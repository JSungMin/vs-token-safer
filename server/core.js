/*
 * vs-token-safer core — transport-agnostic dispatch.
 * Forces code search through an official language server's index (clangd for C++, the Roslyn/C# LSP)
 * instead of Bash grep, and TOKEN-CAPS the result: symbols/references become a compact `file:line`
 * list (never source bodies), severity-/kind-tagged and capped. Both the MCP server (index.js) and the
 * CLI (cli.js, `vts`) call runTool(); output is identical. Local-only; only this glue + the
 * official engine touch your source — nothing is transmitted.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { LspClient, fromUri, langIdForPath, envInt } from "./lsp.js";
import { pickBackend, BACKENDS, clangdAdvisory, dbDirFor, resolveCdbDir, hasPersistedIndex, findProjectRoot } from "./backends/index.js";
import { recordQueryResults, languageCensus } from "./warmset.js";
import { splitSegments } from "./shell-split.js";
import { compactGit, compactP4 } from "./compact.js";

const CONFIG_DIR = path.join(os.homedir(), ".vs-token-safer");
export const CONFIG_FILE = process.env.VTS_CONFIG_FILE || path.join(CONFIG_DIR, "config.json");
let fileCfg = {};
try { fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {}; } catch { /* none */ }
function cfg(envName, key, def) {
  const e = process.env[envName];
  if (e !== undefined && e !== "") return e;
  const v = fileCfg[key];
  if (v !== undefined && v !== null && v !== "") return v;
  return def;
}
export const PROJECT_PATH = cfg("VTS_PROJECT_PATH", "projectPath", "");
export const BACKEND = cfg("VTS_BACKEND", "backend", ""); // "clangd" | "roslyn" | "" (auto)
export const MAX_RESULTS = parseInt(cfg("VTS_MAX_RESULTS", "maxResults", "60"), 10) || 60;
export const PREWARM_BACKENDS = cfg("VTS_PREWARM_BACKENDS", "prewarmBackends", ""); // "" | auto | all | comma-list
const CONFIG_KEYS = ["projectPath", "backend", "maxResults", "prewarmBackends", "tee", "excludeCommands", "usdPerMtok"];

// ---- per-call project root resolution ----
// The MCP server is ONE long-lived process serving every repo a session touches, so a single configured
// projectPath can't be right for all of them. Resolve the root PER CALL instead, preferring the most
// specific signal available. MCP_ROOTS is the workspace folder(s) the client (Claude Code) advertises via
// the `roots` capability — set by the index.js handshake; empty when the client doesn't support roots, in
// which case behavior collapses to exactly the old `PROJECT_PATH || cwd`.
let MCP_ROOTS = [];
export function setMcpRoots(paths) { MCP_ROOTS = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === "string" && p); }
export function getMcpRoots() { return MCP_ROOTS.slice(); }
function isInside(root, target) {
  try {
    const rel = path.relative(path.resolve(root), path.resolve(target));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  } catch { return false; }
}
// Root for an LSP/filesystem query. Precedence: (1) explicit a.projectPath; (2) the enclosing project of a
// `path` argument — but only walk UP to a NEW root when the path falls OUTSIDE every known root (config pin
// + MCP roots); a path INSIDE a known root keeps that root so clangd's compile-DB rooting is preserved;
// (3) an MCP workspace root (current project) over the stale config pin; (4) PROJECT_PATH; (5) cwd.
export function resolveRoot(a = {}) {
  if (a.projectPath) return a.projectPath;
  const known = [PROJECT_PATH, ...MCP_ROOTS].filter(Boolean);
  const p = a.path || (Array.isArray(a.paths) ? a.paths.find((x) => typeof x === "string") : null);
  if (p) {
    const abs = path.isAbsolute(p) ? p : path.resolve(MCP_ROOTS[0] || PROJECT_PATH || process.cwd(), p);
    const enclosing = known.find((r) => isInside(r, abs));
    if (enclosing) return enclosing;                 // inside a known root → keep it (preserve rooting)
    const found = findProjectRoot(abs);
    if (found) return found;                          // outside all known roots → its real project
  }
  if (MCP_ROOTS.length) {
    return MCP_ROOTS.find((r) => isInside(r, process.cwd())) || MCP_ROOTS[0];
  }
  return PROJECT_PATH || process.cwd();
}
// Root for a CWD-relative external command (git/p4): never the config pin (the user/agent runs these where
// they ARE), but an MCP workspace root beats the long-lived server's own process.cwd().
export function resolveCwdRoot(a = {}) { return a.projectPath || MCP_ROOTS[0] || process.cwd(); }

const tok = (s) => Math.round(Buffer.byteLength(String(s), "utf8") / 4);
// The token size of the RAW alternative a tool replaces. A STRING raw (vts_git/vts_p4 stdout) is exactly
// what the model would otherwise read, so measure it as-is; an ARRAY/OBJECT (an LSP index response that
// would be forwarded as JSON) is measured as JSON. Measuring a string via JSON.stringify would inflate it
// (every \n → \\n, plus quotes) and OVER-report savings — a dogfood-found ledger bug for the git/p4 wrappers.
export const rawTokensOf = (rawObj) => tok(typeof rawObj === "string" ? rawObj : JSON.stringify(rawObj));
// LSP SymbolKind → short label (kept terse for the token cap). Covers the full enum so JS/TS/Python
// symbols (constants, properties, fields, enum members…) render with a name instead of a raw `kN`.
const SYMBOL_KIND = {
  1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class", 6: "method", 7: "prop", 8: "field",
  9: "ctor", 10: "enum", 11: "interface", 12: "func", 13: "var", 14: "const", 15: "str", 16: "num",
  17: "bool", 18: "array", 19: "obj", 20: "key", 22: "enum-member", 23: "struct", 24: "event",
  25: "operator", 26: "type",
};

// --- log steer (mirrors rider-mcp-enforcer 0.2.8): a code search aimed at a LOG should go to the
// gamedev-log analyzer, not the language-server index. The index only covers source — a hover/read/search
// pointed at a log returns empty or errors, and the model often burns calls before switching tools.
// A log-ish target: a Logs/ (or Saved/Logs/) dir, or a .log/.jsonl/.log.N file. Precise enough to skip
// "log" inside "catalog" and ordinary source paths.
const LOG_PATHISH = /(^|[/\\])(saved[/\\])?logs([/\\]|$)|\.(log|jsonl)(\.\d+)?$/i;
function looksLogTarget(a) {
  return [a.path, a.projectPath, a.paths].flat().filter((v) => typeof v === "string").some((v) => LOG_PATHISH.test(v));
}
const LOG_STEER =
  "\n\n↪ This looks like a LOG target. The language-server index only covers source code, not logs — use " +
  "the gamedev-log tools (/gamedev-log-analyzer:logs, or the gamedev-log CLI: summary / search / locate / " +
  "fields / diff) for log analysis instead.";
// Appended to an empty symbol result (mirrors rider's honest empty-result hint): an empty answer can be a
// stale index, a definitions-only match, or a string that only lives in a log (excluded from the index).
const EMPTY_HINT =
  " If you JUST edited the target, the index may lag the save — retry, or use search_text for a literal " +
  "match. search_symbol matches DEFINITIONS, not every reference. Looking for something in a LOG? Logs " +
  "aren't indexed — use gamedev-log.";
const LOG_EMPTY_HINT = " Looking for something in a LOG? Logs aren't indexed for code search — use gamedev-log for log content.";

// First-use setup nudge: if the plugin has never been configured (no config file), prepend a one-time
// pointer to setup the FIRST time a search/nav tool runs in a process. Once per process (not per call) so
// it informs without nagging; it never blocks — the tool still answers (using cwd as the root).
let _setupNudged = false;
const needsSetup = () => { try { return !fs.existsSync(CONFIG_FILE); } catch { return false; } };
const SETUP_NUDGE =
  "⚙ vs-token-safer isn't configured yet — run /vs-token-safer:setup (or `vts setup --projectPath <root>`) " +
  "to set the project root + backend; it also censuses the project's languages and tunes warm-up. Using the " +
  "current directory for now.\n\n";

function applySetup(args) {
  let current = {};
  try { current = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {}; } catch { /* new */ }
  const changed = [];
  for (const k of CONFIG_KEYS) if (args[k] !== undefined) { current[k] = args[k]; changed.push(k); }
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(current, null, 2));
  return { current, changed };
}

// ---- savings ledger (local; reused pattern from gamedev-log-analyzer) ----
const SAVINGS_FILE = cfg("VTS_SAVINGS_FILE", "savingsFile", path.join(CONFIG_DIR, "savings.json"));
const readSavings = () => { try { return JSON.parse(fs.readFileSync(SAVINGS_FILE, "utf8")) || {}; } catch { return {}; } };
const dayKey = (d = new Date()) => d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
// $/Mtok used for the est. USD line in `vts savings`. A rough single rate (saved tokens are mostly input
// the model never has to ingest) — override with VTS_USD_PER_MTOK; purely informational.
const USD_PER_MTOK = parseFloat(cfg("VTS_USD_PER_MTOK", "usdPerMtok", "3")) || 3;
function recordSavings(rawTok, outTok, tool) {
  // vts output is never genuinely larger than the raw alternative for the SAME query; a computed negative is
  // an artifact of the JSON-of-already-capped-data baseline on tiny results. Floor to break-even so the
  // ledger never shows a tool "costing" tokens (dogfood-found: search_text/find_files went slightly negative).
  if (outTok > rawTok) outTok = rawTok;
  const s = readSavings();
  s.runs = (s.runs || 0) + 1;
  s.rawTok = (s.rawTok || 0) + rawTok;
  s.outTok = (s.outTok || 0) + outTok;
  const saved = rawTok - outTok;
  if (saved > (s.bestSaved || 0)) { s.bestSaved = saved; s.bestRaw = rawTok; s.bestOut = outTok; }
  // Per-tool aggregate — shows WHERE the win comes from (and which tool's cap to tune).
  if (tool) {
    s.tools = s.tools || {};
    const t = (s.tools[tool] = s.tools[tool] || { runs: 0, rawTok: 0, outTok: 0 });
    t.runs++; t.rawTok += rawTok; t.outTok += outTok;
  }
  // Per-day buckets (for --graph / --daily) — pruned to the last 60 days to bound the file size.
  s.days = s.days || {};
  const k = dayKey();
  const d = (s.days[k] = s.days[k] || { runs: 0, rawTok: 0, outTok: 0 });
  d.runs++; d.rawTok += rawTok; d.outTok += outTok;
  const keys = Object.keys(s.days).sort();
  if (keys.length > 60) for (const old of keys.slice(0, keys.length - 60)) delete s.days[old];
  // Recent-run ring (for --history) — last 20.
  s.history = (s.history || []).concat([{ t: new Date().toISOString(), raw: rawTok, out: outTok }]).slice(-20);
  try { fs.mkdirSync(path.dirname(SAVINGS_FILE), { recursive: true }); fs.writeFileSync(SAVINGS_FILE, JSON.stringify(s, null, 2)); } catch { /* best-effort */ }
}
function savingsLine(rawTok, outTok) {
  if (rawTok < 2000) return "";
  const ratio = outTok > 0 ? Math.round(rawTok / outTok) : rawTok;
  const pct = (100 * (1 - outTok / Math.max(rawTok, 1))).toFixed(1);
  return `\n\n✓ Saved ~${(rawTok - outTok).toLocaleString()} tokens here (${pct}% / ${ratio}× smaller than the raw index response).`;
}
const usd = (tokens) => (tokens / 1e6) * USD_PER_MTOK;
// ASCII sparkline-style bar graph of saved tokens for the last `days` days (RTK `gain --graph` analog).
function savingsGraph(s, days = 30) {
  const today = new Date();
  const rows = [];
  let peak = 1;
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const k = dayKey(d);
    const b = (s.days || {})[k];
    const saved = b ? b.rawTok - b.outTok : 0;
    if (saved > peak) peak = saved;
    rows.push([k, saved]);
  }
  return rows.map(([k, saved]) => {
    const bar = "█".repeat(Math.round((saved / peak) * 24));
    return `  ${k}  ${bar} ${saved ? "~" + saved.toLocaleString() : ""}`;
  }).join("\n");
}
function savingsReport(a = {}) {
  const s = readSavings();
  if (!s.runs) return "No savings recorded yet — run a search first.";
  const ratio = s.outTok > 0 ? Math.round(s.rawTok / s.outTok) : "∞";
  const best = s.bestRaw ? `\n  biggest single run: ${s.bestRaw.toLocaleString()} → ${s.bestOut.toLocaleString()} tok` : "";
  const totalSaved = s.rawTok - s.outTok;
  let body = `vs-token-safer savings (local, ${s.runs} search(es))\n  total saved: ~${totalSaved.toLocaleString()} tokens vs forwarding raw index responses\n  raw → output: ${s.rawTok.toLocaleString()} → ${s.outTok.toLocaleString()} tok (~${ratio}× smaller)${best}\n  est. value: ~$${usd(totalSaved).toFixed(2)} (@ $${USD_PER_MTOK}/Mtok — rough, set VTS_USD_PER_MTOK)`;
  if (s.tools) {
    const byTool = Object.entries(s.tools).map(([t, v]) => [t, v.rawTok - v.outTok, v.runs]).sort((x, y) => y[1] - x[1]).slice(0, 5);
    if (byTool.length) body += `\n  by tool: ` + byTool.map(([t, sv, n]) => `${t} ~${sv.toLocaleString()} (${n})`).join(", ");
  }
  const want = (k) => a[k] === true || a[k] === "true";
  if (want("graph")) body += `\n\nSaved tokens / day (last 30):\n${savingsGraph(s, 30)}`;
  if (want("daily")) {
    const keys = Object.keys(s.days || {}).sort().slice(-14);
    body += `\n\nDaily (last ${keys.length}):\n` + keys.map((k) => { const b = s.days[k]; return `  ${k}  saved ~${(b.rawTok - b.outTok).toLocaleString()}  (${b.runs} run(s))`; }).join("\n");
  }
  if (want("history")) {
    body += `\n\nRecent runs:\n` + (s.history || []).slice().reverse().map((h) => `  ${h.t.replace("T", " ").slice(0, 19)}  ${h.raw.toLocaleString()} → ${h.out.toLocaleString()} tok`).join("\n");
  }
  return body + `\n\nLedger: ${SAVINGS_FILE}`;
}

// ---- #4 tee: when find_files/search_text truncates, write the full (bounded) result set to a tee file so
// the model can recover everything without re-running. RTK "tee mode" analog (default: on-truncate). ----
const TEE_DIR = cfg("VTS_TEE_DIR", "teeDir", path.join(CONFIG_DIR, "tee"));
const teeMode = () => String(cfg("VTS_TEE", "tee", "truncate")).toLowerCase(); // "truncate" (default) | "off"
const TEE_MAX = parseInt(cfg("VTS_TEE_MAX", "teeMax", "5000"), 10) || 5000;
function writeTee(tool, q, lines) {
  try {
    fs.mkdirSync(TEE_DIR, { recursive: true });
    // Prune to the most-recent 50 tee files so the dir doesn't grow unbounded.
    try {
      const files = fs.readdirSync(TEE_DIR).filter((f) => f.endsWith(".txt")).map((f) => path.join(TEE_DIR, f));
      if (files.length > 50) for (const f of files.sort((x, y) => fs.statSync(x).mtimeMs - fs.statSync(y).mtimeMs).slice(0, files.length - 50)) fs.rmSync(f, { force: true });
    } catch { /* prune best-effort */ }
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const safeQ = String(q).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40) || "q";
    const fp = path.join(TEE_DIR, `${ts}_${tool}_${safeQ}.txt`);
    fs.writeFileSync(fp, lines.join("\n") + "\n");
    return fp;
  } catch { return null; }
}
// When a capped result is truncated and tee is on, re-collect up to TEE_MAX and write it; return a note.
function teeNote(tool, q, root, recollect) {
  if (teeMode() === "off") return "";
  try {
    const full = recollect(TEE_MAX);
    const fp = writeTee(tool, q, full);
    if (fp) return ` — full ${full.length}${full.truncated ? "+" : ""} result(s) written to ${fp}`;
  } catch { /* best-effort */ }
  return "";
}
// LSP-result variant: the full result set is ALREADY in memory (no re-collection) — when the formatter
// would cap it ("… N more"), write every row to a tee file so the tail is recoverable without re-querying.
function teeOverflow(tool, q, rows, max) {
  if (teeMode() === "off" || rows.length <= max) return "";
  try {
    const fp = writeTee(tool, q, rows.slice(0, TEE_MAX));
    if (fp) return ` — full ${Math.min(rows.length, TEE_MAX)} result(s) written to ${fp}`;
  } catch { /* best-effort */ }
  return "";
}

// ---- #2 discover: scan recent Claude transcripts for code searches that BYPASSED vts (Bash grep/rg/find
// or the Grep tool aimed at source) and report the raw tokens they spent — the "missed savings" RTK
// `discover` surfaces. Local read-only; nothing leaves the machine. ----
const DISCOVER_CODE_EXT = /\.(c|cc|cxx|cpp|h|hpp|hh|inl|ipp|tpp|cs|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi)\b/;
const DISCOVER_CODE_DIR = /(^|[\s"'/\\])(src|source|sources|engine|plugins)[\\/]/;
const DISCOVER_TEXT_TGT = /\.(log|txt|md|markdown|json|ya?ml|csv|tsv|xml|html?|ini|cfg|conf|toml|lock)\b|(^|[\s"'/\\])(logs?|build|intermediate|saved|node_modules|\.git)[\\/]/i;
const DISCOVER_SEARCH = /^(grep|rg|ack|ag|findstr)\b|^git\s+grep\b|^find\b.*\s-name(\s|$)/;
// Strip control chars from a transcript-sourced string before it's echoed to the terminal (a crafted
// transcript could otherwise inject ANSI sequences), and bound the length.
// eslint-disable-next-line no-control-regex -- intentionally matching control chars to strip them
const cleanQ = (s) => String(s).replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 60);
// Returns {tool,q} if a tool call bypassed vts (a code search routed around it), else null.
function matchBypass(name, input) {
  if (!input) return null;
  if (name === "Bash") {
    const cmd = String(input.command || "");
    // Quote-aware (shared with the hook): a quoted alternation pattern is ONE segment, so a bypassed
    // `grep "A|B" src/x.cpp` is COUNTED instead of dissolving into two non-matching halves.
    for (const seg of splitSegments(cmd)) {
      const s = seg.trim().toLowerCase();
      if (!DISCOVER_SEARCH.test(s)) continue;
      if (DISCOVER_TEXT_TGT.test(s)) continue;
      const isGit = /^git\s+grep\b/.test(s);
      if (isGit || DISCOVER_CODE_EXT.test(s) || DISCOVER_CODE_DIR.test(s)) {
        return { tool: isGit ? "git grep" : (s.match(/^(\w+)/) || ["", "grep"])[1], q: cleanQ(seg) };
      }
    }
    return null;
  }
  if (name === "Grep") {
    const glob = String(input.glob || "").toLowerCase();
    const p = String(input.path || "").replace(/\\/g, "/").toLowerCase();
    const type = String(input.type || "").toLowerCase();
    if (DISCOVER_TEXT_TGT.test(glob) || DISCOVER_TEXT_TGT.test(p)) return null;
    const codeType = /^(c|cpp|csharp|cs|cxx|cc|cuda|js|ts|typescript|javascript|jsx|tsx|py|python)$/.test(type);
    if ((glob && DISCOVER_CODE_EXT.test(glob)) || (p && (DISCOVER_CODE_EXT.test(p) || DISCOVER_CODE_DIR.test(p))) || codeType) {
      return { tool: "Grep", q: cleanQ(String(input.pattern || "")) };
    }
  }
  if (name === "Glob") {
    // The built-in Glob/Search tool is a FILENAME search — a bypass of find_files (token-capped + walk-
    // bounded). Count it when it targets source (code-ext glob, code dir, or a specific Name.* form); a
    // doc/asset/log glob is skipped (find_files isn't the better tool there).
    const pat = String(input.pattern || "");
    const base = (pat.replace(/\\/g, "/").split("/").pop() || "").toLowerCase();
    const p = String(input.path || "").replace(/\\/g, "/").toLowerCase();
    if (DISCOVER_TEXT_TGT.test(base) || DISCOVER_TEXT_TGT.test(p)) return null;
    if (DISCOVER_CODE_EXT.test(base) || DISCOVER_CODE_DIR.test(p) || /[a-z0-9_]\.[*a-z0-9]+$/.test(base)) {
      return { tool: "Glob", q: cleanQ(pat) };
    }
  }
  return null;
}
// Shared transcript scan: find bypassed code searches and (always, cheaply) harvest the source-file
// paths their results contained. discoverReport formats this; autoLearn feeds the harvest straight into
// the warm-set so the loop closes without a human in it.
// Accuracy (both gaps found by running discover on its own output):
//  - the `since` window filters ENTRIES by their timestamp, not just files by mtime — a long-running
//    session keeps its transcript's mtime fresh, so without this the same old misses recount every day;
//  - `projectPath` scopes the count to entries whose `cwd` sits under that root (multi-project installs:
//    one project's bypasses shouldn't pollute another's report), and harvested RELATIVE paths resolve
//    against the entry's cwd so the learn attribution is a real path, not a scanner-cwd guess.
const isUnder = (p, root) => {
  const a2 = path.resolve(String(p)).replace(/\\/g, "/").toLowerCase();
  const r = path.resolve(String(root)).replace(/\\/g, "/").toLowerCase();
  return a2 === r || a2.startsWith(r + "/");
};
function scanBypasses(a = {}) {
  const base = process.env.VTS_CLAUDE_PROJECTS || path.join(os.homedir(), ".claude", "projects");
  let dirs;
  try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(base, d.name)); }
  catch { return { error: `No Claude transcripts found at ${base} (set VTS_CLAUDE_PROJECTS to override).` }; }
  const all = a.all === true || a.all === "true";
  const since = Number(a.since) || 7;
  const cutoff = Date.now() - since * 86400000;
  let files = [];
  for (const d of dirs) {
    let ents; try { ents = fs.readdirSync(d); } catch { continue; }
    for (const f of ents) {
      if (!f.endsWith(".jsonl")) continue;
      const p = path.join(d, f);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (all || st.mtimeMs >= cutoff) files.push({ p, m: st.mtimeMs });
    }
  }
  files.sort((x, y) => y.m - x.m);
  if (files.length > 200) files = files.slice(0, 200); // bound the scan
  const learned = new Set(); // file paths recovered from bypassed-search results → warm-set candidates
  const PATH_RE = /([A-Za-z]:)?[\w./\\-]+\.(?:c|cc|cxx|cpp|h|hpp|hh|inl|ipp|tpp|cs|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi)\b/g;
  const cand = new Map(); // tool_use_id → {tool,q}
  const missed = []; let rawTokTotal = 0; let lines = 0; const MAX_LINES = 300000;
  outer: for (const { p } of files) {
    cand.clear(); // a tool_use and its result always share one transcript → bound the map per file
    let txt; try { txt = fs.readFileSync(p, "utf8"); } catch { continue; }
    for (const line of txt.split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (++lines > MAX_LINES) break outer;
      let e; try { e = JSON.parse(line); } catch { continue; }
      // entry-level window: a multi-day session keeps its file mtime fresh — without this, its old
      // misses recount in every "last N days" report (and re-enter every auto-learn harvest).
      if (!all && e && e.timestamp) { const t = Date.parse(e.timestamp); if (Number.isFinite(t) && t < cutoff) continue; }
      // per-project scope: only count entries that ran under the requested root.
      if (a.projectPath && e && e.cwd && !isUnder(e.cwd, a.projectPath)) continue;
      const content = e && e.message && e.message.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b && b.type === "tool_use") { const m = matchBypass(b.name, b.input); if (m) cand.set(b.id, m); }
        else if (b && b.type === "tool_result" && cand.has(b.tool_use_id)) {
          const meta = cand.get(b.tool_use_id); cand.delete(b.tool_use_id);
          const o = typeof b.content === "string" ? b.content : JSON.stringify(b.content || "");
          // A search our OWN hook BLOCKED (exit 2) has the block message as its tool_result — it was CAUGHT,
          // not bypassed, so counting it (and the long block copy as "raw tokens") over-reports bypasses and
          // under-reports the catch-rate. Skip it. (A WARNED Grep still ran and returned real matches — no
          // block header — so it stays counted, correctly.) Rewritten Bash greps already don't reach here
          // (their tool_use is the vts command, which matchBypass doesn't flag).
          if (/✨ vs-token-safer/.test(o)) continue;
          const rt = tok(o); rawTokTotal += rt; missed.push({ ...meta, rawTok: rt });
          // resolve relative hits against the ENTRY's cwd (the project the search actually ran in) —
          // recordQueryResults would otherwise resolve them against the scanner's cwd, mis-attributing.
          let pm; PATH_RE.lastIndex = 0;
          while ((pm = PATH_RE.exec(o)) && learned.size < 500) {
            const hit = pm[0];
            if (path.isAbsolute(hit) || /^[A-Za-z]:/.test(hit)) learned.add(hit);
            else if (e.cwd) learned.add(path.join(e.cwd, hit));
          }
        }
      }
    }
  }
  return { missed, rawTokTotal, learned, filesCount: files.length, all, since };
}
// Boot-time self-improvement: harvest the last `since` days of bypassed searches and record their result
// files into the warm-set query-history — the same write `vts discover --learn` does, but automatic.
// Best-effort and bounded (200 transcripts / 300k lines / 500 files); returns the count for logging.
export function autoLearn(root, since = 7) {
  const r = scanBypasses({ since });
  if (r.error || !r.learned || !r.learned.size) return 0;
  // Attribute only files that actually live under THIS root — a multi-project install must not pour
  // another project's hits into this project's warm-set.
  const mine = [...r.learned].filter((f) => isUnder(f, root));
  if (!mine.length) return 0;
  try { recordQueryResults(root, mine); return mine.length; } catch { return 0; }
}
function discoverReport(a = {}) {
  const r = scanBypasses(a);
  if (r.error) return r.error;
  const { missed, rawTokTotal, learned, filesCount: fc, all, since } = r;
  const files = { length: fc };
  const learn = a.learn === true || a.learn === "true";
  const learnRoot = resolveRoot(a);
  const scope = (all ? "all time" : `last ${since} day(s)`) + (a.projectPath ? `, scoped to ${a.projectPath}` : "");
  // Synergy B: feed the files those bypassed searches actually hit into the warm-set's query-history, so
  // prewarm front-loads them next time — vts learns from the greps it didn't run.
  let learnLine = "";
  if (learn && learned.size) {
    const mine = [...learned].filter((f) => isUnder(f, learnRoot)); // same attribution rule as autoLearn
    if (mine.length) {
      try { recordQueryResults(learnRoot, mine); learnLine = `\n  ✓ learned ${mine.length} file(s) into the warm-set for ${learnRoot} (prewarm will front-load them).`; }
      catch { /* best-effort */ }
    } else learnLine = `\n  (nothing to learn for ${learnRoot} — the harvested files live under other roots.)`;
  }
  // Synergy C: combine with the savings ledger → a catch-rate (caught vs still-bypassing).
  const caught = (() => { const s = readSavings(); return Math.max(0, (s.rawTok || 0) - (s.outTok || 0)); })();
  const rate = caught + rawTokTotal > 0 ? (100 * caught / (caught + rawTokTotal)).toFixed(1) : "—";
  const catchLine = `\n  catch-rate: ~${caught.toLocaleString()} tok caught (via vts) vs ~${rawTokTotal.toLocaleString()} still bypassing → ${rate}% of search tokens routed through vts`;
  if (!missed.length) return `vs-token-safer discover (${scope}, ${files.length} transcript(s)): no code searches bypassed vts. It's catching them. ✓` + catchLine + learnLine;
  const byTool = {};
  for (const m of missed) byTool[m.tool] = (byTool[m.tool] || 0) + 1;
  const toolLine = Object.entries(byTool).sort((x, y) => y[1] - x[1]).map(([t, n]) => `${t}×${n}`).join(", ");
  const top = missed.slice().sort((x, y) => y.rawTok - x.rawTok).slice(0, 5)
    .map((m) => `  ~${m.rawTok.toLocaleString()} tok  [${m.tool}]  ${m.q}`).join("\n");
  return `vs-token-safer discover — missed token savings (local scan, ${scope}, ${files.length} transcript(s))\n` +
    `  ${missed.length} code search(es) bypassed vts (${toolLine})\n` +
    `  raw tool output ingested: ~${rawTokTotal.toLocaleString()} tok (~$${usd(rawTokTotal).toFixed(2)}) — routed through vts (file:line, capped) most of this is avoidable (typically 70–90% less)${catchLine}\n` +
    `  biggest:\n${top}\n` +
    `  Fix: rewrite is on by default (Bash grep auto-reroutes to vts); for the Grep tool, prefer the vs-search MCP tools (search_symbol / search_text / find_files).${learnLine}`;
}

// ---- LSP client pool (one per root+backend; reused across calls in a process) ----
// key -> { p: Promise<LspClient>, client: LspClient|null, lastUsed: ms }. We cache the PROMISE (not just
// the resolved client) so a boot-time pre-warm racing the first real query share ONE clangd instead of
// spawning two (the warmup is expensive).
//
// BACKEND POOL LIFECYCLE (memory guard). The MCP server is long-lived, and once the root is resolved
// PER-CALL (a path's enclosing project / the MCP workspace root) a session that touches several repos
// would otherwise spawn a PERSISTENT language server per root and never reap them — N repos × a UE-sized
// clangd index = memory blow-up. So the pool is BOUNDED two ways: at most `maxBackends()` live clients
// (the least-recently-used idle one is shut down past the cap), and any client idle past `idleMs()` is
// reaped by a background sweep. Steady state ≈ 1 warm backend; bouncing between two repos keeps both warm
// (no re-index); a third evicts the LRU. An evicted clangd reloads fast from its persisted on-disk index
// (symbolReady polls the shards back in), so reaping is cheap. A client with an in-flight request is
// NEVER evicted (pending.size guards it) — eviction/idle only ever touch settled, quiescent clients.
const clients = new Map();
// Master registry of EVERY spawned client, independent of the `clients` map. The map can lose a reference
// via several paths (evict, idle sweep, failed-warmup catch, key overwrite); this set is the single source
// of truth for teardown, so disposeClients can guarantee NO orphaned child survives (a live child holds
// the event loop open — it hung the eval after PASS and the CI test step never exited). killClient is the
// one place a client is torn down: drop it from both the registry and shut it down (idempotent).
const allClients = new Set();
function killClient(c) { if (!c) return undefined; allClients.delete(c); try { return c.shutdown(); } catch { return undefined; } }
const nowMs = () => Date.now();
const maxBackends = () => Math.max(1, envInt("VTS_MAX_BACKENDS", 2));
const idleMs = () => { const v = parseInt(process.env.VTS_BACKEND_IDLE_MS, 10); return Number.isFinite(v) && v >= 0 ? v : 300000; }; // 5 min; 0 disables idle reaping

// Settled clients with no in-flight request, oldest-used first — the only ones safe to reap.
function evictableEntries() {
  return [...clients.entries()]
    .filter(([, e]) => e.client && e.client.pending && e.client.pending.size === 0)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
}
// Make room for one new backend: at/over the cap, shut down the least-recently-used idle client. If every
// client is busy or still warming, allow a transient over-cap rather than block a live query.
function evictLRU() {
  if (clients.size < maxBackends()) return null;
  const ev = evictableEntries();
  if (!ev.length) return null;
  const [key, e] = ev[0];
  clients.delete(key);
  killClient(e.client);
  return key;
}
// Background reaper: shut down any client idle past idleMs (in-flight requests protected).
function sweepIdle(now = nowMs()) {
  const ttl = idleMs();
  if (!ttl) return [];
  const cut = now - ttl;
  const reaped = [];
  for (const [key, e] of clients) {
    if (e.client && e.client.pending && e.client.pending.size === 0 && e.lastUsed < cut) {
      clients.delete(key);
      reaped.push(key);
      killClient(e.client);
    }
  }
  return reaped;
}
let _sweeper = null;
function ensureSweeper() {
  if (_sweeper || !idleMs()) return;
  // unref'd so the timer never keeps the process (or the eval) alive.
  _sweeper = setInterval(() => sweepIdle(), Math.min(idleMs(), 60000));
  _sweeper.unref?.();
}
function getClient(root, backendName) {
  const key = `${backendName}|${root}`;
  const hit = clients.get(key);
  if (hit) { hit.lastUsed = nowMs(); return hit.p; }
  evictLRU();      // bound the pool BEFORE adding another backend
  ensureSweeper();
  const b = BACKENDS[backendName];
  const entry = { p: null, client: null, lastUsed: nowMs() };
  // `spawned` captures the client the INSTANT it's constructed (its child is alive from initialize on), so
  // a warmup that throws can still tear the child down. entry.client is set only on SUCCESS, so a
  // still-warming client is never treated as evictable (no mid-warmup eviction). Without the failure-path
  // shutdown a failed warmup deleted the cache entry but ORPHANED its child — a killed=false zombie that
  // held the event loop open (the eval hung after PASS / the CI test step never exited).
  let spawned = null;
  entry.p = (async () => {
    const c = new LspClient(b.cmd, b.args(root), { cwd: root, shell: process.platform === "win32" && !!b.winShell });
    spawned = c;
    allClients.add(c); // register the INSTANT it's constructed (child alive from initialize on) → never orphanable
    await c.initialize(root);
    if (typeof b.afterInit === "function") await b.afterInit(c, root); // e.g. Roslyn solution/open + load wait
    entry.client = c;
    entry.lastUsed = nowMs();
    return c;
  })();
  clients.set(key, entry);
  entry.p.catch(() => { clients.delete(key); killClient(spawned); }); // failed warmup: drop the cache entry AND kill the spawned child
  return entry.p;
}
export async function disposeClients() {
  clients.clear();
  if (_sweeper) { clearInterval(_sweeper); _sweeper = null; }
  // Tear down EVERY spawned client from the master registry (not just the map's current entries) so no
  // child — evicted, swept, mid-warmup, or key-overwritten — is ever left running. shutdown is synchronous
  // + idempotent, so a client already torn down is a harmless no-op.
  for (const c of [...allClients]) { try { c.shutdown(); } catch { /* ignore */ } }
  allClients.clear();
}
// Test surface for the eval — deterministic pool checks (LRU eviction, idle sweep, pending protection)
// without spawning a real language server.
export const __pool = {
  clients,
  evictLRU,
  sweepIdle,
  maxBackends,
  idleMs,
  seed(key, client, lastUsed) { clients.set(key, { p: Promise.resolve(client), client, lastUsed }); },
  clear() { clients.clear(); },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Return-when-found query for clangd with a PERSISTED index that's still loading: afterInit no longer
// blocks on the full re-index, so the first workspace/symbol can land while shards are still loading and
// come back empty. Instead of a fixed wait, POLL — re-issue the query with backoff and return the INSTANT
// the sought symbol's shard is loaded (usually well before the cap). `client.indexLoaded` flips true when
// clangd's background index finishes, so an empty result after that is genuine (stop polling). Capped by
// VTS_CLANGD_PERSISTED_WAIT_MS. Non-persisted / non-clangd → one call, no polling.
export async function symbolReady(c, q, persisted, capMs) {
  let syms = (await c.symbol(q)) || [];
  if (syms.length || !persisted) return syms;
  const t0 = Date.now();
  let delay = 1000;
  while (Date.now() - t0 < capMs) {
    if (c.indexLoaded) break; // index finished loading → an empty result is real, stop
    await sleep(Math.min(delay, Math.max(0, capMs - (Date.now() - t0))));
    syms = (await c.symbol(q)) || [];
    if (syms.length) break;
    delay = Math.min(Math.round(delay * 1.5), 5000);
  }
  return syms;
}
// Proactively spawn + warm a backend WITHOUT issuing a query (IDE-style background indexing). Fire-and-
// forget at MCP boot so the user's first search reuses an already-warming/warm client. Returns the
// same cached promise getClient would, so a query arriving mid-warmup joins it rather than racing.
export function prewarm(root, backendName) {
  if (!root || !backendName || !BACKENDS[backendName]) return Promise.resolve(null);
  return getClient(root, backendName);
}

// Surface a one-time advisory if the resolved clangd is too old (older clangd deadlocks on large UE
// projects — see backends/index.js MIN_CLANGD). Shown once per process, prepended to the first result.
let _advisoryShown = false;
// clangd is useless without a compile database. Detect a missing compile_commands.json (shallow scan) and
// advise how to generate it — otherwise semantic search_symbol/find_references/goto/hover silently return
// nothing on a `.uproject`-only project (clangd is still the picked backend for C++). Exported for the eval.
export function hasCompileDb(root) {
  // the out-of-tree home (~/.vs-token-safer/db/<slug>) counts — clangd is pointed there via
  // --compile-commands-dir, so a DB living there is just as usable as an in-tree one.
  if (resolveCdbDir(root)) return true;
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, d] = stack.pop();
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isFile() && e.name === "compile_commands.json") return true;
      if (e.isDirectory() && d < 2 && !e.name.startsWith(".") && e.name !== "node_modules") stack.push([path.join(dir, e.name), d + 1]);
    }
  }
  return false;
}
export function compileDbAdvisory(root) {
  if (hasCompileDb(root)) return "";
  return "⚠ clangd needs compile_commands.json — none found under the root. Generate it: run " +
    "`vts_gen_compile_db` (dry-run prints the UBT command; apply=true runs it), or by hand via UBT " +
    "`-mode=GenerateClangDatabase` (`-Compiler=VisualCpp` for clang-cl) / CMake " +
    "`-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`. OR just keep going — without a DB, semantic " +
    "search_symbol/find_references/goto/hover are limited, but search_symbol falls back to a literal text " +
    "search and find_files/search_text work fully.";
}
// --- opt-in UBT compile-database generation, so the user can CHOOSE: generate compile_commands.json for
// full semantic clangd, or stay in no-DB text mode. UE-specific; engine root from VTS_UE_ROOT / arg / a
// shallow walk-up for Engine/Build/BatchFiles. ---
function findUProject(root) {
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, d] = stack.pop();
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isFile() && /\.uproject$/i.test(e.name)) return path.join(dir, e.name);
      if (e.isDirectory() && d < 2 && !e.name.startsWith(".") && e.name !== "node_modules") stack.push([path.join(dir, e.name), d + 1]);
    }
  }
  return null;
}
const runUbtPath = (engineRoot) => path.join(engineRoot, "Engine", "Build", "BatchFiles", process.platform === "win32" ? "RunUBT.bat" : "RunUBT.sh");
function findEngineRoot(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(runUbtPath(dir))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}
// Build the UBT GenerateClangDatabase invocation for a project (used by vts_gen_compile_db; exported for the
// eval). Returns { uproject, engineRoot, runUbt, args, cmdline } or { error }.
export function genCompileDbPlan(root, a = {}) {
  const upr = findUProject(root);
  if (!upr) return { error: `No .uproject found under ${root}. Pass projectPath = the Unreal project root.` };
  const projName = path.basename(upr).replace(/\.uproject$/i, "");
  const target = a.target || `${projName}Editor`;
  const platform = a.platform || "Win64";
  const config = a.config || "Development";
  const compiler = a.compiler || "VisualCpp"; // GenerateClangDatabase needs this for clang-cl targets
  const engineRoot = a.engineRoot || process.env.VTS_UE_ROOT || findEngineRoot(path.dirname(upr));
  if (!engineRoot) return { error: `Couldn't resolve the UE engine root. Set VTS_UE_ROOT or pass engineRoot= (the folder containing Engine/Build/BatchFiles/RunUBT).`, uproject: upr };
  const runUbt = runUbtPath(engineRoot);
  const args = [target, platform, config, `-project=${upr}`, "-mode=GenerateClangDatabase", `-Compiler=${compiler}`];
  // cmdline doubles as the dry-run output AND the actual shell command for the .bat path — quote any
  // arg with spaces (a `-project=` under "Program Files" etc.) so both stay correct.
  const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
  return { uproject: upr, engineRoot, runUbt, args, cmdline: `"${runUbt}" ${args.map(q).join(" ")}` };
}
// --- VCS-ignore guard: generated clangd artifacts must never reach git or Perforce. clangd ALWAYS writes
// its `.cache/clangd` background index IN the source tree (no flag relocates it), so `.cache/` is guarded
// in BOTH layouts; compile_commands.json is only in-tree when inTree=true, so it's guarded only then.
// ensureDbIgnored(root, patterns) appends where it safely can and says exactly what to do where it can't.
// Exported for the eval. ---
const DB_IGNORES = ["compile_commands.json", ".cache/"];
export function ensureDbIgnored(root, patterns = DB_IGNORES) {
  const notes = [];
  const probe = (patterns[0] || ".cache/").replace(/\/$/, ""); // a representative entry for check-ignore
  // git: inside a work tree and the artifact not ignored → append to the project-root .gitignore.
  try {
    execFileSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore", timeout: 5000 });
    let ignored = true;
    try { execFileSync("git", ["-C", root, "check-ignore", "-q", probe], { stdio: "ignore", timeout: 5000 }); }
    catch { ignored = false; }
    if (ignored) notes.push(`git: ${probe} already ignored.`);
    else {
      const gi = path.join(root, ".gitignore");
      try {
        const cur = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
        const have = cur.split(/\r?\n/).map((l) => l.trim());
        const add = patterns.filter((l) => !have.includes(l));
        if (add.length) fs.appendFileSync(gi, (cur && !cur.endsWith("\n") ? "\n" : "") + "# clangd compile DB + index (generated; never commit)\n" + add.join("\n") + "\n");
        notes.push(`git: added ${add.join(", ") || "(nothing — entries present)"} to ${gi}.`);
      } catch (e) { notes.push(`git: could NOT update .gitignore (${e.code || e.message}) — add ${patterns.join(" + ")} yourself.`); }
    }
  } catch { /* not a git work tree */ }
  // Perforce: P4IGNORE names the ignore file(s); else the usual candidates. Only APPEND to an EXISTING
  // file — creating one p4 doesn't read would be false security, and the file may itself be versioned
  // (read-only until `p4 edit`, which we won't run silently).
  const p4Env = String(process.env.P4IGNORE || "").split(/[;:]/).map((s) => s.trim()).filter((s) => s && !/^[A-Za-z]$/.test(s)); // drop the drive letter a `C:\…` split leaves behind
  const names = p4Env.length ? p4Env : [".p4ignore", ".p4ignore.txt"];
  // The ignore file usually lives at the DEPOT root, not the project subdir (a UE game dir sits levels
  // below it) — walk up from root so it's actually found. Bare patterns match at any depth, so appending
  // there still covers the project's DB. Absolute P4IGNORE entries are used as-is.
  const candidates = [];
  for (const f of names) {
    if (path.isAbsolute(f)) { candidates.push(f); continue; }
    let dir = path.resolve(root);
    for (let i = 0; i < 7; i++) {
      candidates.push(path.join(dir, f));
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  const p4File = candidates.find((f) => { try { return fs.existsSync(f); } catch { return false; } });
  const looksP4 = !!(process.env.P4CLIENT || process.env.P4PORT || process.env.P4CONFIG);
  if (p4File) {
    try {
      const cur = fs.readFileSync(p4File, "utf8");
      const have = cur.split(/\r?\n/).map((l) => l.trim());
      const add = patterns.filter((l) => !have.includes(l) && !have.includes(l.replace(/\/$/, "")));
      if (add.length) { fs.appendFileSync(p4File, (cur.endsWith("\n") || !cur ? "" : "\n") + add.join("\n") + "\n"); notes.push(`p4: added ${add.join(", ")} to ${p4File}.`); }
      else notes.push(`p4: ${path.basename(p4File)} already covers it.`);
    } catch (e) { notes.push(`p4: ${p4File} exists but isn't writable (${e.code || e.message}; versioned? \`p4 edit\` it first) — add ${patterns.join(" + ")} yourself.`); }
  } else if (looksP4) {
    notes.push(`p4: no ignore file found. p4 won't auto-add untracked files, but \`p4 reconcile\` WOULD pick it up — set P4IGNORE (e.g. a .p4ignore listing: ${patterns.join(", ")}).`);
  }
  return notes;
}
let _dbAdvisoryShown = false;
function backendAdvisory(backendName, root) {
  if (backendName !== "clangd") return "";
  let s = "";
  if (!_advisoryShown) { const a = clangdAdvisory(BACKENDS.clangd.cmd); if (a) { _advisoryShown = true; s += a + "\n\n"; } }
  if (!_dbAdvisoryShown && root) { const d = compileDbAdvisory(root); if (d) { _dbAdvisoryShown = true; s += d + "\n\n"; } }
  return s;
}

// ---- token-capping formatters: LSP results → compact file:line (no bodies) ----
const locLine = (uri, range) => `${fromUri(uri).replace(/\\/g, "/")}:${(range.start.line + 1)}`;
function fmtSymbols(syms, max) {
  const shown = syms.slice(0, max);
  const body = shown.map((s) => {
    const kind = SYMBOL_KIND[s.kind] || `k${s.kind}`;
    const container = s.containerName ? ` (in ${s.containerName})` : "";
    return `${kind} ${s.name}${container}  @ ${locLine(s.location.uri, s.location.range)}`;
  }).join("\n");
  const more = syms.length - shown.length;
  return body + (more > 0 ? `\n… ${more} more (raise maxResults or narrow the query).` : "");
}
// Output-cap v2 (caveman "collapse repetition"): a refs-heavy result repeats the same long path on every
// line. Collapse it — one line per FILE with all its line numbers joined, then factor a common DIRECTORY
// prefix so a deep shared tree is printed ONCE. Every location is preserved and recoverable (full path =
// prefix + "/" + tail; lines are the comma list). Biggest win on find_references (the code-mod primitive)
// and any multi-location result. VTS_COMPACT_RESULTS=0 restores the classic one-location-per-line shape.
const compactResults = () => { const v = process.env.VTS_COMPACT_RESULTS; return v === undefined || v === "" ? true : !/^(0|false|off|no)$/i.test(v); };
function splitPathLine(s) { const i = s.lastIndexOf(":"); return i > 1 ? { p: s.slice(0, i), ln: s.slice(i + 1) } : { p: s, ln: "" }; }
// Longest common DIRECTORY prefix across paths (the filename segment never counts), or "" if <2 paths /
// no shared dir. Returns a slash-joined prefix with no trailing slash.
function commonDirPrefix(paths) {
  if (paths.length < 2) return "";
  const split = paths.map((p) => p.split("/"));
  const minLen = Math.min(...split.map((s) => s.length));
  let i = 0;
  while (i < minLen - 1 && split.every((s) => s[i] === split[0][i])) i++;
  return i > 0 ? split[0].slice(0, i).join("/") : "";
}
// items: "path:line" strings (path uses "/"). → grouped, deduped, prefix-factored block.
function compactLocationLines(items) {
  const byFile = new Map();
  for (const it of items) {
    const { p, ln } = splitPathLine(it);
    if (!byFile.has(p)) byFile.set(p, []);
    if (ln) byFile.get(p).push(ln);
  }
  const files = [...byFile.keys()];
  const linesOf = (p) => [...new Set(byFile.get(p))].sort((a, b) => Number(a) - Number(b)).join(",");
  const suffix = (p) => (linesOf(p) ? `:${linesOf(p)}` : "");
  const prefix = commonDirPrefix(files);
  if (prefix && files.length > 1) {
    return `  under ${prefix}/\n` + files.map((p) => `    ${p.slice(prefix.length + 1)}${suffix(p)}`).join("\n");
  }
  return files.map((p) => `  ${p}${suffix(p)}`).join("\n");
}
function fmtLocations(locs, max, label) {
  const arr = Array.isArray(locs) ? locs : locs ? [locs] : [];
  const shown = arr.slice(0, max);
  const more = arr.length - shown.length;
  const tail = more > 0 ? `\n… ${more} more.` : "";
  const body = compactResults()
    ? compactLocationLines(shown.map((l) => locLine(l.uri, l.range)))
    : shown.map((l) => `  @ ${locLine(l.uri, l.range)}`).join("\n");
  return `${arr.length} ${label}:\n${body}${tail}`;
}
export { compactLocationLines, commonDirPrefix };
// hover MarkupContent → a few plaintext lines (signature/type), no fenced code, no walls of text.
function fmtHover(h) {
  if (!h || !h.contents) return "(no hover info)";
  let c = h.contents;
  if (Array.isArray(c)) c = c.map((x) => (typeof x === "string" ? x : x.value || "")).join("\n");
  else if (typeof c === "object") c = c.value || "";
  c = String(c).replace(/```[a-z]*\n?/gi, "").trim();
  const lines = c.split(/\r?\n/).filter(Boolean).slice(0, 8);
  return lines.join("\n") || "(no hover info)";
}
// document symbols (hierarchical DocumentSymbol[] or flat SymbolInformation[]) → kind name @ file:line.
// An outline wants the DECLARATION structure (classes/functions/methods/fields/types), not every
// function-body local and anonymous callback. tsserver in particular floods documentSymbol with
// `arr.map() callback` artifacts and nested var/const locals (dogfood: a 200-symbol core.js outline was
// mostly noise). Hide those by default — VTS_OUTLINE_RAW=1 shows everything; VTS_OUTLINE_DEPTH caps nesting.
// tsserver's synthetic nested display-names (e.g. "arr.map() callback", "<function>"). Tightened to the
// parenthesized-callback form + a fully angle-bracketed name so it can't match a real symbol named e.g.
// `callback` or `registerCallback`. Only applied at depth>0 (see walk) — a top-level entry is always a
// real declaration, whatever its name/kind.
const OUTLINE_NOISE = /\(\)\s*callback$|^<[^>]*>$/i;
function fmtDocSymbols(syms, max, file) {
  const raw = process.env.VTS_OUTLINE_RAW === "1" || process.env.VTS_OUTLINE_RAW === "true";
  const maxDepth = envInt("VTS_OUTLINE_DEPTH", 4);
  const rows = [];
  let dropped = 0;
  // Class-like containers whose members (properties/fields) ARE structure worth keeping. Under anything else
  // (a function, a const/var holding an object literal) a kind-7 property is just a DATA key — `COMMANDS::git`,
  // `STATUS::M`, `_internals::compactGit` — and floods the outline. Hide those; keep class members.
  const CLASSLIKE = new Set([5, 10, 11, 23]); // class, enum, interface, struct
  const walk = (arr, parent, depth, parentKind) => {
    for (const s of arr || []) {
      // Noise only when NESTED: a synthetic callback / angle-name, a var/const/key local, or an object-literal
      // property key (kind 7 under a non-class parent). Still DESCEND into a hidden node's children (passing
      // the hidden node's PARENT) so a real declaration inside a filtered wrapper isn't orphaned.
      const objKey = s.kind === 7 && !CLASSLIKE.has(parentKind);
      if (!raw && depth > 0 && (OUTLINE_NOISE.test(s.name || "") || s.kind === 13 || s.kind === 14 || s.kind === 20 || objKey)) {
        dropped++;
        if (s.children && depth < maxDepth) walk(s.children, parent, depth + 1, parentKind);
        continue;
      }
      const r = s.range || (s.location && s.location.range);
      const ln = r ? r.start.line + 1 : 1;
      const loc = s.location ? fromUri(s.location.uri).replace(/\\/g, "/") : file;
      rows.push(`${SYMBOL_KIND[s.kind] || `k${s.kind}`} ${parent ? parent + "::" : ""}${s.name}  @ ${loc}:${ln}`);
      if (s.children && depth < maxDepth) walk(s.children, (parent ? parent + "::" : "") + s.name, depth + 1, s.kind);
    }
  };
  walk(syms, "", 0, 0);
  const shown = rows.slice(0, max);
  const note = dropped && !raw ? ` (${dropped} local/anonymous hidden; VTS_OUTLINE_RAW=1 to show)` : "";
  return `${rows.length} symbol(s)${note}:\n` + shown.join("\n") + (rows.length > shown.length ? `\n… ${rows.length - shown.length} more.` : "");
}
// Directories never worth walking for code search — VCS internals, dependency trees, and (the big one on
// a real project) BUILD/GENERATED output. On an Unreal tree `Intermediate/` alone holds tens of thousands
// of generated *.gen.cpp; walking it made find_files/search_text as slow as the built-in Glob (which timed
// out → the model gave up on file search). Skipping it keeps our walk fast enough to be the better tool.
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", ".cache", ".vs", ".idea", ".gradle",
  "intermediate", "binaries", "saved", "deriveddatacache", "build", "dist", "out", "obj", "bin",
  "__pycache__", ".venv", "venv", "target",
]);
const skipDir = (name) => name.startsWith(".") || SKIP_DIRS.has(name.toLowerCase());
// File-by-name search (no LSP) — basename glob (* ?) or substring, bounded. Sanctioned replacement for
// `find -name` (which the grep-block hook discourages).
function findFilesUnder(root, q, max) {
  const useGlob = /[*?]/.test(q);
  const re = useGlob ? new RegExp("^" + q.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i") : null;
  const ql = q.toLowerCase();
  const out = [];
  const stack = [root]; let scanned = 0; const t0 = Date.now(); let timedOut = false;
  // Collect up to max+1 so "exactly max files exist" (a complete sweep) isn't misreported as truncated.
  // Time-boxed (4s) like scanTextUnder so a giant tree can never hang the tool — it returns what it found.
  while (stack.length && out.length <= max && scanned < 300000) {
    if (Date.now() - t0 >= 4000) { timedOut = true; break; }
    const dir = stack.pop();
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!skipDir(e.name)) stack.push(p); }
      else { scanned++; if (re ? re.test(e.name) : e.name.toLowerCase().includes(ql)) { out.push(p.replace(/\\/g, "/")); if (out.length > max) break; } }
    }
  }
  // Flag a truncated sweep so the caller never presents a capped/aborted result as complete (no silent caps).
  if (out.length > max) { out.length = max; out.truncated = "cap"; }
  else if (timedOut) out.truncated = "time";
  else if (scanned >= 300000 && stack.length) out.truncated = "scan";
  return out;
}
// Bounded, token-capped raw-text search (no LSP) — the sanctioned alternative to grep for strings/comments
// /config keys the symbol index can't answer. Returns file:line: trimmed-line, capped in count and time.
// Trim a match line for output and mark truncation (…) so a hit past col 200 in a long/minified line
// isn't silently shown without its match — and the reader knows the line was cut.
const trimMatchLine = (s) => { const t = String(s).trim(); return t.length > 200 ? t.slice(0, 200) + "…" : t; };
// Doc/text extensions — the non-code text a grep over README/docs/config hits. Off by default (search_text
// stays code-only per its contract); `docs=true` widens the sweep so a docs-grep can be compacted too.
const DOC_EXTS = /\.(c|cc|cxx|cpp|h|hpp|hh|inl|ipp|tpp|cs|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi|md|markdown|txt|json|ya?ml|toml|ini|cfg|conf|xml|html?|csv|rst|tex)$/i;
function scanTextUnder(root, q, max, accept) {
  let re; try { re = new RegExp(q); } catch { re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); }
  // `accept` decides which files to read: a RegExp tested against the filename (the ext set — code by
  // default, DOC_EXTS when docs=true), or a predicate function (a glob target). Default = code exts.
  const CODE_EXTS = /\.(c|cc|cxx|cpp|h|hpp|hh|inl|ipp|tpp|cs|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi)$/i;
  const ok = typeof accept === "function" ? accept : (name) => (accept || CODE_EXTS).test(name);
  // Collect up to max+1 (so "exactly max" isn't misreported as truncated); track whether the 4s time-box
  // actually aborted work (checked per directory and per file — the costly steps).
  const out = []; const stack = [root]; const t0 = Date.now(); let timedOut = false;
  while (stack.length && out.length <= max) {
    if (Date.now() - t0 >= 4000) { timedOut = true; break; }
    const dir = stack.pop();
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!skipDir(e.name)) stack.push(p); continue; }
      if (!ok(e.name)) continue;
      if (Date.now() - t0 >= 4000) { timedOut = true; break; }
      let txt; try { txt = fs.readFileSync(p, "utf8"); } catch { continue; }
      if (!re.test(txt)) continue;
      const lines = txt.split(/\r?\n/);
      for (let i = 0; i < lines.length && out.length <= max; i++) if (re.test(lines[i])) out.push(`${p.replace(/\\/g, "/")}:${i + 1}: ${trimMatchLine(lines[i])}`);
      if (out.length > max) break;
    }
    if (timedOut) break;
  }
  if (out.length > max) { out.length = max; out.truncated = "cap"; }
  else if (timedOut) out.truncated = "time";
  return out;
}
// Filename glob (* ?) → a predicate over basenames, for a TARGETED text search (`search_text glob=*.md`).
// Naming the glob IS the opt-in to whatever extension it covers — no separate docs flag needed.
function globAccept(glob) {
  const re = new RegExp("^" + String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
  return (name) => re.test(name);
}
// Search ONE named file (any extension — the user named it, so its type is implied). file:line, capped.
function scanTextFile(absPath, q, max) {
  let re; try { re = new RegExp(q); } catch { re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); }
  const out = [];
  let txt; try { txt = fs.readFileSync(absPath, "utf8"); } catch { return out; }
  const lines = txt.split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length <= max; i++) if (re.test(lines[i])) out.push(`${absPath.replace(/\\/g, "/")}:${i + 1}: ${trimMatchLine(lines[i])}`);
  if (out.length > max) { out.length = max; out.truncated = "cap"; }
  return out;
}
// A LSP WorkspaceEdit comes back as `changes: {uri: TextEdit[]}` and/or `documentChanges: [{textDocument,edits}]`.
// Collapse both shapes into Map<absPath, TextEdit[]>.
function editsByFile(we) {
  const m = new Map();
  const add = (uri, edits) => { const p = fromUri(uri); m.set(p, (m.get(p) || []).concat(edits || [])); };
  if (we && we.changes) for (const [uri, edits] of Object.entries(we.changes)) add(uri, edits);
  if (we && Array.isArray(we.documentChanges)) for (const dc of we.documentChanges) if (dc && dc.textDocument && dc.edits) add(dc.textDocument.uri, dc.edits);
  return m;
}
// Apply TextEdits to file text. Edits are non-overlapping (LSP guarantee); apply back-to-front by offset
// so earlier offsets stay valid. LSP positions are UTF-16; fine for source code.
function applyEditsToText(text, edits) {
  const lineStart = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStart.push(i + 1);
  const off = (p) => (lineStart[p.line] !== undefined ? lineStart[p.line] : text.length) + p.character;
  const sorted = [...edits].sort((a, b) => off(b.range.start) - off(a.range.start));
  let out = text;
  for (const e of sorted) out = out.slice(0, off(e.range.start)) + e.newText + out.slice(off(e.range.end));
  return out;
}

// ─── Symbolic editing (Serena-style) ─────────────────────────────────────────
// Edit a declaration by NAMING it instead of Read-ing the whole file into context + counting lines for an
// exact-match Edit. The LSP outline (textDocument/documentSymbol) gives `.range` = the WHOLE declaration
// (signature + body) and `.selectionRange` = just the name; the engine supplies the coordinates, we only
// splice text. Same model as the rest of vts: official index does the analysis, we glue + token-cap. All
// callers preview by default (apply=true writes), mirroring rename — the only other mutating tool.
function flattenDocSyms(syms, out) {
  out = out || [];
  for (const s of syms || []) { out.push(s); if (s.children) flattenDocSyms(s.children, out); }
  return out;
}
// Resolve a symbol NAME to the DocumentSymbol whose `.range` bounds its body. `path` (when given) pins the
// file and goes straight to its outline; otherwise the declaration's file is found via the index (same
// exact-name ranking as find_references-by-name). An optional 0-based `line` disambiguates same-named
// symbols. Returns { file, ds, ambiguous } or { error }.
async function resolveSymbolForEdit(c, root, backendName, a) {
  const want = String(a.symbol || "");
  if (!want) return { error: "needs `symbol` (the declaration name to edit)." };
  let file = a.path ? String(a.path) : null;
  if (!file) {
    const persisted = backendName === "clangd" && hasPersistedIndex(root);
    const syms = await symbolReady(c, want, persisted, envInt("VTS_CLANGD_PERSISTED_WAIT_MS", 60000));
    const pick = syms.slice().sort((x, y) => (x.name === want ? 0 : 1) - (y.name === want ? 0 : 1))[0];
    if (!pick) return { error: `no indexed declaration for "${want}" — pass path=<file> (the outline is read per-file), or run search_symbol first.` };
    file = fromUri(pick.location.uri);
  }
  c.didOpen(file, langIdForPath(file, backendName));
  const flat = flattenDocSyms(await c.documentSymbol(file));
  let matches = flat.filter((s) => s.name === want);
  if (matches.length > 1 && a.line != null) {
    const ln = Number(a.line);
    const near = matches.filter((s) => ((s.selectionRange || s.range) || {}).start && (s.selectionRange || s.range).start.line === ln);
    if (near.length) matches = near;
  }
  if (!matches.length) return { error: `no symbol named "${want}" in ${file.replace(/\\/g, "/")} — the match is exact-name; check spelling or run document_symbols on the file.` };
  const ds = matches[0];
  if (!ds.range) return { error: `backend "${backendName}" returned no body range for "${want}" (flat SymbolInformation, not a hierarchical outline) — can't bound the body to edit safely.` };
  return { file, ds, ambiguous: matches.length };
}

// Run an external command (git / p4), capturing stdout even on a non-zero exit (git diff/status return
// non-zero in some states but still print useful output). Pure best-effort: never throws — a missing
// binary or a timeout comes back as { out:"", err, code }. The wrapper tools compact `out` before it
// reaches the model; this is the only place vts_git/vts_p4 touch the shell.
function runExternal(bin, argv, root) {
  try {
    const out = execFileSync(bin, argv, {
      cwd: root, encoding: "utf8",
      timeout: envInt("VTS_EXTERNAL_TIMEOUT_MS", 20000),
      // A huge diff/log is exactly what compaction is for — don't let a big-but-valid output trip ENOBUFS
      // and read as a failure. 256MB headroom (env-tunable); the compactor shrinks it after capture.
      maxBuffer: envInt("VTS_EXTERNAL_MAXBUFFER", 256 * 1024 * 1024),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return { out: out || "", err: "", code: 0 };
  } catch (e) {
    return { out: e.stdout ? String(e.stdout) : "", err: e.stderr ? String(e.stderr) : String(e.message || e), code: e.status == null ? 1 : e.status };
  }
}
// Normalize a wrapper tool's args into an argv array. Accepts an array (`argv`), a pre-split CLI tail, or a
// single string (`args`) split on whitespace (quote-aware split is the hook's job; here a plain split is fine
// because the hook hands us already-tokenized argv).
function toArgv(a) {
  if (Array.isArray(a.argv)) return a.argv.map(String);
  if (Array.isArray(a.args)) return a.args.map(String);
  if (typeof a.args === "string" && a.args.trim()) return a.args.trim().split(/\s+/);
  if (typeof a.sub === "string" && a.sub.trim()) return a.sub.trim().split(/\s+/);
  return [];
}

// vts_git/vts_p4 are COMPACTION wrappers for READ-ONLY commands — they must NOT become an arbitrary-VCS-
// execution surface. Default-DENY: only these read-only subcommands run; anything else (commit/reset/
// checkout/clean/push/merge/rebase, p4 submit/revert/edit/add/delete/sync-write) is refused. `p4 reconcile`
// is read-only ONLY with -n, so it's forced to preview below.
const GIT_READONLY = new Set(["status", "log", "diff", "show", "blame", "shortlog", "ls-files", "ls-tree", "describe", "rev-parse", "rev-list", "cat-file", "name-rev", "whatchanged", "reflog", "grep", "diff-tree", "cherry", "count-objects"]);
const P4_READONLY = new Set(["opened", "status", "changes", "describe", "filelog", "fstat", "files", "print", "dirs", "diff", "diff2", "where", "info", "annotate", "sizes", "cstat", "reconcile", "have"]);
// p4 (and occasionally git) write a "nothing here" message to STDERR and exit non-zero — e.g. `p4 opened`
// with nothing open prints "File(s) not opened on this client." That's an EMPTY RESULT, not a failure;
// surfacing it as an error is wrong. Recognize the benign shapes so the wrapper returns a clean result.
const BENIGN_EMPTY = /not opened|no file\(s\)|no files? to|up-to-date|nothing (?:opened|to)|no such file|no changes/i;
export const isBenignEmpty = (s) => !!s && BENIGN_EMPTY.test(String(s));

// ---- single dispatcher (async) ----
export async function runTool(name, a = {}) {
  const out = (text) => ({ text, isError: false });
  const err = (text) => ({ text, isError: true });
  const finishOut = (rawObj, body) => {
    const rawTok = rawTokensOf(rawObj), outTok = tok(body);
    try { recordSavings(rawTok, outTok, name); } catch { /* best-effort */ }
    // One-time setup nudge if never configured; additive log steer if this call targets a log. Neither blocks.
    let pre = "";
    if (!_setupNudged && needsSetup()) { _setupNudged = true; pre = SETUP_NUDGE; }
    return out(pre + body + (looksLogTarget(a) ? LOG_STEER : "") + savingsLine(rawTok, outTok));
  };
  // Shared preview/apply writer for the symbolic-edit tools. Preview by default (file:line span only —
  // token-light); apply=true splices the one edit and writes, reusing the rename read-only/Perforce note.
  const symbolEditResult = (file, edit, apply, headline, rawObj) => {
    const fp = file.replace(/\\/g, "/");
    const r = edit.range;
    const span = r.start.line === r.end.line ? `${fp}:${r.start.line + 1}` : `${fp}:${r.start.line + 1}-${r.end.line + 1}`;
    if (!apply) return finishOut(rawObj, `${headline} — PREVIEW at ${span}. Pass apply=true to write.`);
    try { fs.writeFileSync(file, applyEditsToText(fs.readFileSync(file, "utf8"), [edit])); }
    catch (e) { return finishOut(rawObj, `${headline} — FAILED to write ${span} (${e.code || e.message}). Read-only? Check out of Perforce first.`); }
    return finishOut(rawObj, `${headline} — APPLIED at ${span}.`);
  };
  try {
    if (name === "vts_setup") {
      const { current, changed } = applySetup(a);
      // Language-aware setup: census the configured root, report the mix, and pick a sensible default for
      // prewarmBackends when the user hasn't set one — single language → "auto" (warm the dominant backend),
      // multiple languages → "all" (warm each in proportion to its file count). Best-effort; never throws.
      let langLine = "";
      try {
        const root = a.projectPath || current.projectPath || PROJECT_PATH || process.cwd();
        const census = languageCensus(root);
        const langs = ["clangd", "roslyn", "typescript", "pyright"].filter((b) => census[b] > 0);
        langLine = `\nLanguages under ${root}: ` + (langs.length ? langs.map((b) => `${b}(${census[b]})`).join(", ") : "none detected yet");
        if (current.prewarmBackends == null && langs.length) {
          const val = langs.length > 1 ? "all" : "auto";
          applySetup({ prewarmBackends: val });
          current.prewarmBackends = val;
          if (!changed.includes("prewarmBackends")) changed.push("prewarmBackends");
          langLine += `\n→ prewarmBackends="${val}" (${langs.length > 1 ? "multi-language: warm every backend in proportion to its file count" : "single language: warm the dominant backend"}).`;
        }
        // Proactively flag a C++ project with no compile DB — clangd can't index without it, so warn now
        // (at setup) rather than letting the user discover empty search_symbol results later.
        if (census.clangd > 0 && !hasCompileDb(root)) langLine += `\n${compileDbAdvisory(root)}`;
      } catch { /* census is best-effort */ }
      return out((changed.length ? `Updated ${changed.join(", ")}.` : "No recognized keys.") + langLine + `\nConfig: ${CONFIG_FILE}\n${JSON.stringify(current, null, 2)}`);
    }
    if (name === "vts_config") {
      return out(`Effective settings (env > config > default):\n` + JSON.stringify({ projectPath: PROJECT_PATH || "(unset)", backend: BACKEND || "(auto)", maxResults: MAX_RESULTS, prewarmBackends: PREWARM_BACKENDS || "(auto)" }, null, 2) + `\n\nConfig file: ${CONFIG_FILE}`);
    }
    if (name === "vts_savings") return out(savingsReport(a));
    if (name === "vts_savings_reset") { try { fs.writeFileSync(SAVINGS_FILE, "{}"); } catch { /* ignore */ } return out("Savings ledger cleared."); }
    if (name === "vts_discover") return out(discoverReport(a));
    if (name === "vts_warmup") {
      const root = resolveRoot(a);
      const backendName = a.backend || BACKEND || pickBackend(root);
      if (!backendName) return err(`No backend to warm. Pass backend=clangd|roslyn or ensure ${root} has compile_commands.json / a .sln.`);
      const t0 = Date.now();
      await getClient(root, backendName); // spawn + afterInit (index-ready wait) → primes the on-disk + in-process index
      return out(backendAdvisory(backendName, root) + `Warmed ${backendName} for ${root} in ${((Date.now() - t0) / 1000).toFixed(1)}s. Queries in this process are now warm; clangd's on-disk index (.cache/clangd) also persists for faster cold starts.`);
    }
    if (name === "vts_gen_compile_db") {
      // The user's choice: run UBT GenerateClangDatabase for full semantic clangd, OR don't and stay in
      // no-DB text mode. DRY RUN by default (prints the exact command); apply=true runs it (minutes).
      const root = resolveRoot(a);
      const plan = genCompileDbPlan(root, a);
      if (plan.error) return err(plan.error);
      const apply = a.apply === true || a.apply === "true";
      if (!apply) {
        return out(`compile_commands.json generation — DRY RUN (pass apply=true to run; takes minutes, needs the UE build env):\n  ${plan.cmdline}\n\nRun it here (apply=true) or in a terminal. On success clangd gains full semantic search_symbol/find_references/goto/hover; until then vts stays in no-DB text-fallback mode. Override via target/platform/config/compiler/engineRoot args or VTS_UE_ROOT.\nOn apply, compile_commands.json AND clangd's .cache/ index both land OUTSIDE the source tree at ${dbDirFor(root)} (clangd honors --compile-commands-dir as the index root) — nothing for git or p4 to track, and the engine-root copy is removed. Prefer the classic project-root layout? Pass inTree=true (then a VCS-ignore guard protects the in-tree DB + .cache).`);
      }
      if (!fs.existsSync(plan.runUbt)) return err(`RunUBT not found at ${plan.runUbt}. Check engineRoot / VTS_UE_ROOT.`);
      try {
        const t0 = Date.now();
        // RunUBT is a .bat on Windows — Node refuses to spawn .bat/.cmd directly (EINVAL, CVE-2024-27980
        // hardening), so that path goes through the shell using the already-quoted cmdline. The .sh path
        // (and any direct binary) keeps the safer no-shell execFileSync.
        const opts = { stdio: "ignore", timeout: envInt("VTS_UBT_TIMEOUT_MS", 1800000) };
        if (/\.(bat|cmd)$/i.test(plan.runUbt)) execSync(plan.cmdline, opts);
        else execFileSync(plan.runUbt, plan.args, opts);
        // UBT writes compile_commands.json to the engine root; our clangd backend looks under the project
        // root → copy it there if it isn't already.
        // Destination: OUT of the source tree by default (~/.vs-token-safer/db/<slug> — clangd reads it
        // via --compile-commands-dir and writes its .cache/ index next to it, so neither git nor
        // `p4 reconcile` ever sees an artifact). inTree=true keeps the classic project-root layout, with
        // the VCS-ignore guard as the safety net.
        const inTree = a.inTree === true || a.inTree === "true";
        const destDir = inTree ? root : dbDirFor(root);
        const dest = path.join(destDir, "compile_commands.json");
        const atEngine = path.join(plan.engineRoot, "compile_commands.json");
        let where = null;
        if (fs.existsSync(atEngine)) {
          try { fs.mkdirSync(destDir, { recursive: true }); fs.copyFileSync(atEngine, dest); where = dest; } catch { where = atEngine; }
        } else if (fs.existsSync(dest)) where = dest;
        let cleanup = "";
        if (where && where !== atEngine && fs.existsSync(atEngine)) { try { fs.rmSync(atEngine); cleanup = " Engine-root copy removed."; } catch { /* leave it */ } }
        // clangd stores its .cache/clangd background index next to the compile DB (it honors
        // --compile-commands-dir as the index root — live-verified: 6166 shards landed under the
        // out-of-tree dir, none in the source tree). So out-of-tree keeps BOTH the DB and the index out of
        // the tree — nothing to guard. inTree puts both at the project root, so guard compile_commands.json
        // + .cache/ there.
        let ignNote;
        if (inTree) {
          const ign = ensureDbIgnored(root, DB_IGNORES);
          const guard = ign.length ? ` VCS guard: ${ign.join(" ")}` : "";
          ignNote = `\ncompile_commands.json + clangd's .cache/ index are at the project root.${guard}${cleanup}`;
        } else {
          ignNote = `\ncompile_commands.json and clangd's .cache/ index both live OUTSIDE the source tree (${destDir}) — nothing for git or p4 to track.${cleanup}`;
        }
        return out(`Generated compile_commands.json in ${Math.round((Date.now() - t0) / 1000)}s${where ? ` → ${where}` : " (locate compile_commands.json under the engine/project root)"}. clangd now has a full index — restart the MCP server (or re-run the query) so it's picked up.${ignNote}`);
      } catch (e) {
        return err(`UBT GenerateClangDatabase failed: ${e.message}\nRun it manually:\n  ${plan.cmdline}`);
      }
    }
    // find_files / search_text are pure filesystem (no language server) — they work even when no backend
    // is set, and are the sanctioned, token-capped replacements for `find -name` / `grep`.
    if (name === "find_files") {
      if (!a.q) return err("find_files needs q (a filename substring or glob like *Manager.cpp).");
      const root = resolveRoot(a);
      const max = Number(a.maxResults) || MAX_RESULTS;
      const files = findFilesUnder(root, String(a.q), max);
      if (!files.length) return finishOut([], `No files matching "${a.q}" under ${root}.` + LOG_EMPTY_HINT);
      let ft = files.truncated === "cap" ? ` — capped at ${max} (raise maxResults or narrow q; more exist)` : files.truncated === "scan" ? ` — scan limit hit (narrow projectPath; more exist)` : "";
      if (files.truncated) ft += teeNote("find_files", a.q, root, (n) => findFilesUnder(root, String(a.q), n));
      return finishOut(files, `${files.length} file(s) matching "${a.q}"${ft}:\n` + files.join("\n"));
    }
    if (name === "search_text") {
      if (!a.q) return err("search_text needs q (a string or regex to find in code).");
      const root = resolveRoot(a);
      const max = Number(a.maxResults) || MAX_RESULTS;
      // Target selection — naming a file/glob auto-includes WHATEVER extension it is (no docs flag needed):
      //   path=README.md  → search that one file (any ext)
      //   glob=*.md       → search files matching the glob (any ext)
      //   neither         → project-wide ext set: code-only by default, +docs/config when docs=true
      const docs = a.docs === true || a.docs === "true";
      let runScan, scopeLabel;
      if (a.path) {
        const abs = path.resolve(path.isAbsolute(String(a.path)) ? String(a.path) : path.join(root, String(a.path)));
        // Confine the target to the project root — a `path=` outside it (absolute elsewhere, or ../ escape)
        // would turn this "local file:line" tool into an arbitrary-file read. Reject it.
        const rel = path.relative(path.resolve(root), abs);
        if (rel.startsWith("..") || path.isAbsolute(rel)) return err(`search_text path must be inside the project root (${root}). Refusing to read ${a.path}.`);
        runScan = (n) => scanTextFile(abs, String(a.q), n);
        scopeLabel = `in ${String(a.path)}`;
      } else if (a.glob) {
        const acc = globAccept(String(a.glob));
        runScan = (n) => scanTextUnder(root, String(a.q), n, acc);
        scopeLabel = `glob ${String(a.glob)}`;
      } else {
        const ext = docs ? DOC_EXTS : undefined;
        runScan = (n) => scanTextUnder(root, String(a.q), n, ext);
        scopeLabel = docs ? "text+docs" : "text; for symbols prefer search_symbol";
      }
      const hits = runScan(max);
      if (!hits.length) return finishOut([], `No text matches for "${a.q}" (${scopeLabel}) under ${root}.` + LOG_EMPTY_HINT);
      let tt = hits.truncated === "cap" ? ` — capped at ${max} (raise maxResults or narrow q; more exist)` : hits.truncated === "time" ? ` — 4s time-box hit (narrow projectPath/q; more matches likely exist)` : "";
      if (hits.truncated) tt += teeNote("search_text", a.q, root, runScan);
      return finishOut(hits, `${hits.length} match(es) for "${a.q}" (${scopeLabel})${tt}:\n` + hits.join("\n"));
    }
    // vts_git / vts_p4 — run the real VCS command and COMPACT its output before it reaches the model. The
    // language-server index can't help here (status/log/diff/opened aren't source symbols), but the raw dump
    // is verbose + repetitive — group/dedup/cap reclaims the tokens. The grep-block hook reroutes a plain
    // `git status` / `p4 opened` here transparently; the savings ledger aggregates them per tool.
    if (name === "vts_git" || name === "vts_p4") {
      // git/p4 are cwd-relative — run where the user/agent IS, not the configured PROJECT_PATH (which would
      // surprise: `vts git status` in repo B showing the configured repo A). Explicit projectPath still wins.
      const root = resolveCwdRoot(a);
      const max = Number(a.maxResults) || MAX_RESULTS;
      const bin = name === "vts_git" ? "git" : "p4";
      const argv = toArgv(a);
      if (!argv.length) return err(`${bin} needs a subcommand (e.g. argv:["status"] or args:"status -s").`);
      const sub = String(argv[0]).toLowerCase();
      // SAFETY: default-deny to read-only subcommands so the compaction wrapper can't run a mutating VCS op.
      const allowed = bin === "git" ? GIT_READONLY : P4_READONLY;
      if (!allowed.has(sub)) {
        const mut = bin === "git" ? "commit/reset/checkout/clean/push/merge/rebase" : "submit/revert/edit/add/delete";
        return err(`vts_${bin} runs READ-ONLY ${bin} subcommands only (it just compacts output) — "${sub}" is refused. Run mutating commands (${mut}) directly with ${bin}. Allowed: ${[...allowed].slice(0, 10).join(", ")}…`);
      }
      // `git status` long-format is prose; compactGitStatus parses the porcelain `XY path` shape. Force it
      // (idempotent — leave an explicit -s/--short/--porcelain alone) so a plain `git status` compacts too.
      if (bin === "git" && sub === "status" && !argv.some((t) => /^(-s|--short|--porcelain)/.test(t))) argv.push("--porcelain");
      // `p4 reconcile` MUTATES the workspace unless previewing — force -n so the wrapper is always read-only.
      if (bin === "p4" && sub === "reconcile" && !argv.some((t) => t === "-n" || t === "--preview" || /^-[a-z]*n/i.test(t))) argv.push("-n");
      const { out: stdout, err: stderr, code } = runExternal(bin, argv, root);
      const raw = stdout || stderr || "";
      if (!stdout && (code !== 0 || stderr)) {
        // A benign "nothing here" message (p4 writes these to stderr + nonzero) is an empty result, not a
        // failure — return it cleanly so the agent doesn't read an error where there's simply no work.
        if (isBenignEmpty(stderr)) return finishOut("", `${bin} ${argv.join(" ")}: ${stderr.trim().slice(0, 200)}`);
        // genuine failure (binary missing, not a repo/workspace, bad args) — surface stderr, capped with a
        // marker so a huge error isn't silently cut.
        const e = stderr || "no output";
        return err(`${bin} ${argv.join(" ")} failed (exit ${code}):\n${e.length > 1500 ? e.slice(0, 1500) + "\n…(stderr truncated)" : e}`);
      }
      const compactFn = name === "vts_git" ? compactGit : compactP4;
      const body = compactFn(sub, raw, max);
      return finishOut(raw, `${bin} ${argv.join(" ")} (compacted):\n${body}`);
    }

    const root = resolveRoot(a);
    const backendName = a.backend || BACKEND || pickBackend(root);
    // search_symbol degrades gracefully when NO backend resolves (text fallback) instead of hard-erroring —
    // so the grep-rewrite hook can always route an identifier to `vts symbol` (semantic when a backend
    // exists, literal text otherwise) without risking a dead-end error.
    if (!backendName && name === "search_symbol") {
      if (!a.q) return err("search_symbol needs q (the symbol name/substring).");
      const max = Number(a.maxResults) || MAX_RESULTS;
      const hits = scanTextUnder(root, String(a.q), Math.min(max, 20));
      if (hits.length) return finishOut(hits, `No language-server backend resolved for ${root} — literal text matches for "${a.q}" (file:line, not a semantic decl):\n` + hits.join("\n"));
      return finishOut([], `No backend resolved and no text match for "${a.q}" under ${root}.` + EMPTY_HINT);
    }
    if (!backendName) return err(`No backend resolved. Pass backend=clangd|roslyn|typescript|pyright, set VTS_BACKEND, or ensure the project root has compile_commands.json (C++), a .sln/.csproj (C#), a tsconfig/package.json (JS/TS), or a pyproject.toml/*.py (Python).`);
    const max = Number(a.maxResults) || MAX_RESULTS;
    const lang = langIdForPath(a.path, backendName); // languageId for didOpen (hover/document_symbols/rename); unused by search_symbol

    if (name === "search_symbol") {
      if (!a.q) return err("search_symbol needs q (the symbol name/substring).");
      const c = await getClient(root, backendName);
      const persisted = backendName === "clangd" && hasPersistedIndex(root);
      const syms = await symbolReady(c, String(a.q), persisted, envInt("VTS_CLANGD_PERSISTED_WAIT_MS", 60000));
      try { recordQueryResults(root, syms.map((s) => fromUri(s.location.uri))); } catch { /* best-effort */ }
      const adv = backendAdvisory(backendName, root);
      if (!syms.length) {
        // tsserver / pyright answer workspace/symbol from the files they have OPEN/indexed, so a symbol
        // whose file the warm-up didn't open (or a non-exported local) can come back empty even though it
        // exists. Fall back to a bounded literal text search so it's still locatable (clangd/roslyn index
        // the whole project, so they skip this). Clearly labeled: text matches, not semantic declarations.
        // tsserver/pyright answer from OPEN/indexed files (an unopened or non-exported symbol misses);
        // clangd returns nothing without a usable compile_commands.json. In all three, fall back to a
        // bounded literal text search so the name is still locatable. (roslyn indexes the whole solution.)
        if (backendName === "typescript" || backendName === "pyright" || backendName === "clangd") {
          const hits = scanTextUnder(root, String(a.q), Math.min(max, 20));
          if (hits.length) {
            const why = backendName === "clangd"
              ? "clangd has no usable index here (missing/empty compile_commands.json)"
              : `${backendName} answers from open/indexed files, so a symbol whose file isn't open yet (or a non-exported local) can be missed`;
            return finishOut(hits, adv + `No indexed symbol for "${a.q}" — ${why}. Literal text matches instead (file:line of the name, not a semantic decl):\n` + hits.join("\n"));
          }
        }
        return finishOut([], adv + `No symbols matching "${a.q}" (backend: ${backendName}).` + EMPTY_HINT);
      }
      const symTee = teeOverflow("search_symbol", a.q, syms.map((s) => `${s.name} @ ${locLine(s.location.uri, s.location.range)}`), max);
      return finishOut(syms, adv + `${syms.length} symbol(s) matching "${a.q}" (backend: ${backendName}, root: ${root})${symTee}:\n` + fmtSymbols(syms, max));
    }
    if (name === "find_references") {
      const c = await getClient(root, backendName);
      // The code-modification primitive: when modifying a symbol you need every call site, but you start
      // from a NAME, not a 0-based position. Accept `symbol` and resolve the declaration position via the
      // index first (search_symbol → best match → its location), then find references there — so
      // "where is FooBar used" is ONE call, not the locate→position→refs dance that pushes the model to grep.
      let pos = null, originLabel = "";
      if (a.symbol) {
        const persisted = backendName === "clangd" && hasPersistedIndex(root);
        const syms = await symbolReady(c, String(a.symbol), persisted, envInt("VTS_CLANGD_PERSISTED_WAIT_MS", 60000));
        const want = String(a.symbol);
        const wantPath = a.path ? String(a.path).replace(/\\/g, "/").toLowerCase() : null;
        // exact-name matches first; if a path is given, prefer a match in that file (disambiguates overloads).
        const ranked = syms.slice().sort((x, y) => {
          const xe = x.name === want ? 0 : 1, ye = y.name === want ? 0 : 1;
          if (xe !== ye) return xe - ye;
          // endsWith (not includes) so a `path` of "Foo.cpp" doesn't match "BarFoo.cpp"
          if (wantPath) { const xp = fromUri(x.location.uri).replace(/\\/g, "/").toLowerCase().endsWith(wantPath) ? 0 : 1, yp = fromUri(y.location.uri).replace(/\\/g, "/").toLowerCase().endsWith(wantPath) ? 0 : 1; if (xp !== yp) return xp - yp; }
          return 0;
        });
        const pick = ranked[0];
        if (!pick) {
          // no indexed decl (ts/py open-files miss, clangd no-DB) → fall back to a literal usage scan so a
          // code-modder still gets every textual hit, clearly labeled as text not semantic.
          const hits = scanTextUnder(root, want, max);
          if (hits.length) return finishOut(hits, backendAdvisory(backendName, root) + `No indexed declaration for "${want}" — literal usage matches instead (file:line of the name, not semantic references):\n` + hits.join("\n"));
          return finishOut([], backendAdvisory(backendName, root) + `No declaration found for "${want}" (backend: ${backendName}).` + EMPTY_HINT);
        }
        const pp = fromUri(pick.location.uri);
        pos = { path: pp, line: pick.location.range.start.line, character: pick.location.range.start.character };
        c.didOpen(pp, langIdForPath(pp, backendName)); // ensure the resolved TU is open for the references query
        originLabel = `"${want}" (${SYMBOL_KIND[pick.kind] || "sym"} @ ${locLine(pick.location.uri, pick.location.range)})`;
      } else {
        if (!a.path || a.line == null || a.character == null) return err("find_references needs `symbol` (a name — resolved via the index), or a `path` + `line` + `character` position (0-based). `path` may also accompany `symbol` to disambiguate an overload.");
        pos = { path: a.path, line: Number(a.line), character: Number(a.character) };
        originLabel = `${a.path}:${Number(a.line) + 1}`;
      }
      const locs = (await c.references(pos.path, pos.line, pos.character, a.includeDeclaration === true)) || [];
      const locList = (Array.isArray(locs) ? locs : [locs]).filter(Boolean);
      try { recordQueryResults(root, locList.map((l) => fromUri(l.uri))); } catch { /* best-effort */ }
      const refTee = teeOverflow("find_references", a.symbol ? String(a.symbol) : `${path.basename(String(pos.path))}:${pos.line + 1}`, locList.map((l) => locLine(l.uri, l.range)), max);
      return finishOut(locs, backendAdvisory(backendName, root) + `references of ${originLabel} (backend: ${backendName})${refTee}:\n` + fmtLocations(locs, max, "reference(s)"));
    }
    if (name === "goto_definition") {
      if (!a.path || a.line == null || a.character == null) return err("goto_definition needs path, line, character (0-based position).");
      const c = await getClient(root, backendName);
      const locs = (await c.definition(a.path, Number(a.line), Number(a.character))) || [];
      try { recordQueryResults(root, (Array.isArray(locs) ? locs : [locs]).filter(Boolean).map((l) => fromUri(l.uri))); } catch { /* best-effort */ }
      return finishOut(locs, backendAdvisory(backendName, root) + `definition of ${a.path}:${Number(a.line) + 1} (backend: ${backendName}):\n` + fmtLocations(locs, max, "definition(s)"));
    }
    if (name === "hover") {
      if (!a.path || a.line == null || a.character == null) return err("hover needs path, line, character (0-based position).");
      const c = await getClient(root, backendName);
      c.didOpen(a.path, lang); // ensure the TU is open so clangd/Roslyn can answer at the position
      const h = await c.hover(a.path, Number(a.line), Number(a.character));
      return finishOut(h || {}, backendAdvisory(backendName, root) + `hover ${a.path}:${Number(a.line) + 1} (backend: ${backendName}):\n` + fmtHover(h));
    }
    if (name === "document_symbols") {
      if (!a.path) return err("document_symbols needs path (the file to outline).");
      const c = await getClient(root, backendName);
      c.didOpen(a.path, lang);
      const syms = (await c.documentSymbol(a.path)) || [];
      try { recordQueryResults(root, [a.path]); } catch { /* best-effort */ }
      return finishOut(syms, backendAdvisory(backendName, root) + `outline of ${a.path} (backend: ${backendName}):\n` + fmtDocSymbols(syms, max, a.path.replace(/\\/g, "/")));
    }
    if (name === "rename") {
      if (!a.path || a.line == null || a.character == null || !a.newName) return err("rename needs path, line, character (0-based), newName.");
      const c = await getClient(root, backendName);
      c.didOpen(a.path, lang);
      const we = await c.rename(a.path, Number(a.line), Number(a.character), String(a.newName));
      const m = editsByFile(we);
      const total = [...m.values()].reduce((n, e) => n + e.length, 0);
      if (!total) return finishOut(we || {}, `rename: no edits — the symbol at ${a.path}:${Number(a.line) + 1} may not be renameable (backend: ${backendName}).`);
      const rows = [];
      for (const [p, edits] of m) for (const e of edits) rows.push(`${p.replace(/\\/g, "/")}:${e.range.start.line + 1}`);
      const shown = rows.slice(0, max).join("\n") + (rows.length > max ? `\n… ${rows.length - max} more.` : "");
      const apply = a.apply === true || a.apply === "true";
      if (!apply) return finishOut(we, `rename → "${a.newName}" — PREVIEW: ${total} edit(s) across ${m.size} file(s). Pass apply=true to write. Affected:\n${shown}`);
      let written = 0; const failed = [];
      for (const [p, edits] of m) {
        try { fs.writeFileSync(p, applyEditsToText(fs.readFileSync(p, "utf8"), edits)); written++; }
        catch (e) { failed.push(`${p.replace(/\\/g, "/")} (${e.code || e.message})`); }
      }
      const note = failed.length ? `\n⚠ ${failed.length} file(s) not written (read-only? check out of Perforce first): ${failed.slice(0, 5).join("; ")}` : "";
      return finishOut(we, `rename → "${a.newName}" APPLIED: ${total} edit(s) across ${written}/${m.size} file(s).${note}\n${shown}`);
    }
    if (name === "replace_symbol_body" || name === "insert_after_symbol" || name === "insert_before_symbol" || name === "safe_delete") {
      const c = await getClient(root, backendName);
      const r = await resolveSymbolForEdit(c, root, backendName, a);
      if (r.error) return err(`${name}: ${r.error}`);
      const apply = a.apply === true || a.apply === "true";
      const rng = r.ds.range;
      const ambl = r.ambiguous > 1 ? ` (⚠ ${r.ambiguous} symbols named "${a.symbol}"; editing the first — pass line=<0-based> to disambiguate)` : "";
      if (name === "replace_symbol_body") {
        if (a.body == null) return err("replace_symbol_body needs `body` (the new full text for the declaration — signature + body).");
        return symbolEditResult(r.file, { range: rng, newText: String(a.body) }, apply, `replace_symbol_body "${a.symbol}"${ambl}`, r.ds);
      }
      if (name === "insert_after_symbol") {
        if (a.text == null) return err("insert_after_symbol needs `text` (inserted on a new line after the declaration).");
        return symbolEditResult(r.file, { range: { start: rng.end, end: rng.end }, newText: "\n" + String(a.text) }, apply, `insert_after_symbol "${a.symbol}"${ambl}`, r.ds);
      }
      if (name === "insert_before_symbol") {
        if (a.text == null) return err("insert_before_symbol needs `text` (inserted on a line before the declaration).");
        return symbolEditResult(r.file, { range: { start: rng.start, end: rng.start }, newText: String(a.text) + "\n" }, apply, `insert_before_symbol "${a.symbol}"${ambl}`, r.ds);
      }
      // safe_delete — refuse while the symbol is still referenced (unless force=true), so a delete can't
      // silently orphan call sites. References resolve at the NAME (selectionRange), not the whole body.
      const sel = (r.ds.selectionRange || rng).start;
      const refs = ((await c.references(r.file, sel.line, sel.character, false)) || []).filter(Boolean);
      const force = a.force === true || a.force === "true";
      if (refs.length && !force) {
        const where = refs.slice(0, max).map((l) => locLine(l.uri, l.range)).join("\n");
        return finishOut(refs, `safe_delete "${a.symbol}" REFUSED — ${refs.length} reference(s) still point here. Remove them first, or pass force=true. References:\n${where}`);
      }
      const fl = refs.length ? ` (force: ${refs.length} ref(s) ignored)` : "";
      return symbolEditResult(r.file, { range: rng, newText: "" }, apply, `safe_delete "${a.symbol}"${fl}${ambl}`, refs);
    }
    return err(`Unknown tool: ${name}`);
  } catch (e) {
    return err(`vs-token-safer error: ${e.message}`);
  }
}
