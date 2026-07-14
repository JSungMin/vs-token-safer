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
// Whole-declaration edit detector, shared with discover (core.js) so the set we STEER matches the set we
// MEASURE; the adoption ledger is the live metric the steer is tuned against.
import { classifyDeclEdit } from "../server/edit-detect.js";
import { recordEditEvent, resetStreak, recordSteerShown, decideEscalation } from "../server/edit-ledger.js";
import { shouldSuppressSteer, readSteerDecision, topLevelDeclNames, orchestratorPresent, resolveSearchRoot, recordActiveProject, readActiveProject, subprojectsUnder } from "../server/policy.js";

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

// ORCHESTRATOR REDIRECT (the gap that let code search bypass qvts). When a local orchestrator (qvts) is
// present, a CODE SEARCH via Bash grep / the Grep tool / the Glob tool is the orchestrator's job — delegating
// keeps the raw search output in the local model and returns only a compact answer. Without this, this hook
// rerouted grep → the vts CLI (NOT qvts), so the Bash/Grep/Glob path never reached the orchestrator at all,
// and the model, handed a "VTS_ENFORCE=0" escape, just bypassed and Read the file. So when qvts is present we
// redirect these to a ready `qvts` command instead — and we do NOT advertise the VTS_ENFORCE=0 kill switch
// here (that only taught the bypass). Opt out with VTS_ORCH_BLOCK=0 (then the normal vts steer/rewrite runs).
const ORCH = orchestratorPresent() && !/^(0|false|off|no)$/i.test(process.env.VTS_ORCH_BLOCK ?? "1");
const orchRoot = () => process.env.VTS_PROJECT_PATH || readConfig().projectPath || process.cwd();
// `target` (the file/dir the search names) generalizes the root: a file in a sibling sub-tree of the configured
// project (Unreal Engine/ vs Game/, a monorepo package, a web/python workspace) resolves UP to ITS repo root.
// (A) record the resolved project when there's a target; reuse the last active project when there isn't, so a
// target-less code search scopes to where you've been working, not the broad vault/monorepo parent.
function resolveRoot(target) {
  const fb = orchRoot();
  if (target) { const r = resolveSearchRoot(target, fb) || fb; recordActiveProject(r); return r; }
  return readActiveProject() || fb;
}
function qvtsCmd(task, target) {
  const root = String(resolveRoot(target)).replace(/"/g, "'");
  const t = String(task || "").replace(/\s+/g, " ").replace(/"/g, "'").trim().slice(0, 200);
  return `qvts -p "${root}" --json "${t}"`;
}
// (B) when the chosen root is a broad PARENT holding ≥2 sub-projects, nudge to scope -p to the specific one.
function subprojectHint(root) {
  const subs = subprojectsUnder(root);
  if (subs.length < 2) return "";
  const list = subs.slice(0, 5).join(", ");
  return KO
    ? `\n참고: "${root}"는 여러 프로젝트 포함 상위 폴더 — 정확/빠른 결과 위해 -p로 구체 프로젝트 지정 (후보: ${list}).`
    : `\nNote: "${root}" is a parent of multiple projects — pass -p the specific one for accurate/fast results (candidates: ${list}).`;
}
function orchMsg(task, target) {
  const cmd = qvtsCmd(task, target);
  const hint = subprojectHint(resolveRoot(target));
  return (KO
    ? `✨ vs-token-safer: 로컬 오케스트레이터(qvts) 감지 — 이 코드검색은 위임하세요 (직접 grep/Read 말고).\n→ ${cmd}\n   (로컬 모델이 검색하고 compact 답만 반환 — Claude 토큰 절약. 결과 file:line은 사실로 신뢰; 못 찾으면 같은 호출 다시 하면 직접검색 통과.)`
    : `✨ vs-token-safer: local orchestrator (qvts) detected — delegate this code search (don't grep/Read directly).\n→ ${cmd}\n   (the local model searches; only a compact answer returns — saves Claude tokens. Trust the file:line; if it finds nothing, re-issue and direct search passes.)`) + hint;
}
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
  return SEARCH_EXECS.has(exec) || (exec === "find" && /\s-i?name(\s|$)/.test(segment.toLowerCase())) || isGitGrepSegment(segment);
}

// A `find` doing FILE-OPS (not a search-to-read): an action flag (-exec/-delete/-print0/…) or `-type d`
// means it's enumerating files to act on (backup, copy, cleanup), NOT hunting code for the model to read.
// find_files (token-capped) is the WRONG substitute there — a capped list would silently drop files from a
// copy/delete. So such a find is never treated as a code search (live-found: a UE-depot backup `find -name
// "*.cpp"` alongside cp/du got blocked, and rerouting it to a capped find_files would corrupt the backup).
const FIND_ACTION_RE = /\s-(exec|execdir|delete|ok|okdir|print0|fprint0?|fls|fprintf)\b/;
const FIND_TYPE_DIR_RE = /\s-type\s+d\b/;
function isFindFileOps(segment) {
  return execOf(segment) === "find" && (FIND_ACTION_RE.test(segment) || FIND_TYPE_DIR_RE.test(segment));
}

function isCodeSearchSegment(segment) {
  if (!isSearchSegment(segment)) return false;
  if (isFindFileOps(segment)) return false; // a file-ops find is not a code search
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

// File-operation executables — when ANY segment of a command is one of these, a `find` segment in the same
// command is PLUMBING for that op (the file list feeds cp/tar/xargs/…), not an interactive code search. So
// such a find is excluded from the block even without its own -exec (`find … -name '*.cpp' | xargs cp`,
// `du …; find … -name '*.uproject'` during a backup). grep segments are NOT relaxed (a literal grep inside a
// pipeline is usually content filtering, and the user can still VTS_ENFORCE=0 a non-search session).
const FILE_OPS_EXECS = new Set([
  "cp", "mv", "rm", "tar", "rsync", "xargs", "zip", "unzip", "7z", "cpio", "install",
  "ln", "du", "df", "chmod", "chown", "mkdir", "touch", "dd", "scp", "robocopy", "pax",
]);
function hasFileOpsContext(segments) {
  return segments.some((s) => FILE_OPS_EXECS.has(execOf(s)));
}

// A Bash command that EDITS a code file in place — `sed -i`, an `awk` inplace/redirect, or a python/perl
// heredoc (or -c) that opens a code file for write. The edit-steer hook only matches the Edit/MultiEdit
// TOOLS, so a model doing file surgery via Bash/python BYPASSED it entirely (live: an agent brace-matched +
// spliced a large irregular-indent function in python — exactly what replace_symbol_body does natively). A
// warn-only nudge toward the symbol-edit tools (edit by NAME via the parser range — no brace-matching, no
// exact-match hazard, no whole-file read). FP-careful: a code-file path AND an explicit write/in-place
// signal must BOTH be present, so a read-only `sed`/`awk` in a pipeline or a `python build.py` isn't nagged.
// `:` in the class so a Windows drive-letter path (`G:/…/Foo.h`) matches WHOLE — without it the match
// started after the `G:` and the body-read steer suggested a broken, drive-less path in its ready call.
const CODE_FILE_TOKEN = /[\w.:/\\-]+\.(c|cc|cxx|cpp|h|hpp|hh|hxx|inl|ipp|tpp|cs|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi)\b/i;
function isBashCodeEdit(cmd) {
  const s = String(cmd);
  if (!CODE_FILE_TOKEN.test(s)) return false;                       // no code-file path → not a code edit
  if (/\bsed\b[^|]*\s-i\b/.test(s)) return true;                    // sed -i (in-place)
  if (/\bawk\b/.test(s) && (/-i\s+inplace/.test(s) || /\bawk\b[^|]*>/.test(s))) return true; // awk inplace / redirect to a file
  if (/\b(?:python3?|perl)\b/.test(s) && /(<<|-c\b)/.test(s) &&     // python/perl heredoc or -c that WRITES
      (/open\s*\([^)]*["'][aw]b?["']/.test(s) || /\.write(?:_text|_bytes)?\s*\(/.test(s) || /Path\s*\([^)]*\)\s*\.write/.test(s))) return true;
  return false;
}
function bashEditNudge() {
  return KO
    ? "[vs-token-safer] Bash로 코드 파일을 수정 중이에요. 선언을 통째로 교체/추가하는 거면 이름으로 편집하세요 — replace_symbol_body symbol=<이름> / insert_symbol symbol=<앵커> (파서 range로 span 잡아 splice — brace-matching·exact-match·파일 통째 Read 불필요; preview 기본, apply=true 기록). 부분 in-place 수정이면 그대로 OK. 끄기: VTS_EDIT_WARN=0."
    : "[vs-token-safer] Editing a code file via Bash. If you're replacing/adding a WHOLE declaration, edit by NAME — replace_symbol_body symbol=<name> / insert_symbol symbol=<anchor> (resolves the span via the parser range and splices — no brace-matching, no exact-match hazard, no whole-file read; preview by default, apply=true writes). A partial in-place tweak? Carry on. Disable: VTS_EDIT_WARN=0.";
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
  const m = segment.match(/\s-i?name\s+("([^"]+)"|'([^']+)'|(\S+))/);
  return m ? (m[2] || m[3] || m[4] || "") : null;
}
// Split a grep's path operands into a specific FILE (has an extension) vs a DIRECTORY (bare name or slashed, no
// extension), so BOTH can scope the delegated search and generalize the root (a file/dir in a sibling sub-tree
// resolves to ITS repo root). Operands are the bare tokens AFTER the pattern; iterate from the end and stop at
// the pattern token. A bare-word dir (`grep -r Foo Source`) used to be invisible — extractSearchFile only caught
// file/slashed operands, so a dir target silently dropped to a whole -p root scan (the scope-loss bug). A slashed
// path with no extension is treated as a DIR (kept whole, not basename-truncated). Best-effort; both null when
// the grep has no explicit path operand.
function extractGrepScope(segment, isGit) {
  const pat = extractGrepPattern(segment, isGit);
  const toks = segment.trim().split(/\s+/).slice(1); // drop the executable
  const start = isGit ? (toks[0] === "grep" ? 1 : 0) : 0; // `git grep` — don't treat the `grep` subcommand as an operand
  let file = null, dir = null;
  for (let i = toks.length - 1; i >= start; i--) {
    const t = stripQuotes(toks[i]);
    if (!t || t.startsWith("-")) continue;
    if (pat != null && t === pat) break;             // reached the pattern → operands after it are exhausted
    if (!SAFE_PATH.test(t)) continue;                // not a plausible path token
    if (/\.[A-Za-z0-9_]+$/.test(t)) { if (!file) file = t; }        // has an extension → a file
    else if (!dir) dir = t;                          // bare or slashed, no extension → a directory
  }
  return { file, dir };
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
    // Multiple `-name` / an OR (`-o`) can't be expressed as one find_files call — rewriting to the FIRST
    // -name would SILENTLY DROP the rest (a wrong/partial result, e.g. `-name *.h -o -name *.cpp` → only *.h).
    // Bail → block, so the model runs a proper search instead of trusting an incomplete rewrite.
    if ((segment.match(/\s-i?name\s/g) || []).length > 1 || /\s-or?\s/.test(segment)) return null;
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

// Read-only Bash BODY DUMP of a code file: `sed -n 'X,Yp' Foo.cpp`, `cat Foo.h`, `head/tail -n`, a read-only
// awk. The same token leak the Read-tool steer catches (raw bodies into context), through a side door no
// search hook covers. Read-ONLY only: `-i`/inplace is the edit-steer's case, and any stdout redirect (`>`,
// minus `2>` stderr) means the bytes go to a FILE, not into context — leave those alone.
const readSteerOn = () => !/^(0|false|off|no)$/i.test(String(process.env.VTS_READ_STEER ?? "1"));
const BODY_READ_EXECS = new Set(["sed", "cat", "head", "tail", "awk"]);
// Interpreters that can be handed an INLINE program (`-c`/`-e`/heredoc) which opens a code file, reads it,
// and prints slices — a hand-rolled read_symbol. The model reaches for these exactly when read_symbol
// fails (live: read_symbol dead-ended on a UE tree → the model wrote `python -c "s=open(...).read(); i=
// s.find('::Foo'); print(s[i:i+2600])"` with line numbers — literally reimplementing the tool). None of
// sed/cat/head/tail/awk match, so this whole class bypassed the body-read steer.
const INTERP_EXECS = new Set(["python", "python3", "perl", "ruby", "node", "nodejs", "pwsh", "powershell"]);
// A read primitive (opens/reads a file into a string) vs a write primitive (that's the edit steer's job).
const READ_PRIM = /open\s*\(|\.read(?:lines|_text|_bytes)?\s*\(|readFileSync|File\.read|Get-Content|IO\.read|<>/;
// Write PRIMITIVES only — NOT a bare `>` (inside a `python -c` string a `>` is a comparison, not a redirect;
// stderr fds like `2>&1` are stripped by the caller). A real stdout-to-file redirect is rare here and at
// worst costs one extra warn.
const WRITE_PRIM = /open\s*\([^)]*["'][aw]b?\+?["']|\.write(?:_text|_bytes)?\s*\(|writeFileSync|Set-Content|Out-File/;
function isBashCodeBodyRead(seg) {
  const exec = execOf(seg);
  if (BODY_READ_EXECS.has(exec)) {
    if (!CODE_FILE_TOKEN.test(seg)) return false;
    if (/\s-i\b/.test(seg) || /-i\s+inplace/.test(seg)) return false;        // in-place edit → edit steer
    if (/>/.test(seg.replace(/\d>/g, ""))) return false;                     // writes to a file → not a dump
    return true;
  }
  // interpreter one-liner: an inline program (-c/-e/heredoc) that READS a code file and doesn't WRITE it.
  if (INTERP_EXECS.has(exec)) {
    if (!/(^|\s)-[ce]\b|<<'?[A-Za-z_]/.test(seg)) return false;              // must be an inline program, not `python build.py`
    if (!CODE_FILE_TOKEN.test(seg)) return false;                           // references a code file
    if (!READ_PRIM.test(seg)) return false;                                 // actually reads it
    if (WRITE_PRIM.test(seg.replace(/\d>/g, ""))) return false;             // any write → not a pure dump (edit steer / leave alone)
    return true;
  }
  return false;
}
function bodyReadNudge(seg) {
  const m = CODE_FILE_TOKEN.exec(seg);
  const f = m ? m[0] : "<file>";
  const digest = ORCH
    ? (KO ? `; 요약/조사면 qvts digest "${f}" --focus "<질문>" (로컬 모델이 읽고 요약만 반환)` : `; for a survey use qvts digest "${f}" --focus "<question>" (the local model reads it, only a brief returns)`)
    : "";
  return KO
    ? `[vs-token-safer] Bash(${execOf(seg)})로 코드 본문을 컨텍스트에 덤프 중이에요 (${f}). 선언 하나가 필요하면 read_symbol symbol=<이름> path="${f}" (그 선언만, 토큰캡)${digest}. 정확한 바이트가 필요한 편집 직전에만 직접 읽으세요. 끄기: VTS_READ_STEER=0.`
    : `[vs-token-safer] Dumping a code-file body into context via Bash (${execOf(seg)} on ${f}). For one declaration use read_symbol symbol=<name> path="${f}" (that decl only, token-capped)${digest}. Read raw bytes only right before an EDIT. Disable: VTS_READ_STEER=0.`;
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

// ── Edit steering (L1 warn): a whole-DECLARATION edit via the built-in Edit gets a model-visible nudge with
// a ready symbol-edit call. The token win (skipping the file Read) is already sunk by Edit time, so this
// can't recover the CURRENT edit — it's a learning signal for the NEXT one, and the adoption ledger measures
// whether it lands (escalating to a block only if it doesn't; see L2). A sub-declaration tweak isn't flagged.
function editWarnOn() { const v = String(process.env.VTS_EDIT_WARN ?? "1").toLowerCase(); return !(v === "0" || v === "false" || v === "off"); }
function editMinLines() { const n = Number(process.env.VTS_EDIT_MIN_LINES); return Number.isFinite(n) && n > 0 ? n : 8; }
// Best-effort declaration name from a code chunk, so the nudge can name the symbol (a ready call beats a
// vague hint — the SkillOpt "actionable artifact" principle). null when no name is confidently found.
const RESERVED_CALLEE = /^(?:if|for|while|switch|catch|return|sizeof|do|else|case|with)$/;
function declSymbolName(chunk) {
  const c = String(chunk || "");
  let m;
  if ((m = c.match(/\b(?:class|struct|enum|interface|namespace)\s+([A-Za-z_]\w*)/))) return m[1];
  if ((m = c.match(/\b(?:def|function|func|fn)\s+([A-Za-z_]\w*)/))) return m[1];
  // a signature line — but a control-flow header (`if (…) {`, `for (…) {`) also matches it; never name those.
  if ((m = c.match(/^[^\n=;]*?\b([A-Za-z_]\w*)\s*\([^;{)]*\)\s*(?:const)?\s*\{?\s*$/m)) && !RESERVED_CALLEE.test(m[1])) return m[1];
  return null;
}
function editNudgeFor(toolName, ti) {
  const ce = classifyDeclEdit(toolName, ti, editMinLines());
  const pairs = toolName === "MultiEdit" && Array.isArray(ti.edits) ? ti.edits : [ti];
  let name = null;
  for (const e of pairs) { name = declSymbolName(ce.replaceDecl ? e.old_string : e.new_string); if (name) break; }
  const sym = name ? `symbol="${name}"` : "symbol=<name>";
  if (ce.replaceDecl) {
    return KO
      ? `[vs-token-safer] 선언을 *통째* 교체하네요. 파일을 통째로 Read해서 Edit하는 대신 이름으로 편집하세요 — replace_symbol_body ${sym} body=<새 선언 전체> (preview 기본, apply=true 기록; 파일 Read 생략·토큰 절약). 선언 일부만 고치는 거면 Edit 그대로 OK. 끄기: VTS_EDIT_WARN=0.`
      : `[vs-token-safer] This replaces a WHOLE declaration. Instead of Read-the-file-then-Edit, edit by name — replace_symbol_body ${sym} body=<the full new declaration> (preview by default, apply=true writes; skips the file Read, saves tokens). A sub-declaration tweak? Built-in Edit is fine. Disable: VTS_EDIT_WARN=0.`;
  }
  return KO
    ? `[vs-token-safer] 새 선언을 *추가*하네요. 앵커를 Read할 필요 없이 이름 옆에 삽입하세요 — insert_symbol ${sym} text=<추가할 선언> (position=after 기본 또는 before; preview 기본, apply=true 기록). 끄기: VTS_EDIT_WARN=0.`
    : `[vs-token-safer] This ADDS a new declaration. Insert it next to an anchor by name (no Read needed) — insert_symbol ${sym} text=<the new declaration> (position=after default, or before; preview by default, apply=true writes). Disable: VTS_EDIT_WARN=0.`;
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
// An OUTLINE hunt (vs a symbol hunt): an alternation built mostly of declaration KEYWORDS — `^(function|
// const|async function|export|//\s*----)`, `^(void|class|struct)` — is the model enumerating the
// DECLARATION STRUCTURE of a file, not hunting one named symbol. The right tool is `document_symbols` (the
// token-capped, noise-filtered outline), not search_text. WARN-only, never block: keyword alternations are
// FP-prone (`const` in config, `export` in shell), and document_symbols needs a target file the grep may not
// name. Distinct from isSymbolHuntGrep — a CamelCase/snake_case identifier means a SPECIFIC symbol (that path
// handles it), so it's excluded here. Measured: `^(function|const|...|//\s*----)` was a top bypass that the
// hook didn't even warn on (no code path/glob → invisible). VTS_GREP_BLOCK has no bearing (warn-only).
const OUTLINE_KW = /^(?:function|func|fn|def|class|struct|enum|interface|namespace|module|const|let|var|type|typedef|using|import|export|require|package|public|private|protected|static|async|void|template|impl|trait|proc|sub|abstract|final|override|virtual|extends|implements|pub)$/;
// Reduce one alternation branch to the bare keyword it carries: strip a leading regex anchor (`^`), a
// group-open (`(` / `(?:`), a whitespace matcher (`\s*`, `[ \t]*`), and a trailing `)`, then take the LAST
// word (so `async function` / `export const` → `function` / `const`). The first branch of `^\s*(function|…)`
// arrives glued to the anchor+group; without this it failed the keyword test and a 2-branch outline was
// missed (real-case test: `^[ \t]*(function|const)`, `^(export|import)`).
function outlineKeywordOf(branch) {
  const s = String(branch).trim()
    .replace(/^\^/, "")                                    // ^ anchor
    .replace(/^\((?:\?:)?/, "")                            // ( or (?:
    .replace(/^(?:\\s[*+?]?|\[[^\]]*\][*+?]?|\s)+/, "")    // \s* / [ \t]* / literal whitespace
    .replace(/^\((?:\?:)?/, "")                            // a group-open that followed the whitespace
    .replace(/[)$\s]+$/, "")                               // trailing ), $ anchor, whitespace (any order)
    .trim();
  const words = s.split(/\s+/).filter(Boolean);
  return words.length ? words[words.length - 1] : s;
}
function isOutlineHuntGrep(ti) {
  const pat = String(ti.pattern || "");
  if (!pat.includes("|") || pat.length > 200) return false;
  if (/[a-z][A-Z]|[a-z][a-z0-9]*_[a-z]/.test(pat)) return false; // a CamelCase/snake id → a specific symbol, not an outline
  const branches = pat.split("|").map(outlineKeywordOf).filter(Boolean);
  if (branches.length < 2) return false;
  const kw = branches.filter((b) => OUTLINE_KW.test(b)).length;
  return kw >= 2; // ≥2 declaration-keyword branches → a structure/outline hunt → document_symbols
}
function outlineNudgeFor(ti) {
  const p = ti.path ? String(ti.path) : "";
  const call = p && p.length <= 120
    ? (KO ? ` 바로 쓸 수 있는 토큰캡 호출: document_symbols path="${p}".` : ` Equivalent token-capped call: document_symbols path="${p}".`)
    : (KO ? ` 바로 쓸 수 있는 토큰캡 호출: document_symbols path="<파일>".` : ` Equivalent token-capped call: document_symbols path="<file>".`);
  return KO
    ? "[vs-token-safer] 선언 키워드(function/const/class/…)로 파일 구조를 훑고 있네요. 그건 '아웃라인' 요청이라 " +
      "document_symbols가 정확합니다 — 언어 서버가 클래스/함수/메서드/필드 구조를 file:line으로 주고, 익명 콜백·중첩 " +
      "로컬 노이즈를 걸러 토큰캡됩니다 (정규식이 주석·문자열을 긁는 거짓양성도 없음)." + call +
      " 그냥 텍스트 확인이면 Grep 그대로 OK. 끄기: VTS_ENFORCE=0."
    : "[vs-token-safer] Scanning a file's structure by declaration keyword (function/const/class/…). That's an " +
      "OUTLINE request → document_symbols is exact — the language server returns the class/function/method/field " +
      "structure as file:line, noise-filtered (anonymous callbacks / nested locals hidden) and token-capped (no " +
      "regex false positives over comments/strings)." + call + " For a quick text peek, Grep is fine. Disable: VTS_ENFORCE=0.";
}
// Don't block a search explicitly aimed at non-code (a doc/asset glob or path) even if the pattern looks
// symbol-ish — the symbol may legitimately be referenced in a .md/.json.
function notTextLogTarget(ti) {
  const glob = String(ti.glob || ""); const p = String(ti.path || "");
  return !(TEXT_TARGET_RE.test(glob.toLowerCase()) || TEXT_TARGET_RE.test(p.toLowerCase()) || LOG_TARGET_RE.test(glob) || LOG_TARGET_RE.test(p));
}
// Block default-ON; VTS_GREP_BLOCK=0/false/off reverts the symbol-hunt escalation to warn-only.
const grepBlockOn = () => !/^(0|false|off|no)$/i.test(String(process.env.VTS_GREP_BLOCK ?? "1"));
// Truncate a caught pattern/command for display (the "what was intercepted" line).
const clip = (s, n = 56) => { s = String(s).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
// Concise block copy for a symbol-hunt Grep: what was caught · the ready semantic call · the win · opt-out.
function grepBlockMsg(ti) {
  const pat = String(ti.pattern || "");
  const ident = /^[A-Za-z_][A-Za-z0-9_]*$/.test(pat);
  const call = ident ? `find_references symbol="${pat}" / search_symbol q="${pat}"` : `search_text q="${clip(pat, 40)}"`;
  return KO
    ? `✨ vs-token-safer: 심볼검색 가로챔 (토큰↓·정확도↑) — /${clip(pat)}/\n→ ${call} — 시맨틱, file:line, 보통 ~90%↓ (정규식 거짓양성 없음). warn전환: VTS_GREP_BLOCK=0`
    : `✨ vs-token-safer: caught a symbol search (fewer tokens, exact) — /${clip(pat)}/\n→ ${call} — semantic, file:line, ~90% smaller (no regex false positives). Warn-only: VTS_GREP_BLOCK=0`;
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
    ? `✨ vs-token-safer: 파일명검색 가로챔 (거대 트리 타임아웃 방지) — \`${clip(ti.pattern)}\`\n→ ${call} — walk-bound(Intermediate/Binaries/node_modules 스킵)·토큰캡. warn전환: VTS_GREP_BLOCK=0`
    : `✨ vs-token-safer: caught a filename search (avoids giant-tree timeout) — \`${clip(ti.pattern)}\`\n→ ${call} — walk-bounded (skips Intermediate/Binaries/node_modules), token-capped. Warn-only: VTS_GREP_BLOCK=0`;
}
const LOG_NUDGE = KO
  ? "[vs-token-safer] 이 검색은 LOG가 대상입니다. 언어 서버 인덱스는 소스 코드만 다뤄요 — 로그 분석은 grep 대신 " +
    "gamedev-log를 쓰세요 (/gamedev-log-analyzer:logs, 또는 gamedev-log CLI: summary / search / locate / fields / diff). 끄기: VTS_ENFORCE=0."
  : "[vs-token-safer] This search targets a LOG. The language-server index only covers source code — for log " +
    "analysis use gamedev-log (/gamedev-log-analyzer:logs, or the gamedev-log CLI: summary / search / locate " +
    "/ fields / diff) instead of grep. Disable: VTS_ENFORCE=0.";

// Concise block copy for a Bash code-grep that couldn't be safely auto-rewritten (a pipeline / complex
// pattern). Shows: what was intercepted · the equivalent vts call (best-effort from the first code segment)
// · the typical token win · opt-out. Multi-part commands fall to a short tool list when no single call fits.
function suggestCallFor(seg) {
  const exec = execOf(seg);
  if (exec === "find") { const g = extractFindName(seg); return g ? `find_files q="${g}"` : null; }
  const pat = extractGrepPattern(seg, exec === "git");
  if (!pat) return null;
  if (IDENT.test(pat)) return `search_symbol q="${pat}" (or find_references symbol="${pat}")`;
  return `search_text q="${clip(pat, 40)}"`;
}
function blockMsg(codeSegs) {
  const seg = codeSegs[0] || "";
  const call = suggestCallFor(seg) || "search_symbol / search_text / find_files";
  const caught = clip(seg);
  return KO
    ? `✨ vs-token-safer: 코드검색 가로챔 (토큰 절약) — \`${caught}\`\n→ ${call} — file:line로 토큰캡, 보통 ~90%↓ (큰 repo면 20~60×), grep 거짓양성 없음.\n단일 grep은 자동 변환됨(이 건 멀티세그먼트라 차단). 끄기: VTS_ENFORCE=0`
    : `✨ vs-token-safer: caught a code search (saves tokens) — \`${caught}\`\n→ ${call} — token-capped to file:line, ~90% smaller (20–60× on a big repo), no grep false positives.\nA single grep auto-rewrites (this was multi-segment). Disable: VTS_ENFORCE=0`;
}

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

  // Edit / MultiEdit — L1 steer: a whole-DECLARATION edit (replace or add) gets a model-visible nudge with a
  // ready symbol-edit call, and is recorded in the adoption ledger. Non-blocking (the read is already sunk;
  // forcing a redo here recovers nothing — see the asymmetry note). L2 escalates to a block on the safe
  // insert subset once the streak shows the nudge is being ignored.
  if (toolName === "Edit" || toolName === "MultiEdit") {
    if (editWarnOn()) {
      const ce = classifyDeclEdit(toolName, ti, editMinLines());
      if (ce.file && (ce.replaceDecl || ce.insertDecl)) {
        // CC-complement: a whole-decl edit in a GENERATED / build-output path (Intermediate, Binaries,
        // *.generated.*, node_modules…) is fine with the native Edit — a symbol-edit there buys nothing.
        // Stay silent AND don't count it against adoption (it isn't a case we'd steer).
        if (shouldSuppressSteer(ce.file)) process.exit(0);
        const led = recordEditEvent("builtin-warn");
        // L2: an OPT-IN escalation. After VTS_EDIT_BLOCK_AFTER consecutive ignored nudges, BLOCK once on the
        // SAFE subset (a pure insert of a new declaration). DEFAULT OFF (0) — a persistent block TRAPPED the
        // agent: it kept fighting the wall with built-in Edit (re-anchoring, even restructuring code to dodge
        // the hook) instead of switching, and each blocked attempt re-escalated the streak. When it does fire
        // (user opted in with VTS_EDIT_BLOCK_AFTER≥1), it RESETS the streak so it's a one-time nudge-with-teeth,
        // not a wall. VTS_GREP_BLOCK=0 also holds it to warn (shares the master block switch).
        const after = Number(process.env.VTS_EDIT_BLOCK_AFTER);
        const threshold = Number.isFinite(after) && after >= 0 ? after : 0; // OFF by default (block traps the model)
        // ADAPTIVE controller (replaces the static `streak >= threshold`): escalate to the one-shot block only
        // when warns aren't converting AND the block is untried-or-proven-better; back off to warn if the block
        // has been tried and isn't helping (the "agent fights the wall" failure). Block stays on the SAFE
        // subset (a pure insert — insert_symbol can't corrupt) and the master grep-block switch.
        if (grepBlockOn() && ce.insertDecl && !ce.replaceDecl && decideEscalation(led, threshold)) {
          recordSteerShown("block"); // mark block as shown so its conversion (next symbol-edit?) is measured
          resetStreak(); // fire ONCE then back off — no permanent wall
          process.stderr.write(editNudgeFor(toolName, ti) + " (one-time block: warns weren't converting (streak " + led.streak + ", adaptive) — use insert_symbol (position=after|before) for this insert. Set VTS_EDIT_BLOCK_AFTER=0 to disable entirely.)" + setup + "\n");
          process.exit(2); // block — route the safe insert to a symbol-edit
        }
        recordSteerShown("warn"); // mark warn as shown so its conversion is measured by the controller
        emitWarn(editNudgeFor(toolName, ti) + setup);
      }
    }
    process.exit(0);
  }

  // Grep TOOL — enforcement v2 (A+): a clear SYMBOL HUNT is BLOCKED (semantic tool is strictly better);
  // everything else stays warn-only (Grep is the sanctioned fallback for freeform text / just-edited files).
  if (toolName === "Grep") {
    // qvts present → a code/symbol Grep is the orchestrator's job: block and hand back the qvts command (a
    // log/text-target Grep is left to the normal steer below).
    if (ORCH && !isLogGrepTool(ti) && notTextLogTarget(ti) && (isCodeGrepTool(ti) || isSymbolHuntGrep(ti))) {
      process.stderr.write(orchMsg(`find ${String(ti.pattern || "").slice(0, 120)} in code`, ti.path) + "\n");
      process.exit(2);
    }
    if (isLogGrepTool(ti)) emitWarn(LOG_NUDGE + setup);
    // OUTLINE hunt (declaration-KEYWORD alternation, e.g. `^(function|const|export)`, `^(class|struct|enum)`)
    // → steer to document_symbols (warn-only; keyword alts are FP-prone so never blocked). Checked BEFORE the
    // symbol-hunt block ON PURPOSE: a keyword-only alternation carries NO specific identifier, so it's an
    // outline, not a named-symbol hunt — but `isSymbolHuntGrep` would otherwise BLOCK it via its `\bclass\b`/
    // `\bstruct\b`/`\benum\b` cue (a mild pre-existing FP). `isOutlineHuntGrep` excludes CamelCase/snake, so a
    // real named hunt (`MaxWalkSpeed|MaxExcessSpeed`, `class Foo|struct Bar`) still falls through to the block.
    else if (isOutlineHuntGrep(ti) && notTextLogTarget(ti)) emitWarn(outlineNudgeFor(ti) + setup);
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
    if (ORCH && isCodeGlobTool(ti)) {
      // A Glob that NAMES a specific subdir (explicit `path`, or a literal dir prefix in the pattern) is a cheap,
      // correctly-scoped filename listing — native Glob honors that subdir and returns compact PATHS. Delegating
      // LOSES the scope (qvtsCmd resolves the target UP to the repo root and find_files the whole tree) and is
      // slower + wrong-tree — the same scope-loss the Bash `find <subdir> -name` case avoids by staying native.
      // The token mandate is about CONTENT, not file lists. A path-less glob (no scope to lose, giant-tree
      // timeout risk) still delegates. Exclude a bare `.`/`..` (cwd could itself be a huge root).
      const gscope = globRootHint(ti); // explicit path, else the glob's literal dir prefix
      if (gscope && !/^\.{1,2}[\\/]?$/.test(gscope)) process.exit(0); // scoped filename listing → native
      process.stderr.write(orchMsg(`find file named ${globBasename(ti.pattern)}`, ti.path || gscope) + "\n");
      process.exit(2);
    }
    if (grepBlockOn() && isBlockableGlob(ti)) {
      process.stderr.write(globBlockMsg(ti) + setup + "\n");
      process.exit(2); // block — route the concrete code-file glob to find_files
    }
    else if (isCodeGlobTool(ti)) emitWarn(globNudgeFor(ti) + setup);
    process.exit(0);
  }

  // Read — read-side steer (H1, warn-ONLY, never blocks): a whole-file Read of a LARGE code file is the dominant
  // pre-edit token leak. Point it at read_symbol / the symbol-edit tools. Tight-gated in policy.readSteerDecision
  // (code ext, not generated, not an already-sliced read, size ≥ threshold). VTS_READ_STEER=0 / matcher-removal off.
  if (toolName === "Read") {
    const fp = ti && ti.file_path;
    // (A) a Read tells us which project the agent is working in — record it so a later target-less qvts search
    // scopes to THIS project, not the broad vault/monorepo parent. Best-effort; never blocks a Read.
    if (ORCH && fp) { try { recordActiveProject(resolveSearchRoot(fp, orchRoot())); } catch { /* ignore */ } }
    if (fp) {
      let sz = 0; try { sz = fs.statSync(fp).size; } catch { /* unreadable → leave 0 (no steer) */ }
      const minB = Number(process.env.VTS_READ_STEER_MIN ?? 6000);
      const sliced = !!(ti.offset || ti.limit);
      let s = sz ? readSteerDecision(fp, sz, { sliced, minBytes: minB, ko: KO }) : null;
      // B: when the steer fires, upgrade the `<name>` placeholder to concrete read_symbol calls naming the
      // file's real top-level decls — a ready call converts better. Best-effort, bounded, never throws into
      // the hook; on any failure the placeholder nudge above stands.
      if (s) {
        let names = [];
        try { names = topLevelDeclNames(fs.readFileSync(fp, "utf8"), fp); } catch { /* keep the placeholder */ }
        if (names.length) s = readSteerDecision(fp, sz, { sliced, minBytes: minB, ko: KO, symbols: names });
      }
      if (s) emitWarn(s + setup);
    }
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
          additionalContext: KO
            ? `[vs-token-safer] \`${v.bin} ${v.sub}\` → vts ${v.tool}: 출력 그룹/dedup/토큰캡으로 절약. 끄기: VTS_COMPACT_VCS=0.`
            : `[vs-token-safer] \`${v.bin} ${v.sub}\` → vts ${v.tool}: output grouped/deduped/capped to save tokens. Disable: VTS_COMPACT_VCS=0.`,
        },
      }) + "\n");
      process.exit(0);
    }
  }

  // #5 honor excludeCommands — drop excluded execs from enforcement.
  const excluded = excludedCommands();
  // A `find` in a command that also runs a file-op (cp/tar/xargs/du/…) is plumbing for that op, not a code
  // search — exclude it so a backup/copy script isn't blocked (and isn't rerouted to a capped find_files).
  const fileOps = hasFileOpsContext(segments);
  const codeSegs = segments.filter(
    (s) => isCodeSearchSegment(s) && !excluded.has(excludeKeyOf(s)) && !(fileOps && execOf(s) === "find"),
  );

  if (codeSegs.length) {
    // qvts present → delegate the code search to the orchestrator, NOT the vts CLI (the bug this fixes: the
    // Bash path used to reroute to vts, so it never reached qvts, and the model bypassed via VTS_ENFORCE=0).
    // A single segment is transparently REWRITTEN to a `qvts` call (runs as qvts, nothing to bypass); a
    // pipeline blocks with the ready qvts command. No VTS_ENFORCE=0 advertised here.
    if (ORCH) {
      const seg = codeSegs[0];
      // Distinguish a CONTENT grep from a FILENAME `find -name`: the latter must become a find-FILES task
      // ("find file named …") so qvts routes it to find_files (bounded, skips Content/Intermediate). Phrasing a
      // filename find as "find <glob> in code" made qvts run a whole-tree TEXT walk for a mere file listing —
      // live: `find … -name "*.h"` burned the 40s time-box and returned junk, costing MORE than a native ls.
      const isFind = execOf(seg) === "find";
      const findGlob = isFind ? extractFindName(seg) : "";
      const findDir = isFind ? extractFindDir(seg) : "";
      // A filename `find <subdir> -name X` that NAMES a specific directory is a cheap, correctly-SCOPED listing:
      // native `find` honors that subdir and returns compact PATHS (not bulky content). Delegating it LOSES the
      // subdir scope (qvts would find_files the whole -p root) and is far slower + wrong-tree — measured 56s and
      // engine-wide *.h for a single-subdir listing. The token mandate is about CONTENT, not file lists — so let
      // a subdir-scoped filename find run natively (no redirect). Exclude a bare `.`/`..` (cwd could itself be a
      // huge UE root where native find would walk Content/) and a find with no dir operand — those still
      // delegate to find_files (skip-dirs + bounded).
      if (isFind && findGlob && findDir && !/^\.{1,2}[\\/]?$/.test(findDir)) process.exit(0);
      const isGitGrep = execOf(seg) === "git";
      const grepPat = isFind ? "" : extractGrepPattern(seg, isGitGrep); // never treat a find's path as a grep pattern
      // Carry the grep's own FILE or DIRECTORY scope into the task so qvts searches THAT file/dir (search_text
      // path=…), not the whole -p root. A file → basename hint (`grep Foo path/Bar.cpp` → "in Bar.cpp"); a DIR →
      // its path as given (`grep -r Foo Source` → "under Source"). A bare-dir operand used to be dropped, so a
      // dir-scoped grep degraded to "find Foo in code" = a whole-tree scan (the scope-loss bug this fixes).
      const { file: searchFile, dir: searchDir } = isFind ? { file: null, dir: null } : extractGrepScope(seg, isGitGrep);
      const inScope = searchFile ? ` in ${path.basename(searchFile)}`
        : searchDir ? ` under ${searchDir}`
        : " in code";
      const task = grepPat ? `find ${grepPat}${inScope}`
        : findGlob ? `find file named ${findGlob}`
        : "locate the searched symbol/string in code";
      const target = searchFile || searchDir || findDir; // a file/dir the command names → generalize the root
      if (segments.length === 1) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            permissionDecisionReason: "Rerouted code search → local orchestrator (qvts): the raw search stays in the local model, only a compact answer returns to Claude.",
            updatedInput: { ...ti, command: qvtsCmd(task, target) },
            additionalContext: orchMsg(task, target),
          },
        }) + "\n");
        process.exit(0);
      }
      process.stderr.write(orchMsg(task, target) + "\n");
      process.exit(2);
    }
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
            additionalContext: KO
              ? `[vs-token-safer] grep → vts ${rw.tool} q="${rw.q}" — file:line 토큰캡(보통 ~90%↓). 심볼이면 search_symbol(시맨틱) 권장. 끄기: VTS_REWRITE=0.`
              : `[vs-token-safer] grep → vts ${rw.tool} q="${rw.q}" — token-capped file:line (~90% smaller). For symbols prefer search_symbol (semantic). Disable: VTS_REWRITE=0.`,
          },
        }) + "\n");
        process.exit(0);
      }
    }
    process.stderr.write(blockMsg(codeSegs) + setup + "\n");
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
          additionalContext: KO
            ? `[vs-token-safer] grep ${dr.file} → vts text --path ${dr.file} (q="${dr.q}") — 토큰캡. 끄기: VTS_REWRITE=0.`
            : `[vs-token-safer] grep ${dr.file} → vts text --path ${dr.file} (q="${dr.q}") — token-capped. Disable: VTS_REWRITE=0.`,
        },
      }) + "\n");
      process.exit(0);
    }
  }
  if (segments.some(isLogSearchSegment)) {
    emitWarn(LOG_NUDGE + setup);
    process.exit(0); // logs were never blocked — just point at the right tool
  }
  // Bash-based code-file EDIT (sed -i / awk inplace / python-write heredoc) — the model doing file surgery
  // that bypasses the Edit-tool steer. Warn-only (never block — blocking mid-refactor would strand it),
  // gated by the same VTS_EDIT_WARN switch as the Edit-tool steer.
  if (editWarnOn() && isBashCodeEdit(cmd)) {
    emitWarn(bashEditNudge() + setup);
    process.exit(0);
  }
  // Bash-based code BODY DUMP (read-only sed -n 'X,Yp' / cat / head / tail / awk over a code file) — the same
  // context leak the Read-tool steer catches, through a side door none of the search hooks cover (live: a
  // model ranged-read engine headers with `sed -n '170,260p'`, ~90 raw lines per call, right after a properly
  // delegated locate). Warn-only, same VTS_READ_STEER switch as the Read-tool steer.
  if (readSteerOn()) {
    const br = segments.find(isBashCodeBodyRead);
    if (br) emitWarn(bodyReadNudge(br) + setup);
  }
  process.exit(0);
});
