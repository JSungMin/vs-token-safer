// symindex.js — COMMITTABLE symbol index (the cold-start accelerator).
//
// Inspired by Codeix's git-committed JSONL index: a plain, human-readable, version-controllable symbol list
// that a TEAM can share and that works OFFLINE with zero setup. Built from the tree-sitter syntactic tier
// (treesitter.js), so it needs no toolchain — `vts index` walks the scope, extracts every declaration, and
// writes one JSONL record per symbol to `<root>/.vts-index/symbols.jsonl`. Paths are stored RELATIVE to the
// root so the file is portable across machines / checkouts.
//
// It is NOT the source of truth — the semantic LSP always supersedes it when a backend resolves. Its job is
// the cold first query: before clangd has built its index (the 369s→51s problem), or on a machine with no
// toolchain at all, a committed symbols.jsonl answers `search_symbol` instantly. Token cost stays nil — the
// output is the same capped file:line list; the JSONL itself never reaches the model.
import fs from "node:fs";
import path from "node:path";
import { tsFileSymbols, tsSupports } from "./treesitter.js";

const DIR = ".vts-index";
const FILE = "symbols.jsonl";
export const SYMINDEX_VERSION = 1;

export function symIndexDir(root) {
  return path.join(root, DIR);
}
export function symIndexPath(root) {
  return path.join(root, DIR, FILE);
}
export function hasSymIndex(root) {
  try {
    return fs.existsSync(symIndexPath(root));
  } catch {
    return false;
  }
}

// Build the index by walking `root` (bounded to `dirs` when scope is set) and tree-sitter-extracting every
// supported file. skipDir(name)→true prunes a directory (node_modules/build/… — shared with scanTextUnder).
// inScope(absPath)→bool optionally filters to the configured indexing scope. Returns { files, symbols, path }.
export async function buildSymIndex(
  root,
  { skipDir, inScope, timeBudgetMs = 120000, now = Date.now() } = {},
) {
  const skip = skipDir || (() => false);
  const within = inScope || (() => true);
  const stack = [root];
  const t0 = Date.now();
  let files = 0,
    symbols = 0,
    timedOut = false;
  const lines = [];
  while (stack.length) {
    if (Date.now() - t0 >= timeBudgetMs) {
      timedOut = true;
      break;
    }
    const dir = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip(e.name) && e.name !== DIR) stack.push(p);
        continue;
      }
      if (!tsSupports(e.name)) continue;
      if (!within(p)) continue;
      if (Date.now() - t0 >= timeBudgetMs) {
        timedOut = true;
        break;
      }
      let syms;
      try {
        syms = await tsFileSymbols(p);
      } catch {
        continue;
      }
      if (!syms.length) continue;
      files++;
      const rel = path.relative(root, p).replace(/\\/g, "/");
      for (const s of syms) {
        lines.push(JSON.stringify({ f: rel, n: s.name, k: s.kind, l: s.line }));
        symbols++;
      }
    }
    if (timedOut) break;
  }
  const header = JSON.stringify({
    v: SYMINDEX_VERSION,
    built: now,
    files,
    symbols,
    partial: timedOut || undefined,
  });
  const dirPath = symIndexDir(root);
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(symIndexPath(root), header + "\n" + lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
  return { files, symbols, path: symIndexPath(root), partial: timedOut };
}

// Load the index. Returns { meta, entries:[{f,n,k,l}] } or null if absent/unreadable.
export function loadSymIndex(root) {
  let txt;
  try {
    txt = fs.readFileSync(symIndexPath(root), "utf8");
  } catch {
    return null;
  }
  const rows = txt.split(/\r?\n/).filter(Boolean);
  if (!rows.length) return null;
  let meta = {};
  try {
    meta = JSON.parse(rows[0]);
  } catch {
    /* first line is data on a malformed file — tolerate */
  }
  const entries = [];
  for (let i = meta.v ? 1 : 0; i < rows.length; i++) {
    try {
      const o = JSON.parse(rows[i]);
      if (o && o.n) entries.push(o);
    } catch {
      /* skip bad line */
    }
  }
  return { meta, entries };
}

function tailName(name) {
  const m = String(name).split(/::|\.|\//);
  return m[m.length - 1] || name;
}
function matchRank(name, q) {
  const ln = name.toLowerCase(),
    lq = q.toLowerCase();
  if (ln === lq || tailName(name).toLowerCase() === lq) return 2;
  if (ln.includes(lq)) return 1;
  return 0;
}

// Query the committed index for symbols matching `q`. Returns hits shaped like tsSearchSymbols
// ({ name, kind, file (ABSOLUTE), line }) so core.js formats both tiers identically. `.fromIndex` marks the
// source; `.truncated="cap"` when more than `max` matched.
export function searchSymIndex(root, q, { max = 40 } = {}) {
  const idx = loadSymIndex(root);
  if (!idx) return null;
  const hits = [];
  for (const e of idx.entries) {
    const r = matchRank(e.n, q);
    if (r)
      hits.push({ name: e.n, kind: e.k, file: path.join(root, e.f).replace(/\\/g, "/"), line: e.l, rank: r });
  }
  hits.sort((a, b) => b.rank - a.rank || a.name.length - b.name.length);
  const sliced = hits.slice(0, max);
  if (hits.length > max) sliced.truncated = "cap";
  sliced.fromIndex = true;
  sliced.meta = idx.meta;
  return sliced;
}
