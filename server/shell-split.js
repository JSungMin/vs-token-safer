/*
 * Quote-aware shell command splitting — shared by the PreToolUse hook (rewrite/block decisions) and
 * vts discover (bypass measurement) so both see the SAME segments. Cut on |, ||, &&, ;, &, newline ONLY
 * outside single/double quotes: a pipe inside quotes is part of a grep pattern, not a pipeline. Inside
 * double quotes `\"` is an escaped literal quote (bash semantics), so it doesn't close the context;
 * single quotes have no escapes.
 */
// A HEREDOC BODY is data, not commands. Without this, `cat > t.mjs <<'EOF' … grep -n "X" f.cs … EOF` had its
// body lines split into segments and a string that merely MENTIONS a grep was blocked as a code search (hit live
// while writing test scripts). After a `<<[-]WORD` / `<<'WORD'` / `<<"WORD"` operator, the lines up to the one
// that is exactly WORD (leading tabs allowed for `<<-`) are skipped.
export function splitSegments(cmd) {
  const out = [];
  let cur = "", q = null;
  const pending = []; // heredoc terminators waiting for the end of the current line
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (q === '"' && c === "\\" && i + 1 < cmd.length) { cur += c + cmd[i + 1]; i++; continue; }
      cur += c; if (c === q) q = null; continue;
    }
    if (c === "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<") {
      const m = /^<<(-?)\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(cmd.slice(i));
      if (m) { pending.push({ tag: m[3], dash: m[1] === "-" }); cur += m[0]; i += m[0].length - 1; continue; }
    }
    if (c === "\n" && pending.length) {
      // skip every pending body, in order, then resume at the line after the last terminator
      let j = i + 1;
      for (const { tag, dash } of pending) {
        for (;;) {
          const nl = cmd.indexOf("\n", j);
          const line = cmd.slice(j, nl === -1 ? cmd.length : nl);
          j = nl === -1 ? cmd.length : nl + 1;
          if ((dash ? line.replace(/^\t+/, "") : line) === tag || nl === -1) break;
        }
      }
      pending.length = 0;
      out.push(cur); cur = "";
      i = j - 1;
      continue;
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
