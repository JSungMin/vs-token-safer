// textstruct.js — STRUCTURE tier for prose / structured-text files (extensible, format-agnostic).
//
// "token-safer" is a naming umbrella: the move that makes CODE cheap to search and edit — address a unit by
// NAME, splice its span, token-cap the view — applies to documents and config too. A text file's natural
// "symbol tree" is its SECTION hierarchy: Markdown/AsciiDoc/reST headings, TOML/INI `[section]`s, YAML/JSON
// top-level keys. So `document_symbols` on such a file returns a token-capped table of contents, `read_symbol`
// returns ONE section instead of the whole file, and the symbol-edit tools (replace_symbol_body / insert_symbol
// / safe_delete) edit a section BY ITS NAME — without Reading and line-counting a 2000-line CLAUDE.md / config.
//
// ARCHITECTURE: a registry of per-format PROVIDERS. Each provider only emits a flat heading list
// [{ level, title, line }] (1-based line); the shared `computeSpans` turns that into section spans (a section
// runs to the line before the next heading of the same-or-shallower level — nesting falls out of `level`), and
// `resolveSection`/`fmtOutline` are format-agnostic. Adding a format = adding one provider. Zero-dep, PURE (no
// fs), local, nothing transmitted.

// ── Providers ──────────────────────────────────────────────────────────────────────────────────────────
// Markdown / MDX: ATX (`## Title`) + setext (`Title` underlined with ===/---), fenced-code-aware.
function parseMarkdown(lines) {
  const heads = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const fm = /^\s{0,3}(`{3,}|~{3,})/.exec(ln);
    if (fm) {
      const m = fm[1][0];
      if (!fence) fence = m;
      else if (fence === m) fence = null;
      continue;
    }
    if (fence) continue;
    const atx = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(ln);
    if (atx) {
      heads.push({ level: atx[1].length, title: atx[2].trim(), line: i + 1 });
      continue;
    }
    const next = lines[i + 1];
    if (
      next &&
      ln.trim() &&
      !/^\s{0,3}#/.test(ln) &&
      /^\s{0,3}(=+|-+)\s*$/.test(next) &&
      !/^\s{0,3}[-*+]\s/.test(ln) &&
      !/^\s{0,3}>/.test(ln)
    ) {
      heads.push({ level: next.trim()[0] === "=" ? 1 : 2, title: ln.trim(), line: i + 1 });
      i++;
    }
  }
  return heads;
}

// AsciiDoc: `= Title` (level 1) … `====== Title` (level 6). Skip lines inside `----`/`....` listing blocks.
function parseAsciiDoc(lines) {
  const heads = [];
  let block = null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const bm = /^(-{4,}|\.{4,}|={4,}|\*{4,}|\+{4,})\s*$/.exec(ln);
    if (bm) {
      const m = bm[1][0];
      if (!block) block = m;
      else if (block === m) block = null;
      continue;
    }
    if (block) continue;
    const h = /^(={1,6})\s+(\S.*?)\s*$/.exec(ln);
    if (h) heads.push({ level: h[1].length, title: h[2].trim(), line: i + 1 });
  }
  return heads;
}

// reStructuredText: a title line followed by an underline of repeated punctuation at least as long. The level
// is assigned by the ORDER in which each underline character is first seen (reST's own convention).
function parseRst(lines) {
  const heads = [];
  const rank = new Map();
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i],
      next = lines[i + 1];
    if (!ln.trim() || !next) continue;
    const u = /^([=\-~^"#*+.:_`'])\1{2,}\s*$/.exec(next);
    if (u && next.trim().length >= ln.trim().length && !/^([=\-~^"#*+.:_`'])\1{2,}\s*$/.test(ln)) {
      const ch = u[1];
      if (!rank.has(ch)) rank.set(ch, rank.size + 1);
      heads.push({ level: rank.get(ch), title: ln.trim(), line: i + 1 });
      i++;
    }
  }
  return heads;
}

// TOML / INI: `[section]` and TOML `[[array.of.tables]]`. All flat (level 1) — each runs to the next header.
function parseIni(lines) {
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const h = /^\s*(\[{1,2})\s*([^\]]+?)\s*\]{1,2}\s*$/.exec(lines[i]);
    if (h) heads.push({ level: 1, title: h[2].trim(), line: i + 1 });
  }
  return heads;
}

// YAML: mapping keys, nested by indentation (2 spaces = one level). Skips sequence items and inline values, so
// the outline is the document's key skeleton — edit a block by naming its key.
function parseYaml(lines) {
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^\s*#/.test(ln) || !ln.trim()) continue;
    if (/^---\s*$/.test(ln) || /^\.\.\.\s*$/.test(ln)) continue;
    const m = /^(\s*)([A-Za-z0-9_.$/-]+)\s*:(\s|$)/.exec(ln);
    if (m && !/^\s*-/.test(ln)) {
      const indent = m[1].length;
      heads.push({ level: Math.floor(indent / 2) + 1, title: m[2], line: i + 1 });
    }
  }
  return heads;
}

// JSON: object keys, nested by indentation in pretty-printed JSON (best-effort — relies on indentation).
function parseJson(lines) {
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s+)"([^"]+)"\s*:/.exec(lines[i]);
    if (m) heads.push({ level: Math.floor(m[1].length / 2), title: m[2], line: i + 1 });
  }
  // normalise so the shallowest key is level 1
  const min = heads.reduce((a, h) => Math.min(a, h.level), Infinity);
  if (Number.isFinite(min)) for (const h of heads) h.level = h.level - min + 1;
  return heads;
}

// Plain text (heuristic, lower confidence): setext-style underlines, ALL-CAPS short lines, and numbered
// headers ("1.2 Title"). Best-effort — a .txt has no guaranteed structure.
function parseText(lines) {
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i],
      next = lines[i + 1];
    if (
      next &&
      ln.trim() &&
      /^(=+|-+|#+|\*+)\s*$/.test(next) &&
      next.trim().length >= ln.trim().length &&
      ln.trim().length < 80
    ) {
      heads.push({ level: next.trim()[0] === "=" ? 1 : 2, title: ln.trim(), line: i + 1 });
      i++;
      continue;
    }
    const num = /^(\d+(?:\.\d+)*)\.?\s+(\S.{0,78})$/.exec(ln);
    if (num) {
      heads.push({ level: num[1].split(".").length, title: ln.trim(), line: i + 1 });
      continue;
    }
    if (/^[A-Z0-9][A-Z0-9 _\-:]{2,48}$/.test(ln.trim()) && (!next || !next.trim() || /^[A-Z]/.test(next))) {
      // a short ALL-CAPS line followed by a blank or sentence — a likely header
      if (next !== undefined && !next.trim()) heads.push({ level: 1, title: ln.trim(), line: i + 1 });
    }
  }
  return heads;
}

const PROVIDERS = [
  { exts: /\.(md|markdown|mdx|mkd|mdown)$/i, parse: parseMarkdown },
  { exts: /\.(adoc|asciidoc|asc)$/i, parse: parseAsciiDoc },
  { exts: /\.(rst|rest)$/i, parse: parseRst },
  { exts: /\.(toml|ini|cfg|conf|properties|editorconfig|gitconfig)$/i, parse: parseIni },
  { exts: /\.(ya?ml)$/i, parse: parseYaml },
  { exts: /\.(json|jsonc|json5)$/i, parse: parseJson },
  { exts: /\.(txt|text|rst\.txt)$/i, parse: parseText },
];

function providerFor(file) {
  const f = String(file || "");
  return PROVIDERS.find((p) => p.exts.test(f)) || null;
}

// Does this file have a registered structure provider? (drives the "use the structure tier" check.)
export function isStructFile(file) {
  return !!providerFor(file);
}
export function extName(file) {
  const m = /\.[A-Za-z0-9]+$/.exec(String(file || ""));
  return m ? m[0].toLowerCase() : "";
}

// Section span from a flat heading list: each section runs to the line before the next heading of level <=
// this one (so a section contains its nested subsections), or to EOF.
function computeSpans(heads, totalLines) {
  const out = [];
  for (let i = 0; i < heads.length; i++) {
    let end = totalLines;
    for (let j = i + 1; j < heads.length; j++) {
      if (heads[j].level <= heads[i].level) {
        end = heads[j].line - 1;
        break;
      }
    }
    out.push({
      level: heads[i].level,
      title: heads[i].title,
      line: heads[i].line,
      endLine: Math.max(end, heads[i].line),
    });
  }
  return out;
}

// Outline a structured-text file → [{ level, title, line (1-based), endLine (1-based, inclusive) }]. Empty for
// an unsupported file. The single entry point both the read and edit paths use.
export function structOutline(file, text) {
  const p = providerFor(file);
  if (!p) return [];
  const lines = String(text).split(/\r?\n/);
  return computeSpans(p.parse(lines), lines.length);
}

// Back-compat alias (markdown was the first provider).
export function mdOutline(text) {
  return computeSpans(parseMarkdown(String(text).split(/\r?\n/)), String(text).split(/\r?\n/).length);
}

// Resolve ONE section by title for read/edit. Exact title (case-insensitive) beats a substring; a `line`
// (1-based, inside the section) disambiguates repeats; a `level` filters by depth. → { level, title, line,
// endLine } or null.
export function resolveSection(file, text, title, { line = null, level = null } = {}) {
  const outline = structOutline(file, text);
  if (!outline.length || !title) return null;
  const want = String(title).trim().toLowerCase();
  const cands = outline.filter((s) => level == null || s.level === level);
  const exact = cands.filter((s) => s.title.toLowerCase() === want);
  const subs = cands.filter((s) => s.title.toLowerCase().includes(want));
  let pool = exact.length ? exact : subs;
  if (!pool.length) return null;
  if (line != null) {
    const byLine = pool.filter((s) => line >= s.line && line <= s.endLine);
    if (byLine.length) pool = byLine;
  }
  pool.sort((a, b) => a.level - b.level || a.line - b.line);
  return pool[0];
}

// Format an outline as a token-capped indented `hN title :line` table of contents (the file is named once in
// the caller's header, so each row carries only the heading).
export function fmtOutline(outline, max = 200) {
  const shown = outline.slice(0, max);
  const rows = shown.map((s) => `${"  ".repeat(Math.max(0, s.level - 1))}h${s.level} ${s.title} :${s.line}`);
  const more = outline.length - shown.length;
  return rows.join("\n") + (more > 0 ? `\n… ${more} more section(s).` : "");
}
