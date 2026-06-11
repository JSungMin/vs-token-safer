#!/usr/bin/env node
/*
 * vs-token-safer — PreToolUse hook
 * Blocks Bash code-symbol searches (grep/rg/ack/ag/findstr, or `find -name`, over source
 * files) and tells Claude to use the vs-search MCP tools (or the `vts` CLI) instead. Raw text
 * searches (logs, md, json, config) pass through.
 *
 * It only triggers when a search tool is the ACTUAL executable of a command segment — so
 * `node setup.mjs ...`, `cd ".../plugins/..."`, etc. are never blocked just because a path
 * or argument happens to contain "rg", "plugins", "source", and the like.
 *
 * Protocol: exit 0 = allow; exit 2 + stderr = block, stderr shown to the model.
 */

const SEARCH_EXECS = new Set(["grep", "rg", "ack", "ag", "findstr"]);

function execOf(segment) {
  const tokens = segment.trim().split(/\s+/);
  let i = 0;
  // skip leading env-var assignments: FOO=bar grep ...
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  let exec = (tokens[i] || "").toLowerCase();
  // strip any path prefix and a Windows extension → basename
  exec = exec.replace(/^.*[\\/]/, "").replace(/\.(exe|bat|cmd|ps1)$/, "");
  return exec;
}

function isCodeSearchSegment(segment) {
  const exec = execOf(segment);
  const s = segment.toLowerCase();
  const isSearch = SEARCH_EXECS.has(exec) || (exec === "find" && /\s-name(\s|$)/.test(s));
  if (!isSearch) return false;

  const codeExt = /\.(c|cc|cxx|cpp|h|hpp|hh|inl|ipp|tpp|cs|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi)\b/.test(s);
  const codeDir = /(^|[\s"'/\\])(src|source|sources|engine|plugins)[\\/]/.test(s);
  const textTarget =
    /\.(log|txt|md|markdown|json|ya?ml|csv|tsv|xml|html?|ini|cfg|conf|toml|lock)\b/.test(s) ||
    /(^|[\s"'/\\])(logs?|build|intermediate|saved|node_modules|\.git)[\\/]/.test(s);

  return (codeExt || codeDir) && !textTarget;
}

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let cmd = "";
  try {
    cmd = ((JSON.parse(input).tool_input) || {}).command || "";
  } catch {
    process.exit(0); // unparseable — don't block
  }
  if (!cmd) process.exit(0);

  // Escape hatch: if the language server is unavailable (no compile_commands.json / no .sln),
  // blocking grep would leave Claude with no way to search code. Set VTS_ENFORCE=0 (or false/off).
  const enforce = String(process.env.VTS_ENFORCE ?? "1").toLowerCase();
  if (enforce === "0" || enforce === "false" || enforce === "off") process.exit(0);

  // Evaluate each shell segment independently; only an actual search-tool invocation counts.
  const segments = cmd.split(/\|\||&&|[|;&\n]/g);
  const blocked = segments.some((seg) => seg.trim() && isCodeSearchSegment(seg));
  if (!blocked) process.exit(0);

  process.stderr.write(
    "[vs-token-safer] Blocked a code-symbol search via Bash.\n" +
      "Use the vs-search MCP tools (server: 'vs-search') instead — they query the language\n" +
      "server's index (clangd for C++, Roslyn for C#, tsserver for JS/TS, pyright for Python)\n" +
      "and are token-capped to file:line:\n" +
      "  - symbol / class / function / type → search_symbol  (args: q, projectPath, backend, maxResults)\n" +
      "  - references / usages of a symbol  → find_references (args: path, line, character — 0-based)\n" +
      "  - definition of a symbol           → goto_definition (args: path, line, character — 0-based)\n" +
      "  - raw text / string / comment      → search_text     (args: q, projectPath) — token-capped grep\n" +
      "  - file by name                     → find_files      (args: q, projectPath) — glob or substring\n" +
      "Or delegate the whole lookup to the context-isolated `code-locator` subagent.\n" +
      "CLI alternative (no MCP): `vts symbol --q <name> --projectPath <root>` (also: vts text / files / hover).\n" +
      "Backend auto-detects from the root (compile_commands.json → clangd, .sln/.csproj → roslyn,\n" +
      "tsconfig/package.json → typescript, pyproject.toml/*.py → pyright);\n" +
      "override with backend=… or VTS_BACKEND, set the root via projectPath or VTS_PROJECT_PATH.\n" +
      "For logs/config text, target a non-code file, or set VTS_ENFORCE=0."
  );
  process.exit(2); // block
});
