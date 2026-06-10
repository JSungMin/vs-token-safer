/*
 * Prewarm ORDERING — which TUs to open/index first so the warm-up window has a high hit-rate.
 *
 * clangd boosts the indexing priority of TUs related to files we didOpen (IndexBoostedFile), so the
 * order of the open-set steers what becomes queryable first. We rank candidates by, in weight order:
 *   ① query-history  (LFU + recency) — files that answered past searches (strongest signal)
 *   ② vcs-recency    — recently-touched files (git log + Perforce `p4 opened`) — what the dev works on
 *   ③ mtime          — filesystem recency (tiebreak / no-VCS fallback; p4 edit/sync updates mtime too)
 * Background indexing still covers everything eventually; this only front-loads the likely targets.
 * Keep the open-set small (cap) — over-prewarming pollutes/saturates the worker.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HIST_FILE = process.env.VTS_QUERY_HISTORY || path.join(os.homedir(), ".vs-token-safer", "query-history.json");
const norm = (p) => path.resolve(p).replace(/\\/g, "/").toLowerCase();
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
    const out = execFileSync("git", ["-C", root, "log", "--name-only", "--format=", "-n", "80"], { encoding: "utf8", timeout: 5000 });
    const order = []; const seen = new Set();
    for (const line of out.split(/\r?\n/)) {
      const t = line.trim();
      if (t && !seen.has(t)) { seen.add(t); order.push(norm(path.join(root, t))); }
    }
    addOrder(rank, order);
  } catch { /* no git */ }
}

// Perforce: files currently OPEN for edit in this client (a strong "working on it right now" signal) —
// `p4 -ztag opened` reports each file's local `clientFile`. Best-effort; empty if no p4 / not configured.
function p4Recent(root, rank) {
  try {
    const out = execFileSync("p4", ["-ztag", "opened", "-m", "200"], { cwd: root, encoding: "utf8", timeout: 5000 });
    const order = [];
    for (const line of out.split(/\r?\n/)) {
      const m = /^\.\.\. clientFile (.+)$/.exec(line.trim());
      if (m) order.push(norm(m[1]));
    }
    addOrder(rank, order);
  } catch { /* no p4 */ }
}

// Merged VCS recency (git + Perforce). A tree may be under either; both are probed best-effort and the
// higher rank wins. mtime (in orderForWarm) remains the universal fallback — in a p4 workspace, `p4 edit`
// / `p4 sync` updates file mtime, so recently-touched files surface even without the p4 probe.
function vcsRecent(root) {
  const rank = new Map();
  gitRecent(root, rank);
  p4Recent(root, rank);
  return rank;
}

// Reorder `candidates` for warming and cap. Weights: history >> git-recency >> mtime.
export function orderForWarm(root, candidates, cap = 100) {
  const hist = histRank(root);
  const vcs = vcsRecent(root);
  const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
  const scored = candidates.map((f) => {
    const k = norm(f);
    return { f, s: (hist.get(k) || 0) * 1e6 + (vcs.get(k) || 0) * 1e3 + mtime(f) / 1e13 };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, cap).map((x) => x.f);
}
