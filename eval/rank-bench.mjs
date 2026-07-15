#!/usr/bin/env node
// KNOWN-ANSWER RANKING HARNESS — measures the RANKING QUALITY of the fuzzy (concept_search) and syntactic
// (tree-sitter) rungs against a curated gold set over a FROZEN synthetic corpus (eval/fixtures/rank-corpus).
// It is the embedding-free, local, deterministic analogue of SWE-Explore's line-level ranking eval
// (arXiv:2606.07297): for each intent query we know which declaration(s) embody it, so we score Recall@K, MRR,
// and answer-set COVERAGE under a result budget (K = the shown-result budget — our token cap).
//
//   node eval/rank-bench.mjs                 # report
//   node eval/rank-bench.mjs --json          # also write results/rank-latest.json
//   node eval/rank-bench.mjs --min-mrr 0.55  # CI regression gate: exit 1 if fuzzy MRR < 0.55
//
// WHY A FROZEN CORPUS (the SWE-Explore methodology migration): the earlier version rooted on vts's own live
// server/*.js, so editing the code shifted the corpus and the MRR drifted (a ranking change couldn't be told
// apart from a source edit). A committed synthetic corpus makes every metric attributable to a RANKING change
// alone. Synthetic names only (charter: no real paths/symbols).
//
// SURPRISE RUNG ("lost if surprise", adapted from the gist-compression failure study arXiv:2412.17483). Gist/
// context COMPRESSION loses the SURPRISING (rare, high-information) token first — in code that is exactly the
// identifier you were hunting. vts does not compress (it OMITS bodies and returns addresses), but its fuzzy
// GATES could still lose a rare decl: a df=1 token can't be expanded through (minCooc 2 / df >= 2) and can't
// become a PRF feedback term (minDocs 2). Measured, not assumed — and it does NOT reproduce: a rare identifier
// ranks #1 on a direct match (idf REWARDS the rarity) and #1 even against common-token competitors; only a PURE
// synonym gap onto a df=1 term demotes it (rank 4) — demoted, still inside the K budget, not lost. Scored as its
// OWN rung so it never moves the fuzzy MRR gate (fuzzy MRR is 0.848 with and without this corpus extension).
//
// Backend-free by construction: the fuzzy rung (concept_search) never uses an LSP; the syntactic rung is tested
// by calling tsSearchSymbols DIRECTLY (not search_symbol -> the LSP backend, which would intercept a multi-word
// query before the syntactic fallback and confound the metric — that path is guarded deterministically in
// eval/run.mjs guard 81 instead).
//
// This is a METRICS REPORT, not a pass/fail guard (eval/run.mjs owns correctness). Run it before/after a
// ranking change (negation, PRF, co-change, token coverage) to PROVE the change helped.
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "fixtures", "rank-corpus");
const args = process.argv.slice(2);
const wantJson = args.includes("--json");
const minMrrIdx = args.indexOf("--min-mrr");
const minMrr = minMrrIdx >= 0 ? Number(args[minMrrIdx + 1]) : null;

const { runTool, disposeClients } = await import("../server/core.js");
const { tsAvailable, tsSearchSymbols } = await import("../server/treesitter.js");

if (!tsAvailable()) {
  console.log("rank-bench: tree-sitter grammars unavailable (web-tree-sitter + tree-sitter-wasms) — skipping.");
  process.exit(0);
}
process.env.VTS_CONCEPT_COCHANGE = process.env.VTS_CONCEPT_COCHANGE ?? "0"; // a CI tmp checkout could mine noise

// GOLD SET over the frozen corpus. fuzzy = intent -> the declaration(s) that embody it (no guaranteed name
// overlap — that is the point); syntactic = a name (or multi-word phrase) -> the decl it should resolve to.
const GOLD = [
  // --- fuzzy rung (concept_search): "I know the intent, not the name" — a MIX of direct and paraphrased
  // (synonym-gap) intents over a corpus seeded with token-sharing DISTRACTORS, so ranking matters and the
  // honest embedding-residual (a pure synonym with no lexical bridge) shows up as a low rank / miss. ---
  { q: "how does the user log in", rung: "fuzzy", answers: ["authenticateUser", "validateSession"] },
  { q: "check that a password is correct", rung: "fuzzy", answers: ["verifyPassword"] }, // check~verify; distractor resetPassword
  { q: "take money from the customer card", rung: "fuzzy", answers: ["chargePayment"] }, // synonym gap; distractors listPayments/customerAddress
  { q: "give the money back to the buyer", rung: "fuzzy", answers: ["refundPayment"] }, // give-back~refund, buyer~customer
  { q: "extend the subscription another cycle", rung: "fuzzy", answers: ["renewSubscription"] }, // extend~renew
  { q: "send a bill to the client", rung: "fuzzy", answers: ["sendInvoice", "createInvoice"] }, // bill in comment, client~customer
  { q: "preload hot keys at startup", rung: "fuzzy", answers: ["prewarmKeys", "warmCache"] }, // startup~boot
  { q: "remove old items from the cache", rung: "fuzzy", answers: ["evictEntry"] }, // remove~evict, old~stale; distractors clearCache/resizeCache
  { q: "log the user out", rung: "fuzzy", answers: ["logoutUser"] }, // direct
  { q: "renew an expired access token", rung: "fuzzy", answers: ["refreshToken"] }, // renew/expired~refresh
  // --- surprise rung: "LOST IF SURPRISE" (the gist-compression failure mode, arXiv:2412.17483, adapted). A
  // compressor loses the SURPRISING token first — in code that is exactly the rare identifier you were hunting.
  // We don't compress (we omit bodies and return addresses), but our fuzzy GATES could still lose it: a df=1
  // token can't be expanded through (minCooc 2 / df >= 2) and can't become a PRF feedback term (minDocs 2). So
  // measure it directly, separately from the fuzzy MRR gate. auth/quarantine.ts holds the rare decls.
  // (a) DIRECT: the rare token is IN the query -> idf should REWARD the rarity, not lose it.
  { q: "quarantine a flagged credential", rung: "surprise", answers: ["quarantineCredential"] },
  // (b) RARE-VS-COMMON: rare tokens compete with common-"token" decls (refreshToken/validateSession) -> does
  // the high-idf rare decl still win the head of the list?
  { q: "blocklist a compromised token", rung: "surprise", answers: ["revokeCompromisedToken"] },
  // (c) BRIDGE: a PURE synonym gap onto a df=1 term (isolate~quarantine, suspicious~anomaly); only the common
  // "credential" overlaps. Expansion CANNOT bridge it (the neighbour gates need df >= 2). This is the honest
  // embedding-residual made measurable — a MISS here is a reported limit, not a regression.
  { q: "isolate a suspicious credential", rung: "surprise", answers: ["quarantineCredential"] },
  // --- syntactic rung (tsSearchSymbols direct): exact + MULTI-WORD token coverage (the LocAgent capability) ---
  { q: "validateSession", rung: "syntactic", answers: ["validateSession"] },
  { q: "charge payment", rung: "syntactic", answers: ["chargePayment"] },
  { q: "verify password", rung: "syntactic", answers: ["verifyPassword"] },
  { q: "warm cache", rung: "syntactic", answers: ["warmCache"] },
  { q: "warm the cache at boot", rung: "syntactic", answers: ["warmCache"] }, // AND-empty (no "boot" decl) -> partial fallback surfaces warmCache
];

const KS = [1, 3, 5, 10];
const SKIP = new Set(["node_modules", ".git"]);

// Ordered list of result symbol NAMES for a gold query, per rung.
async function resultNames(g) {
  if (g.rung === "fuzzy" || g.rung === "surprise") {   // the surprise probes ride the same fuzzy path, scored apart
    const r = await runTool("concept_search", { q: g.q, projectPath: ROOT, maxResults: 20 });
    if (!r || r.isError) return [];
    return String(r.text)
      .split("\n")
      .map((l) => {
        const m = l.match(/[\w./\\-]+:\d+:\s+\S+\s+(\S+)\s*$/); // "file:line: kind name"
        return m ? m[1] : null;
      })
      .filter(Boolean);
  }
  const hits = await tsSearchSymbols(ROOT, g.q, { skipDir: (n) => SKIP.has(n) });
  return (hits || []).map((h) => h.name);
}

const rows = [];
for (const g of GOLD) {
  const names = await resultNames(g);
  const rank = (() => {
    for (let i = 0; i < names.length; i++) if (g.answers.includes(names[i])) return i + 1;
    return Infinity;
  })();
  const covered = g.answers.filter((a) => names.includes(a)).length;
  rows.push({ ...g, rank, coverage: covered / g.answers.length });
}
await disposeClients();

function agg(items) {
  const n = items.length || 1;
  const recall = Object.fromEntries(KS.map((k) => [k, items.filter((it) => it.rank <= k).length / n]));
  const mrr = items.reduce((s, it) => s + (isFinite(it.rank) ? 1 / it.rank : 0), 0) / n;
  const coverage = items.reduce((s, it) => s + it.coverage, 0) / n;
  return { n: items.length, recall, mrr, coverage };
}
const byRung = {
  fuzzy: agg(rows.filter((r) => r.rung === "fuzzy")),
  surprise: agg(rows.filter((r) => r.rung === "surprise")),
  syntactic: agg(rows.filter((r) => r.rung === "syntactic")),
  all: agg(rows),
};

const pct = (x) => (x * 100).toFixed(0).padStart(3) + "%";
console.log(`\nrank-bench — frozen corpus eval/fixtures/rank-corpus (${rows.length} queries)\n`);
console.log("rung        n   R@1   R@3   R@5  R@10   MRR   Cov");
for (const k of ["fuzzy", "surprise", "syntactic", "all"]) {
  const a = byRung[k];
  console.log(`${k.padEnd(10)} ${String(a.n).padStart(2)}  ${pct(a.recall[1])}  ${pct(a.recall[3])}  ${pct(a.recall[5])}  ${pct(a.recall[10])}  ${a.mrr.toFixed(3)}  ${pct(a.coverage)}`);
}
console.log("\nK-budget (fuzzy Recall@K — K = shown-result budget / token-cap proxy):");
console.log("  " + KS.map((k) => `R@${k}=${pct(byRung.fuzzy.recall[k])}`).join("  "));
console.log("\nper-query (rank of first gold hit; ∞ = miss; cov = answer-set coverage):");
for (const r of rows) console.log(`  ${r.rank === Infinity ? "  ∞" : String(r.rank).padStart(3)}  cov ${pct(r.coverage)}  [${r.rung}] ${r.q}`);

if (wantJson) {
  const outDir = path.join(HERE, "..", "results");
  try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* exists */ }
  fs.writeFileSync(
    path.join(outDir, "rank-latest.json"),
    JSON.stringify({ corpus: "eval/fixtures/rank-corpus", queries: rows.map(({ q, rung, rank, coverage }) => ({ q, rung, rank: isFinite(rank) ? rank : null, coverage })), summary: byRung }, null, 2),
  );
  console.log("\nwrote results/rank-latest.json");
}

if (minMrr != null) {
  const got = byRung.fuzzy.mrr;
  if (got < minMrr) { console.log(`\nFAIL — fuzzy MRR ${got.toFixed(3)} < required ${minMrr}`); process.exit(1); }
  console.log(`\nOK — fuzzy MRR ${got.toFixed(3)} >= ${minMrr}`);
}
process.exit(0);
