/*
 * gamedev-log-analyzer — log-grep enforcement engine (pure, testable).
 *
 * Decides whether a Bash command is a raw text-dump of a LOG file (grep/tail/cat/… over a `.log` /
 * `.jsonl` / Logs dir) that should instead go through `gamedev-log` (parse + dedup + token-cap).
 * The PreToolUse hook (hooks/block-log-grep.mjs) imports this; the eval imports it too. Keeping the
 * logic here (not inline in the hook) is what makes it unit-testable.
 *
 * Mode is read the same way core.js reads config: env GDLOG_ENFORCE > ~/.gamedev-log-analyzer/config.json
 * "enforce" > default "block". Modes: "block" (deny + nudge), "warn" (allow + nudge), "off" (allow).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Text-dump executables that flood raw log lines into context. `node`/`gamedev-log` are NOT here, so
// the analyzer's own invocations never trip the hook.
export const READ_EXECS = new Set(["grep", "rg", "ack", "ag", "findstr", "tail", "head", "cat"]);

export function execOf(segment) {
  const tokens = String(segment).trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++; // skip FOO=bar prefixes
  let exec = (tokens[i] || "").toLowerCase();
  exec = exec.replace(/^.*[\\/]/, "").replace(/\.(exe|bat|cmd|ps1)$/, ""); // basename, drop win ext
  return exec;
}

// A log target = a `.log` / `.jsonl` / rotated `.log.N` file, or a path under a Logs/Saved/Logs dir.
// `.json` is intentionally excluded (configs); only line-delimited `.jsonl` counts as a log.
function hasLogTarget(s) {
  return (
    /\.(log|jsonl)\b/.test(s) ||
    /\.log\.\d+\b/.test(s) ||
    /(^|[\s"'/\\])(saved[\\/]logs|logs)[\\/]/.test(s)
  );
}

// A small bounded peek (`tail -8`, `head -20`, default-10 `tail`) or a count-only read (`grep -c`,
// `rg -c`) cannot flood context regardless of file size — its output is a handful of lines or a single
// number. Blocking it would be friction with zero token win (violates token-first), so it passes. This
// mirrors the Read-tool slice escape (offset/limit always allowed). Unbounded reads — `cat`, a bare
// `grep`, `tail -f`, `tail -n +N` (from a line to EOF), a large `-n N`, or `tail -c <bigbytes>` — still
// block, since those are the actual floods the analyzer exists to replace.
const BOUNDED_PEEK_LINES = 50;
const BOUNDED_PEEK_BYTES = 8192;
export function isBoundedRead(segment) {
  const exec = execOf(segment);
  const s = String(segment);
  // count-only matchers: output is a count, never a line dump (findstr has no count flag).
  if ((exec === "grep" || exec === "rg") && /(^|\s)(-c|--count)\b/.test(s)) return true;
  if (exec === "tail" || exec === "head") {
    if (/(^|\s)(-f|--follow)\b/.test(s)) return false; // live stream — unbounded
    if (/-n\s*\+\d+|--lines[=\s]+\+\d+/.test(s)) return false; // tail -n +N → reads to EOF
    const mc = s.match(/-c\s*(\d+)|--bytes[=\s]+(\d+)/); // byte count
    if (mc) return Number(mc[1] || mc[2]) <= BOUNDED_PEEK_BYTES;
    const m =
      s.match(/--lines[=\s]+(\d+)/) || s.match(/-n\s*(\d+)/) || s.match(/(?:^|\s)-(\d+)\b/);
    const n = m ? Number(m[1]) : 10; // tail/head default to 10 lines
    return n <= BOUNDED_PEEK_LINES;
  }
  return false;
}

export function isLogReadSegment(segment) {
  const exec = execOf(segment);
  if (!READ_EXECS.has(exec)) return false;
  if (!hasLogTarget(String(segment).toLowerCase())) return false;
  return !isBoundedRead(segment); // a bounded peek / count-only read isn't a flood
}

// A bare file path that is a log target (for the Read-tool branch, where there's no shell exec).
export function isLogPath(p) {
  return hasLogTarget(String(p || "").toLowerCase());
}

// Coarse volume gate for the Read tool: a log at/above this many bytes is worth steering to the
// analyzer (~3-5k tokens raw). Below it, a raw Read is cheap — let it through. Size is a blunt signal
// (it misses redundancy), but it's the only thing knowable WITHOUT reading the file. Hardcoded on
// purpose — no config key until there's evidence anyone needs to tune it.
export const READ_MIN_BYTES = 200_000;

// Decision for the `Read` tool. PURE — the caller supplies the file size and whether a slice
// (offset/limit) was requested, so this never touches the filesystem (the hook does the stat and
// fails open on any error). Intercept only an UNBOUNDED read of a LARGE LOG; a slice always passes,
// which is the one-step escape hatch (Read again with offset/limit) and Claude's fallback when the
// analyzer parses a format poorly.
export function shouldBlockRead(filePath, sizeBytes, sliced) {
  if (!filePath || sliced) return false;
  if (!isLogPath(filePath)) return false;
  return Number(sizeBytes) >= READ_MIN_BYTES;
}

// Shell variables assigned a LOG-PATH literal anywhere in the command. This closes the indirection
// hole: `log="…/Editor.log"; tail -3 "$log" | grep err` puts the path in the ASSIGNMENT segment and the
// read in a LATER segment, so per-segment matching alone misses it. We bind the var to the log here,
// then a read-exec that dereferences that exact var counts as a log read. High precision: we require
// BOTH a log-literal RHS AND a deref-by-a-read-exec (a bare `echo "$log"` is not a flood, not blocked).
// The boundary `(?:^|[\s;&|(])` avoids matching inside `--flag=x.log` (no var binding for CLI flags).
export function collectLogVars(cmd) {
  const vars = new Set();
  const re = /(?:^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s;&|]*))/g;
  let m;
  while ((m = re.exec(String(cmd || ""))) !== null) {
    const rhs = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || "";
    if (rhs && hasLogTarget(rhs.toLowerCase())) vars.add(m[1]);
  }
  return vars;
}

// Does this segment dereference one of the bound log-vars ($VAR, ${VAR}, "$VAR")?
function segDerefsLogVar(segment, vars) {
  if (!vars.size) return false;
  const re = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;
  let m;
  while ((m = re.exec(String(segment))) !== null) if (vars.has(m[1])) return true;
  return false;
}

// True if ANY shell segment is a raw log read — either a direct literal in a read-exec segment
// (`tail x.log | grep err`), or a read-exec dereferencing a var bound to a log path earlier in the
// command (`log="x.log"; tail "$log"`).
export function shouldBlockLogBash(cmd) {
  const c = String(cmd || "");
  const segments = c.split(/\|\||&&|[|;&\n]/g);
  const logVars = collectLogVars(c);
  return segments.some((seg) => {
    if (!seg.trim()) return false;
    if (isLogReadSegment(seg)) return true; // direct log-path literal in a read-exec segment
    // var-bound log path — same bounded-peek exemption as the direct case
    return READ_EXECS.has(execOf(seg)) && !isBoundedRead(seg) && segDerefsLogVar(seg, logVars);
  });
}

// ---- #1 transparent rewrite (mirrors vs-token-safer): a single raw log-read segment → the equivalent
// gamedev-log CLI command, run via updatedInput. The model's flow is unbroken AND the output is
// guaranteed parsed/dedup/token-capped instead of a raw flood. Returns { cmd, tool, path, q? } or null
// when ANYTHING is ambiguous — the caller then falls back to the warn/block path, so a rewrite is never
// wrong. Conservative on purpose: one clean unquoted segment, a shell-safe literal log path, no shell
// metachars/vars/redirects (those can't be safely rewritten → let them warn).
const SAFE_LOG_PATH = /^[A-Za-z0-9_./:\\-]+$/; // unquoted literal path, no spaces/vars/metachars
const SAFE_QUERY = /^[A-Za-z0-9_.:-]+$/; // shell-safe literal grep pattern (also a valid literal regex)
const GREP_EXECS = new Set(["grep", "rg", "ack", "ag", "findstr"]);
// short flags that consume a value → pattern position is unclear, so bail. Covers grep (-e -m -A/-B/-C
// -D -d -f) AND ripgrep (-t -T -g -M type/glob/max-columns), so e.g. `rg -t log PAT x.log` won't mis-parse.
const VALUE_FLAG_LETTERS = /[efmABCDdtTgM]/;

function segHasShellHazard(seg) {
  // a var, command-subst, quote, redirect, glob, brace, or line-continuation means we can't rewrite safely
  return /[$`"'><(){}*?]/.test(seg) || /\\\s*$/.test(seg);
}
function isLogPathToken(t) {
  return SAFE_LOG_PATH.test(t) && hasLogTarget(t.toLowerCase());
}

export function buildLogRewrite(segment, cliPath) {
  const seg = String(segment).trim();
  if (!cliPath || segHasShellHazard(seg)) return null;
  const exec = execOf(seg);
  if (!READ_EXECS.has(exec)) return null;
  if (isBoundedRead(seg)) return null; // a bounded peek / count-only read isn't a flood → leave it raw
  const toks = seg.split(/\s+/);
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++; // FOO=bar prefixes
  i++; // the executable
  const rest = toks.slice(i);
  const node = (args) => `node "${cliPath}" ${args}`;

  if (GREP_EXECS.has(exec)) {
    // walk flags (vts-style); first bare token = PATTERN, the log path is a later bare token.
    let pat = null;
    const paths = [];
    for (const t of rest) {
      if (t === "--" || t.startsWith("--")) return null; // option terminator / unknown long flag → bail
      if (exec === "findstr" && t.startsWith("/")) continue; // findstr flags use /
      if (t.startsWith("-")) {
        if (VALUE_FLAG_LETTERS.test(t)) return null; // value-taking short flag → pattern position unclear
        continue; // boolean short-flag cluster (-rn, -i …)
      }
      if (pat === null) pat = t;
      else paths.push(t);
    }
    if (!pat || !SAFE_QUERY.test(pat)) return null;
    const logs = paths.filter(isLogPathToken);
    if (logs.length !== 1) return null; // 0 or >1 log path → ambiguous
    // severityMin Verbose so the reroute keeps grep's "any line containing the term" semantics.
    return { cmd: node(`search --path "${logs[0]}" --query "${pat}" --severityMin Verbose`), tool: "search", path: logs[0], q: pat };
  }

  // cat / tail / head — only UNBOUNDED reads reach here (bounded peeks are exempt). Reroute to summary.
  const paths = [];
  for (let k = 0; k < rest.length; k++) {
    const t = rest[k];
    if (t === "--") {
      for (const p of rest.slice(k + 1)) if (!p.startsWith("-")) paths.push(p);
      break;
    }
    if (/^-[nc]$/.test(t)) {
      k++;
      continue;
    } // -n N / -c N consume the next token
    if (t.startsWith("-")) continue; // -n50 / -f / --lines=50 / etc.
    paths.push(t);
  }
  const logs = paths.filter(isLogPathToken);
  if (logs.length !== 1) return null;
  return { cmd: node(`summary --path "${logs[0]}"`), tool: "summary", path: logs[0] };
}

// ---- mode (env > config.json > default) ----
const CONFIG_FILE =
  process.env.GDLOG_CONFIG_FILE || path.join(os.homedir(), ".gamedev-log-analyzer", "config.json");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

const VALID_MODES = ["block", "warn", "off"];

// Normalize loose aliases so `on/1/true` → block, `0/false/none` → off.
export function normalizeMode(v) {
  const m = String(v || "").toLowerCase().trim();
  if (["off", "0", "false", "none", "allow"].includes(m)) return "off";
  if (["warn", "nudge", "soft"].includes(m)) return "warn";
  if (["block", "on", "1", "true", "deny", "hard"].includes(m)) return "block";
  return null;
}

// Default is "warn": nudge toward the analyzer but never deny. The hard-block guarantee was always
// porous (the Grep tool / MCP search / Read bypass enforcement entirely), so paying friction for it
// violated token-first. Opt into hard denial with `gamedev-log enforce block` / GDLOG_ENFORCE=block.
export function enforceMode() {
  const env = process.env.GDLOG_ENFORCE;
  if (env !== undefined && env !== "") return normalizeMode(env) || "warn";
  const fromCfg = readConfig().enforce;
  if (fromCfg !== undefined && fromCfg !== null && fromCfg !== "") return normalizeMode(fromCfg) || "warn";
  return "warn"; // default: nudge, don't deny
}

export function enforceSource() {
  if (process.env.GDLOG_ENFORCE !== undefined && process.env.GDLOG_ENFORCE !== "") return "env GDLOG_ENFORCE";
  if (readConfig().enforce != null && readConfig().enforce !== "") return CONFIG_FILE;
  return "default";
}

// Persist mode into config.json (merge-preserving other keys). Returns the written mode.
export function writeEnforceMode(mode) {
  const norm = normalizeMode(mode);
  if (!norm) throw new Error(`mode must be one of: ${VALID_MODES.join(" | ")} (or on/off aliases)`);
  const cur = readConfig();
  cur.enforce = norm;
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cur, null, 2));
  return norm;
}

// The nudge shown when a raw log read is intercepted. One source of truth for the hook + tests.
// `kind` ∈ {"bash","read"} controls the wording and the escape hatch so the message never lies about
// how the read happened. `target` is the command (bash) or the file path (read).
export function nudgeText(target, kind = "bash") {
  const t = String(target || "");
  const how = kind === "read" ? "a large log via the Read tool" : "a raw log read via Bash";
  const head = "[gamedev-log-analyzer] Intercepted " + how + (t ? `:\n  ${t.slice(0, 200)}` : "");
  const pathRef = kind === "read" && t ? t : "<log>";
  const tools =
    "\nUse gamedev-log instead — it parses, dedups, and token-caps the log " +
    "(a multi-MB log → a few hundred tokens) rather than dumping raw lines into context:\n" +
    `  - severity + category rollup   -> gamedev-log summary --path ${pathRef}\n` +
    `  - search / dedup groups        -> gamedev-log search  --path ${pathRef} --severityMin Warning\n` +
    `  - build warnings by code       -> gamedev-log search  --path ${pathRef} --groupBy code\n` +
    `  - jump list (file:line only)   -> gamedev-log locate  --path ${pathRef}\n` +
    `  - scalar fields over time      -> gamedev-log fields  --path ${pathRef} --fields ts,<Key>\n`;
  const escape =
    kind === "read"
      ? "Genuinely need the raw bytes? Re-run Read with `offset`/`limit` for a bounded slice (always " +
        `allowed), or peek with \`gamedev-log tail --path ${pathRef}\`, or lower enforcement: ` +
        "`gamedev-log enforce warn|off`."
      : "Genuinely need the raw bytes? Lower enforcement: `gamedev-log enforce warn` (nudge only) or " +
        "`gamedev-log enforce off` (allow), or set GDLOG_ENFORCE=off for this shell.";
  return head + tools + escape;
}
