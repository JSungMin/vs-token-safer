// symindex-worker.mjs — parse ONE chunk directory in an isolated child process.
//
// buildSymIndexChunked (symindex.js) forks this once per chunk. Process isolation is the whole point: a giant
// source tree (e.g. a full UE Engine, millions of symbols) blew the V8 heap when parsed in one process — even
// with streaming writes, cumulative per-file parser state exhausted the internal zone. Parsing each chunk in a
// short-lived process resets all of that between chunks, so total memory is bounded by the LARGEST single chunk,
// not the whole tree. Symbols stream to `outPath` (JSONL, no header); the per-file hash manifest is returned on
// stdout so the parent can merge one header + all parts without holding any part's symbols in memory.
//
// argv: <root> <chunkDir> <outPath> [shallow]  — paths are made relative to <root> so the index stays portable.
// shallow=1 indexes ONLY <chunkDir>'s direct files (no recursion) — used for the "self" chunk of a directory
// whose subtree was too big and got split into per-subdir chunks; without it that dir's own files are lost.
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { tsFileSymbols, tsSupports } from "./treesitter.js";
import { fnv1a } from "./warmset.js";
import { defaultSkipDir } from "./symindex.js";

const [root, chunkDir, outPath, shallowArg] = process.argv.slice(2);
if (!root || !chunkDir || !outPath) {
  process.stderr.write("symindex-worker: usage <root> <chunkDir> <outPath> [shallow]\n");
  process.exit(2);
}
const shallow = shallowArg === "1" || shallowArg === "true";

const ws = fs.createWriteStream(outPath, { encoding: "utf8" });
const writeLine = async (s) => {
  if (!ws.write(s)) await once(ws, "drain");
};

let files = 0,
  symbols = 0;
const h = {};
const stack = [chunkDir];
while (stack.length) {
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
      if (!shallow && !defaultSkipDir(e.name) && e.name !== ".vts-index") stack.push(p);
      continue;
    }
    if (!tsSupports(e.name)) continue;
    const rel = path.relative(root, p).replace(/\\/g, "/");
    let st, src;
    try {
      st = fs.statSync(p);
      src = fs.readFileSync(p, "utf8");
    } catch {
      continue;
    }
    let syms;
    try {
      syms = await tsFileSymbols(p);
    } catch {
      continue;
    }
    h[rel] = { mt: Math.round(st.mtimeMs), sz: st.size, h: fnv1a(src) };
    if (!syms.length) continue;
    files++;
    for (const s of syms) {
      await writeLine(JSON.stringify({ f: rel, n: s.name, k: s.kind, l: s.line }) + "\n");
      symbols++;
    }
  }
}
await new Promise((res) => ws.end(res));
process.stdout.write(JSON.stringify({ files, symbols, h }));
