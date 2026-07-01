// symindex-worker.mjs — parse ONE chunk in an isolated child process. buildSymIndexChunked forks this once per
// chunk. Process isolation is the whole point: web-tree-sitter's WASM heap is grow-only (a heavy file — e.g. a
// tree-sitter-swift source — can add ~800MB that never frees), so a long-lived process accumulates until it OOMs
// the V8 zone. A short-lived process resets all of it. But a single chunk can still hold enough heavy files to
// blow one process, so this worker also SELF-LIMITS: after each file it checks RSS, and once over the cap it
// flushes what it has, writes the UNPROCESSED files to a `.remaining` list, and returns that path so the parent
// re-dispatches them to a FRESH worker. Every worker makes progress on ≥1 file, so this always terminates.
//
// argv: <root> <target> <outPath> [shallow]
//   target = a directory (walk it) OR "@<listfile>" (a newline-delimited file list to parse verbatim).
//   shallow=1 → index only <dir>'s direct files (no recursion); ignored for a @listfile.
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { tsFileSymbols } from "./treesitter.js";
import { fnv1a } from "./warmset.js";
import { defaultSkipDir, isIndexable } from "./symindex.js";

const [root, target, outPath, shallowArg] = process.argv.slice(2);
if (!root || !target || !outPath) {
  process.stderr.write("symindex-worker: usage <root> <target> <outPath> [shallow]\n");
  process.exit(2);
}
const shallow = shallowArg === "1" || shallowArg === "true";
const RSS_CAP = Number(process.env.VTS_INDEX_WORKER_RSS_MB || 2500) * 1e6;

function collectFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!shallow && !defaultSkipDir(e.name) && e.name !== ".vts-index") stack.push(p);
      } else if (isIndexable(e.name)) out.push(p);
    }
  }
  return out;
}

const files = target.startsWith("@")
  ? fs.readFileSync(target.slice(1), "utf8").split("\n").filter(Boolean)
  : collectFiles(target);

const ws = fs.createWriteStream(outPath, { encoding: "utf8" });
const writeLine = async (s) => {
  if (!ws.write(s)) await once(ws, "drain");
};

let fileCount = 0,
  symbols = 0;
const h = {};

async function finish(remaining) {
  await new Promise((res) => ws.end(res));
  let remainingPath;
  if (remaining && remaining.length) {
    remainingPath = outPath + ".remaining";
    fs.writeFileSync(remainingPath, remaining.join("\n"));
  }
  process.stdout.write(JSON.stringify({ files: fileCount, symbols, h, remaining: remainingPath }));
  // process.exitCode (not a hard process.exit()) lets the event loop drain naturally instead of force-cutting
  // libuv mid-teardown — a hard exit() here was observed to crash with a libuv assertion on Windows
  // (`UV_HANDLE_CLOSING`, likely a race with tree-sitter's WASM/native cleanup). The orchestrator also tolerates
  // a non-zero exit with valid stdout JSON as a fallback, so this is belt-and-suspenders, not the only guard.
  process.exitCode = 0;
}

for (let k = 0; k < files.length; k++) {
  // Check RSS BEFORE parsing the next file, not after: web-tree-sitter's WASM heap grows per file and never
  // shrinks in-process, so once we're near the cap the very next parse can spike past it and OOM before any
  // after-the-fact check runs. Handing the tail (including this file) to a fresh worker resets that heap. k>0
  // guarantees ≥1 file of progress per worker, so `remaining` strictly shrinks and the re-dispatch terminates.
  if (k > 0 && process.memoryUsage().rss > RSS_CAP) {
    await finish(files.slice(k));
  }
  const p = files[k];
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
  if (syms.length) {
    fileCount++;
    for (const s of syms) {
      await writeLine(JSON.stringify({ f: rel, n: s.name, k: s.kind, l: s.line }) + "\n");
      symbols++;
    }
  }
}
await finish(null);
