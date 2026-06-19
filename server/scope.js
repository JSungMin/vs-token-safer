// Indexing SCOPE — index/warm a SUBSET of a project instead of the whole tree. This is the single biggest
// cold-index accelerator on a huge monorepo: on a full Unreal Engine source tree (~26k translation units)
// where a developer only touches the game module, scoping clangd to that subtree means it background-indexes
// a few hundred TUs, not all of them — the first-index time drops by the TU ratio. Scope is a comma-list of
// paths relative to the project root (or absolute), set via VTS_SCOPE or the config `scope` key (persisted by
// `vts setup --scope`). Empty scope = the whole tree (unchanged behavior).
//
// The mechanism is twofold and backend-aware:
//   • clangd — DEEP prune: write a filtered compile_commands.json (only in-scope entries) to an out-of-tree
//     dir and point clangd's --compile-commands-dir at it, so the engine itself indexes less (scopedCdb).
//   • every backend (clangd/roslyn/tsserver/pyright) — UNIVERSAL: restrict vts's own file walks (warm-set,
//     find_files, search_text) to the scope subtree via inScope, without touching the user's tsconfig/sln.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const norm = (p) => path.resolve(String(p)).replace(/\\/g, "/").toLowerCase();

// Resolve the scope to a list of absolute, existing directories. `cfgScope` is the config-file `scope` value
// (env VTS_SCOPE wins). Returns [] when no scope is set or none of the paths exist (→ whole-tree behavior).
export function scopeDirs(root, cfgScope) {
  const raw = process.env.VTS_SCOPE || cfgScope || "";
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(path.isAbsolute(s) ? s : path.join(root, s)))
    .filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

// Is `absPath` under any scope dir? Empty scope → everything is in scope (so callers can apply it
// unconditionally: `inScope(f, scopeDirs(...))` is a no-op when no scope is configured).
export function inScope(absPath, dirs) {
  if (!dirs || !dirs.length) return true;
  const f = norm(absPath);
  return dirs.some((d) => { const dd = norm(d); return f === dd || f.startsWith(dd + "/"); });
}

// Write a SCOPED compile_commands.json — only the entries whose source `file` is in scope — to an out-of-tree
// dir and return that dir (clangd then indexes just those TUs). Idempotent: rewrites only when the filtered
// content changes (keyed by the scope set), so repeated spawns don't churn the file or clangd's index. Falls
// back to `srcCdbDir` unchanged when there is no scope, no source DB, or the scope matched zero TUs (never
// strand clangd with an empty DB). `outBase` is dbDirFor(root) — the per-root out-of-tree home.
export function scopedCdb(root, srcCdbDir, dirs, outBase) {
  if (!dirs || !dirs.length || !srcCdbDir) return srcCdbDir;
  let entries;
  try { entries = JSON.parse(fs.readFileSync(path.join(srcCdbDir, "compile_commands.json"), "utf8")); } catch { return srcCdbDir; }
  if (!Array.isArray(entries)) return srcCdbDir;
  const abs = (e) => (path.isAbsolute(e.file) ? e.file : path.join(e.directory || srcCdbDir, e.file));
  const kept = entries.filter((e) => e && e.file && inScope(abs(e), dirs));
  if (!kept.length) return srcCdbDir; // scope matched nothing in the DB → don't hand clangd an empty DB
  const json = JSON.stringify(kept);
  const hash = crypto.createHash("sha1").update(dirs.map(norm).sort().join("|")).digest("hex").slice(0, 10);
  const outDir = path.join(outBase, "scoped-" + hash);
  const outFile = path.join(outDir, "compile_commands.json");
  let prev = ""; try { prev = fs.readFileSync(outFile, "utf8"); } catch { /* none */ }
  if (prev !== json) {
    try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(outFile, json); } catch { return srcCdbDir; }
  }
  return outDir;
}

// Stats for reporting (vts scope / setup): how many of the DB's TUs the scope keeps.
export function scopeStats(srcCdbDir, dirs) {
  try {
    const entries = JSON.parse(fs.readFileSync(path.join(srcCdbDir, "compile_commands.json"), "utf8"));
    if (!Array.isArray(entries)) return null;
    const abs = (e) => (path.isAbsolute(e.file) ? e.file : path.join(e.directory || srcCdbDir, e.file));
    const kept = entries.filter((e) => e && e.file && inScope(abs(e), dirs)).length;
    return { total: entries.length, kept };
  } catch { return null; }
}
