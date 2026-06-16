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
  references     Find every call site / usage of a symbol. Pass --symbol <name> (resolved via the index,
                 no position needed — the tool to use when editing code); or a --path --line --character
                 position. [--symbol <name> | --path <file> --line N --character N] [--includeDeclaration]
  definition     Go to the definition of the symbol at a position.
                 [--path <file> --line N --character N]
  hover          Type/signature info at a position. [--path <file> --line N --character N]
  symbols        Outline a file (its classes/functions as file:line). [--path <file>]
  rename         Semantic rename across the project. Preview by default; --apply to write.
                 [--path <file> --line N --character N --newName <name> [--apply]]
  replace-symbol Replace a whole declaration by NAME (outline supplies the span). Preview; --apply to write.
                 [--symbol <name> --body <text> [--path <file> --line N --apply]]
  insert-after   Insert text on a new line after a named declaration. Preview; --apply to write.
                 [--symbol <name> --text <text> [--path <file> --line N --apply]]
  insert-before  Insert text on a line before a named declaration. Preview; --apply to write.
                 [--symbol <name> --text <text> [--path <file> --line N --apply]]
  safe-delete    Delete a named declaration; refuses while referenced unless --force. Preview; --apply.
                 [--symbol <name> [--path <file> --line N --force --apply]]
  files          Find files by name (substring or glob). [--q <pattern> --projectPath <dir>]
  text           Raw text/regex search (token-capped). [--q <pattern> --projectPath <dir> --path <file> --glob <pat> --docs]
                 --path <file> / --glob <pat> target a file/glob and auto-include its extension (e.g. a .md);
                 --docs (no path/glob) widens the project sweep to README/docs/config text.
  git            Run a READ-ONLY git command and COMPACT its output (status/log/diff grouped+deduped+capped).
                 Pass-through: 'vts git status -s', 'vts git log --oneline', 'vts git diff [--projectPath DIR]'.
                 Mutating subcommands (commit/reset/checkout/push…) are refused — run git directly.
  p4             Run a READ-ONLY Perforce command and COMPACT its output (opened/status/changes/reconcile -n).
                 Pass-through: 'vts p4 opened', 'vts p4 changes -m 50'. reconcile is forced to preview (-n).
  warmup         Pre-build the index (IDE-style) so later searches are fast. [--projectPath --backend]
  setup          Persist config. [--projectPath --backend --maxResults]
  config         Show effective settings.
  savings        How many tokens you've saved vs forwarding raw index responses.
                 [--graph (30-day ASCII) --daily --history]
  savings-reset  Clear the savings ledger.
  discover       Scan recent Claude transcripts for code searches that BYPASSED vts (missed savings).
                 The since-window filters individual entries by timestamp; --projectPath scopes the
                 count to that root (and bounds what --learn attributes to it).
                 [--since N (days, default 7) --all (all projects, all time)
                  --learn (feed the files those searches hit into the warm-set) --projectPath <dir>]
  gen-compile-db Generate compile_commands.json for an Unreal project via UBT (full clangd index).
                 Dry-run by default; --apply runs it. The DB + clangd's .cache/ land OUTSIDE the source
                 tree (~/.vs-token-safer/db/<project>; --inTree keeps the classic project-root layout).
                 [--projectPath --apply --inTree --engineRoot --target ...]

Backends (auto-detected from the root, or set --backend / VTS_BACKEND):
  clangd      — C/C++ (needs compile_commands.json; Unreal: UBT -mode=GenerateClangDatabase)
  roslyn      — C#/.NET (.sln/.csproj; default engine csharp-ls, override via VTS_ROSLYN_CMD)
  typescript  — JS/TS (tsconfig/jsconfig/package.json; bundled typescript-language-server)
  pyright     — Python (pyproject/setup.py/requirements or *.py; bundled pyright-langserver)
Settings precedence: env (VTS_*) > ~/.vs-token-safer/config.json > default.`;

const LIST_FLAGS = new Set([]);
const BOOL_FLAGS = new Set(["includeDeclaration", "apply", "graph", "daily", "history", "all", "learn", "inTree", "force"]);

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
const COMMANDS = { symbol: "search_symbol", references: "find_references", definition: "goto_definition", hover: "hover", symbols: "document_symbols", rename: "rename", "replace-symbol": "replace_symbol_body", "insert-after": "insert_after_symbol", "insert-before": "insert_before_symbol", "safe-delete": "safe_delete", files: "find_files", text: "search_text", git: "vts_git", p4: "vts_p4", setup: "vts_setup", config: "vts_config", savings: "vts_savings", "savings-reset": "vts_savings_reset", discover: "vts_discover", warmup: "vts_warmup", "gen-compile-db": "vts_gen_compile_db" };

const [, , rawCmd, ...rest] = process.argv;
if (!rawCmd || rawCmd === "-h" || rawCmd === "--help" || rawCmd === "help") { console.log(HELP); process.exit(rawCmd ? 0 : 1); }
const name = COMMANDS[rawCmd] || (rawCmd.startsWith("vts_") || rawCmd.includes("_") ? rawCmd : null);
if (!name) { console.error(`Unknown command: ${rawCmd}\n`); console.log(HELP); process.exit(2); }

// git/p4 are pass-throughs: the tail is the VCS subcommand + flags (NOT vts --flags), forwarded verbatim as
// argv. The TWO vts flags `--projectPath`/`--maxResults` are lifted out first (so `vts git status
// --projectPath X` targets X instead of handing git an unknown option); everything else goes to the command.
let args;
if (name === "vts_git" || name === "vts_p4") {
  const argv = []; const extra = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--projectPath") { extra.projectPath = rest[++i]; continue; }
    if (rest[i] === "--maxResults") { extra.maxResults = rest[++i]; continue; }
    argv.push(rest[i]);
  }
  args = { argv, ...extra };
} else {
  args = parseArgs(rest);
}
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
