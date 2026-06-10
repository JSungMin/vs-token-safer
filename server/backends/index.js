// Backend registry: how to spawn each OFFICIAL language server. We run the trusted engine (clangd from
// LLVM, a Roslyn-based C# LSP) locally and only translate LSP↔MCP in our own thin glue — no third-party
// MCP server runs over your source.
//
// Each backend is { cmd, args(root), detect(root) }. cmd/args are overridable via config/env
// (VTS_<NAME>_CMD / VTS_<NAME>_ARGS) so users can point at their own clangd / csharp-ls / MS C# LSP.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toUri, envInt } from "../lsp.js";

const env = (name, def) => { const v = process.env[name]; return v && v !== "" ? v : def; };
const splitArgs = (s) => (s ? s.split(/\s+/).filter(Boolean) : null);

// Collect every file (up to `depth`) whose name matches `re` — used to open all .csproj for Roslyn.
function findAllShallow(root, re, depth = 2) {
  const out = [];
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, d] = stack.pop();
    let ents = [];
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
  let dirs = [];
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
  let dirs = [];
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
// shallow scan for a file matching a predicate (1 level) — for .sln/.csproj/compile_commands in subdirs
function findShallow(root, re, depth = 2) {
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, d] = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isFile() && re.test(e.name)) return path.join(dir, e.name);
      if (e.isDirectory() && d < depth && !e.name.startsWith(".") && e.name !== "node_modules") stack.push([path.join(dir, e.name), d + 1]);
    }
  }
  return null;
}

export const BACKENDS = {
  // C/C++ via clangd (LLVM). Needs compile_commands.json (Unreal: generate via UBT
  // `-mode=GenerateClangDatabase`, or CMake `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`). LIVE-TARGET.
  clangd: {
    cmd: env("VTS_CLANGD_CMD", "clangd"),
    args: (root) => splitArgs(env("VTS_CLANGD_ARGS")) || [
      `--compile-commands-dir=${path.dirname(findShallow(root, /^compile_commands\.json$/) || path.join(root, "x"))}`,
      "--background-index",
      "--header-insertion=never",
    ],
    detect: (root) => !!findShallow(root, /^compile_commands\.json$/) || exists(root, "*.uproject") || !!findShallow(root, /\.uproject$/, 1),
    // clangd indexes asynchronously after launch; a one-shot CLI query would race (and kill) it
    // before the index exists. Open the compile_commands TUs (+ nearby headers) so their symbols
    // enter clangd's dynamic index, then wait until at least one file is parsed (publishDiagnostics)
    // before the first query. Long-lived MCP use also benefits: the warm-up primes the index.
    afterInit: async (client, root) => {
      const cc = findShallow(root, /^compile_commands\.json$/);
      let files = [];
      if (cc) {
        try { files = JSON.parse(fs.readFileSync(cc, "utf8")).map((e) => e.file).filter(Boolean); } catch { /* ignore */ }
      }
      const extra = findAllShallow(root, /\.(c|cc|cxx|cpp|h|hpp|hh|inl)$/i, 2);
      const open = [...new Set([...files, ...extra])].slice(0, envInt("VTS_CLANGD_OPEN_CAP", 100)); // cap for huge trees
      for (const f of open) client.didOpen(f, "cpp");
      if (open.length) {
        // On a huge tree (e.g. a cold UE-scale index) the dynamic index isn't ready when the first
        // file's diagnostics fire, so waiting on diagnostics alone races the still-building index and
        // the first query times out. Prefer clangd's background-index completion ($/progress kind:end),
        // bounded by VTS_LSP_INDEX_WAIT_MS; fall back to diagnostics if the server emits no work-done
        // progress (older clangd / a server without that capability).
        const idxWait = envInt("VTS_LSP_INDEX_WAIT_MS", 120000);
        const indexed = await client.waitForNotification("$/progress", idxWait, (p) => p && p.value && p.value.kind === "end");
        // Fallback only for a server that emits no work-done progress (clangd always does). idxWait was
        // already spent above, so this is a short "did the first file parse?" check, not a second full wait.
        if (!indexed) await client.waitForNotification("textDocument/publishDiagnostics", Math.min(idxWait, 30000));
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
};

// Auto-pick a backend from what's in the project root (C++ compile-db/uproject → clangd; .sln/.csproj → roslyn).
export function pickBackend(root) {
  for (const name of ["clangd", "roslyn"]) {
    try { if (BACKENDS[name].detect(root)) return name; } catch { /* ignore */ }
  }
  return "";
}
