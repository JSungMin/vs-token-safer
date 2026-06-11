#!/usr/bin/env node
// Self-contained eval for vs-token-safer. Uses a MOCK language server (no clangd/Roslyn toolchain
// needed) to exercise the genuinely-new layer: the LSP client, the token-capping symbol/reference
// formatter, and the runTool dispatch. Asserts the token win + correct file:line shape. CI-friendly.
import { LspClient } from "../server/lsp.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.VTS_CLANGD_CMD = process.execPath;
process.env.VTS_CLANGD_ARGS = new URL("./_mock-lsp.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
// Isolate the query-history ledger to a temp file (set BEFORE core/warmset load — read at module init)
// so the eval's recordQueryResults calls never touch the user's real ~/.vs-token-safer ledger.
const QH = path.join(os.tmpdir(), `vts-eval-qh-${process.pid}.json`);
process.env.VTS_QUERY_HISTORY = QH;
const IG = path.join(os.tmpdir(), `vts-eval-ig-${process.pid}.json`); // isolate the include-graph cache
process.env.VTS_INCLUDE_GRAPH = IG;
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
const { parseClangdMajor, MIN_CLANGD, BACKENDS } = await import("../server/backends/index.js");
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

// 10) prewarm ORDERING — query-history ranks a hot file first (hit-rate), and the remote-index arg
// (⑥ prebuilt/shared index) is wired. git/p4 recency + mtime are best-effort and not asserted here.
const { orderForWarm, recordQueryResults } = await import("../server/warmset.js");
const qhRoot = "/proj/warmtest";
recordQueryResults(qhRoot, ["/proj/warmtest/hot.cpp"]); // seed history → hot.cpp should rank first
const ordered = orderForWarm(qhRoot, ["/proj/warmtest/cold.cpp", "/proj/warmtest/hot.cpp"], 10);
const orderHotFirst = (ordered[0] || "").toLowerCase().endsWith("hot.cpp");
process.env.VTS_CLANGD_REMOTE = "localhost:9000";
const savedArgs = process.env.VTS_CLANGD_ARGS;
delete process.env.VTS_CLANGD_ARGS; // the explicit ARGS override short-circuits args(); clear it to test the built args
const remoteWired = BACKENDS.clangd.args("/proj").some((x) => x.includes("--remote-index-address=localhost:9000"));
process.env.VTS_CLANGD_ARGS = savedArgs;
delete process.env.VTS_CLANGD_REMOTE;
const orderingOk = orderHotFirst && remoteWired;

// 11) centrality (③) — a header #included by multiple candidates ranks above an unreferenced leaf
// (no history/VCS for this temp dir, so centrality decides). Also exercises the working-now (④) path.
const cdir = path.join(os.tmpdir(), `vts-cent-${process.pid}`);
fs.mkdirSync(cdir, { recursive: true });
fs.writeFileSync(path.join(cdir, "hub.h"), "#pragma once\n");
fs.writeFileSync(path.join(cdir, "a.cpp"), '#include "hub.h"\n');
fs.writeFileSync(path.join(cdir, "b.cpp"), '#include "hub.h"\n');
fs.writeFileSync(path.join(cdir, "leaf.cpp"), "int x;\n");
const cands = ["a.cpp", "b.cpp", "leaf.cpp", "hub.h"].map((f) => path.join(cdir, f));
const cord = orderForWarm(cdir, cands, 10).map((p) => p.toLowerCase());
const idx = (n) => cord.findIndex((p) => p.endsWith(n));
const centralityRankOk = idx("hub.h") !== -1 && idx("hub.h") < idx("leaf.cpp");
// adaptive cache: the first run persisted the include-graph; a second run with the read budget at 0
// (cache-only — no fresh file reads) must still rank hub.h first, proving the cache is reused & grows.
const graphPersisted = fs.existsSync(IG);
process.env.VTS_CENTRALITY_BUDGET_MS = "0";
const cord2 = orderForWarm(cdir, cands, 10).map((p) => p.toLowerCase());
delete process.env.VTS_CENTRALITY_BUDGET_MS;
const cacheReuseOk = cord2.findIndex((p) => p.endsWith("hub.h")) < cord2.findIndex((p) => p.endsWith("leaf.cpp"));
const centralityOk = centralityRankOk && graphPersisted && cacheReuseOk;
try { fs.rmSync(cdir, { recursive: true, force: true }); } catch { /* ignore */ }

// 12) new read-only tools — hover + document_symbols (mock LSP), find_files + search_text (filesystem).
const someFile = path.join(process.cwd(), "eval", "run.mjs");
const hv = await runTool("hover", { path: someFile, line: 0, character: 0, backend: "clangd" });
const hoverOk = !hv.isError && /Foo/.test(hv.text);
const ds = await runTool("document_symbols", { path: someFile, backend: "clangd" });
const docSymOk = !ds.isError && /Foo/.test(ds.text) && /:5/.test(ds.text);
const tdir = path.join(os.tmpdir(), `vts-files-${process.pid}`);
fs.mkdirSync(tdir, { recursive: true });
fs.writeFileSync(path.join(tdir, "Widget.cpp"), "int NEEDLE_TOKEN = 1;\n");
const ff = await runTool("find_files", { q: "*.cpp", projectPath: tdir });
const findFilesOk = !ff.isError && /Widget\.cpp/.test(ff.text);
const st = await runTool("search_text", { q: "NEEDLE_TOKEN", projectPath: tdir });
const searchTextOk = !st.isError && /NEEDLE_TOKEN/.test(st.text) && /Widget\.cpp:1/.test(st.text);
try { fs.rmSync(tdir, { recursive: true, force: true }); } catch { /* ignore */ }
const newToolsOk = hoverOk && docSymOk && findFilesOk && searchTextOk;

// 13) rename — preview returns affected file:line and does NOT write; apply writes the edit to disk.
const rdir = path.join(os.tmpdir(), `vts-rename-${process.pid}`);
fs.mkdirSync(rdir, { recursive: true });
const rfile = path.join(rdir, "r.cpp");
fs.writeFileSync(rfile, "abcXYZ rest\n"); // mock replaces [0,0]-[0,3] ("abc") with newName
const rp = await runTool("rename", { path: rfile, line: 0, character: 0, newName: "NEW", backend: "clangd" });
const renamePreviewOk = !rp.isError && /PREVIEW/.test(rp.text) && /r\.cpp:1/.test(rp.text) && fs.readFileSync(rfile, "utf8").startsWith("abc");
const ra = await runTool("rename", { path: rfile, line: 0, character: 0, newName: "NEW", backend: "clangd", apply: true });
const renameApplyOk = !ra.isError && /APPLIED/.test(ra.text) && fs.readFileSync(rfile, "utf8").startsWith("NEW");
// multi-edit-per-file: mock returns two same-line edits front-to-back; back-to-front offset apply must
// yield "X bbb ZZZZ\n". A forward (un-sorted) apply would shift offsets and corrupt the second edit.
const rfile2 = path.join(rdir, "r2.cpp");
fs.writeFileSync(rfile2, "aaa bbb ccc\n");
const rm = await runTool("rename", { path: rfile2, line: 0, character: 0, newName: "MULTI", backend: "clangd", apply: true });
const renameMultiOk = !rm.isError && /APPLIED/.test(rm.text) && fs.readFileSync(rfile2, "utf8") === "X bbb ZZZZ\n";
try { fs.rmSync(rdir, { recursive: true, force: true }); } catch { /* ignore */ }
const renameOk = renamePreviewOk && renameApplyOk && renameMultiOk;

// 15) JS/TS + Python backends — auto-detect ordering and languageId mapping. Pure functions, so no
// live tsserver/pyright is needed; this guards that adding the new backends didn't shadow clangd/roslyn
// and that didOpen gets the right languageId per file extension.
const { pickBackend } = await import("../server/backends/index.js");
const { langIdForPath } = await import("../server/lsp.js");
const mkBeDir = (sub, files) => {
  const d = path.join(os.tmpdir(), `vts-be-${process.pid}-${sub}`);
  fs.mkdirSync(d, { recursive: true });
  for (const [n, body] of Object.entries(files)) fs.writeFileSync(path.join(d, n), body);
  return d;
};
const tsDir = mkBeDir("ts", { "tsconfig.json": "{}", "app.ts": "export const x = 1;\n" });
const pyDir = mkBeDir("py", { "pyproject.toml": "", "main.py": "x = 1\n" });
const pkgDir = mkBeDir("pkg", { "package.json": "{}" });
const mixDir = mkBeDir("mix", { "compile_commands.json": "[]", "package.json": "{}" }); // C++ DB + package.json → clangd wins
const detectOk =
  pickBackend(tsDir) === "typescript" &&
  pickBackend(pyDir) === "pyright" &&
  pickBackend(pkgDir) === "typescript" &&
  pickBackend(mixDir) === "clangd";
const langOk =
  langIdForPath("a.ts", "typescript") === "typescript" &&
  langIdForPath("a.tsx", "typescript") === "typescriptreact" &&
  langIdForPath("a.mjs", "typescript") === "javascript" &&
  langIdForPath("a.py", "pyright") === "python" &&
  langIdForPath("a.cs", "roslyn") === "csharp" &&
  langIdForPath("a.cpp", "clangd") === "cpp" &&
  langIdForPath("noext", "pyright") === "python"; // unknown ext → backend default
// nodeLspBackend wiring: ts/pyright end with --stdio, winShell is a boolean, and when the bundled bin
// resolved we launch via `node <bin>` (cmd = this node, ≥2 args). Install-state-agnostic (the bin may or
// may not be present in CI), so it asserts the shape, not a specific path.
const tsArgs = BACKENDS.typescript.args(process.cwd());
const pyArgs = BACKENDS.pyright.args(process.cwd());
const wiringOk =
  tsArgs[tsArgs.length - 1] === "--stdio" && pyArgs[pyArgs.length - 1] === "--stdio" &&
  typeof BACKENDS.typescript.winShell === "boolean" && typeof BACKENDS.pyright.winShell === "boolean" &&
  (BACKENDS.typescript.cmd === process.execPath ? tsArgs.length >= 2 && BACKENDS.typescript.winShell === false : true) &&
  (BACKENDS.pyright.cmd === process.execPath ? pyArgs.length >= 2 && BACKENDS.pyright.winShell === false : true);
const multiLangOk = detectOk && langOk && wiringOk;
for (const d of [tsDir, pyDir, pkgDir, mixDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }

await disposeClients();
try { fs.rmSync(QH, { force: true }); } catch { /* ignore */ }
try { fs.rmSync(IG, { force: true }); } catch { /* ignore */ }

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
  ["warm ordering (history) + remote arg", orderingOk, "true", orderingOk],
  ["centrality + adaptive graph cache", centralityOk, "true", centralityOk],
  ["new tools: hover/symbols/files/text", newToolsOk, "true", newToolsOk],
  ["rename preview + apply + multi-edit", renameOk, "true", renameOk],
  ["js/ts + python backends: detect + langId", multiLangOk, "true", multiLangOk],
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
