#!/usr/bin/env node
/*
 * vs-token-safer — PreToolUse hook (matchers: Bash, Grep)
 *
 * Steers code search toward the language-server index (vs-search MCP) instead of text search, and steers
 * LOG analysis toward gamedev-log. Three vectors:
 *   - Bash: grep/rg/ack/ag/findstr/`git grep` (or `find -name`) over C/C++/C#/JS/TS/Py source → first
 *     REWRITTEN to the equivalent vts CLI (token-capped) via updatedInput when the command is a single
 *     safe segment; otherwise BLOCKED (exit 2). VTS_REWRITE=0 → block instead of rewrite; VTS_ENFORCE=0
 *     disables both; per-command opt-out via excludeCommands (config) / VTS_EXCLUDE_COMMANDS. Raw non-code
 *     text (md, json, config) passes.
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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Quote-aware command splitting, shared with vts discover so enforcement and measurement agree. A pipe
// inside quotes is part of a grep pattern — `grep "FooA|FooB" src/x.cpp` used to split into two
// non-matching segments and sail through the hook entirely (the top bypass `vts discover` surfaced).
import { splitSegments } from "../server/shell-split.js";

const CONFIG_FILE = process.env.VTS_CONFIG_FILE || path.join(os.homedir(), ".vs-token-safer", "config.json");
const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {}; } catch { return {}; } };
const notSetUp = () => { try { return !fs.existsSync(CONFIG_FILE); } catch { return false; } };
const SETUP_LINE = "\nNot set up yet? Run /vs-token-safer:setup (or `vts setup --projectPath <root>`) to configure the project root + backend.";

// #5 excludeCommands — finer than the global VTS_ENFORCE=0 kill switch: a code-grep whose executable is in
// this list is left alone (no block, no rewrite). Sources: config.json `excludeCommands` (array) +
// VTS_EXCLUDE_COMMANDS (csv). Keyed by the bare executable name (grep/rg/find/findstr/git).
function excludedCommands() {
  const set = new Set();
  const cfg = readConfig();
  const list = Array.isArray(cfg.excludeCommands) ? cfg.excludeCommands : String(cfg.excludeCommands || "").split(",");
  for (const c of list.concat(String(process.env.VTS_EXCLUDE_COMMANDS || "").split(","))) { const t = String(c).trim().toLowerCase(); if (t) set.add(t); }
  return set;
}

// #1 rewrite — the project root vts should search when we transparently reroute a grep → vts CLI.
const rewriteRoot = () => process.env.VTS_PROJECT_PATH || readConfig().projectPath || process.cwd();
// Absolute path to the bundled CLI (../server/cli.js relative to this hook) — `vts` may not be on PATH, so
// the rewrite runs it via `node "<cli.js>"`, which is always available.
const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "cli.js");
const rewriteOff = () => /^(0|false|off|no)$/i.test(String(process.env.VTS_REWRITE ?? "1"));

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

// `git grep` is inherently a repo CODE search (it scans tracked source by default), so it warrants the
// same steer even with no explicit code path/ext — unlike a bare `grep` over the cwd.
function isGitGrepSegment(segment) {
  return execOf(segment) === "git" && /(^|\s)git\s+grep(\s|$)/i.test(segment);
}

function isSearchSegment(segment) {
  const exec = execOf(segment);
  return SEARCH_EXECS.has(exec) || (exec === "find" && /\s-name(\s|$)/.test(segment.toLowerCase())) || isGitGrepSegment(segment);
}

function isCodeSearchSegment(segment) {
  if (!isSearchSegment(segment)) return false;
  const s = segment.toLowerCase();
  const textTarget =
    TEXT_TARGET_RE.test(s) ||
    /(^|[\s"'/\\])(logs?|build|intermediate|saved|node_modules|\.git)[\\/]/.test(s);
  // git grep defaults to searching tracked code → block unless it explicitly targets a text/log path.
  if (isGitGrepSegment(segment)) return !textTarget;
  const codeExt = CODE_EXT_RE.test(s);
  const codeDir = CODE_DIR_RE.test(s);
  return (codeExt || codeDir) && !textTarget;
}

// The executable key used for excludeCommands matching (git grep → "git").
const excludeKeyOf = (segment) => execOf(segment);

// #1 Build a vts CLI rewrite for a SINGLE code-search segment, or null if anything is ambiguous (caller
// then falls back to blocking — never a wrong rewrite). Conservative on purpose: only the common shape
// `<grep> [bool-flags] PATTERN [paths]` / `find … -name GLOB`, and only a shell-safe literal pattern.
const VALUE_FLAG_LETTERS = /[efmABCDd]/; // short flags that consume a value (-e PATTERN, -m N, -A N …)
// A pattern token may arrive quoted (`"FooA|FooB"`, `'^#include'`) — strip ONE matching outer pair so the
// safety gate sees the actual pattern. A token with an unmatched quote stays as-is (and fails the gate).
function stripQuotes(t) {
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) return t.slice(1, -1);
  return t;
}
function extractGrepPattern(segment, isGit) {
  const toks = segment.trim().split(/\s+/);
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++; // FOO=bar prefixes
  i++; // the executable (grep/rg/ack/ag/git)
  if (isGit) { if (toks[i] !== "grep") return null; i++; } // `git grep …`
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (t === "--") return null;                 // explicit option terminator — bail (pathspec ambiguity)
    if (t.startsWith("--")) return null;          // unknown long option — bail (may consume a value)
    if (t.startsWith("-")) {
      if (VALUE_FLAG_LETTERS.test(t)) return null; // value-taking short flag — pattern position unclear
      continue;                                    // boolean short flag cluster (-rn, -i, …)
    }
    return stripQuotes(t);                          // first bare token = PATTERN (grep puts it before files)
  }
  return null;
}
function extractFindName(segment) {
  const m = segment.match(/\s-name\s+("([^"]+)"|'([^']+)'|(\S+))/);
  return m ? (m[2] || m[3] || m[4] || "") : null;
}
// Shell-safe pattern: alnum/_/./:/- plus the regex chars `|` `^` `#` (alternations like `FooA|FooB` and
// anchors like `^#include` are the most-bypassed real queries, and search_text takes a regex). The rewrite
// always double-quotes the -q arg, and these chars are literal inside double quotes in bash AND cmd.exe.
// `$` stays excluded (variable expansion in double quotes), as do spaces/quotes/backslashes/backticks.
const SAFE_TEXT = /^[A-Za-z0-9_.:|^#-]+$/;
const SAFE_GLOB = /^[A-Za-z0-9_.*?-]+$/;    // filename glob
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;   // a bare identifier → route to semantic search_symbol (synergy A)
const quote = (s) => `"${s}"`;
// A grep PATTERN → vts command. A bare identifier goes to `vts symbol` (semantic — search_symbol now
// degrades to literal text when no backend resolves, so this is always safe); a dotted/scoped literal goes
// to `vts text`. The rewrite thus delivers the BEST engine for the query, not just a grep-equivalent.
function rewriteForPattern(root, pat) {
  if (IDENT.test(pat)) return { cmd: `node ${quote(CLI_PATH)} symbol --q ${quote(pat)} --projectPath ${quote(root)}`, tool: "search_symbol", q: pat };
  if (SAFE_TEXT.test(pat)) return { cmd: `node ${quote(CLI_PATH)} text --q ${quote(pat)} --projectPath ${quote(root)}`, tool: "search_text", q: pat };
  return null;
}
function buildRewrite(segment) {
  const exec = execOf(segment);
  const root = rewriteRoot();
  if (/["\r\n]/.test(root)) return null; // a root with a quote/newline would break shell quoting → block instead
  if (exec === "find") {
    const glob = extractFindName(segment);
    if (!glob || !SAFE_GLOB.test(glob)) return null;
    return { cmd: `node ${quote(CLI_PATH)} files --q ${quote(glob)} --projectPath ${quote(root)}`, tool: "find_files", q: glob };
  }
  const isGit = exec === "git";
  if (!isGit && !SEARCH_EXECS.has(exec)) return null;
  if (exec === "findstr") {
    // findstr flags start with `/`; pattern is the first token that isn't a `/flag`.
    const toks = segment.trim().split(/\s+/).slice(1);
    const pat = toks.find((t) => !t.startsWith("/"));
    return pat ? rewriteForPattern(root, pat) : null;
  }
  const pat = extractGrepPattern(segment, isGit);
  return pat ? rewriteForPattern(root, pat) : null;
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

// The Grep tool can't be rewritten to an MCP tool (a PreToolUse hook may only modify the SAME tool's
// input), so the next best thing is a READY-TO-USE equivalent call in the nudge — a model handed the
// exact tool + args complies far more often than one handed a generic pointer. Identifier → semantic
// search_symbol; anything else → search_text (it takes a regex, so alternations/anchors work).
function grepNudgeFor(ti) {
  const pat = String(ti.pattern || "");
  let concrete = "";
  if (pat && pat.length <= 120 && !/[\r\n"]/.test(pat)) {
    const tool = /^[A-Za-z_][A-Za-z0-9_]*$/.test(pat) ? "search_symbol" : "search_text";
    concrete = ` Equivalent token-capped call: ${tool} q="${pat}"${tool === "search_symbol" ? " (semantic decls; search_text for every textual hit)" : ""}.`;
  }
  return (
    "[vs-token-safer] Code search via the Grep tool. For symbol / references / definition on ESTABLISHED " +
    "code, prefer the vs-search MCP tools (search_symbol / find_references / goto_definition) — semantic " +
    "(language-server index) and token-capped to file:line — or search_text / find_files, or the " +
    "code-locator subagent." + concrete + " For a JUST-edited / unindexed file or a quick literal peek, " +
    "Grep is fine — carry on. Disable: VTS_ENFORCE=0."
  );
}
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

  // First-use setup nudge: if the plugin was never configured, append a pointer to setup on whatever
  // message we emit (the user is already mid-grep, exactly when configuring helps).
  const setup = notSetUp() ? SETUP_LINE : "";

  // Grep TOOL — warn-only, never block (Grep is the sanctioned fallback).
  if (toolName === "Grep") {
    if (isLogGrepTool(ti)) emitWarn(LOG_NUDGE + setup);
    else if (isCodeGrepTool(ti)) emitWarn(grepNudgeFor(ti) + setup);
    process.exit(0);
  }

  // Bash — code-grep is rewritten to the vts CLI (token-capped) when safe, else blocked (vts default); a
  // log-targeted search is steered (warn) but allowed.
  const cmd = ti.command || "";
  if (!cmd) process.exit(0);
  const segments = splitSegments(cmd);

  // #5 honor excludeCommands — drop excluded execs from enforcement.
  const excluded = excludedCommands();
  const codeSegs = segments.filter((s) => isCodeSearchSegment(s) && !excluded.has(excludeKeyOf(s)));

  if (codeSegs.length) {
    // #1 transparent rewrite: a whole command that is exactly one code-search segment, where we can build
    // a safe vts equivalent, is rerouted via updatedInput — the model's flow is unbroken AND the output is
    // guaranteed token-capped. Anything ambiguous (pipelines, complex patterns) falls back to the block.
    if (!rewriteOff() && segments.length === 1 && codeSegs.length === 1) {
      const rw = buildRewrite(codeSegs[0]);
      if (rw) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            permissionDecisionReason: `Rerouted code search → vts ${rw.tool} (language-server-grade, token-capped to file:line).`,
            updatedInput: { ...ti, command: rw.cmd },
            additionalContext:
              `[vs-token-safer] Rewrote your search → \`vts ${rw.tool}\` (q="${rw.q}"), token-capped to file:line. ` +
              `For SYMBOLS (class/function/type) prefer the vs-search MCP search_symbol — semantic, not text. ` +
              `Disable rewrite: VTS_REWRITE=0 (then it blocks instead). Disable entirely: VTS_ENFORCE=0.`,
          },
        }) + "\n");
        process.exit(0);
      }
    }
    process.stderr.write(BLOCK_MSG + setup + "\n");
    process.exit(2); // block
  }
  if (segments.some(isLogSearchSegment)) {
    emitWarn(LOG_NUDGE + setup);
    process.exit(0); // logs were never blocked — just point at the right tool
  }
  process.exit(0);
});
