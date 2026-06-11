/*
 * Quote-aware shell command splitting — shared by the PreToolUse hook (rewrite/block decisions) and
 * vts discover (bypass measurement) so both see the SAME segments. Cut on |, ||, &&, ;, &, newline ONLY
 * outside single/double quotes: a pipe inside quotes is part of a grep pattern, not a pipeline. Inside
 * double quotes `\"` is an escaped literal quote (bash semantics), so it doesn't close the context;
 * single quotes have no escapes.
 */
export function splitSegments(cmd) {
  const out = [];
  let cur = "", q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (q === '"' && c === "\\" && i + 1 < cmd.length) { cur += c + cmd[i + 1]; i++; continue; }
      cur += c; if (c === q) q = null; continue;
    }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === "|" || c === ";" || c === "&" || c === "\n") {
      if (c === "|" && cmd[i + 1] === "|") i++;
      else if (c === "&" && cmd[i + 1] === "&") i++;
      out.push(cur); cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.filter((s) => s.trim());
}
