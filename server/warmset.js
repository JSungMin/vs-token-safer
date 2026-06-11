/*
 * Prewarm ORDERING — which TUs to open/index first so the warm-up window has a high hit-rate.
 *
 * clangd boosts the indexing priority of TUs related to files we didOpen (IndexBoostedFile), so the
 * order of the open-set steers what becomes queryable first. We rank candidates by, in weight order:
 *   query-history  (LFU + recency) — files that answered past searches (strongest evidence)
 *   working-now    — files open/modified right now (git status / Perforce `p4 opened`)
 *   git-recency    — recently-committed files (git log)
 *   centrality     — include fan-in among candidates (adaptive: prefix-read + per-warmup time budget +
 *                    a persistent include-graph cache that GROWS coverage across warmups)
 *   mtime          — filesystem recency fallback (p4 edit/sync updates mtime too)
 * Background indexing still covers everything eventually; this only front-loads the likely targets.
 * Keep the open-set small (cap) — over-prewarming pollutes/saturates the worker.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HIST_FILE = process.env.VTS_QUERY_HISTORY || path.join(os.homedir(), ".vs-token-safer", "query-history.json");
const GRAPH_FILE = process.env.VTS_INCLUDE_GRAPH || path.join(os.homedir(), ".vs-token-safer", "include-graph.json");
const norm = (p) => path.resolve(p).replace(/\\/g, "/").toLowerCase();
const envInt = (name, def) => { const v = parseInt(process.env[name], 10); return Number.isFinite(v) && v >= 0 ? v : def; };

// Read only the top of a file (where #includes live) — cheap enough to scan many files for centrality.
function readIncludePrefix(f, maxBytes = 65536) {
  let fd;
  try { fd = fs.openSync(f, "r"); } catch { return null; }
  try { const buf = Buffer.alloc(maxBytes); const n = fs.readSync(fd, buf, 0, maxBytes, 0); return buf.toString("utf8", 0, n); }
  catch { return null; }
  finally { try { fs.closeSync(fd); } catch { /* ignore */ } }
}
function parseIncludes(txt) {
  const out = []; const re = /#\s*include\s*["<]([^">]+)[">]/g; let m;
  while ((m = re.exec(txt))) out.push(path.basename(m[1]).toLowerCase());
  return out;
}
// Persistent include-graph cache ({ normPath: { m: mtimeMs, i: [includedBasename,...] } }) so centrality
// scanning AMORTIZES across warmups instead of re-reading every file each time. mtime invalidates stale
// entries automatically.
function loadGraph() { try { return JSON.parse(fs.readFileSync(GRAPH_FILE, "utf8")) || {}; } catch { return {}; } }
function saveGraph(g) { try { fs.mkdirSync(path.dirname(GRAPH_FILE), { recursive: true }); fs.writeFileSync(GRAPH_FILE, JSON.stringify(g)); } catch { /* best-effort */ } }
const readHist = () => { try { return JSON.parse(fs.readFileSync(HIST_FILE, "utf8")) || {}; } catch { return {}; } };
// LFU with a recency tiebreak (scan-resistant-ish: a one-off scan adds n=1, repeated use compounds).
const score = (e, now) => e.n + 1 / (1 + (now - e.t));

// Record the result files of a query (frequency++ + a monotonic per-root "time"). Capped per root.
export function recordQueryResults(root, files) {
  if (!root || !files || !files.length) return;
  const h = readHist();
  const key = norm(root);
  const bucket = h[key] || {};
  const now = (bucket.__seq || 0) + 1;
  bucket.__seq = now;
  for (const f of files.slice(0, 50)) {
    const k = norm(f);
    const e = bucket[k] || { n: 0, t: 0 };
    e.n++; e.t = now;
    bucket[k] = e;
  }
  const entries = Object.entries(bucket).filter(([k]) => k !== "__seq");
  if (entries.length > 500) {
    entries.sort((a, b) => score(b[1], now) - score(a[1], now));
    const trimmed = { __seq: now };
    for (const [k, v] of entries.slice(0, 500)) trimmed[k] = v;
    h[key] = trimmed;
  } else {
    h[key] = bucket;
  }
  try { fs.mkdirSync(path.dirname(HIST_FILE), { recursive: true }); fs.writeFileSync(HIST_FILE, JSON.stringify(h)); } catch { /* best-effort */ }
}

function histRank(root) {
  const bucket = readHist()[norm(root)];
  const m = new Map();
  if (!bucket) return m;
  const now = bucket.__seq || 0;
  for (const [k, v] of Object.entries(bucket)) if (k !== "__seq") m.set(k, score(v, now));
  return m;
}

// Assign descending rank to an ordered, most-recent-first list of normalized paths, merged into `rank`.
function addOrder(rank, order) {
  order.forEach((p, i) => { const r = order.length - i; if ((rank.get(p) || 0) < r) rank.set(p, r); });
}

// git: recently-touched files (most recent first). Empty if not a git repo / no git.
function gitRecent(root, rank) {
  try {
    const out = execFileSync("git", ["-C", root, "log", "--name-only", "--format=", "-n", "80"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    const order = []; const seen = new Set();
    for (const line of out.split(/\r?\n/)) {
      const t = line.trim();
      if (t && !seen.has(t)) { seen.add(t); order.push(norm(path.join(root, t))); }
    }
    addOrder(rank, order);
  } catch { /* no git */ }
}

// ④ "Working on it right now" — the strongest recency signal: files modified in the working tree
// (`git status`) and/or open for edit in Perforce (`p4 opened`). Returns a Set of normalized paths.
// Both probed best-effort; a p4 `clientFile` is already a local path, git paths are repo-relative.
function workingFiles(root) {
  const set = new Set();
  try {
    const out = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.split(/\r?\n/)) {
      let t = line.slice(3).trim(); // drop the 2-char XY status + space
      if (!t) continue;
      if (t.includes(" -> ")) t = t.split(" -> ").pop(); // renames: take the new path
      set.add(norm(path.join(root, t.replace(/^"|"$/g, ""))));
    }
  } catch { /* no git */ }
  try {
    const out = execFileSync("p4", ["-ztag", "opened", "-m", "500"], { cwd: root, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.split(/\r?\n/)) {
      const m = /^\.\.\. clientFile (.+)$/.exec(line.trim());
      if (m) set.add(norm(m[1]));
    }
  } catch { /* no p4 */ }
  return set;
}

// ③ Dependency centrality — among candidates, count include fan-in (how many candidates `#include`
// each one). High fan-in = reused widely → warming it helps many queries. ADAPTIVE so it doesn't all-or-
// nothing-skip big trees: it reads only each file's include-prefix, spends at most VTS_CENTRALITY_BUDGET_MS
// per warmup on NEW/changed files, and persists what it scans to an include-graph cache (mtime-keyed).
// So coverage GROWS across warmups — first run scans a budget's worth, later runs reuse the cache and
// extend it, until the whole module is mapped (then only changed files are rescanned). VTS_CENTRALITY_MAX
// bounds the stat loop (0 = disable centrality); VTS_CENTRALITY_BUDGET_MS bounds fresh reads (0 = cache-only).
function centralityRank(candidates) {
  const maxIter = envInt("VTS_CENTRALITY_MAX", 20000);
  if (maxIter === 0) return new Map(); // disabled
  const list = candidates.slice(0, maxIter);
  const budgetMs = envInt("VTS_CENTRALITY_BUDGET_MS", 400);
  const byName = new Map();
  for (const f of list) { const b = path.basename(f).toLowerCase(); if (!byName.has(b)) byName.set(b, norm(f)); }
  const graph = loadGraph();
  const start = Date.now();
  let dirty = false;
  const fanin = new Map();
  for (const f of list) {
    const nf = norm(f);
    let st; try { st = fs.statSync(f).mtimeMs; } catch { continue; }
    const cached = graph[nf];
    let inc;
    if (cached && cached.m === st) inc = cached.i;
    else if (Date.now() - start < budgetMs) {
      const txt = readIncludePrefix(f);
      if (txt == null) continue;
      inc = parseIncludes(txt);
      graph[nf] = { m: st, i: inc };
      dirty = true;
    } else inc = cached ? cached.i : null; // budget spent → reuse stale cache, else defer to a later warmup
    if (!inc) continue;
    const seen = new Set();
    for (const b of inc) {
      const target = byName.get(b);
      if (target && target !== nf && !seen.has(target)) { seen.add(target); fanin.set(target, (fanin.get(target) || 0) + 1); }
    }
  }
  if (dirty) saveGraph(graph);
  return fanin;
}

// --- language census: how much of the repo is each backend's language, so warm-up scales to the project
// mix. A C++-heavy tree warms more C++ TUs; a small JS side-dir warms few. Counts drive both the adaptive
// per-backend open-cap (warmCap) and the optional multi-backend prewarm (prewarmBackends). ---
const CENSUS_EXT = {
  clangd: /\.(c|cc|cxx|cpp|h|hpp|hh|inl|ipp|tpp)$/i,
  roslyn: /\.cs$/i,
  typescript: /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i,
  pyright: /\.(py|pyi)$/i,
};
const SKIP_DIR = /^(build|intermediate|saved|bin|obj|dist|out|node_modules|\.git|target|coverage)$/i;
const _censusCache = new Map(); // normRoot -> counts (process-lifetime; warm-up reads it a few times)
export function languageCensus(root) {
  const key = norm(root);
  if (_censusCache.has(key)) return _censusCache.get(key);
  const counts = { clangd: 0, roslyn: 0, typescript: 0, pyright: 0, total: 0 };
  const stack = [root]; let scanned = 0;
  const MAX = envInt("VTS_CENSUS_MAX", 200000), t0 = Date.now();
  while (stack.length && scanned < MAX && Date.now() - t0 < 3000) {
    const dir = stack.pop();
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isDirectory()) { if (!e.name.startsWith(".") && !SKIP_DIR.test(e.name)) stack.push(path.join(dir, e.name)); continue; }
      scanned++;
      for (const b in CENSUS_EXT) if (CENSUS_EXT[b].test(e.name)) { counts[b]++; counts.total++; break; }
    }
  }
  _censusCache.set(key, counts);
  return counts;
}
// Adaptive warm open-cap for a backend: an explicit VTS_*_OPEN_CAP wins; else scale to the language's file
// count (warm ~VTS_WARM_CAP_RATIO of them) clamped to [base, VTS_WARM_CAP_MAX]. Big language → warm more.
export function warmCap(root, backend, envName, base) {
  const ov = parseInt(process.env[envName], 10);
  if (Number.isFinite(ov) && ov >= 0) return ov; // explicit override (incl. 0 = disable) wins
  const n = languageCensus(root)[backend] || 0;
  const ratio = Number(process.env.VTS_WARM_CAP_RATIO) > 0 ? Number(process.env.VTS_WARM_CAP_RATIO) : 0.1;
  return Math.min(envInt("VTS_WARM_CAP_MAX", 300), Math.max(base, Math.round(n * ratio)));
}
// Which backends to prewarm: VTS_PREWARM_BACKENDS unset/"auto" → [dominant only] (current behavior);
// "all" → every detected language (count>0), dominant first; a comma list → those backend names. Each is
// then warmed with ITS adaptive cap, so a multi-language repo warms in proportion to the language mix.
export function prewarmBackends(root, picked, which = process.env.VTS_PREWARM_BACKENDS) {
  const w = String(which || "").trim().toLowerCase();
  if (!w || w === "auto") return picked ? [picked] : [];
  const census = languageCensus(root);
  const detected = ["clangd", "roslyn", "typescript", "pyright"].filter((b) => census[b] > 0).sort((a, b) => census[b] - census[a]);
  if (w === "all") return detected.length ? detected : picked ? [picked] : [];
  const list = w.split(",").map((s) => s.trim()).filter((b) => CENSUS_EXT[b]);
  return list.length ? list : picked ? [picked] : [];
}

// Reorder `candidates` for warming and cap. Tiered weights (strongest evidence first):
//   ② query history > ④ working-now (git status / p4 opened) > ① git-log recency > ③ centrality > mtime.
export function orderForWarm(root, candidates, cap = 100) {
  const hist = histRank(root);
  const working = workingFiles(root);
  const gitLog = new Map(); gitRecent(root, gitLog);
  const central = centralityRank(candidates);
  const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
  const scored = candidates.map((f) => {
    const k = norm(f);
    const s = (hist.get(k) || 0) * 1e6
      + (working.has(k) ? 1e5 : 0)
      + (gitLog.get(k) || 0) * 1e3
      + (central.get(k) || 0) * 1e1
      + mtime(f) / 1e13;
    return { f, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, cap).map((x) => x.f);
}
