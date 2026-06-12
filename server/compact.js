/*
 * vs-token-safer — output compaction for VCS commands the language-server index can't help with: a raw
 * `git`/`p4` dump is verbose, repetitive, and mostly boilerplate. These PURE string→string functions group,
 * deduplicate, and cap that output before it reaches the model — the same token-first principle as the
 * symbol/reference formatters, applied to VCS output (the slice rtk covers, kept under our roof, our cap,
 * our savings ledger). No spawning here — the wrapper in core.js runs the command and feeds the raw stdout
 * in; eval exercises these directly with canned strings (deterministic, no toolchain). (Text search is
 * NOT here: grep reroutes to search_text, which scans + token-caps itself — no raw grep output to compact.)
 */

const splitLines = (raw) => String(raw == null ? "" : raw).split(/\r?\n/);
const nonEmpty = (raw) => splitLines(raw).filter((l) => l.trim().length);

// Collapse identical lines into one with a `(×N)` suffix, preserving first-seen order, then cap the list.
// Returns { lines, total, shown } so the caller can render a `… +K more` summary (no silent caps).
function dedupCap(lines, max) {
  const counts = new Map();
  for (const l of lines) counts.set(l, (counts.get(l) || 0) + 1);
  const out = [];
  for (const [l, n] of counts) out.push(n > 1 ? `${l}  (×${n})` : l);
  const total = out.length;
  const shown = out.slice(0, max);
  return { lines: shown, total, shown: shown.length };
}

const topDir = (p) => {
  const s = String(p).replace(/^\.?[/\\]+/, "").replace(/\\/g, "/");
  const i = s.indexOf("/");
  return i === -1 ? "(root)" : s.slice(0, i);
};

// ---- git ----
// `git status --porcelain`/`-s`: `XY path`. Group by status code (counts) and untracked files by top dir.
function compactGitStatus(raw, max) {
  const lines = nonEmpty(raw);
  if (!lines.length) return "clean (no changes).";
  const STATUS = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", U: "unmerged", "?": "untracked", "!": "ignored" };
  const byCode = new Map();
  for (const l of lines) {
    // porcelain: 2-char XY, space, path. Tolerate `-s` (same shape) and a leading marker.
    const xy = l.slice(0, 2);
    const key = (xy.trim()[0] || xy[0] || "?");
    let p = l.slice(2).trim().replace(/^"|"$/g, "");
    // Renames/copies render as `old -> new`; group + show the DESTINATION (the path that now exists).
    if ((key === "R" || key === "C") && p.includes(" -> ")) p = p.split(" -> ").pop().replace(/^"|"$/g, "");
    if (!byCode.has(key)) byCode.set(key, []);
    byCode.get(key).push(p);
  }
  const out = [`${lines.length} change(s):`];
  let shown = 0; // ONE shared listing budget across all groups (not per-group — that could dump ~max each)
  for (const [code, paths] of byCode) {
    const label = STATUS[code] || code;
    const dirs = new Map();
    for (const p of paths) dirs.set(topDir(p), (dirs.get(topDir(p)) || 0) + 1);
    const dirSummary = [...dirs].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([d, n]) => `${d}(${n})`).join(", ");
    out.push(`  ${label}: ${paths.length}  [${dirSummary}]`);
    const take = Math.min(paths.length, Math.max(0, max - shown));
    for (const p of paths.slice(0, take)) out.push(`    ${p}`);
    shown += take;
    if (paths.length > take) out.push(`    … +${paths.length - take} more ${label}`);
  }
  return out.join("\n");
}

// `git log --oneline` (or full): keep the first line of each commit, cap N.
function compactGitLog(raw, max) {
  const lines = nonEmpty(raw);
  if (!lines.length) return "(no commits).";
  // If full log (commit/Author/Date blocks), collapse each commit to `sha subject`.
  if (/^commit [0-9a-f]{7,}/m.test(raw)) {
    const commits = [];
    let sha = null, subj = null, sawBlank = false;
    for (const l of splitLines(raw)) {
      const cm = l.match(/^commit ([0-9a-f]{7,})/);
      if (cm) { if (sha) commits.push(`${sha.slice(0, 9)} ${subj || ""}`.trim()); sha = cm[1]; subj = null; sawBlank = false; continue; }
      if (sha && !subj) { if (!l.trim()) { sawBlank = true; continue; } if (sawBlank) subj = l.trim(); }
    }
    if (sha) commits.push(`${sha.slice(0, 9)} ${subj || ""}`.trim());
    const shown = commits.slice(0, max);
    return shown.join("\n") + (commits.length > shown.length ? `\n… +${commits.length - shown.length} more commit(s).` : "");
  }
  const shown = lines.slice(0, max);
  return shown.join("\n") + (lines.length > shown.length ? `\n… +${lines.length - shown.length} more commit(s).` : "");
}

// `git diff` (full unified): collapse to a per-file +adds/-dels diffstat, drop the hunk bodies entirely.
function compactGitDiff(raw, max) {
  const lines = splitLines(raw);
  if (!nonEmpty(raw).length) return "(no diff).";
  const files = [];
  let cur = null;
  for (const l of lines) {
    const gm = l.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (gm) { cur = { file: gm[2].replace(/^"|"$/g, ""), add: 0, del: 0, binary: false }; files.push(cur); continue; }
    if (!cur) continue;
    if (/^Binary files /.test(l)) { cur.binary = true; continue; } // a changed binary, no +/- body to count
    if (l.startsWith("+++") || l.startsWith("---")) continue; // file headers, not content
    if (l.startsWith("+")) cur.add++;
    else if (l.startsWith("-")) cur.del++;
  }
  if (!files.length) {
    // No `diff --git` headers → not a unified diff (likely `--stat` / `--name-only`, already terse). Don't
    // mangle it: dedup + cap the raw output and pass it through.
    const { lines, total } = dedupCap(nonEmpty(raw), max);
    return lines.join("\n") + (total > lines.length ? `\n… +${total - lines.length} more unique line(s).` : "");
  }
  const shown = files.slice(0, max);
  const body = shown.map((f) => `  ${f.file} | ${f.binary ? "(binary)" : `+${f.add} -${f.del}`}`).join("\n");
  const totAdd = files.reduce((s, f) => s + f.add, 0), totDel = files.reduce((s, f) => s + f.del, 0);
  return `${files.length} file(s) changed, +${totAdd} -${totDel}:\n${body}` + (files.length > shown.length ? `\n… +${files.length - shown.length} more file(s).` : "");
}

export function compactGit(sub, raw, max = 60) {
  const s = String(sub || "").toLowerCase();
  if (s === "status") return compactGitStatus(raw, max);
  if (s === "log") return compactGitLog(raw, max);
  if (s === "diff") return compactGitDiff(raw, max);
  // Unknown subcommand → generic dedup+cap (still a win on repetitive output).
  const { lines, total } = dedupCap(nonEmpty(raw), max);
  if (!lines.length) return "(no output).";
  return lines.join("\n") + (total > lines.length ? `\n… +${total - lines.length} more unique line(s).` : "");
}

// ---- perforce ----
// `p4 opened`/`p4 status`/`p4 -n reconcile`: `//depot/path#rev - action ...`. Group by action + depot dir.
function compactP4Opened(raw, max) {
  const lines = nonEmpty(raw);
  if (!lines.length) return "(nothing opened).";
  const byAction = new Map();
  for (const l of lines) {
    // `//depot/a/b.cpp#3 - edit default change (text)` or `... - opened for edit`
    const fm = l.match(/^(\/\/[^#\s]+)/);
    const file = fm ? fm[1] : l.trim();
    const am = l.match(/-\s*(?:opened for\s+)?(\w+)/);
    const action = am ? am[1].toLowerCase() : "open";
    if (!byAction.has(action)) byAction.set(action, []);
    byAction.get(action).push(file);
  }
  const out = [`${lines.length} file(s):`];
  for (const [action, files] of byAction) {
    const dirs = new Map();
    for (const f of files) { const d = f.replace(/^\/\//, "").split("/").slice(0, 3).join("/"); dirs.set(d, (dirs.get(d) || 0) + 1); }
    const dirSummary = [...dirs].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([d, n]) => `${d}(${n})`).join(", ");
    out.push(`  ${action}: ${files.length}  [${dirSummary}]`);
    const per = Math.max(0, Math.floor(max / Math.max(byAction.size, 1)));
    for (const f of files.slice(0, per)) out.push(`    ${f}`);
    if (files.length > per) out.push(`    … +${files.length - per} more ${action}`);
  }
  return out.join("\n");
}

// `p4 changes`: `Change N on DATE by user@ws 'desc'`. Keep terse, cap.
function compactP4Changes(raw, max) {
  const lines = nonEmpty(raw);
  if (!lines.length) return "(no changes).";
  const shown = lines.slice(0, max).map((l) => {
    // `Change N on DATE by user@ws [*pending*] 'desc'` — grab the head fields and the quoted desc wherever
    // it sits (the optional *pending* marker no longer breaks the match).
    const m = l.match(/^Change (\d+) on (\S+) by (\S+)/);
    if (!m) return l.slice(0, 200);
    const pending = /\*pending\*/.test(l) ? "*pending* " : "";
    const desc = (l.match(/'([^']*)'/) || ["", ""])[1].slice(0, 80);
    return `${m[1]} ${m[2]} ${m[3]} ${pending}${desc}`.trim();
  });
  return shown.join("\n") + (lines.length > shown.length ? `\n… +${lines.length - shown.length} more change(s).` : "");
}

export function compactP4(sub, raw, max = 60) {
  const s = String(sub || "").toLowerCase();
  if (s === "opened" || s === "status" || s === "reconcile") return compactP4Opened(raw, max);
  if (s === "changes") return compactP4Changes(raw, max);
  const { lines, total } = dedupCap(nonEmpty(raw), max);
  if (!lines.length) return "(no output).";
  return lines.join("\n") + (total > lines.length ? `\n… +${total - lines.length} more unique line(s).` : "");
}

// Exposed for the eval (deterministic unit coverage of the grouping helpers).
export const _internals = { dedupCap, topDir, compactGitStatus, compactGitLog, compactGitDiff, compactP4Opened, compactP4Changes };
