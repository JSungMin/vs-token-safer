/*
 * Prewarm ORDERING — which TUs to open/index first so the warm-up window has a high hit-rate.
 *
 * clangd boosts the indexing priority of TUs related to files we didOpen (IndexBoostedFile), so the
 * order of the open-set steers what becomes queryable first. We rank candidates by, in weight order:
 *   query-history  (LFU + recency) — files that answered past searches (strongest evidence)
 *   working-now    — files open/modified right now (git status / Perforce `p4 opened`)
 *   git-recency    — recently-committed files (git log)
 *   centrality     — include fan-in among candidates (bounded; widely-reused headers help many queries)
 *   mtime          — filesystem recency fallback (p4 edit/sync updates mtime too)
 * Background indexing still covers everything eventually; this only front-loads the likely targets.
 * Keep the open-set small (cap) — over-prewarming pollutes/saturates the worker.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HIST_FILE = process.env.VTS_QUERY_HISTORY || path.join(os.homedir(), ".vs-token-safer", "query-history.json");
const norm = (p) => path.resolve(p).replace(/\\/g, "/").toLowerCase();
const envInt = (name, def) => { const v = parseInt(process.env[name], 10); return Number.isFinite(v) && v >= 0 ? v : def; };
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

// ③ Dependency centrality (bounded): among candidates, count include fan-in — how many candidates
// `#include` each one. High fan-in = reused widely → warming it helps many queries. Reads files, so it's
// gated to a max candidate count (VTS_CENTRALITY_MAX, default 1500; 0 disables) to stay cheap on huge
// trees, where clangd's preamble already pulls central headers transitively when a TU is opened.
function centralityRank(candidates) {
  const max = envInt("VTS_CENTRALITY_MAX", 1500);
  if (!max || candidates.length > max) return new Map();
  const byName = new Map();
  for (const f of candidates) { const b = path.basename(f).toLowerCase(); if (!byName.has(b)) byName.set(b, norm(f)); }
  const fanin = new Map();
  for (const f of candidates) {
    let txt; try { txt = fs.readFileSync(f, "utf8"); } catch { continue; }
    const self = norm(f); const seen = new Set();
    const re = /#\s*include\s*["<]([^">]+)[">]/g; let m;
    while ((m = re.exec(txt))) {
      const target = byName.get(path.basename(m[1]).toLowerCase());
      if (target && target !== self && !seen.has(target)) { seen.add(target); fanin.set(target, (fanin.get(target) || 0) + 1); }
    }
  }
  return fanin;
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
