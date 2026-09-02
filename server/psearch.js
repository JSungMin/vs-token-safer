/*
 * psearch.js — recognise a POWERSHELL code search. PURE (string in, verdict out; no fs, no spawn) so the
 * enforcement hook and `vts discover` classify the same command the same way, and so it is unit-testable.
 *
 * Why this exists: this Claude Code environment exposes a `PowerShell` tool ALONGSIDE `Bash`. The PreToolUse
 * matcher listed only `Bash|Grep|Glob|Edit|MultiEdit|Read`, so a code search run as
 * `Select-String -Path <dir>\Foo.h -Pattern "A|B|C"` never reached the hook at all — and even fed in directly
 * the hook exited 0, because it only parses grep/rg/ack/ag/findstr/`git grep`/`find -name`. So the whole
 * channel was unenforced AND uncounted: the "share of search tokens routed through vts" that discover reports
 * was computed over a channel set that excluded it.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: rewrite the command. The Bash path rewrites a safe single segment into
 * the equivalent `vts` call, which works because `shell-split.js` understands POSIX quoting. PowerShell is a
 * different language — backtick escapes, `$d` interpolation, `$(...)` subexpressions, abbreviated parameters
 * (`-Pat` binds to `-Pattern`), positional binding, `@(...)` arrays. A parser good enough to rewrite safely is
 * a real PowerShell parser; a naive one silently rewrites into a DIFFERENT search, and a wrong answer the
 * model believes is worse than no interception. So this only ever classifies, and the caller emits a
 * ready-to-use vts call for the model to run itself.
 */

// Code-file extensions worth intercepting — kept in step with the Bash side's CODE_FILE_TOKEN.
const CODE_EXT = "c|cc|cxx|cpp|h|hpp|hh|hxx|inl|ipp|tpp|cs|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi|go|rs|java|kt|rb|php|swift|scala|m|mm";
const CODE_EXT_RE = new RegExp(`\\.(${CODE_EXT})\\b`, "i");
const CODE_GLOB_RE = new RegExp(`\\*\\.(${CODE_EXT})\\b`, "i");
// Paths that are NOT source: logs, build output, dependencies. A search there is legitimately raw.
// The directory alternative is end-anchored as well as separator-terminated: a target may NAME the excluded
// directory as its last segment (`... -Filter *.cpp C:\repo\Intermediate`), which a `[\\/]dir[\\/]` pattern
// alone misses — and that is precisely the build-output case we must not intercept.
const TEXT_TARGET_RE = /\.(log|jsonl|txt|md|csv|xml|json|ya?ml|ini|cfg|toml)\b|[\\/](logs?|saved|intermediate|binaries|build|dist|out|obj|bin|node_modules|\.git|deriveddatacache)([\\/"']|\s|$)/i;

// Cmdlets (and aliases) that SEARCH CONTENT / LIST FILES.
const CONTENT_CMDLETS = /(^|[\s;(|{])(select-string|sls)(\s|$)/i;
const FILE_CMDLETS = /(^|[\s;(|{])(get-childitem|gci|ls|dir)(\s|$)/i;

// Cmdlets that MUTATE or move files. Their presence means the command is doing file-ops plumbing (a backup, a
// copy, a cleanup) and any file list it builds feeds that op — intercepting it would be wrong, and steering it
// to a token-CAPPED listing would silently drop files from the operation. Same reasoning as the Bash
// `hasFileOpsContext` guard, which was added after a real UE-depot backup got blocked.
const FILE_OPS_RE =
  /(^|[\s;(|{])(copy-item|move-item|remove-item|rename-item|new-item|set-content|add-content|out-file|compress-archive|expand-archive|robocopy|xcopy|start-process|invoke-webrequest|export-csv|set-acl|clear-content)(\s|$)/i;

// Is the search cmdlet being fed by a PIPE? `<something> | Select-String foo` filters the OUTPUT of another
// command (a build log, `git log`, a CSV) — that is ordinary text filtering, not a code search, and vts has
// nothing better to offer. Only a Select-String that reads FILES ITSELF is in scope.
function pipedInto(cmd, cmdletRe) {
  // Look for a `|` that appears before the cmdlet with no intervening `;` (a new statement resets the pipeline).
  const m = cmdletRe.exec(cmd);
  if (!m) return false;
  const before = cmd.slice(0, m.index);
  const lastSemi = Math.max(before.lastIndexOf(";"), before.lastIndexOf("{"));
  return before.slice(lastSemi + 1).includes("|");
}

// The value of a named parameter, tolerating PowerShell's prefix binding (`-Pat` → `-Pattern`) and both quote
// styles. Returns "" when absent. Only the FIRST value is taken — an array (`-Path a,b`) yields the first,
// which is enough to decide "is this source code", never to rebuild the command.
function paramValue(cmd, full, minLen) {
  const alt = [];
  for (let n = minLen; n <= full.length; n++) alt.push(full.slice(0, n));
  const re = new RegExp(`-(?:${alt.join("|")})\\s+("([^"]*)"|'([^']*)'|([^\\s,;|]+))`, "i");
  const m = re.exec(cmd);
  if (!m) return "";
  return (m[2] ?? m[3] ?? m[4] ?? "").trim();
}

// Anything that looks like a filesystem target in the command: an explicit -Path/-LiteralPath, else a quoted
// or bare token carrying a code extension or a path separator. Used only to decide whether the search is
// aimed at SOURCE — not to reconstruct a scope.
function targetsOf(cmd) {
  const out = [];
  for (const p of [["path", 2], ["literalpath", 2]]) {
    const v = paramValue(cmd, p[0], p[1]);
    if (v) out.push(v);
  }
  const tok = /("([^"]*[\\/][^"]*)"|'([^']*[\\/][^']*)'|([\w.$:{}\\/-]*[\\/][\w.${}\\/-]+))/g;
  let m;
  while ((m = tok.exec(cmd))) {
    const v = (m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

// The hunted pattern: -Pattern when named, else the first quoted string that is not a path. Best-effort — it
// is shown back to the model in the suggested call, never executed.
function patternOf(cmd) {
  const named = paramValue(cmd, "pattern", 3);
  if (named) return named;
  const q = /"([^"]+)"|'([^']+)'/g;
  let m;
  while ((m = q.exec(cmd))) {
    const v = (m[1] ?? m[2] ?? "").trim();
    if (v && !/[\\/]/.test(v) && !/^\$/.test(v)) return v;
  }
  return "";
}

// A CamelCase / snake_case identifier in the pattern makes this a named-symbol hunt (search_symbol territory)
// rather than freeform text. Mirrors the Bash side's symbol-hunt cue; an ALL-CAPS keyword alternation
// (`TODO|FIXME`, `GET|POST`) carries no such signal and stays freeform on purpose.
// The `[A-Z]+[a-z0-9]+[A-Z]` alternative (not `[A-Z][a-z0-9]+[A-Z]`) is what admits the Unreal prefix
// convention — FConeConstraint, UStaticMesh, ATestActor, IInterface, TArray — where two capitals lead.
const IDENT_RE = /\b([a-z]+[A-Z][A-Za-z0-9]*|[A-Z]+[a-z0-9]+[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*_[a-z0-9_]+)\b/;

// The pattern must BE a symbol, not merely CONTAIN one. Containment was too loose in exactly the way the Bash
// side already guards against: `"// TODO: FixMe later"` is prose, and offering `search_symbol q="FixMe"` for it
// answers a different question. So every alternative of the pattern must itself be an identifier, an optionally
// scoped one (`Foo::Bar`), or a structural declaration cue (`struct FConeConstraint`) — mirroring
// isSymbolHuntGrep's whole-pattern rule on the Grep tool.
const WHOLE_SYM_RE = /^(?:(?:struct|class|enum|union|namespace|typedef|interface)\s+)?[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$/;
export function symbolIn(pattern) {
  const raw = String(pattern || "").trim();
  if (!raw) return "";
  const parts = raw.split("|").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return "";
  if (!parts.every((p) => WHOLE_SYM_RE.test(p))) return ""; // any prose/regex alternative → not a symbol hunt
  for (const p of parts) {
    const m = IDENT_RE.exec(p);
    if (m) return m[1]; // the first alternative carrying a real identifier shape names the hunt
  }
  return "";
}

/**
 * Classify a PowerShell command. Returns null when it is not a code search we should speak up about, else
 * { kind: "content"|"files", pattern, target, symbol } — `symbol` non-empty when it reads as a named-symbol
 * hunt. Conservative by construction: every ambiguity resolves to null (stay quiet).
 */
export function classifyPowerShellSearch(command) {
  const cmd = String(command || "");
  if (!cmd.trim()) return null;
  // Cheap pre-check before any parsing: this hook runs on EVERY PowerShell call, and in a real transcript
  // corpus the overwhelming majority are Set-Location / Stop-Process / Get-Process / Add-Type — nothing to
  // classify. One substring test skips the regex work for them.
  if (!/select-string|\bsls\b|get-childitem|\bgci\b|\bdir\b|\bls\b/i.test(cmd)) return null;
  if (FILE_OPS_RE.test(cmd)) return null; // plumbing for a file operation, not a search-to-read
  // INVERTED match: `-NotMatch` returns the lines that do NOT match. Any call we suggest would return the
  // complement of what was asked — a wrong answer the model would believe, which is the precise hazard this
  // module exists to avoid. Never speak up.
  if (/-notmatch\b/i.test(cmd)) return null;
  // SCRIPTED VALUE, not a search-to-read: `-Quiet` yields a boolean, `.LineNumber`/`.Count`/`.Matches` pull a
  // field, `$x = (Select-String …)` captures into a variable, and an `if (…)` uses it as a test. No bulk text
  // ever reaches the context window, so there are no tokens to save — and none of the vts tools can return a
  // value INTO a PowerShell variable, so steering would just break a working script. Same lesson as the Bash
  // side's file-ops guard, which exists because a real depot backup got blocked.
  if (/-quiet\b/i.test(cmd)) return null;
  if (/\)\s*\.\s*(linenumber|count|matches|line|path|filename)\b/i.test(cmd)) return null;
  if (/\$\w+\s*=\s*\(?\s*(select-string|sls|get-childitem|gci)\b/i.test(cmd)) return null;
  if (/\bif\s*\(/i.test(cmd)) return null;

  const targets = targetsOf(cmd);
  const codeTarget = targets.some((t) => CODE_EXT_RE.test(t) || CODE_GLOB_RE.test(t));
  const textTarget = targets.some((t) => TEXT_TARGET_RE.test(t)) || TEXT_TARGET_RE.test(cmd);

  if (CONTENT_CMDLETS.test(cmd)) {
    if (pipedInto(cmd, CONTENT_CMDLETS)) return null; // filtering another command's output
    if (textTarget) return null; // a log/doc/config search is legitimately raw
    // Needs SOME filesystem target: a bare `Select-String -Pattern x` with nothing to read is not ours.
    if (!targets.length) return null;
    // A path with no code extension can still be a source DIRECTORY; require either a code file, a code glob,
    // or a directory-looking target combined with a code-ish pattern. Otherwise stay quiet.
    const pattern = patternOf(cmd);
    const dirTarget = targets.some((t) => /[\\/]/.test(t) && !/\.\w{1,5}$/.test(t));
    if (!codeTarget && !dirTarget) return null;
    return { kind: "content", pattern, target: targets[0] || "", symbol: symbolIn(pattern) };
  }

  if (FILE_CMDLETS.test(cmd)) {
    // Only a RECURSIVE listing filtered to code files is a find_files case. A plain `ls` / `Get-ChildItem` of
    // one directory is how anyone looks around — never intercept that.
    if (!/-r(ec|ecu|ecur|ecurs|ecurse)?\b/i.test(cmd)) return null;
    const filt = paramValue(cmd, "filter", 3) || paramValue(cmd, "include", 3);
    const glob = CODE_GLOB_RE.test(filt) ? filt : CODE_EXT_RE.test(filt) ? filt : "";
    if (!glob) return null;
    if (textTarget) return null;
    return { kind: "files", pattern: glob, target: targets[0] || "", symbol: "" };
  }

  return null;
}
