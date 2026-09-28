/*
 * PASSTHROUGH COMPACTION (the rtk model, applied to code search). The hook used to BLOCK a Bash code search it
 * could not translate exactly into a vts call, which hands the choice back to the model — and a model given a
 * block converts almost never (measured: 2 of 1,694 warnings acted on). rtk never asks: it runs the SAME command
 * and only shrinks what comes back. So for every search we cannot translate, the hook now wraps the ORIGINAL
 * command and pipes its output through `vts squeeze`: the real grep runs with the real semantics, and only the
 * output is compacted (grouped by file, long lines clipped, capped, the full text teed to a file). No
 * equivalence proof is needed because nothing is re-interpreted.
 *
 * PURE: string → string. The CLI (`vts squeeze`) owns stdin, the tee file and the ledger.
 */

// The wrapped command appends this line so the ORIGINAL exit status survives the pipe (grep exits 1 on "no
// match", and a caller may branch on it). POSIX sh has no portable pipefail, and pipefail would also turn a
// harmless SIGPIPE inside the original command (`grep | head`) into a failure.
export const RC_MARK = "__VTS_RC=";

// `{ { <cmd>\n} 2>&1; printf …rc…; } | node cli squeeze`. The newline before the closing brace lets a heredoc
// or a trailing comment in <cmd> end cleanly.
export function wrapCommand(cmd, cliPath) {
  return `{ { ${cmd}\n} 2>&1; printf '\\n${RC_MARK}%s\\n' "$?"; } | node "${cliPath}" squeeze`;
}

// Split a trailing rc marker off the captured text. No marker (the command called `exit` itself) → rc null.
export function splitRc(text) {
  const s = String(text || "");
  const m = /\n?__VTS_RC=(\d+)\s*$/.exec(s);
  if (!m) return { body: s, rc: null };
  return { body: s.slice(0, m.index), rc: Number(m[1]) };
}

// grep/rg/git-grep output line: `path:line:text`, `path:line-text` (context), or `path:text`. A Windows drive
// letter is part of the path, not a separator.
const LOC = /^((?:[A-Za-z]:)?[^:\n]*?[^\s:][^:\n]*):(\d+)([:-])(.*)$/;
const PLAIN = /^((?:[A-Za-z]:)?[^:\n]*?\.[A-Za-z0-9_]{1,8}):(.*)$/;

const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

// Compact captured output. Grep-shaped lines are grouped under one header per file (the path is not repeated on
// every row) and their text trimmed + clipped; anything else passes through clipped. The whole result is capped
// at maxLines rows. Returns { text, truncated, rawLines }.
export function squeezeOutput(text, { maxLines = 80, maxLineChars = 160 } = {}) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const rawLines = lines.length;
  if (!rawLines) return { text: "", truncated: false, rawLines: 0 };

  const out = [];
  let cur = null;
  let grepRows = 0;
  for (const ln of lines) {
    const m = LOC.exec(ln) || null;
    const p = m ? null : PLAIN.exec(ln);
    if (m || p) {
      grepRows++;
      const file = (m || p)[1];
      if (file !== cur) { out.push(file); cur = file; }
      out.push(m ? `  ${m[2]}${m[3]} ${clip(m[4].trim(), maxLineChars)}` : `  ${clip(p[2].trim(), maxLineChars)}`);
    } else {
      cur = null;
      out.push(clip(ln, maxLineChars));
    }
  }
  // Mostly non-grep output (counts, a file list, an error) → do not regroup what we did not understand.
  const body = grepRows * 2 >= rawLines ? out : lines.map((l) => clip(l, maxLineChars));
  const truncated = body.length > maxLines;
  const shown = truncated ? body.slice(0, maxLines) : body;
  return { text: shown.join("\n"), truncated, rawLines, hidden: truncated ? body.length - maxLines : 0 };
}
