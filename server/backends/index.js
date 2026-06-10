// Backend registry: how to spawn each OFFICIAL language server. We run the trusted engine (clangd from
// LLVM, a Roslyn-based C# LSP) locally and only translate LSP↔MCP in our own thin glue — no third-party
// MCP server runs over your source.
//
// Each backend is { cmd, args(root), detect(root) }. cmd/args are overridable via config/env
// (VTS_<NAME>_CMD / VTS_<NAME>_ARGS) so users can point at their own clangd / csharp-ls / MS C# LSP.
import fs from "node:fs";
import path from "node:path";

const env = (name, def) => { const v = process.env[name]; return v && v !== "" ? v : def; };
const splitArgs = (s) => (s ? s.split(/\s+/).filter(Boolean) : null);

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
  },
  // C#/.NET via a Roslyn-based LSP. Default targets `csharp-ls` (dotnet tool, Roslyn) over stdio; point
  // VTS_ROSLYN_CMD/ARGS at Microsoft.CodeAnalysis.LanguageServer if you prefer the exact VS engine.
  // BEST-EFFORT — not yet live-verified against a real .sln in CI.
  roslyn: {
    cmd: env("VTS_ROSLYN_CMD", "csharp-ls"),
    args: (root) => {
      const sln = findShallow(root, /\.sln$/) || findShallow(root, /\.csproj$/);
      return splitArgs(env("VTS_ROSLYN_ARGS")) || (sln ? ["--solution", sln] : []);
    },
    detect: (root) => !!findShallow(root, /\.sln$/) || !!findShallow(root, /\.csproj$/),
  },
};

// Auto-pick a backend from what's in the project root (C++ compile-db/uproject → clangd; .sln/.csproj → roslyn).
export function pickBackend(root) {
  for (const name of ["clangd", "roslyn"]) {
    try { if (BACKENDS[name].detect(root)) return name; } catch { /* ignore */ }
  }
  return "";
}
