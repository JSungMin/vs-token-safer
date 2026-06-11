#!/usr/bin/env node
/*
 * vs-token-safer — PreToolUse hook (matchers: Bash, Grep)
 *
 * Steers code search toward the language-server index (vs-search MCP) instead of text search, and steers
 * LOG analysis toward gamedev-log. Three vectors:
 *   - Bash: grep/rg/ack/ag/findstr (or `find -name`) over C/C++/C#/JS/TS/Py source → BLOCKED by default
 *     (exit 2); VTS_ENFORCE=0 disables. Raw non-code text (md, json, config) passes.
 *   - Grep TOOL (built-in): the model's reflexive code search lives here, not Bash — so a Bash-only hook
 *     never fired where the habit is. The Grep branch nudges too, but is **warn-ONLY, never block**: Grep
 *     is the sanctioned fallback (and the right call on a just-edited/unindexed file), so blocking it would
 *     strand the model.
 *   - LOG steer: a search aimed at a Logs/ dir or a .log/.jsonl file (Bash OR Grep) gets a warn-only
 *     pointer to gamedev-log — the language-server index doesn't cover logs, and they aren't blocked.
 *
 * The Bash branch only triggers when a search tool is the ACTUAL executable of a command segment — so
 * `node setup.mjs ...`, `cd ".../plugins/..."`, etc. are never flagged just because a path or argument
 * happens to contain "rg", "plugins", "source", and the like.
 *
 * Protocol: exit 0 = allow; exit 2 + stderr = block, stderr shown to the model. A warn is an exit-0 with a
 * hookSpecificOutput.additionalContext payload on stdout (stderr on exit 0 isn't reliably surfaced).
 */

const SEARCH_EXECS = new Set(["grep", "rg", "ack", "ag", "findstr"]);
// ripgrep --type aliases for the languages we index (the Grep tool's `type` param forwards to rg).
const CODE_TYPES = new Set(["c", "cpp", "csharp", "cs", "cxx", "cc", "cuda", "js", "ts", "typescript", "javascript", "jsx", "tsx", "py", "python"]);
const CODE_EXT_RE = /\.(c|cc|cxx|cpp|h|hpp|hh|inl|ipp|tpp|cs|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi)\b/;
const CODE_DIR_RE = /(^|[\s"'/\\])(src|source|sources|engine|plugins)[\\/]/;
const TEXT_TARGET_RE = /\.(log|txt|md|markdown|json|ya?ml|csv|tsv|xml|html?|ini|cfg|conf|toml|lock)\b/;
// A log-ish target: a Logs/ (or Saved/Logs/) dir, or a .log/.jsonl/.log.N file. Precise enough to skip
// "log" inside "catalog" and ordinary source paths.
// `logs([/\\]|$)` so a bare `Saved/Logs` dir (the common Grep `path` form, no trailing slash) still hits,
// while `(^|sep)` anchoring still rejects "catalog"/"dialogs"/"mylogs".
const LOG_TARGET_RE = /(^|[\s"'/\\])(saved[/\\])?logs([/\\]|$)|\.(log|jsonl)(\.\d+)?\b/i;

function execOf(segment) {
  const tokens = segment.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++; // skip FOO=bar prefixes
  let exec = (tokens[i] || "").toLowerCase();
  return exec.replace(/^.*[\\/]/, "").replace(/\.(exe|bat|cmd|ps1)$/, ""); // basename, strip win ext
}

function isSearchSegment(segment) {
  const exec = execOf(segment);
  return SEARCH_EXECS.has(exec) || (exec === "find" && /\s-name(\s|$)/.test(segment.toLowerCase()));
}

function isCodeSearchSegment(segment) {
  if (!isSearchSegment(segment)) return false;
  const s = segment.toLowerCase();
  const codeExt = CODE_EXT_RE.test(s);
  const codeDir = CODE_DIR_RE.test(s);
  const textTarget =
    TEXT_TARGET_RE.test(s) ||
    /(^|[\s"'/\\])(logs?|build|intermediate|saved|node_modules|\.git)[\\/]/.test(s);
  return (codeExt || codeDir) && !textTarget;
}

// A search segment whose target is a LOG (steer to gamedev-log; never blocked).
function isLogSearchSegment(segment) {
  return isSearchSegment(segment) && LOG_TARGET_RE.test(segment);
}

// Grep TOOL — nudge only on an EXPLICIT code signal (a code-ext glob, a code `type`, or a code path). A
// bare Grep over the cwd (no path/glob/type) is NOT nudged: can't confirm it targets code, and silence
// beats noise. An explicit non-code glob/path opts out.
function isCodeGrepTool(ti) {
  const glob = String(ti.glob || "").toLowerCase();
  const type = String(ti.type || "").toLowerCase();
  const p = String(ti.path || "").replace(/\\/g, "/").toLowerCase();
  if (glob && TEXT_TARGET_RE.test(glob)) return false;
  if (p && TEXT_TARGET_RE.test(p)) return false;
  const globIsCode = !!glob && CODE_EXT_RE.test(glob);
  const pathIsCode = (!!p && CODE_EXT_RE.test(p)) || CODE_DIR_RE.test(p);
  return globIsCode || CODE_TYPES.has(type) || pathIsCode;
}
function isLogGrepTool(ti) {
  const glob = String(ti.glob || "");
  const p = String(ti.path || "");
  return LOG_TARGET_RE.test(glob) || LOG_TARGET_RE.test(p);
}

function emitWarn(text) {
  // allow, but inject the nudge into the model's context (stderr on exit 0 isn't reliably surfaced).
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } }) + "\n"
  );
}

const GREP_NUDGE =
  "[vs-token-safer] Code search via the Grep tool. For symbol / references / definition on ESTABLISHED " +
  "code, prefer the vs-search MCP tools (search_symbol / find_references / goto_definition) — semantic " +
  "(language-server index) and token-capped to file:line — or search_text / find_files, or the " +
  "code-locator subagent. For a JUST-edited / unindexed file or a quick literal peek, Grep is fine — carry " +
  "on. Disable: VTS_ENFORCE=0.";
const LOG_NUDGE =
  "[vs-token-safer] This search targets a LOG. The language-server index only covers source code — for log " +
  "analysis use gamedev-log (/gamedev-log-analyzer:logs, or the gamedev-log CLI: summary / search / locate " +
  "/ fields / diff) instead of grep. Disable: VTS_ENFORCE=0.";

const BLOCK_MSG =
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
  "For logs/config text, target a non-code file (or use gamedev-log for logs), or set VTS_ENFORCE=0.";

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let j;
  try {
    j = JSON.parse(input);
  } catch {
    process.exit(0); // unparseable — don't block
  }
  const toolName = j.tool_name || "";
  const ti = j.tool_input || {};

  // Escape hatch: if the language server is unavailable, blocking grep would strand the model. Set
  // VTS_ENFORCE=0 (or false/off) to disable the block AND the nudges.
  const enforce = String(process.env.VTS_ENFORCE ?? "1").toLowerCase();
  if (enforce === "0" || enforce === "false" || enforce === "off") process.exit(0);

  // Grep TOOL — warn-only, never block (Grep is the sanctioned fallback).
  if (toolName === "Grep") {
    if (isLogGrepTool(ti)) emitWarn(LOG_NUDGE);
    else if (isCodeGrepTool(ti)) emitWarn(GREP_NUDGE);
    process.exit(0);
  }

  // Bash — code-grep is blocked (vts default); a log-targeted search is steered (warn) but allowed.
  const cmd = ti.command || "";
  if (!cmd) process.exit(0);
  const segments = cmd.split(/\|\||&&|[|;&\n]/g).filter((s) => s.trim());

  if (segments.some(isCodeSearchSegment)) {
    process.stderr.write(BLOCK_MSG + "\n");
    process.exit(2); // block
  }
  if (segments.some(isLogSearchSegment)) {
    emitWarn(LOG_NUDGE);
    process.exit(0); // logs were never blocked — just point at the right tool
  }
  process.exit(0);
});
