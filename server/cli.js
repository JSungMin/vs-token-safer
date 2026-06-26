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
                 position. --direction callers|callees switches to a MULTI-HOP call hierarchy (transitive
                 callers = blast radius / callees) to --depth N (default 2).
                 [--symbol <name> | --path <file> --line N --character N] [--includeDeclaration --direction --depth N]
  definition     Go to the definition of the symbol at a position.
                 [--path <file> --line N --character N]
  trace-calls    Alias for 'references --direction callers' (the multi-hop call hierarchy / blast radius).
                 [--symbol <name> | --path <file> --line N --character N] [--direction callers|callees --depth N]
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
  dce            Preview-only dead-code analysis. From seed symbol(s), walk the call graph to a fixpoint and
                 list DEAD / HELD / ENTRY / INCONCLUSIVE candidates + a safe deletion order. NEVER deletes —
                 each DEAD candidate still goes through safe-delete's own reference guard. clangd needs a WARM
                 (persisted) index — a cold/large tree under-reports callers, so it refuses unless warm; run
                 'vts preindex' first, or --build to build-and-wait now (slow). Thorough by default: each DEAD
                 candidate is reference-verified (full uses vs call sites) to catch non-call refs;
                 --thorough=false for the fast call-graph-only mode. --allowCold inspects cold (all INCONCLUSIVE).
                 --roots A,B (or a committable .vts-index/dce-roots.json) switches to REACHABILITY mode: liveness
                 is computed forward from those entry points (Go-deadcode/RTA style), so a missing caller can't
                 cause a false DEAD — only incomplete roots can (the reference verify catches that).
                 [--seed <name> | --seeds A,B,C --projectPath <dir> [--entry main,init --roots main,RunTests --maxNodes N --build --allowCold]]
  files          Find files by name (substring or glob). [--q <pattern> --projectPath <dir>]
  text           Raw text/regex search (token-capped). [--q <pattern> --projectPath <dir> --path <file> --glob <pat> --docs]
                 --path <file> / --glob <pat> target a file/glob and auto-include its extension (e.g. a .md);
                 --docs (no path/glob) widens the project sweep to README/docs/config text.
  git            Run a READ-ONLY git command and COMPACT its output (status/log/diff grouped+deduped+capped).
                 Pass-through: 'vts git status -s', 'vts git log --oneline', 'vts git diff [--projectPath DIR]'.
                 Mutating subcommands (commit/reset/checkout/push…) are refused — run git directly.
  p4             Run a READ-ONLY Perforce command and COMPACT its output (opened/status/changes/reconcile -n).
                 Pass-through: 'vts p4 opened', 'vts p4 changes -m 50'. reconcile is forced to preview (-n).
  index          Build the committable .vts-index/symbols.jsonl (tree-sitter; instant cold-start symbol tier,
                 no toolchain needed — commit it to share with the team). [--projectPath --status (show current)]
  concept        FUZZY search for a concept/intent you can't name exactly ("auth login flow"). Mines a concept
                 dictionary from the repo's OWN identifier+comment co-occurrence (no embeddings, nothing sent)
                 and ranks declarations; --flow also expands the top hit along the call graph.
                 [--q <phrase> --projectPath <dir> --flow --maxResults N]
  warmup         Pre-build the index (IDE-style) so later searches are fast. [--projectPath --backend]
  setup          Persist config. [--projectPath --backend --maxResults]
                 [--genCompileDb dry|apply] — also generate the C++ compile DB in this step (dry-run prints
                 the UBT command; apply runs it, needs clangd ≥ 22). Parks it out-of-tree.
                 [--clangdCmd <path>] — persist the clangd ≥ 22 binary path (VS-bundled 19.1.x deadlocks UE).
  serve          Start the local dashboard (127.0.0.1 only, nothing transmitted) — savings trend, language
                 mix, per-tool savings, and the include-graph fan-in as an interactive 3D force graph (Three.js,
                 vendored locally — no CDN). [--port N (default 8731) --projectPath <dir> --open (launch browser)]
                 Stop it with 'vts serve --stop' (or Ctrl-C). Easiest: the /vs-token-safer:viz / :viz-stop commands.
  config         Show effective settings.
  savings        How many tokens you've saved vs forwarding raw index responses.
                 [--graph (30-day ASCII) --daily --history]
  savings-reset  Clear the savings ledger.
  discover       Scan recent Claude transcripts for code searches that BYPASSED vts (missed savings).
                 The since-window filters individual entries by timestamp; --projectPath scopes the
                 count to that root (and bounds what --learn attributes to it).
                 [--since N (days, default 7) --all (all projects, all time)
                  --learn (feed the files those searches hit into the warm-set) --projectPath <dir>
                  --agents (also account agent SPAWNS — code-locator/Explore fleets, exact totalTokens)]
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

const LIST_FLAGS = new Set(["seeds", "entry", "roots"]);
const BOOL_FLAGS = new Set(["includeDeclaration", "apply", "graph", "daily", "history", "all", "learn", "inTree", "force", "signatureOnly", "stop", "open", "static", "docs", "status", "flow", "allowCold", "build", "thorough", "reachability", "detail", "agents"]);

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
const COMMANDS = { symbol: "search_symbol", references: "find_references", definition: "goto_definition", "trace-calls": "find_references", hover: "hover", symbols: "document_symbols", "read-symbol": "read_symbol", diagnostics: "diagnostics", rename: "rename", "replace-symbol": "replace_symbol_body", insert: "insert_symbol", "insert-after": "insert_symbol", "insert-before": "insert_symbol", "safe-delete": "safe_delete", dce: "vts_dce", files: "find_files", text: "search_text", git: "vts_git", p4: "vts_p4", setup: "vts_setup", config: "vts_config", savings: "vts_savings", "savings-reset": "vts_savings_reset", discover: "vts_discover", warmup: "vts_warmup", preindex: "vts_preindex", scope: "vts_scope", index: "vts_index", concept: "concept_search", "gen-compile-db": "vts_gen_compile_db" };

const [, , rawCmd, ...rest] = process.argv;
if (!rawCmd || rawCmd === "-h" || rawCmd === "--help" || rawCmd === "help") { console.log(HELP); process.exit(rawCmd ? 0 : 1); }

// `vts serve` — the local dashboard. Long-running (NOT a runTool dispatch): start the 127.0.0.1 server and
// stay alive until Ctrl-C. Special-cased here so it doesn't fall through to the one-shot runTool path below.
if (rawCmd === "serve") {
  const a = parseArgs(rest);
  const { startServer, writePid, clearPid, stopServer, openBrowser } = await import("./serve.js");
  // --stop: signal a running dashboard via its pidfile and exit (the /vs-token-safer:viz-stop command).
  if (a.stop === true || a.stop === "true") { process.stdout.write(stopServer() + "\n"); process.exit(0); }
  const root = a.projectPath || process.cwd();
  const port = parseInt(a.port, 10) || 8731;
  const open = a.open === true || a.open === "true";
  try {
    const { url } = await startServer(root, port);
    writePid({ port, url, root });
    process.stdout.write(`vs-token-safer dashboard → ${url}\n  root: ${root}\n  local-only (127.0.0.1), nothing transmitted. Ctrl-C (or \`vts serve --stop\`) to stop.\n`);
    if (open) openBrowser(url);
    const bye = () => { clearPid(); process.stdout.write("\nstopped.\n"); process.exit(0); };
    process.on("SIGINT", bye); process.on("SIGTERM", bye);
  } catch (e) {
    process.stderr.write(`vts serve failed: ${e.message}${/EADDRINUSE/.test(String(e.message)) ? ` — port ${port} busy, pass --port <n> (or \`vts serve --stop\` first).` : ""}\n`);
    process.exit(1);
  }
} else {
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
  // back-compat CLI aliases: `vts insert-after`/`insert-before` map to insert_symbol with the position set.
  if (rawCmd === "insert-before") args.position = "before";
  else if (rawCmd === "insert-after" && args.position == null) args.position = "after";
  // `vts trace-calls` is sugar for `references --direction callers` (the multi-hop call hierarchy).
  else if (rawCmd === "trace-calls" && args.direction == null) args.direction = "callers";
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
}
