#!/usr/bin/env node
// Self-contained eval for vs-token-safer. Uses a MOCK language server (no clangd/Roslyn toolchain
// needed) to exercise the genuinely-new layer: the LSP client, the token-capping symbol/reference
// formatter, and the runTool dispatch. Asserts the token win + correct file:line shape. CI-friendly.
import { LspClient } from "../server/lsp.js";

process.env.VTS_CLANGD_CMD = process.execPath;
process.env.VTS_CLANGD_ARGS = new URL("./_mock-lsp.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const { runTool, disposeClients, prewarm } = await import("../server/core.js");

const tok = (s) => Math.round(Buffer.byteLength(String(s), "utf8") / 4);

// 1) LSP client handshake + workspace/symbol against the mock.
const c = new LspClient(process.execPath, [process.env.VTS_CLANGD_ARGS], { cwd: process.cwd() });
await c.initialize(process.cwd());
const syms = (await c.symbol("Spawn")) || [];
await c.shutdown();
const lspOk = syms.length === 2 && syms[0].name === "SpawnHandler";

// 2) runTool search_symbol — compact file:line, no bodies.
const r1 = await runTool("search_symbol", { q: "Spawn", projectPath: process.cwd(), backend: "clangd" });
const fmtOk = !r1.isError && /class SpawnHandler {2}@ \/proj\/src\/Foo\.cpp:42/.test(r1.text) && !/character|range|"kind"/.test(r1.text);

// 3) token cap — a 1000-symbol index response collapses to a capped file:line list.
const big = await runTool("search_symbol", { q: "ALL", projectPath: process.cwd(), backend: "clangd", maxResults: 60 });
const rawBig = JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ name: `Symbol_${i}`, kind: 12, containerName: `Namespace::Deeply::Nested::Container_${i % 50}`, location: { uri: `file:///proj/src/Module_${i % 80}/File_${i}.cpp`, range: { start: { line: i, character: 4 }, end: { line: i, character: 24 } } } })));
const rawTok = tok(rawBig), outTok = tok(big.text);
const capReduction = 1 - outTok / rawTok;
const capped = /… 940 more/.test(big.text);

// 4) references wiring.
const r2 = await runTool("find_references", { path: "src/Foo.cpp", line: 41, character: 6, projectPath: process.cwd(), backend: "clangd" });
const refOk = !r2.isError && /reference\(s\)/.test(r2.text);

// 5) MCP=CLI parity: both go through runTool; the dispatch is the shared layer (smoke).
const dispatchOk = lspOk && fmtOk && refOk;

// 6) VTS_LSP_TIMEOUT_MS honored — a request slower than the configured timeout rejects (the cold
// UE-scale fix: users can raise the ceiling instead of silently timing out at a hardcoded 30s).
// Set the env only AROUND the slow request — not during initialize (the handshake would race a 50ms cap).
const ct = new LspClient(process.execPath, [process.env.VTS_CLANGD_ARGS], { cwd: process.cwd() });
await ct.initialize(process.cwd());
let timeoutHonored = false;
try {
  process.env.VTS_LSP_TIMEOUT_MS = "50"; // mock delays "SLOW" 300ms → request() default timeout (50ms) rejects
  await ct.symbol("SLOW");
} catch (e) { timeoutHonored = /timed out/.test(e.message); }
finally { delete process.env.VTS_LSP_TIMEOUT_MS; }
await ct.shutdown();

// 7) index-ready signal — afterInit waits for clangd's background-index completion ($/progress
// kind:end) before the first query, instead of racing the still-building index.
const cp = new LspClient(process.execPath, [process.env.VTS_CLANGD_ARGS], { cwd: process.cwd() });
await cp.initialize(process.cwd());
const ready = await cp.waitForNotification("$/progress", 2000, (p) => p && p.value && p.value.kind === "end");
await cp.shutdown();
const indexReadyOk = !!ready;

// 8) clangd version advisory — parse the major version and gate on the recommended floor (older
// clangd deadlocks on large UE projects; ≥ MIN_CLANGD is the verified-good floor).
// Dynamic import: static would load backends/index.js (capturing BACKENDS.clangd.cmd) before the
// VTS_CLANGD_CMD env above is set; by here core.js has already loaded it with the mock cmd in place.
const { parseClangdMajor, MIN_CLANGD } = await import("../server/backends/index.js");
const verParseOk = parseClangdMajor("clangd version 19.1.5") === 19
  && parseClangdMajor("clangd version 22.1.6 (https://github.com/llvm/llvm-project abc123)") === 22
  && parseClangdMajor("not a version") === null;
const verGateOk = MIN_CLANGD >= 22 && 19 < MIN_CLANGD && 22 >= MIN_CLANGD;
const advisoryOk = verParseOk && verGateOk;

// 9) pre-warm + vts_warmup — IDE-style index warming. prewarm guards bad args; vts_warmup runs the
// warmup path (spawn + afterInit) without a query and reports success.
const prewarmGuardOk = (await prewarm("", "")) === null && (await prewarm("/x", "nope")) === null;
const w = await runTool("vts_warmup", { projectPath: process.cwd(), backend: "clangd" });
const warmupOk = !w.isError && /Warmed clangd/.test(w.text);
const warmOk = prewarmGuardOk && warmupOk;

await disposeClients();

const rows = [
  ["LSP client handshake + symbol", lspOk, "true", lspOk],
  ["symbol → file:line (no bodies)", fmtOk, "true", fmtOk],
  ["token cap (1000 syms → capped)", capped, "true", capped],
  ["token reduction vs raw index", (capReduction * 100).toFixed(1) + "%", "≥ 70%", capReduction >= 0.7],
  ["references wiring", refOk, "true", refOk],
  ["runTool dispatch", dispatchOk, "true", dispatchOk],
  ["VTS_LSP_TIMEOUT_MS honored", timeoutHonored, "true", timeoutHonored],
  ["index-ready ($/progress end) wait", indexReadyOk, "true", indexReadyOk],
  ["clangd version advisory + gate", advisoryOk, "true", advisoryOk],
  ["prewarm guard + vts_warmup", warmOk, "true", warmOk],
];
console.log(`vs-token-safer eval — mock LSP backend\n`);
let ok = true;
for (const [name, val, thr, pass] of rows) {
  console.log(`${pass ? "✓" : "✗"} ${name.padEnd(34)} ${String(val).padStart(8)}   ${thr}`);
  if (!pass) ok = false;
}
console.log(`\nraw index ~${rawTok.toLocaleString()} tok → capped output ~${outTok.toLocaleString()} tok`);
if (!ok) { console.error("\nEVAL FAILED."); process.exit(1); }
console.log("EVAL PASSED.");
