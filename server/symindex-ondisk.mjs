// symindex-ondisk.mjs — the on-disk query tier (Phase 2). The in-memory inverted+trigram index (symindex.js)
// makes WARM queries fast (5–100ms), but building those posting maps costs 9–18s on a 4M-symbol tree — paid on
// every COLD process (a one-shot `qvts` spawn with no warm daemon re-pays it every call). This module moves the
// postings ON DISK at build time so a query LOADS nothing large: it binary-searches a small in-memory term
// dictionary, reads just the matching term's posting (a few KB) at a file offset, and reads only the candidate
// symbol lines. No 563MB parse, no 18s map build — cold and warm are both ms.
//
// Files under <root>/.vts-index/ (siblings of symbols.jsonl):
//   symbols.pos    — magic, N, then N × uint48 LE byte offsets of each symbol line in symbols.jsonl (id order).
//   tokens.idx     — term dictionary + delta-varint postings for camelCase tokens (multi-word queries).
//   trigrams.idx   — same, for 3-grams (single-word substring queries).
// Dictionary format (tokens.idx / trigrams.idx), all LE:
//   [4] magic  [4] uint32 T (terms)  [4] uint32 blobLen
//   [blobLen] term blob: T terms, each uint16 len + UTF-8 bytes, in SORTED order
//   [T*16] index: per term { uint32 blobOff, uint16 termLen, uint48 postOff, uint32 postCount } (pad to 16)
//   [..] posting blob: per term, `postCount` entry-ids as delta-varint (ascending)
// Portable/committable like symbols.jsonl (offsets are within these files, not absolute paths).
import fs from "node:fs";
import path from "node:path";
import { splitIdent } from "./concept.js";

const DIR = ".vts-index";
export const POS_FILE = "symbols.pos";
export const TOK_FILE = "tokens.idx";
export const TRI_FILE = "trigrams.idx";
const MAGIC_POS = 0x31535056; // "VPS1" LE-ish sentinel
const MAGIC_DIC = 0x31434944; // "DIC1"
const INDEX_STRIDE = 16;

const p = (root, f) => path.join(root, DIR, f);
export function hasOnDisk(root) {
  try {
    return fs.existsSync(p(root, POS_FILE)) && fs.existsSync(p(root, TOK_FILE)) && fs.existsSync(p(root, TRI_FILE));
  } catch {
    return false;
  }
}

// ── varint (unsigned LEB128) ──────────────────────────────────────────────────────────────────────────────
function pushVarint(bytes, n) {
  while (n >= 0x80) {
    bytes.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  bytes.push(n);
}
function readVarint(buf, pos) {
  let shift = 0,
    result = 0,
    b;
  do {
    b = buf[pos.i++];
    result += (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
  } while (b & 0x80);
  return result;
}

function _tokenize(name) {
  return splitIdent(name).map((t) => t.toLowerCase()).filter(Boolean);
}
function _trigrams(s) {
  const ls = s.toLowerCase();
  const out = [];
  for (let i = 0; i + 3 <= ls.length; i++) out.push(ls.slice(i, i + 3));
  return out;
}

// Serialize one dictionary (term → sorted unique ids) to a Buffer in the format above.
function serializeDict(termMap) {
  const terms = [...termMap.keys()].sort();
  const T = terms.length;
  const blobParts = [];
  const blobOffs = new Array(T);
  let blobLen = 0;
  for (let i = 0; i < T; i++) {
    const tb = Buffer.from(terms[i], "utf8");
    const head = Buffer.allocUnsafe(2);
    head.writeUInt16LE(tb.length, 0);
    blobOffs[i] = blobLen;
    blobParts.push(head, tb);
    blobLen += 2 + tb.length;
  }
  const blob = Buffer.concat(blobParts, blobLen);
  // posting blob + per-term meta
  const postParts = [];
  const meta = new Array(T); // { postOff, postCount, termLen, blobOff }
  let postLen = 0;
  for (let i = 0; i < T; i++) {
    const ids = termMap.get(terms[i]); // already ascending + unique (built in entry order)
    const bytes = [];
    let prev = 0;
    for (const id of ids) {
      pushVarint(bytes, id - prev);
      prev = id;
    }
    const b = Buffer.from(bytes);
    meta[i] = { blobOff: blobOffs[i], termLen: Buffer.byteLength(terms[i], "utf8"), postOff: postLen, postCount: ids.length };
    postParts.push(b);
    postLen += b.length;
  }
  const postBlob = Buffer.concat(postParts, postLen);
  const index = Buffer.alloc(T * INDEX_STRIDE);
  for (let i = 0; i < T; i++) {
    const m = meta[i];
    const o = i * INDEX_STRIDE;
    index.writeUInt32LE(m.blobOff, o);
    index.writeUInt16LE(m.termLen, o + 4);
    index.writeUIntLE(m.postOff, o + 6, 6); // uint48
    index.writeUInt32LE(m.postCount, o + 12);
  }
  const head = Buffer.alloc(12);
  head.writeUInt32LE(MAGIC_DIC, 0);
  head.writeUInt32LE(T, 4);
  head.writeUInt32LE(blobLen, 8);
  return Buffer.concat([head, blob, index, postBlob]);
}

// Build all on-disk sidecars from the parsed index { entries, ...} + the symbols.jsonl path (for line offsets).
// entries[i] must correspond to the (i+1)-th line of symbols.jsonl (line 0 is the header). Streams the .pos and
// dict files. Postings are built in memory (one pass) — that's the cold cost we're MOVING to build time.
export function writeOnDisk(root, entries, jsonlPath) {
  // 1) symbols.pos — byte offset of each symbol line. Re-scan the jsonl as a Buffer to get exact offsets.
  const buf = fs.readFileSync(jsonlPath);
  const offsets = [];
  let lineStart = 0;
  let sawHeader = false;
  for (let i = 0; i <= buf.length; i++) {
    if (i !== buf.length && buf[i] !== 0x0a) continue;
    if (i > lineStart) {
      if (!sawHeader) sawHeader = true; // line 0 = header, skip
      else offsets.push(lineStart);
    }
    lineStart = i + 1;
  }
  const N = Math.min(offsets.length, entries.length);
  const pos = Buffer.alloc(8 + N * 6);
  pos.writeUInt32LE(MAGIC_POS, 0);
  pos.writeUInt32LE(N, 4);
  for (let i = 0; i < N; i++) pos.writeUIntLE(offsets[i], 8 + i * 6, 6);
  fs.writeFileSync(p(root, POS_FILE), pos);

  // 2) token + trigram posting maps (ascending ids by construction: entries iterated in order).
  const tok = new Map();
  const tri = new Map();
  const push = (m, k, i) => {
    let a = m.get(k);
    if (!a) {
      a = [];
      m.set(k, a);
    }
    if (a[a.length - 1] !== i) a.push(i);
  };
  for (let i = 0; i < N; i++) {
    const n = entries[i].n;
    if (!n) continue;
    const seen = new Set();
    for (const t of _tokenize(n)) if (!seen.has(t)) { seen.add(t); push(tok, t, i); }
    for (const g of new Set(_trigrams(n))) push(tri, g, i);
  }
  fs.writeFileSync(p(root, TOK_FILE), serializeDict(tok));
  fs.writeFileSync(p(root, TRI_FILE), serializeDict(tri));
  return { symbols: N, tokens: tok.size, trigrams: tri.size };
}

// ── Reader ────────────────────────────────────────────────────────────────────────────────────────────────
// Loads only the small dictionaries (term blob + fixed index) into memory; posting blobs and symbol lines are
// read on demand at file offsets. Cached per root by mtime so a warm process reuses open fds + parsed dicts.
const _readerCache = new Map();

function openDict(file) {
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(12);
  fs.readSync(fd, head, 0, 12, 0);
  if (head.readUInt32LE(0) !== MAGIC_DIC) {
    fs.closeSync(fd);
    throw new Error("bad dict magic");
  }
  const T = head.readUInt32LE(4);
  const blobLen = head.readUInt32LE(8);
  const blob = Buffer.alloc(blobLen);
  fs.readSync(fd, blob, 0, blobLen, 12);
  const index = Buffer.alloc(T * INDEX_STRIDE);
  fs.readSync(fd, index, 0, index.length, 12 + blobLen);
  const postBase = 12 + blobLen + index.length;
  return { fd, T, blob, index, postBase };
}
function termAt(d, i) {
  const o = i * INDEX_STRIDE;
  const blobOff = d.index.readUInt32LE(o);
  const len = d.index.readUInt16LE(o + 4);
  return d.blob.toString("utf8", blobOff + 2, blobOff + 2 + len);
}
function postingOf(d, i) {
  const o = i * INDEX_STRIDE;
  const postOff = d.index.readUIntLE(o + 6, 6);
  const count = d.index.readUInt32LE(o + 12);
  // read enough bytes: max varint size = 5 bytes/id, but delta usually 1-2. Read a generous span, decode `count`.
  const span = Math.min(count * 5 + 16, 1 << 24);
  const buf = Buffer.alloc(span);
  const got = fs.readSync(d.fd, buf, 0, span, d.postBase + postOff);
  const pos = { i: 0 };
  const ids = new Array(count);
  let prev = 0;
  for (let k = 0; k < count && pos.i < got; k++) {
    prev += readVarint(buf, pos);
    ids[k] = prev;
  }
  return ids;
}
function lookup(d, term) {
  let lo = 0,
    hi = d.T - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = termAt(d, mid);
    if (t === term) return postingOf(d, mid);
    if (t < term) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

export function openReader(root) {
  const posPath = p(root, POS_FILE);
  let st;
  try {
    st = fs.statSync(posPath);
  } catch {
    return null;
  }
  const key = posPath;
  const cached = _readerCache.get(key);
  if (cached && cached.mt === st.mtimeMs) return cached.reader;
  let posFd, tokD, triD;
  try {
    posFd = fs.openSync(posPath, "r");
    tokD = openDict(p(root, TOK_FILE));
    triD = openDict(p(root, TRI_FILE));
  } catch {
    return null;
  }
  const posHead = Buffer.alloc(8);
  fs.readSync(posFd, posHead, 0, 8, 0);
  const N = posHead.readUInt32LE(4);
  const jsonlFd = fs.openSync(p(root, "symbols.jsonl"), "r");

  const symOffset = (id) => {
    const b = Buffer.alloc(6);
    fs.readSync(posFd, b, 0, 6, 8 + id * 6);
    return b.readUIntLE(0, 6);
  };
  const readSymbol = (id) => {
    const off = symOffset(id);
    const chunk = Buffer.alloc(4096);
    let acc = "";
    let at = off;
    // read forward until newline (symbol lines are short; one 4KB read almost always suffices)
    for (let guard = 0; guard < 64; guard++) {
      const got = fs.readSync(jsonlFd, chunk, 0, chunk.length, at);
      if (got <= 0) break;
      const nl = chunk.indexOf(0x0a);
      if (nl >= 0 && nl < got) {
        acc += chunk.toString("utf8", 0, nl);
        break;
      }
      acc += chunk.toString("utf8", 0, got);
      at += got;
    }
    try {
      return JSON.parse(acc);
    } catch {
      return null;
    }
  };
  const reader = {
    N,
    tokens: (term) => lookup(tokD, term),
    trigrams: (g) => lookup(triD, g),
    readSymbol,
    tri: triD,
    close: () => {
      try { fs.closeSync(posFd); fs.closeSync(jsonlFd); fs.closeSync(tokD.fd); fs.closeSync(triD.fd); } catch {}
    },
  };
  _readerCache.set(key, { mt: st.mtimeMs, reader });
  return reader;
}

// Candidate entry-ids for `q`, mirroring symbolMatchScore (same rule as the in-memory tier):
//   multi-word → union of token postings; single-word → intersection of 3-gram postings; <3 chars → null.
export function candidatesOnDisk(reader, q, qTokens) {
  const raw = String(q);
  if (qTokens.length >= 2 && /\s/.test(raw)) {
    const cand = new Set();
    for (const t of qTokens.map((x) => x.toLowerCase()).filter(Boolean)) {
      const a = reader.tokens(t);
      if (a) for (const id of a) cand.add(id);
    }
    return cand.size ? [...cand].sort((a, b) => a - b) : null;
  }
  const lq = raw.toLowerCase();
  if (lq.length < 3) return null;
  const grams = [...new Set(_trigrams(lq))];
  let inter = null;
  for (const g of grams) {
    const a = reader.trigrams(g);
    if (!a) return [];
    const s = a; // ascending
    if (inter === null) inter = new Set(s);
    else { const ni = new Set(); for (const id of s) if (inter.has(id)) ni.add(id); inter = ni; }
    if (!inter.size) break;
  }
  return inter ? [...inter].sort((a, b) => a - b) : null;
}
