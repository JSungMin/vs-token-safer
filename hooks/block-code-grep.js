#!/usr/bin/env node
/*
 * vs-token-safer — PreToolUse hook (matchers: Bash, Grep, Glob)
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
// UI language for the human-facing nudges/blocks: VTS_LANG > config `lang` > OS locale (Intl) > "en".
// A Korean user (ko-KR locale) gets Korean automatically; force with VTS_LANG=ko|en.
function uiLang() {
  const v = String(process.env.VTS_LANG || readConfig().lang || "").toLowerCase();
  if (v) return v.startsWith("ko") ? "ko" : "en";
  try { return /^ko/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? "ko" : "en"; } catch { return "en"; }
}
const KO = uiLang() === "ko";
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
// VCS output compaction (separate from code-search): a read-only git/p4 command whose raw output is verbose
// + repetitive is rerouted to the vts wrapper (runs it, then groups/dedups/caps). Never blocks — a git
// command must still run; on by default, VTS_COMPACT_VCS=0 disables. `git grep` is NOT here (it's a code
// search, handled by the grep path).
const GIT_COMPACT_SUBS = new Set(["status", "log", "diff"]);
const P4_COMPACT_SUBS = new Set(["opened", "status", "changes", "reconcile"]);
const compactVcsOn = () => !/^(0|false|off|no)$/i.test(String(process.env.VTS_COMPACT_VCS ?? "1"));
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
// `find [path] -name X` — the FIRST operand (before any `-predicate`) is the search directory. Honor it so
// the rewrite searches the tree the command names, not the configured root — dropping it made a
// `find /abs/UE/path -name X` rewrite search the vts repo and falsely report "No files" (live dogfood bug).
function extractFindDir(segment) {
  const t = segment.trim().split(/\s+/)[1]; // token after `find`
  if (!t || t.startsWith("-") || t.startsWith("(") || t.startsWith("!")) return null; // no path operand → cwd
  return stripQuotes(t);
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
    const dir = extractFindDir(segment); // honor `find <dir>` — else find_files searches the wrong tree (configured root)
    const searchRoot = dir && SAFE_PATH.test(dir) ? dir : root; // unsafe/absent dir → fall back to the configured root
    return { cmd: `node ${quote(CLI_PATH)} files --q ${quote(glob)} --projectPath ${quote(searchRoot)}`, tool: "find_files", q: glob };
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

// Build a vts wrapper rewrite for a SINGLE read-only git/p4 command (status/log/diff/opened/…), or null.
// Conservative: bail on ANY shell metachar (quote/backtick/$/redirect/backslash) and on a global flag
// before the subcommand (`git -C path status` — the -C is ambiguous to split safely). The vts wrapper runs
// the command and compacts its output; the model's flow is unbroken and the result is token-capped.
function buildVcsRewrite(segment) {
  if (/["'`$\\<>]/.test(segment)) return null; // any quoting/redirect → leave the original command alone
  const toks = segment.trim().split(/\s+/);
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++; // FOO=bar prefixes
  const exec = (toks[i] || "").replace(/^.*[\\/]/, "").replace(/\.(exe|bat|cmd|ps1)$/i, "").toLowerCase();
  if (exec !== "git" && exec !== "p4") return null;
  const sub = (toks[i + 1] || "").toLowerCase();
  if (!sub || sub.startsWith("-")) return null; // a global flag before the subcommand → too ambiguous
  const ok = exec === "git" ? GIT_COMPACT_SUBS.has(sub) : P4_COMPACT_SUBS.has(sub);
  if (!ok) return null;
  const rest = toks.slice(i + 1); // subcommand + its flags (passed verbatim as argv to the vts wrapper)
  if (!rest.every((t) => /^[A-Za-z0-9_.:=/-]+$/.test(t))) return null; // simple tokens only (no pathspec quoting)
  const argv = rest.map((t) => `"${t}"`).join(" ");
  return { bin: exec, tool: exec === "git" ? "vts_git" : "vts_p4", sub, cmd: `node "${CLI_PATH}" ${exec} ${argv}` };
}

// A docs/text grep WITH an explicit text-file target (`grep foo README.md`) → reroute to `vts text` scoped
// to that file (search_text path= auto-includes any extension; output token-capped). Targeted, so no
// broad-scan surprise — and a docs grep was never blocked, so this only ever rewrites, never blocks.
const SAFE_PATH = /^[A-Za-z0-9_.:/\\-]+$/;
function buildDocsGrepRewrite(segment) {
  const exec = execOf(segment);
  if (!SEARCH_EXECS.has(exec) || exec === "findstr") return null; // grep/rg/ack/ag (findstr flags differ)
  const pat = extractGrepPattern(segment, false);
  if (!pat || !SAFE_TEXT.test(pat)) return null;                  // only a shell-safe literal/regex pattern
  const toks = segment.trim().split(/\s+/);
  const fileTok = toks.find((t) => !t.startsWith("-") && t !== pat && TEXT_TARGET_RE.test(t) && SAFE_PATH.test(t));
  if (!fileTok) return null;                                      // no explicit text-file target → leave alone
  const root = rewriteRoot();
  if (/["\r\n]/.test(root)) return null;
  return { tool: "search_text", q: pat, file: fileTok, cmd: `node ${quote(CLI_PATH)} text --q ${quote(pat)} --path ${quote(fileTok)} --projectPath ${quote(root)}` };
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
    const ident = /^[A-Za-z_][A-Za-z0-9_]*$/.test(pat);
    if (KO) {
      concrete = ident
        ? ` 바로 쓸 수 있는 토큰캡 호출: find_references symbol="${pat}" (모든 사용처 — 수정할 때 필요한 것), 또는 search_symbol q="${pat}" (선언).`
        : ` 바로 쓸 수 있는 토큰캡 호출: search_text q="${pat}".`;
    } else {
      concrete = ident
        ? ` Equivalent token-capped calls: find_references symbol="${pat}" (every call site — what you want when editing it), or search_symbol q="${pat}" (its declaration).`
        : ` Equivalent token-capped call: search_text q="${pat}".`;
    }
  }
  return KO
    ? "[vs-token-safer] Grep 툴로 코드 검색 중이에요. 이미 존재하는 코드의 심볼/참조/정의는 vs-search MCP 도구" +
      "(search_symbol / find_references / goto_definition)를 권장합니다 — 시맨틱(언어 서버 인덱스)이고 file:line으로 " +
      "토큰캡됩니다 — 또는 search_text / find_files, code-locator 서브에이전트도 좋아요." + concrete +
      " 방금 수정했거나 미인덱스 파일, 빠른 텍스트 확인이면 Grep 그대로 OK. 끄기: VTS_ENFORCE=0."
    : "[vs-token-safer] Code search via the Grep tool. For symbol / references / definition on ESTABLISHED " +
      "code, prefer the vs-search MCP tools (search_symbol / find_references / goto_definition) — semantic " +
      "(language-server index) and token-capped to file:line — or search_text / find_files, or the " +
      "code-locator subagent." + concrete + " For a JUST-edited / unindexed file or a quick literal peek, " +
      "Grep is fine — carry on. Disable: VTS_ENFORCE=0.";
}
// enforcement v2 (A+) + v2.1: a Grep-TOOL pattern HUNTING A NAMED SYMBOL is escalated from warn to BLOCK —
// a semantic tool is strictly better (smaller, exact, no regex false positives — `void.*Foo\(` also matches
// `SetActiveFoo`), and the reroute is search_text/search_symbol (same regex, token-capped → no wrong/missing
// results, just friction). A symbol hunt that we BLOCK = (1) a bare identifier; (2) a regex with a ≥4-char
// identifier AND a code-structural cue (`::`, a literal `(`, a C++/decl keyword); or (3) v2.1 — an ALTERNATION
// (`A|B|C`) carrying a CamelCase or snake_case identifier (`MaxWalkSpeed|MaxExcessSpeed`, `get_value|set_value`).
// (3) is the top measured bypass (UE type/symbol enumeration). KEPT as warn (false-positive-safe): freeform
// single-token text, AND keyword alternations — `TODO|FIXME` / `ERROR|WARN` / `GET|POST` are ALL-CAPS with no
// lower→upper transition, so they carry no CamelCase/snake signal and never match (3). A `TODO|FIXME` doesn't
// block; a `MaxWalkSpeed|MaxExcessSpeed` does. VTS_GREP_BLOCK=0 reverts all of this to warn-only.
function isSymbolHuntGrep(ti) {
  const pat = String(ti.pattern || "");
  if (!pat || pat.length > 200) return false;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(pat)) return true;                       // (1) bare identifier → search_symbol
  if (!/[A-Za-z_][A-Za-z0-9_]{3,}/.test(pat)) return false;                    // no real identifier token → not a symbol hunt
  if (/::|\\\(|\bvoid\b|\bclass\b|\bstruct\b|\benum\b|\btemplate\b/.test(pat)) return true; // (2) code-structural cue
  if (pat.includes("|") && /[a-z][A-Z]|[a-z][a-z0-9]*_[a-z]/.test(pat)) return true;        // (3) CamelCase/snake alternation
  return false;
}
// Don't block a search explicitly aimed at non-code (a doc/asset glob or path) even if the pattern looks
// symbol-ish — the symbol may legitimately be referenced in a .md/.json.
function notTextLogTarget(ti) {
  const glob = String(ti.glob || ""); const p = String(ti.path || "");
  return !(TEXT_TARGET_RE.test(glob.toLowerCase()) || TEXT_TARGET_RE.test(p.toLowerCase()) || LOG_TARGET_RE.test(glob) || LOG_TARGET_RE.test(p));
}
// Block default-ON; VTS_GREP_BLOCK=0/false/off reverts the symbol-hunt escalation to warn-only.
const grepBlockOn = () => !/^(0|false|off|no)$/i.test(String(process.env.VTS_GREP_BLOCK ?? "1"));
// Reassuring block copy for a symbol-hunt Grep — leads with the win (tokens + accuracy), frames the red box
// as a friendly "hold on", and embeds the READY-TO-USE search_symbol/search_text call (grepNudgeFor).
function grepBlockMsg(ti) {
  const head = KO
    ? "✨ vs-token-safer가 심볼 검색을 가로챘어요 — 고장이 아니라 의도된 동작이고, 토큰 절약 + 정확도↑입니다. 🎉\n" +
      "(빨간 박스는 훅이 \"잠깐\"이라고 말하는 신호일 뿐, 실패가 아니에요.)\n" +
      "이 패턴은 '심볼 사냥'이라 시맨틱 도구가 더 작고 정확합니다 (정규식 거짓양성 없음 — `void.*Foo\\(`는 `SetActiveFoo`도 긁어요):\n"
    : "✨ vs-token-safer caught a SYMBOL search — intended, not broken; it saves tokens AND improves accuracy. 🎉\n" +
      "(The red box is just the hook saying \"hold on\" — not a failure.)\n" +
      "This pattern is a symbol hunt → a semantic tool is smaller + exact (no regex false positives — `void.*Foo\\(` also catches `SetActiveFoo`):\n";
  return head + grepNudgeFor(ti) + (KO ? "\nwarn-only로 되돌리려면: VTS_GREP_BLOCK=0." : "\nPrefer warn-only? VTS_GREP_BLOCK=0.");
}
// Glob / Search TOOL — the built-in filename search. vts's find_files is the token-capped, walk-bounded
// equivalent (skips Intermediate/Binaries/node_modules, time-boxed) — the built-in Glob has no result cap
// and times out on a giant tree (a real UE dead-end: the model gave up on file search entirely). Warn-only
// (find_files is a DIFFERENT tool → can't updatedInput-rewrite a Glob), nudged ONLY on a source signal so
// a doc/log/asset glob isn't pestered. The basename of the glob pattern is the ready-to-use find_files q.
function globBasename(pat) {
  const seg = String(pat || "").replace(/\\/g, "/").split("/").pop() || "";
  return seg.replace(/[{}]/g, ""); // a {ts,tsx} brace-set still reads as a hint
}
function isCodeGlobTool(ti) {
  const base = globBasename(ti.pattern).toLowerCase();
  const p = String(ti.path || "").replace(/\\/g, "/").toLowerCase();
  if (LOG_TARGET_RE.test(String(ti.pattern || "")) || LOG_TARGET_RE.test(p)) return false; // log → not here
  if (TEXT_TARGET_RE.test(base)) return false;                                              // *.md/*.json → skip
  // a CODE extension in the glob, a code dir in the path, or a specific source file with a WILDCARD ext
  // (`Foo.*` — the "find the .h/.cpp pair" form). A concrete NON-code ext (`Foo.png`, `Bar.uasset`) is left
  // alone — only CODE_EXT_RE decides concrete extensions, so asset/binary filename searches aren't intercepted.
  return CODE_EXT_RE.test(base) || CODE_DIR_RE.test(p) || /[a-z0-9_]\.\*$/.test(base);
}
function globNudgeFor(ti) {
  const base = globBasename(ti.pattern);
  const call = base && base.length <= 80
    ? (KO ? ` 바로 쓸 수 있는 토큰캡 호출: find_files q="${base}".` : ` Equivalent token-capped call: find_files q="${base}".`)
    : "";
  return KO
    ? "[vs-token-safer] Glob(Search) 툴로 파일명 검색 중이에요. find_files가 토큰캡 + 워크 바운드(Intermediate/" +
      "Binaries/node_modules 스킵, 시간박스) 버전이라 거대 트리(UE)에서도 안 멈춰요." + call +
      " 작은 트리 빠른 확인이면 Glob 그대로 OK. 끄기: VTS_ENFORCE=0."
    : "[vs-token-safer] Filename search via the Glob/Search tool. find_files is the token-capped, walk-bounded " +
      "equivalent (skips Intermediate/Binaries/node_modules, time-boxed) — it won't time out on a giant tree " +
      "(UE)." + call + " On a small tree a quick Glob is fine. Disable: VTS_ENFORCE=0.";
}
// v2.2: a Glob naming a CONCRETE code file/extension (`*.cpp`, `Foo.h`, `**/Bar.*`) is BLOCKED → find_files,
// which is walk-bounded (won't time out on a giant UE tree) and token-capped, so it's strictly better. A bare
// `*` / `**/*` (no extension) stays a warn — genuinely ambiguous. The warn was ignored: the model kept
// Glob-ing a huge tree and narrowing the path instead of switching tools (live dogfood). VTS_GREP_BLOCK=0 reverts.
function isBlockableGlob(ti) {
  if (!isCodeGlobTool(ti)) return false;
  const base = globBasename(ti.pattern).toLowerCase();
  return CODE_EXT_RE.test(base) || /[a-z0-9_]\.\*$/.test(base); // a CODE extension, or `Name.*` — never a concrete non-code ext (Foo.png) or a bare *
}
// Root hint for the reroute: the explicit `path`, else the literal directory prefix of the glob (everything
// before the first wildcard, minus the trailing filename) — so the model narrows the giant tree.
function globRootHint(ti) {
  if (ti.path) return String(ti.path).replace(/\\/g, "/");
  const dir = String(ti.pattern || "").replace(/\\/g, "/").split(/[*?]/)[0].replace(/\/[^/]*$/, "");
  return dir.includes("/") ? dir : "";
}
function globBlockMsg(ti) {
  const base = globBasename(ti.pattern);
  const hint = globRootHint(ti);
  const call = `find_files q="${base}"${hint ? ` projectPath="${hint}"` : ""}`;
  return KO
    ? "✨ vs-token-safer가 파일명 검색을 가로챘어요 — 고장이 아니라 의도된 동작이고, 거대 트리 타임아웃을 막아줍니다. 🎉\n" +
      "(빨간 박스는 \"잠깐\"의 신호일 뿐, 실패가 아니에요.) find_files는 walk-bound(Intermediate/Binaries/node_modules " +
      "스킵 + 시간박스)라 UE 트리에서도 안 멈춰요.\n어시스턴트는 이렇게 다시 실행하세요: " + call +
      " (루트를 좁힐수록 빠름). 끄기: VTS_GREP_BLOCK=0 / VTS_ENFORCE=0."
    : "✨ vs-token-safer caught a filename search — intended, not broken; it avoids a giant-tree timeout. 🎉\n" +
      "(The red box is just a \"hold on\", not a failure.) find_files is walk-bounded (skips Intermediate/Binaries/" +
      "node_modules + time-boxed) so it won't hang on a UE tree.\nAssistant: re-run as: " + call +
      " (narrow the root for speed). Disable: VTS_GREP_BLOCK=0 / VTS_ENFORCE=0.";
}
const LOG_NUDGE = KO
  ? "[vs-token-safer] 이 검색은 LOG가 대상입니다. 언어 서버 인덱스는 소스 코드만 다뤄요 — 로그 분석은 grep 대신 " +
    "gamedev-log를 쓰세요 (/gamedev-log-analyzer:logs, 또는 gamedev-log CLI: summary / search / locate / fields / diff). 끄기: VTS_ENFORCE=0."
  : "[vs-token-safer] This search targets a LOG. The language-server index only covers source code — for log " +
    "analysis use gamedev-log (/gamedev-log-analyzer:logs, or the gamedev-log CLI: summary / search / locate " +
    "/ fields / diff) instead of grep. Disable: VTS_ENFORCE=0.";

const BLOCK_MSG = KO
  ? "✨ vs-token-safer가 코드 검색을 가로챘어요 — 고장난 게 아니라 의도된 동작이고, 토큰을 왕창 아꼈습니다. 🎉\n" +
    "(빨간 박스는 훅이 \"잠깐\"이라고 말하는 유일한 방법이에요 — 실패가 아니라 친절한 안내입니다.)\n" +
    "같은 검색을 언어 서버 인덱스로 하면 file:line으로 토큰캡되어 보통 ~90% 작고(큰 repo면 20~60배),\n" +
    "grep의 거짓 양성(주석·문자열·유사명)도 없습니다. 어시스턴트는 이 검색을 의도에 맞는 vts 도구로 다시 실행하세요:\n" +
    "  - 심볼 / 클래스 / 함수 / 타입   → search_symbol   (q, projectPath, backend, maxResults)\n" +
    "  - 참조 / 사용처                 → find_references (symbol — 이름만; 코드수정 primitive)\n" +
    "  - 정의로 이동                   → goto_definition (path, line, character — 0-based)\n" +
    "  - 원시 텍스트 / 문자열 / 주석   → search_text     (q, projectPath) — 토큰캡 grep\n" +
    "  - 파일명 검색                   → find_files      (q, projectPath) — glob 또는 부분일치\n" +
    "또는 컨텍스트 격리 `code-locator` 서브에이전트에 위임할 수 있습니다.\n" +
    "CLI(비-MCP): `vts symbol --q <이름> --projectPath <루트>` (vts text / files / hover 도).\n" +
    "백엔드는 루트에서 자동 감지(compile_commands.json→clangd, .sln/.csproj→roslyn, tsconfig/package.json→typescript, pyproject/*.py→pyright).\n" +
    "팁: 단순한 grep 하나는 자동 변환됩니다(빨간 박스 없음) — 이번 건 여러 부분이라 차단됐으니 위 중 하나를 실행하세요. " +
    "로그/설정 텍스트는 비코드 파일이나 gamedev-log로. 끄기: VTS_ENFORCE=0."
  : "✨ vs-token-safer caught a code search before it flooded your context — nothing broke, this is on\n" +
    "purpose, and it just saved you a pile of tokens. 🎉 (A red box is the only way a hook can say\n" +
    "\"hold on\" — it's a friendly redirect, not a failure.) The very same lookup through the language-server\n" +
    "index comes back token-capped to file:line, usually ~90% smaller (often 20–60× on a big repo), and\n" +
    "WITHOUT grep's false positives. The assistant should re-run this lookup with the vts tool matching the intent:\n" +
    "  - symbol / class / function / type → search_symbol  (args: q, projectPath, backend, maxResults)\n" +
    "  - references / usages of a symbol  → find_references (args: symbol — just the name; the edit primitive)\n" +
    "  - definition of a symbol           → goto_definition (args: path, line, character — 0-based)\n" +
    "  - raw text / string / comment      → search_text     (args: q, projectPath) — token-capped grep\n" +
    "  - file by name                     → find_files      (args: q, projectPath) — glob or substring\n" +
    "Or delegate the whole lookup to the context-isolated `code-locator` subagent.\n" +
    "CLI alternative (no MCP): `vts symbol --q <name> --projectPath <root>` (also: vts text / files / hover).\n" +
    "Backend auto-detects from the root (compile_commands.json → clangd, .sln/.csproj → roslyn,\n" +
    "tsconfig/package.json → typescript, pyproject.toml/*.py → pyright).\n" +
    "Tip: a SINGLE simple grep is auto-rewritten for you (no red box at all) — this one had several parts,\n" +
    "so just run one of the above. Logs/config text → target a non-code file or gamedev-log. Opt out anytime: VTS_ENFORCE=0.";

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

  // Grep TOOL — enforcement v2 (A+): a clear SYMBOL HUNT is BLOCKED (semantic tool is strictly better);
  // everything else stays warn-only (Grep is the sanctioned fallback for freeform text / just-edited files).
  if (toolName === "Grep") {
    if (isLogGrepTool(ti)) emitWarn(LOG_NUDGE + setup);
    else if (grepBlockOn() && isSymbolHuntGrep(ti) && notTextLogTarget(ti)) {
      process.stderr.write(grepBlockMsg(ti) + setup + "\n");
      process.exit(2); // block — route the symbol hunt to search_symbol / search_text
    }
    else if (isCodeGrepTool(ti)) emitWarn(grepNudgeFor(ti) + setup);
    process.exit(0);
  }

  // Glob / Search TOOL — v2.2: a CONCRETE code-file glob (`*.cpp`, `Foo.h`, `**/Bar.*`) is BLOCKED → find_files
  // (walk-bounded, won't time out on a giant tree); a bare `*` / code-dir glob stays a warn. The warn alone was
  // ignored — the model kept Glob-ing a huge UE tree instead of switching. VTS_GREP_BLOCK=0 reverts to warn-only.
  if (toolName === "Glob") {
    if (grepBlockOn() && isBlockableGlob(ti)) {
      process.stderr.write(globBlockMsg(ti) + setup + "\n");
      process.exit(2); // block — route the concrete code-file glob to find_files
    }
    else if (isCodeGlobTool(ti)) emitWarn(globNudgeFor(ti) + setup);
    process.exit(0);
  }

  // Bash — code-grep is rewritten to the vts CLI (token-capped) when safe, else blocked (vts default); a
  // log-targeted search is steered (warn) but allowed.
  const cmd = ti.command || "";
  if (!cmd) process.exit(0);
  const segments = splitSegments(cmd);

  // VCS output compaction: a SINGLE read-only git/p4 command (status/log/diff/opened/…) is rerouted to the
  // vts wrapper, which runs it and compacts the output. Runs BEFORE code-search handling (so `git grep`
  // stays a code search) and NEVER blocks — if we can't build a safe rewrite, the original command runs.
  if (!rewriteOff() && compactVcsOn() && segments.length === 1 && !excludedCommands().has(execOf(segments[0]))) {
    const v = buildVcsRewrite(segments[0]);
    if (v) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: `Rerouted ${v.bin} ${v.sub} → vts ${v.tool} (output grouped/deduped/token-capped).`,
          updatedInput: { ...ti, command: v.cmd },
          additionalContext:
            `[vs-token-safer] Compacted \`${v.bin} ${v.sub}\` output (grouped/deduped/capped) to save tokens. ` +
            `Disable VCS compaction: VTS_COMPACT_VCS=0. Disable all rewrites: VTS_REWRITE=0.`,
        },
      }) + "\n");
      process.exit(0);
    }
  }

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
  // Docs/text grep with an explicit file target (not code, not log) → reroute to `vts text --path <file>`,
  // which auto-includes that file's extension and token-caps the result. Rewrite-only, never blocks.
  if (!rewriteOff() && segments.length === 1 && !excluded.has(execOf(segments[0])) && !isLogSearchSegment(segments[0])) {
    const dr = buildDocsGrepRewrite(segments[0]);
    if (dr) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: `Rerouted docs/text grep → vts search_text scoped to ${dr.file} (token-capped).`,
          updatedInput: { ...ti, command: dr.cmd },
          additionalContext:
            `[vs-token-safer] Rewrote your grep over ${dr.file} → \`vts text --path ${dr.file}\` (q="${dr.q}"), ` +
            `token-capped — search_text path= auto-includes that file's extension. Disable: VTS_REWRITE=0 / VTS_ENFORCE=0.`,
        },
      }) + "\n");
      process.exit(0);
    }
  }
  if (segments.some(isLogSearchSegment)) {
    emitWarn(LOG_NUDGE + setup);
    process.exit(0); // logs were never blocked — just point at the right tool
  }
  process.exit(0);
});
