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
const hoverOk = !hv.isError && /Foo/.test(hv.text);
const ds = await runTool("document_symbols", { path: someFile, backend: "clangd" });
process.env.VTS_OUTLINE_RAW = "1";
const dsRaw = await runTool("document_symbols", { path: someFile, backend: "clangd" });
delete process.env.VTS_OUTLINE_RAW;
const docSymOk =
  !ds.isError && /Foo/.test(ds.text) && /:5/.test(ds.text) &&
  /keepMethod/.test(ds.text) &&                  // real method kept
  /realInner/.test(ds.text) &&                   // real decl inside a hidden wrapper NOT orphaned
  /func callback {2}@/.test(ds.text) &&          // top-level symbol named 'callback' kept (depth-0, not noise)
  !/map\(\) callback/.test(ds.text) && !/localTmp/.test(ds.text) && // anonymous + nested local hidden
  /local\/anonymous hidden/.test(ds.text) &&     // the hidden-count note
  /map\(\) callback/.test(dsRaw.text) && /localTmp/.test(dsRaw.text); // VTS_OUTLINE_RAW=1 shows everything
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
const hGrep = runHook({ tool_name: "Grep", tool_input: { pattern: "Foo", glob: "*.ts" } });
const hGrepLog = runHook({ tool_name: "Grep", tool_input: { pattern: "Error", path: "Saved/Logs" } }); // bare Logs dir
let hCodeJson = {}; try { hCodeJson = JSON.parse(hCode.out || "{}"); } catch { /* ignore */ }
const rwOut = hCodeJson.hookSpecificOutput || {};
const hookOk =
  hCode.status === 0 && rwOut.permissionDecision === "allow" &&
  /cli\.js" symbol --q "Foo"/.test(rwOut.updatedInput?.command || "") && // identifier → semantic vts symbol (synergy A)
  hCodeBlock.status === 2 && /Blocked/.test(hCodeBlock.err) &&         // VTS_REWRITE=0 → block fallback
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
  hComplex.status === 2 && /Blocked/.test(hComplex.err) &&
  hPipe.status === 2 &&
  hExcluded.status === 0 && !/Blocked/.test(hExcluded.err) && !(parseRw(hExcluded).updatedInput); // excluded → untouched

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
const svRich = await runTool("vts_savings", { graph: true, daily: true, history: true });
const savingsUpgradeOk =
  !svPlain.isError && /est\. value: ~\$/.test(svPlain.text) &&            // USD line always present
  !/Saved tokens \/ day/.test(svPlain.text) &&                            // graph NOT shown by default
  /Saved tokens \/ day \(last 30\)/.test(svRich.text) &&                  // --graph
  /Daily \(last/.test(svRich.text) &&                                     // --daily
  /Recent runs:/.test(svRich.text);                                       // --history

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
const nIdent = nudgeCtx(runHook({ tool_name: "Grep", tool_input: { pattern: "Foo", glob: "*.ts" } }));
const nRegex = nudgeCtx(runHook({ tool_name: "Grep", tool_input: { pattern: "FooA|FooB", glob: "*.cpp" } }));
const nudgeOk =
  /find_references symbol="Foo"/.test(nIdent) && /search_symbol q="Foo"/.test(nIdent) && // identifier → usages + decl
  /search_text q="FooA\|FooB"/.test(nRegex); // regex → text suggestion
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
const dbGitignore = (() => { try { return fs.readFileSync(path.join(ueGame, ".gitignore"), "utf8"); } catch { return ""; } })();
const applyOutOk =
  !applied.isError && /Generated compile_commands\.json/.test(applied.text) &&
  fs.existsSync(path.join(outDir, "compile_commands.json")) &&        // DB landed out of tree
  !fs.existsSync(path.join(ueGame, "compile_commands.json")) &&       // no DB in the source tree
  /OUTSIDE the source tree/.test(applied.text) &&
  dbGitignore.includes(".cache/") && !dbGitignore.includes("compile_commands.json") && // .cache/ ignored in-tree; DB not (it's out-of-tree)
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

await disposeClients();
try { fs.rmSync(QH, { force: true }); } catch { /* ignore */ }
try { fs.rmSync(IG, { force: true }); } catch { /* ignore */ }
try { fs.rmSync(CF, { force: true }); } catch { /* ignore */ }
try { fs.rmSync(SV, { force: true }); } catch { /* ignore */ }
try { fs.rmSync(TEE, { recursive: true, force: true }); } catch { /* ignore */ }

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
  ["gen-compile-db apply: out-of-tree DB + in-tree .cache ignored + perf flags", applyOk, "true", applyOk],
  ["perf: persisted clangd index detected (skip TU re-parse)", persistedIndexOk, "true", persistedIndexOk],
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
