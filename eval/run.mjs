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
const CF = path.join(os.tmpdir(), `vts-eval-cfg-${process.pid}.json`); // isolate the config file (vts_setup writes)
process.env.VTS_CONFIG_FILE = CF;
fs.writeFileSync(CF, "{}"); // start "configured" so the first-use setup nudge doesn't prefix other tests
const SV = path.join(os.tmpdir(), `vts-eval-sv-${process.pid}.json`); // isolate the savings ledger (recordSavings writes)
process.env.VTS_SAVINGS_FILE = SV;
const TEE = path.join(os.tmpdir(), `vts-eval-tee-${process.pid}`); // isolate the tee dir
process.env.VTS_TEE_DIR = TEE;
const EDL = path.join(os.tmpdir(), `vts-eval-edl-${process.pid}.json`); // isolate the edit-adoption ledger
process.env.VTS_EDIT_LEDGER = EDL; // so the symbolic-edit guards don't write the user's real adoption ledger
process.env.VTS_LANG = "en"; // force English UI so message-marker assertions are deterministic regardless of OS locale
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
// (search_symbol now factors the common dir prefix across rows, so the path may be relative under an
// `under <prefix>/` header — assert the symbol + its file:line without requiring a contiguous absolute path.)
const fmtOk = !r1.isError && /class SpawnHandler {2}@ /.test(r1.text) && /Foo\.cpp:42/.test(r1.text) && !/character|range|"kind"/.test(r1.text);

// 3) token cap — a 1000-symbol index response collapses to a capped file:line list.
const big = await runTool("search_symbol", { q: "ALL", projectPath: process.cwd(), backend: "clangd", maxResults: 60 });
const rawBig = JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ name: `Symbol_${i}`, kind: 12, containerName: `Namespace::Deeply::Nested::Container_${i % 50}`, location: { uri: `file:///proj/src/Module_${i % 80}/File_${i}.cpp`, range: { start: { line: i, character: 4 }, end: { line: i, character: 24 } } } })));
const rawTok = tok(rawBig), outTok = tok(big.text);
const capReduction = 1 - outTok / rawTok;
const capped = /… 940 more/.test(big.text);

// 4) references wiring — by position AND by NAME. find_references({symbol}) resolves the declaration via
// workspace/symbol (mock: "Spawn" → SpawnHandler @ Foo.cpp:42) then queries references there, so a
// code-modder gets call sites from a NAME with no line/column. Omitting both errors.
const r2 = await runTool("find_references", { path: "src/Foo.cpp", line: 41, character: 6, projectPath: process.cwd(), backend: "clangd" });
const r2name = await runTool("find_references", { symbol: "Spawn", projectPath: process.cwd(), backend: "clangd" });
const r2none = await runTool("find_references", { projectPath: process.cwd(), backend: "clangd" });
const refOk = !r2.isError && /reference\(s\)/.test(r2.text) &&
  !r2name.isError && /references of "Spawn"/.test(r2name.text) && /Foo\.cpp:42/.test(r2name.text) && /reference\(s\)/.test(r2name.text) &&
  r2none.isError && /symbol/.test(r2none.text) && /path/.test(r2none.text); // "needs symbol … or path …"

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
// hover keeps the signature AND trims a pathological long line to ≤200 chars + "…" (per-line cap, not just
// the ≤8-line cap) — a complex TS/C++ hover can be one multi-thousand-char type.
const hoverOk = !hv.isError && /Foo/.test(hv.text) && /…/.test(hv.text) && !/T{250}/.test(hv.text);
const ds = await runTool("document_symbols", { path: someFile, backend: "clangd" });
process.env.VTS_OUTLINE_RAW = "1";
const dsRaw = await runTool("document_symbols", { path: someFile, backend: "clangd" });
delete process.env.VTS_OUTLINE_RAW;
const docSymOk =
  !ds.isError && /Foo/.test(ds.text) && /:5/.test(ds.text) &&
  /keepMethod/.test(ds.text) &&                  // real method kept
  /realInner/.test(ds.text) &&                   // real decl inside a hidden wrapper NOT orphaned
  /func callback {2}:\d/.test(ds.text) &&        // top-level symbol named 'callback' kept (depth-0); path dropped (single-file outline) → `:line`
  !/map\(\) callback/.test(ds.text) && !/localTmp/.test(ds.text) && // anonymous + nested local hidden
  !/noiseKey/.test(ds.text) &&                   // object-literal prop key (kind 7 under a func) hidden
  /keepProp/.test(ds.text) && /Cls/.test(ds.text) && // but a class property (kind 7 under a class) is KEPT
  /local\/anonymous hidden/.test(ds.text) &&     // the hidden-count note
  /map\(\) callback/.test(dsRaw.text) && /localTmp/.test(dsRaw.text) && /noiseKey/.test(dsRaw.text); // RAW shows all
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

// 16) log steer (rider 0.2.8 parity) — a search aimed at a Logs/ path appends a gamedev-log pointer to the
// result (additive, never blocks); an empty result carries the same hint for the path-less case.
const logRoot = path.join(os.tmpdir(), `vts-eval-${process.pid}-Logs`);
const logDir = path.join(logRoot, "Logs", "sub"); // projectPath contains a `Logs/` segment → LOG_PATHISH hits
fs.mkdirSync(logDir, { recursive: true });
const lsRes = await runTool("search_text", { q: "anything", projectPath: logDir }); // log target → LOG_STEER
const ffRes = await runTool("find_files", { q: "no_such_file_xyz", projectPath: os.tmpdir() }); // empty, non-log
const logSteerOk =
  !lsRes.isError && /This looks like a LOG target/.test(lsRes.text) && // path-based steer (LOG_STEER)
  !ffRes.isError && /gamedev-log/.test(ffRes.text);                    // path-less empty hint (LOG_EMPTY_HINT)
try { fs.rmSync(logRoot, { recursive: true, force: true }); } catch { /* ignore */ }

// 17) PreToolUse hook vectors: Bash code-grep BLOCKS (exit 2), Bash log-grep WARNS+allows (gamedev-log),
// Grep tool on code WARNS+allows. Runs the actual hook as a child with JSON stdin.
const { spawnSync } = await import("node:child_process");
const hookPath = new URL("../hooks/block-code-grep.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const runHook = (payload, env) => {
  const r = spawnSync(process.execPath, [hookPath], { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, ...(env || {}) } });
  return { status: r.status, out: r.stdout || "", err: r.stderr || "" };
};
// A single safe code-grep now REWRITES to the vts CLI (updatedInput), not blocks. A complex pattern / a
// pipeline / VTS_REWRITE=0 falls back to the block.
const hCode = runHook({ tool_name: "Bash", tool_input: { command: "grep -rn Foo src/Thing.cpp" } });
const hCodeBlock = runHook({ tool_name: "Bash", tool_input: { command: "grep -rn Foo src/Thing.cpp" } }, { VTS_REWRITE: "0" });
const hLog = runHook({ tool_name: "Bash", tool_input: { command: "grep Error Saved/Logs/run.log" } });
const hGrep = runHook({ tool_name: "Grep", tool_input: { pattern: "return null", glob: "*.ts" } }); // freeform code text → warns (not a symbol hunt)
const hGrepLog = runHook({ tool_name: "Grep", tool_input: { pattern: "Error", path: "Saved/Logs" } }); // bare Logs dir
let hCodeJson = {}; try { hCodeJson = JSON.parse(hCode.out || "{}"); } catch { /* ignore */ }
const rwOut = hCodeJson.hookSpecificOutput || {};
const hookOk =
  hCode.status === 0 && rwOut.permissionDecision === "allow" &&
  /cli\.js" symbol --q "Foo"/.test(rwOut.updatedInput?.command || "") && // identifier → semantic vts symbol (synergy A)
  hCodeBlock.status === 2 && /caught a code search/.test(hCodeBlock.err) && // VTS_REWRITE=0 → block fallback
  hLog.status === 0 && /gamedev-log/.test(hLog.out) &&
  hGrep.status === 0 && /Grep tool/.test(hGrep.out) &&
  hGrepLog.status === 0 && /gamedev-log/.test(hGrepLog.out);

// 17b) rewrite specifics: `find -name GLOB` → vts files; `git grep PATTERN` → vts text (single safe seg);
// a complex (non-literal) pattern falls back to block; a pipeline falls back to block; excludeCommands
// lets an exec through untouched.
const parseRw = (r) => { try { return JSON.parse(r.out || "{}").hookSpecificOutput || {}; } catch { return {}; } };
const hFind = parseRw(runHook({ tool_name: "Bash", tool_input: { command: "find . -name *.cpp" } }));
const hGitGrep = parseRw(runHook({ tool_name: "Bash", tool_input: { command: "git grep SpawnActor" } }));
const hDotted = parseRw(runHook({ tool_name: "Bash", tool_input: { command: "grep -rn Foo.Bar src/Thing.cpp" } })); // dotted → literal text
// Quote-aware splitting (self-improve round): a quoted alternation / anchored pattern — the top bypass
// shapes `vts discover` surfaced — is ONE segment now, and the regex-safe gate lets it rewrite to
// search_text (which takes a regex). A REAL pipe (outside quotes) still splits → still blocks.
const hAlt = parseRw(runHook({ tool_name: "Bash", tool_input: { command: 'grep -rn "FooA|FooB" src/Thing.cpp' } }));
const hAnchor = parseRw(runHook({ tool_name: "Bash", tool_input: { command: 'grep -rn "^#include" src/Thing.cpp' } }));
const hComplex = runHook({ tool_name: "Bash", tool_input: { command: "grep -rn 'a b' src/Thing.cpp" } }); // space → unsafe → block
const hPipe = runHook({ tool_name: "Bash", tool_input: { command: "grep -rn Foo src/Thing.cpp | head" } }); // pipeline → block
const hExcluded = runHook({ tool_name: "Bash", tool_input: { command: "rg Foo src/Thing.cpp" } }, { VTS_EXCLUDE_COMMANDS: "rg" });
const rewriteOk =
  /cli\.js" files --q "\*\.cpp"/.test(hFind.updatedInput?.command || "") &&
  /cli\.js" symbol --q "SpawnActor"/.test(hGitGrep.updatedInput?.command || "") &&  // git grep identifier → symbol
  /cli\.js" text --q "Foo\.Bar"/.test(hDotted.updatedInput?.command || "") &&        // dotted literal → text
  /cli\.js" text --q "FooA\|FooB"/.test(hAlt.updatedInput?.command || "") &&         // quoted alternation → text (regex)
  /cli\.js" text --q "\^#include"/.test(hAnchor.updatedInput?.command || "") &&      // quoted anchor → text (regex)
  hComplex.status === 2 && /caught a code search/.test(hComplex.err) &&
  hPipe.status === 2 &&
  hExcluded.status === 0 && !/caught a code search/.test(hExcluded.err) && !(parseRw(hExcluded).updatedInput); // excluded → untouched

// 18) search_text covers JS/TS/Py (scanTextUnder ext set, not just C/C++/C#), and search_symbol on a
// typescript/pyright backend falls back to a literal text search when the index returns nothing (a
// non-exported / unopened-file symbol the workspace/symbol index can't surface).
const tsTextDir = path.join(os.tmpdir(), `vts-eval-${process.pid}-tstext`);
fs.mkdirSync(tsTextDir, { recursive: true });
fs.writeFileSync(path.join(tsTextDir, "mod.ts"), "export function MISS_localHelper() { return 1; }\n");
const stTs = await runTool("search_text", { q: "MISS_localHelper", projectPath: tsTextDir });
const searchTextJsOk = !stTs.isError && /mod\.ts:1/.test(stTs.text); // .ts is now scanned
// fallback: run the CLI in a CHILD so the mock can back the `typescript` backend without disturbing this
// process's cached BACKENDS. q="MISS" → mock returns [] → fallback text search finds the .ts.
const cliPath = new URL("../server/cli.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const fb = spawnSync(
  process.execPath,
  [cliPath, "symbol", "--q", "MISS", "--projectPath", tsTextDir, "--backend", "typescript"],
  { encoding: "utf8", env: { ...process.env,
    VTS_TS_CMD: process.platform === "win32" ? `"${process.execPath}"` : process.execPath, // quote: execPath may have spaces (shell mode on win)
    VTS_TS_ARGS: process.env.VTS_CLANGD_ARGS, VTS_QUERY_HISTORY: QH, VTS_INCLUDE_GRAPH: IG } },
);
const fallbackOk = (fb.stdout || "").includes("Literal text matches") && /mod\.ts/.test(fb.stdout || "");
try { fs.rmSync(tsTextDir, { recursive: true, force: true }); } catch { /* ignore */ }
const jsTextOk = searchTextJsOk && fallbackOk;

// 19) language census + adaptive warm cap + multi-backend prewarm selection (pure functions, no LSP).
const { languageCensus, warmCap, prewarmBackends } = await import("../server/warmset.js");
const censusDir = path.join(os.tmpdir(), `vts-eval-${process.pid}-census`);
fs.mkdirSync(path.join(censusDir, "src"), { recursive: true });
fs.mkdirSync(path.join(censusDir, "node_modules", "x"), { recursive: true });
for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(censusDir, "src", `f${i}.cpp`), "");
for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(censusDir, "src", `m${i}.ts`), "");
fs.writeFileSync(path.join(censusDir, "node_modules", "x", "junk.cpp"), ""); // skipped dir → not counted
const census = languageCensus(censusDir);
const censusOk = census.clangd === 30 && census.typescript === 5 && census.roslyn === 0 && census.total === 35;
// adaptive cap: explicit override wins; small count → base; scaling clamps to [base, MAX].
const capOverrideOk = (() => { process.env.VTS_TS_OPEN_CAP = "7"; const c = warmCap(censusDir, "typescript", "VTS_TS_OPEN_CAP", 60); delete process.env.VTS_TS_OPEN_CAP; return c === 7; })();
const capBaseOk = warmCap(censusDir, "typescript", "VTS_TS_OPEN_CAP", 60) === 60; // 5*0.1 < base → base
const capScaleOk = (() => { process.env.VTS_WARM_CAP_RATIO = "2"; const c = warmCap(censusDir, "clangd", "VTS_CLANGD_OPEN_CAP", 10); delete process.env.VTS_WARM_CAP_RATIO; return c === 60; })(); // 30*2=60
const pbDefault = prewarmBackends(censusDir, "clangd"); // unset → [picked]
const pbAll = (() => { process.env.VTS_PREWARM_BACKENDS = "all"; const r = prewarmBackends(censusDir, "clangd"); delete process.env.VTS_PREWARM_BACKENDS; return r; })();
const pbList = (() => { process.env.VTS_PREWARM_BACKENDS = "typescript,pyright"; const r = prewarmBackends(censusDir, "clangd"); delete process.env.VTS_PREWARM_BACKENDS; return r; })();
const prewarmSelOk =
  pbDefault.length === 1 && pbDefault[0] === "clangd" &&
  pbAll.length === 2 && pbAll[0] === "clangd" && pbAll[1] === "typescript" && // dominant (more files) first
  pbList.length === 2 && pbList[0] === "typescript";
try { fs.rmSync(censusDir, { recursive: true, force: true }); } catch { /* ignore */ }
const warmRatioOk = censusOk && capOverrideOk && capBaseOk && capScaleOk && prewarmSelOk;

// 20) vts_setup language auto-config: a multi-language root → census reported + prewarmBackends auto-set "all".
const setupDir = path.join(os.tmpdir(), `vts-eval-${process.pid}-setup`);
fs.mkdirSync(path.join(setupDir, "src"), { recursive: true });
fs.writeFileSync(path.join(setupDir, "src", "a.cpp"), "");
fs.writeFileSync(path.join(setupDir, "src", "b.ts"), "");
const su = await runTool("vts_setup", { projectPath: setupDir });
const setupOk = !su.isError && /Languages under/.test(su.text) && /prewarmBackends="all"/.test(su.text);
try { fs.rmSync(setupDir, { recursive: true, force: true }); } catch { /* ignore */ }

// 21) first-use setup nudge: with NO config file, a search result is prefixed with a setup pointer (once),
// and the hook appends one to its block. Delete the isolated config to simulate an unconfigured install.
try { fs.rmSync(CF, { force: true }); } catch { /* ignore */ }
const fnNudge = await runTool("find_files", { q: "no_such", projectPath: os.tmpdir() });
// VTS_REWRITE=0 forces the block path (rewrite would exit 0 with no stderr) so the setup line is asserted.
const hNudge = runHook({ tool_name: "Bash", tool_input: { command: "grep -rn Foo src/Thing.cpp" } }, { VTS_REWRITE: "0" }); // CF gone → setup line
const setupNudgeOk =
  !fnNudge.isError && /isn't configured/.test(fnNudge.text) &&
  hNudge.status === 2 && /\/vs-token-safer:setup/.test(hNudge.err);

// 22) manifest version parity — the `claude plugin validate --strict` gate (CI `validate` job): each
// marketplace.json entry version MUST match that plugin's plugin.json, or strict validation fails. This
// caught a real drift (bundled gamedev synced to 0.10.3 while the marketplace entry stayed 0.10.1).
const rd = (rel) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url)));
const mkt = rd("../.claude-plugin/marketplace.json");
const mEntry = (n) => mkt.plugins.find((p) => p.name === n) || {};
const manifestOk =
  mEntry("vs-token-safer").version === rd("../.claude-plugin/plugin.json").version &&
  mEntry("gamedev-log-analyzer").version === rd("../gamedev-log-analyzer/.claude-plugin/plugin.json").version;

// 23) buffer freshness: didOpen on a NEW doc → didOpen(v1); re-didOpen an already-open doc → didChange
// (bumped version, current disk text — refreshes a file changed after warm-up); a since-deleted file →
// didClose. Capture the wire by spying on notify().
const fc = new LspClient(process.execPath, [process.env.VTS_CLANGD_ARGS], { cwd: process.cwd() });
await fc.initialize(process.cwd());
const sent = [];
const realNotify = fc.notify.bind(fc);
fc.notify = (m, p) => { sent.push(m); return realNotify(m, p); };
const ftmp = path.join(os.tmpdir(), `vts-eval-${process.pid}-fresh.cpp`);
fs.writeFileSync(ftmp, "int A = 1;\n");
fc.didOpen(ftmp, "cpp"); // → didOpen v1
fs.writeFileSync(ftmp, "int B = 2;\n");
fc.didOpen(ftmp, "cpp"); // already open → didChange v2
fs.rmSync(ftmp, { force: true });
fc.didOpen(ftmp, "cpp"); // read fails → didClose
await fc.shutdown();
const freshOk =
  sent.filter((m) => m === "textDocument/didOpen").length === 1 &&
  sent.includes("textDocument/didChange") &&
  sent.includes("textDocument/didClose");

// 24) LSP spec conformance: server→client request replies have correct shapes (config→array, applyEdit→
// {applied}, showDocument→{success}, void→null, unknown→MethodNotFound); $/cancelRequest fires on timeout;
// the client declares the synchronization + workspace.configuration capabilities it actually uses.
const lc = new LspClient(process.execPath, [process.env.VTS_CLANGD_ARGS], { cwd: process.cwd() });
const rep = (method, params) => lc._serverRequestReply({ id: 7, method, params });
const cfg = rep("workspace/configuration", { items: [{}, {}, {}] });
const replyShapesOk =
  Array.isArray(cfg.result) && cfg.result.length === 3 && cfg.result.every((x) => x === null) &&
  rep("workspace/applyEdit", {}).result?.applied === false &&
  rep("window/showDocument", {}).result?.success === false &&
  rep("client/registerCapability", {}).result === null &&
  rep("window/workDoneProgress/create", {}).result === null &&
  rep("x/unknownMethod", {}).error?.code === -32601;
let initParams = null;
const origSend = lc._send.bind(lc);
lc._send = (obj) => { if (obj && obj.method === "initialize") initParams = obj.params; return origSend(obj); };
await lc.initialize(process.cwd());
const capOk = !!(initParams && initParams.capabilities.textDocument.synchronization && initParams.capabilities.workspace.configuration === true);
const csent = [];
const rn = lc.notify.bind(lc);
lc.notify = (m, pr) => { csent.push(m); return rn(m, pr); };
let cancelOk = false;
try { process.env.VTS_LSP_TIMEOUT_MS = "50"; await lc.symbol("SLOW"); } // mock delays 300ms → times out at 50ms
catch { cancelOk = csent.includes("$/cancelRequest"); }
finally { delete process.env.VTS_LSP_TIMEOUT_MS; }
await lc.shutdown();
const conformanceOk = replyShapesOk && capOk && cancelOk;

// 25) clangd with no compile database: hasCompileDb/compileDbAdvisory detect+advise; search_symbol falls
// back to a literal text search (a .uproject-only C++ project would otherwise return nothing).
const { hasCompileDb, compileDbAdvisory } = await import("../server/core.js");
const noDb = path.join(os.tmpdir(), `vts-eval-${process.pid}-nodb`);
fs.mkdirSync(noDb, { recursive: true });
fs.writeFileSync(path.join(noDb, "Thing.cpp"), "void MISS_cppFn() {}\n");
const withDb = path.join(os.tmpdir(), `vts-eval-${process.pid}-withdb`);
fs.mkdirSync(withDb, { recursive: true });
fs.writeFileSync(path.join(withDb, "compile_commands.json"), "[]");
const dbAdvisoryOk =
  !hasCompileDb(noDb) && hasCompileDb(withDb) &&
  /compile_commands/.test(compileDbAdvisory(noDb)) && compileDbAdvisory(withDb) === "";
const csym = await runTool("search_symbol", { q: "MISS", backend: "clangd", projectPath: noDb }); // mock [] → text fallback
const clangdFallbackOk =
  !csym.isError && /Literal text matches/.test(csym.text) &&
  /clangd has no usable index/.test(csym.text) && /Thing\.cpp/.test(csym.text);
for (const d of [noDb, withDb]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
const clangdNoDbOk = dbAdvisoryOk && clangdFallbackOk;

// 26) vts_gen_compile_db DRY RUN: build the UBT GenerateClangDatabase command for a .uproject, no execution.
const { genCompileDbPlan } = await import("../server/core.js");
const ueDir = path.join(os.tmpdir(), `vts-eval-${process.pid}-ue`);
fs.mkdirSync(path.join(ueDir, "Engine", "Build", "BatchFiles"), { recursive: true });
fs.writeFileSync(path.join(ueDir, "MyGame.uproject"), "{}");
fs.writeFileSync(path.join(ueDir, "Engine", "Build", "BatchFiles", process.platform === "win32" ? "RunUBT.bat" : "RunUBT.sh"), "");
const plan = genCompileDbPlan(ueDir, {});
const planOk =
  !plan.error && /MyGameEditor/.test(plan.cmdline) && /GenerateClangDatabase/.test(plan.cmdline) &&
  /-Compiler=VisualCpp/.test(plan.cmdline) && /MyGame\.uproject/.test(plan.cmdline);
const dry = await runTool("vts_gen_compile_db", { projectPath: ueDir }); // apply unset → dry run, never executes
const dryOk = !dry.isError && /DRY RUN/.test(dry.text) && /GenerateClangDatabase/.test(dry.text) && !fs.existsSync(path.join(ueDir, "compile_commands.json"));
try { fs.rmSync(ueDir, { recursive: true, force: true }); } catch { /* ignore */ }
const genDbOk = planOk && dryOk;

// 27) no silent caps: find_files / search_text flag a truncated (capped) sweep; a complete sweep doesn't.
const capDir = path.join(os.tmpdir(), `vts-eval-${process.pid}-cap`);
fs.mkdirSync(capDir, { recursive: true });
for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(capDir, `f${i}.cpp`), "NEEDLE\nNEEDLE\nNEEDLE\n");
const ffCap = await runTool("find_files", { q: "*.cpp", projectPath: capDir, maxResults: 2 });
const stCap = await runTool("search_text", { q: "NEEDLE", projectPath: capDir, maxResults: 2 });
const ffFull = await runTool("find_files", { q: "*.cpp", projectPath: capDir, maxResults: 50 });
const ffExact = await runTool("find_files", { q: "*.cpp", projectPath: capDir, maxResults: 5 }); // exactly 5 files → complete
const truncOk =
  !ffCap.isError && /capped at 2/.test(ffCap.text) &&
  !stCap.isError && /capped at 2/.test(stCap.text) &&
  !ffFull.isError && !/capped/.test(ffFull.text) && // complete sweep → no truncation note
  !ffExact.isError && !/capped/.test(ffExact.text) && /5 file/.test(ffExact.text); // exactly max → NOT a false "cap" (limit+1)
try { fs.rmSync(capDir, { recursive: true, force: true }); } catch { /* ignore */ }

// 28) savings upgrade — graph/daily/history breakdowns render + an estimated USD line. The ledger has runs
// from the searches above (isolated to SV). Assert the new sections appear on request, not by default.
const svPlain = await runTool("vts_savings", {});
const svRich = await runTool("vts_savings", { daily: true, history: true });
const svNoGraph = await runTool("vts_savings", { graph: false });
const savingsUpgradeOk =
  !svPlain.isError && /est\. value: ~\$/.test(svPlain.text) &&            // USD line always present
  /Saved tokens \/ day \(last 30\)/.test(svPlain.text) &&                 // graph shown BY DEFAULT now
  !/Saved tokens \/ day/.test(svNoGraph.text) &&                          // graph:false suppresses it
  /Daily \(last/.test(svRich.text) &&                                     // --daily (opt-in)
  /Recent runs:/.test(svRich.text);                                       // --history (opt-in)

// 29) tee-on-truncation — a truncated find_files/search_text writes the full set to a tee file and
// references it; VTS_TEE=off suppresses it.
const teeDir = path.join(os.tmpdir(), `vts-eval-${process.pid}-teesrc`);
fs.mkdirSync(teeDir, { recursive: true });
for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(teeDir, `f${i}.cpp`), "NEEDLE\n");
const teeRes = await runTool("find_files", { q: "*.cpp", projectPath: teeDir, maxResults: 2 }); // truncated → tee
const teeMatch = (teeRes.text.match(/written to (\S+\.txt)/) || [])[1];
const teeFileOk = !!teeMatch && fs.existsSync(teeMatch) && fs.readFileSync(teeMatch, "utf8").split(/\r?\n/).filter(Boolean).length === 6;
process.env.VTS_TEE = "off";
const teeOff = await runTool("find_files", { q: "*.cpp", projectPath: teeDir, maxResults: 2 });
delete process.env.VTS_TEE;
const teeOk = !teeRes.isError && /capped at 2/.test(teeRes.text) && teeFileOk && !/written to/.test(teeOff.text);
try { fs.rmSync(teeDir, { recursive: true, force: true }); } catch { /* ignore */ }

// 30) discover — scan a synthetic transcript for a code search that bypassed vts (Bash grep + Grep tool),
// report the count + raw tokens spent. A non-code grep (a .log target) is NOT counted.
const projRoot = path.join(os.tmpdir(), `vts-eval-${process.pid}-claudeproj`);
const projDir = path.join(projRoot, "G--some--project");
fs.mkdirSync(projDir, { recursive: true });
const learnRoot = path.join(os.tmpdir(), `vts-eval-${process.pid}-learnroot`);
const otherRoot = path.join(os.tmpdir(), `vts-eval-${process.pid}-otherroot`);
const NOW = new Date().toISOString();
const OLD = new Date(Date.now() - 30 * 86400000).toISOString(); // 30 days ago → outside since:7
const transcript = [
  { type: "assistant", cwd: learnRoot, timestamp: NOW, message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "grep -rn SpawnActor src/Foo.cpp" } }] } },
  { type: "user", cwd: learnRoot, timestamp: NOW, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "src/Foo.cpp:1:SpawnActor\n".repeat(200) }] } },
  { type: "assistant", cwd: learnRoot, timestamp: NOW, message: { role: "assistant", content: [{ type: "tool_use", id: "tu2", name: "Grep", input: { pattern: "Tick", glob: "*.cpp" } }] } },
  { type: "user", cwd: learnRoot, timestamp: NOW, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu2", content: "many matches\n".repeat(100) }] } },
  { type: "assistant", cwd: learnRoot, timestamp: NOW, message: { role: "assistant", content: [{ type: "tool_use", id: "tu3", name: "Bash", input: { command: "grep Error Saved/Logs/run.log" } }] } }, // log → NOT counted
  { type: "user", cwd: learnRoot, timestamp: NOW, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu3", content: "log lines\n".repeat(50) }] } },
  // quoted alternation — the naive splitter dissolved this into two non-matching halves and discover
  // MISSED it; the shared quote-aware splitter must count it as one bypassed grep.
  { type: "assistant", cwd: learnRoot, timestamp: NOW, message: { role: "assistant", content: [{ type: "tool_use", id: "tu4", name: "Bash", input: { command: 'grep -rn "QAlpha|QBeta" src/Quoted.cpp' } }] } },
  { type: "user", cwd: learnRoot, timestamp: NOW, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu4", content: "src/Quoted.cpp:3:QAlpha\n".repeat(40) }] } },
  // a grep our OWN hook BLOCKED — its tool_result IS the block message ("✨ vs-token-safer … 가로챘"), so it
  // was CAUGHT, not bypassed; discover must NOT count it (nor the long block copy as raw tokens).
  { type: "assistant", cwd: learnRoot, timestamp: NOW, message: { role: "assistant", content: [{ type: "tool_use", id: "tu7", name: "Bash", input: { command: "grep -rn BLOCKEDONE src/Blk.cpp" } }] } },
  { type: "user", cwd: learnRoot, timestamp: NOW, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu7", content: "✨ vs-token-safer가 코드 검색을 가로챘어요 — 의도된 동작입니다.\n".repeat(20) }] } },
  // 30-day-old entry in a still-fresh transcript: counted by --all, EXCLUDED by the since window
  // (entry-level timestamps — file mtime alone would recount this forever).
  { type: "assistant", cwd: learnRoot, timestamp: OLD, message: { role: "assistant", content: [{ type: "tool_use", id: "tu5", name: "Bash", input: { command: "grep -rn STALEONE src/Old.cpp" } }] } },
  { type: "user", cwd: learnRoot, timestamp: OLD, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu5", content: "src/Old.cpp:1:STALEONE\n".repeat(30) }] } },
  // a DIFFERENT project's bypass: excluded whenever projectPath scopes the scan.
  { type: "assistant", cwd: otherRoot, timestamp: NOW, message: { role: "assistant", content: [{ type: "tool_use", id: "tu6", name: "Bash", input: { command: "grep -rn OTHERGREP src/Other.cpp" } }] } },
  { type: "user", cwd: otherRoot, timestamp: NOW, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu6", content: "src/Other.cpp:1:OTHERGREP\n".repeat(30) }] } },
].map((e) => JSON.stringify(e)).join("\n");
fs.writeFileSync(path.join(projDir, "session.jsonl"), transcript);
process.env.VTS_CLAUDE_PROJECTS = projRoot;
const disc = await runTool("vts_discover", { all: true, learn: true, projectPath: learnRoot }); // synergy B+C, scoped
const discSince = await runTool("vts_discover", { since: 7, projectPath: learnRoot }); // entry-level window
delete process.env.VTS_CLAUDE_PROJECTS;
const qhAfter = (() => { try { return fs.readFileSync(QH, "utf8"); } catch { return ""; } })();
const discoverOk =
  !disc.isError && /4 code search\(es\) bypassed vts/.test(disc.text) && // grep + Grep + quoted + stale; NOT the log grep
  /grep×3/.test(disc.text) && /Grep×1/.test(disc.text) &&
  /SpawnActor/.test(disc.text) && /QAlpha\|QBeta/.test(disc.text) && // quote-aware: counted, not dissolved
  !/OTHERGREP/.test(disc.text) && /scoped to/.test(disc.text) &&    // projectPath scope excludes the other root
  !/BLOCKEDONE/.test(disc.text) &&                  // a hook-BLOCKED grep (block-message result) is NOT a bypass
  /catch-rate:/.test(disc.text) &&                  // synergy C: caught-vs-bypassing
  /learned \d+ file\(s\) into the warm-set/.test(disc.text) && // synergy B: learn line
  /foo\.cpp/i.test(qhAfter) && !/other\.cpp/i.test(qhAfter) && // attribution: learnRoot files only
  !discSince.isError && /3 code search\(es\) bypassed vts/.test(discSince.text) && !/STALEONE/.test(discSince.text); // stale entry out of the window
try { fs.rmSync(projRoot, { recursive: true, force: true }); } catch { /* ignore */ }

// 31) synergy A safety: search_symbol with NO backend resolved degrades to text (never a hard error), so
// the grep-rewrite hook can always route an identifier to `vts symbol`.
const nobeDir = path.join(os.tmpdir(), `vts-eval-${process.pid}-nobe`);
fs.mkdirSync(nobeDir, { recursive: true });
fs.writeFileSync(path.join(nobeDir, "notes.txt"), "nothing indexable here\n"); // no backend marker, no code
const noBe = await runTool("search_symbol", { q: "Anything", projectPath: nobeDir }); // backend unresolved
const symbolNoBackendOk = !noBe.isError && /No backend resolved/.test(noBe.text); // graceful, not an error
try { fs.rmSync(nobeDir, { recursive: true, force: true }); } catch { /* ignore */ }

// 32) self-improve round: (a) the Grep-tool nudge carries a READY-TO-USE equivalent call (identifier →
// search_symbol, regex → search_text) since the hook can't reroute a Grep call to an MCP tool; (b)
// autoLearn() — the boot-time hook — harvests bypassed-search result files into the warm-set with no
// human in the loop (same write as discover --learn).
const nudgeCtx = (r) => { try { return JSON.parse(r.out || "{}").hookSpecificOutput?.additionalContext || ""; } catch { return ""; } };
// A bare identifier is now BLOCKED (enforcement v2 A+), so its concrete nudge lands in the block stderr;
// a non-symbol-hunt alternation still WARNS (additionalContext). Read each from where it now lives.
const nIdent = runHook({ tool_name: "Grep", tool_input: { pattern: "Foo", glob: "*.ts" } }).err;
const nRegex = runHook({ tool_name: "Grep", tool_input: { pattern: "FooA|FooB", glob: "*.cpp" } }).err; // CamelCase alternation → blocked (v2.1); nudge in the block stderr
const nudgeOk =
  /find_references symbol="Foo"/.test(nIdent) && /search_symbol q="Foo"/.test(nIdent) && // identifier → usages + decl (in the block msg)
  /search_text q="FooA\|FooB"/.test(nRegex); // CamelCase alternation → block, with the search_text call embedded
const alRoot = path.join(os.tmpdir(), `vts-eval-${process.pid}-alproj`);
fs.mkdirSync(path.join(alRoot, "P--x"), { recursive: true });
fs.writeFileSync(path.join(alRoot, "P--x", "s.jsonl"), [
  { type: "assistant", cwd: "/proj/alroot", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "tool_use", id: "al1", name: "Bash", input: { command: "grep -rn Widget src/Gear.cpp" } }] } },
  { type: "user", cwd: "/proj/alroot", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "al1", content: "src/Gear.cpp:7:Widget\n" }] } },
].map((e) => JSON.stringify(e)).join("\n"));
const { autoLearn } = await import("../server/core.js");
process.env.VTS_CLAUDE_PROJECTS = alRoot;
const alCount = autoLearn("/proj/alroot", 7);
delete process.env.VTS_CLAUDE_PROJECTS;
const qhAl = (() => { try { return fs.readFileSync(QH, "utf8"); } catch { return ""; } })();
const autoLearnOk = alCount > 0 && /gear\.cpp/i.test(qhAl); // harvested file landed in query-history
try { fs.rmSync(alRoot, { recursive: true, force: true }); } catch { /* ignore */ }
const selfImproveOk = nudgeOk && autoLearnOk;

// 33) round-2 self-improve: (a) an LSP result the formatter would cap ("… N more") tees the FULL set —
// `big` (guard 3) returned 1000 symbols against maxResults 60, so its header must reference a tee file;
// (b) the savings ledger now aggregates per tool, so the report shows where the win comes from.
const lspTeeOk = /written to .*search_symbol/.test(big.text) && /… 940 more/.test(big.text); // tee + cap coexist
const svTool = await runTool("vts_savings", {});
const perToolOk = !svTool.isError && /by tool: .*search_symbol ~[\d,]+ \(\d+\)/.test(svTool.text);
const round2Ok = lspTeeOk && perToolOk;

// 34) VCS-ignore guard: a generated compile DB must never reach git/p4. git work tree → .gitignore gains
// compile_commands.json + .cache/ (and `git check-ignore` then passes); an existing .p4ignore is appended;
// both are idempotent (second run adds nothing).
const { ensureDbIgnored } = await import("../server/core.js");
const gitDir = path.join(os.tmpdir(), `vts-eval-${process.pid}-gitign`);
fs.mkdirSync(gitDir, { recursive: true });
spawnSync("git", ["-C", gitDir, "init", "-q"], { encoding: "utf8" });
const gNotes = ensureDbIgnored(gitDir);
const giTxt = (() => { try { return fs.readFileSync(path.join(gitDir, ".gitignore"), "utf8"); } catch { return ""; } })();
const gCheck = spawnSync("git", ["-C", gitDir, "check-ignore", "-q", "compile_commands.json"], { encoding: "utf8" });
const gAgain = ensureDbIgnored(gitDir); // second run → already ignored, no duplicate append
const giTxt2 = (() => { try { return fs.readFileSync(path.join(gitDir, ".gitignore"), "utf8"); } catch { return ""; } })();
const gitIgnOk =
  gNotes.some((n) => /git: added/.test(n)) &&
  giTxt.includes("compile_commands.json") && giTxt.includes(".cache/") &&
  gCheck.status === 0 &&
  gAgain.some((n) => /already ignored/.test(n)) && giTxt2 === giTxt;
// p4: the ignore file usually lives at the DEPOT root (the live UE test had it two levels above the
// game dir) — ensureDbIgnored must walk UP from the project root to find it.
const p4Dir = path.join(os.tmpdir(), `vts-eval-${process.pid}-p4ign`);
const p4Proj = path.join(p4Dir, "Game", "Sub"); // .p4ignore at p4Dir; project two levels below
fs.mkdirSync(p4Proj, { recursive: true });
fs.writeFileSync(path.join(p4Dir, ".p4ignore"), "Intermediate/\n");
const pNotes = ensureDbIgnored(p4Proj);
const p4Txt = fs.readFileSync(path.join(p4Dir, ".p4ignore"), "utf8");
const p4IgnOk = pNotes.some((n) => /p4: added/.test(n)) && p4Txt.includes("compile_commands.json") && p4Txt.includes("Intermediate/");
for (const d of [gitDir, p4Dir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
const vcsGuardOk = gitIgnOk && p4IgnOk;

// 35) gen-compile-db APPLY end-to-end (the path the live UE test caught: Node refuses to spawn a .bat
// directly — EINVAL — so Windows must go through the shell). A synthetic RunUBT writes the DB at the
// ENGINE root; apply must run it, copy the DB to the project root, REMOVE the engine-root copy, and
// run the VCS guard (the project dir is a git repo here → .gitignore note).
const ueRoot = path.join(os.tmpdir(), `vts-eval-${process.pid}-ueapply`);
const ueGame = path.join(ueRoot, "Game");
fs.mkdirSync(path.join(ueRoot, "Engine", "Build", "BatchFiles"), { recursive: true });
fs.mkdirSync(ueGame, { recursive: true });
fs.writeFileSync(path.join(ueGame, "MyGame.uproject"), "{}");
if (process.platform === "win32") {
  fs.writeFileSync(path.join(ueRoot, "Engine", "Build", "BatchFiles", "RunUBT.bat"), '@echo []>"%~dp0..\\..\\..\\compile_commands.json"\r\n');
} else {
  const sh = path.join(ueRoot, "Engine", "Build", "BatchFiles", "RunUBT.sh");
  fs.writeFileSync(sh, '#!/bin/sh\necho "[]" > "$(dirname "$0")/../../../compile_commands.json"\n');
  fs.chmodSync(sh, 0o755);
}
spawnSync("git", ["-C", ueGame, "init", "-q"], { encoding: "utf8" });
// Default apply = OUT-OF-TREE: the DB lands under VTS_DB_DIR/<slug>, the source tree stays clean (no
// project-root DB, no .gitignore churn), clangd's --compile-commands-dir points at the out-of-tree dir,
// and hasCompileDb sees it (advisory suppressed).
const DBH = path.join(os.tmpdir(), `vts-eval-${process.pid}-dbhome`);
process.env.VTS_DB_DIR = DBH;
const { dbDirFor, resolveCdbDir } = await import("../server/backends/index.js");
const applied = await runTool("vts_gen_compile_db", { projectPath: ueGame, apply: true });
const outDir = dbDirFor(ueGame);
const { hasCompileDb: hasDb2 } = await import("../server/core.js");
const applyOutOk =
  !applied.isError && /Generated compile_commands\.json/.test(applied.text) &&
  fs.existsSync(path.join(outDir, "compile_commands.json")) &&        // DB landed out of tree
  !fs.existsSync(path.join(ueGame, "compile_commands.json")) &&       // no DB in the source tree
  !fs.existsSync(path.join(ueGame, ".gitignore")) &&                  // clangd's index is out-of-tree too → nothing to ignore in-tree
  /both live OUTSIDE the source tree/.test(applied.text) &&
  !fs.existsSync(path.join(ueRoot, "compile_commands.json")) &&       // engine-root copy removed
  resolveCdbDir(ueGame) === outDir &&                                  // clangd resolves the out-of-tree home
  (() => { // the eval-global VTS_CLANGD_ARGS (mock) short-circuits args(); clear it for these checks
    const saved = process.env.VTS_CLANGD_ARGS; delete process.env.VTS_CLANGD_ARGS;
    const args = BACKENDS.clangd.args(ueGame);
    process.env.VTS_CLANGD_ARGS = saved;
    return args.some((x) => x === `--compile-commands-dir=${outDir}`) &&
      args.includes("--background-index-priority=normal") &&          // index at real priority, not idle-only
      args.some((x) => /^-j=\d+$/.test(x));                            // multiple workers
  })() &&
  hasDb2(ueGame);                                                      // advisory suppressed
// inTree=true keeps the classic layout, protected by the VCS-ignore guard.
fs.rmSync(path.join(outDir, "compile_commands.json"), { force: true }); // so resolveCdbDir prefers in-tree cleanly
fs.writeFileSync(path.join(ueRoot, "Engine", "Build", "BatchFiles", process.platform === "win32" ? "RunUBT.bat" : "RunUBT.sh"),
  process.platform === "win32" ? '@echo []>"%~dp0..\\..\\..\\compile_commands.json"\r\n' : '#!/bin/sh\necho "[]" > "$(dirname "$0")/../../../compile_commands.json"\n');
if (process.platform !== "win32") fs.chmodSync(path.join(ueRoot, "Engine", "Build", "BatchFiles", "RunUBT.sh"), 0o755);
const appliedIn = await runTool("vts_gen_compile_db", { projectPath: ueGame, apply: true, inTree: true });
const applyInOk =
  !appliedIn.isError &&
  fs.existsSync(path.join(ueGame, "compile_commands.json")) &&        // classic project-root layout
  !fs.existsSync(path.join(ueRoot, "compile_commands.json")) &&
  /Engine-root copy removed/.test(appliedIn.text) &&
  /VCS guard: git: added/.test(appliedIn.text);                        // ignore appended in the git repo
delete process.env.VTS_DB_DIR;
const applyOk = applyOutOk && applyInOk;
try { fs.rmSync(ueRoot, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(DBH, { recursive: true, force: true }); } catch { /* ignore */ }

// 36) perf: a persisted clangd index (`.cache/clangd/index/*.idx`, in-tree — clangd's fixed location) is
// detected, so afterInit can open a small nudge set instead of re-parsing 100 TUs (the cold-start cost).
const { hasPersistedIndex } = await import("../server/backends/index.js");
const piDir = path.join(os.tmpdir(), `vts-eval-${process.pid}-persist`);
fs.mkdirSync(piDir, { recursive: true });
const noIndexSeen = hasPersistedIndex(piDir);
fs.mkdirSync(path.join(piDir, ".cache", "clangd", "index"), { recursive: true });
fs.writeFileSync(path.join(piDir, ".cache", "clangd", "index", "Foo.cpp.ABC123.idx"), "x");
const indexSeen = hasPersistedIndex(piDir);
const persistedIndexOk = noIndexSeen === false && indexSeen === true;
try { fs.rmSync(piDir, { recursive: true, force: true }); } catch { /* ignore */ }

// 37) return-when-found: with a persisted index still loading, symbolReady RE-issues the query (backoff)
// and returns the INSTANT the symbol's shard loads — not at a fixed deadline. A fake client returns empty
// for the first 2 calls (still loading) then the symbol; the poll must catch it. persisted=false → one
// call (no poll). Once indexLoaded flips, an empty result stops the poll immediately (genuine miss).
const { symbolReady } = await import("../server/core.js");
const mkClient = (results) => { let i = 0; return { indexLoaded: false, async symbol() { return results[Math.min(i++, results.length - 1)]; } }; };
const found = await symbolReady(mkClient([[], [], [{ name: "Late" }]]), "Late", true, 20000); // empty,empty,hit
const noPollRes = await symbolReady(mkClient([[], [{ name: "X" }]]), "X", false, 20000);       // persisted=false → one call → []
const tGenuine = Date.now();
const genuine = await symbolReady({ indexLoaded: true, async symbol() { return []; } }, "Nope", true, 20000);
const genuineFast = Date.now() - tGenuine < 2000; // indexLoaded → returns at once, doesn't poll to the cap
const returnWhenFoundOk =
  found.length === 1 && found[0].name === "Late" &&   // polled until the symbol appeared
  noPollRes.length === 0 &&                            // non-persisted → no polling
  genuine.length === 0 && genuineFast;                 // indexLoaded → empty is genuine, returns immediately

// 38) output compaction — pure string→string compaction of git/p4/grep output: grouping by type/dir,
// identical-line dedup (×N), per-file diffstat, and capping. Deterministic (no toolchain), so asserted
// directly on canned input. The token win comes from collapsing the repetitive boilerplate a raw dump has.
const { compactGit, compactP4 } = await import("../server/compact.js");
const gitStatusRaw = [" M server/core.js", " M server/cli.js", "?? server/compact.js", "?? eval/new.mjs", "A  server/index.js"].join("\n");
const gitStatusOut = compactGit("status", gitStatusRaw, 60);
const gitLogRaw = Array.from({ length: 50 }, (_, i) => `abc${i} commit subject ${i}`).join("\n");
const gitLogOut = compactGit("log", gitLogRaw, 10);
const gitDiffRaw = "diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1 +1,2 @@\n-old\n+new\n+added\ndiff --git a/y.js b/y.js\n--- a/y.js\n+++ b/y.js\n@@ -1 +1 @@\n-a\n+b\n";
const gitDiffOut = compactGit("diff", gitDiffRaw, 60);
const gitDiffStatOut = compactGit("diff", " x.js | 3 +++\n y.js | 2 +-\n 2 files changed, 4 insertions(+), 1 deletion(-)\n", 60); // --stat: no unified headers → passthrough, not mangled
const p4OpenedRaw = Array.from({ length: 30 }, (_, i) => `//depot/Game/Src/F${i}.cpp#${i} - edit default change (text)`).join("\n");
const p4Out = compactP4("opened", p4OpenedRaw, 60);
const compactPureOk =
  /modified: 2/.test(gitStatusOut) && /untracked: 2/.test(gitStatusOut) && /added: 1/.test(gitStatusOut) &&
  /… \+40 more commit/.test(gitLogOut) &&                                  // 50 commits → 10 shown + 40 more
  /x\.js \| \+2 -1/.test(gitDiffOut) && /y\.js \| \+1 -1/.test(gitDiffOut) && // per-file diffstat, bodies dropped
  /2 files changed/.test(gitDiffStatOut) && /x\.js \| 3/.test(gitDiffStatOut) && // --stat passthrough, not "(no file changes)"
  /edit: 30/.test(p4Out) && /depot\/Game\/Src/.test(p4Out);                 // p4 opened grouped by action + dir

// 39) vts_git live — run the wrapper against a REAL temp git repo (git is in CI; guard 34 already spawns it)
// and confirm it returns compacted status. Also search_text docs=true sweeps README/docs text (off by default).
const gwDir = path.join(os.tmpdir(), `vts-eval-${process.pid}-gitwrap`);
fs.mkdirSync(gwDir, { recursive: true });
spawnSync("git", ["-C", gwDir, "init", "-q"], { encoding: "utf8" });
spawnSync("git", ["-C", gwDir, "config", "user.email", "e@x.t"], { encoding: "utf8" });
spawnSync("git", ["-C", gwDir, "config", "user.name", "t"], { encoding: "utf8" });
fs.writeFileSync(path.join(gwDir, "a.cpp"), "int a;\n");
fs.writeFileSync(path.join(gwDir, "b.cpp"), "int b;\n");
const gw = await runTool("vts_git", { argv: ["status", "-s"], projectPath: gwDir });
const gwPlain = await runTool("vts_git", { argv: ["status"], projectPath: gwDir }); // long-format → --porcelain forced
const gitWrapOk = !gw.isError && /git status -s \(compacted\)/.test(gw.text) && /untracked: 2/.test(gw.text) &&
  !gwPlain.isError && /--porcelain/.test(gwPlain.text) && /untracked: 2/.test(gwPlain.text); // plain status still grouped
const gwBad = await runTool("vts_git", { argv: [], projectPath: gwDir });
const gitWrapGuardOk = gwBad.isError && /subcommand/.test(gwBad.text);
const docDir = path.join(os.tmpdir(), `vts-eval-${process.pid}-docs`);
fs.mkdirSync(docDir, { recursive: true });
fs.writeFileSync(path.join(docDir, "README.md"), "# Title\nDOC_NEEDLE here\n");
const stCode = await runTool("search_text", { q: "DOC_NEEDLE", projectPath: docDir });            // code-only → miss
const stDocs = await runTool("search_text", { q: "DOC_NEEDLE", projectPath: docDir, docs: true }); // docs → hit
const stPath = await runTool("search_text", { q: "DOC_NEEDLE", projectPath: docDir, path: "README.md" }); // path → auto .md
const stGlob = await runTool("search_text", { q: "DOC_NEEDLE", projectPath: docDir, glob: "*.md" });      // glob → auto .md
const docsTextOk =
  !stCode.isError && /No text matches/.test(stCode.text) &&
  !stDocs.isError && /README\.md:2/.test(stDocs.text) && /text\+docs/.test(stDocs.text) &&
  !stPath.isError && /README\.md:2/.test(stPath.text) && /in README\.md/.test(stPath.text) &&  // path target, ext auto
  !stGlob.isError && /README\.md:2/.test(stGlob.text) && /glob \*\.md/.test(stGlob.text);       // glob target, ext auto
for (const d of [gwDir, docDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
const vcsToolsOk = compactPureOk && gitWrapOk && gitWrapGuardOk && docsTextOk;

// 40) hook VCS rerouting — `git status` / `p4 opened` reroute to the vts wrapper (updatedInput), `git grep`
// stays a CODE search (NOT captured by VCS compaction), and VTS_COMPACT_VCS=0 disables the reroute.
const hGitStatus = parseRw(runHook({ tool_name: "Bash", tool_input: { command: "git status -s" } }));
const hGitLog = parseRw(runHook({ tool_name: "Bash", tool_input: { command: "git log --oneline" } }));
const hP4 = parseRw(runHook({ tool_name: "Bash", tool_input: { command: "p4 opened" } }));
const hGitGrep2 = parseRw(runHook({ tool_name: "Bash", tool_input: { command: "git grep SpawnActor" } })); // code search, not VCS
const hVcsOff = runHook({ tool_name: "Bash", tool_input: { command: "git status -s" } }, { VTS_COMPACT_VCS: "0" });
const hDocsGrep = parseRw(runHook({ tool_name: "Bash", tool_input: { command: "grep DOC_NEEDLE README.md" } })); // docs grep + file → vts text --path
const vcsHookOk =
  /cli\.js" git "status" "-s"/.test(hGitStatus.updatedInput?.command || "") &&
  /cli\.js" git "log" "--oneline"/.test(hGitLog.updatedInput?.command || "") &&
  /cli\.js" p4 "opened"/.test(hP4.updatedInput?.command || "") &&
  /cli\.js" symbol --q "SpawnActor"/.test(hGitGrep2.updatedInput?.command || "") &&   // git grep → code symbol, not vts_git
  /cli\.js" text --q "DOC_NEEDLE" --path "README\.md"/.test(hDocsGrep.updatedInput?.command || "") && // docs grep → targeted text
  hVcsOff.status === 0 && !/vts_git/.test(JSON.parse(hVcsOff.out || "{}").hookSpecificOutput?.updatedInput?.command || ""); // disabled → no VCS reroute

// 41) savings-ledger accuracy (dogfood-found): (a) rawTokensOf measures a STRING raw verbatim (vts_git/
// vts_p4 stdout — NOT via JSON.stringify, which escapes \n→\\n and over-reports savings) while an array/
// object stays JSON (the forwarded-index baseline); (b) recordSavings floors to break-even so no tool ever
// records NEGATIVE savings on a tiny result. The isolated ledger (SV) has accumulated every run above.
const { rawTokensOf } = await import("../server/core.js");
const strRaw = "line1\nline2\nline3\nline4\nline5";
const savingsAccurateOk =
  rawTokensOf(strRaw) === tok(strRaw) &&                       // string measured as-is
  rawTokensOf(strRaw) < tok(JSON.stringify(strRaw)) &&         // JSON.stringify would have inflated it
  rawTokensOf([{ name: "X", l: 1 }]) === tok(JSON.stringify([{ name: "X", l: 1 }])); // array → JSON baseline
const svLedger = (() => { try { return JSON.parse(fs.readFileSync(SV, "utf8")); } catch { return {}; } })();
const noNegativeTool = Object.values(svLedger.tools || {}).every((t) => t.rawTok >= t.outTok);
const savingsLedgerOk = savingsAccurateOk && noNegativeTool && (svLedger.rawTok || 0) >= (svLedger.outTok || 0);

// 42) hardening (critic + live-QA driven): vts_git/vts_p4 read-only allowlist (a mutating subcommand is
// refused BEFORE it runs), search_text path= confinement (no arbitrary-file read outside the root), and
// compactor correctness — rename → destination only, shared status listing budget, binary-diff marker,
// and the 200-char line-truncation marker.
const gReset = await runTool("vts_git", { argv: ["reset", "--hard"], projectPath: os.tmpdir() }); // never runs git
const allowlistOk = gReset.isError && /READ-ONLY/.test(gReset.text) && /refused/i.test(gReset.text);
const gShow = await runTool("vts_git", { argv: ["status"], projectPath: process.cwd() }); // read-only → allowed (runs)
const allowlistAllowsRO = !gShow.isError && /git status/.test(gShow.text);
const outsideFile = path.join(os.tmpdir(), `vts-eval-${process.pid}-outside.txt`);
fs.writeFileSync(outsideFile, "TRAVERSAL_SECRET\n");
const ptRoot = path.join(os.tmpdir(), `vts-eval-${process.pid}-ptroot`); fs.mkdirSync(ptRoot, { recursive: true });
const trav = await runTool("search_text", { q: "TRAVERSAL_SECRET", path: outsideFile, projectPath: ptRoot });
const traversalOk = trav.isError && /inside the project root/.test(trav.text); // refused, file NOT read
try { fs.rmSync(outsideFile, { force: true }); fs.rmSync(ptRoot, { recursive: true, force: true }); } catch { /* ignore */ }
const renameOut = compactGit("status", "R  old/a.cpp -> new/b.cpp\n M src/x.cpp\n", 60);
const renameParseOk = /renamed: 1/.test(renameOut) && /new\/b\.cpp/.test(renameOut) && !/old\/a\.cpp ->/.test(renameOut);
const manyStatus = Array.from({ length: 10 }, (_, i) => ` M m/f${i}.cpp`).concat(Array.from({ length: 10 }, (_, i) => `?? u/g${i}.cpp`)).join("\n");
const budgetOut = compactGit("status", manyStatus, 3);
const budgetOk = (budgetOut.match(/^ {4}[^…\s]/gm) || []).length <= 3; // shared budget: ≤max path lines TOTAL
const binOut = compactGit("diff", "diff --git a/img.png b/img.png\nindex 1..2 100644\nBinary files a/img.png and b/img.png differ\n", 60);
const binaryOk = /img\.png \| \(binary\)/.test(binOut);
const longDir = path.join(os.tmpdir(), `vts-eval-${process.pid}-longline`); fs.mkdirSync(longDir, { recursive: true });
fs.writeFileSync(path.join(longDir, "m.js"), "x".repeat(400) + "NEEDLE\n");
const longRes = await runTool("search_text", { q: "NEEDLE", projectPath: longDir });
const truncMarkOk = !longRes.isError && /…/.test(longRes.text);
try { fs.rmSync(longDir, { recursive: true, force: true }); } catch { /* ignore */ }
const hardeningOk = allowlistOk && allowlistAllowsRO && traversalOk && renameParseOk && budgetOk && binaryOk && truncMarkOk;

// 43) polish: (a) vts_git/vts_p4 run in CWD, not the configured PROJECT_PATH — `vts git status` in repo B
// shows repo B even when VTS_PROJECT_PATH points at repo A (was the live-QA surprise); (b) p4 changes parses
// the quoted desc + optional *pending*; (c) the generic dedup summary says "unique line(s)".
const mkGitRepo = (sub, files) => {
  const d = path.join(os.tmpdir(), `vts-eval-${process.pid}-${sub}`);
  fs.mkdirSync(d, { recursive: true });
  spawnSync("git", ["-C", d, "init", "-q"]); spawnSync("git", ["-C", d, "config", "user.email", "e@x.t"]);
  spawnSync("git", ["-C", d, "config", "user.name", "t"]); spawnSync("git", ["-C", d, "config", "core.autocrlf", "false"]);
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(d, n), b);
  return d;
};
const repoA = mkGitRepo("repoA", { "aaa.cpp": "int a;\n" });
spawnSync("git", ["-C", repoA, "add", "-A"]); spawnSync("git", ["-C", repoA, "commit", "-qm", "init"]); // clean
const repoB = mkGitRepo("repoB", { "bbb_untracked.cpp": "int b;\n" }); // dirty (untracked)
const cpCwd = spawnSync(process.execPath, [cliPath, "git", "status"], { cwd: repoB, encoding: "utf8", env: { ...process.env, VTS_PROJECT_PATH: repoA, VTS_ENFORCE: "0", VTS_CONFIG_FILE: CF } });
const gitCwdOk = /bbb_untracked/.test(cpCwd.stdout || "") && !/aaa\.cpp/.test(cpCwd.stdout || ""); // CWD repoB won, not repoA
for (const d of [repoA, repoB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
const p4ch = compactP4("changes", "Change 42 on 2026/01/02 by alice@ws *pending* 'rework combat'\nChange 41 on 2026/01/01 by bob@ws 'tidy'\n", 60);
const p4ChangesOk = /42 2026\/01\/02 alice@ws \*pending\* rework combat/.test(p4ch) && /41 .*bob@ws tidy/.test(p4ch);
const dedupOut = compactGit("unknownsub", Array.from({ length: 10 }, (_, i) => `uline${i}`).join("\n"), 3);
const dedupWordOk = /more unique line\(s\)/.test(dedupOut);
// benign empty-state stderr (p4 "File(s) not opened" + nonzero) is an empty result, not a failure.
const { isBenignEmpty } = await import("../server/core.js");
const benignOk = isBenignEmpty("File(s) not opened on this client.") && isBenignEmpty("No files to reconcile.") &&
  !isBenignEmpty("fatal: not a git repository") && !isBenignEmpty("");
const polishOk = gitCwdOk && p4ChangesOk && dedupWordOk && benignOk;

// 44) i18n: VTS_LANG=ko renders the block + Grep nudge in Korean; en stays English (forced en above keeps
// every other assertion deterministic). A Korean user (ko-KR locale) auto-gets Korean.
const hKoBlock = runHook({ tool_name: "Bash", tool_input: { command: "grep -rn Foo src/Thing.cpp" } }, { VTS_REWRITE: "0", VTS_LANG: "ko" });
const hKoNudge = runHook({ tool_name: "Grep", tool_input: { pattern: "Foo", glob: "*.ts" } }, { VTS_LANG: "ko" }).err; // identifier → blocked; KO nudge is in the block stderr
const hEnBlock = runHook({ tool_name: "Bash", tool_input: { command: "grep -rn Foo src/Thing.cpp" } }, { VTS_REWRITE: "0", VTS_LANG: "en" });
const i18nOk =
  hKoBlock.status === 2 && /코드 검색을 가로챘어요/.test(hKoBlock.err) && /find_references symbol="Foo"/.test(hKoNudge) &&
  /Grep 툴로 코드 검색/.test(hKoNudge) &&
  hEnBlock.status === 2 && /caught a code search/.test(hEnBlock.err); // en explicit still English

// 45) backend pool lifecycle (memory guard): the live language-server pool is BOUNDED so a session that
// touches many repos can't spawn an unbounded number of persistent clangd/Roslyn processes. evictLRU shuts
// down the least-recently-used SETTLED+idle client at the cap; an in-flight request (pending.size>0)
// protects its client from both eviction and the idle sweep; sweepIdle reaps clients idle past the TTL;
// idleMs=0 disables reaping. Seeded with FAKE clients (no real LSP spawn) so the checks are deterministic.
const { __pool } = await import("../server/core.js");
const shut = [];
const mk = (k, pending = 0) => ({ _k: k, pending: new Map(Array.from({ length: pending }, (_, i) => [i, 1])), async shutdown() { shut.push(this._k); } });
process.env.VTS_MAX_BACKENDS = "2"; // cap = 2
__pool.clear();
__pool.seed("clangd|A", mk("A"), 100); __pool.seed("clangd|B", mk("B"), 200); __pool.seed("clangd|C", mk("C"), 300);
const evicted = __pool.evictLRU(); // over cap → drop the oldest (smallest lastUsed)
await new Promise((r) => setTimeout(r, 0)); // flush the async shutdown microtask
const lruEvictOk = evicted === "clangd|A" && shut.includes("A") && !__pool.clients.has("clangd|A") && __pool.clients.size === 2;
shut.length = 0; __pool.clear();
__pool.seed("clangd|busy", mk("busy", 1), 50); __pool.seed("clangd|idle", mk("idle"), 150); __pool.seed("clangd|warm", mk("warm"), 250);
const evicted2 = __pool.evictLRU(); // oldest is BUSY → skipped, next-oldest idle dropped
const busyProtectedOk = evicted2 === "clangd|idle" && __pool.clients.has("clangd|busy");
__pool.clear(); __pool.seed("clangd|solo", mk("solo"), 100);
const noEvictOk = __pool.evictLRU() === null && __pool.clients.size === 1; // under cap → no eviction
shut.length = 0; process.env.VTS_BACKEND_IDLE_MS = "1000"; __pool.clear();
const T = 1_000_000;
__pool.seed("clangd|old", mk("old"), T - 5000);        // idle 5s > 1s TTL → reaped
__pool.seed("clangd|fresh", mk("fresh"), T - 100);     // idle 0.1s < TTL → kept
__pool.seed("clangd|oldbusy", mk("oldbusy", 1), T - 9000); // old but busy → kept
const reaped = __pool.sweepIdle(T);
await new Promise((r) => setTimeout(r, 0));
const idleSweepOk = reaped.length === 1 && reaped[0] === "clangd|old" && shut.includes("old") &&
  __pool.clients.has("clangd|fresh") && __pool.clients.has("clangd|oldbusy");
process.env.VTS_BACKEND_IDLE_MS = "0";
const sweepDisabledOk = __pool.sweepIdle(T).length === 0; // TTL 0 → reaping disabled
delete process.env.VTS_MAX_BACKENDS; delete process.env.VTS_BACKEND_IDLE_MS; __pool.clear();
const poolLifecycleOk = lruEvictOk && busyProtectedOk && noEvictOk && idleSweepOk && sweepDisabledOk;

// 46) per-call root resolution (A1/A2): findProjectRoot walks UP to the nearest project marker so a `path`
// argument pins the correct repo; resolveRoot precedence = explicit projectPath > a path's enclosing
// project (only when OUTSIDE every known root, so an inside-path keeps its root and clangd rooting is
// preserved) > an MCP workspace root (over the stale config pin) > PROJECT_PATH > cwd. setMcpRoots holds
// the client-advertised workspace folders. (Config is empty in the eval, so PROJECT_PATH === "".)
const { resolveRoot, setMcpRoots, getMcpRoots } = await import("../server/core.js");
const { findProjectRoot } = await import("../server/backends/index.js");
const rootBase = path.join(os.tmpdir(), `vts-eval-${process.pid}-roots`);
const repoCC = path.join(rootBase, "withcc"); const deepCC = path.join(repoCC, "a", "b");
fs.mkdirSync(deepCC, { recursive: true });
fs.writeFileSync(path.join(repoCC, "compile_commands.json"), "[]"); fs.writeFileSync(path.join(deepCC, "x.cpp"), "int x;\n");
const repoGit = path.join(rootBase, "withgit"); const deepGit = path.join(repoGit, "src");
fs.mkdirSync(path.join(repoGit, ".git"), { recursive: true }); fs.mkdirSync(deepGit, { recursive: true });
fs.writeFileSync(path.join(deepGit, "y.cpp"), "int y;\n");
const rl = (p) => path.resolve(p);
const findRootOk =
  rl(findProjectRoot(path.join(deepCC, "x.cpp"))) === rl(repoCC) &&    // climbs to the compile_commands dir
  rl(findProjectRoot(path.join(deepGit, "y.cpp"))) === rl(repoGit) &&  // stops at the .git repo boundary
  rl(findProjectRoot(repoCC)) === rl(repoCC);                          // a directory arg resolves to itself
setMcpRoots([]);
const rrExplicit = rl(resolveRoot({ projectPath: repoGit, path: path.join(deepCC, "x.cpp") })) === rl(repoGit); // explicit wins over path
setMcpRoots([repoCC]);                                                 // repoCC is now a "known" workspace root
const rrInsideKept = rl(resolveRoot({ path: path.join(deepCC, "x.cpp") })) === rl(repoCC); // inside known → keep root
const rrOutside = rl(resolveRoot({ path: path.join(deepGit, "y.cpp") })) === rl(repoGit);  // outside known → its real project
const rrNoPathRoot = rl(resolveRoot({})) === rl(repoCC);              // no path → the MCP workspace root
setMcpRoots([]);
const rrFallback = rl(resolveRoot({})) === rl(process.cwd());         // no roots + empty PROJECT_PATH → cwd
const rootsRoundtripOk = (() => { setMcpRoots([repoCC, repoGit]); const g = getMcpRoots(); setMcpRoots([]); return g.length === 2 && rl(g[0]) === rl(repoCC); })();
try { fs.rmSync(rootBase, { recursive: true, force: true }); } catch { /* ignore */ }
const rootResolveOk = findRootOk && rrExplicit && rrInsideKept && rrOutside && rrNoPathRoot && rrFallback && rootsRoundtripOk;

// 47) output cap v2 (caveman "collapse repetition"): a refs-heavy result collapses to one line per FILE
// (all line numbers joined, deduped, sorted) with a common DIRECTORY prefix factored out once — every
// location preserved + recoverable. VTS_COMPACT_RESULTS=0 restores the classic "  @ path:line" shape.
const { compactLocationLines, commonDirPrefix } = await import("../server/core.js");
const cl = compactLocationLines([
  "G:/proj/Source/Game/Private/Combat/Damage.cpp:120",
  "G:/proj/Source/Game/Private/Combat/Damage.cpp:42",
  "G:/proj/Source/Game/Private/Combat/Damage.cpp:42",   // dup → deduped
  "G:/proj/Source/Game/Private/AI/Enemy.cpp:55",
]);
const capV2Ok =
  commonDirPrefix(["a/b/c/x.cpp", "a/b/d/y.cpp"]) === "a/b" &&      // dir prefix, filename segment excluded
  commonDirPrefix(["a/x.cpp"]) === "" &&                            // single path → no prefix
  /under G:\/proj\/Source\/Game\/Private\//.test(cl) &&             // common prefix factored once
  /Combat\/Damage\.cpp:42,120/.test(cl) &&                          // same-file lines coalesced, deduped, sorted
  /AI\/Enemy\.cpp:55/.test(cl) &&
  (cl.match(/Damage\.cpp/g) || []).length === 1;                    // path printed once, not per location
const clSingle = compactLocationLines(["G:/proj/only/A.cpp:9", "G:/proj/only/A.cpp:3"]); // one file → no prefix header
const capSingleOk = !/under /.test(clSingle) && /A\.cpp:3,9/.test(clSingle);
process.env.VTS_COMPACT_RESULTS = "0";
const rOff = await runTool("find_references", { symbol: "Spawn", projectPath: process.cwd(), backend: "clangd" });
delete process.env.VTS_COMPACT_RESULTS;
const capToggleOk = !rOff.isError && /@ .*Foo\.cpp:42/.test(rOff.text); // classic "  @ path:line" restored
const capResultsOk = capV2Ok && capSingleOk && capToggleOk;

// 49) Glob-tool steering + find_files walk bound: a CONCRETE code-file Glob (v2.2) is BLOCKED → find_files
// (token-capped + walk-bounded); a code-DIR glob with no extension stays a warn nudge; a doc/asset glob is
// left alone. And find_files SKIPS heavy build/dep dirs (node_modules/Intermediate/Binaries/…) so a giant UE
// tree can't time it out like the built-in Glob did.
const hGlobCode = runHook({ tool_name: "Glob", tool_input: { pattern: "**/*.cpp" } });        // concrete extension → block
const hGlobFile = runHook({ tool_name: "Glob", tool_input: { pattern: "**/FooManager.*" } }); // specific source file → block
const hGlobWarn = nudgeCtx(runHook({ tool_name: "Glob", tool_input: { pattern: "*", path: "src/lib" } })); // code dir, no ext → warn
const hGlobDoc = runHook({ tool_name: "Glob", tool_input: { pattern: "**/*.md" } });          // doc → neither
const globNudgeOk =
  hGlobCode.status === 2 && /find_files q="\*\.cpp"/.test(hGlobCode.err) &&        // concrete code glob → block → find_files
  hGlobFile.status === 2 && /find_files q="FooManager\.\*"/.test(hGlobFile.err) && // specific source file → block
  /find_files q=/.test(hGlobWarn) &&                                               // code-dir glob (no ext) → warn nudge
  hGlobDoc.status === 0 && !/find_files/.test(nudgeCtx(hGlobDoc));                 // doc glob → no block, no nudge
const skipRoot = path.join(os.tmpdir(), `vts-eval-${process.pid}-skip`);
fs.mkdirSync(path.join(skipRoot, "src"), { recursive: true });
fs.mkdirSync(path.join(skipRoot, "Intermediate"), { recursive: true });
fs.mkdirSync(path.join(skipRoot, "node_modules"), { recursive: true });
fs.writeFileSync(path.join(skipRoot, "src", "Real.cpp"), "");
fs.writeFileSync(path.join(skipRoot, "Intermediate", "Gen.cpp"), "");  // generated → in a skipped dir
fs.writeFileSync(path.join(skipRoot, "node_modules", "Dep.cpp"), "");  // dependency → in a skipped dir
const ffSkip = await runTool("find_files", { q: "*.cpp", projectPath: skipRoot });
const skipOk = !ffSkip.isError && /Real\.cpp/.test(ffSkip.text) && !/Gen\.cpp/.test(ffSkip.text) && !/Dep\.cpp/.test(ffSkip.text);
try { fs.rmSync(skipRoot, { recursive: true, force: true }); } catch { /* ignore */ }
const globAndWalkOk = globNudgeOk && skipOk;

// 50) enforcement v2 (A+ / v2.1): a SYMBOL-HUNT Grep is BLOCKED (exit 2 → search_symbol/search_text) — a
// bare identifier, a structural-cue regex, OR a CamelCase/snake ALTERNATION (FooBar|BazQux, the top measured
// bypass shape — UE type enumeration). Keyword alternations (TODO|FIXME, GET|POST — ALL-CAPS, no lower→upper
// transition) and freeform single tokens stay WARN (no false-positive block). VTS_GREP_BLOCK=0 reverts; a
// doc-target (*.md) isn't blocked. Plus discover counts the built-in Glob/Search tool as a find_files bypass.
const hSymHunt = runHook({ tool_name: "Grep", tool_input: { pattern: "::FooWidget\\b|void.*FooWidget\\(", path: "src/lib" } });
const hIdentBlk = runHook({ tool_name: "Grep", tool_input: { pattern: "FooWidget", path: "src/lib" } });
const hCamelAlt = runHook({ tool_name: "Grep", tool_input: { pattern: "FooBar|BazQux", path: "src/lib" } }); // CamelCase symbol enumeration → block (v2.1)
const hFreeform = runHook({ tool_name: "Grep", tool_input: { pattern: "TODO|FIXME", path: "src/lib" } });    // ALL-CAPS keyword alternation → warn
const hKwAlt = runHook({ tool_name: "Grep", tool_input: { pattern: "GET|POST|HEAD", path: "src/lib" } });    // ALL-CAPS keyword alternation → warn
const hSymOff = runHook({ tool_name: "Grep", tool_input: { pattern: "void.*FooWidget\\(", path: "src/lib" } }, { VTS_GREP_BLOCK: "0" });
const hSymDoc = runHook({ tool_name: "Grep", tool_input: { pattern: "FooWidget", glob: "*.md" } });
const enforceV2Ok =
  hSymHunt.status === 2 && /search_text q="/.test(hSymHunt.err) && /caught a SYMBOL/.test(hSymHunt.err) && // structural-cue regex → block
  hIdentBlk.status === 2 && /find_references symbol="FooWidget"/.test(hIdentBlk.err) &&                    // bare identifier → block
  hCamelAlt.status === 2 && /search_text q="/.test(hCamelAlt.err) &&                                       // CamelCase alternation → block (v2.1)
  hFreeform.status === 0 && hKwAlt.status === 0 &&     // keyword alternations (no CamelCase) → NOT blocked (warn)
  hSymOff.status === 0 &&                              // VTS_GREP_BLOCK=0 → reverts to warn
  hSymDoc.status === 0;                                // doc target (*.md) → not blocked
const glProj = path.join(os.tmpdir(), `vts-eval-${process.pid}-globdisc`);
fs.mkdirSync(path.join(glProj, "G--proj"), { recursive: true });
const GNOW = new Date().toISOString();
fs.writeFileSync(path.join(glProj, "G--proj", "t.jsonl"),
  JSON.stringify({ type: "assistant", cwd: glProj, timestamp: GNOW, message: { role: "assistant", content: [{ type: "tool_use", id: "g1", name: "Glob", input: { pattern: "**/*Manager.cpp" } }] } }) + "\n" +
  JSON.stringify({ type: "user", cwd: glProj, timestamp: GNOW, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "g1", content: "a.cpp\nb.cpp\n".repeat(40) }] } }) + "\n");
process.env.VTS_CLAUDE_PROJECTS = glProj;
const discGlob = await runTool("vts_discover", { since: 7 });
delete process.env.VTS_CLAUDE_PROJECTS;
const globDiscOk = !discGlob.isError && /Glob×\d/.test(discGlob.text); // discover groups bypasses by tool → "Glob×1"
try { fs.rmSync(glProj, { recursive: true, force: true }); } catch { /* ignore */ }
const enforceAndDiscoverOk = enforceV2Ok && globDiscOk;

// 51) v2.2: (A) a Bash `find <dir> -name X` rewrite HONORS <dir> as the search root — dropping it made
// find_files search the configured root and falsely report "No files" (live dogfood bug on a UE worktree).
// (B) a CONCRETE code-file Glob (`*.cpp` / `Name.h`) is BLOCKED → find_files with a projectPath hint; a
// bare `**/*` stays allowed.
const hFindDir = parseRw(runHook({ tool_name: "Bash", tool_input: { command: 'find "/abs/widget/src/lib" -name "FooThing.h" 2>/dev/null' } }));
const findDirOk = /files --q "FooThing\.h" --projectPath "\/abs\/widget\/src\/lib"/.test(hFindDir.updatedInput?.command || ""); // dir honored, not the configured root
const hGlobBlk = runHook({ tool_name: "Glob", tool_input: { pattern: "src/lib/**/FooThing.cpp", path: "/abs/widget" } });
const globBlkOk = hGlobBlk.status === 2 && /find_files q="FooThing\.cpp" projectPath="\/abs\/widget"/.test(hGlobBlk.err); // block + path hint
const hGlobConcrete = runHook({ tool_name: "Glob", tool_input: { pattern: "**/*.cpp" } });   // concrete code extension → block
const hGlobWild = runHook({ tool_name: "Glob", tool_input: { pattern: "**/FooThing.*" } });  // specific source, wildcard ext → block
const hGlobBare = runHook({ tool_name: "Glob", tool_input: { pattern: "**/*" } });            // no extension → allowed
// asset/binary filename searches are NOT code search → never blocked, even as a SPECIFIC file (only CODE_EXT_RE
// decides concrete extensions; the earlier `Name.<any-ext>` clause wrongly blocked Foo.png / Bar.uasset).
const hGlobAsset = runHook({ tool_name: "Glob", tool_input: { pattern: "Texture.png" } });
const hGlobUasset = runHook({ tool_name: "Glob", tool_input: { pattern: "Mesh.uasset" } });
// find edge cases: multiple `-name` / an `-o` OR can't be one find_files call → BLOCK (never an incomplete
// rewrite that silently drops the second extension); a single `-iname` (case-insensitive) IS enforced now.
const hFindMulti = runHook({ tool_name: "Bash", tool_input: { command: 'find /d -name "*.h" -o -name "*.cpp"' } });
const hFindIname = parseRw(runHook({ tool_name: "Bash", tool_input: { command: 'find "/d/src" -iname "FooThing.cpp"' } }));
const findEdgeOk = hFindMulti.status === 2 &&                                                  // multi-name → block, not partial rewrite
  /files --q "FooThing\.cpp" --projectPath "\/d\/src"/.test(hFindIname.updatedInput?.command || ""); // -iname enforced + dir honored
const v22Ok = findDirOk && globBlkOk && hGlobConcrete.status === 2 && hGlobWild.status === 2 &&
  hGlobBare.status === 0 && hGlobAsset.status === 0 && hGlobUasset.status === 0 && findEdgeOk;

// 52) symbolic editing (Serena-style): edit a declaration by NAMING it — the LSP outline (documentSymbol)
// supplies the body span, so no whole-file Read + line-counting for an exact-match Edit. replace_symbol_body
// replaces the span; insert_before/after splice at its edges; safe_delete refuses while referenced (the mock
// returns a referrer at the symbol's name line) unless force=true. Preview by default; apply=true writes.
const seDir = path.join(os.tmpdir(), `vts-eval-${process.pid}-symedit`);
fs.mkdirSync(seDir, { recursive: true });
const seFile = path.join(seDir, "Ed.cpp");
const SEBODY = "L0\nL1\nL2\nL3\n0123456789 rest\n"; // mock documentSymbol puts "Foo" at line 4, chars 0-10
const seW = () => fs.writeFileSync(seFile, SEBODY);
const seR = () => fs.readFileSync(seFile, "utf8");
seW();
const sePrev = await runTool("replace_symbol_body", { symbol: "Foo", path: seFile, body: "X", backend: "clangd" });
const sePrevOk = !sePrev.isError && /PREVIEW/.test(sePrev.text) && /Ed\.cpp:5/.test(sePrev.text) && seR() === SEBODY; // preview → not written
const seRepl = await runTool("replace_symbol_body", { symbol: "Foo", path: seFile, body: "ZZZ", backend: "clangd", apply: true });
const seReplOk = !seRepl.isError && /APPLIED/.test(seRepl.text) && seR() === "L0\nL1\nL2\nL3\nZZZ rest\n";
seW();
const seBefore = await runTool("insert_symbol", { symbol: "Foo", position: "before", path: seFile, text: "PRE", backend: "clangd", apply: true });
const seBeforeOk = !seBefore.isError && seR() === "L0\nL1\nL2\nL3\nPRE\n0123456789 rest\n";
seW();
const seAfter = await runTool("insert_symbol", { symbol: "Foo", position: "after", path: seFile, text: "POST", backend: "clangd", apply: true });
const seAfterOk = !seAfter.isError && seR() === "L0\nL1\nL2\nL3\n0123456789\nPOST rest\n";
seW();
const seMiss = await runTool("replace_symbol_body", { symbol: "Nope", path: seFile, body: "x", backend: "clangd" });
const seMissOk = seMiss.isError && /no symbol named "Nope"/.test(seMiss.text);
const seRefuse = await runTool("safe_delete", { symbol: "Foo", path: seFile, backend: "clangd", apply: true });
const seRefuseOk = !seRefuse.isError && /REFUSED/.test(seRefuse.text) && /reference/.test(seRefuse.text) && seR() === SEBODY; // referenced → not deleted
const seForce = await runTool("safe_delete", { symbol: "Foo", path: seFile, force: true, backend: "clangd", apply: true });
const seForceOk = !seForce.isError && /force/.test(seForce.text) && seR() === "L0\nL1\nL2\nL3\n rest\n";
try { fs.rmSync(seDir, { recursive: true, force: true }); } catch { /* ignore */ }
const symEditOk = sePrevOk && seReplOk && seBeforeOk && seAfterOk && seMissOk && seRefuseOk && seForceOk;

// 53) edit-steer (B+A): a FOCUSED search_symbol result appends an EDIT_STEER pointing at the symbol-edit
// tools (the moment before the model would Read-the-file-to-Edit) — gated to small result sets,
// VTS_EDIT_STEER=0 hides it. And discover MEASURES the edit habit (A): a whole-declaration Edit on a code
// file, with the tokens of that file's prior Read attributed (what a symbol-edit would have skipped).
const ssSteer = await runTool("search_symbol", { q: "Spawn", projectPath: process.cwd(), backend: "clangd" });
const ssSteerOk = !ssSteer.isError && /replace_symbol_body/.test(ssSteer.text) && /VTS_EDIT_STEER=0/.test(ssSteer.text);
process.env.VTS_EDIT_STEER = "0";
const ssOff = await runTool("search_symbol", { q: "Spawn", projectPath: process.cwd(), backend: "clangd" });
delete process.env.VTS_EDIT_STEER;
const ssOffOk = !ssOff.isError && !/replace_symbol_body/.test(ssOff.text);
const eProj = path.join(os.tmpdir(), `vts-eval-${process.pid}-editdisc`);
fs.mkdirSync(path.join(eProj, "P--proj"), { recursive: true });
const ENOW = new Date().toISOString();
const bigRead = "x ".repeat(2000); // a sizable file read → measurable tokens to attribute
const declOld = "void Foo::Bar()\n{\n  a();\n  b();\n  c();\n  d();\n  e();\n  f();\n  g();\n}"; // 9 newlines + decl cue
fs.writeFileSync(path.join(eProj, "P--proj", "t.jsonl"),
  JSON.stringify({ type: "assistant", cwd: eProj, timestamp: ENOW, message: { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "/proj/src/Thing.cpp" } }] } }) + "\n" +
  JSON.stringify({ type: "user", cwd: eProj, timestamp: ENOW, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: bigRead }] } }) + "\n" +
  JSON.stringify({ type: "assistant", cwd: eProj, timestamp: ENOW, message: { role: "assistant", content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/proj/src/Thing.cpp", old_string: declOld, new_string: "void Foo::Bar(){}" } }] } }) + "\n");
process.env.VTS_CLAUDE_PROJECTS = eProj;
const discEdit = await runTool("vts_discover", { since: 7 });
delete process.env.VTS_CLAUDE_PROJECTS;
const editDiscOk = !discEdit.isError && /1 whole-declaration Edit/.test(discEdit.text) && /skip that read/.test(discEdit.text);
try { fs.rmSync(eProj, { recursive: true, force: true }); } catch { /* ignore */ }
const editSteerOk = ssSteerOk && ssOffOk && editDiscOk;

// 54) edit-steer HOOK (L1 warn + L2 escalation): a whole-decl REPLACE/INSERT Edit gets a model-visible
// nudge with a ready symbol-edit call; a sub-decl tweak / non-code file / VTS_EDIT_WARN=0 stays silent. L2:
// once the adoption ledger's ignore-streak hits VTS_EDIT_BLOCK_AFTER, a SAFE insert is BLOCKED (a replace
// stays warn — riskier to force). The ledger is isolated to a temp file so the eval never touches the real one.
const EL = path.join(os.tmpdir(), `vts-eval-el-${process.pid}.json`);
const elEnv = (extra) => ({ VTS_EDIT_LEDGER: EL, VTS_LANG: "en", ...(extra || {}) });
const DECLC = "void Foo::Bar()\n{\n  a();\n  b();\n  c();\n  d();\n  e();\n  f();\n  g();\n}"; // 9 newlines + decl cue
try { fs.rmSync(EL, { force: true }); } catch { /* ignore */ }
const hRepl = runHook({ tool_name: "Edit", tool_input: { file_path: "/src/T.cpp", old_string: DECLC, new_string: "x" } }, elEnv());
const hIns = runHook({ tool_name: "Edit", tool_input: { file_path: "/src/T.cpp", old_string: "  anchor();", new_string: DECLC } }, elEnv());
const hSub = runHook({ tool_name: "Edit", tool_input: { file_path: "/src/T.cpp", old_string: "a,\nb,", new_string: "a,\nb,\nc," } }, elEnv());
const hOff = runHook({ tool_name: "Edit", tool_input: { file_path: "/src/T.cpp", old_string: DECLC, new_string: "x" } }, elEnv({ VTS_EDIT_WARN: "0" }));
const hMd = runHook({ tool_name: "Edit", tool_input: { file_path: "/notes/T.md", old_string: DECLC, new_string: "x" } }, elEnv());
const editWarnOk =
  hRepl.status === 0 && /replace_symbol_body symbol="Bar"/.test(nudgeCtx(hRepl)) &&   // whole-decl replace → ready replace call
  hIns.status === 0 && /insert_symbol symbol="Bar"/.test(nudgeCtx(hIns)) &&     // new-decl insert → ready insert call
  hSub.status === 0 && !nudgeCtx(hSub) &&                                              // sub-decl tweak → silent
  hOff.status === 0 && !nudgeCtx(hOff) &&                                              // VTS_EDIT_WARN=0 → silent
  hMd.status === 0 && !nudgeCtx(hMd);                                                  // non-code file → silent
fs.writeFileSync(EL, JSON.stringify({ builtin: 5, symbol: 0, streak: 5 }));            // streak at the threshold
const hEsc = runHook({ tool_name: "Edit", tool_input: { file_path: "/src/T.cpp", old_string: "  anchor();", new_string: DECLC } }, elEnv({ VTS_EDIT_BLOCK_AFTER: "5" }));
const escStreakReset = (() => { try { return JSON.parse(fs.readFileSync(EL, "utf8")).streak; } catch { return -1; } })(); // block fires → streak reset (no wall)
fs.writeFileSync(EL, JSON.stringify({ builtin: 9, symbol: 0, streak: 9 }));
const hEscRepl = runHook({ tool_name: "Edit", tool_input: { file_path: "/src/T.cpp", old_string: DECLC, new_string: "x" } }, elEnv({ VTS_EDIT_BLOCK_AFTER: "5" }));
fs.writeFileSync(EL, JSON.stringify({ builtin: 9, symbol: 0, streak: 9 }));
const hEscDefault = runHook({ tool_name: "Edit", tool_input: { file_path: "/src/T.cpp", old_string: "  anchor();", new_string: DECLC } }, elEnv()); // NO VTS_EDIT_BLOCK_AFTER → default OFF
const editEscalateOk =
  hEsc.status === 2 && /one-time block/.test(hEsc.err) &&   // opt-in (BLOCK_AFTER=5): insert past the streak → block once
  escStreakReset === 0 &&                                   // …and it RESETS the streak — fire-once, not a permanent wall
  hEscRepl.status === 0 &&                                  // replace stays warn even at high streak
  hEscDefault.status === 0;                                 // DEFAULT (no env) → NOT blocked (escalation off by default)
try { fs.rmSync(EL, { force: true }); } catch { /* ignore */ }
const editHookOk = editWarnOk && editEscalateOk;

// 55) per-file-language backend: a query that TARGETS a file gets its OWN language's backend, so a `.py`/
// `.ts` file in a clangd/roslyn-rooted MIXED repo (e.g. a UE C++ tree with a Python tooling dir) doesn't
// hit the wrong LSP and find nothing. Pure ext→backend map (backendForPath) + precedence (preferBackend):
// explicit a.backend > the path's backend WHEN it conflicts with a forced one (a `.js` is never sent to a
// `backend:"clangd"`-pinned global server → `-32001 invalid AST`) > forced BACKEND > path backend > "" (→ pickBackend).
const { backendForPath, preferBackend } = await import("../server/core.js");
const backendPathOk =
  backendForPath("Plugins/MyEditorPlugin/Python/trace_core.py") === "pyright" &&
  backendForPath("src/App.tsx") === "typescript" && backendForPath("a/b.mjs") === "typescript" &&
  backendForPath("Source/Foo.cpp") === "clangd" && backendForPath("Bar.h") === "clangd" &&
  backendForPath("Svc.cs") === "roslyn" &&
  backendForPath("README.md") === null && backendForPath("noext") === null && backendForPath(undefined) === null &&
  // precedence — a forced clangd must NOT swallow a .js/.cs/.py query on the one global server (the live -32001 bug)
  preferBackend("", "typescript", "clangd") === "typescript" && // conflict → the file's backend wins
  preferBackend("", "roslyn", "clangd") === "roslyn" &&         // conflict → the file's backend wins
  preferBackend("", "clangd", "clangd") === "clangd" &&         // agree → forced backend
  preferBackend("", null, "clangd") === "clangd" &&             // path-less (search_symbol by name) → forced kept
  preferBackend("roslyn", "typescript", "clangd") === "roslyn" && // explicit per-call wins outright
  preferBackend("", "typescript", "") === "typescript" &&      // no forced backend → the file's backend
  preferBackend("", null, "") === "";                          // nothing resolvable → "" (caller does pickBackend(root))

// 56) vts_setup genCompileDb — setup can kick off the compile-DB generation in the same step (so the user
// doesn't have to find the separate vts_gen_compile_db tool): `true` = DRY-RUN (prints the UBT command, runs
// nothing), "apply" = run UBT. Wiring test: the section appears with the GenerateClangDatabase command and
// UBT was NOT executed (dry).
const suEng = path.join(os.tmpdir(), `vts-eval-sueng-${process.pid}`);
fs.mkdirSync(path.join(suEng, "Engine", "Build", "BatchFiles"), { recursive: true });
fs.writeFileSync(path.join(suEng, "Engine", "Build", "BatchFiles", process.platform === "win32" ? "RunUBT.bat" : "RunUBT.sh"), "");
const suGame = path.join(os.tmpdir(), `vts-eval-sugame-${process.pid}`);
fs.mkdirSync(suGame, { recursive: true });
fs.writeFileSync(path.join(suGame, "MyGame.uproject"), "{}");
process.env.VTS_UE_ROOT = suEng;
const suGen = await runTool("vts_setup", { projectPath: suGame, genCompileDb: true });
delete process.env.VTS_UE_ROOT;
const setupGenOk =
  !suGen.isError &&
  /compile_commands\.json \(dry-run\)/.test(suGen.text) &&   // setup wired the gen step (dry)
  /GenerateClangDatabase/.test(suGen.text) &&                // the UBT command is shown
  !/Generated compile_commands/.test(suGen.text);            // …but UBT was NOT actually run
for (const d of [suEng, suGame]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }

// 57) vts_setup clangdCmd — the clangd-binary path is a first-class config key (a `vts setup` click can
// persist it WITHOUT editing the user's OS env), so backends can prefer a user-supplied clangd ≥ 22 over
// the deadlock-prone VS-bundled 19.1.x. Assert it lands in the config file and is reported as changed.
const fakeClangd = process.platform === "win32" ? "C:/tools/clangd/bin/clangd.exe" : "/opt/clangd/bin/clangd";
const suClangd = await runTool("vts_setup", { clangdCmd: fakeClangd });
let cfPersisted = {};
try { cfPersisted = JSON.parse(fs.readFileSync(CF, "utf8")) || {}; } catch { /* none */ }
const setupClangdOk =
  !suClangd.isError &&
  /clangdCmd/.test(suClangd.text) &&          // reported as a changed key
  cfPersisted.clangdCmd === fakeClangd;        // …and actually written to the config file

// 58) search_text → symbol steer — a TEXT query that is really a symbol/class usage hunt (a `Foo<Bar>`
// template arg, `::` scope, or CamelCase/snake identifier) gets a one-line nudge toward find_references /
// search_symbol (semantic, complete, no time-box) appended to the result; freeform/keyword text does NOT.
const { symbolHuntInText } = await import("../server/core.js");
const huntUnitOk =
  symbolHuntInText("FindComponentByClass<UMyComp>") === "UMyComp" &&   // template arg is the hunted type
  symbolHuntInText("MaxWalkSpeed") === "MaxWalkSpeed" &&               // dominant CamelCase identifier
  !!symbolHuntInText("get_value|set_value") &&                        // snake_case alternation → truthy
  symbolHuntInText("TODO|FIXME") === null &&                          // ALL-CAPS keyword → no symbol shape
  symbolHuntInText("just some plain words") === null;                 // prose → null
// integration: a code scan whose q is a `<Type>` hunt steers; a plain-word q does not.
const stDir = path.join(os.tmpdir(), `vts-eval-textsteer-${process.pid}`);
fs.mkdirSync(stDir, { recursive: true });
fs.writeFileSync(path.join(stDir, "use.cpp"), "auto* w = Owner->Helper<UMyWidget>();\nint plainword = 1;\n");
const stHunt = await runTool("search_text", { q: "Helper<UMyWidget>", projectPath: stDir });
const stPlain = await runTool("search_text", { q: "plainword", projectPath: stDir });
const textSteerOk =
  huntUnitOk &&
  /find_references symbol="UMyWidget"/.test(stHunt.text) &&   // symbol hunt → steer with the right name
  !/find_references/.test(stPlain.text);                       // plain word → no steer
try { fs.rmSync(stDir, { recursive: true, force: true }); } catch { /* ignore */ }

// 59) edit-warn control-flow exclusion — a multi-line `if (…) {` / `for (…) {` block edited INSIDE a
// function body must NOT be classified as a whole declaration (dogfood-found false positive: it suggested
// `replace_symbol_body symbol="if"`, which is not a named symbol). A real function/class decl still counts.
const { classifyDeclEdit } = await import("../server/edit-detect.js");
const ifBlock = "if (Pawn && Pawn->IsValid())\n{\n    DoA();\n    DoB();\n    DoC();\n    DoD();\n    DoE();\n    DoF();\n}";
const forBlock = "for (int i = 0; i < n; ++i)\n{\n    sum += i;\n    sum += i;\n    sum += i;\n    sum += i;\n    sum += i;\n    sum += i;\n}";
// control-flow block whose BODY contains a DECL_KW token (`(void)` cast / `static` local) — the construct is
// still control flow (decided by the FIRST line), so it must NOT count as a whole declaration (v0.26.2 fix;
// the v0.26.1 fix only guarded the signature-opener branch and these still false-positived).
const ifVoid = "if (Pawn && Pawn->IsValid())\n{\n    (void)Pawn;\n    DoA();\n    DoB();\n    DoC();\n    DoD();\n    DoE();\n}";
const ifStatic = "if (ready)\n{\n    static int n = 0;\n    n++;\n    n++;\n    n++;\n    n++;\n    n++;\n}";
const realFn = "void UMyClass::DoWork(int x)\n{\n    int a = x;\n    a += 1;\n    a += 2;\n    a += 3;\n    a += 4;\n    a += 5;\n    Helper(a);\n}";
const ctrlFlowExclusionOk =
  classifyDeclEdit("Edit", { file_path: "a.cpp", old_string: ifBlock, new_string: "x" }).replaceDecl === false &&
  classifyDeclEdit("Edit", { file_path: "a.cpp", old_string: forBlock, new_string: "x" }).replaceDecl === false &&
  classifyDeclEdit("Edit", { file_path: "a.cpp", old_string: ifVoid, new_string: "x" }).replaceDecl === false &&
  classifyDeclEdit("Edit", { file_path: "a.cpp", old_string: ifStatic, new_string: "x" }).replaceDecl === false &&
  classifyDeclEdit("Edit", { file_path: "a.cpp", old_string: realFn, new_string: "x" }).replaceDecl === true;

// 60) outline-hunt Grep steer — a declaration-KEYWORD alternation (`^(function|const|export)`) is the model
// enumerating a file's STRUCTURE, not hunting one named symbol → warn pointing at document_symbols (warn-ONLY:
// keyword alts are FP-prone so never blocked). Was previously invisible (no code path/glob → no warn at all,
// a top measured bypass). A CamelCase/snake identifier means a specific symbol → the symbol-hunt block path
// owns it (not this); an ALL-CAPS keyword alt (TODO|FIXME) is neither → stays silent (no false steer).
const oWarn = (p, extra) => nudgeCtx(runHook({ tool_name: "Grep", tool_input: { pattern: p, ...(extra || {}) } }));
const outlineWarn = oWarn("^(function|const|export)", { path: "server/core.js" });
const outlineSteerOk =
  /document_symbols/.test(outlineWarn) && /server\/core\.js/.test(outlineWarn) && // keyword-alt + path → document_symbols warn naming the file
  /document_symbols/.test(oWarn("^(function|const|async function|export)")) &&     // multi-word branch ("async function") reduced to its keyword
  /document_symbols/.test(oWarn("^(export|import)")) &&                            // import is a structure keyword (kw≥2)
  /document_symbols/.test(oWarn("^[ \\t]*(function|const)")) &&                    // anchor+charclass+group glued to 1st branch, per-branch cleanup
  /document_symbols/.test(oWarn("^(function|const)$")) &&                          // trailing $ anchor stripped
  // a keyword-only alternation that the symbol-hunt cue (`\bclass\b`) would otherwise BLOCK is steered to the
  // outline path FIRST (it carries no specific identifier → it's an outline, not a named hunt).
  /document_symbols/.test(oWarn("^(class|struct|enum)")) &&
  /document_symbols/.test(oWarn("^(def|class)")) &&
  // FP-safe: ALL-CAPS / prose / control-flow keyword alternations do NOT steer.
  (() => { const r = runHook({ tool_name: "Grep", tool_input: { pattern: "TODO|FIXME" } }); return r.status === 0 && !/document_symbols/.test(r.out + r.err); })() &&
  (() => { const r = runHook({ tool_name: "Grep", tool_input: { pattern: "error|warning|info" } }); return r.status === 0 && !/document_symbols/.test(r.out + r.err); })() &&
  // CamelCase / snake alternation stays a symbol-hunt BLOCK (owned by isSymbolHuntGrep, excluded from outline).
  (() => { const r = runHook({ tool_name: "Grep", tool_input: { pattern: "MaxWalkSpeed|MaxExcessSpeed" } }); return r.status === 2 && !/document_symbols/.test(r.err); })() &&
  // malformed (nested paren) → 2nd branch fails the exact keyword match → kw<2 → no steer, no crash.
  (() => { const r = runHook({ tool_name: "Grep", tool_input: { pattern: "^(function|const(nested))" } }); return r.status === 0; })();

// 61) common-prefix factoring for find_files + search_text — both previously repeated the full absolute path
// on EVERY row (benchmark-found: find_files ~32%, search_text ~54% reduction). factorCommonPrefix prints the
// shared directory once as `under <prefix>/` with relative tails, the same token-saver fmtLocations uses.
const cpDir = path.join(os.tmpdir(), `vts-eval-prefix-${process.pid}`);
fs.mkdirSync(path.join(cpDir, "sub"), { recursive: true });
fs.writeFileSync(path.join(cpDir, "sub", "alpha.ts"), "const NEEDLE_one = 1;\n");
fs.writeFileSync(path.join(cpDir, "sub", "beta.ts"), "const NEEDLE_two = 2;\n");
const cpFiles = await runTool("find_files", { q: ".ts", projectPath: cpDir });
const cpText = await runTool("search_text", { q: "NEEDLE", projectPath: cpDir });
const cpAbs = new RegExp(cpDir.replace(/\\/g, "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/sub/alpha\\.ts");
process.env.VTS_COMPACT_RESULTS = "0";
const cpOff = await runTool("find_files", { q: ".ts", projectPath: cpDir });
delete process.env.VTS_COMPACT_RESULTS;
const prefixFactoringOk =
  // find_files: one `under <prefix>/` header + relative tails (alpha.ts/beta.ts), not the full path per row.
  !cpFiles.isError && /under .*sub\//.test(cpFiles.text) && /\n {2}alpha\.ts\b/.test(cpFiles.text) && /\n {2}beta\.ts\b/.test(cpFiles.text) &&
  // search_text: same factoring, tails keep `:line: text`.
  !cpText.isError && /under .*sub\//.test(cpText.text) && /\n {2}alpha\.ts:1: /.test(cpText.text) &&
  // VTS_COMPACT_RESULTS=0 → classic per-row (no `under` header, full absolute path on each line).
  !cpOff.isError && !/under .*sub\//.test(cpOff.text) && cpAbs.test(cpOff.text);
try { fs.rmSync(cpDir, { recursive: true, force: true }); } catch { /* ignore */ }

// 62) tool-definition budget + vts_admin fold — the tool schemas are a FIXED per-session context cost
// (always in the model's system prompt). Trimming descriptions then folding the 9 cold admin tools behind
// one `vts_admin{op,params}` cut tools/list 4088→3436→~2420 tok. Reads the schemas from server/tools.js
// directly (NO server spawn, NO MCP SDK — this eval is the toolchain-free gate) and asserts: the HOT
// search/nav/edit tools stay first-class + named; the cold tools are NOT separately advertised; vts_admin
// carries the op enum; op→vts_<op> resolves to a real runTool handler; and the list stays under budget.
const { TOOLS: TOOL_DEFS, ADMIN_OPS } = await import("../server/tools.js");
const toolNames = TOOL_DEFS.map((t) => t.name);
const toolsTok = Math.round(Buffer.byteLength(JSON.stringify(TOOL_DEFS), "utf8") / 4);
const adminTool = TOOL_DEFS.find((t) => t.name === "vts_admin");
// op→vts_<op> must each be a real runTool handler (folding can't point at a missing op). vts_config is the
// cheapest to actually invoke (no backend/filesystem) — proves the dispatch target resolves.
const cfgViaOp = await runTool("vts_" + "config", {});
const toolsBudgetOk =
  TOOL_DEFS.length === 13 && // 11 hot search/nav/edit (inserts merged into insert_symbol) + diagnostics + vts_admin
  ["search_symbol", "find_references", "goto_definition", "search_text", "find_files", "replace_symbol_body"].every((n) => toolNames.includes(n)) && // hot tools first-class
  toolNames.includes("vts_admin") &&
  !["vts_setup", "vts_git", "vts_p4", "vts_savings", "vts_savings_reset", "vts_discover", "vts_warmup", "vts_config", "vts_gen_compile_db"].some((n) => toolNames.includes(n)) && // cold tools folded away
  TOOL_DEFS.every((t) => t.name && (t.description || "").length > 10 && t.inputSchema) && // routing signal intact
  JSON.stringify(adminTool?.inputSchema?.properties?.op?.enum || []) === JSON.stringify([...ADMIN_OPS]) && // enum matches the dispatch set
  !cfgViaOp.isError && /settings/i.test(cfgViaOp.text) && // op→vts_config resolves to a real handler
  toolsTok <= 3200; // ~3030: fold floor ~2420 + Glama tool-quality re-add (~480) + the diagnostics tool +
                    // goto `kind` (~130). Cap still blocks prose creep.

// 63) LSP-glue strengthening (referencing OMC lsp_* / IDE surfaces): a `diagnostics` tool + goto_definition
// `kind` (type_definition/implementation/declaration). The mock pushes 2 diagnostics (publishDiagnostics on
// didOpen) for a "diag"-named file, none for a clean one; the goto kinds route to the matching LSP method.
const lspDir = path.join(os.tmpdir(), `vts-eval-lsp-${process.pid}`);
fs.mkdirSync(lspDir, { recursive: true });
fs.writeFileSync(path.join(lspDir, "with_diag.cpp"), "int main(){return 0;}\n");
fs.writeFileSync(path.join(lspDir, "clean.cpp"), "int ok(){return 1;}\n");
const dg = await runTool("diagnostics", { path: path.join(lspDir, "with_diag.cpp"), projectPath: lspDir, backend: "clangd" });
const dgClean = await runTool("diagnostics", { path: path.join(lspDir, "clean.cpp"), projectPath: lspDir, backend: "clangd" });
const gImpl = await runTool("goto_definition", { path: path.join(lspDir, "clean.cpp"), line: 0, character: 4, kind: "implementation", projectPath: lspDir, backend: "clangd" });
const gType = await runTool("goto_definition", { path: path.join(lspDir, "clean.cpp"), line: 0, character: 4, kind: "type_definition", projectPath: lspDir, backend: "clangd" });
const gDef = await runTool("goto_definition", { path: path.join(lspDir, "clean.cpp"), line: 0, character: 4, projectPath: lspDir, backend: "clangd" });
const gDecl = await runTool("goto_definition", { path: path.join(lspDir, "clean.cpp"), line: 0, character: 4, kind: "declaration", projectPath: lspDir, backend: "clangd" }); // mock replies -32601 → must degrade, not error
process.env.VTS_DIAG_DIR_WAIT_MS = "300"; // mock publishes on didOpen instantly — no need for the 4s default
const dgDir = await runTool("diagnostics", { scope: "directory", projectPath: lspDir, backend: "clangd" });
delete process.env.VTS_DIAG_DIR_WAIT_MS;
const lspGlueOk =
  // diagnostics: summary + sorted error-before-warning + file:line:col + [code] + message
  !dg.isError && /1 error, 1 warning/.test(dg.text) && /:5:3 error \[E001\]: use of undeclared/.test(dg.text) &&
  dg.text.indexOf("E001") < dg.text.indexOf("unused variable") &&
  !dgClean.isError && /no diagnostics/.test(dgClean.text) &&
  // scope=directory aggregates across files (the diag file's 2 diagnostics, the clean file contributes none)
  !dgDir.isError && /1 error, 1 warning/.test(dgDir.text) && /with_diag\.cpp:5:3 error/.test(dgDir.text) && /file\(s\) scanned/.test(dgDir.text) &&
  // goto kinds route to the right LSP method (distinct mock locations) with the right label
  !gImpl.isError && /implementation of/.test(gImpl.text) && /Impl\.cpp:101/.test(gImpl.text) &&
  !gType.isError && /type definition of/.test(gType.text) && /Type\.cpp:201/.test(gType.text) &&
  !gDef.isError && /Foo\.cpp:42/.test(gDef.text) && /^definition of .*clean\.cpp/.test(gDef.text) &&
  // kind=declaration on a backend WITHOUT that provider → MethodNotFound (-32601) caught in gotoByKind →
  // graceful empty ("0 definition(s)"), NOT a raw LSP error surfaced to the model (live dogfound: tsserver).
  !gDecl.isError && /0 declaration\(s\)/.test(gDecl.text);
try { fs.rmSync(lspDir, { recursive: true, force: true }); } catch { /* ignore */ }

await disposeClients();
// 48) clean teardown (no orphaned child): disposeClients must terminate EVERY spawned language-server
// child — evicted, swept, mid-warmup, or key-overwritten — via the master registry. A surviving child
// holds the event loop open (the process hangs after PASS → the CI test step never exits). Assert no mock
// LSP child handle is still alive shortly after teardown. (process._getActiveHandles is internal but
// stable across the CI Node versions; the guard is the regression net for the orphan that caused this.)
await new Promise((r) => setTimeout(r, 300)); // let killed children reap (Windows TerminateProcess + 'exit')
const liveChildren = (process._getActiveHandles?.() || [])
  .filter((h) => h && h.constructor && h.constructor.name === "ChildProcess" && (h.spawnargs || []).some((a) => /_mock-lsp/.test(String(a)))).length;
const teardownOk = liveChildren === 0;

try { fs.rmSync(QH, { force: true }); } catch { /* ignore */ }
try { fs.rmSync(IG, { force: true }); } catch { /* ignore */ }
try { fs.rmSync(CF, { force: true }); } catch { /* ignore */ }
try { fs.rmSync(SV, { force: true }); } catch { /* ignore */ }
try { fs.rmSync(TEE, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(EDL, { force: true }); } catch { /* ignore */ }

// 64) value-tied star nudge — appears in the `vts savings` report ONLY past a cumulative-saving threshold,
// is a PURE function of `saved` (no network, no GitHub star-status check → zero-transmission preserved), and
// VTS_STAR_NUDGE=0 silences it. Shown only in the manual report, never in the search/edit flow.
const { starNudgeLine } = await import("../server/core.js");
const starNudgeOk =
  /⭐/.test(starNudgeLine(60000)) && /github\.com\/JSungMin\/vs-token-safer/.test(starNudgeLine(60000)) && // over threshold → shown with url
  starNudgeLine(1000) === "" &&                                                                            // under threshold → silent
  (() => { process.env.VTS_STAR_NUDGE = "0"; const off = starNudgeLine(99999); delete process.env.VTS_STAR_NUDGE; return off === ""; })(); // toggle off

// 65) symbol-edit P4 auto-checkout (ensureWritableForEdit): before an apply WRITE to a READ-ONLY file (the
// Perforce signature) vts runs `p4 edit` so the symbol-edit/rename isn't blocked — it writes via fs directly,
// bypassing any built-in Edit/Write p4 hook. Gated on read-only → a writable (git) repo never invokes p4.
// Stub VTS_P4_CMD with a script that chmods the file writable, standing in for `p4 edit`.
const { ensureWritableForEdit } = await import("../server/core.js");
const p4dir = path.join(os.tmpdir(), `vts-eval-p4-${process.pid}`); fs.mkdirSync(p4dir, { recursive: true });
const p4wf = path.join(p4dir, "writable.ts"); fs.writeFileSync(p4wf, "x");
const p4rf = path.join(p4dir, "readonly.ts"); fs.writeFileSync(p4rf, "x"); fs.chmodSync(p4rf, 0o444);
const p4stub = path.join(p4dir, "p4stub.mjs");
fs.writeFileSync(p4stub, "import fs from 'node:fs'; fs.chmodSync(process.argv[process.argv.length-1], 0o666);\n");
const p4NoteWritable = ensureWritableForEdit(p4wf); // writable → skip p4 entirely
process.env.VTS_P4_CMD = `node "${p4stub}"`;
const p4NoteRO = ensureWritableForEdit(p4rf);       // read-only → stub "p4 edit" opens it → note
delete process.env.VTS_P4_CMD;
try { fs.chmodSync(p4rf, 0o444); } catch { /* re-lock */ }
process.env.VTS_P4_EDIT = "0";
const p4NoteDisabled = ensureWritableForEdit(p4rf); // disabled → "" even though read-only
delete process.env.VTS_P4_EDIT;
const p4EditOk = p4NoteWritable === "" && /p4 edit/i.test(p4NoteRO) && p4NoteDisabled === "";
try { fs.chmodSync(p4rf, 0o666); fs.rmSync(p4dir, { recursive: true, force: true }); } catch { /* ignore */ }

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
  ["log steer + empty hint → gamedev-log", logSteerOk, "true", logSteerOk],
  ["hook: rewrite code-grep / warn log+grep", hookOk, "true", hookOk],
  ["hook: rewrite find/git-grep, block complex/pipe, exclude", rewriteOk, "true", rewriteOk],
  ["search_text JS/TS + symbol→text fallback", jsTextOk, "true", jsTextOk],
  ["language census + adaptive cap + multi-prewarm", warmRatioOk, "true", warmRatioOk],
  ["vts_setup language census auto-config", setupOk, "true", setupOk],
  ["first-use setup nudge (tool + hook)", setupNudgeOk, "true", setupNudgeOk],
  ["marketplace ↔ plugin.json version parity", manifestOk, "true", manifestOk],
  ["buffer freshness: didOpen→didChange→didClose", freshOk, "true", freshOk],
  ["LSP conformance: server-req replies + cancel + caps", conformanceOk, "true", conformanceOk],
  ["clangd no-compile-DB: advisory + text fallback", clangdNoDbOk, "true", clangdNoDbOk],
  ["vts_gen_compile_db dry-run (UBT command)", genDbOk, "true", genDbOk],
  ["no silent caps: find_files/search_text truncation note", truncOk, "true", truncOk],
  ["savings: graph/daily/history + USD (RTK gain)", savingsUpgradeOk, "true", savingsUpgradeOk],
  ["tee: truncated result written to recovery file", teeOk, "true", teeOk],
  ["discover: bypassed searches + catch-rate + learn (synergy B/C)", discoverOk, "true", discoverOk],
  ["synergy A: search_symbol no-backend → text (no hard error)", symbolNoBackendOk, "true", symbolNoBackendOk],
  ["self-improve: concrete grep nudge + boot auto-learn", selfImproveOk, "true", selfImproveOk],
  ["round-2: LSP-cap tee + per-tool savings", round2Ok, "true", round2Ok],
  ["VCS guard: compile DB git/p4-ignored (idempotent)", vcsGuardOk, "true", vcsGuardOk],
  ["gen-compile-db apply: out-of-tree DB+index + inTree guard + perf flags", applyOk, "true", applyOk],
  ["perf: persisted clangd index detected (skip TU re-parse)", persistedIndexOk, "true", persistedIndexOk],
  ["perf: return-when-found poll on a loading index", returnWhenFoundOk, "true", returnWhenFoundOk],
  ["compact: git/p4 output grouped+deduped+capped (pure)", compactPureOk, "true", compactPureOk],
  ["vts_git live wrapper + search_text docs sweep", vcsToolsOk, "true", vcsToolsOk],
  ["hook: git/p4 reroute to vts wrapper (git grep stays code)", vcsHookOk, "true", vcsHookOk],
  ["savings: string-raw not inflated + no negative tool (dogfood)", savingsLedgerOk, "true", savingsLedgerOk],
  ["hardening: ro-allowlist + path-confine + rename/binary/budget/trunc", hardeningOk, "true", hardeningOk],
  ["polish: git/p4 run in cwd + p4-changes parse + dedup wording", polishOk, "true", polishOk],
  ["i18n: VTS_LANG=ko Korean block+nudge / en English", i18nOk, "true", i18nOk],
  ["backend pool: LRU evict + idle reap + in-flight protect", poolLifecycleOk, "true", poolLifecycleOk],
  ["per-call root: findProjectRoot walk-up + resolveRoot precedence + MCP roots", rootResolveOk, "true", rootResolveOk],
  ["output cap v2: refs collapse per-file + common-prefix factor (toggle)", capResultsOk, "true", capResultsOk],
  ["clean teardown: no orphaned LSP child after disposeClients", teardownOk, "true", teardownOk],
  ["Glob-tool nudge → find_files + find_files skips heavy dirs", globAndWalkOk, "true", globAndWalkOk],
  ["enforce v2: symbol-hunt Grep blocks, freeform warns + discover counts Glob", enforceAndDiscoverOk, "true", enforceAndDiscoverOk],
  ["v2.2: find <dir> honored in rewrite + concrete-code Glob blocks → find_files", v22Ok, "true", v22Ok],
  ["symbolic editing: replace/insert/safe_delete by name (preview+apply+ref-guard)", symEditOk, "true", symEditOk],
  ["edit-steer: search EDIT_STEER (toggle) + discover counts whole-decl Edit", editSteerOk, "true", editSteerOk],
  ["edit-steer hook: L1 warn (replace/insert) + L2 safe-insert escalation", editHookOk, "true", editHookOk],
  ["per-file-language backend (.py→pyright in a clangd-rooted mixed repo)", backendPathOk, "true", backendPathOk],
  ["vts_setup genCompileDb: generates the compile DB in the setup step (dry)", setupGenOk, "true", setupGenOk],
  ["vts_setup clangdCmd: persists the clangd-binary path to config", setupClangdOk, "true", setupClangdOk],
  ["search_text → symbol steer (find_references on a `<Type>`/symbol hunt)", textSteerOk, "true", textSteerOk],
  ["edit-warn control-flow exclusion (if/for block ≠ a whole decl)", ctrlFlowExclusionOk, "true", ctrlFlowExclusionOk],
  ["outline-hunt Grep steer (decl-keyword alt → document_symbols; FP-safe)", outlineSteerOk, "true", outlineSteerOk],
  ["common-prefix factoring: find_files + search_text (toggle)", prefixFactoringOk, "true", prefixFactoringOk],
  ["tool-def budget + vts_admin fold: hot tools named, cold folded, ≤ 3200 tok", toolsBudgetOk, "true", toolsBudgetOk],
  ["LSP glue: diagnostics tool + goto kinds (typeDef/impl/decl)", lspGlueOk, "true", lspGlueOk],
  ["star nudge: value-tied, threshold-gated, pure (no network), toggle", starNudgeOk, "true", starNudgeOk],
  ["symbol-edit P4 auto-checkout: read-only → p4 edit, writable skips, toggle", p4EditOk, "true", p4EditOk],
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
