#!/usr/bin/env node
// Self-contained eval for gamedev-log-analyzer. Generates a SYNTHETIC, sanitized log (no real project
// data) and measures the core promises: parse coverage, token reduction, dedup collapse, and
// field-extraction size. Exits non-zero if any metric falls below threshold — a regression guard
// and a measurable target for future self-improvement. No dependencies (pure logs.js); CI-friendly.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeLog, extractFields, parseLine, diffLogs, locateLog, readText } from "../server/logs.js";
import { runTool } from "../server/core.js";
import { shouldBlockLogBash, normalizeMode, shouldBlockRead, nudgeText, READ_MIN_BYTES } from "../server/enforce.js";

// Deterministic synthetic UE-style log (generic names only).
function makeLog(n) {
  const out = [];
  const ms = (i) => String(i % 1000).padStart(3, "0");
  const fr = (i) => String(i % 600).padStart(4);
  for (let i = 0; i < n; i++) {
    const ts = (1000 + i * 0.016).toFixed(3);
    const actor = `Actor_${i % 12}`;
    const t = i % 10;
    if (t < 6) {
      out.push(`[2024.01.01-00.00.00:${ms(i)}][${fr(i)}]LogMove: Display: Mover.cpp(566) Tick Pawn=${actor} ts=${ts} Pos=(${-(i % 500)}.0, ${i % 900}.0, 130.0) Alpha=${(i % 100) / 100}`);
    } else if (t < 9) {
      out.push(`[2024.01.01-00.00.00:${ms(i)}][${fr(i)}]LogSync: Warning: Sync.cpp(120) Drift Pawn=${actor} ts=${ts} Gap=${i % 50}`);
    } else if (i % 50 === 0) {
      out.push(`Src/Build.cpp(${100 + (i % 30)}): error C2065: undeclared identifier`);
    } else {
      out.push(`[2024.01.01-00.00.00:${ms(i)}][${fr(i)}]LogNull: Error: Null.cpp(45) null pointer id ${i}`);
    }
  }
  return out.join("\n");
}

const tok = (s) => Math.round(Buffer.byteLength(String(s), "utf8") / 4);
const N = 4000;
const log = makeLog(N);
const lines = log.split("\n");

let parsed = 0;
for (const l of lines) if (parseLine(l)) parsed++;
const coverage = parsed / lines.length;

const rawTok = tok(log);
const summary = analyzeLog(log, { severityMin: "Warning", maxGroups: 40, groupBy: "callsite" });
const sumTok = tok(summary);
const reduction = 1 - sumTok / rawTok;
const groups = (summary.match(/@ [\w./]+:\d+/g) || []).length;
const fieldsTok = tok(extractFields(log, { query: "Tick", fields: ["Pawn", "Alpha", "ts"], max: 20 }));

// diff: B = same run plus a handful of injected NEW errors. A near-identical pair must
// yield a near-empty diff — the delta-only token win vs re-summarizing the whole log.
const logB = makeLog(N)
  .split("\n")
  .map((l, i) => (i % 800 === 0 ? `[2024.01.01-00.00.00:000][   0]LogGpu: Error: Gpu.cpp(9) device removed during present` : l))
  .join("\n");
const diff = diffLogs(log, logB, { severityMin: "Warning" });
const diffTok = tok(diff);
const diffHasNew = /\+ NEW/.test(diff);
const diffVsRaw = 1 - diffTok / rawTok; // honest win: delta vs re-reading the whole log

// locate: jump list (distinct file:line only) must be a compact handoff and carry no message bodies.
const locate = locateLog(log, { severityMin: "Error", basename: true });
const locateTok = tok(locate);
const locateHasLoc = /\.cpp:\d+/.test(locate); // jumpable basename:line present
const locateNoBodies = !/undeclared identifier|null pointer/.test(locate); // no message text leaked

// hybrid wiring: the shared runTool() (used by BOTH the MCP server and the CLI) must dispatch and
// produce the same compact output as calling logs.js directly. Guards the core.js refactor.
const tmp = path.join(os.tmpdir(), "gamedev-log-eval-core.log");
fs.writeFileSync(tmp, log);
const viaCore = runTool("log_search", { path: tmp, severityMin: "Warning", groupBy: "callsite" });
// runTool wraps the exact engine output ("Source: <path>\n" + engineOut [+ coverage/savings lines]),
// so MCP=CLI=engine ⇒ the engine output must be embedded verbatim.
const engineOut = analyzeLog(log, { severityMin: "Warning", groupBy: "callsite" });
const coreOk = !viaCore.isError && viaCore.text.includes(engineOut);
try { fs.unlinkSync(tmp); } catch { /* ignore */ }

// coverage hint: an unknown format (<40% parsed, ≥100 lines) gets a one-line nudge to the learnings
// ledger; a supported log does not. Guards the self-learning "surface the gap" behavior.
const junkPath = path.join(os.tmpdir(), "gamedev-log-eval-junk.log");
fs.writeFileSync(junkPath, Array.from({ length: 150 }, () => "random telemetry blob alpha 1 beta 2").join("\n"));
const hintOnUnknown = /Only \d+% of lines parsed/.test(runTool("log_summary", { path: junkPath }).text);
try { fs.unlinkSync(junkPath); } catch { /* ignore */ }
const covHintOk = hintOnUnknown && !/Only \d+% of lines parsed/.test(viaCore.text); // supported log → no hint

// tail-read (huge logs): reading the last N bytes starts mid-file, so the leading partial line must be
// dropped — parsing has to begin on a clean line boundary, never on a fragment.
const tailLines = Array.from({ length: 500 }, (_, i) => `LINE${String(i).padStart(4, "0")}: padding content xxxxxxxx`);
const tailText = tailLines.join("\n");
const tailPath = path.join(os.tmpdir(), "gamedev-log-eval-tail.log");
fs.writeFileSync(tailPath, tailText);
const tailed = readText(tailPath, Math.floor(Buffer.byteLength(tailText) / 2) + 7); // cut lands mid-line
try { fs.unlinkSync(tailPath); } catch { /* ignore */ }
const firstReal = tailed.split("\n")[1] || ""; // line[0] is the "…truncated…" marker
const tailOk = /^LINE\d{4}: /.test(firstReal); // a COMPLETE line, not a fragment

// fields --stats: aggregate each numeric column to one min/max/avg/Δ line (fewer tokens than rows).
const statsOut = extractFields(log, { fields: ["Alpha", "Gap"], query: "", severityMin: "Display", stats: true });
const statsOk = /Alpha: n=\d+ min=/.test(statsOut) && /avg=/.test(statsOut) && /Δ=/.test(statsOut) && !/\bts\tAlpha\b/.test(statsOut);

// savings: a big log (>5000 raw tok) gets a per-call "✓ Saved ~N tokens here" line via runTool.
const savingsLineOk = /✓ Saved ~[\d,]+ tokens here/.test(viaCore.text); // viaCore = summary of the 117k-tok synthetic log

// Multi-engine classification — SYNTHETIC samples from each engine's documented format. UE + MSVC build
// are live-verified; Unity-deep + Godot are BEST-EFFORT (format from public docs, NOT verified against
// real Unity/Godot logs). This guards the documented shapes only, not real-world coverage.
const engineCases = [
  { line: "Assets/Game/Foo.cs(12,34): error CS1002: ; expected", sev: "Error", cat: "Build", code: "CS1002" }, // Unity C# compile
  { line: "MyLib.obj : error LNK2019: unresolved external symbol", sev: "Error", cat: "Build", code: "LNK2019" }, // MSVC linker
  { line: "SCRIPT ERROR: Invalid call in base 'Node'.", sev: "Error", cat: "Godot" }, // Godot ⚠️ unverified
  { line: "USER WARNING: deprecated API used", sev: "Warning", cat: "Godot" }, // Godot ⚠️ unverified
  { line: "   at: Player._process (res://player.gd:42)", sev: "Display", cat: "Godot", loc: "res://player.gd:42" },
  { line: "NullReferenceException: Object reference not set", sev: "Error" }, // Unity runtime (generic)
  // JSONL — live-verified against a real UE AIMovementDebug .jsonl (severity from verbosity, category
  // from stage, message from message). bunyan/pino/serilog key aliases handled too.
  { line: '{"ts":17750181.6,"verbosity":"Log","stage":"ServerCMCPos","message":"[AISyncBlend] Pawn=X Vel=0"}', sev: "Display", cat: "ServerCMCPos" },
  { line: '{"level":"error","logger":"net","msg":"connection refused"}', sev: "Error", cat: "net" }, // bunyan/pino
  { line: '{"@l":"Warning","SourceContext":"App.Db","message":"slow query"}', sev: "Warning", cat: "App.Db" }, // serilog
  // Common text formats — BEST-EFFORT (not verified against a specific app's real logs).
  { line: "2024-01-02 03:04:05,123 - app.worker - ERROR - task failed", sev: "Error", cat: "app.worker" }, // python logging
  { line: "[WARN] disk almost full", sev: "Warning", cat: "Log" }, // bracketed level
];
const engineOk = engineCases.every((c) => {
  const e = parseLine(c.line);
  return e && e.severity === c.sev && (!c.cat || e.category === c.cat) && (!c.loc || e.location === c.loc) && (!c.code || e.code === c.code);
});

// Build-warning code rollup: a noisy build with the SAME diagnostic code (C4996) on many DISTINCT
// deprecated APIs must collapse to ONE line per code under groupBy=code, even though each message
// (different identifiers, no numbers) is a distinct template. This is the big token win on UE/MSVC
// builds where grep dumps every warning line. groupBy=template can't merge them; groupBy=code does.
const deprApis = ["LegacyAlpha", "LegacyBravo", "LegacyCharlie", "LegacyDelta", "LegacyEcho", "LegacyFoxtrot", "LegacyGolf", "LegacyHotel"];
const buildLog = deprApis
  .map((nm, i) => `Source/Mod/File_${nm}.cpp(${120 + i},4): warning C4996: '${nm}': has been deprecated, use New${nm}() instead`)
  .concat([
    "Source/Mod/Net.cpp(10,2): error C2065: undeclared identifier",
    "Source/Mod/Net.cpp(55,8): error C2065: undeclared identifier",
    "MyLib.obj : error LNK2019: unresolved external symbol",
  ])
  .join("\n");
const codeCaptured = parseLine(buildLog.split("\n")[0]).code === "C4996"; // code captured, not swallowed
const byCode = analyzeLog(buildLog, { severityMin: "Warning", groupBy: "code" });
const byTemplate = analyzeLog(buildLog, { severityMin: "Warning", groupBy: "template" });
const bodyGroups = (s) => (s.match(/^(?:WARNING|ERROR|FATAL) \[/gm) || []).length;
const codeRollupOne = /C4996: .*\(×8\)/.test(byCode); // all 8 distinct C4996 deprecations on one line
const codeFewerGroups = bodyGroups(byCode) < bodyGroups(byTemplate); // code collapses what template can't
const codeRollupOk = codeCaptured && codeRollupOne && codeFewerGroups;

// log_diff must honor groupBy=code too (regression: diffLogs silently forced "code" → "template", so a
// code-rolled diff exploded into one row per distinct message and the header lied about the grouping).
// A has no C4996; B is the noisy build with 8 DISTINCT C4996 deprecations. Under groupBy=code they must
// collapse into ONE new group (×8) and the header must announce groupBy=code; template keeps all 8 — so
// the code diff has strictly fewer NEW groups. Under the old bug every clause fails (template grouping).
const diffBase = "Source/Mod/Net.cpp(10,2): error C2065: undeclared identifier";
const diffByCode = diffLogs(diffBase, buildLog, { severityMin: "Warning", groupBy: "code" });
const diffByTemplate = diffLogs(diffBase, buildLog, { severityMin: "Warning", groupBy: "template" });
const newRows = (s) => (s.match(/^\+ [A-Z]+ \[/gm) || []).length; // NEW item rows (excludes the "+ NEW (n):" header)
const diffByCodeOk =
  /groupBy=code/.test(diffByCode) && /C4996: .*\(×8\)/.test(diffByCode) && newRows(diffByCode) < newRows(diffByTemplate);

// JSONL field extraction — the JSON `Actor=(x,y,z)` inside `message` + top-level `ts` must resolve so
// `log_fields` works on JSONL trace logs (live-verified on a real UE movement log).
const jsonlLog = [
  '{"ts":100.0,"verbosity":"Log","stage":"Pos","message":"Pawn=A Actor=(10.0, 20.0, 5.0) Vel=400"}',
  '{"ts":100.1,"verbosity":"Log","stage":"Pos","message":"Pawn=A Actor=(13.0, 24.0, 5.0) Vel=410"}',
].join("\n");
const jsonlOut = extractFields(jsonlLog, { fields: ["ts", "Actor.x", "Vel", "step:Actor"], category: "Pos", severityMin: "Display", max: 10 });
const jsonlOk = /(^|\n)100\t10\.0\t400\t/.test(jsonlOut) && /\t5\.00$/.test(jsonlOut); // step = hypot(3,4)=5.00

// Log-grep enforcement: the PreToolUse hook must catch raw Bash log reads (grep/tail/cat over
// .log/.jsonl/Logs) and steer them to gamedev-log, while leaving code grep and non-log reads alone.
const enfCases = [
  // unbounded reads of a log = floods → block
  ["grep -i warning build.log", true],
  ["cat crash.jsonl", true],
  ["rg pattern G:/Proj/Saved/Logs/run.log", true],
  ["tail -n 5000 build.log", true], // large -n → flood
  ["tail -f Saved/Logs/Editor.log", true], // live stream → unbounded
  ["tail -n +1 build.log", true], // from line 1 to EOF → whole file
  // bounded peeks / count-only reads can't flood → pass (mirrors the Read slice escape)
  ["tail -3 Saved/Logs/Editor.log | grep -cE error", false], // the original incident — 3 lines + a count
  ["tail -8 build.log", false],
  ["head -20 Saved/Logs/Editor.log", false],
  ["tail build.log", false], // default 10 lines
  ["grep -c error build.log", false], // count only = one number
  // non-log / non-read-exec → pass
  ["grep TODO src/Foo.cpp", false], // code file, not a log
  ["node server/cli.js search --path x.log", false], // analyzer's own call (node, not a read exec)
  ["head -20 notes.txt", false], // txt is not a log
  ["ls Logs/", false], // ls is not a read-exec
  // variable indirection: path in the assignment, read in a later segment
  ['log=/p/x.log; cat "$log"', true], // bareword RHS, deref, full cat → block
  ['L="/p/run.jsonl"; grep err "$L"', true], // unbounded grep of a var-bound log → block
  ['log="/p/x.log"; tail -8 "$log"', false], // var-bound but bounded peek → pass
  ['log="/p/x.log"; echo "$log"', false], // echo is not a read-exec → not a flood
  ['f="notes.txt"; cat "$f"', false], // var bound to a non-log → precise, no block
  ['tail -3 "$log" | grep err', false], // $log never bound → unknown, allow
];
const enforceClassifyOk = enfCases.every(([c, exp]) => shouldBlockLogBash(c) === exp);
const enforceModeOk =
  normalizeMode("on") === "block" && normalizeMode("0") === "off" &&
  normalizeMode("nudge") === "warn" && normalizeMode("bogus") === null;
const enforceStatusOk = /Log-grep enforcement: (block|warn|off)/.test(runTool("log_enforce", {}).text);

// Read-tool enforcement: intercept only an UNBOUNDED read of a LARGE log. A slice (offset/limit),
// a small log, a non-log file, or an unknown size (stat failed → 0) must all pass — the slice path is
// the one-step escape so a blocked Read never strands the model.
const big = READ_MIN_BYTES + 1, small = READ_MIN_BYTES - 1;
const readCases = [
  ["Saved/Logs/Editor.log", big, false, true],   // large log, unbounded → block
  ["Editor.log", big, true, false],               // sliced (offset/limit) → always allow
  ["Editor.log", small, false, false],            // small log → allow (cheap)
  ["src/Foo.cpp", big, false, false],             // non-log code file → allow
  ["run.jsonl", big, false, true],                // large .jsonl → block
  ["", big, false, false],                        // no path → allow
  ["Editor.log", 0, false, false],                // stat failed (size 0) → allow (fail-open)
];
const readClassifyOk = readCases.every(([p, sz, sliced, exp]) => shouldBlockRead(p, sz, sliced) === exp);
// the nudge must tell the truth about HOW the read happened + offer the right escape per kind
const nudgeOk =
  /via the Read tool/.test(nudgeText("Editor.log", "read")) &&
  /offset.*limit|limit.*offset|`offset`/.test(nudgeText("Editor.log", "read")) &&
  /via Bash/.test(nudgeText("tail x.log", "bash")) &&
  /gamedev-log (summary|search)/.test(nudgeText("x.log", "read"));
const enforceOk = enforceClassifyOk && enforceModeOk && enforceStatusOk && readClassifyOk && nudgeOk;

const rows = [
  ["parse coverage", (coverage * 100).toFixed(1) + "%", "≥ 95%", coverage >= 0.95],
  ["token reduction (callsite)", (reduction * 100).toFixed(1) + "%", "≥ 90%", reduction >= 0.9],
  ["callsite groups", groups, "≤ 20", groups <= 20],
  ["log_fields tokens (20 rows)", fieldsTok, "≤ 400", fieldsTok <= 400],
  ["log_diff tokens (delta-only)", diffTok, "≤ 200", diffTok <= 200],
  ["log_diff surfaces NEW errors", diffHasNew, "true", diffHasNew],
  ["log_diff vs raw log", (diffVsRaw * 100).toFixed(1) + "%", "≥ 99%", diffVsRaw >= 0.99],
  ["runTool dispatch (MCP=CLI)", coreOk, "true", coreOk],
  ["log_locate tokens (jump list)", locateTok, "≤ 150", locateTok <= 150],
  ["log_locate has file:line", locateHasLoc, "true", locateHasLoc],
  ["log_locate omits bodies", locateNoBodies, "true", locateNoBodies],
  ["multi-engine classify (synthetic)", engineOk, "true", engineOk],
  ["build code rollup (groupBy=code)", codeRollupOk, "true", codeRollupOk],
  ["log_diff code rollup (groupBy=code)", diffByCodeOk, "true", diffByCodeOk],
  ["enforce: bash+read+mode+nudge", enforceOk, "true", enforceOk],
  ["JSONL field extraction", jsonlOk, "true", jsonlOk],
  ["coverage hint (unknown fmt only)", covHintOk, "true", covHintOk],
  ["tail-read clean line boundary", tailOk, "true", tailOk],
  ["fields --stats aggregate", statsOk, "true", statsOk],
  ["savings per-call line (big log)", savingsLineOk, "true", savingsLineOk],
];

console.log(`gamedev-log-analyzer eval — ${N} synthetic (sanitized) lines\n`);
let ok = true;
for (const [name, val, thr, pass] of rows) {
  console.log(`${pass ? "✓" : "✗"} ${name.padEnd(30)} ${String(val).padStart(8)}   ${thr}`);
  if (!pass) ok = false;
}
console.log(`\nraw ~${rawTok.toLocaleString()} tok → callsite summary ~${sumTok.toLocaleString()} tok`);
if (!ok) {
  console.error("\nEVAL FAILED: a metric fell below threshold.");
  process.exit(1);
}
console.log("EVAL PASSED.");
