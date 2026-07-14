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
import os from "node:os";
import { once } from "node:events";
import { execFile, execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { tsFileSymbols, tsSupports } from "./treesitter.js";
import { fnv1a } from "./warmset.js";
import { splitIdent, symbolMatchScore } from "./concept.js";
import { openReader as _openReader, writeOnDisk as _writeOnDisk, candidatesOnDisk as _candidatesOnDisk } from "./symindex-ondisk.mjs";

// On-disk query tier (Phase 2): when the sidecar files exist, a query loads NOTHING large — it binary-searches a
// small term dict and reads only the matching postings + candidate symbol lines, so cold (one-shot) queries are
// ms, not the 9–18s the in-memory posting build costs. Disable with VTS_SYMINDEX_ONDISK=0 (→ in-memory tier).
const _ondiskOn = process.env.VTS_SYMINDEX_ONDISK !== "0";

const DIR = ".vts-index";
const FILE = "symbols.jsonl";
export const SYMINDEX_VERSION = 1;

// Directories never worth indexing. Kept HERE (not just core.js) because the chunk worker runs in an isolated
// child process and can't receive a skipDir closure — it imports this shared set instead. Superset of core.js's
// list: also drops third-party / vendored trees (UE ThirdParty is hundreds of thousands of external files that
// balloon both the walk and the index for symbols a developer almost never searches). Override via
// VTS_INDEX_NO_SKIP_VENDOR=1 if you really need to index vendored code.
export const SKIP_DIRS = new Set(
  [
    "node_modules", ".git", ".svn", ".hg", ".cache", ".vs", ".idea", ".gradle",
    "intermediate", "binaries", "saved", "deriveddatacache", "build", "dist", "out", "obj", "bin",
    "__pycache__", ".venv", "venv", "target",
    ...(process.env.VTS_INDEX_NO_SKIP_VENDOR === "1" ? [] : ["thirdparty", "third_party", "vendor", "vendored", "externals"]),
  ],
);
export const defaultSkipDir = (name) => name.startsWith(".") || SKIP_DIRS.has(name.toLowerCase());

// Generated code (UE reflection: Foo.gen.cpp / Foo.generated.h, and similar) is machine-written boilerplate:
// low search value (the real declaration is the hand-written .h/.cpp) AND a build hazard — a plugin like
// Marketplace ships thousands of ~1MB .gen.cpp files whose tree-sitter parse trees exhaust memory and OOM the
// chunk worker. Skip them from indexing. Override with VTS_INDEX_KEEP_GENERATED=1.
const GENERATED_RE = /\.(gen|generated)\.(c|cc|cpp|cxx|h|hpp|inl)$/i;
export function isIndexable(name) {
  return tsSupports(name) && (process.env.VTS_INDEX_KEEP_GENERATED === "1" || !GENERATED_RE.test(name));
}

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

// Highest mtime across a per-file manifest ({rel: {mt, sz, h}}) — the freshness watermark stamped into the
// header so a later query can tell whether any SOURCE has changed since the index was built (indexFreshness).
// Cheap: the manifest is already in hand at build time (every file was stat'd), so no extra walk.
function _maxMtimeOf(hashes) {
  let mx = 0;
  for (const k in hashes) { const v = hashes[k]; if (v && v.mt > mx) mx = v.mt; }
  return mx;
}

// ── Query-time freshness (S3: partial/stale index) ──────────────────────────────────────────────────────────
// Read ONLY the header line (the freshness stamp) of symbols.jsonl — never load the whole index (which can be
// hundreds of MB) just to read {built, files, maxMtime}. Cached by path+mtime+size.
const _metaCache = new Map(); // path → { mt, sz, meta }
export function symIndexMeta(root) {
  const p = symIndexPath(root);
  let st; try { st = fs.statSync(p); } catch { return null; }
  const c = _metaCache.get(p);
  if (c && c.mt === st.mtimeMs && c.sz === st.size) return c.meta;
  let fd, meta = null;
  try {
    fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const s = buf.toString("utf8", 0, n);
    const nl = s.indexOf("\n");
    const o = JSON.parse(nl === -1 ? s : s.slice(0, nl));
    if (o && o.v) meta = o;
  } catch { meta = null; }
  finally { try { if (fd !== undefined) fs.closeSync(fd); } catch { /* ignore */ } }
  _metaCache.set(p, { mt: st.mtimeMs, sz: st.size, meta });
  return meta;
}
// Is the committed index STALE relative to the current tree? A BUDGETED probe (400ms, like bigTreeLikely) that
// reads mtime/existence ONLY (never file bodies) and EARLY-EXITS the instant it finds a source newer than the
// index's watermark. Returns { stale, changed } — `changed` is a lower bound (≥1 on early-exit) or a count-delta
// when the walk completes in budget. NEVER blocks the answer; a legacy index with no watermark → not stale
// (can't judge honestly). Cached by root + the jsonl's mtime so repeat queries don't re-walk. VTS_STALE_CHECK=0
// disables (always treats the index as fresh).
const _freshnessCache = new Map(); // `${root}\0${jsonlMtime}` → { stale, changed }
export function indexFreshness(root) {
  if (/^(0|false|off|no)$/i.test(String(process.env.VTS_STALE_CHECK ?? "1"))) return { stale: false, changed: 0 };
  const meta = symIndexMeta(root);
  if (!meta || meta.maxMtime == null) return { stale: false, changed: 0 }; // no watermark → don't cry stale
  let jmt; try { jmt = fs.statSync(symIndexPath(root)).mtimeMs; } catch { return { stale: false, changed: 0 }; }
  const key = `${root}\0${jmt}`;
  const hit = _freshnessCache.get(key);
  if (hit) return hit;
  const t0 = Date.now();
  const stack = [root];
  let seen = 0, changed = 0, budget = false;
  const maxMt = meta.maxMtime;
  outer:
  while (stack.length) {
    if (Date.now() - t0 > 400) { budget = true; break; }
    const dir = stack.pop();
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isDirectory()) { if (!defaultSkipDir(e.name) && e.name !== DIR) stack.push(path.join(dir, e.name)); continue; }
      if (!isIndexable(e.name)) continue;
      seen++;
      let st; try { st = fs.statSync(path.join(dir, e.name)); } catch { continue; }
      if (Math.round(st.mtimeMs) > maxMt) { changed = 1; break outer; } // any newer source → stale, stop early
    }
  }
  let res;
  if (changed > 0) res = { stale: true, changed };
  // Count-delta is only trustworthy when the whole tree was walked in budget (a partial walk under-counts).
  else if (!budget && meta.files != null && Math.abs(seen - meta.files) > Math.max(2, Math.round(meta.files * 0.02)))
    res = { stale: true, changed: Math.abs(seen - meta.files) };
  else res = { stale: false, changed: 0 };
  _freshnessCache.set(key, res);
  return res;
}

// ── S2/S3: auto-build the committed index in the BACKGROUND ──────────────────────────────────────────────────
// When a locate hits a tree that has no committed index, kick off `vts index` DETACHED so the NEXT cold start
// (or the same session, once it finishes) answers instantly — without ever blocking THIS query or leaking build
// output into a tool response. Deduped by an in-process Set AND a cross-process lock file (a fresh lock younger
// than the TTL means another process is already building). VTS_AUTO_INDEX=0 disables. Returns { started, reason }.
const _autoIndexInflight = new Set();
function _autoIndexLock() { return path.join(os.homedir(), ".vts-local", "autoindex.lock"); }
export function ensureAutoIndex(root) {
  if (/^(0|false|off|no)$/i.test(String(process.env.VTS_AUTO_INDEX ?? "1"))) return { started: false, reason: "disabled" };
  const key = path.resolve(root);
  if (_autoIndexInflight.has(key)) return { started: false, reason: "inflight" };
  if (hasSymIndex(root)) return { started: false, reason: "exists" };
  const ttlMs = Number(process.env.VTS_AUTOINDEX_LOCK_TTL_MS || 30 * 60 * 1000);
  const lockPath = _autoIndexLock();
  // Cross-process dedupe: the lock file holds one {root: startedMs} record per active build. Skip if a FRESH
  // record for this root exists (another vts process is building it). Prune stale/expired records opportunistically.
  let locks = {};
  try { locks = JSON.parse(fs.readFileSync(lockPath, "utf8")) || {}; } catch { /* absent/corrupt → fresh map */ }
  const now = Date.now();
  for (const k in locks) if (!(now - (locks[k] || 0) < ttlMs)) delete locks[k]; // drop expired
  if (locks[key] && now - locks[key] < ttlMs) { _autoIndexInflight.add(key); return { started: false, reason: "locked" }; }
  // Detached spawn: `node <cli.js> index --projectPath <root>`, all output to a log file (NEVER a response).
  try {
    const dir = path.dirname(lockPath);
    fs.mkdirSync(dir, { recursive: true });
    const logDir = path.join(dir, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const slug = path.basename(key).replace(/[^\w.-]/g, "_") + "-" + Math.abs(fnv1a(key)).toString(36);
    const logPath = path.join(logDir, `autoindex-${slug}.log`);
    const out = fs.openSync(logPath, "a");
    const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
    const child = spawn(process.execPath, [cli, "index", "--projectPath", root], {
      cwd: root, detached: true, stdio: ["ignore", out, out], windowsHide: true,
    });
    child.unref();
    try { fs.closeSync(out); } catch { /* fd handed to child */ }
    locks[key] = now;
    try { fs.writeFileSync(lockPath, JSON.stringify(locks)); } catch { /* best-effort lock */ }
    _autoIndexInflight.add(key);
    return { started: true, reason: "spawned", log: logPath };
  } catch (e) {
    return { started: false, reason: "error", error: String((e && e.message) || e) };
  }
}

// Build the index by walking `root` (bounded to `dirs` when scope is set) and tree-sitter-extracting every
// supported file. skipDir(name)→true prunes a directory (node_modules/build/… — shared with scanTextUnder).
// inScope(absPath)→bool optionally filters to the configured indexing scope.
//
// INCREMENTAL (default): the header carries a per-file manifest `h: {rel: {mt, sz, h}}` — mtime, size, and an
// FNV-1a content hash (same pure, zero-dep hash warmset uses for its include-graph cache). On a rebuild, a
// file whose mtime+size still match its manifest entry is REUSED verbatim — no read, no tree-sitter parse
// (parsing is the expensive part the cold-index problem is about). A file whose stat changed is READ and
// hashed; if the content hash still matches (mtime jitter, bytes unchanged) it's reused too, else it's
// re-parsed. Deleted files drop out; new files parse. So `vts index` after editing a handful of files
// re-parses only those, not the whole tree. Returns { files, symbols, path, reused, reparsed, partial }.
//
// This is the SINGLE-PROCESS builder. For a giant tree it OOMs (a full UE Engine has ~4M symbols; even with
// streamed writes the cumulative per-file parser state exhausts V8's internal zone). buildSymIndex() (below)
// dispatches such trees to the chunked, multi-process builder instead. Callers should use buildSymIndex().
async function buildSymIndexSingle(
  root,
  { skipDir, inScope, timeBudgetMs = 120000, now = Date.now(), incremental = true } = {},
) {
  const skip = skipDir || (() => false);
  const within = inScope || (() => true);
  // Prior index → reuse map (rel → its records) + the per-file stat/hash manifest.
  const prior = incremental ? loadSymIndex(root) : null;
  const priorHashes = (prior && prior.meta && prior.meta.h) || {};
  const priorByFile = new Map();
  if (prior) for (const e of prior.entries) { const a = priorByFile.get(e.f) || []; a.push({ f: e.f, n: e.n, k: e.k, l: e.l }); priorByFile.set(e.f, a); }
  const stack = [root];
  const t0 = Date.now();
  let files = 0,
    symbols = 0,
    timedOut = false,
    reused = 0,
    reparsed = 0;
  const newHashes = {};
  // Stream symbol records to a temp file as we walk. A full UE Engine tree has MILLIONS of symbols; buffering
  // them in an array and joining with "\n" at the end exhausted the V8 heap (Zone OOM) even at 16 GB. A write
  // stream keeps memory flat. The header (files/symbols/manifest) is only known after the walk, so records go
  // to a `.building` temp first and the final file is header-line + piped temp body (never one giant string).
  // Backpressure-aware: when the OS buffer fills, the walk pauses for "drain" instead of ballooning memory.
  const dirPath = symIndexDir(root);
  fs.mkdirSync(dirPath, { recursive: true });
  const finalPath = symIndexPath(root);
  const tmpPath = finalPath + ".building";
  const body = fs.createWriteStream(tmpPath, { encoding: "utf8" });
  const writeLine = async (s) => {
    if (!body.write(s)) await once(body, "drain");
  };
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
      const rel = path.relative(root, p).replace(/\\/g, "/");
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      const mt = Math.round(st.mtimeMs),
        sz = st.size;
      const pri = priorHashes[rel];
      let recs, h;
      if (pri && pri.mt === mt && pri.sz === sz) {
        // unchanged by stat → reuse, no read, no parse (the fast path)
        recs = priorByFile.get(rel) || [];
        h = pri.h;
        reused++;
      } else {
        // stat changed (or new file): read + hash. If the content hash still matches, reuse (mtime jitter).
        let src;
        try {
          src = fs.readFileSync(p, "utf8");
        } catch {
          continue;
        }
        h = fnv1a(src);
        if (pri && pri.h === h) {
          recs = priorByFile.get(rel) || [];
          reused++;
        } else {
          let syms;
          try {
            syms = await tsFileSymbols(p);
          } catch {
            continue;
          }
          recs = syms.map((s) => ({ f: rel, n: s.name, k: s.kind, l: s.line }));
          reparsed++;
        }
      }
      newHashes[rel] = { mt, sz, h }; // remember every seen file (incl. empty) so it isn't re-read next time
      if (!recs.length) continue;
      files++;
      for (const r of recs) {
        await writeLine(JSON.stringify(r) + "\n");
        symbols++;
      }
    }
    if (timedOut) break;
  }
  await new Promise((res) => body.end(res));
  // GUARD: never overwrite an EXISTING index with a degenerate 0-symbol build. On a non-empty tree, 0 symbols
  // means tree-sitter failed to LOAD/parse (a missing or ABI-incompatible grammar — e.g. a web-tree-sitter ↔
  // tree-sitter-wasms dylink mismatch), NOT that the code has no declarations. Writing it would DESTROY a good
  // committed index (observed live: a 0.26 dylink mismatch produced 0 symbols and clobbered a 3.9M-symbol
  // index). Abort, keep the existing symbols.jsonl, surface the cause.
  if (symbols === 0 && fs.existsSync(finalPath)) {
    try { fs.unlinkSync(tmpPath); } catch { /* temp already gone */ }
    throw new Error(
      "vts index: build produced 0 symbols on a tree that already has an index — tree-sitter grammar is " +
        "unavailable/incompatible. Kept the existing symbols.jsonl (refusing to overwrite it with an empty " +
        "index). Reinstall in the server dir: npm i web-tree-sitter@^0.25 tree-sitter-wasms",
    );
  }
  const header = JSON.stringify({
    v: SYMINDEX_VERSION,
    built: now,
    files,
    symbols,
    maxMtime: _maxMtimeOf(newHashes), // freshness watermark (S3 staleness probe)
    partial: timedOut || undefined,
    h: newHashes,
  });
  // Final file = header line + the streamed temp body, joined by PIPE (not read-into-a-string) so a
  // multi-hundred-MB index never materializes as a single V8 string.
  await new Promise((res, rej) => {
    const out = fs.createWriteStream(finalPath, { encoding: "utf8" });
    out.on("error", rej);
    out.write(header + "\n");
    const rs = fs.createReadStream(tmpPath, { encoding: "utf8" });
    rs.on("error", rej);
    rs.on("end", () => out.end());
    out.on("finish", res);
    rs.pipe(out, { end: false });
  });
  try {
    fs.unlinkSync(tmpPath);
  } catch {
    /* temp already gone */
  }
  return { files, symbols, path: finalPath, partial: timedOut, reused, reparsed };
}

// ── Chunked, multi-process builder ──────────────────────────────────────────────────────────────────────────
// Symbol-count for a subtree (cheap: readdir walk, NO parsing) — used to decide chunk boundaries. Stops at `max`.
function countSupported(dir, max = Infinity) {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let es;
    try {
      es = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of es) {
      if (e.isDirectory()) {
        if (!defaultSkipDir(e.name) && e.name !== DIR) stack.push(path.join(d, e.name));
      } else if (isIndexable(e.name)) {
        if (++n >= max) return n;
      }
    }
  }
  return n;
}

// Plan chunks: recursively split `root` so each chunk's file count stays under fileCap. A directory whose whole
// subtree fits becomes one recursive chunk; an oversized directory becomes a shallow "self" chunk (its direct
// files only) plus a recursive chunk per subdirectory. Generalizes to ANY tree — a small repo yields ONE chunk
// (caller then runs the in-process builder), a huge one yields many. Returns [{ dir, shallow }].
//
// SINGLE PASS: one walk records each dir's DIRECT file count + child dirs; a memoized post-order sums subtrees.
// (A naive recurse-and-recount re-walked every ancestor's subtree — ~46s on a UE tree; this is O(files), a few s.)
export function planChunks(root, { fileCap = 4000 } = {}) {
  const direct = new Map(); // dir → direct supported-file count
  const kids = new Map(); // dir → [child dir]
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let es;
    try {
      es = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      direct.set(d, 0);
      kids.set(d, []);
      continue;
    }
    let dc = 0;
    const ch = [];
    for (const e of es) {
      if (e.isDirectory()) {
        if (!defaultSkipDir(e.name) && e.name !== DIR) {
          const p = path.join(d, e.name);
          ch.push(p);
          stack.push(p);
        }
      } else if (isIndexable(e.name)) dc++;
    }
    direct.set(d, dc);
    kids.set(d, ch);
  }
  const total = new Map();
  const subtotal = (d) => {
    if (total.has(d)) return total.get(d);
    let s = direct.get(d) || 0;
    for (const k of kids.get(d) || []) s += subtotal(k);
    total.set(d, s);
    return s;
  };
  const chunks = [];
  const visit = (d) => {
    const n = subtotal(d);
    if (n === 0) return;
    if (n <= fileCap) {
      chunks.push({ dir: d, shallow: false });
      return;
    }
    if ((direct.get(d) || 0) > 0) chunks.push({ dir: d, shallow: true }); // this dir's own files
    for (const k of kids.get(d) || []) visit(k);
  };
  visit(root);
  return chunks;
}

const WORKER_PATH = fileURLToPath(new URL("./symindex-worker.mjs", import.meta.url));

// Build the index by parsing each chunk in an ISOLATED child process (memory resets per chunk → total footprint
// is bounded by the LARGEST single chunk, not the whole tree), `concurrency` at a time, then merging one header
// + all parts. This is what makes a full UE Engine (millions of symbols) indexable at all — the single-process
// builder OOMs on it. Non-incremental (full rebuild). Returns the buildSymIndexSingle shape + { chunks, failed }.
export async function buildSymIndexChunked(
  root,
  {
    fileCap = Number(process.env.VTS_INDEX_CHUNK_FILECAP || 4000),
    concurrency = Number(process.env.VTS_INDEX_CHUNK_CONCURRENCY || Math.min(12, Math.max(2, (os.cpus()?.length || 4) - 2))),
    heapMb = Number(process.env.VTS_INDEX_CHUNK_HEAP_MB || 4096),
    now = Date.now(),
    onProgress,
  } = {},
) {
  const chunks = planChunks(root, { fileCap });
  const dirPath = symIndexDir(root);
  fs.mkdirSync(dirPath, { recursive: true });
  const partDir = path.join(dirPath, ".parts");
  fs.rmSync(partDir, { recursive: true, force: true });
  fs.mkdirSync(partDir, { recursive: true });

  let totFiles = 0,
    totSymbols = 0,
    done = 0,
    failed = 0;
  const H = {};
  const parts = [];
  const runChunk = (c, i) =>
    new Promise((resolve) => {
      const symsPath = path.join(partDir, `part-${i}.jsonl`);
      const args = [`--max-old-space-size=${heapMb}`, WORKER_PATH, root, c.dir, symsPath, c.shallow ? "1" : "0"];
      execFile(process.execPath, args, { maxBuffer: 512 * 1024 * 1024 }, (err, stdout) => {
        done++;
        // A worker can finish ALL its parsing (valid JSON already flushed to stdout) and still exit non-zero —
        // e.g. a libuv teardown assertion crash on process.exit() after tree-sitter WASM cleanup (observed on
        // Windows). That crash is harmless: the work is done and the JSON is already written. So on a non-zero
        // exit, still TRY to parse stdout before giving up — only treat it as a real chunk failure if stdout
        // isn't valid (an actual crash mid-parse, before any output was written).
        if (err) {
          try {
            const r = JSON.parse(stdout);
            totFiles += r.files;
            totSymbols += r.symbols;
            Object.assign(H, r.h);
            if (fs.existsSync(symsPath) && fs.statSync(symsPath).size > 0) parts.push(symsPath);
            if (r.remaining) chunks.push({ dir: "@" + r.remaining, shallow: false });
            if (onProgress) onProgress({ done, total: chunks.length, symbols: totSymbols, recoveredExit: String(err.message || err).split("\n")[0] });
            return resolve();
          } catch {
            failed++;
            if (onProgress) onProgress({ done, total: chunks.length, failedDir: c.dir, err: String(err.message || err).split("\n")[0] });
            return resolve();
          }
        }
        try {
          const r = JSON.parse(stdout);
          totFiles += r.files;
          totSymbols += r.symbols;
          Object.assign(H, r.h);
          if (fs.existsSync(symsPath) && fs.statSync(symsPath).size > 0) parts.push(symsPath);
          // Worker hit its RSS cap and handed back the unprocessed tail — re-dispatch it to a FRESH worker (a new
          // process resets the grow-only WASM heap). Strictly shrinks each round, so this terminates.
          if (r.remaining) chunks.push({ dir: "@" + r.remaining, shallow: false });
        } catch {
          failed++;
        }
        if (onProgress) onProgress({ done, total: chunks.length, symbols: totSymbols });
        resolve();
      });
    });
  // Dynamic pool: runChunk may PUSH re-dispatched tail chunks mid-flight, so a runner that finds the queue empty
  // must wait while others are still active (they might enqueue more) before exiting.
  let idx = 0;
  let active = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, chunks.length) }, async () => {
      for (;;) {
        if (idx >= chunks.length) {
          if (active > 0) {
            await new Promise((r) => setTimeout(r, 20));
            continue;
          }
          break;
        }
        const my = idx++;
        active++;
        try {
          await runChunk(chunks[my], my);
        } finally {
          active--;
        }
      }
    }),
  );

  // Merge: header line + every part's symbols, streamed (never one giant string — the index can exceed 512 MB).
  const header = JSON.stringify({ v: SYMINDEX_VERSION, built: now, files: totFiles, symbols: totSymbols, maxMtime: _maxMtimeOf(H), partial: failed > 0 || undefined, h: H });
  const finalPath = symIndexPath(root);
  // GUARD (mirror of buildSymIndexSingle): refuse to clobber an EXISTING index with a 0-symbol build. Every
  // chunk yielding 0 symbols means the workers' tree-sitter grammar is unavailable/incompatible (a dylink /
  // ABI mismatch), not that the tree has no code. Live: a web-tree-sitter 0.26 mismatch produced 0 symbols and
  // destroyed a 3.9M-symbol index. Keep the existing symbols.jsonl and surface the cause.
  if (totSymbols === 0 && fs.existsSync(finalPath)) {
    fs.rmSync(partDir, { recursive: true, force: true });
    throw new Error(
      "vts index: chunked build produced 0 symbols on a tree that already has an index — tree-sitter grammar " +
        "is unavailable/incompatible in the index workers. Kept the existing symbols.jsonl (refusing to " +
        "overwrite it with an empty index). Reinstall in the server dir: npm i web-tree-sitter@^0.25 tree-sitter-wasms",
    );
  }
  const out = fs.createWriteStream(finalPath, { encoding: "utf8" });
  out.write(header + "\n");
  for (const pp of parts) {
    await new Promise((res, rej) => {
      const rs = fs.createReadStream(pp, { encoding: "utf8" });
      rs.on("error", rej);
      rs.on("end", res);
      rs.pipe(out, { end: false });
    });
  }
  await new Promise((res) => out.end(res));
  fs.rmSync(partDir, { recursive: true, force: true });
  return { files: totFiles, symbols: totSymbols, path: finalPath, partial: failed > 0, chunks: chunks.length, failed };
}

// Public entry: dispatch a giant tree to the chunked multi-process builder, a normal tree to the in-process one.
// A tree with > VTS_INDEX_CHUNK_THRESHOLD (default 20000) supported files goes chunked. Force with opts.chunked
// =true / disable with opts.chunked=false. Chunked mode ignores `incremental` (it's always a full rebuild).
// GRAMMAR SELF-HEAL: `vts index` needs web-tree-sitter + tree-sitter-wasms, but a marketplace/plugin update
// wipes node_modules and the index path — unlike the MCP server spawn (which self-heals its own deps) — has no
// other recovery, so a rebuild would silently produce 0 symbols and (before the 0-symbol guard) clobber a good
// index. Install them here, PINNED to ^0.25: web-tree-sitter 0.26's wasm dylink format is incompatible with the
// tree-sitter-wasms grammars and fails to load (getDylinkMetadata). Best-effort + synchronous — runs once before
// any worker spawns; if it can't install, the build still aborts safely via the 0-symbol guard below.
function ensureGrammar() {
  const req = createRequire(import.meta.url);
  try {
    req.resolve("web-tree-sitter");               // main entry — exports-safe (the ./package.json subpath is blocked on 0.25+)
    req.resolve("tree-sitter-wasms/package.json"); // grammar pkg (treesitter.js resolves it exactly this way)
    return; // both present — package.json pins web-tree-sitter to ^0.25, so an installed copy is dylink-compatible
  } catch { /* missing → install below */ }
  const here = path.dirname(fileURLToPath(import.meta.url)); // server dir — treesitter.js resolves grammars from here
  const isWin = process.platform === "win32";
  const local = path.join(path.dirname(process.execPath), isWin ? "npm.cmd" : "npm");
  const npm = fs.existsSync(local) ? `"${local}"` : "npm";
  process.stderr.write("[vts index] tree-sitter grammar missing or incompatible — installing web-tree-sitter@^0.25 + tree-sitter-wasms (one-time)…\n");
  try {
    execSync(`${npm} install web-tree-sitter@^0.25 tree-sitter-wasms --no-audit --no-fund --no-save --loglevel=error`, { cwd: here, stdio: "ignore", timeout: 300000 });
  } catch (e) {
    process.stderr.write(`[vts index] grammar auto-install failed (${e && e.message}). Run manually in ${here}: npm i web-tree-sitter@^0.25 tree-sitter-wasms\n`);
  }
}

export async function buildSymIndex(root, opts = {}) {
  ensureGrammar();
  const threshold = Number(process.env.VTS_INDEX_CHUNK_THRESHOLD || 20000);
  let useChunked = opts.chunked === true;
  if (opts.chunked === undefined) useChunked = countSupported(root, threshold + 1) > threshold;
  const r = useChunked ? await buildSymIndexChunked(root, opts) : await buildSymIndexSingle(root, opts);
  // Phase 2: build the on-disk query sidecars (symbols.pos + tokens.idx + trigrams.idx) so later queries never
  // pay the cold in-memory posting build. Best-effort — a query still works (in-memory tier) if this fails.
  if (_ondiskOn && opts.ondisk !== false && r && r.symbols > 0) {
    try {
      const idx = loadSymIndex(root);
      if (idx) r.ondisk = _writeOnDisk(root, idx.entries, symIndexPath(root));
    } catch (e) {
      r.ondiskError = String((e && e.message) || e);
    }
  }
  return r;
}

// Parsed-index cache, keyed by file path → { mt, sz, data }. The whole point of the committed index is the
// INSTANT cold query, but a giant tree's symbols.jsonl can be ~100MB / ~700k lines, and re-reading + JSON.parsing
// every line on EVERY search_symbol made the query itself time out (MCP -32001) — the opposite of instant. In a
// warm/daemon process (where repeat queries actually happen) we parse once and reuse until the file's mtime+size
// change (a rebuild rewrites it → cache auto-invalidates). A per-call one-shot spawn naturally gets a cold parse,
// which is why a warm daemon is the supported way to serve a large index. Disable with VTS_SYMINDEX_CACHE=0.
const _loadCache = new Map();
const _cacheOn = process.env.VTS_SYMINDEX_CACHE !== "0";

// Load the index. Returns { meta, entries:[{f,n,k,l}] } or null if absent/unreadable.
export function loadSymIndex(root) {
  const p = symIndexPath(root);
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return null;
  }
  if (_cacheOn) {
    const c = _loadCache.get(p);
    if (c && c.mt === st.mtimeMs && c.sz === st.size) return c.data;
  }
  // Read as a Buffer and split lines manually. A big index (e.g. a full UE Engine → ~560 MB / ~4M lines) exceeds
  // V8's max STRING length (~512 MB), so readFileSync(p,"utf8") THROWS ("Cannot create a string longer than
  // 0x1fffffe8 characters") and the old code silently returned null — the index was unusable above ~512 MB.
  // A Buffer has no such cap (up to 2 GB); we stringify only ONE LINE at a time, well under the limit.
  let buf;
  try {
    buf = fs.readFileSync(p);
  } catch {
    return null;
  }
  if (!buf.length) return null;
  let meta = {};
  const entries = [];
  const NL = 0x0a,
    CR = 0x0d;
  let start = 0,
    lineNo = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i !== buf.length && buf[i] !== NL) continue;
    let end = i;
    if (end > start && buf[end - 1] === CR) end--; // strip \r
    if (end > start) {
      const line = buf.toString("utf8", start, end);
      if (lineNo === 0) {
        // First line is the header on a v-tagged file; on a legacy headerless file it's a symbol record.
        try {
          const o = JSON.parse(line);
          if (o && o.v) meta = o;
          else if (o && o.n) entries.push(o);
        } catch {
          /* tolerate */
        }
      } else {
        try {
          const o = JSON.parse(line);
          if (o && o.n) entries.push(o);
        } catch {
          /* skip bad line */
        }
      }
      lineNo++;
    }
    start = i + 1;
  }
  const data = { meta, entries };
  if (_cacheOn) _loadCache.set(p, { mt: st.mtimeMs, sz: st.size, data });
  return data;
}

// ── Inverted + trigram index (query accelerator) ──────────────────────────────────────────────────────────
// The naive search scored EVERY entry (a full UE index is ~4M symbols → ~0.7s linear scan per query even warm).
// Following classic IR (token inverted index) + code-search practice (Russ Cox / Zoekt trigram index; the n-gram
// selection study arXiv:2504.12251), we precompute two postings maps ONCE per loaded index (cached on the parsed
// object): token → entry-ids (camelCase-split, lowercased) and 3-gram → entry-ids. A query then scores only the
// small CANDIDATE POOL those postings yield, not all 4M. symbolMatchScore stays the source of truth for ranking,
// so precision is unchanged — the postings only PRUNE which entries it looks at (they're a superset of any match).
// Disable with VTS_SYMINDEX_INVERTED=0 (falls back to the full scan). Build is O(symbols) once, amortized by cache.
const _invertedOn = process.env.VTS_SYMINDEX_INVERTED !== "0";

function _tokenize(name) {
  return splitIdent(name).map((t) => t.toLowerCase()).filter(Boolean);
}
function _trigrams(s) {
  const ls = s.toLowerCase();
  const out = [];
  for (let i = 0; i + 3 <= ls.length; i++) out.push(ls.slice(i, i + 3));
  return out;
}
function _push(m, k, i) {
  let a = m.get(k);
  if (!a) {
    a = [];
    m.set(k, a);
  }
  if (a[a.length - 1] !== i) a.push(i); // entries iterated in order → dedupe by tail
}
// Both posting maps are built LAZILY, on the first query that needs them (token map for multi-word queries,
// trigram map for single-word substring queries), so a cold load pays only for the index its workload uses — not
// both. The trigram map is ~15× larger (every 3-gram of every name → ~60M postings on a UE tree).
function _buildTokenPostings(entries) {
  const tok = new Map();
  for (let i = 0; i < entries.length; i++) {
    const n = entries[i].n;
    if (!n) continue;
    const seen = new Set();
    for (const t of _tokenize(n)) if (!seen.has(t)) { seen.add(t); _push(tok, t, i); }
  }
  return tok;
}
function _buildTrigramIndex(entries) {
  const tri = new Map();
  for (let i = 0; i < entries.length; i++) {
    const n = entries[i].n;
    if (!n) continue;
    for (const g of new Set(_trigrams(n))) _push(tri, g, i);
  }
  return tri;
}
// Candidate entry-ids for query `q`: union of its tokens' postings, plus (for substring/non-token queries) the
// INTERSECTION of its trigrams' postings (every symbol containing q as a substring must contain all its 3-grams).
// Returns null → "no pruning signal, scan everything" (safety: never a false negative).
// Candidate entry-ids for query `q`, chosen to EXACTLY mirror symbolMatchScore's matching rule so the pool is a
// faithful superset (no false negatives):
//   • multi-word query (whitespace) → token-coverage matching → UNION of the query tokens' postings.
//   • single-word query → substring matching (ln.includes(lq)) → INTERSECTION of the query's 3-gram postings
//     (a substring implies every one of its 3-grams is present). A 3-gram absent from the index ⇒ no match at
//     all ⇒ empty pool. Queries under 3 chars have no trigram → null (full scan; almost anything contains them).
// Returns a sorted entry-id array, an empty array (definitely no matches), or null (no pruning → scan all).
function _candidates(idx, q, qTokens) {
  const inv = idx.inv;
  const raw = String(q);
  if (qTokens.length >= 2 && /\s/.test(raw)) {
    if (!inv.tok) inv.tok = _buildTokenPostings(idx.entries); // lazy: first multi-word query builds it, once
    const cand = new Set();
    for (const t of qTokens.map((x) => x.toLowerCase()).filter(Boolean)) {
      const a = inv.tok.get(t);
      if (a) for (const i of a) cand.add(i);
    }
    return cand.size ? [...cand].sort((a, b) => a - b) : null;
  }
  const lq = raw.toLowerCase();
  if (lq.length < 3) return null;
  if (!inv.tri) inv.tri = _buildTrigramIndex(idx.entries); // lazy: first single-word query builds it, once
  let inter = null;
  for (const g of [...new Set(_trigrams(lq))]) {
    const a = inv.tri.get(g);
    if (!a) return []; // this 3-gram appears in no symbol → the substring can't either
    if (inter === null) inter = new Set(a);
    else { const ni = new Set(); for (const i of a) if (inter.has(i)) ni.add(i); inter = ni; }
    if (!inter.size) break;
  }
  // Sort by entry-id so the pool scans in the SAME order as a full scan → rank ties break identically (a capped
  // top-N picks the same tied subset the unaccelerated path would). Determinism, not recall.
  return inter ? [...inter].sort((a, b) => a - b) : null;
}

// Run a query through the on-disk reader (Phase 2): prune to a candidate pool via the on-disk postings, then
// score only those candidates' symbol lines. Same ranking/fallback as the in-memory path. Returns null to signal
// "no pruning available — fall back to the full in-memory scan" (a <3-char query).
// Tiebreak among equal name-match scores: surface real DEFINITIONS above forward-declarations. A type-name
// search on a heavily forward-declared symbol otherwise buries the definition under hundreds of `struct Foo;`
// forward decls and the maxResults cap drops it entirely (live dogfood: FSkeletalMeshLODRenderData — the real
// struct at SkeletalMeshLODRenderData.h sat below 196 forward-decls and never made the top-30). "decl" is
// tree-sitter's non-definition declaration bucket; incidental members/params rank between the two.
function kindSortRank(k) {
  if (k === "decl") return 2;                                        // forward declaration — least useful
  if (k === "member" || k === "field" || k === "param" || k === "var") return 1;
  return 0;                                                          // class/struct/enum/func/method/ctor/namespace = definition
}

function _searchViaReader(reader, root, q, qTokens, max) {
  const pool = _candidatesOnDisk(reader, q, qTokens);
  if (pool === null) return null; // no trigram/token signal → let the in-memory tier full-scan it
  const scan = (coverMin) => {
    const h = [];
    for (const id of pool) {
      const e = reader.readSymbol(id);
      if (!e) continue;
      const r = symbolMatchScore(e.n, qTokens, q, coverMin);
      if (r) h.push({ name: e.n, kind: e.k, file: path.join(root, e.f).replace(/\\/g, "/"), line: e.l, rank: r });
    }
    return h;
  };
  let hits = scan(1);
  if (!hits.length && qTokens.length >= 2 && /\s/.test(q)) hits = scan(Number(process.env.VTS_SYM_COVER_MIN ?? 0.6));
  hits.sort((a, b) => b.rank - a.rank || kindSortRank(a.kind) - kindSortRank(b.kind) || a.name.length - b.name.length);
  const sliced = hits.slice(0, max);
  if (hits.length > max) sliced.truncated = "cap";
  sliced.fromIndex = true;
  return sliced;
}

// Query the committed index for symbols matching `q`. Returns hits shaped like tsSearchSymbols
// ({ name, kind, file (ABSOLUTE), line }) so core.js formats both tiers identically. `.fromIndex` marks the
// source; `.truncated="cap"` when more than `max` matched.
export function searchSymIndex(root, q, { max = 40 } = {}) {
  const qTokens = splitIdent(q); // token-aware (LocAgent): multi-word "warm cap" now scores warmCap by coverage
  // Phase 2: on-disk tier first (no large load). Returns null only when it can't prune (e.g. a <3-char query),
  // which falls through to the in-memory tier below.
  if (_ondiskOn) {
    const reader = _openReader(root);
    if (reader) {
      const res = _searchViaReader(reader, root, q, qTokens, max);
      if (res !== null) return res;
    }
  }
  const idx = loadSymIndex(root);
  if (!idx) return null;
  if (_invertedOn && !idx.inv) idx.inv = { tok: null, tri: null }; // posting maps built lazily; ride loadSymIndex cache
  const pool = idx.inv ? _candidates(idx, q, qTokens) : null; // sorted entry-ids, [] (no match), or null → full scan
  const scan = (coverMin) => {
    const h = [];
    const consider = (e) => {
      const r = symbolMatchScore(e.n, qTokens, q, coverMin);
      if (r) h.push({ name: e.n, kind: e.k, file: path.join(root, e.f).replace(/\\/g, "/"), line: e.l, rank: r });
    };
    if (pool) for (const i of pool) consider(idx.entries[i]);
    else for (const e of idx.entries) consider(e);
    return h;
  };
  let hits = scan(1); // strict AND pass (precise)
  // PARTIAL fallback (only when the precise pass found nothing on a multi-word query) — admits a name covering
  // >= VTS_SYM_COVER_MIN of the query tokens, so "warm cache boot" still surfaces warmCache. No precision cost:
  // a non-empty AND result is never diluted with partials.
  if (!hits.length && qTokens.length >= 2 && /\s/.test(q)) hits = scan(Number(process.env.VTS_SYM_COVER_MIN ?? 0.6));
  hits.sort((a, b) => b.rank - a.rank || kindSortRank(a.kind) - kindSortRank(b.kind) || a.name.length - b.name.length);
  const sliced = hits.slice(0, max);
  if (hits.length > max) sliced.truncated = "cap";
  sliced.fromIndex = true;
  sliced.meta = idx.meta;
  return sliced;
}
