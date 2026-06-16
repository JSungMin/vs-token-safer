#!/usr/bin/env node
// Focused verification for the v0.22.0 edit-steer (B) + edit-habit measurement (A) — the layer the
// 287k/30d trend is read off. Two things must be true for the trend to mean anything:
//   B) EDIT_STEER rides the RIGHT results (focused search_symbol / a goto_definition hit) and ONLY those
//      — not a broad 1000-hit dump, not an empty result, not find_references, and it honours the toggle
//      and the size cap. A steer that fires on the wrong things (or never) makes the trend untrustworthy.
//   A) discover's edit-habit counter is EXACT — whole-declaration Edits are counted, sub-declaration /
//      no-cue / non-code / Write are NOT, and a file's prior Read is attributed ONCE (a re-Read re-adds).
//      If the count double-attributes, the 287k headline is inflated (it was, before reads.delete).
// Mock LSP — no toolchain. Run: `node eval/test-edit-steer.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.VTS_CLANGD_CMD = process.execPath;
process.env.VTS_CLANGD_ARGS = new URL("./_mock-lsp.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const tmp = (n) => path.join(os.tmpdir(), `vts-steer-${process.pid}-${n}`);
process.env.VTS_QUERY_HISTORY = tmp("qh.json");
process.env.VTS_INCLUDE_GRAPH = tmp("ig.json");
process.env.VTS_CONFIG_FILE = tmp("cfg.json"); fs.writeFileSync(process.env.VTS_CONFIG_FILE, "{}");
process.env.VTS_SAVINGS_FILE = tmp("sv.json");
process.env.VTS_TEE_DIR = tmp("tee");
process.env.VTS_LANG = "en";
const { runTool, disposeClients } = await import("../server/core.js");

const tok = (s) => Math.round(Buffer.byteLength(String(s), "utf8") / 4);
const STEER = /replace_symbol_body/; // the EDIT_STEER signature marker
const root = process.cwd();
const checks = [];
const check = (name, pass) => checks.push([name, pass]);

// ── B) EDIT_STEER appears on the right results, only the right ones ───────────────────────────────────
// focused search_symbol (mock returns 2 syms for a normal query, ≤ default cap 10) → steer present.
const focused = await runTool("search_symbol", { q: "Spawn", projectPath: root, backend: "clangd" });
check("focused search_symbol → steer present", !focused.isError && STEER.test(focused.text));
// broad result (mock returns 1000 for "ALL", > VTS_EDIT_STEER_MAX) → NOT a likely edit precursor → no steer.
const broad = await runTool("search_symbol", { q: "ALL", projectPath: root, backend: "clangd", maxResults: 60 });
check("broad search_symbol (1000 hits) → no steer", !broad.isError && !STEER.test(broad.text));
// empty result (mock "MISS" → 0 syms, text fallback) → nothing to edit → no steer.
const empty = await runTool("search_symbol", { q: "MISS", projectPath: root, backend: "clangd" });
check("empty search_symbol → no steer", !empty.isError && !STEER.test(empty.text));
// goto_definition with a hit (mock returns 1 location) → landed on a decl → steer present.
const gotoHit = await runTool("goto_definition", { path: "src/Foo.cpp", line: 0, character: 0, projectPath: root, backend: "clangd" });
check("goto_definition hit → steer present", !gotoHit.isError && STEER.test(gotoHit.text));
// find_references is deliberately EXCLUDED (its intent is touch-every-use, not whole-decl replace) → no steer.
const refs = await runTool("find_references", { symbol: "Spawn", projectPath: root, backend: "clangd" });
check("find_references → no steer (excluded by design)", !refs.isError && !STEER.test(refs.text));
// toggle off → steer suppressed everywhere.
process.env.VTS_EDIT_STEER = "0";
const off = await runTool("search_symbol", { q: "Spawn", projectPath: root, backend: "clangd" });
delete process.env.VTS_EDIT_STEER;
check("VTS_EDIT_STEER=0 → steer hidden", !off.isError && !STEER.test(off.text));
// cap boundary: MAX=1 < 2 hits → no steer; MAX=2 == 2 hits → steer. Proves the ≤cap gate, not just on/off.
process.env.VTS_EDIT_STEER_MAX = "1";
const capUnder = await runTool("search_symbol", { q: "Spawn", projectPath: root, backend: "clangd" });
process.env.VTS_EDIT_STEER_MAX = "2";
const capAt = await runTool("search_symbol", { q: "Spawn", projectPath: root, backend: "clangd" });
delete process.env.VTS_EDIT_STEER_MAX;
check("VTS_EDIT_STEER_MAX boundary (1→hide, 2→show for 2 hits)", !capUnder.isError && !STEER.test(capUnder.text) && !capAt.isError && STEER.test(capAt.text));

// ── A) discover edit-habit counter is exact ──────────────────────────────────────────────────────────
const DECL = "void Foo::Bar()\n{\n  a();\n  b();\n  c();\n  d();\n  e();\n  f();\n  g();\n}"; // 9 newlines + "void"/")" cue
const NO_CUE = "  x1 = 1;\n  x2 = 2;\n  x3 = 3;\n  x4 = 4;\n  x5 = 5;\n  x6 = 6;\n  x7 = 7;\n  x8 = 8;\n  x9 = 9;"; // 8 nl, no decl cue
const SHORT = "void Foo()\n{\n  a();\n}"; // has a cue but only 3 newlines (< min)
const BIG = "x ".repeat(2000); // 4000 bytes → tok = 1000; the read a symbol-edit would skip
const u = (() => { let n = 0; return () => `id${++n}`; })();
const NOW = new Date().toISOString(); // recent → inside discover's default since-window (epoch-0 would be filtered out)
const ev = (role, blocks) => JSON.stringify({ type: role === "user" ? "user" : "assistant", cwd: "/p", timestamp: NOW, message: { role, content: blocks } });
const useRead = (id, file) => ({ type: "tool_use", id, name: "Read", input: { file_path: file } });
const resRead = (id, body) => ({ type: "tool_result", tool_use_id: id, content: body });
const useEdit = (file, oldStr, name = "Edit") => ({ type: "tool_use", id: u(), name, input: name === "MultiEdit" ? { file_path: file, edits: [{ old_string: oldStr, new_string: "x" }] } : { file_path: file, old_string: oldStr, new_string: "x" } });
const useWrite = (file, body) => ({ type: "tool_use", id: u(), name: "Write", input: { file_path: file, content: body } });
// Build an isolated transcript dir, run discover scoped to it, parse the edit-habit line.
let dirN = 0;
async function editHabit(lines) {
  const base = tmp(`disc${dirN++}`);
  fs.mkdirSync(path.join(base, "P--proj"), { recursive: true });
  fs.writeFileSync(path.join(base, "P--proj", "t.jsonl"), lines.join("\n") + "\n");
  process.env.VTS_CLAUDE_PROJECTS = base;
  const r = await runTool("vts_discover", { since: 7 });
  delete process.env.VTS_CLAUDE_PROJECTS;
  fs.rmSync(base, { recursive: true, force: true });
  const m = r.text.match(/edit habit: (\d+) whole-declaration Edit\(s\) on code; ~([\d,]+) tok/);
  return m ? { count: Number(m[1]), readTok: Number(m[2].replace(/,/g, "")) } : { count: 0, readTok: 0 };
}
const RT = tok(BIG); // expected tokens for one BIG read
// 1 read + 1 whole-decl edit on the same file → count 1, read attributed once.
const a1 = await editHabit([ev("assistant", [useRead("r1", "/src/Thing.cpp")]), ev("user", [resRead("r1", BIG)]), ev("assistant", [useEdit("/src/Thing.cpp", DECL)])]);
check("A: 1 read + 1 whole-decl edit → count 1, readTok = 1 read", a1.count === 1 && a1.readTok === RT);
// 1 read + 2 whole-decl edits (no re-read) → count 2, read attributed ONCE (the double-count regression net).
const a2 = await editHabit([ev("assistant", [useRead("r1", "/src/Thing.cpp")]), ev("user", [resRead("r1", BIG)]), ev("assistant", [useEdit("/src/Thing.cpp", DECL)]), ev("assistant", [useEdit("/src/Thing.cpp", DECL)])]);
check("A: 1 read + 2 edits → count 2, readTok counted ONCE", a2.count === 2 && a2.readTok === RT);
// read → edit → RE-read → edit → count 2, read re-added (a fresh read is a fresh skippable cost).
const a3 = await editHabit([ev("assistant", [useRead("r1", "/src/Thing.cpp")]), ev("user", [resRead("r1", BIG)]), ev("assistant", [useEdit("/src/Thing.cpp", DECL)]), ev("assistant", [useRead("r2", "/src/Thing.cpp")]), ev("user", [resRead("r2", BIG)]), ev("assistant", [useEdit("/src/Thing.cpp", DECL)])]);
check("A: re-read between edits → readTok re-added (2×)", a3.count === 2 && a3.readTok === RT * 2);
// whole-decl edit with NO prior read → counted, but 0 read tokens to attribute.
const a4 = await editHabit([ev("assistant", [useEdit("/src/Thing.cpp", DECL)])]);
check("A: edit with no prior read → count 1, readTok 0", a4.count === 1 && a4.readTok === 0);
// sub-threshold edit (< VTS_EDIT_MIN_LINES newlines) → NOT a whole-decl edit.
const a5 = await editHabit([ev("assistant", [useEdit("/src/Thing.cpp", SHORT)])]);
check("A: short edit (<8 lines) → not counted", a5.count === 0);
// big edit but NO declaration cue → not counted.
const a6 = await editHabit([ev("assistant", [useEdit("/src/Thing.cpp", NO_CUE)])]);
check("A: big edit, no decl cue → not counted", a6.count === 0);
// whole-decl-shaped edit on a NON-code file → not counted.
const a7 = await editHabit([ev("assistant", [useEdit("/notes/Thing.md", DECL)])]);
check("A: whole-decl edit on a .md → not counted", a7.count === 0);
// MultiEdit carrying a whole-decl edit → counted.
const a8 = await editHabit([ev("assistant", [useEdit("/src/Thing.cpp", DECL, "MultiEdit")])]);
check("A: MultiEdit whole-decl → counted", a8.count === 1);
// Write (a new file, not a symbol replace) → not counted.
const a9 = await editHabit([ev("assistant", [useWrite("/src/New.cpp", DECL)])]);
check("A: Write → not counted", a9.count === 0);

await disposeClients();
console.log("vs-token-safer — edit-steer + edit-habit verification\n");
let ok = true;
for (const [name, pass] of checks) { console.log(`${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; }
if (!ok) { console.error("\nEDIT-STEER TEST FAILED."); process.exit(1); }
console.log(`\n${checks.length}/${checks.length} checks. EDIT-STEER TEST PASSED.`);
