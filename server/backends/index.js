// Backend registry: how to spawn each OFFICIAL language server. We run the trusted engine (clangd from
// LLVM, a Roslyn-based C# LSP) locally and only translate LSP↔MCP in our own thin glue — no third-party
// MCP server runs over your source.
//
// Each backend is { cmd, args(root), detect(root) }. cmd/args are overridable via config/env
// (VTS_<NAME>_CMD / VTS_<NAME>_ARGS) so users can point at their own clangd / csharp-ls / MS C# LSP.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toUri, envInt, langIdForPath } from "../lsp.js";
import { orderForWarm, warmCap } from "../warmset.js";
import { resolveBinJs } from "../resolve-bin.js";

const env = (name, def) => { const v = process.env[name]; return v && v !== "" ? v : def; };
const splitArgs = (s) => (s ? s.split(/\s+/).filter(Boolean) : null);

// clangd ≥ this is recommended for large Unreal projects. Older clangd (notably the 19.1.x bundled with
// Visual Studio) can DEADLOCK indexing real UE translation units in LSP-server mode — clangd --check
// parses the same TU fine, but every async path (didOpen + background-index) never finishes. Verified:
// VS-bundled clangd 19.1.5 deadlocks (>250s, 0 symbols); standalone clangd 22.1.6 parses it in ~13s and
// returns symbols. See https://github.com/clangd/clangd/releases for a current build.
export const MIN_CLANGD = 22;
export function parseClangdMajor(versionText) {
  const m = /clangd version (\d+)/i.exec(String(versionText || ""));
  return m ? parseInt(m[1], 10) : null;
}
// Run `<cmd> --version` once and return the major version (or null if it can't be determined).
let _clangdMajorCache;
export function clangdMajor(cmd) {
  if (_clangdMajorCache !== undefined) return _clangdMajorCache;
  try { _clangdMajorCache = parseClangdMajor(execFileSync(cmd, ["--version"], { encoding: "utf8", timeout: 10000 })); }
  catch { _clangdMajorCache = null; }
  return _clangdMajorCache;
}
// One-line advisory if the resolved clangd is older than recommended; "" otherwise. Best-effort: a
// clangd we can't version-probe (null) is left alone rather than nagged.
export function clangdAdvisory(cmd) {
  const major = clangdMajor(cmd);
  if (major != null && major < MIN_CLANGD)
    return `⚠ clangd ${major}.x detected — clangd ≥ ${MIN_CLANGD} is recommended for large Unreal/C++ projects. Older clangd (e.g. the 19.1.x bundled with Visual Studio) can hang indexing UE translation units. Point VTS_CLANGD_CMD at a newer clangd (https://github.com/clangd/clangd/releases).`;
  return "";
}

// Collect every file (up to `depth`) whose name matches `re` — used to open all .csproj for Roslyn.
function findAllShallow(root, re, depth = 2) {
  const out = [];
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, d] = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isFile() && re.test(e.name)) out.push(path.join(dir, e.name));
      else if (e.isDirectory() && d < depth && !e.name.startsWith(".") && e.name !== "node_modules") stack.push([path.join(dir, e.name), d + 1]);
    }
  }
  return out;
}

// Locate Microsoft.CodeAnalysis.LanguageServer (the official Roslyn LSP that Visual Studio / the C#
// Dev Kit use), bundled with the VS Code C# extension. Highest extension version wins. This is the
// preferred C# engine; csharp-ls is the fallback when it's absent. Override with VTS_ROSLYN_CMD/ARGS.
function findRoslynMsDll() {
  const override = env("VTS_ROSLYN_DLL");
  if (override) return fs.existsSync(override) ? override : null;
  const extRoot = path.join(os.homedir(), ".vscode", "extensions");
  let dirs;
  try { dirs = fs.readdirSync(extRoot).filter((n) => n.startsWith("ms-dotnettools.csharp-")); } catch { return null; }
  dirs.sort().reverse(); // lexical sort puts the newest semver-ish folder last → reverse for first
  for (const d of dirs) {
    const dll = path.join(extRoot, d, ".roslyn", "Microsoft.CodeAnalysis.LanguageServer.dll");
    if (fs.existsSync(dll)) return dll;
  }
  return null;
}
const ROSLYN_MS_DLL = findRoslynMsDll();

// Microsoft.CodeAnalysis.LanguageServer targets a recent .NET (currently net10), which the system
// `dotnet` (often an older SDK) can't host. The VS Code C# extension acquires a private runtime via
// the vscode-dotnet-runtime extension — find its newest dotnet host and use it to launch the dll.
// Override with VTS_ROSLYN_CMD. Falls back to "dotnet" (works if a new-enough runtime is on PATH).
function findRoslynDotnetHost() {
  const base = path.join(os.homedir(), "AppData", "Roaming", "Code", "User", "globalStorage", "ms-dotnettools.vscode-dotnet-runtime", ".dotnet");
  let dirs;
  try { dirs = fs.readdirSync(base).filter((n) => /^\d+\.\d+/.test(n)); } catch { return "dotnet"; }
  // Newest version folder first (e.g. "10.0.8~x64~aspnetcore"); pick the first with a dotnet.exe.
  dirs.sort((a, b) => {
    const pa = a.split("~")[0].split(".").map(Number), pb = b.split("~")[0].split(".").map(Number);
    for (let i = 0; i < 3; i++) if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
    return 0;
  });
  for (const d of dirs) {
    const exe = path.join(base, d, process.platform === "win32" ? "dotnet.exe" : "dotnet");
    if (fs.existsSync(exe)) return exe;
  }
  return "dotnet";
}
const ROSLYN_DOTNET = ROSLYN_MS_DLL ? findRoslynDotnetHost() : "dotnet";

const exists = (root, ...names) => names.some((n) => {
  try { return fs.existsSync(path.join(root, n)); } catch { return false; }
});

// --- out-of-tree compile-DB home: keep generated artifacts outside the source tree, so neither the DB
// nor clangd's index shows up for git or `p4 reconcile`. One dir per project root under ~/.vs-token-safer/db/
// (VTS_DB_DIR overrides the base); clangd reads the DB via --compile-commands-dir AND writes its
// `.cache/clangd` index there too — it honors --compile-commands-dir as the index root (live-verified:
// 6166 shards landed under this dir, none in the source tree), so the whole artifact set stays out. ---
export function dbDirFor(root) {
  const base = env("VTS_DB_DIR", path.join(os.homedir(), ".vs-token-safer", "db"));
  const norm = path.resolve(root).replace(/\\/g, "/").toLowerCase();
  const slug = `${path.basename(norm) || "root"}-${crypto.createHash("sha1").update(norm).digest("hex").slice(0, 10)}`;
  return path.join(base, slug);
}
// Does a persisted clangd background index already exist for this root? clangd stores it at
// `<project>/.cache/clangd/index/*.idx` (in-tree — no flag relocates it). When it's there, clangd serves
// workspace/symbol from the loaded shards, so afterInit doesn't need to re-PARSE 100 TUs (the parse storm
// was the bulk of the cold-start latency vs a warm IDE like Rider) — a tiny nudge-open + shard load is
// enough. Returns true if any .idx shard is present under the root's (or the CDB dir's) clangd cache.
export function hasPersistedIndex(root) {
  for (const base of [root, resolveCdbDir(root)].filter(Boolean)) {
    const idxDir = path.join(base, ".cache", "clangd", "index");
    try { if (fs.readdirSync(idxDir).some((f) => /\.idx$/i.test(f))) return true; } catch { /* none */ }
  }
  return false;
}
// Where this root's compile DB actually lives: in-tree (shallow scan, the classic layout) wins, else the
// out-of-tree home. Returns the DIRECTORY containing compile_commands.json, or null.
export function resolveCdbDir(root) {
  const inTree = findShallow(root, /^compile_commands\.json$/);
  if (inTree) return path.dirname(inTree);
  const out = dbDirFor(root);
  try { if (fs.existsSync(path.join(out, "compile_commands.json"))) return out; } catch { /* ignore */ }
  return null;
}
// shallow scan for a file matching a predicate (1 level) — for .sln/.csproj/compile_commands in subdirs
function findShallow(root, re, depth = 2) {
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, d] = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isFile() && re.test(e.name)) return path.join(dir, e.name);
      if (e.isDirectory() && d < depth && !e.name.startsWith(".") && e.name !== "node_modules") stack.push([path.join(dir, e.name), d + 1]);
    }
  }
  return null;
}

// Build a backend def for a Node-based LSP shipped as an npm dep. Prefer the bundled bin (launched via
// `node <bin.js>` — no PATH lookup, no Windows `.cmd`/shell quoting, spaces-safe). Honor a VTS_*_CMD
// override; otherwise fall back to the global PATH binary (winShell on Windows for its `.cmd` shim).
function nodeLspBackend(binJs, cmdOverride, globalName, argsEnv, rest) {
  const extra = ["--stdio"];
  if (cmdOverride) return { cmd: cmdOverride, args: () => splitArgs(env(argsEnv)) || extra, winShell: true, ...rest };
  // Bundled bin: cmd is `node`, so the bin path MUST stay argv[0]. A VTS_*_ARGS override replaces only
  // the trailing flags (the user can't know the bundled bin path) — without this, `node <user-flags>`
  // would spawn bare node with no server script and hang.
  if (binJs) return { cmd: process.execPath, args: () => [binJs, ...(splitArgs(env(argsEnv)) || extra)], winShell: false, ...rest };
  return { cmd: globalName, args: () => splitArgs(env(argsEnv)) || extra, winShell: true, ...rest };
}
const TS_BIN = resolveBinJs("typescript-language-server", "typescript-language-server");
const PY_BIN = resolveBinJs("pyright", "pyright-langserver");

export const BACKENDS = {
  // C/C++ via clangd (LLVM). Needs compile_commands.json (Unreal: generate via UBT
  // `-mode=GenerateClangDatabase`, or CMake `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`). LIVE-TARGET.
  clangd: {
    cmd: env("VTS_CLANGD_CMD", "clangd"),
    args: (root) => {
      const ov = splitArgs(env("VTS_CLANGD_ARGS"));
      if (ov) return ov;
      const a = [
        // --compile-commands-dir only tells clangd where to FIND compile_commands.json (out-of-tree home
        // or in-tree); it does NOT relocate the index. clangd has no index-dir flag — it persists its
        // background index in `<project>/.cache/clangd` (in-tree), reused across spawns for warm speed.
        `--compile-commands-dir=${resolveCdbDir(root) || root}`,
        "--background-index",
        // Default priority is `background` = MINIMUM, idle-CPU-only — so a fresh index crawls (a big reason
        // the first query felt far slower than a warm IDE like Rider). We want it built NOW; `normal` lets
        // it use real CPU. Override with VTS_CLANGD_INDEX_PRIORITY (e.g. `background` to be a good citizen).
        `--background-index-priority=${env("VTS_CLANGD_INDEX_PRIORITY", "normal")}`,
        // More async workers → faster background indexing (default is conservative). Cap at the box's cores.
        `-j=${Math.max(2, parseInt(env("VTS_CLANGD_JOBS", String(Math.max(2, (os.cpus()?.length || 4) - 1))), 10) || 4)}`,
        "--header-insertion=never",
      ];
      // Prebuilt/remote index (zero per-dev warmup): point clangd at a shared clangd-index-server.
      const remote = env("VTS_CLANGD_REMOTE");
      if (remote) a.push(`--remote-index-address=${remote}`, `--project-root=${root}`);
      return a;
    },
    detect: (root) => !!resolveCdbDir(root) || exists(root, "*.uproject") || !!findShallow(root, /\.uproject$/, 1),
    // clangd indexes asynchronously after launch; a one-shot CLI query would race (and kill) it
    // before the index exists. Open the compile_commands TUs (+ nearby headers) so their symbols
    // enter clangd's dynamic index, then wait until at least one file is parsed (publishDiagnostics)
    // before the first query. Long-lived MCP use also benefits: the warm-up primes the index.
    afterInit: async (client, root) => {
      const cdbDir = resolveCdbDir(root);
      const cc = cdbDir ? path.join(cdbDir, "compile_commands.json") : null;
      let files = [];
      if (cc) {
        try { files = JSON.parse(fs.readFileSync(cc, "utf8")).map((e) => e.file).filter(Boolean); } catch { /* ignore */ }
      }
      const extra = findAllShallow(root, /\.(c|cc|cxx|cpp|h|hpp|hh|inl)$/i, 2);
      // When a persisted index already exists, clangd answers workspace/symbol from the loaded shards —
      // re-opening 100 TUs only triggers a costly re-parse (~seconds EACH on UE) for no symbol-search gain.
      // Open just a small nudge set so clangd starts loading; the full project is already in the index.
      // (A cold project with NO index still opens the full cap to force the first dynamic index.)
      const persisted = hasPersistedIndex(root);
      const cap = persisted ? Math.min(warmCap(root, "clangd", "VTS_CLANGD_OPEN_CAP", 100), envInt("VTS_CLANGD_WARM_CAP_PERSISTED", 8)) : warmCap(root, "clangd", "VTS_CLANGD_OPEN_CAP", 100);
      // Order the open-set by likely-query-first (query-history > git-recency > mtime), then cap — this
      // steers clangd's IndexBoostedFile priority so the warm window covers what the dev actually queries.
      const open = orderForWarm(root, [...new Set([...files, ...extra])], cap);
      for (const f of open) client.didOpen(f, "cpp");
      if (open.length) {
        const fullWait = envInt("VTS_LSP_INDEX_WAIT_MS", 120000);
        if (persisted) {
          // PERSISTED index: don't BLOCK on the full background re-validation ($/progress kind:end) — it
          // takes minutes (measured: 369s) while workspace/symbol can answer from the static shards far
          // sooner (51s). Instead return after a short floor and let the QUERY poll the loading index, so
          // it returns the INSTANT the sought symbol's shard is loaded (often well under the cap) — not at
          // a fixed deadline. `indexLoaded` flips when the background index finishes, so the poll knows an
          // empty result is then genuine (not "still loading"). Fire-and-forget; never blocks here.
          client.indexLoaded = false;
          const cap = envInt("VTS_CLANGD_PERSISTED_WAIT_MS", 60000);
          client.waitForNotification("$/progress", cap, (p) => p && p.value && p.value.kind === "end")
            .then(() => { client.indexLoaded = true; }, () => { client.indexLoaded = true; });
          await client.waitForNotification("textDocument/publishDiagnostics", envInt("VTS_CLANGD_PERSISTED_FLOOR_MS", 3000));
        } else {
          // COLD (no persisted index): the dynamic index must be BUILT before the first query can answer,
          // so block on completion, bounded by VTS_LSP_INDEX_WAIT_MS; fall back to a diagnostics check for
          // a server that emits no work-done progress (clangd always does).
          const indexed = await client.waitForNotification("$/progress", fullWait, (p) => p && p.value && p.value.kind === "end");
          if (!indexed) await client.waitForNotification("textDocument/publishDiagnostics", Math.min(fullWait, 30000));
        }
      }
    },
  },
  // C#/.NET via a Roslyn-based LSP. Preferred engine: Microsoft.CodeAnalysis.LanguageServer (the exact
  // Roslyn LSP Visual Studio / the C# Dev Kit use), auto-detected from the VS Code C# extension bundle.
  // Fallback: `csharp-ls` (dotnet tool). Override either via VTS_ROSLYN_CMD/ARGS (or VTS_ROSLYN_DLL).
  // The MS engine takes no `--solution` CLI arg — the solution/project is opened after `initialize`
  // via the `afterInit` hook (a `solution/open` / `project/open` notification), then we wait for
  // `workspace/projectInitializationComplete` before the first query.
  roslyn: {
    cmd: env("VTS_ROSLYN_CMD", ROSLYN_MS_DLL ? ROSLYN_DOTNET : "csharp-ls"),
    args: (root) => {
      const ov = splitArgs(env("VTS_ROSLYN_ARGS"));
      if (ov) return ov;
      if (ROSLYN_MS_DLL) return [ROSLYN_MS_DLL, "--stdio", "--logLevel", "Warning", "--extensionLogDirectory", os.tmpdir()];
      const sln = findShallow(root, /\.sln$/) || findShallow(root, /\.csproj$/);
      return sln ? ["--solution", sln] : [];
    },
    detect: (root) => !!findShallow(root, /\.sln$/) || !!findShallow(root, /\.csproj$/),
    // MS-engine only: open the workspace, then block until Roslyn finishes loading projects.
    afterInit: ROSLYN_MS_DLL && !env("VTS_ROSLYN_ARGS")
      ? async (client, root) => {
          const sln = findShallow(root, /\.sln$/);
          if (sln) client.notify("solution/open", { solution: toUri(sln) });
          else {
            const csprojs = findAllShallow(root, /\.csproj$/);
            if (csprojs.length) client.notify("project/open", { projects: csprojs.map(toUri) });
          }
          await client.waitForNotification("workspace/projectInitializationComplete", 180000);
        }
      : null,
  },
  // JS/TS via typescript-language-server (wraps the official tsserver). Shipped as an npm dep in
  // server/package.json → auto-installed for every user (no manual `npm i -g`); we resolve its bundled
  // bin and launch `node <cli.mjs> --stdio`. Override via VTS_TS_CMD/ARGS; without the bundled copy it
  // falls back to a PATH `typescript-language-server` (winShell on Windows for the `.cmd` shim). tsserver
  // indexes lazily per open document, so the warm-up opens the top-N likely-query files; workspace/symbol
  // still answers across the project.
  typescript: nodeLspBackend(TS_BIN, env("VTS_TS_CMD"), "typescript-language-server", "VTS_TS_ARGS", {
    detect: (root) => exists(root, "tsconfig.json", "jsconfig.json", "package.json") || !!findShallow(root, /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, 1),
    afterInit: async (client, root) => {
      const files = findAllShallow(root, /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i, 3);
      const open = orderForWarm(root, files, warmCap(root, "typescript", "VTS_TS_OPEN_CAP", 60));
      for (const f of open) client.didOpen(f, langIdForPath(f, "typescript"));
    },
  }),
  // Python via pyright-langserver (Microsoft's type checker / LSP). Same model: npm dep → auto-installed,
  // launched as `node <langserver.index.js> --stdio`; override via VTS_PY_CMD/ARGS. Pyright analyzes on
  // open + walks imports; warm-up opens the top-N likely-query files; workspace/symbol answers project-wide.
  pyright: nodeLspBackend(PY_BIN, env("VTS_PY_CMD"), "pyright-langserver", "VTS_PY_ARGS", {
    detect: (root) => exists(root, "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile") || !!findShallow(root, /\.py$/, 1),
    afterInit: async (client, root) => {
      const files = findAllShallow(root, /\.pyi?$/i, 3);
      const open = orderForWarm(root, files, warmCap(root, "pyright", "VTS_PY_OPEN_CAP", 60));
      for (const f of open) client.didOpen(f, "python");
    },
  }),
};

// Auto-pick a backend from what's in the project root. Order = strongest signal first: a C++ compile
// database / uproject (clangd) and a .sln/.csproj (roslyn) are unambiguous build artifacts, so they win
// over the weaker JS/Python markers (a package.json or stray *.py shows up in many repos). Disambiguate
// explicitly with VTS_BACKEND / backend=… when a root carries more than one.
export function pickBackend(root) {
  for (const name of ["clangd", "roslyn", "typescript", "pyright"]) {
    try { if (BACKENDS[name].detect(root)) return name; } catch { /* ignore */ }
  }
  return "";
}

// Walk UP from a file (or dir) to the nearest enclosing project root — the directory holding a build /
// project marker. This lets a per-call `path` argument pin the CORRECT repo even on a globally-installed
// server: a deep UE `.cpp` resolves to its own `.uproject`/compile_commands root, not whatever single
// projectPath the config happens to be pinned to. Any one marker wins; the NEAREST dir going up is the
// root (so a nested sub-package or submodule resolves to itself, and we never cross a repo boundary by
// climbing past a `.git`). Returns the absolute root dir, or null if nothing is found before the FS root.
const ROOT_FILE_MARKERS = [
  "compile_commands.json", "tsconfig.json", "jsconfig.json", "package.json",
  "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile",
];
const ROOT_GLOB_MARKERS = [/\.uproject$/i, /\.sln$/i, /\.csproj$/i];
export function findProjectRoot(startPath) {
  if (!startPath) return null;
  let dir;
  try { dir = fs.statSync(startPath).isDirectory() ? startPath : path.dirname(startPath); }
  catch { dir = path.dirname(startPath); } // nonexistent path → still climb its parent chain
  dir = path.resolve(dir);
  for (let i = 0; i < 64; i++) { // bounded walk — can't loop past the FS root
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { ents = null; }
    if (ents) {
      const files = ents.filter((e) => e.isFile()).map((e) => e.name);
      const fileSet = new Set(files);
      if (ROOT_FILE_MARKERS.some((m) => fileSet.has(m))) return dir;
      if (files.some((n) => ROOT_GLOB_MARKERS.some((re) => re.test(n)))) return dir;
      if (ents.some((e) => e.name === ".git")) return dir; // weakest marker, but a repo boundary — stop here
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
