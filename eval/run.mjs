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
const runHook = (payload) => {
  const r = spawnSync(process.execPath, [hookPath], { input: JSON.stringify(payload), encoding: "utf8" });
  return { status: r.status, out: r.stdout || "", err: r.stderr || "" };
};
const hCode = runHook({ tool_name: "Bash", tool_input: { command: "grep -rn Foo src/Thing.cpp" } });
const hLog = runHook({ tool_name: "Bash", tool_input: { command: "grep Error Saved/Logs/run.log" } });
const hGrep = runHook({ tool_name: "Grep", tool_input: { pattern: "Foo", glob: "*.ts" } });
const hGrepLog = runHook({ tool_name: "Grep", tool_input: { pattern: "Error", path: "Saved/Logs" } }); // bare Logs dir
const hookOk =
  hCode.status === 2 && /Blocked/.test(hCode.err) &&
  hLog.status === 0 && /gamedev-log/.test(hLog.out) &&
  hGrep.status === 0 && /Grep tool/.test(hGrep.out) &&
  hGrepLog.status === 0 && /gamedev-log/.test(hGrepLog.out);

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
const hNudge = runHook({ tool_name: "Bash", tool_input: { command: "grep -rn Foo src/Thing.cpp" } }); // CF gone → setup line
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

await disposeClients();
try { fs.rmSync(QH, { force: true }); } catch { /* ignore */ }
try { fs.rmSync(IG, { force: true }); } catch { /* ignore */ }
try { fs.rmSync(CF, { force: true }); } catch { /* ignore */ }

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
  ["hook: block code / warn log+grep", hookOk, "true", hookOk],
  ["search_text JS/TS + symbol→text fallback", jsTextOk, "true", jsTextOk],
  ["language census + adaptive cap + multi-prewarm", warmRatioOk, "true", warmRatioOk],
  ["vts_setup language census auto-config", setupOk, "true", setupOk],
  ["first-use setup nudge (tool + hook)", setupNudgeOk, "true", setupNudgeOk],
  ["marketplace ↔ plugin.json version parity", manifestOk, "true", manifestOk],
  ["buffer freshness: didOpen→didChange→didClose", freshOk, "true", freshOk],
  ["LSP conformance: server-req replies + cancel + caps", conformanceOk, "true", conformanceOk],
  ["clangd no-compile-DB: advisory + text fallback", clangdNoDbOk, "true", clangdNoDbOk],
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
