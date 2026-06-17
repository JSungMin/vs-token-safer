#!/usr/bin/env node
/*
 * vs-token-safer — reproducible token benchmark (A/B: Bash grep vs vts).
 *
 * WHY this shape (and not promptfoo-with-a-live-model): vts is a TOOL that shapes the *input* context a
 * code-search puts in front of the model, not a prompt that shapes the model's *output*. So the honest,
 * model-INDEPENDENT metric is deterministic — for the same query, how many tokens does grep inject vs
 * how many does vts inject? That needs NO API key and NO model call, so anyone reproduces it exactly
 * (`npm run bench`). The per-model COST table is then `token-delta × that model's input price` — the
 * model matrix for free, with no run-to-run variance.
 *
 * THE KEY VARIABLE IS REPO SIZE. grep returns every matching line (full text), so its cost scales with
 * the match count; vts returns a token-capped `file:line` list, so it stays roughly flat. On a 10-file
 * toy a narrow text search is a wash (vts's header overhead ≈ grep); the win opens up as the repo grows.
 * So the benchmark SWEEPS corpus size and reports the reduction climbing — the honest shape of the win.
 *
 * Arms, per scenario:
 *   A) grep  — what the built-in Grep/Glob tool hands the model: matching `relpath:lineno:full-line` (or
 *              a path list for file-by-name), capped at GREP_LINE_CAP (Claude's Grep tool truncates ~250;
 *              the CONSERVATIVE baseline — uncapped grep-and-paste is far larger).
 *   B) vts   — the runTool output: a token-capped `file:line` list, no bodies.
 *
 * Token estimate = bytes / 4 (identical to server/core.js). Corpus = a synthetic TypeScript project in a
 * temp dir so the typescript-language-server backend resolves symbols/refs without clangd or a compile DB
 * (CI installs it via optionalDependencies). No real source/paths/symbols — synthetic only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "vts-bench-"));
for (const [k, f] of [
  ["VTS_QUERY_HISTORY", "qh.json"], ["VTS_INCLUDE_GRAPH", "ig.json"], ["VTS_CONFIG_FILE", "cfg.json"],
  ["VTS_SAVINGS_FILE", "sv.json"], ["VTS_EDIT_LEDGER", "edl.json"],
]) process.env[k] = path.join(TMP, f);
process.env.VTS_TEE_DIR = path.join(TMP, "tee");
fs.writeFileSync(process.env.VTS_CONFIG_FILE, "{}");
process.env.VTS_LANG = "en";

const { runTool, disposeClients } = await import("../server/core.js");
const tok = (s) => Math.round(Buffer.byteLength(String(s), "utf8") / 4);
const pct = (x) => (x * 100).toFixed(1) + "%";

// USD per 1M INPUT tokens. List prices — verify at https://www.anthropic.com/pricing. The token DELTA is
// the deterministic claim; cost is delta × price, so updating these re-prices the table without re-running.
const PRICES = { "Haiku 4.5": 1.0, "Sonnet 4.x": 3.0, "Opus 4.x": 15.0 };
const GREP_LINE_CAP = 250;      // Claude's built-in Grep tool truncates output ~here (conservative baseline)
const SIZES = [10, 50, 150];    // caller files per corpus — sweep to show the win scaling with repo size

// Build a synthetic TS project of `n` caller files. Target symbol `processPayment`: ONE declaration, a
// call site + comment + retry note per caller (so refs/text scale with n), plus substring noise
// (`processPaymentRefund`) grep over-reports. "retry loop" is a genuine text string (no symbol shape →
// no vts steer-nudge), so the text scenario is a fair text-vs-text comparison.
function buildCorpus(n) {
  const root = path.join(TMP, `corpus-${n}`);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: `bench-${n}`, version: "1.0.0" }));
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "commonjs", target: "es2020", strict: true }, include: ["src"] }));
  fs.writeFileSync(path.join(root, "src", "payment.ts"),
    `// processPayment is the core billing entry point.\n` +
    `export function processPayment(amount: number, currency: string): boolean {\n` +
    `  if (amount <= 0) return false;\n` +
    `  const note = "calling processPayment in a retry loop";\n` +
    `  return true;\n` +
    `}\n` +
    `export function processPaymentRefund(amount: number): boolean { return amount > 0; }\n`);
  for (let i = 0; i < n; i++) {
    // Namespace import (not a named binding) so the ONLY symbol literally named `processPayment` is the
    // declaration — find_references-by-name then resolves the real decl and returns the COMPLETE ref set
    // (a fair same-answer token comparison). grep `\bprocessPayment\b` still matches `billing.processPayment`.
    fs.writeFileSync(path.join(root, "src", `caller${i}.ts`),
      `import * as billing from "./payment";\n` +
      `// caller ${i}: drives processPayment inside a retry loop\n` +
      `export function run${i}(): void {\n` +
      `  for (let r = 0; r < 3; r++) {\n` +
      `    const ok = billing.processPayment(${i + 1}, "USD"); // retry loop\n` +
      `    if (!ok) continue;\n` +
      `  }\n` +
      `}\n`);
  }
  // Dependency/build junk a real tree carries — `find`/grep traverse it (noise), vts walk-bounds past it
  // (SKIP_DIRS: node_modules/Intermediate/Binaries/…). Named to match the file-by-name query so the
  // file-search arm reflects find_files' actual value: skipping ignored dirs, not just capping.
  const junk = path.join(root, "node_modules", "vendor");
  fs.mkdirSync(junk, { recursive: true });
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(junk, `caller_vendor${i}.ts`), `export const v${i} = ${i};\n`);
  return root;
}

// Arm A: grep over file CONTENT → `relpath:lineno:line` per match, capped.
function grepContent(root, re) {
  const out = [];
  for (const p of walkTs(root)) {
    const rel = path.relative(root, p).replace(/\\/g, "/");
    fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => { if (re.test(line)) out.push(`${rel}:${i + 1}:${line}`); });
  }
  return capList(out);
}
// Arm A for file-by-name: the path list a `find -name`/Glob hands back.
function grepFiles(root, re) {
  const out = walkTs(root).map((p) => path.relative(root, p).replace(/\\/g, "/")).filter((rel) => re.test(rel));
  return capList(out);
}
function walkTs(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkTs(p, acc); else if (/\.ts$/.test(e.name)) acc.push(p);
  }
  return acc;
}
function capList(out) { const c = out.slice(0, GREP_LINE_CAP); return { tok: tok(c.join("\n")), lines: out.length, capped: out.length > GREP_LINE_CAP }; }

// Arm B: vts runTool.
async function vtsArm(root, toolName, args, kind) {
  const r = await runTool(toolName, { projectPath: root, backend: "typescript", ...args });
  // "mode": symbol/refs are SEMANTIC when the index resolved them; search_text/find_files are FILESYSTEM.
  let mode = "filesystem";
  if (kind === "semantic") mode = (!r.isError && !/Literal text matches|No backend resolved/.test(r.text)) ? "semantic" : "text-fallback";
  return { tok: tok(r.text), ok: !r.isError, mode };
}

const scenarios = [
  { name: "find symbol declaration", grep: (root) => grepContent(root, /\bprocessPayment\b/), vts: (root) => vtsArm(root, "search_symbol", { q: "processPayment" }, "semantic") },
  { name: "find all references", grep: (root) => grepContent(root, /\bprocessPayment\b/), vts: (root) => vtsArm(root, "find_references", { symbol: "processPayment" }, "semantic") },
  { name: "text search ('retry loop')", grep: (root) => grepContent(root, /retry loop/), vts: (root) => vtsArm(root, "search_text", { q: "retry loop" }, "text") },
  { name: "find file by name ('caller')", grep: (root) => grepFiles(root, /caller/), vts: (root) => vtsArm(root, "find_files", { q: "caller" }, "file") },
];

// ── Sweep ────────────────────────────────────────────────────────────────────────────────────────
const bySize = {};
for (const n of SIZES) {
  const root = buildCorpus(n);
  const rows = [];
  for (const s of scenarios) {
    const a = s.grep(root);
    const b = await s.vts(root);
    rows.push({ scenario: s.name, grepTok: a.tok, grepLines: a.lines, grepCapped: a.capped, vtsTok: b.tok, vtsMode: b.mode, vtsOk: b.ok, reduction: a.tok > 0 ? 1 - b.tok / a.tok : 0 });
  }
  bySize[n] = rows;
}

// ── Report ───────────────────────────────────────────────────────────────────────────────────────
const totalsFor = (rows) => { const g = rows.reduce((n, r) => n + r.grepTok, 0), v = rows.reduce((n, r) => n + r.vtsTok, 0); return { g, v, red: g > 0 ? 1 - v / g : 0 }; };

let md = `# vs-token-safer benchmark — Bash grep vs vts (deterministic, no API)\n\n`;
md += `Synthetic TypeScript corpus, ${scenarios.length} code-search scenarios, swept across corpus size.\n`;
md += `Token ≈ bytes ÷ 4 (same as the product ledger). Grep arm = matching \`file:line:text\` (or a path\n`;
md += `list for file-by-name) capped at ${GREP_LINE_CAP} lines (Claude's Grep tool). vts arm = the\n`;
md += `token-capped \`file:line\` output. Reproduce: \`npm run bench\`.\n\n`;

md += `## Reduction vs corpus size (the win scales)\n\n`;
md += `| caller files | grep tokens | vts tokens | reduction |\n|--:|--:|--:|--:|\n`;
for (const n of SIZES) { const t = totalsFor(bySize[n]); md += `| ${n} | ${t.g} | ${t.v} | **${pct(t.red)}** |\n`; }
md += `\nGrep grows with the match count; vts stays capped — so the reduction climbs with repo size. On a\n`;
md += `tiny corpus a narrow text/file search is a wash (vts's header overhead ≈ grep); the semantic\n`;
md += `scenarios (symbol/refs) win even there because grep over-reports comments/strings/substrings.\n\n`;

const big = SIZES[SIZES.length - 1];
md += `## Per-scenario at ${big} files\n\n`;
md += `| Scenario | grep tokens | vts tokens | reduction | vts mode |\n|---|--:|--:|--:|---|\n`;
for (const r of bySize[big]) {
  const mode = !r.vtsOk ? "ERROR" : r.vtsMode;
  md += `| ${r.scenario} | ${r.grepTok}${r.grepCapped ? " (capped)" : ""} | ${r.vtsTok} | **${pct(r.reduction)}** | ${mode} |\n`;
}
const bt = totalsFor(bySize[big]);
md += `| **TOTAL** | **${bt.g}** | **${bt.v}** | **${pct(bt.red)}** | |\n\n`;

md += `## Cost per model at ${big} files (token delta × input price)\n\n`;
md += `Saved = (grep − vts) input tokens × list input price. List prices, verify at anthropic.com/pricing.\n\n`;
md += `| Model | $/Mtok (in) | grep cost | vts cost | saved | cheaper |\n|---|--:|--:|--:|--:|--:|\n`;
const costRows = [];
for (const [model, price] of Object.entries(PRICES)) {
  const gc = (bt.g / 1e6) * price, vc = (bt.v / 1e6) * price;
  costRows.push({ model, price, grepCost: gc, vtsCost: vc, saved: gc - vc });
  md += `| ${model} | $${price.toFixed(2)} | $${gc.toFixed(6)} | $${vc.toFixed(6)} | $${(gc - vc).toFixed(6)} | ${pct(bt.red)} |\n`;
}
md += `\n> Absolute $ per query is tiny — the win compounds across the many searches in a real session and\n`;
md += `> grows with repo size. On a real Unreal Engine project the same A/B is ~282k → ~2k tokens (~138×);\n`;
md += `> see BENCHMARK.md.\n`;

console.log(md);

const results = { generatedBy: "benchmarks/run.mjs", tokenEstimate: "bytes/4", grepLineCap: GREP_LINE_CAP, sizes: SIZES, bySize, costAtMax: { files: big, rows: costRows }, prices: PRICES };
const outDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "results");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "latest.json"), JSON.stringify(results, null, 2) + "\n");
fs.writeFileSync(path.join(outDir, "latest.md"), md);

await disposeClients();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

// Non-fatal sanity: the largest corpus should show a solid overall reduction and no errored scenario.
const errored = bySize[big].filter((r) => !r.vtsOk);
if (errored.length) { console.error(`\n[warn] ${errored.length} scenario(s) errored at ${big} files — is the typescript backend installed?`); for (const r of errored) console.error(`  - ${r.scenario}`); }
else if (bt.red < 0.5) console.error(`\n[warn] overall reduction at ${big} files is ${pct(bt.red)} (<50%) — unexpected; check the backend resolved semantic results.`);
console.log(`\nResults written to benchmarks/results/latest.{json,md}. Reproduce: npm run bench`);
