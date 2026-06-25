#!/usr/bin/env node
// KNOWN-ANSWER RANKING HARNESS — measures the RANKING QUALITY of the fuzzy (concept_search) and syntactic
// (search_symbol) rungs against a curated, hand-labelled gold set over vts's OWN server/*.js (real code,
// symbols whose location we know). It is the embedding-free, local, deterministic analogue of SWE-Explore's
// line-level ranking eval (arXiv:2606.07297): for each intent query we know which declaration(s) embody it,
// so we can score Recall@K and MRR and a K-budget curve (Recall vs the shown-result budget K — the budget
// dimension being our token cap). NO network, NO toolchain beyond the tree-sitter grammars the plugin already
// bundles; no LSP backend is required (search_symbol falls to the syntactic tier on a backend-less .js tree).
//
//   node eval/rank-bench.mjs                 # report
//   node eval/rank-bench.mjs --json          # also write results/rank-latest.json
//   node eval/rank-bench.mjs --min-mrr 0.55  # CI regression gate: exit 1 if overall fuzzy MRR < 0.55
//
// This is a METRICS REPORT, not a pass/fail guard (eval/run.mjs owns correctness guards). Run it before and
// after a ranking change (negation, PRF, co-change, a future BM25 layer) to PROVE the change helped — and it
// is the measurement substrate the adoption-steer work (Theme B) must be gated on, given the prior SkillOpt
// negative result that wording alone has no headroom.
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "server"); // vts's own source — real decls at known locations
const args = process.argv.slice(2);
const wantJson = args.includes("--json");
const minMrrIdx = args.indexOf("--min-mrr");
const minMrr = minMrrIdx >= 0 ? Number(args[minMrrIdx + 1]) : null;

const { runTool, disposeClients } = await import("../server/core.js");
const { tsAvailable } = await import("../server/treesitter.js");

if (!tsAvailable()) {
  console.log("rank-bench: tree-sitter grammars unavailable (web-tree-sitter + tree-sitter-wasms) — skipping.");
  process.exit(0);
}

// GOLD SET — each item: a query, the rung it exercises, and the symbol NAME(s) that genuinely answer it. The
// fuzzy items are the real measurement (intent → embodying decl, no name overlap guaranteed); the syntactic
// items are a sanity floor (an exact name must rank itself first). Keep answers to symbols that demonstrably
// live in server/*.js so the gold set stays self-checking as the code evolves.
const GOLD = [
  // --- fuzzy rung: "I know the intent, not the name" ---
  { q: "prewarm warm-up ordering by hit rate", rung: "fuzzy", answers: ["orderForWarm", "prewarmBackends"] },
  { q: "exclude a concept boolean negation", rung: "fuzzy", answers: ["parseConceptQuery", "scoreSymbol"] },
  { q: "files committed together git co-change neighbours", rung: "fuzzy", answers: ["cochangeNeighbors", "parseCoChange"] },
  { q: "dead code reachability mark sweep from roots", rung: "fuzzy", answers: ["reachabilityDeadCode", "analyzeDeadCode"] },
  { q: "generate compile database advisory missing", rung: "fuzzy", answers: ["compileDbAdvisory", "hasCompileDb", "genCompileDbPlan"] },
  { q: "pick the language server backend for a repo", rung: "fuzzy", answers: ["pickBackend", "preferBackend", "backendForPath"] },
  { q: "steer a text scan toward the semantic symbol search", rung: "fuzzy", answers: ["symbolHuntInText", "textSymbolSteer", "altSymbols"] },
  { q: "record and report token savings ledger", rung: "fuzzy", answers: ["recordSavings", "savingsLine", "savingsReport"] },
  // --- syntactic rung: exact name must rank itself first (sanity floor) ---
  // NOTE: multi-word token-coverage (LocAgent) is the syntactic TIER's capability; it is asserted
  // deterministically in eval/run.mjs guard 81 (direct tsSearchSymbols/searchSymIndex). It is NOT measured
  // here because rank-bench routes through search_symbol -> the language-server backend, which intercepts a
  // multi-word query before the syntactic fallback runs (backend routing would confound the metric).
  { q: "orderForWarm", rung: "syntactic", answers: ["orderForWarm"] },
  { q: "buildCallGraph", rung: "syntactic", answers: ["buildCallGraph"] },
  { q: "cochangeNeighbors", rung: "syntactic", answers: ["cochangeNeighbors"] },
];

const KS = [1, 3, 5, 10];
process.env.VTS_CONCEPT_COCHANGE = process.env.VTS_CONCEPT_COCHANGE ?? "0"; // pin off: a CI tmp checkout could mine noise

// Rank of the first gold answer in an ordered result text. Result rows of both rungs carry `…file:line: kind
// name` — we keep only result-looking lines (a file:line prefix) in order, then find the first whose text
// matches a gold answer on a word boundary. Returns the 1-based rank, or Infinity on a miss.
function firstHitRank(text, answers) {
  const lines = String(text).split("\n").filter((l) => /[\w./\\-]+:\d+/.test(l) && !/^\s*\[/.test(l));
  const res = answers.map((a) => new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`));
  for (let i = 0; i < lines.length; i++) if (res.some((r) => r.test(lines[i]))) return i + 1;
  return Infinity;
}

const rows = [];
for (const g of GOLD) {
  const tool = g.rung === "fuzzy" ? "concept_search" : "search_symbol";
  const r = await runTool(tool, { q: g.q, projectPath: ROOT, maxResults: 20 });
  const rank = r && !r.isError ? firstHitRank(r.text, g.answers) : Infinity;
  rows.push({ ...g, tool, rank });
}
await disposeClients();

function agg(items) {
  const n = items.length || 1;
  const recall = Object.fromEntries(KS.map((k) => [k, items.filter((it) => it.rank <= k).length / n]));
  const mrr = items.reduce((s, it) => s + (isFinite(it.rank) ? 1 / it.rank : 0), 0) / n;
  return { n: items.length, recall, mrr };
}
const byRung = { fuzzy: agg(rows.filter((r) => r.rung === "fuzzy")), syntactic: agg(rows.filter((r) => r.rung === "syntactic")), all: agg(rows) };

const pct = (x) => (x * 100).toFixed(0).padStart(3) + "%";
console.log(`\nrank-bench — known-answer ranking over ${path.relative(path.join(HERE, ".."), ROOT)} (${rows.length} queries)\n`);
console.log("rung        n   R@1   R@3   R@5  R@10   MRR");
for (const k of ["fuzzy", "syntactic", "all"]) {
  const a = byRung[k];
  console.log(`${k.padEnd(10)} ${String(a.n).padStart(2)}  ${pct(a.recall[1])}  ${pct(a.recall[3])}  ${pct(a.recall[5])}  ${pct(a.recall[10])}  ${a.mrr.toFixed(3)}`);
}
console.log("\nper-query (rank of first gold hit; ∞ = miss):");
for (const r of rows) console.log(`  ${r.rank === Infinity ? "  ∞" : String(r.rank).padStart(3)}  [${r.rung}] ${r.q}`);

if (wantJson) {
  const outDir = path.join(HERE, "..", "results");
  try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* exists */ }
  fs.writeFileSync(path.join(outDir, "rank-latest.json"), JSON.stringify({ root: "server", queries: rows.map(({ q, rung, rank }) => ({ q, rung, rank: isFinite(rank) ? rank : null })), summary: byRung }, null, 2));
  console.log("\nwrote results/rank-latest.json");
}

if (minMrr != null) {
  const got = byRung.fuzzy.mrr;
  if (got < minMrr) { console.log(`\nFAIL — fuzzy MRR ${got.toFixed(3)} < required ${minMrr}`); process.exit(1); }
  console.log(`\nOK — fuzzy MRR ${got.toFixed(3)} >= ${minMrr}`);
}
process.exit(0);
