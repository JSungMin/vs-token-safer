#!/usr/bin/env node
/*
 * vts — CLI front-end for vs-token-safer (no IDE, no MCP).
 * Forces code search through clangd (C++) / a Roslyn LSP (C#) and token-caps the result to a compact
 * file:line list. Same engine as the MCP server (both call runTool in core.js). Local-only.
 *
 * Usage:  vts <command> [--flag value | --flag=value | --bare]
 * Commands: symbol  references  definition  setup  config  savings  savings-reset
 *   vts symbol --q SpawnActor --projectPath /path/to/proj [--backend clangd|roslyn]
 *   vts references --path Src/Foo.cpp --line 41 --character 6
 *   vts definition --path Src/Foo.cpp --line 41 --character 6
 */
import { runTool, disposeClients } from "./core.js";

const HELP = `vts — local code search via clangd (C++) / Roslyn (C#), token-capped to file:line.

Usage: vts <command> [options]

Commands:
  symbol         Search symbol declarations by name/substring across the project.
                 [--q <name> --projectPath <dir> --backend clangd|roslyn --maxResults N]
  references     Find references of the symbol at a position (0-based line/character).
                 [--path <file> --line N --character N --includeDeclaration]
  definition     Go to the definition of the symbol at a position.
                 [--path <file> --line N --character N]
  warmup         Pre-build the index (IDE-style) so later searches are fast. [--projectPath --backend]
  setup          Persist config. [--projectPath --backend --maxResults]
  config         Show effective settings.
  savings        How many tokens you've saved vs forwarding raw index responses.
  savings-reset  Clear the savings ledger.

Backends (auto-detected from the root, or set --backend / VTS_BACKEND):
  clangd  — C/C++ (needs compile_commands.json; Unreal: UBT -mode=GenerateClangDatabase)
  roslyn  — C#/.NET (.sln/.csproj; default engine csharp-ls, override via VTS_ROSLYN_CMD)
Settings precedence: env (VTS_*) > ~/.vs-token-safer/config.json > default.`;

const LIST_FLAGS = new Set([]);
const BOOL_FLAGS = new Set(["includeDeclaration"]);

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    let tok = argv[i];
    if (!tok.startsWith("--")) continue;
    tok = tok.slice(2);
    let key, val;
    const eq = tok.indexOf("=");
    if (eq !== -1) { key = tok.slice(0, eq); val = tok.slice(eq + 1); }
    else { key = tok; if (BOOL_FLAGS.has(key)) { a[key] = true; continue; } val = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : ""; }
    a[key] = LIST_FLAGS.has(key) ? val.split(",").map((s) => s.trim()).filter(Boolean) : val;
  }
  return a;
}
const COMMANDS = { symbol: "search_symbol", references: "find_references", definition: "goto_definition", setup: "vts_setup", config: "vts_config", savings: "vts_savings", "savings-reset": "vts_savings_reset", warmup: "vts_warmup" };

const [, , rawCmd, ...rest] = process.argv;
if (!rawCmd || rawCmd === "-h" || rawCmd === "--help" || rawCmd === "help") { console.log(HELP); process.exit(rawCmd ? 0 : 1); }
const name = COMMANDS[rawCmd] || (rawCmd.startsWith("vts_") || rawCmd.includes("_") ? rawCmd : null);
if (!name) { console.error(`Unknown command: ${rawCmd}\n`); console.log(HELP); process.exit(2); }

const args = parseArgs(rest);
try {
  const { text, isError } = await runTool(name, args);
  (isError ? process.stderr : process.stdout).write(text + "\n");
  await disposeClients();
  process.exit(isError ? 1 : 0);
} catch (e) {
  process.stderr.write(`vts error: ${e.message}\n`);
  try { await disposeClients(); } catch { /* ignore */ }
  process.exit(1);
}
