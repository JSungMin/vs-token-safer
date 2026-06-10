#!/usr/bin/env node
// Reproducible measurement of the prewarm-ORDERING hit-rate lift, using the REAL orderForWarm() code
// under a controlled workload with temporal/frequency locality (what dev code-search actually looks
// like: you keep querying around the files you're working on). No clangd/toolchain needed.
//
//   node eval/bench-hitrate.mjs
//
// "Hit" = the file a future query needs is inside the capped warm-up set. We compare:
//   baseline = arbitrary order (open the first N files) — what an unordered warm-up does
//   ours     = orderForWarm() — ranks by query history (and, on a real tree, git/p4 recency + mtime)
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const QH = path.join(os.tmpdir(), `vts-bench-qh-${process.pid}.json`);
process.env.VTS_QUERY_HISTORY = QH;
const { orderForWarm, recordQueryResults } = await import("../server/warmset.js");

let seed = 1234567; // deterministic LCG → stable numbers across runs
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const M = 2000, ROOT = "/sim", HQ = 400, TQ = 400;
const files = Array.from({ length: M }, (_, i) => `${ROOT}/m${i}.cpp`);
// heat ~ Zipf over a RANDOM permutation, so popularity is uncorrelated with file index → "first N" is a
// genuinely arbitrary baseline (not secretly aligned with what's hot).
const perm = [...files].map((f) => ({ f, r: rnd() })).sort((a, b) => a.r - b.r).map((x) => x.f);
const weight = perm.map((_, i) => 1 / (i + 1));
const total = weight.reduce((a, b) => a + b, 0);
const pick = () => { let x = rnd() * total; for (let i = 0; i < M; i++) { x -= weight[i]; if (x <= 0) return perm[i]; } return perm[M - 1]; };

for (let i = 0; i < HQ; i++) recordQueryResults(ROOT, [pick()]); // past queries seed the history ledger
const test = Array.from({ length: TQ }, () => pick());          // future queries we measure against
const hit = (set, q) => q.filter((f) => set.has(f)).length / q.length;

console.log(`prewarm hit-rate — M=${M} files, history=${HQ} queries, test=${TQ}, Zipf locality\n`);
console.log("cap   cap%   baseline   ours    lift");
let ok = true;
for (const cap of [50, 100, 200, 400, 600, 1000]) {
  const baseline = new Set(files.slice(0, cap));
  const ours = new Set(orderForWarm(ROOT, files, cap));
  const hb = hit(baseline, test), ho = hit(ours, test);
  if (ho <= hb) ok = false; // ordering must never be worse than arbitrary on a locality workload
  console.log(`${String(cap).padStart(4)}  ${((cap / M) * 100).toFixed(0).padStart(3)}%   ${(hb * 100).toFixed(1).padStart(6)}%   ${(ho * 100).toFixed(1).padStart(6)}%   ${hb > 0 ? (ho / hb).toFixed(1) + "x" : "+" + (ho * 100).toFixed(0) + "pp"}`);
}
try { fs.rmSync(QH, { force: true }); } catch { /* ignore */ }
console.log(ok ? "\nOK — ordering beats arbitrary at every cap." : "\nFAIL — ordering did not beat arbitrary.");
process.exit(ok ? 0 : 1);
