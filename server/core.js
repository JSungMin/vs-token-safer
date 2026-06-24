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
import { LspClient, fromUri, langIdForPath, envInt, canonFsPath } from "./lsp.js";
import { pickBackend, BACKENDS, clangdAdvisory, dbDirFor, resolveCdbDir, hasPersistedIndex, findProjectRoot, effectiveCdbDir, scopeDirsFor, buildStaticIndex, hasClangdIndexer, indexerEnabled, clangdIndexModeAdvisory } from "./backends/index.js";
import { scopeStats, inScope } from "./scope.js";
import { recordQueryResults, languageCensus, histRank } from "./warmset.js";
import { splitSegments } from "./shell-split.js";
import { classifyDeclEdit } from "./edit-detect.js";
import { counterfactualOn, relateSets, recordCounterfactual, grepKey, locKey, counterfactualReport } from "./counterfactual.js";
import { recordEditEvent } from "./edit-ledger.js";
import { compactGit, compactP4 } from "./compact.js";
import { tsSearchSymbols, tsSearchReferences, tsFileDeclDocs, tsSupports, tsAvailable, htmlEmbeddedDecls, tsChunkEnd } from "./treesitter.js";
import { searchSymIndex, buildSymIndex, symIndexPath, loadSymIndex } from "./symindex.js";
import { splitIdent, tokenize, buildConceptModel, expandQuery, scoreSymbol, importSpecifiers, parseSynonyms, anchorConfident, prfTerms } from "./concept.js";
import { cochangeNeighbors } from "./cochange.js";
import { isStructFile, structOutlineInjected, resolveInOutline, fmtOutline } from "./textstruct.js";
import { analyzeDeadCode, reachabilityDeadCode, formatDce, dceWarmGate, reconcileRefs, parseRootsFile } from "./dce.js";

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
const CONFIG_KEYS = ["projectPath", "backend", "maxResults", "prewarmBackends", "tee", "excludeCommands", "usdPerMtok", "clangdCmd", "scope", "clangdIndexer"];

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
// File-language backend: when a query TARGETS a specific file, its extension decides the language more
// reliably than the root's build artifacts. In a MIXED repo — e.g. a UE C++ tree (`.uproject` → clangd)
// with a Python tooling dir — pickBackend(root) returns clangd for the whole tree, so a `.py`/`.ts` query
// would hit clangd and find nothing, and the model gives up on vts. Prefer the file's OWN backend over the
// root heuristic; an explicit `backend=`/`VTS_BACKEND` still wins (this only beats the auto-detect fallback).
export function backendForPath(p) {
  const m = p && String(p).toLowerCase().match(/\.[a-z0-9]+$/);
  if (!m) return null;
  const e = m[0];
  if (/^\.(c|cc|cxx|cpp|h|hpp|hh|inl|ipp|tpp)$/.test(e)) return "clangd";
  if (e === ".cs") return "roslyn";
  if (/^\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(e)) return "typescript";
  if (/^\.(py|pyi)$/.test(e)) return "pyright";
  return null;
}

// Backend precedence for a single query (pure, exported for the eval). Order: an explicit per-call
// `backend=` wins outright > the path's OWN backend WHEN it conflicts with a forced backend (so a `.js`/`.cs`/
// `.py` is never sent to a `backend:"clangd"`-pinned global server → `-32001 invalid AST`) > the forced
// backend (config `backend` / `VTS_BACKEND`) > the path's backend > "" (caller falls back to pickBackend(root)).
// A path-less query (byPath null) keeps the forced backend, so `search_symbol` by name on a C++ repo stays clangd.
export function preferBackend(aBackend, byPath, forced) {
  return aBackend || (byPath && forced && byPath !== forced ? byPath : forced) || byPath || "";
}

// Census-based multi-backend fallback for a PATH-LESS search_symbol. A name-only query has no `path` to drive
// backendForPath, so preferBackend keeps the forced/root backend (clangd in a UE tree). A DIFFERENT language
// in the SAME repo — a Python tooling dir, a JS side-project — is then structurally invisible: the query is
// sent to clangd, finds nothing, and the model gives up on vts. So when the primary backend misses, consult
// the language census and retry against the OTHER backends that actually have files here, most-code-first.
// Returns the candidate backend names (excluding `primary`, count ≥ VTS_CENSUS_FALLBACK_MIN), census-desc.
// `census` is injectable for the eval. VTS_CENSUS_FALLBACK=0 disables; only fired on a path-less, non-explicit
// query (a deliberate `path=`/`backend=` choice is never second-guessed).
export function censusFallbackBackends(root, primary, census) {
  if (/^(0|false|off|no)$/i.test(String(process.env.VTS_CENSUS_FALLBACK ?? "1"))) return [];
  const min = envInt("VTS_CENSUS_FALLBACK_MIN", 1);
  const c = census || languageCensus(root);
  return ["clangd", "roslyn", "typescript", "pyright"]
    .filter((b) => b !== primary && (c[b] || 0) >= min)
    .sort((x, y) => (c[y] || 0) - (c[x] || 0));
}

// Perforce auto-checkout for a symbol-edit / rename APPLY. A symbol edit writes via `fs` directly (it bypasses
// the built-in Edit/Write tool, so a p4-checkout PreToolUse hook never fires for it). In a P4 workspace an
// unopened file is READ-ONLY, so before writing a read-only file we run `p4 edit` to open it for edit. Gated ON
// the read-only signal → a normal writable (git) repo never invokes p4, so there's no p4 dependency for most
// users. Best-effort: if p4 is missing or the file isn't in a client the edit fails, the file stays read-only,
// and the caller's write surfaces the existing "check out of Perforce" note. VTS_P4_EDIT=0 disables;
// VTS_P4_CMD overrides the binary. Returns a short note when it actually opened the file (else "").
export function ensureWritableForEdit(file) {
  try { fs.accessSync(file, fs.constants.W_OK); return ""; } catch { /* read-only → maybe a Perforce-managed file */ }
  if (/^(0|false|off|no)$/i.test(String(process.env.VTS_P4_EDIT ?? "1"))) return "";
  const p4 = process.env.VTS_P4_CMD || "p4";
  try {
    execSync(`${p4} edit ${JSON.stringify(file)}`, { stdio: "ignore", timeout: envInt("VTS_P4_TIMEOUT_MS", 15000), cwd: path.dirname(file) });
    fs.accessSync(file, fs.constants.W_OK); // only claim success if the file is now writable
    return " (p4 edit'd for checkout)";
  } catch { return ""; }
}

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
  "\n\n↪ Looks like a LOG. The index covers source, not logs — use gamedev-log " +
  "(/gamedev-log-analyzer:logs, or CLI: summary/search/locate/fields/diff).";
// Appended to an empty symbol result (mirrors rider's honest empty-result hint): an empty answer can be a
// stale index, a definitions-only match, or a string that only lives in a log (excluded from the index).
const EMPTY_HINT =
  " Empty can mean: JUST-edited (index lags the save — retry or search_text), a DEFINITIONS-only match " +
  "(not every reference), or a LOG (not indexed — use gamedev-log).";
const LOG_EMPTY_HINT = " Looking for something in a LOG? Logs aren't indexed for code search — use gamedev-log for log content.";
// search_text → symbol steer (dogfood-found): a TEXT query that is really a SYMBOL/CLASS usage hunt — a
// template arg `Foo<Bar>`, a `::` scope, or a dominant CamelCase/snake identifier — is answered better by
// find_references / search_symbol: the LSP index is COMPLETE (no 4s time-box) and ~10–20× smaller. The
// model reached for search_text on `FindComponentByClass<UMyComp>` and got an 8-of-49 time-boxed slice;
// find_references returned all 49 at 19× compaction. Pull the most likely target NAME: a `<Type>` template
// arg wins (that's what's being hunted), else the longest CamelCase/snake identifier. Returns null when the
// query carries no symbol-shaped token (`TODO|FIXME`, freeform prose) → no steer, no noise.
export function symbolHuntInText(q) {
  const s = String(q || "");
  if (!s || s.length > 200) return null;
  const tmpl = /<\s*([A-Za-z_][A-Za-z0-9_]*)\s*>/.exec(s);
  if (tmpl) return tmpl[1];
  const ids = s.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || [];
  const cand = ids.filter((w) => /[a-z][A-Z]/.test(w) || /[a-z0-9]_[a-z]/.test(w));
  if (!cand.length) return null;
  return cand.sort((a, b) => b.length - a.length)[0];
}
// An ALTERNATION of symbols (`A|B|C`, any N) — the model reaches for search_text because find_references
// takes ONE name, not a regex. Pull every identifier branch so the steer can point at find_references PER
// symbol (the general `|` case, not just two). Returns the deduped identifier list, or null when it isn't a
// symbol alternation: every `|`-separated branch must be a bare identifier AND at least one must carry a
// CamelCase/snake cue (so a keyword/content alternation — `TODO|FIXME`, `GET|POST|HEAD` — is NOT steered;
// those are real text filters, not symbols, exactly as the grep-block hook classifies them).
export function altSymbols(q) {
  const s = String(q || "");
  if (!s.includes("|") || s.length > 200) return null;
  const branches = s.split("|").map((b) => b.trim()).filter(Boolean);
  if (branches.length < 2) return null;
  if (!branches.every((b) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(b))) return null; // any non-identifier branch → a regex, not a symbol list
  if (!branches.some((b) => /[a-z][A-Z]|[a-z0-9]_[a-z]/.test(b))) return null;  // no CamelCase/snake cue → keyword alternation, leave it
  return [...new Set(branches)];
}
const textSteerOn = () => !/^(0|false|off|no)$/i.test(String(process.env.VTS_TEXT_STEER ?? "1"));
// Build the one-line steer, or "" — fires only on a clear symbol hunt that would actually benefit: the
// scan was TRUNCATED (completeness now matters) OR the query carries a `<>`/`::` code cue. A bare CamelCase
// text search that completed fine isn't nagged.
function textSymbolSteer(q, truncated) {
  if (!textSteerOn()) return "";
  // Alternation of symbols (A|B|C, any N) → steer to find_references on EACH (find_references can't take a
  // regex; search_text matched the whole alternation as full line text). Fires regardless of truncation —
  // an alternation of symbols always has a strictly better per-symbol semantic path.
  const alts = altSymbols(q);
  if (alts && alts.length >= 2) {
    const list = alts.slice(0, 6).map((a) => `find_references symbol="${a}"`).join(" · ");
    const more = alts.length > 6 ? ` (+${alts.length - 6} more)` : "";
    return `\n↪ "${q}" is an ALTERNATION of ${alts.length} symbols — search_text matched it as one regex (full line text). find_references can't take A|B in one call; for semantic, COMPLETE results run ONE call per symbol: ${list}${more}.`;
  }
  const sym = symbolHuntInText(q);
  if (!sym) return "";
  // "strong" cue = a code expression (`::`/`<>`) OR a BARE identifier (the whole query is one symbol name,
  // e.g. `SmoothSyncBudget`). A bare-identifier text search ALWAYS has a strictly better semantic tool, so
  // steer even when it completed (not just when truncated) — that's the case the model keeps reaching for.
  const strong = /::|<|>/.test(String(q)) || /^[A-Za-z_][A-Za-z0-9_]{2,}$/.test(String(q).trim());
  if (!truncated && !strong) return "";
  return truncated
    ? `\n↪ "${sym}" looks like a symbol and this text scan was TRUNCATED. find_references symbol="${sym}" is semantic + COMPLETE (no time-box) and ~10–20× smaller; search_symbol q="${sym}" for the declaration.`
    : `\n↪ "${sym}" is a symbol — find_references symbol="${sym}" (all uses, semantic, file:line only, COMPLETE) or search_symbol q="${sym}" (its declaration) is far smaller than a text scan, which returns full line text.`;
}
// Appended to a FOCUSED symbol/definition result: the model just located a declaration, the moment right
// BEFORE it would Read the whole file to Edit it. Point it at the symbol-edit tools, which edit by NAME and
// skip that read — the token win lives here (upstream of Edit), not at the Edit call. Additive, one line,
// only on small result sets (a 60-hit search isn't an edit precursor). `VTS_EDIT_STEER=0` hides it.
const EDIT_STEER =
  "\n↪ Going to CHANGE one of these? Edit by NAME — replace_symbol_body (whole body) / insert_symbol " +
  "(position=after|before) / safe_delete (preview by default, apply=true writes). It skips reading the file into " +
  "context. (VTS_EDIT_STEER=0 to hide.)";
const editSteerOn = () => process.env.VTS_EDIT_STEER !== "0" && process.env.VTS_EDIT_STEER !== "false";
const usesSteerOn = () => process.env.VTS_USES_STEER !== "0" && process.env.VTS_USES_STEER !== "false";
const refNavOn = () => process.env.VTS_REF_NAV !== "0" && process.env.VTS_REF_NAV !== "false";
// Appended to a LARGE flat find_references result: the same dependents can be read far cheaper as a per-file
// blast-radius SUMMARY (detail=file) or navigated as the transitive caller TREE (direction=callers) — point
// the model at those instead of scrolling a long flat list. Only when the set is big (a handful of refs
// doesn't need a summary). `VTS_REF_NAV=0` hides it.
export function refNavSteer(n, max) {
  if (!refNavOn()) return "";
  if (n <= max && n < envInt("VTS_REF_NAV_MIN", 25)) return "";
  return `\n↪ ${n} references — smaller views of the same set: detail=file (per-file blast-radius summary) or detail=dir; direction=callers (the transitive caller tree, before you change it). (VTS_REF_NAV=0 to hide.)`;
}

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
// The bundled sibling gamedev-log-analyzer keeps its own savings ledger (same shape); its log-compaction
// savings count toward the same win (fewer tokens reach the model), so `vts savings` folds them into the
// combined total. Local file read only — nothing transmitted. Override path via VTS_GAMEDEV_SAVINGS_FILE.
const GAMEDEV_SAVINGS_FILE = process.env.VTS_GAMEDEV_SAVINGS_FILE || path.join(os.homedir(), ".gamedev-log-analyzer", "savings.json");
const readGamedevSavings = () => { try { return JSON.parse(fs.readFileSync(GAMEDEV_SAVINGS_FILE, "utf8")) || {}; } catch { return {}; } };
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
// HONEST per-tool baseline label: read_symbol/document_symbols measure the WHOLE-FILE Read they avoid; the
// search/nav tools measure the raw language-server response they cap. Saying "raw index response" for the
// avoided-read tools was literally wrong (the baseline is the file). One ledger, two clearly-labeled baselines.
const AVOIDED_READ_TOOLS = new Set(["read_symbol", "document_symbols"]);
function savingsLine(rawTok, outTok, tool) {
  if (rawTok < 2000) return "";
  const ratio = outTok > 0 ? Math.round(rawTok / outTok) : rawTok;
  const pct = (100 * (1 - outTok / Math.max(rawTok, 1))).toFixed(1);
  const vs = AVOIDED_READ_TOOLS.has(tool) ? "vs a full-file Read" : "vs the raw index";
  return `\n\n✓ Saved ~${(rawTok - outTok).toLocaleString()} tok here (${pct}% / ${ratio}× ${vs}).`;
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
// Value-tied star pointer — shown ONLY in this manual `vts savings` report (never in the search/edit flow),
// and only once the cumulative saving crosses a threshold, so it rides delivered value instead of nagging.
// NO network and NO star-status check: the plugin stays zero-transmission — we never ask GitHub whether you've
// starred (that would be an outbound call, breaking PRIVACY.md). A pure function of `saved`. Off: VTS_STAR_NUDGE=0.
export function starNudgeLine(saved) {
  if (/^(0|false|off|no)$/i.test(String(process.env.VTS_STAR_NUDGE ?? "1"))) return "";
  const min = parseInt(cfg("VTS_STAR_MIN", "starMin", "50000"), 10) || 50000;
  if (!(Number(saved) >= min)) return "";
  return `\n\n⭐ vs-token-safer has saved you ~${Number(saved).toLocaleString()} tokens so far. If it's pulling its weight, a star helps others find it — github.com/JSungMin/vs-token-safer (no tracking; this line is just a thank-you, set VTS_STAR_NUDGE=0 to hide).`;
}
function savingsReport(a = {}) {
  const s = readSavings();
  const gd = readGamedevSavings();
  const gdSaved = Math.max(0, (gd.rawTok || 0) - (gd.outTok || 0));
  if (!s.runs && !gd.runs) return "No savings recorded yet — run a search first.";
  const ratio = s.outTok > 0 ? Math.round(s.rawTok / s.outTok) : "∞";
  const best = s.bestRaw ? `\n  biggest single run: ${s.bestRaw.toLocaleString()} → ${s.bestOut.toLocaleString()} tok` : "";
  const totalSaved = Math.max(0, (s.rawTok || 0) - (s.outTok || 0));
  let body = `vs-token-safer savings (local, ${s.runs || 0} search(es))\n  total saved: ~${totalSaved.toLocaleString()} tokens vs forwarding raw index responses\n  raw → output: ${(s.rawTok || 0).toLocaleString()} → ${(s.outTok || 0).toLocaleString()} tok (~${ratio}× smaller)${best}\n  est. value: ~$${usd(totalSaved).toFixed(2)} (@ $${USD_PER_MTOK}/Mtok — rough, set VTS_USD_PER_MTOK)`;
  if (s.tools) {
    const byTool = Object.entries(s.tools).map(([t, v]) => [t, v.rawTok - v.outTok, v.runs]).sort((x, y) => y[1] - x[1]).slice(0, 5);
    if (byTool.length) body += `\n  by tool: ` + byTool.map(([t, sv, n]) => `${t} ~${sv.toLocaleString()} (${n})`).join(", ");
  }
  // Fold in the bundled gamedev-log-analyzer's log-compaction savings → a combined total (same goal: fewer
  // tokens reach the model). Shown as a separate line so the split stays legible.
  if (gdSaved > 0 || gd.runs) {
    const combined = totalSaved + gdSaved;
    body += `\n  + gamedev-log-analyzer (logs): ~${gdSaved.toLocaleString()} tokens saved (${(gd.runs || 0).toLocaleString()} run(s))` +
      `\n  ▸ COMBINED saved: ~${combined.toLocaleString()} tokens (~$${usd(combined).toFixed(2)})`;
  }
  const want = (k) => a[k] === true || a[k] === "true";
  // Graph shows BY DEFAULT (the at-a-glance trend is the point of the report). Suppress per-call with
  // graph:false, or globally with VTS_SAVINGS_GRAPH=0 (e.g. to keep a scripted `vts savings` terse).
  const showGraph = !(a.graph === false || a.graph === "false" || /^(0|false|off|no)$/i.test(String(process.env.VTS_SAVINGS_GRAPH ?? "1")));
  if (showGraph) body += `\n\nSaved tokens / day (last 30):\n${savingsGraph(s, 30)}`;
  if (want("daily")) {
    const keys = Object.keys(s.days || {}).sort().slice(-14);
    body += `\n\nDaily (last ${keys.length}):\n` + keys.map((k) => { const b = s.days[k]; return `  ${k}  saved ~${(b.rawTok - b.outTok).toLocaleString()}  (${b.runs} run(s))`; }).join("\n");
  }
  if (want("history")) {
    body += `\n\nRecent runs:\n` + (s.history || []).slice().reverse().map((h) => `  ${h.t.replace("T", " ").slice(0, 19)}  ${h.raw.toLocaleString()} → ${h.out.toLocaleString()} tok`).join("\n");
  }
  body += counterfactualReport(); // "" unless VTS_COUNTERFACTUAL=1 has recorded shadow-grep comparisons
  return body + starNudgeLine(totalSaved) + `\n\nLedger: ${SAVINGS_FILE}`;
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
// Whole-declaration edit detection (replace + insert) lives in edit-detect.js, SHARED with the enforcement
// hook so the set we MEASURE here matches the set the hook STEERS. Discover counts an edit when its replaced
// text is a whole declaration (replace_symbol_body territory) OR its added text is (insert_after/before).
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
  // Edit-habit measurement (A): count whole-declaration Edits on code files, and attribute the tokens of a
  // PRIOR Read of that same file — that read is what a symbol-edit (edit-by-name) would have skipped.
  let editCount = 0, editReadTok = 0, editUnreached = 0; // editUnreached: whole-decl edits with NO prior vts
  // search on that file → the EDIT_STEER (which only rides a search_symbol/goto result) could never have
  // reached them. A high fraction is the case for a harder lever (a warn on the Edit itself).
  const reads = new Map();      // normalized file → tokens of its most recent Read result (per transcript)
  const readUse = new Map();    // Read tool_use_id → normalized file (its result carries the size)
  const searchUse = new Map();  // vts search/goto/refs tool_use id → true (its result carries the file:line)
  const searchedBn = new Set(); // basenames seen in a prior vts search/goto/refs RESULT → steer-reachable
  outer: for (const { p } of files) {
    cand.clear(); reads.clear(); readUse.clear(); searchUse.clear(); searchedBn.clear(); // tool_use+result share one transcript → bound per file
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
        if (b && b.type === "tool_use") {
          const m = matchBypass(b.name, b.input); if (m) cand.set(b.id, m);
          if (b.name === "Read" && b.input && b.input.file_path) readUse.set(b.id, String(b.input.file_path).replace(/\\/g, "/").toLowerCase());
          else if (/(?:search_symbol|goto_definition|find_references)$/.test(String(b.name || ""))) searchUse.set(b.id, true);
          else { const ce = classifyDeclEdit(b.name, b.input, envInt("VTS_EDIT_MIN_LINES", 8)); if (ce.file && (ce.replaceDecl || ce.insertDecl)) { editCount++; if (reads.has(ce.file)) { editReadTok += reads.get(ce.file); reads.delete(ce.file); } if (!searchedBn.has(path.basename(ce.file))) editUnreached++; } } // attribute a read ONCE (a re-Read re-adds it); unreached = no prior vts search landed on this file
        }
        else if (b && b.type === "tool_result" && readUse.has(b.tool_use_id)) {
          const f = readUse.get(b.tool_use_id); readUse.delete(b.tool_use_id);
          const o = typeof b.content === "string" ? b.content : JSON.stringify(b.content || "");
          reads.set(f, tok(o)); // most recent Read of this file → the token a later symbol-edit would skip
        }
        else if (b && b.type === "tool_result" && searchUse.has(b.tool_use_id)) {
          searchUse.delete(b.tool_use_id);
          const o = typeof b.content === "string" ? b.content : JSON.stringify(b.content || "");
          let pm; PATH_RE.lastIndex = 0; while ((pm = PATH_RE.exec(o))) searchedBn.add(path.basename(pm[0]).toLowerCase()); // files a prior steer-carrying search surfaced
        }
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
  return { missed, rawTokTotal, learned, filesCount: files.length, all, since, editCount, editReadTok, editUnreached };
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
  const { missed, rawTokTotal, learned, filesCount: fc, all, since, editCount, editReadTok, editUnreached } = r;
  // A: surface the edit habit alongside the search bypasses — whole-declaration Edits that could edit by name.
  // editUnreached = those with no prior vts search on the file → the EDIT_STEER (search-result-only) can't
  // reach them; a high fraction is the evidence for a harder lever (a warn on the Edit itself).
  const editLine = editCount ? `\n  edit habit: ${editCount} whole-declaration Edit(s) on code; ~${editReadTok.toLocaleString()} tok went to reading those files first — replace_symbol_body / insert_symbol / safe_delete edit by NAME and skip that read.` +
    `\n    of those, ${editUnreached}/${editCount} had NO prior vts search on that file → the search-result steer can't reach them (the case for a warn-on-Edit if this fraction stays high).` : "";
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
  // The search-only catch-rate is FLATTERING: it omits the edit-pre-read tokens (typically the bigger leak).
  // Add an HONEST line that folds editReadTok into the leaking side so the true coverage — and the symbol-edit
  // adoption gap it exposes — isn't hidden (the metric a critic rightly flagged as a vanity number).
  const trueLeak = rawTokTotal + (editReadTok || 0);
  const trueRate = caught + trueLeak > 0 ? (100 * caught / (caught + trueLeak)).toFixed(1) : "—";
  const trueLine = editReadTok ? `\n  true coverage (incl. edit-pre-reads): ~${caught.toLocaleString()} caught vs ~${trueLeak.toLocaleString()} leaking (search ${rawTokTotal.toLocaleString()} + edit-read ${editReadTok.toLocaleString()}) → ${trueRate}% — symbol-edit adoption is the real gap.` : "";
  const catchLine = `\n  catch-rate: ~${caught.toLocaleString()} tok caught (via vts) vs ~${rawTokTotal.toLocaleString()} still bypassing → ${rate}% of search tokens routed through vts` + trueLine;
  if (!missed.length) return `vs-token-safer discover (${scope}, ${files.length} transcript(s)): no code searches bypassed vts. It's catching them. ✓` + catchLine + editLine + learnLine;
  const byTool = {};
  for (const m of missed) byTool[m.tool] = (byTool[m.tool] || 0) + 1;
  const toolLine = Object.entries(byTool).sort((x, y) => y[1] - x[1]).map(([t, n]) => `${t}×${n}`).join(", ");
  const top = missed.slice().sort((x, y) => y.rawTok - x.rawTok).slice(0, 5)
    .map((m) => `  ~${m.rawTok.toLocaleString()} tok  [${m.tool}]  ${m.q}`).join("\n");
  return `vs-token-safer discover — missed token savings (local scan, ${scope}, ${files.length} transcript(s))\n` +
    `  ${missed.length} code search(es) bypassed vts (${toolLine})\n` +
    `  raw tool output ingested: ~${rawTokTotal.toLocaleString()} tok (~$${usd(rawTokTotal).toFixed(2)}) — routed through vts (file:line, capped) most of this is avoidable (typically 70–90% less)${catchLine}\n` +
    `  biggest:\n${top}\n` +
    `  Fix: rewrite is on by default (Bash grep auto-reroutes to vts); for the Grep tool, prefer the vs-search MCP tools (search_symbol / search_text / find_files).${editLine}${learnLine}`;
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
// B: when a clangd query comes back EMPTY, say WHY — distinguish (1) the target file isn't in the compile DB
// at all (its module wasn't built/included) from (2) it IS in the DB but its index shard isn't built yet (the
// background index is incomplete on a huge tree — the live UE case: a 26k-TU full-engine DB only ~42% indexed,
// so a real symbol's TU hadn't been indexed → text fallback). Far more actionable than the generic EMPTY_HINT.
// clangd-only, best-effort, cached (the DB can be 26k entries → parse once per cdbDir). VTS_INDEX_ADVISORY=0 off.
const _cdbCache = new Map(); // cdbDir → { count, files:Set<canonPath>, mtime }
function loadCdb(cdbDir) {
  try {
    const cc = path.join(cdbDir, "compile_commands.json");
    const st = fs.statSync(cc);
    const hit = _cdbCache.get(cdbDir);
    if (hit && hit.mtime === st.mtimeMs) return hit;
    const j = JSON.parse(fs.readFileSync(cc, "utf8"));
    const v = { count: j.length, files: new Set(j.map((e) => canonFsPath(String(e.file || ""))).filter(Boolean)), mtime: st.mtimeMs };
    _cdbCache.set(cdbDir, v);
    return v;
  } catch { return null; }
}
function clangdShardCount(cdbDir) {
  try { let n = 0; for (const f of fs.readdirSync(path.join(cdbDir, ".cache", "clangd", "index"))) if (f.endsWith(".idx")) n++; return n; } catch { return 0; }
}
export function clangdIndexAdvisory(backendName, root, targetPath) {
  if (backendName !== "clangd") return "";
  if (/^(0|false|off|no)$/i.test(String(process.env.VTS_INDEX_ADVISORY ?? "1"))) return "";
  // Use the EFFECTIVE (scoped) CDB so the TU count + shard % reflect the scope — else a scoped project still
  // reports the full ~26k TUs and tells the user to scope when they already have.
  let cdbDir; try { cdbDir = effectiveCdbDir(root); } catch { cdbDir = null; }
  if (!cdbDir) return ""; // the no-DB case is already covered by compileDbAdvisory
  const db = loadCdb(cdbDir);
  if (!db) return "";
  // (1) a file-targeted query whose file isn't in the DB → the module isn't compiled for this target
  if (targetPath) {
    const want = canonFsPath(String(targetPath));
    if (want && !db.files.has(want)) {
      return `\n⚠ ${path.basename(String(targetPath))} is NOT in compile_commands.json — its module likely isn't built/included in the target. Build the editor target (UBT compiles it + UHT generates *.generated.h), then regenerate the DB (vts_admin {op:"gen_compile_db", params:{apply:true}}).`;
    }
  }
  // (2) the DB covers it, but clangd's background index is incomplete → the symbol's TU may be unindexed
  const shards = clangdShardCount(cdbDir);
  if (db.count > 0 && shards < Math.floor(db.count * 0.9)) {
    const pct = Math.round((shards / db.count) * 100);
    return `\n⚠ clangd index ~${pct}% complete (${shards.toLocaleString()}/${db.count.toLocaleString()} TUs) — the symbol's translation unit may not be indexed yet (not a definitive 0). Keep the MCP server warm so the background index finishes, or scope the compile DB to your game modules (exclude the engine's ~11k TUs) so it indexes fully + fast.`;
  }
  return "";
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
let _idxModeShown = false;
function backendAdvisory(backendName, root) {
  if (backendName !== "clangd") return "";
  let s = "";
  if (!_advisoryShown) { const a = clangdAdvisory(BACKENDS.clangd.cmd); if (a) { _advisoryShown = true; s += a + "\n\n"; } }
  if (!_dbAdvisoryShown && root) { const d = compileDbAdvisory(root); if (d) { _dbAdvisoryShown = true; s += d + "\n\n"; } }
  // Background-index tier advisory (huge tree → throttled/off to protect RAM). One-time per process so it
  // doesn't repeat on every clangd result, but loud enough that a degraded search isn't mistaken for a miss.
  if (!_idxModeShown && root) { const m = clangdIndexModeAdvisory(root); if (m) { _idxModeShown = true; s += m + "\n\n"; } }
  return s;
}

// ---- token-capping formatters: LSP results → compact file:line (no bodies) ----
const locLine = (uri, range) => `${fromUri(uri).replace(/\\/g, "/")}:${(range.start.line + 1)}`;
function fmtSymbols(syms, max) {
  const shown = syms.slice(0, max);
  const more = syms.length - shown.length;
  const tail = more > 0 ? `\n… ${more} more (raise maxResults or narrow the query).` : "";
  const rows = shown.map((s) => {
    const kind = SYMBOL_KIND[s.kind] || `k${s.kind}`;
    const container = s.containerName ? ` (in ${s.containerName})` : "";
    return { head: `${kind} ${s.name}${container}`, loc: locLine(s.location.uri, s.location.range) };
  });
  // Factor the common directory prefix out of the `@ path:line` tails (same token-saver as find_references /
  // find_files): a project-wide symbol search repeats the long absolute root on every row. Printed once as
  // `under <prefix>/`; full path recoverable as `<prefix>/<tail>`. VTS_COMPACT_RESULTS=0 → classic per-row.
  if (compactResults() && rows.length > 1) {
    const prefix = commonDirPrefix(rows.map((r) => r.loc));
    if (prefix) return `under ${prefix}/\n` + rows.map((r) => `  ${r.head}  @ ${r.loc.slice(prefix.length + 1)}`).join("\n") + tail;
  }
  return rows.map((r) => `${r.head}  @ ${r.loc}`).join("\n") + tail;
}

// ---- result RERANK (Semble-inspired, charter-pure) ----------------------------------------------------
// Semble (cited) shows lexical+semantic FUSION + code-aware reranking beats either alone. We adopt the
// RANKING idea WITHOUT its embeddings/persistent vector index (those are the cbm-style rejects: a second
// semantic source + a storage/transmission surface). This reranks the OFFICIAL engine's own results, so it
// is zero-transmission, holds no index, and changes no MCP surface. It matters because search_symbol CAPS to
// top-N — order decides which rows survive the cap, i.e. whether the answer the model wants is even shown.
// Score = lexical tier (exact > prefix > word/camel boundary > substring) + a callable-kind nudge + a
// query-history boost (the SAME warmset LFU+recency signal that orders prewarm). Tiers are spaced so the
// history boost only re-orders near-ties WITHIN a tier and can never flip a clearly-better lexical match.
// STABLE: equal scores keep the LSP's original order, so behavior is unchanged when nothing out-ranks.
// VTS_RANK=0 disables. Pure function (no I/O) — the caller supplies the history map.
const rankEnabled = () => { const v = process.env.VTS_RANK; return v === undefined || v === "" ? true : !/^(0|false|off|no)$/i.test(v); };
function lexScore(name, q) {
  if (!name || !q) return 0;
  const n = name.toLowerCase(), s = q.toLowerCase();
  if (n === s) return 100;            // exact name
  if (n.startsWith(s)) return 30;     // prefix
  let i = n.indexOf(s);
  if (i < 0) return 0;
  while (i >= 0) {                     // any occurrence at a word/camel boundary
    const prev = name[i - 1], cur = name[i];
    if (i === 0 || prev === "_" || /[^A-Za-z0-9]/.test(prev) || (/[A-Z]/.test(cur) && /[a-z0-9]/.test(prev || ""))) return 10;
    i = n.indexOf(s, i + 1);
  }
  return 3;                            // plain substring, no boundary
}
export function rankSymbols(query, syms, histMap) {
  if (!Array.isArray(syms) || syms.length < 2) return syms;
  const hist = histMap instanceof Map && histMap.size ? histMap : null;
  const maxHist = hist ? Math.max(...hist.values()) : 0;
  const scoreOf = (sm) => {
    let sc = lexScore(sm && sm.name, query);
    if (sm && CALLABLE_KIND.has(sm.kind)) sc += 2; // a symbol hunt usually wants a func/class/type, not a local
    if (hist && maxHist > 0 && sm && sm.location) {
      const key = fromUri(sm.location.uri).replace(/\\/g, "/").toLowerCase();
      const h = hist.get(key);
      if (h) sc += 2.5 * (h / maxHist); // < tier gap, so it only breaks near-ties / nudges within a tier
    }
    return sc;
  };
  return syms.map((s, i) => ({ s, i, sc: scoreOf(s) }))
    .sort((a, b) => (b.sc - a.sc) || (a.i - b.i)) // stable: equal score keeps the engine's original order
    .map((x) => x.s);
}

// CONFIDENCE-ADAPTIVE FOCUS: rerank lets us go one step further than Semble — once an EXACT-name match is in
// a big result set, the model almost certainly wanted that one symbol (the "locate a known symbol" query,
// the most common shape), so showing 60 rows wastes tokens on a tail it won't read. When an exact match
// exists among many results, tighten the SHOWN count to the exact matches + a small head (the rest stay in
// the "… N more (raise maxResults)" tail + the recovery tee — no silent cap). Broad/substring browses (no
// exact match) keep the full cap. search_symbol ONLY — find_references must show every site. VTS_FOCUS=0 off.
const focusEnabled = () => { const v = process.env.VTS_FOCUS; return v === undefined || v === "" ? true : !/^(0|false|off|no)$/i.test(v); };
export function focusCap(query, syms, max) {
  const FOCUS_N = envInt("VTS_FOCUS_N", 6);
  if (!focusEnabled() || !Array.isArray(syms) || syms.length <= FOCUS_N) return max;
  const ql = String(query || "").toLowerCase();
  const exact = syms.filter((s) => (s && s.name ? s.name.toLowerCase() : "") === ql).length;
  return exact >= 1 ? Math.min(max, Math.max(exact, FOCUS_N)) : max; // exact target → show it + a few, not the long tail
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
// Factor the longest common DIRECTORY prefix out of a list of absolute-path-led lines, printed once as
// `under <prefix>/` with relative tails — the same token-saver fmtLocations uses, now applied to the pure
// path list (find_files) and the text-match list (search_text), which previously repeated the full absolute
// path on EVERY row (a real benchmark-found drag: find_files ~32%, search_text ~54% reduction; the repeated
// root prefix was most of the cost). Safe on a `path:line: text` line too — commonDirPrefix splits on "/" and
// never counts the last segment (the filename + `:line: text`), so only the shared DIR is factored; the full
// path stays recoverable as `<prefix>/<tail>`. VTS_COMPACT_RESULTS=0 restores the classic per-row shape.
function factorCommonPrefix(lines) {
  if (!compactResults() || lines.length < 2) return lines.join("\n");
  const prefix = commonDirPrefix(lines);
  if (!prefix) return lines.join("\n");
  return `under ${prefix}/\n` + lines.map((l) => "  " + l.slice(prefix.length + 1)).join("\n");
}
// ── Completeness certificate — the semantic guarantee grep cannot give ──────────────────────────────────
// Every result-bearing tool states whether the answer set is COMPLETE (the engine/scan covered everything),
// PARTIAL (capped — more exist and the remainder is KNOWN and recoverable via the cap/tee), or INCONCLUSIVE
// (a bounded walk hit a time/scan limit before finishing, so the remainder is UNKNOWN — a real 0 and an
// unreached-0 are indistinguishable). The crucial, paper-load-bearing distinction is PARTIAL vs INCONCLUSIVE:
// grep returns a flat match list with no signal about either; a semantic index can certify COMPLETE, and a
// bounded lexical walk can at least honestly flag INCONCLUSIVE instead of presenting a possibly-truncated 0 as
// fact. The tag is additive (the human-facing notes elsewhere stay) and machine-readable. VTS_CERT=0 hides it.
function certOn() { return !/^(0|false|off|no)$/i.test(String(process.env.VTS_CERT ?? "1")); }
// truncated: falsy | "cap" | "time" | "scan". semantic=true → a language-server index answered (authoritative
// 0); false → a bounded lexical scan. shown/total optional (total null = unknown upper bound).
function completenessCert({ shown = 0, total = null, truncated = null, semantic = false, scoped = false, syntactic = false, fuzzy = false, section = false } = {}) {
  if (!certOn()) return "";
  // ONE label names BOTH which precision RUNG answered AND how complete the set is (the unified precision
  // label). The four ladder rungs — exact (semantic LSP) / syntactic (tree-sitter) / fuzzy (concept dictionary)
  // / section (structure tier) — each carry their own honesty caveat; a capped/timed-out result falls through
  // to the PARTIAL / INCONCLUSIVE coverage states instead. So the agent always sees exactly which rung it's on.
  //
  // SECTION rung — the structure tier (docs/config) addressed by heading/selector/rule. Exact text spans, but
  // document structure, not semantic code analysis.
  if (section) {
    return `\n[completeness: SECTION rung — ${shown} section(s) by heading/selector (exact text spans, not semantic code).]`;
  }
  // FUZZY rung — the concept dictionary mined from the repo's own naming (no embeddings). Related, not exact.
  if (fuzzy && truncated !== "cap" && !(total != null && shown < total)) {
    return `\n[completeness: FUZZY rung — ${shown} decl(s) by naming co-occurrence (no embeddings); climb to find_references/goto_definition for ground truth.]`;
  }
  // SYNTACTIC rung — tree-sitter / committed index finds DECLARATIONS without a toolchain, but does not resolve
  // references, overloads, or types — so even a "complete" syntactic answer is not the semantic certainty the LSP gives.
  if (syntactic && truncated !== "cap" && !(total != null && shown < total)) {
    return `\n[completeness: SYNTACTIC rung — ${shown} decl(s), zero setup; locates decls, not refs/overloads/types. Install a language server (or compile_commands.json) for semantic certainty.]`;
  }
  // When an indexing scope is active, a semantic COMPLETE (or authoritative 0) is complete WITHIN THE SCOPE,
  // not across the whole project — qualify it so the agent doesn't read it as project-wide coverage.
  const within = scoped ? " within the configured indexing scope (widen/unset for full coverage)" : "";
  // INCONCLUSIVE walks are where AUTO-SCOPE pays off: a bounded scan on a big tree is exactly the case a scoped
  // index fixes, so the advisory is actionable (the concrete `vts setup --scope` + `vts preindex` commands).
  if (truncated === "time" || truncated === "scan") {
    const how = truncated === "time" ? "time-boxed" : "scan-limited";
    return `\n[completeness: INCONCLUSIVE — bounded ${how} walk didn't cover the tree (a 0 may be incomplete); scope it (vts setup --scope <module>; vts preindex) or certify with search_symbol/find_references.]`;
  }
  if (truncated === "index") {
    return `\n[completeness: INCONCLUSIVE — indexed/open files only, so a not-yet-indexed file can be missed (not an authoritative 0); scope a big tree (vts setup --scope <module>; vts preindex).]`;
  }
  if (truncated === "cap" || (total != null && shown < total)) {
    const more = total != null ? `${shown} of ${total}` : `the top ${shown}`;
    return `\n[completeness: PARTIAL — showing ${more}; remainder known + recoverable (raise the cap or read the tee file).]`;
  }
  return `\n[completeness: ${semantic ? "EXACT rung, COMPLETE" : "COMPLETE"} — ${semantic ? "language-server index" : "bounded scan"}, every match${within} (${shown}).]`;
}
export { completenessCert };
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
// detail=file|dir summary for find_references — a "blast-radius" view: group dependents by file (or dir),
// sort by ref-count desc, factor the common prefix. Collapses a long ref list into "who depends on this and
// how heavily" in one capped block (the per-line list is what you get with detail omitted). Pure reuse of the
// refs we already have — no extra analysis. Token win on a hot symbol with dozens of call sites.
function fmtRefSummary(locList, level, max) {
  const by = new Map();
  for (const l of locList) {
    const f = fromUri(l.uri).replace(/\\/g, "/");
    const k = level === "dir" ? (f.replace(/\/[^/]*$/, "") || f) : f;
    by.set(k, (by.get(k) || 0) + 1);
  }
  const rows = [...by.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const keys = rows.map((r) => r[0]);
  const factor = compactResults() && keys.length > 1 ? commonDirPrefix(keys) : "";
  const shown = rows.slice(0, max);
  const more = rows.length - shown.length;
  const head = `${locList.length} reference(s) across ${by.size} ${level === "dir" ? "dir" : "file"}(s), most-referenced first`;
  const body = shown.map(([k, n]) => `  ${factor ? k.slice(factor.length + 1) : k} (${n})`).join("\n");
  return head + (factor ? ` under ${factor}/` : "") + ":\n" + body + (more > 0 ? `\n… ${more} more ${level === "dir" ? "dir" : "file"}(s).` : "");
}
export { compactLocationLines, commonDirPrefix, fmtRefSummary };
// ─── call-hierarchy tracing (trace_calls) ───────────────────────────────────
// Walk the LSP call graph (callHierarchy/incoming|outgoingCalls) to a bounded depth and node count, then
// token-cap to an indented `file:line` tree. The official engine resolves the edges (real semantic call
// resolution — overloads, virtual dispatch — not a tree-sitter approximation); we only traverse + format.
// A CallHierarchyItem's selectionRange is the NAME (better file:line than the whole-body range).
const callItemLoc = (item) => locLine(item.uri, item.selectionRange || item.range || { start: { line: 0 } });
const traceKey = (item) => canonFsPath(item.uri) + ":" + (((item.selectionRange || item.range || {}).start || {}).line ?? "?");
// DFS from `item` following callers (incoming) or callees (outgoing). `visited` breaks cycles AND prevents
// re-expanding a shared node; `acc` collects {depth,item,cycle} flattened (formatted by indent); `capRef.cap`
// bounds total nodes (a hot function can have a huge call graph — no silent unbounded walk).
async function traceFrom(c, item, dir, depth, depthMax, visited, acc, capRef) {
  if (depth >= depthMax) return;
  let calls;
  try { calls = dir === "callees" ? await c.outgoingCalls(item) : await c.incomingCalls(item); } catch { calls = []; }
  for (const call of (calls || []).filter(Boolean)) {
    if (acc.length >= capRef.cap) { capRef.truncated = true; return; }
    const next = dir === "callees" ? call.to : call.from;
    if (!next || !next.uri) continue;
    const k = traceKey(next);
    const cycle = visited.has(k);
    acc.push({ depth: depth + 1, item: next, cycle });
    if (cycle) continue;              // already seen → record the edge but don't re-expand (cycle/dedup guard)
    visited.add(k);
    await traceFrom(c, next, dir, depth + 1, depthMax, visited, acc, capRef);
  }
}
// prepareCallHierarchy right after a cold didOpen can return [] before the server finishes analyzing the
// file (live-seen on a freshly-spawned tsserver). Retry with backoff for a short window so a cold call graph
// isn't a spurious "no anchor". Cap via VTS_CALLHIER_WAIT_MS. Returns the items (possibly empty after the cap).
// Which REPOSITORY a file belongs to — walk up to the nearest project marker (findProjectRoot) and label it
// by that root's basename, so the viz can group/color nodes by repo ("which repo is this from?"). A file with
// no enclosing project (system header, etc.) → "external". Cached per directory (the fs walk is the cost).
const _repoCache = new Map();
function repoLabelFor(file) {
  try {
    const dir = path.dirname(String(file));
    if (_repoCache.has(dir)) return _repoCache.get(dir);
    const root = findProjectRoot(String(file)) || findProjectRoot(dir);
    const label = root ? path.basename(root) : "external";
    _repoCache.set(dir, label);
    return label;
  } catch { return "external"; }
}
// Anchor a call-hierarchy query ON the symbol NAME. workspace/symbol's location.range.start can land on a
// leading keyword (e.g. `async`/`function`) rather than the identifier — textDocument/references tolerates
// that, but textDocument/prepareCallHierarchy returns [] unless the position is on the name (live-found:
// `async function X` traced empty while a sync `function Y` worked). Read the resolved line, find the name's
// column, and anchor a char INTO it; fall back to the given char if the line/name can't be read.
export function anchorOnName(file, line, name, fallbackChar) {
  try {
    const ln = (fs.readFileSync(file, "utf8").split(/\r?\n/)[line] || "");
    const i = name ? ln.indexOf(String(name)) : -1;
    if (i >= 0) return i + Math.min(1, String(name).length); // one char inside the identifier
  } catch { /* unreadable → fallback */ }
  return fallbackChar;
}
async function prepareCallHierReady(c, p, line, ch, capMs = envInt("VTS_CALLHIER_WAIT_MS", 8000)) {
  let items = (await c.prepareCallHierarchy(p, line, ch)) || [];
  if (items.length) { c.callHierWarm = true; return items; }
  // Once this client has EVER produced a hierarchy item, the index is proven warm → an empty result is a
  // GENUINE "not callable here" (a variable, a non-function position), not index lag. Don't burn the retry
  // window (live-found: tracing a `const` or an off-function position waited the full 8s before failing).
  if (c.callHierWarm) return items;
  const t0 = Date.now(); let delay = 400;
  while (Date.now() - t0 < capMs) {
    await sleep(Math.min(delay, Math.max(0, capMs - (Date.now() - t0))));
    items = (await c.prepareCallHierarchy(p, line, ch)) || [];
    if (items.length) { c.callHierWarm = true; return items; }
    delay = Math.min(Math.round(delay * 1.5), 2000);
  }
  return items;
}
// LSP SymbolKinds that can anchor a call hierarchy (have callers/callees): method, ctor, func — plus the
// type kinds whose ctor is the hook (class/interface/struct). A variable/const/field/property/module/etc.
// can never produce a hierarchy item, so a by-name trace of one fails FAST with a clear reason instead of
// burning the retry. (kind from workspace/symbol; null → allow and let prepareCallHierarchy decide.)
const CALLABLE_KIND = new Set([5, 6, 9, 11, 12, 23]);
const isCallableKind = (k) => k == null || CALLABLE_KIND.has(k);
// ON-DEMAND call graph for the dashboard (the comparable-to-codebase-memory-mcp "call graph" view, but the
// official-LSP way: NO persistent semantic graph DB — we resolve a focused symbol and walk LSP callHierarchy
// live, returning a {nodes,links} object shaped like the include-graph so the 3D viz renders it the same).
// direction: callers | callees | both (default). Bounded by depth (VTS_TRACE_MAX_DEPTH) + node cap
// (VTS_TRACE_MAX_NODES). Returns { focus, direction, depth, nodes:[{id,label,file,line,kind,weight,focus}],
// links:[{source,target}], truncated, backend } or { error, nodes:[], links:[] }. Exported for serve.js + eval.
export async function buildCallGraph(a = {}) {
  const root = resolveRoot(a);
  const backendName = preferBackend(a.backend, backendForPath(a.path), BACKEND) || pickBackend(root);
  if (!backendName) return { error: "no language-server backend resolved for this root", nodes: [], links: [] };
  const c = await getClient(root, backendName);
  const dirRaw = String(a.direction || "both").toLowerCase();
  const dirs = (dirRaw === "callers" || dirRaw === "incoming") ? ["callers"]
    : (dirRaw === "callees" || dirRaw === "outgoing") ? ["callees"] : ["callers", "callees"];
  const depthMax = Math.max(1, Math.min(Number(a.depth) || 2, envInt("VTS_TRACE_MAX_DEPTH", 5)));
  const nodeCap = Math.min(Number(a.maxResults) || MAX_RESULTS, envInt("VTS_TRACE_MAX_NODES", 80));
  let pos, focusLabel = String(a.symbol || "");
  if (a.symbol) {
    const persisted = backendName === "clangd" && hasPersistedIndex(root);
    const syms = await symbolReady(c, String(a.symbol), persisted, envInt("VTS_CLANGD_PERSISTED_WAIT_MS", 60000));
    const want = String(a.symbol);
    const pick = syms.slice().sort((x, y) => (x.name === want ? 0 : 1) - (y.name === want ? 0 : 1))[0];
    if (!pick) return { error: `no indexed declaration for "${want}"`, focus: want, nodes: [], links: [] };
    if (!isCallableKind(pick.kind)) return { error: `"${want}" is a ${SYMBOL_KIND[pick.kind] || "symbol"}, not a function/method/class — call hierarchy needs a callable symbol.`, focus: want, nodes: [], links: [] };
    pos = { path: fromUri(pick.location.uri), line: pick.location.range.start.line, character: pick.location.range.start.character };
    focusLabel = pick.name;
  } else if (a.path && a.line != null && a.character != null) {
    pos = { path: String(a.path), line: Number(a.line), character: Number(a.character) };
  } else { return { error: "needs `symbol` (a name) or `path`+`line`+`character`", nodes: [], links: [] }; }
  if (a.symbol) pos.character = anchorOnName(pos.path, pos.line, String(a.symbol), pos.character); // anchor ON the name for callHierarchy
  c.didOpen(pos.path, langIdForPath(pos.path, backendName));
  const items = (await prepareCallHierReady(c, pos.path, pos.line, pos.character)).filter(Boolean);
  if (!items.length) return { error: "no call-hierarchy anchor at the symbol (point at a function/method, or the backend may lack callHierarchy)", focus: focusLabel, nodes: [], links: [] };
  const nodeMap = new Map();
  const linkMap = new Map(); const links = [];
  const addNode = (item, isFocus) => {
    const k = traceKey(item);
    if (!nodeMap.has(k)) { const file = fromUri(item.uri).replace(/\\/g, "/"); nodeMap.set(k, { id: k, label: item.name, file, line: (((item.selectionRange || item.range || {}).start || {}).line || 0) + 1, kind: SYMBOL_KIND[item.kind] || "sym", repo: repoLabelFor(file), weight: 0, calls: 0, calledBy: 0, focus: !!isFocus }); }
    else if (isFocus) nodeMap.get(k).focus = true;
    return k;
  };
  const addLink = (s, t, count) => { if (s === t) return; const key = s + " " + t; const e = linkMap.get(key); if (e) { e.count += count; } else { const l = { source: s, target: t, count }; linkMap.set(key, l); links.push(l); } };
  const root0 = items[0];
  addNode(root0, true);
  const capRef = { n: 1, truncated: false }; // root counts as 1 node
  const collect = async (item, dir, depth) => {
    if (depth >= depthMax) return;
    let calls; try { calls = dir === "callees" ? await c.outgoingCalls(item) : await c.incomingCalls(item); } catch { calls = []; }
    const fromKey = traceKey(item);
    for (const call of (calls || []).filter(Boolean)) {
      if (capRef.n >= nodeCap) { capRef.truncated = true; break; }
      const nx = dir === "callees" ? call.to : call.from;
      if (!nx || !nx.uri) continue;
      const sites = Math.max(1, Array.isArray(call.fromRanges) ? call.fromRanges.length : 1); // # of call sites on this edge
      const seen = nodeMap.has(traceKey(nx));
      const k = addNode(nx, false);
      if (dir === "callees") addLink(fromKey, k, sites); else addLink(k, fromKey, sites); // edge always points caller→callee
      if (!seen) { capRef.n++; await collect(nx, dir, depth + 1); } // expand each node once
    }
  };
  for (const d of dirs) await collect(root0, d, 0);
  // per-node call counts: `calls` = call sites it makes (out), `calledBy` = call sites targeting it (in).
  // weight = total call sites touching the node (call-weighted degree) → heat ramp = "how busy / hot".
  for (const l of links) { const s = nodeMap.get(l.source), t = nodeMap.get(l.target); if (s) s.calls += l.count; if (t) t.calledBy += l.count; }
  for (const n of nodeMap.values()) n.weight = n.calls + n.calledBy;
  const nodes = [...nodeMap.values()];
  try { recordQueryResults(root, nodes.map((n) => n.file)); } catch { /* best-effort */ }
  const totalCallSites = links.reduce((a, l) => a + l.count, 0); // at-a-glance "how much is called" total
  return { root, focus: focusLabel, direction: dirRaw, depth: depthMax, nodes, links, totalCallSites, truncated: capRef.truncated, backend: backendName };
}
// Symbol-name autocomplete for the dashboard's call-graph search box — `q` (a prefix) → matching declaration
// NAMES via the LSP workspace/symbol index (the same source search_symbol uses). Deduped by name+file, capped,
// function/method/class-ish first (the useful call-graph anchors). Exported for serve.js (/symbols) + eval.
export async function listSymbols(a = {}) {
  const root = resolveRoot(a);
  const backendName = preferBackend(a.backend, backendForPath(a.path), BACKEND) || pickBackend(root);
  if (!backendName) return { error: "no language-server backend resolved", symbols: [] };
  const c = await getClient(root, backendName);
  const q = String(a.q || "");
  const persisted = backendName === "clangd" && hasPersistedIndex(root);
  const syms = (await symbolReady(c, q, persisted, envInt("VTS_CLANGD_PERSISTED_WAIT_MS", 60000))) || [];
  const max = Math.min(Number(a.maxResults) || 40, 200);
  // call-graph anchors are functions/methods/classes/ctors — rank those first so the autocomplete is useful.
  const CALLABLE = new Set([6, 9, 12, 5, 11, 23]); // method, ctor, func, class, interface, struct
  const ranked = syms.slice().sort((x, y) => (CALLABLE.has(x.kind) ? 0 : 1) - (CALLABLE.has(y.kind) ? 0 : 1));
  const seen = new Set(); const out = [];
  for (const s of ranked) {
    const file = fromUri(s.location.uri).replace(/\\/g, "/");
    const k = s.name + "|" + file;
    if (seen.has(k)) continue; seen.add(k);
    out.push({ name: s.name, kind: SYMBOL_KIND[s.kind] || "sym", file, line: ((s.location.range.start || {}).line || 0) + 1 });
    if (out.length >= max) break;
  }
  return { backend: backendName, symbols: out };
}
// hover MarkupContent → a few plaintext lines (signature/type), no fenced code, no walls of text.
// LSP DiagnosticSeverity. Diagnostics (compiler/linter errors+warnings) as a token-capped
// `file:line:col severity [code]: message` list, sorted error→hint then by line, with a count summary —
// the compact alternative to reading raw build/compiler output. Messages are trimmed (trimMatchLine).
const DIAG_SEV = { 1: "error", 2: "warning", 3: "info", 4: "hint" };
function fmtDiagnostics(diags, file, max) {
  const arr = Array.isArray(diags) ? diags : [];
  if (!arr.length) return "  (no diagnostics — clean)";
  const fileRel = file ? String(file).replace(/\\/g, "/") : null; // null → multi-file (each d._file), e.g. directory scope
  const lineOf = (d) => (d.range && d.range.start ? d.range.start.line : 0);
  const sorted = arr.slice().sort((a, b) => (a.severity || 9) - (b.severity || 9) || String(a._file || "").localeCompare(String(b._file || "")) || (lineOf(a) - lineOf(b)));
  const shown = sorted.slice(0, max);
  const body = shown.map((d) => {
    const ln = lineOf(d) + 1;
    const col = (d.range && d.range.start ? d.range.start.character : 0) + 1;
    const sev = DIAG_SEV[d.severity] || "diag";
    const code = d.code !== undefined && d.code !== null && d.code !== "" ? ` [${d.code}]` : "";
    return `  ${(fileRel || d._file || "?")}:${ln}:${col} ${sev}${code}: ${trimMatchLine(String(d.message || "").replace(/\s+/g, " "))}`;
  }).join("\n");
  const counts = {};
  for (const d of arr) { const s = DIAG_SEV[d.severity] || "diag"; counts[s] = (counts[s] || 0) + 1; }
  const summary = ["error", "warning", "info", "hint", "diag"].filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`).join(", ");
  const more = arr.length - shown.length;
  return `${summary}:\n` + body + (more > 0 ? `\n… ${more} more.` : "");
}
function fmtHover(h) {
  if (!h || !h.contents) return "(no hover info)";
  let c = h.contents;
  if (Array.isArray(c)) c = c.map((x) => (typeof x === "string" ? x : x.value || "")).join("\n");
  else if (typeof c === "object") c = c.value || "";
  c = String(c).replace(/```[a-z]*\n?/gi, "").trim();
  // Cap BOTH dimensions: ≤8 lines AND ≤200 chars/line (trimMatchLine). The 8-line cap alone left a
  // pathological single huge line uncapped — a complex TS/C++ hover can be one multi-thousand-char type
  // signature/union. Trim each line so "a few lines, no walls" holds even then.
  const lines = c.split(/\r?\n/).filter(Boolean).slice(0, 8).map(trimMatchLine);
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
function fmtDocSymbols(syms, max) {
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
      // Single-file outline → the path is constant (named once in the caller's "outline of <file>" header),
      // so emit only the line number, not the full path repeated on every row (was ~path×rows of pure waste).
      rows.push(`${SYMBOL_KIND[s.kind] || `k${s.kind}`} ${parent ? parent + "::" : ""}${s.name}  :${ln}`);
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
// Bounded walk collecting CODE files under a root (for project-wide diagnostics: didOpen each so the
// server parses + publishes). Same SKIP_DIRS + time/scan box as findFilesUnder so a giant tree can't hang
// it. `.truncated` flags a capped/aborted sweep (no silent caps).
const DIAG_CODE_RE = /\.(c|cc|cxx|cpp|h|hpp|hh|inl|ipp|tpp|cs|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi)$/i;
function codeFilesUnder(root, max) {
  const out = []; const stack = [root]; let scanned = 0; const t0 = Date.now(); let timedOut = false;
  while (stack.length && out.length < max && scanned < 300000) {
    if (Date.now() - t0 >= 4000) { timedOut = true; break; }
    const dir = stack.pop();
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!skipDir(e.name)) stack.push(p); }
      else { scanned++; if (DIAG_CODE_RE.test(e.name)) { out.push(p.replace(/\\/g, "/")); if (out.length >= max) break; } }
    }
  }
  if (out.length >= max && stack.length) out.truncated = "cap";
  else if (timedOut) out.truncated = "time";
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
// CONCEPT (lexical-fuzzy) SEARCH — the charter-pure slice of the "find code that does X" gap. A true
// semantic search needs embeddings (a second semantic source + a storage/transmission surface = the cbm/
// Semble reject we DON'T adopt). But a MULTI-TERM query can be served lexically with no index and no
// transmission: gather lines matching ANY term, then RANK by how many DISTINCT terms each line carries
// (BM25-style coverage). It collapses the several greps a concept hunt would take into one ranked answer.
// It is NOT synonym-aware — clearly labeled "lexical, ranked by term coverage". VTS_CONCEPT=0 disables.
// conceptTerms(q) returns the term list when q LOOKS conceptual (≥2 whitespace tokens, each an alpha-led
// word ≥3 chars, no regex metacharacters), else null (so a single token / a regex stays a literal scan).
export function conceptTerms(q) {
  const v = process.env.VTS_CONCEPT;
  if (v !== undefined && v !== "" && /^(0|false|off|no)$/i.test(v)) return null;
  const s = String(q || "");
  if (/[.*+?^${}()|[\]\\<>:]/.test(s)) return null; // a regex / scope / template hunt → not a prose concept query
  const toks = s.split(/\s+/).filter(Boolean);
  if (toks.length < 2 || toks.length > 8) return null;
  if (!toks.every((t) => /^[A-Za-z][A-Za-z0-9_]{2,}$/.test(t))) return null; // alpha-led words only
  return [...new Set(toks.map((t) => t.toLowerCase()))];
}
// Rank lines by distinct-term coverage. Reuses scanTextUnder with an OR-regex to gather a wide pool, then
// sorts by how many of the query's terms appear on each line (a line hitting all terms is most on-concept).
function conceptScan(root, terms, max, accept) {
  const safe = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pool = scanTextUnder(root, safe.join("|"), Math.min(Math.max(max * 8, 80), 600), accept);
  const scored = pool
    .map((line) => { const low = line.toLowerCase(); return { line, cov: terms.filter((t) => low.includes(t)).length }; })
    .sort((a, b) => b.cov - a.cov); // most distinct terms first; stable within equal coverage (original walk order)
  const out = scored.slice(0, max).map((x) => x.line);
  out.truncated = pool.truncated || (scored.length > max ? "cap" : undefined);
  return out;
}
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
// SYNTACTIC fallback tier — between the semantic LSP and the literal text scan. When no LSP backend resolves
// (or it answers from open files and missed the symbol), this returns real DECLARATIONS for 36 languages with
// zero project setup: first a committed `.vts-index/symbols.jsonl` (instant, team-shareable), else a live
// tree-sitter AST walk. Strictly better than the literal `grep <name>` it precedes — that returns every usage
// LINE and can't tell a class from a comment; this returns the decls, ranked exact-before-substring.
// Returns { lines: ["file:line: kind name", …], source, truncated, total } or null when neither tier hits.
// Best-effort: any failure returns null so the caller still falls through to the literal scan.
async function syntacticSymbols(root, q, max) {
  try {
    let hits = searchSymIndex(root, String(q), { max });
    let source = hits && hits.length ? "committed index (.vts-index)" : null;
    if (!source) {
      hits = await tsSearchSymbols(root, String(q), { max, skipDir });
      source = hits && hits.length ? "tree-sitter (syntactic)" : null;
    }
    if (!source) return null;
    const lines = hits.map((h) => `${h.file}:${h.line}: ${h.kind} ${h.name}`);
    return { lines, source, truncated: hits.truncated || null, total: hits.length };
  } catch { return null; }
}
// CONCEPT INDEX (fuzzy retrieval, approach B): mine a local concept dictionary from the repo's OWN identifier+
// comment co-occurrence (server/concept.js) so a fuzzy "how does the auth flow work" query finds related
// declarations WITHOUT embeddings — nothing transmitted, output still token-capped file:line. Built from the
// same tree-sitter pass as the syntactic tier (tsFileDeclDocs = decl + its leading docstring). Cached per root
// for the process lifetime (a big tree is walked once; restart/re-setup to refresh). Bounded walk (time+file).
const _conceptCache = new Map(); // root → { model, symbols } | building promise
async function conceptIndexFor(root) {
  if (_conceptCache.has(root)) return _conceptCache.get(root);
  const build = (async () => {
    const symbols = [], units = [];
    const dirs = scopeDirsFor(root);
    const within = dirs.length ? (p) => inScope(p, dirs) : () => true;
    const stack = [root]; const t0 = Date.now(); let files = 0;
    const budget = envInt("VTS_CONCEPT_BUILD_MS", 15000), fileCap = envInt("VTS_CONCEPT_FILE_CAP", 6000);
    const fileSpecs = new Map(), byBase = new Map(); // for the within-repo import graph
    while (stack.length) {
      if (Date.now() - t0 >= budget || files >= fileCap) break;
      const dir = stack.pop();
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!skipDir(e.name)) stack.push(p); continue; }
        if (!tsSupports(e.name) || !within(p)) continue;
        if (files >= fileCap) break;
        files++;
        let decls; try { decls = await tsFileDeclDocs(p); } catch { continue; }
        const fp = p.replace(/\\/g, "/");
        // path tokens (the dir + filename, ext stripped) — a free locality signal shared by every decl in
        // the file: a symbol under auth/session.ts scores for "auth session" even if its name doesn't say so.
        const pt = tokenize(path.relative(root, p).replace(/\.[^./]+$/, ""));
        // import-graph inputs: this file's basename + the basenames it imports (resolved against the corpus).
        const base = e.name.replace(/\.[^.]+$/, "").toLowerCase();
        if (!byBase.has(base)) byBase.set(base, []);
        byBase.get(base).push(fp);
        try { fileSpecs.set(fp, importSpecifiers(fs.readFileSync(p, "utf8"), e.name.split(".").pop())); } catch { /* ignore */ }
        for (const d of decls) {
          const nt = splitIdent(d.name), dt = tokenize(d.doc);
          units.push([...nt, ...dt]);
          symbols.push({ name: d.name, kind: d.kind, file: fp, line: d.line, nt, dt, pt });
        }
      }
    }
    // Within-repo import graph: link a file to every corpus file whose basename it imports (both directions).
    // A symbol in a file ADJACENT to a strongly-matching file is structurally related even with no shared token.
    const neighbors = new Map();
    const link = (a, b) => { if (a === b) return; if (!neighbors.has(a)) neighbors.set(a, new Set()); neighbors.get(a).add(b); };
    for (const [f, specs] of fileSpecs) for (const s of specs) for (const g of byBase.get(s) || []) { link(f, g); link(g, f); }
    // GIT CO-CHANGE neighbours (a 2nd structural signal, embedding-free): files frequently committed together
    // are semantically related even with no shared token/import — the local proxy for what vectors cluster.
    // Built once per root (this index is cached). Off / non-git → empty map (the boost then does nothing).
    let cochange = new Map();
    if (!/^(0|false|off|no)$/i.test(String(process.env.VTS_CONCEPT_COCHANGE ?? "1"))) {
      try {
        cochange = cochangeNeighbors(root, {
          maxCommits: envInt("VTS_COCHANGE_MAX_COMMITS", 500),
          maxFilesPerCommit: envInt("VTS_COCHANGE_MAX_FILES_PER_COMMIT", 30),
          minWeight: envInt("VTS_COCHANGE_MIN_WEIGHT", 2),
        });
      } catch { cochange = new Map(); }
    }
    return { model: buildConceptModel(units), symbols, files, neighbors, cochange };
  })();
  _conceptCache.set(root, build);
  const res = await build;
  _conceptCache.set(root, res); // replace the promise with the resolved value
  return res;
}
// Counterfactual shadow measurement (opt-in VTS_COUNTERFACTUAL=1): run a LOCAL literal grep for the same
// symbol NAME, compare what grep WOULD have returned (tokens + match positions) against the vts answer, and
// record the comparison. The grep output is DISCARDED — only the numbers reach the local ledger, never the
// model (zero transmission, zero added model cost). Bounded by scanTextUnder's 4s time-box; any failure is
// swallowed so a measurement never breaks a query. `locs` items each carry {uri, range}. See
// server/counterfactual.js for the construct-validity rationale.
export function maybeCounterfactual(tool, name, root, locs, vtsBody) {
  if (!counterfactualOn() || !name) return;
  try {
    const grepHits = scanTextUnder(root, String(name), 5000);
    const grepTok = rawTokensOf(grepHits.join("\n"));
    const vtsTok = tok(vtsBody);
    const vtsKeys = (locs || []).map((l) => locKey(l.uri, l.range)).filter(Boolean);
    const grepKeys = grepHits.map(grepKey).filter(Boolean);
    // EDGE CASE (UE-tree dogfood): on a giant tree the shadow grep itself hits its cap or 4s time-box, so the
    // grep BASELINE is truncated. Comparing the vts set against a truncated baseline is unreliable — the two
    // can look "disjoint" merely because grep only reached other directories. So when the baseline truncated,
    // do NOT compute a set relation (record "baseline-truncated"); the token figure is then a LOWER bound on
    // what a complete grep would have spent, flagged as such in the report.
    const truncatedBaseline = !!grepHits.truncated;
    const relation = truncatedBaseline ? "baseline-truncated" : relateSets(vtsKeys, grepKeys);
    recordCounterfactual(tool, { grepTok, vtsTok, relation, truncatedBaseline });
  } catch { /* best-effort — never break a query for a measurement */ }
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

// STRUCTURE tier (textstruct.js): a prose/config file (markdown/asciidoc/rst/toml/yaml/json/txt) has a SECTION
// tree, not a language server. Route the same NAME-addressed tools to its section spans so a section is
// outline-able, readable, and editable BY ITS HEADING/KEY — no backend, no whole-file Read. The token-safer
// move, extended from code to documents. Reuses the symbol-edit splice machinery via a synthesised range.
const STRUCT_TOOLS = new Set(["document_symbols", "read_symbol", "replace_symbol_body", "insert_symbol", "safe_delete"]);
async function structTool(name, a, root, { finishOut, err, symbolEditResult }) {
  const file = (path.isAbsolute(String(a.path)) ? String(a.path) : path.join(root, String(a.path))).replace(/\\/g, "/");
  let text; try { text = fs.readFileSync(file, "utf8"); } catch { return err(`structure: cannot read ${a.path}.`); }
  const max = Number(a.maxResults) || MAX_RESULTS;
  // Compute the outline once. For HTML the embedded `<script>`/`<style>` JS/CSS decls are REFINED to exact
  // tree-sitter ranges (htmlEmbeddedDecls) when the grammars are present, else the heuristic brace-scan stands.
  const o = await structOutlineInjected(file, text, htmlEmbeddedDecls);
  if (name === "document_symbols") {
    if (!o.length) return finishOut([], `No sections found in ${file} (no headings/keys recognised).`);
    try { recordQueryResults(root, [file]); } catch { /* best-effort */ }
    // Baseline = the WHOLE FILE you'd otherwise Read to see its structure (avoided-read, like read_symbol),
    // not the tiny outline objects — else document_symbols banks ~0 despite saving a full-file Read.
    return finishOut(text, `outline of ${file} — ${o.length} section(s) (structure tier, no language server):\n` + fmtOutline(o, max) + completenessCert({ shown: o.length, section: true }));
  }
  // the remaining tools target one named section (accept `symbol` — reuses the symbol tools — or `section`).
  const title = a.symbol != null ? a.symbol : a.section;
  if (title == null) return err(`${name} on a text file needs \`symbol\` (the section heading/key to target). Run document_symbols on it first to see the sections.`);
  const sec = resolveInOutline(o, title, { line: a.line != null ? Number(a.line) + 1 : null });
  if (!sec) return err(`No section titled "${title}" in ${file}. Run document_symbols to list the headings (match is exact-then-substring; pass line= to disambiguate repeats).`);
  const lines = text.split(/\r?\n/);
  // synthesise an LSP-shaped range that spans whole section lines: start of the heading line → start of the
  // line AFTER the section's last line (so a replace/delete swaps the lines cleanly; endLine is 1-based).
  const start = { line: sec.line - 1, character: 0 };
  const endExcl = { line: sec.endLine, character: 0 };
  const ds = { range: { start, end: endExcl }, selectionRange: { start, end: { line: sec.line - 1, character: lines[sec.line - 1]?.length || 0 } }, name: sec.title, kind: 0 };
  if (name === "read_symbol") {
    const cap = envInt("VTS_SYMBOL_MAX_LINES", 200);
    const sigOnly = a.signatureOnly === true || a.signatureOnly === "true";
    let end = sigOnly ? sec.line : sec.endLine;
    if (end - sec.line + 1 > cap) end = sec.line + cap - 1;
    const body = lines.slice(sec.line - 1, end).join("\n");
    const omitted = sec.endLine - end;
    const note = omitted > 0 ? `\n… ${omitted} more line(s)${sigOnly ? " (heading only — omit signatureOnly for the section)" : ` — raise VTS_SYMBOL_MAX_LINES (now ${cap})`}.` : "";
    try { recordQueryResults(root, [file]); } catch { /* best-effort */ }
    return finishOut(text, `section "${sec.title}" @ ${file}:${sec.line}-${sec.endLine} (structure tier):\n` + body + note + completenessCert({ shown: 1, section: true }));
  }
  const apply = a.apply === true || a.apply === "true";
  if (name === "replace_symbol_body") {
    if (a.body == null) return err("replace_symbol_body needs `body` (the new full text for the section, including its heading).");
    let nt = String(a.body); if (!nt.endsWith("\n")) nt += "\n";
    try { recordEditEvent("symbol-edit"); } catch { /* best-effort */ }
    return symbolEditResult(file, { range: ds.range, newText: nt }, apply, `replace_symbol_body section "${sec.title}"`, ds);
  }
  if (name === "insert_symbol") {
    if (a.text == null) return err("insert_symbol needs `text` (the new section to insert).");
    const before = String(a.position || "after").toLowerCase() === "before";
    const at = before ? start : endExcl;
    let nt = String(a.text); if (!nt.endsWith("\n")) nt += "\n";
    try { recordEditEvent("symbol-edit"); } catch { /* best-effort */ }
    return symbolEditResult(file, { range: { start: at, end: at }, newText: nt }, apply, `insert_symbol ${before ? "before" : "after"} section "${sec.title}"`, ds);
  }
  // safe_delete a section — no reference graph for prose, so it deletes the span (preview by default).
  try { recordEditEvent("symbol-edit"); } catch { /* best-effort */ }
  return symbolEditResult(file, { range: ds.range, newText: "" }, apply, `safe_delete section "${sec.title}" (${sec.endLine - sec.line + 1} lines)`, ds);
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
    return out(pre + body + (looksLogTarget(a) ? LOG_STEER : "") + savingsLine(rawTok, outTok, name));
  };
  // Shared preview/apply writer for the symbolic-edit tools. Preview by default (file:line span only —
  // token-light); apply=true splices the one edit and writes, reusing the rename read-only/Perforce note.
  const symbolEditResult = (file, edit, apply, headline, rawObj) => {
    const fp = file.replace(/\\/g, "/");
    const r = edit.range;
    const span = r.start.line === r.end.line ? `${fp}:${r.start.line + 1}` : `${fp}:${r.start.line + 1}-${r.end.line + 1}`;
    if (!apply) return finishOut(rawObj, `${headline} — PREVIEW at ${span}. Pass apply=true to write.`);
    const p4note = ensureWritableForEdit(file); // P4: open a read-only file for edit before writing (no-op on a writable repo)
    try { fs.writeFileSync(file, applyEditsToText(fs.readFileSync(file, "utf8"), [edit])); }
    catch (e) { return finishOut(rawObj, `${headline} — FAILED to write ${span} (${e.code || e.message}). Read-only? Check out of Perforce first (vts auto-runs \`p4 edit\` unless VTS_P4_EDIT=0 — is p4 on PATH / the file in a client?).`); }
    return finishOut(rawObj, `${headline} — APPLIED at ${span}.${p4note}`);
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
      // genCompileDb — one-stop: kick off the compile-DB generation right from setup so the user doesn't have
      // to find the separate vts_gen_compile_db tool. `true` = DRY-RUN (prints the UBT command, runs nothing);
      // "apply" = run UBT now (heavy — indexes engine headers, needs clangd ≥ 22). Reuses the gen-compile-db
      // logic verbatim (plan, out-of-tree DB, VCS guard) by dispatching to it.
      let genLine = "";
      if (a.genCompileDb) {
        try {
          const root = a.projectPath || current.projectPath || PROJECT_PATH || process.cwd();
          const apply = a.genCompileDb === "apply" || a.genCompileDb === true && (a.apply === true || a.apply === "true");
          const g = await runTool("vts_gen_compile_db", { projectPath: root, apply });
          genLine = `\n\n── compile_commands.json (${apply ? "apply" : "dry-run"}) ──\n${g.text}`;
        } catch (e) { genLine = `\n\n(compile-DB step failed: ${e.message} — run vts_gen_compile_db directly)`; }
      }
      return out((changed.length ? `Updated ${changed.join(", ")}.` : "No recognized keys.") + langLine + `\nConfig: ${CONFIG_FILE}\n${JSON.stringify(current, null, 2)}` + genLine);
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
    if (name === "vts_scope") {
      // Show / inspect the indexing scope: the biggest cold-index accelerator on a huge tree (index a subset,
      // not the whole monorepo). Read-only; set it via `vts setup --scope` (persists) or the VTS_SCOPE env.
      const root = resolveRoot(a);
      const dirs = scopeDirsFor(root);
      const lines = [`Scope for ${root}:`, `  current: ${dirs.length ? dirs.join(", ") : "(none — whole tree indexed)"}`];
      const src = resolveCdbDir(root);
      if (src && dirs.length) {
        const st = scopeStats(src, dirs);
        if (st) lines.push(`  clangd TUs: ${st.kept} of ${st.total} kept (${Math.round((100 * st.kept) / Math.max(st.total, 1))}%) → scoped compile DB at ${effectiveCdbDir(root)}`);
      } else if (src) {
        let total = 0; try { total = JSON.parse(fs.readFileSync(path.join(src, "compile_commands.json"), "utf8")).length; } catch { /* ignore */ }
        if (total) lines.push(`  clangd TUs: ${total} (whole tree — set a scope to index a subset)`);
      }
      let tops = [];
      try { tops = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules").map((e) => e.name).sort(); } catch { /* ignore */ }
      if (tops.length) lines.push(`  top-level dirs (pick a subset): ${tops.slice(0, 40).join(", ")}`);
      lines.push(`  set with: vts setup --scope "Sub1,Sub2"  (or VTS_SCOPE env), then run vts preindex.`);
      return out(lines.join("\n"));
    }
    if (name === "vts_preindex") {
      // Pre-build the index so the first real query is instant. DEFAULT = a scoped background-index warm pass
      // (no extra build step; works with the clangd everyone has). The clangd-indexer STATIC index is the
      // heavy, OPT-IN path (`static=true`): it parses every in-scope TU offline and can take TENS OF MINUTES on
      // a large scope, so it is never triggered just because the binary exists. Either way the scope is
      // honored, and clangd auto-loads an EXISTING vts-static.idx via --index-file (cheap) regardless.
      const root = resolveRoot(a);
      const backendName = a.backend || BACKEND || pickBackend(root);
      if (!backendName) return err(`No backend to pre-index. Pass backend=clangd|roslyn|typescript|pyright or ensure ${root} has a build artifact.`);
      const dirs = scopeDirsFor(root);
      const scopeNote = dirs.length ? ` (scope: ${dirs.length} dir(s))` : " (whole tree — set a scope via vts setup --scope to index a subset faster)";
      const wantStatic = a.static === true || a.static === "true";
      if (backendName === "clangd" && wantStatic) {
        if (!hasClangdIndexer()) return err(!indexerEnabled()
          ? `preindex static: clangd-indexer is DISABLED on this machine (clangdIndexer="off" / VTS_CLANGD_INDEXER=off). Re-enable with \`vts setup --clangdIndexer on\`, or omit static for the background-index warm pass.`
          : `preindex static: clangd-indexer not found. Install the full LLVM toolchain (scoop install llvm | winget install LLVM.LLVM) or set VTS_CLANGD_INDEXER_CMD. Or omit static for the background-index warm pass.`);
        const r = buildStaticIndex(root);
        if (r.error) return err(`preindex: ${r.error}`);
        const t0 = Date.now();
        try { await getClient(root, backendName); } catch { /* warm best-effort */ }
        return out(`Built STATIC clangd index${scopeNote}: ${r.tus} TU(s) → ${r.path} in ${(r.ms / 1000).toFixed(1)}s, loaded via --index-file (no background crawl wait). Warm in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
      }
      const t0 = Date.now();
      await getClient(root, backendName);
      // After a default warm pass, point at the heavier static option ONLY as a hint (with the time caveat) —
      // never auto-run it. Install advice when clangd has no indexer at all.
      const staticHint = backendName !== "clangd" ? ""
        : hasClangdIndexer()
          ? `\n(Want instant COLD starts across sessions? \`vts preindex --static\` builds a one-time monolithic --index-file via clangd-indexer — but it parses every in-scope TU and can take tens of minutes on a large scope, so run it in the background / CI. The scoped background index above is usually enough.)`
          : `\n(Optional: install the full LLVM toolchain — it bundles clangd-indexer — then \`vts preindex --static\` builds an instant-load --index-file.\n   install:  scoop install llvm   |   winget install LLVM.LLVM   |   https://github.com/llvm/llvm-project/releases  ·  or VTS_CLANGD_INDEXER_CMD=/path/to/clangd-indexer)`;
      return out(backendAdvisory(backendName, root) + `Pre-warmed ${backendName} for ${root}${scopeNote} in ${((Date.now() - t0) / 1000).toFixed(1)}s (background index persisted to .cache).` + staticHint);
    }
    if (name === "vts_index") {
      // Build / inspect the COMMITTABLE symbol index (.vts-index/symbols.jsonl) — the cold-start accelerator.
      // tree-sitter walks the scope and writes a portable, git-committable, team-shareable JSONL of every
      // declaration; a later search_symbol on a toolchain-less machine (or before clangd's index is built)
      // answers from it instantly. status=true just reports the current file; otherwise it (re)builds.
      const root = resolveRoot(a);
      if (a.status === true || a.status === "true") {
        const idx = loadSymIndex(root);
        if (!idx) return out(`No committed symbol index at ${symIndexPath(root)}. Build one: vts index  (commit .vts-index/ to share it with the team / speed cold starts).`);
        const built = idx.meta.built ? new Date(idx.meta.built).toISOString() : "unknown";
        return out(`Committed symbol index: ${symIndexPath(root)}\n  ${idx.entries.length} symbol(s) over ${idx.meta.files ?? "?"} file(s), built ${built}${idx.meta.partial ? " (PARTIAL — time-boxed; rebuild for full coverage)" : ""}.\n  Used as the instant cold-start tier for search_symbol when no language server has indexed yet.`);
      }
      if (!tsAvailable()) return err(`vts index needs the tree-sitter grammars (web-tree-sitter + tree-sitter-wasms). They install with the plugin; if missing, run \`npm install\` in the server dir.`);
      const dirs = scopeDirsFor(root);
      const within = dirs.length ? (p) => inScope(p, dirs) : undefined;
      const t0 = Date.now();
      const r = await buildSymIndex(root, { skipDir, inScope: within, now: Date.now() });
      const scopeNote = dirs.length ? ` (scope: ${dirs.length} dir(s))` : "";
      // Incremental note: how many files were reused (no re-parse) vs re-parsed this run — the cold→warm win.
      const incrNote = r.reparsed != null && (r.reused || r.reparsed) ? ` [incremental: re-parsed ${r.reparsed}, reused ${r.reused} unchanged]` : "";
      return out(`Built committable symbol index${scopeNote}: ${r.symbols} symbol(s) over ${r.files} file(s) → ${r.path} in ${((Date.now() - t0) / 1000).toFixed(1)}s${incrNote}.${r.partial ? " (PARTIAL — time-boxed; raise VTS via a narrower scope or rerun.)" : ""}\n  Commit .vts-index/ to share it / speed teammates' cold starts. It answers search_symbol instantly until a language server indexes (which then supersedes it).`);
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
    if (name === "concept_search") {
      // FUZZY retrieval (approach B): answer a concept/intent query ("how does the auth flow work") that does
      // NOT name a symbol, using a concept dictionary mined locally from the repo's own identifier+comment
      // co-occurrence — no embeddings, nothing transmitted, output token-capped file:line. Seed the query
      // lexically (sub-token + dictionary expansion), rank declarations; flow=true also expands the top seed
      // along the language server's call graph (the seed→expand→flow method).
      if (!a.q) return err("concept_search needs q (a concept/intent phrase, e.g. \"auth login flow\").");
      const root = resolveRoot(a);
      if (!tsAvailable()) return err("concept_search needs the tree-sitter grammars (web-tree-sitter + tree-sitter-wasms); they install with the plugin. Until then use search_text (multi-word, ranked by term coverage).");
      const max = Number(a.maxResults) || MAX_RESULTS;
      const { model, symbols, neighbors, cochange } = await conceptIndexFor(root);
      if (!symbols.length) return finishOut([], `No indexable declarations under ${root} for concept search (no tree-sitter-supported files in scope?).` + EMPTY_HINT);
      const qToks = tokenize(String(a.q));
      if (!qToks.length) return err(`"${a.q}" has no usable concept tokens (too short / all stop-words). Try concrete nouns: "auth session token".`);
      // COMMITTABLE synonyms (the critic-approved adaptation): a team-curated, git-committable
      // .vts-index/concept-synonyms.json ({ "term": ["syn", …] }) augments the mined dictionary — inspectable,
      // deterministic, no drift. Purely additive: absent/malformed → the mined model runs alone.
      let synonyms = null;
      try { synonyms = parseSynonyms(fs.readFileSync(path.join(root, ".vts-index", "concept-synonyms.json"), "utf8")); } catch { /* no committed synonyms */ }
      // VTS_CONCEPT_MAX_DF (default 0.25): suppress expansion through/into a cross-cutting-generic token (one
      // present in > this fraction of decls) — the documented noise source on cross-cutting fuzzy queries.
      const maxDfRatio = Number(process.env.VTS_CONCEPT_MAX_DF ?? 0.25);
      let enriched = expandQuery(model, qToks, { ...(synonyms ? { synonyms } : {}), maxDfRatio });
      // Kind weight: a fuzzy "how does X work" wants the function/class/type that EMBODIES the concept, not a
      // throwaway local const/var that merely mentions a word — demote those so the real declarations rank up.
      const kindW = (k) => (/^(const|var|local|decl|field|member)$/.test(k) ? 0.35 : 1);
      const scoreAll = (enr) => symbols
        .map((s) => ({ s, base: scoreSymbol(model, enr, s.nt, s.dt, { pathTokens: s.pt }) * kindW(s.kind) }))
        .filter((r) => r.base > 0);
      // Pass 1: base score (name + path + comment channels).
      let based = scoreAll(enriched);
      // Keep the PRE-PRF intrinsic score per symbol: the climb seed must be the strongest ORIGINAL-query match
      // (an exact name hit), never a symbol that PRF feedback drifted to the top — PRF widens RECALL, not the seed.
      const base0 = new Map(based.map((r) => [r.s, r.base]));
      // PRF (RM3, arXiv:2603.11008): mine expansion terms from the VOCABULARY of the top-k pass-1 results and
      // re-score — the embedding-free synonym bridge ("login" hits the auth module, whose decls contain
      // "authenticate", folded back so a 2nd pass surfaces it). Drift-guarded: terms must appear in >= 2 of the
      // top decls, weighted by idf, capped. VTS_CONCEPT_PRF=0 reverts to the single-shot expansion.
      if ((process.env.VTS_CONCEPT_PRF ?? "1") !== "0" && based.length) {
        const topK = based.slice().sort((a2, b2) => b2.base - a2.base).slice(0, envInt("VTS_CONCEPT_PRF_K", 5));
        const bags = topK.map((r) => [...(r.s.nt || []), ...(r.s.dt || [])]);
        const fb = prfTerms(model, bags, qToks, { terms: envInt("VTS_CONCEPT_PRF_TERMS", 5), minDocs: 2, weight: Number(process.env.VTS_CONCEPT_PRF_WEIGHT ?? 0.5) });
        if (fb.length) {
          const enr2 = new Map(enriched);
          for (const [t, w] of fb) if ((enr2.get(t) || 0) < w) enr2.set(t, w);
          enriched = enr2;          // so the cert / "concept-expanded with" line reflects the PRF terms too
          based = scoreAll(enriched); // Pass 1b: re-score with the feedback-augmented query
        }
      }
      // Pass 2: import-graph proximity — a symbol whose FILE imports (or is imported by) a strongly-matching file
      // is in the same subsystem, so lift it by a fraction of that neighbour file's best score. Deterministic
      // structural signal from the code itself; reranks the matched set, never invents a match. FACTOR=0 off.
      const fileBase = new Map();
      for (const r of based) if ((fileBase.get(r.s.file) || 0) < r.base) fileBase.set(r.s.file, r.base);
      const nf = Number(process.env.VTS_CONCEPT_IMPORT_FACTOR ?? 0.3);
      // GIT CO-CHANGE factor — a 2nd structural neighbour channel (files committed together), weighted BELOW the
      // import graph (a co-change is a softer signal than an explicit import). Same anchor gate. FACTOR=0 off.
      const cf = Number(process.env.VTS_CONCEPT_COCHANGE_FACTOR ?? 0.25);
      // LARGER confidence gate (arXiv:2605.16352): expand the neighbourhood ONLY from high-confidence anchors — a
      // neighbour file lifts a symbol only if its own base clears a fraction of the strongest intrinsic match.
      // Stops a weak/cross-cutting neighbour from dragging its imports/co-changes up. VTS_CONCEPT_ANCHOR_MIN=0 = old.
      const topBase = based.reduce((m, r) => (r.base > m ? r.base : m), 0);
      const anchorRatio = Number(process.env.VTS_CONCEPT_ANCHOR_MIN ?? 0.5);
      const bestNeighbour = (map, file) => {
        let best = 0;
        const ns = map && map.get(file);
        if (ns) for (const g of ns) { const fb = fileBase.get(g) || 0; if (anchorConfident(fb, topBase, anchorRatio) && fb > best) best = fb; }
        return best;
      };
      const scoredAll = based
        .map((r) => {
          const nb = nf ? bestNeighbour(neighbors, r.s.file) : 0;       // import-graph neighbour
          const cb = cf ? bestNeighbour(cochange, r.s.file) : 0;        // git co-change neighbour
          return { s: r.s, sc: r.base + nb * nf + cb * cf, base: r.base };
        })
        .sort((a2, b2) => b2.sc - a2.sc);
      // Fuzzy results have a long low-relevance tail (a trivial local matching one weak expansion term). Cap
      // tighter than an exact search and drop anything below a fraction of the top score — fuzzy wants the
      // confident few, not 60 maybes. VTS_CONCEPT_FLOOR / VTS_CONCEPT_MAX tune it.
      const floor = (scoredAll[0]?.sc || 0) * Number(process.env.VTS_CONCEPT_FLOOR || 0.2);
      const conceptMax = Math.min(max, envInt("VTS_CONCEPT_MAX", 15));
      const ranked = scoredAll.filter((r) => r.sc >= floor).slice(0, conceptMax);
      if (!ranked.length) return finishOut([], `No concept matches for "${a.q}" under ${root} (the repo's own naming may not bridge those words — try search_text, or a synonym).` + EMPTY_HINT + completenessCert({ shown: 0, total: 0, fuzzy: true }));
      // Climb/flow SEED = the entry with the strongest INTRINSIC match (name/path/comment `base`), NOT the
      // proximity-boosted total `sc`. The seed is handed to find_references/goto_definition for ground truth,
      // so it must be the most confident exact-name candidate — an import-graph neighbour can lift a weak-base
      // symbol to the top of the shown list, but it should never become the thing we tell the model to climb on.
      const b0 = (r) => base0.get(r.s) ?? r.base; // pre-PRF intrinsic — climb the original-query match, not a PRF drift
      const seed = ranked.reduce((best, r) => (b0(r) > b0(best) ? r : best), ranked[0]);
      const expTerms = [...enriched].filter(([t]) => !qToks.includes(t)).slice(0, 8).map(([t]) => t);
      const rows = ranked.map((r) => `${r.s.file}:${r.s.line}: ${r.s.kind} ${r.s.name}`);
      const expLine = expTerms.length ? `\n  concept-expanded with: ${expTerms.join(", ")} (mined from this repo's own naming, not a model)` : "";
      const cert = completenessCert({ shown: rows.length, total: ranked.length, truncated: null, fuzzy: true });
      let flow = "";
      if (a.flow === true || a.flow === "true") {
        try {
          const fr = await runTool("find_references", { symbol: seed.s.name, direction: a.direction || "callees", depth: Number(a.depth) || 2, projectPath: root });
          if (fr && !fr.isError) flow = `\n\nflow of the top seed (${seed.s.name}) along the call graph:\n${fr.text}`;
        } catch { /* flow is best-effort */ }
      }
      // Precision-ladder navigation: concept_search is the FUZZY rung (related, not exact). Once a seed looks
      // right, climb to the exact rung for ground-truth — name the hit to find_references / goto_definition.
      const climb = process.env.VTS_CONCEPT_STEER !== "0" ? `\n[ladder: this is the fuzzy rung. Climb to exact on a hit — find_references symbol="${seed.s.name}" or goto_definition for ground-truth refs/def.]` : "";
      return finishOut(rows, `${ranked.length} concept match(es) for "${a.q}" (fuzzy — local concept dictionary, no embeddings, file:line):${expLine}\n` + rows.join("\n") + cert + climb + flow);
    }
    if (name === "vts_dce") {
      // TOPOLOGICAL dead-code ANALYSIS (preview-only) — see dce.js. Seed symbol(s) → walk the call graph to a
      // fixpoint → DEAD / HELD / ENTRY / INCONCLUSIVE candidates + a safe deletion order. It NEVER deletes;
      // the real removal goes through safe_delete (whose find_references guard is the independent backstop, so
      // a false DEAD here cannot delete live code). DCE proposes (call graph), safe_delete disposes (refs guard).
      const root = resolveRoot(a);
      let seeds = [];
      if (Array.isArray(a.seeds)) seeds = a.seeds.slice();
      else if (typeof a.seeds === "string" && a.seeds) seeds = a.seeds.split(",");
      if (a.seed) seeds.push(String(a.seed));
      seeds = [...new Set(seeds.map((s) => String(s).trim()).filter(Boolean))];
      if (!seeds.length) return err('vts_dce needs seed symbol(s): seed="Foo" or seeds="Foo,Bar" (the declaration(s) you suspect are dead).');
      // Reachability (mark-sweep) roots: explicit `roots` ∪ the committable .vts-index/dce-roots.json (team-
      // curated, framework-agnostic — vts hard-codes NO framework markers). Reachability mode activates when
      // any root is supplied or reachability=true is set; it computes liveness FORWARD from these entry points.
      let rootsArg = [];
      if (Array.isArray(a.roots)) rootsArg = a.roots.slice();
      else if (typeof a.roots === "string" && a.roots) rootsArg = a.roots.split(",");
      let fileRoots = [];
      try { fileRoots = parseRootsFile(fs.readFileSync(path.join(root, ".vts-index", "dce-roots.json"), "utf8")); } catch { /* no committed roots */ }
      const dceRoots = [...new Set([...rootsArg, ...fileRoots].map((s) => String(s).trim()).filter(Boolean))];
      const reachabilityMode = a.reachability === true || a.reachability === "true" || dceRoots.length > 0;
      if (reachabilityMode && !dceRoots.length) return err('reachability mode needs roots: roots="main,StartupModule,RunTests" (the entry points liveness is computed from), or a committable .vts-index/dce-roots.json. Without roots, omit reachability to use the default caller-cascade mode.');
      const backendName = preferBackend(a.backend, backendForPath(a.path), BACKEND) || pickBackend(root);
      if (!backendName) return err(`dead-code analysis needs a language-server backend (clangd/roslyn/typescript/pyright) for ${root}; none resolved. It walks the call graph, which the syntactic/text tiers can't provide.`);
      // WARM GATE — the safety preflight (cheap fs check, no clangd spawn). On a cold/large clangd tree the call
      // graph under-reports callers (callers in not-yet-indexed TUs are absent) → a LIVE symbol can look DEAD.
      // Refuse by default rather than hand back unsafe DEAD candidates; allowCold proceeds with every verdict
      // forced to INCONCLUSIVE. (search_symbol etc. still resolve fine cold — only the call-graph completeness
      // that DCE's correctness hinges on is unsafe.)
      const allowCold = a.allowCold === true || a.allowCold === "true";
      const build = a.build === true || a.build === "true";
      const thorough = !(a.thorough === false || a.thorough === "false"); // default ON — the slow, complete mode
      let persisted = backendName === "clangd" ? hasPersistedIndex(root) : true;
      // build=true: don't refuse a cold clangd tree — kick off the (slow) full index build and WAIT, then
      // proceed with a COMPLETE call graph. getClient's afterInit blocks on the cold build, so once it returns
      // the whole index is ready. If the build can't complete, we stay cold and fall through to the gate.
      if (backendName === "clangd" && !persisted && build) {
        try { const cb = await getClient(root, backendName); persisted = hasPersistedIndex(root) || cb.indexLoaded === true; } catch { /* build failed → stays cold */ }
      }
      const gate = dceWarmGate(backendName, persisted, allowCold);
      if (gate.refuse) return err(`dead-code analysis needs a built clangd index for ${root}, and none is persisted yet. On a cold or large (e.g. Unreal, ~26k TUs) tree the call graph UNDER-REPORTS callers — a symbol whose callers live in not-yet-indexed translation units would look DEAD when it is actually live, which is unsafe to feed safe_delete. Indexing the WHOLE tree is heavy, so SCOPE it to the module under analysis first, then build:\n  vts setup --scope Source --projectPath "${root}"   (narrow to the game/module subtree — not the whole monorepo)\n  vts preindex --projectPath "${root}"               (build the scoped index; or keep the MCP server running so clangd stays warm)\nOr re-run with build=true to build-and-wait now (slow — minutes on a big tree). Refusing rather than returning unsafe DEAD candidates; allowCold=true inspects the structure with every verdict forced to INCONCLUSIVE.`);
      // Entry-point roots — never dead even with zero callers (they're invoked externally). A small built-in
      // set + user-supplied `entry` patterns (comma list, matched as case-insensitive name substrings).
      const userPats = (typeof a.entry === "string" && a.entry ? a.entry.split(",") : Array.isArray(a.entry) ? a.entry : [])
        .map((s) => String(s).trim().toLowerCase()).filter(Boolean);
      const DEFAULT_ENTRY = /^(main|winmain|_?start|run)$/i;
      const isEntry = (nm) => DEFAULT_ENTRY.test(nm) || userPats.some((p) => nm.toLowerCase().includes(p));
      // query(name): one call-hierarchy probe (both directions, 1 hop) → caller + callee NAMES with files.
      const query = async (nm) => {
        let cg;
        try { cg = await buildCallGraph({ symbol: nm, direction: "both", depth: 1, projectPath: root, backend: backendName }); }
        catch { return { resolved: false }; }
        if (!cg || cg.error) return { resolved: false };
        const focus = cg.nodes.find((n) => n.focus) || cg.nodes[0];
        if (!focus) return { resolved: false };
        const byId = new Map(cg.nodes.map((n) => [n.id, n]));
        const callers = [], callees = [], seenC = new Set(), seenE = new Set();
        let callSites = 0;
        for (const l of cg.links || []) {
          if (l.target === focus.id && l.source !== focus.id) {
            callSites += Math.max(1, Number(l.count) || 1); // sum of call-site ranges feeding this symbol — the thorough verify reconciles this against the full reference count
            const n = byId.get(l.source); if (n && !seenC.has(n.label)) { seenC.add(n.label); callers.push({ name: n.label, file: n.file }); }
          }
          if (l.source === focus.id && l.target !== focus.id) { const n = byId.get(l.target); if (n && !seenE.has(n.label)) { seenE.add(n.label); callees.push({ name: n.label, file: n.file }); } }
        }
        const cert = gate.forceInconclusive ? "INCONCLUSIVE" : cg.truncated ? "PARTIAL" : "COMPLETE";
        return { resolved: true, callers, callees, callSites, cert, file: focus.file, line: focus.line };
      };
      // THOROUGH verify (default on, slow): count the FULL semantic reference set (textDocument/references —
      // every use, not just calls) and reconcile against the call-site count. A symbol kept alive ONLY by a
      // non-call reference (function value/callback, reflection, dynamic dispatch) has more references than call
      // sites → it is NOT marked DEAD. This closes the call graph's blind spot in preview, without mutating.
      // Skipped in allowCold (all INCONCLUSIVE already) and when thorough=false (fast call-graph-only mode).
      const dceClient = (thorough && !gate.forceInconclusive) ? await getClient(root, backendName) : null;
      const refCountFor = async (nm) => {
        if (!dceClient) return null;
        try {
          const persistedNow = backendName === "clangd" && hasPersistedIndex(root);
          const syms = await symbolReady(dceClient, nm, persistedNow, envInt("VTS_CLANGD_PERSISTED_WAIT_MS", 60000));
          const pick = (syms || []).slice().sort((x, y) => (x.name === nm ? 0 : 1) - (y.name === nm ? 0 : 1))[0];
          if (!pick) return null;
          const p = fromUri(pick.location.uri), line = pick.location.range.start.line;
          const ch = anchorOnName(p, line, nm, pick.location.range.start.character);
          dceClient.didOpen(p, langIdForPath(p, backendName));
          const locs = (await dceClient.references(p, line, ch, false)) || [];
          return locs.length;
        } catch { return null; }
      };
      const verify = dceClient ? (async (nm, r) => reconcileRefs(r.callSites || 0, await refCountFor(nm))) : null;
      const envCap = envInt("VTS_DCE_MAX_NODES", reachabilityMode ? 2000 : 120);
      const maxNodes = Math.min(Number(a.maxNodes) || envCap, reachabilityMode ? envInt("VTS_DCE_MAX_NODES", 2000) : envCap);
      let result;
      if (reachabilityMode) {
        // MARK-SWEEP (Go-deadcode/RTA model): liveness is computed FORWARD from the named ENTRY POINTS, so a
        // missing *caller* edge can't make a live symbol look dead — only an incomplete ROOT set can, and the
        // reference verify catches that. Roots come from the `roots` arg ∪ the committable .vts-index/dce-roots
        // .json (team-curated, framework-agnostic — vts hard-codes NO framework markers).
        result = await reachabilityDeadCode(query, dceRoots, seeds, { maxNodes, isEntry, verify });
        result.mode = `reachability (mark-sweep from ${dceRoots.length} root${dceRoots.length === 1 ? "" : "s"}${verify ? ", reference-verified" : ""})`;
      } else {
        result = await analyzeDeadCode(query, seeds, { maxNodes, isEntry, verify });
        result.mode = gate.forceInconclusive ? "allowCold" : verify ? "thorough (reference-verified)" : "fast (call-graph only)";
      }
      if (gate.forceInconclusive) result.coldNote = `clangd index not warm for ${root} — running in allowCold mode: every verdict is forced to INCONCLUSIVE (nothing is marked DEAD). Build the index (build=true, or vts preindex) for real DEAD/HELD verdicts.`;
      const rows = result.dead.map((dd) => `${dd.file}:${dd.line}`);
      return finishOut(rows, formatDce(result, { cap: MAX_RESULTS }));
    }
    if (name === "find_files") {
      if (!a.q) return err("find_files needs q (a filename substring or glob like *Manager.cpp).");
      const root = resolveRoot(a);
      const max = Number(a.maxResults) || MAX_RESULTS;
      const files = findFilesUnder(root, String(a.q), max);
      if (!files.length) return finishOut([], `No files matching "${a.q}" under ${root}.` + LOG_EMPTY_HINT + completenessCert({ shown: 0, total: files.truncated ? null : 0, truncated: files.truncated || null, semantic: false }));
      let ft = files.truncated === "cap" ? ` — capped at ${max} (raise maxResults or narrow q; more exist)` : files.truncated === "scan" ? ` — scan limit hit (narrow projectPath; more exist)` : "";
      if (files.truncated) ft += teeNote("find_files", a.q, root, (n) => findFilesUnder(root, String(a.q), n));
      const filesCert = completenessCert({ shown: files.length, total: files.truncated ? null : files.length, truncated: files.truncated || null, semantic: false });
      return finishOut(files, `${files.length} file(s) matching "${a.q}"${ft}:\n` + factorCommonPrefix(files) + filesCert);
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
        const terms = conceptTerms(String(a.q));
        if (terms) {
          // multi-word query → lexical concept search: gather any-term hits, rank by distinct-term coverage.
          runScan = (n) => conceptScan(root, terms, n, ext);
          scopeLabel = docs ? "concept (text+docs, ranked by term coverage)" : "concept (lexical, ranked by term coverage)";
        } else {
          runScan = (n) => scanTextUnder(root, String(a.q), n, ext);
          scopeLabel = docs ? "text+docs" : "text; for symbols prefer search_symbol";
        }
      }
      const hits = runScan(max);
      if (!hits.length) {
        // 0 matches but the 4s walk TIMED OUT before finishing → not genuinely absent, just unreached (this
        // is exactly how a usage hunt on a giant tree returns an empty/partial slice). Say so, and steer a
        // symbol hunt to find_references (semantic, walks no tree, complete).
        const toNote = hits.truncated === "time" ? " — but the 4s time-box hit before the scan finished, so this 0 is NOT conclusive (the walk didn't cover the whole tree; a real 0 and an unreached-in-time 0 are indistinguishable here)" : "";
        const emptySteer = (!docs && !a.path && hits.truncated) ? textSymbolSteer(a.q, true) : "";
        const emptyTextCert = completenessCert({ shown: 0, total: hits.truncated ? null : 0, truncated: hits.truncated || null, semantic: false });
        return finishOut([], `No text matches for "${a.q}" (${scopeLabel}) under ${root}${toNote}.` + LOG_EMPTY_HINT + emptySteer + emptyTextCert);
      }
      let tt = hits.truncated === "cap" ? ` — capped at ${max} (raise maxResults or narrow q; more exist)` : hits.truncated === "time" ? ` — 4s time-box hit (narrow projectPath/q; more matches likely exist)` : "";
      if (hits.truncated) tt += teeNote("search_text", a.q, root, runScan);
      // Steer a symbol/class usage hunt toward find_references/search_symbol (complete + far smaller than a
      // time-boxed text scan). Only on a CODE scan — a doc/single-file target is an intentional text lookup.
      const steer = (!docs && !a.path) ? textSymbolSteer(a.q, hits.truncated) : "";
      const textCert = completenessCert({ shown: hits.length, total: hits.truncated ? null : hits.length, truncated: hits.truncated || null, semantic: false });
      const textBody = `${hits.length} match(es) for "${a.q}" (${scopeLabel})${tt}:\n` + factorCommonPrefix(hits) + textCert;
      // LEAD with the symbol-hunt steer (not trail it): the model acts on the first lines it reads, so an
      // actionable "use find_references instead" buried under 60 matches is seen too late (live: a symbol
      // text-search ran, the model used the partial body before reaching the trailing steer). A plain text
      // search has no steer → body unchanged.
      return finishOut(hits, steer ? steer.replace(/^\n+/, "") + "\n\n" + textBody : textBody);
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
    // STRUCTURE tier: a prose/config file (markdown/asciidoc/rst/toml/yaml/json/txt) has a SECTION tree, not a
    // language server — route the name-addressed tools to its sections BEFORE backend resolution (which would
    // fail to find a server for a .md/.toml/…). A section is then outline-able/readable/editable by its heading.
    if (a.path && isStructFile(a.path) && STRUCT_TOOLS.has(name)) return await structTool(name, a, root, { finishOut, err, symbolEditResult });
    // backendForPath(a.path): a `.py`/`.ts` file in a clangd/roslyn-rooted MIXED repo gets its OWN backend
    // (pyright/typescript) instead of the root's — else the query hits the wrong LSP and finds nothing. A
    // path's own backend ALSO overrides a FORCED backend (config `backend` / VTS_BACKEND) when they CONFLICT:
    // one global server serves every repo, so a `backend:"clangd"` pinned for a C++ project must not be sent
    // this repo's `.js`/`.cs`/`.py` (clangd then answers `-32001 invalid AST`). A path-less query (e.g.
    // search_symbol by name) keeps the forced backend; an explicit per-call `a.backend` still wins outright.
    const backendName = preferBackend(a.backend, backendForPath(a.path), BACKEND) || pickBackend(root);
    // search_symbol degrades gracefully when NO backend resolves (text fallback) instead of hard-erroring —
    // so the grep-rewrite hook can always route an identifier to `vts symbol` (semantic when a backend
    // exists, literal text otherwise) without risking a dead-end error.
    if (!backendName && name === "search_symbol") {
      if (!a.q) return err("search_symbol needs q (the symbol name/substring).");
      const max = Number(a.maxResults) || MAX_RESULTS;
      // No toolchain — try the SYNTACTIC tier (committed index / tree-sitter AST) before the literal scan: it
      // returns real declarations for 36 languages with zero setup, vastly better than a usage-line grep.
      const syn = await syntacticSymbols(root, a.q, Math.min(max, 40));
      if (syn) return finishOut(syn.lines, `No language-server backend for ${root} — ${syn.source} declaration matches for "${a.q}":\n` + syn.lines.join("\n") + completenessCert({ shown: syn.lines.length, total: syn.total, truncated: syn.truncated, syntactic: true }));
      const hits = scanTextUnder(root, String(a.q), Math.min(max, 20));
      if (hits.length) return finishOut(hits, `No language-server backend resolved for ${root} — literal text matches for "${a.q}" (file:line, not a semantic decl):\n` + hits.join("\n"));
      return finishOut([], `No backend resolved and no text match for "${a.q}" under ${root}.` + EMPTY_HINT);
    }
    // find_references with NO backend (a Go/Rust/… repo we have no language server for): the SYNTACTIC
    // reference fallback (tree-sitter call sites, then a literal scan) — the SAME tier search_symbol uses
    // above. Without this, getClient(root, null) hard-errors before the by-name fallback inside the handler
    // can run, so find_references-by-name dead-ends on a toolchain-less repo (live-found on a Go corpus).
    if (!backendName && name === "find_references") {
      if (!a.symbol) return err("find_references needs `symbol` (a name) when no language-server backend is available — a position query (path/line/character) requires a backend.");
      const want = String(a.symbol);
      const fmax = Number(a.maxResults) || MAX_RESULTS;
      const tsRefs = await tsSearchReferences(root, want, { skipDir });
      if (tsRefs && tsRefs.length) {
        const refLines = tsRefs.map((r) => `${r.file}:${r.line}`);
        const body = compactResults() ? compactLocationLines(refLines) : refLines.join("\n");
        return finishOut(refLines, `No language-server backend for ${root} — ${tsRefs.length} tree-sitter call reference(s) for "${want}" (syntactic, file:line; not semantic — a language server resolves which overload/scope):\n` + body + completenessCert({ shown: refLines.length, total: tsRefs.length, truncated: tsRefs.truncated, syntactic: true }));
      }
      const hits = scanTextUnder(root, want, fmax);
      if (hits.length) return finishOut(hits, `No language-server backend for ${root} — literal usage matches for "${want}" (file:line of the name, not semantic references):\n` + hits.join("\n"));
      return finishOut([], `No backend resolved and no tree-sitter/text reference for "${want}" under ${root}.` + EMPTY_HINT);
    }
    if (!backendName) return err(`No backend resolved. Pass backend=clangd|roslyn|typescript|pyright, set VTS_BACKEND, or ensure the project root has compile_commands.json (C++), a .sln/.csproj (C#), a tsconfig/package.json (JS/TS), or a pyproject.toml/*.py (Python).`);
    const max = Number(a.maxResults) || MAX_RESULTS;
    const lang = langIdForPath(a.path, backendName); // languageId for didOpen (hover/document_symbols/rename); unused by search_symbol

    if (name === "search_symbol") {
      if (!a.q) return err("search_symbol needs q (the symbol name/substring).");
      // Render a successful symbol hit set — shared by the primary path and the census fallback below, so a
      // mixed-repo fallback result gets the SAME focus/tee/steer/cert treatment as a primary hit.
      const renderFoundSymbols = (syms, bname, advB, note = "") => {
        const focusN = focusCap(String(a.q), syms, max);
        const symTee = teeOverflow("search_symbol", a.q, syms.map((s) => `${s.name} @ ${locLine(s.location.uri, s.location.range)}`), focusN);
        const symEdit = editSteerOn() && syms.length <= envInt("VTS_EDIT_STEER_MAX", 10) ? EDIT_STEER : ""; // focused lookup → likely an edit precursor
        // Found the declaration(s); the other natural next step is "where is it USED?" — point at find_references
        // by NAME (semantic call sites) so the model doesn't fall back to a grep for usages. Focused result only.
        const symUses = usesSteerOn() && syms.length <= envInt("VTS_EDIT_STEER_MAX", 10)
          ? `\n↪ Where is "${a.q}" USED? find_references symbol="${a.q}" (all call sites, semantic) — add direction=callers for the caller tree.`
          : "";
        const focusNote = focusN < max && focusN < syms.length ? ` — showing the ${focusN} best for an exact-name hit (raise maxResults or VTS_FOCUS=0 for all ${syms.length})` : "";
        const symCert = completenessCert({ shown: Math.min(focusN, syms.length), total: syms.length, truncated: focusN < syms.length ? "cap" : null, semantic: true, scoped: scopeDirsFor(root).length > 0 });
        const symBody = advB + `${syms.length} symbol(s) matching "${a.q}" (backend: ${bname}, root: ${root})${note}${focusNote}${symTee}:\n` + fmtSymbols(syms, focusN) + symEdit + symUses + symCert;
        maybeCounterfactual("search_symbol", String(a.q), root, syms.map((s) => s.location), symBody);
        return finishOut(syms, symBody);
      };
      const c = await getClient(root, backendName);
      const persisted = backendName === "clangd" && hasPersistedIndex(root);
      const syms0 = await symbolReady(c, String(a.q), persisted, envInt("VTS_CLANGD_PERSISTED_WAIT_MS", 60000));
      // Read the history signal BEFORE recording THIS query's results, so a result can't boost its own rank.
      const histMap = rankEnabled() ? histRank(root) : null;
      try { recordQueryResults(root, syms0.map((s) => fromUri(s.location.uri))); } catch { /* best-effort */ }
      // Rerank the engine's results before fmtSymbols caps to top-N (Semble-inspired, zero-transmission).
      const syms = histMap ? rankSymbols(String(a.q), syms0, histMap) : syms0;
      const adv = backendAdvisory(backendName, root);
      if (!syms.length) {
        // CENSUS-BASED MULTI-BACKEND FALLBACK (path-less, non-explicit query only): the primary backend (the
        // forced/root one) missed, but a DIFFERENT language present in this MIXED repo would never be tried —
        // preferBackend keeps the forced backend with no `path` to override it, so a Python tooling dir under a
        // UE C++ tree is structurally invisible. Retry against the OTHER backends the census shows have files,
        // most-code-first, and return the FIRST semantic hit — still the EXACT rung, just from the right
        // language server. A query carrying a `path` or an explicit `backend=` is a deliberate choice → kept.
        if (!a.path && !a.backend) {
          for (const fb of censusFallbackBackends(root, backendName)) {
            try {
              const cfb = await getClient(root, fb);
              const persistedFb = fb === "clangd" && hasPersistedIndex(root);
              const symsFb0 = await symbolReady(cfb, String(a.q), persistedFb, envInt("VTS_CLANGD_PERSISTED_WAIT_MS", 60000));
              if (!symsFb0.length) continue;
              try { recordQueryResults(root, symsFb0.map((s) => fromUri(s.location.uri))); } catch { /* best-effort */ }
              const symsFb = histMap ? rankSymbols(String(a.q), symsFb0, histMap) : symsFb0;
              return renderFoundSymbols(symsFb, fb, backendAdvisory(fb, root), ` — mixed-repo fallback, ${backendName} had no match`);
            } catch { /* this backend failed to spawn/answer — try the next census candidate */ }
          }
        }
        // tsserver / pyright answer workspace/symbol from the files they have OPEN/indexed, so a symbol
        // whose file the warm-up didn't open (or a non-exported local) can come back empty even though it
        // exists. Fall back to a bounded literal text search so it's still locatable (clangd/roslyn index
        // the whole project, so they skip this). Clearly labeled: text matches, not semantic declarations.
        // tsserver/pyright answer from OPEN/indexed files (an unopened or non-exported symbol misses);
        // clangd returns nothing without a usable compile_commands.json. In all three, fall back to a
        // bounded literal text search so the name is still locatable. (roslyn indexes the whole solution.)
        if (backendName === "typescript" || backendName === "pyright" || backendName === "clangd") {
          const why = backendName === "clangd"
            ? "clangd has no usable index here (missing/empty compile_commands.json)"
            : `${backendName} answers from open/indexed files, so a symbol whose file isn't open yet (or a non-exported local) can be missed`;
          // SYNTACTIC tier first (real decls, 36 langs, no setup), then the literal scan as a last resort.
          const syn = await syntacticSymbols(root, a.q, Math.min(max, 40));
          if (syn) return finishOut(syn.lines, adv + `No indexed symbol for "${a.q}" — ${why}. ${syn.source} declaration matches instead:\n` + syn.lines.join("\n") + completenessCert({ shown: syn.lines.length, total: syn.total, truncated: syn.truncated, syntactic: true }));
          const hits = scanTextUnder(root, String(a.q), Math.min(max, 20));
          if (hits.length) {
            return finishOut(hits, adv + `No indexed symbol for "${a.q}" — ${why}. Literal text matches instead (file:line of the name, not a semantic decl):\n` + hits.join("\n"));
          }
        }
        const partialIdx = backendName === "typescript" || backendName === "pyright" || (backendName === "clangd" && !hasCompileDb(root));
        const emptyCert = completenessCert({ shown: 0, total: 0, truncated: partialIdx ? "index" : null, semantic: true, scoped: scopeDirsFor(root).length > 0 });
        // Precision-ladder navigation: search_symbol is the EXACT rung (it wants a name). A multi-word query
        // that found no exact symbol reads like an INTENT, not a name — descend one rung to the fuzzy tier
        // instead of leaving the agent at a dead end. VTS_CONCEPT_STEER=0 silences it.
        const intentSteer = process.env.VTS_CONCEPT_STEER !== "0" && /\S\s+\S/.test(String(a.q).trim())
          ? `\n[ladder: that reads like an INTENT, not a symbol name. Descend to the fuzzy rung — concept_search q="${a.q}" (repo-mined concept dictionary, no embeddings, still file:line).]`
          : "";
        return finishOut([], adv + `No symbols matching "${a.q}" (backend: ${backendName}).` + EMPTY_HINT + clangdIndexAdvisory(backendName, root, null) + emptyCert + intentSteer);
      }
      // confidence-adaptive focus + steers + cert (shared with the census fallback above).
      return renderFoundSymbols(syms, backendName, adv);
    }
    if (name === "find_references") {
      const c = await getClient(root, backendName);
      // The code-modification primitive: when modifying a symbol you need every call site, but you start
      // from a NAME, not a 0-based position. Accept `symbol` and resolve the declaration position via the
      // index first (search_symbol → best match → its location), then find references there — so
      // "where is FooBar used" is ONE call, not the locate→position→refs dance that pushes the model to grep.
      let pos = null, originLabel = "", pickKind = null;
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
          // no indexed decl (ts/py open-files miss, clangd no-DB). SYNTACTIC reference fallback FIRST: a
          // tree-sitter call-site capture (real call references, 11 langs, zero toolchain) — strictly better
          // than the literal scan that follows (a call site, not every textual mention). Then literal scan.
          const idxAdv = clangdIndexAdvisory(backendName, root, a.path || null);
          const tsRefs = await tsSearchReferences(root, want, { skipDir });
          if (tsRefs && tsRefs.length) {
            const refLines = tsRefs.map((r) => `${r.file}:${r.line}`);
            const body = compactResults() ? compactLocationLines(refLines) : refLines.join("\n");
            return finishOut(refLines, backendAdvisory(backendName, root) + `No indexed declaration for "${want}" — ${tsRefs.length} tree-sitter call reference(s) (syntactic, file:line; not semantic — a language server resolves which overload/scope):\n` + body + completenessCert({ shown: refLines.length, total: tsRefs.length, truncated: tsRefs.truncated, syntactic: true }) + idxAdv);
          }
          const hits = scanTextUnder(root, want, max);
          if (hits.length) return finishOut(hits, backendAdvisory(backendName, root) + `No indexed declaration for "${want}" — literal usage matches instead (file:line of the name, not semantic references):\n` + hits.join("\n") + idxAdv);
          return finishOut([], backendAdvisory(backendName, root) + `No declaration found for "${want}" (backend: ${backendName}).` + EMPTY_HINT + idxAdv);
        }
        const pp = fromUri(pick.location.uri);
        pos = { path: pp, line: pick.location.range.start.line, character: pick.location.range.start.character };
        pickKind = pick.kind;
        c.didOpen(pp, langIdForPath(pp, backendName)); // ensure the resolved TU is open for the references query
        originLabel = `"${want}" (${SYMBOL_KIND[pick.kind] || "sym"} @ ${locLine(pick.location.uri, pick.location.range)})`;
      } else {
        if (!a.path || a.line == null || a.character == null) return err("find_references needs `symbol` (a name — resolved via the index), or a `path` + `line` + `character` position (0-based). `path` may also accompany `symbol` to disambiguate an overload.");
        pos = { path: a.path, line: Number(a.line), character: Number(a.character) };
        originLabel = `${a.path}:${Number(a.line) + 1}`;
      }
      // direction=callers|callees → a MULTI-HOP CALL HIERARCHY instead of flat references (codebase-memory-mcp
      // trace_path parity, but synthesized from the OFFICIAL LSP callHierarchy — real semantic edges, zero
      // transmission). Folded into find_references rather than a new tool: it's the transitive superset of
      // "who uses this", reuses the symbol→position resolution above, and adds no fixed tool-surface cost.
      const dirRaw = String(a.direction || "").toLowerCase();
      const traceDir = (dirRaw === "callers" || dirRaw === "incoming") ? "callers" : (dirRaw === "callees" || dirRaw === "outgoing") ? "callees" : null;
      if (traceDir && a.symbol && !isCallableKind(pickKind)) {
        // a variable/const/field has no call hierarchy — say so FAST (don't burn the prepareCallHierarchy retry)
        return finishOut([], backendAdvisory(backendName, root) + `${originLabel} is a ${SYMBOL_KIND[pickKind] || "symbol"}, not a function/method — call hierarchy (direction=${traceDir}) needs a callable. Omit direction for plain references.`);
      }
      if (traceDir) {
        if (a.symbol) pos.character = anchorOnName(pos.path, pos.line, String(a.symbol), pos.character); // anchor ON the name for callHierarchy
        c.didOpen(pos.path, langIdForPath(pos.path, backendName));
        const depthMax = Math.max(1, Math.min(Number(a.depth) || 2, envInt("VTS_TRACE_MAX_DEPTH", 5)));
        const nodeCap = Math.min(Number(a.maxResults) || MAX_RESULTS, envInt("VTS_TRACE_MAX_NODES", 80));
        const cItems = (await prepareCallHierReady(c, pos.path, pos.line, pos.character)).filter(Boolean);
        if (!cItems.length) return finishOut([], backendAdvisory(backendName, root) + `No call-hierarchy anchor for ${originLabel} (backend: ${backendName}) — point at a function/method, or the backend may not support callHierarchy.` + EMPTY_HINT);
        const acc = []; const visited = new Set(); const capRef = { cap: nodeCap, truncated: false };
        for (const it of cItems) { visited.add(traceKey(it)); await traceFrom(c, it, traceDir, 0, depthMax, visited, acc, capRef); }
        const filePaths = acc.map((n) => fromUri(n.item.uri));
        try { recordQueryResults(root, filePaths); } catch { /* best-effort */ }
        const noun = traceDir === "callees" ? "callee" : "caller";
        const tbody = acc.length
          ? acc.map((n) => `${"  ".repeat(n.depth)}${SYMBOL_KIND[n.item.kind] || "sym"} ${n.item.name}  @ ${callItemLoc(n.item)}${n.cycle ? " (cycle)" : ""}`).join("\n")
          : `(no ${noun}s found)`;
        const more = capRef.truncated ? `\n… node cap ${nodeCap} hit (raise maxResults/VTS_TRACE_MAX_NODES or lower depth).` : "";
        const summary = acc.length ? `\n${acc.length} ${noun} edge(s) across ${new Set(filePaths).size} file(s) (depth ≤ ${depthMax}).` : "";
        return finishOut(cItems, backendAdvisory(backendName, root) + `${noun}s of ${originLabel} (backend: ${backendName}):\n` + tbody + more + summary);
      }
      const locs = (await c.references(pos.path, pos.line, pos.character, a.includeDeclaration === true)) || [];
      const locList = (Array.isArray(locs) ? locs : [locs]).filter(Boolean);
      try { recordQueryResults(root, locList.map((l) => fromUri(l.uri))); } catch { /* best-effort */ }
      const refTee = teeOverflow("find_references", a.symbol ? String(a.symbol) : `${path.basename(String(pos.path))}:${pos.line + 1}`, locList.map((l) => locLine(l.uri, l.range)), max);
      // detail=file|dir → a blast-radius summary (dependents grouped + ranked) instead of the per-line list.
      const detail = String(a.detail || "").toLowerCase();
      const refBody = (detail === "file" || detail === "dir") ? fmtRefSummary(locList, detail, max) : fmtLocations(locs, max, "reference(s)");
      const refCert = completenessCert({ shown: Math.min(locList.length, max), total: locList.length, truncated: locList.length > max ? "cap" : null, semantic: true, scoped: scopeDirsFor(root).length > 0 });
      const refNav = detail ? "" : refNavSteer(locList.length, max); // a flat list with no detail= → offer the cheaper views
      const refBodyFull = backendAdvisory(backendName, root) + `references of ${originLabel} (backend: ${backendName})${refTee}:\n` + refBody + refNav + refCert;
      if (a.symbol) maybeCounterfactual("find_references", String(a.symbol), root, locList, refBodyFull); // by-name → a NAME to shadow-grep
      return finishOut(locs, refBodyFull);
    }
    if (name === "goto_definition") {
      if (!a.path || a.line == null || a.character == null) return err("goto_definition needs path, line, character (0-based position).");
      const c = await getClient(root, backendName);
      c.didOpen(a.path, lang); // re-read the file so the position resolves against current disk text
      const KIND_LABEL = { definition: "definition", type_definition: "type definition", implementation: "implementation", declaration: "declaration" };
      const kind = KIND_LABEL[String(a.kind || "definition")] ? String(a.kind || "definition") : "definition";
      const label = KIND_LABEL[kind];
      const locs = (await c.gotoByKind(kind, a.path, Number(a.line), Number(a.character))) || [];
      try { recordQueryResults(root, (Array.isArray(locs) ? locs : [locs]).filter(Boolean).map((l) => fromUri(l.uri))); } catch { /* best-effort */ }
      const defEdit = editSteerOn() && (Array.isArray(locs) ? locs.length : !!locs) ? EDIT_STEER : ""; // landed on a decl → edit precursor
      return finishOut(locs, backendAdvisory(backendName, root) + `${label} of ${a.path}:${Number(a.line) + 1} (backend: ${backendName}):\n` + fmtLocations(locs, max, `${label}(s)`) + defEdit);
    }
    if (name === "diagnostics") {
      const dirScope = a.scope === "directory" || a.directory === true;
      if (!a.path && !dirScope) return err("diagnostics needs `path` (a file), or `scope=\"directory\"` to scan the project.");
      const c = await getClient(root, backendName);
      if (dirScope) {
        // Project-wide: open a BOUNDED set of code files so the server parses + publishes each, wait once for
        // the publishes, then aggregate the per-uri diagnostics it pushed. Bounded (VTS_DIAG_DIR_MAX, time-box
        // in codeFilesUnder) so a giant tree can't hang it; capped/aborted sweeps are disclosed (no silent caps).
        const dirRoot = (a.path ? (path.isAbsolute(String(a.path)) ? String(a.path) : path.join(root, String(a.path))) : root).replace(/\\/g, "/");
        const cap = envInt("VTS_DIAG_DIR_MAX", 50);
        const files = codeFilesUnder(dirRoot, cap);
        for (const f of files) c.didOpen(f, langIdForPath(f, backendName));
        await new Promise((r) => setTimeout(r, envInt("VTS_DIAG_DIR_WAIT_MS", 4000))); // let the server publish
        const agg = [];
        const dirCanon = canonFsPath(dirRoot); // servers spell the Win drive differently (%3A/case) — compare canonically
        for (const [uri, ds] of c.diagnostics.entries()) {
          if (!ds || !ds.length) continue;
          let fp; try { fp = fromUri(uri).replace(/\\/g, "/"); } catch { continue; }
          if (!canonFsPath(uri).startsWith(dirCanon)) continue; // only files under the scanned dir
          for (const x of ds) agg.push({ ...x, _file: fp });
        }
        const sweepNote = files.truncated ? ` — scan capped at ${files.length} file(s) (raise VTS_DIAG_DIR_MAX; more exist)` : ` (${files.length} file(s) scanned)`;
        return finishOut(agg, backendAdvisory(backendName, root) + `diagnostics under ${dirRoot} (backend: ${backendName})${sweepNote}:\n` + fmtDiagnostics(agg, null, max));
      }
      c.didOpen(a.path, lang); // parse the file so the server publishes its diagnostics
      const diags = (await c.diagnosticsFor(a.path)) || [];
      return finishOut(diags, backendAdvisory(backendName, root) + `diagnostics for ${a.path} (backend: ${backendName}):\n` + fmtDiagnostics(diags, a.path, max));
    }
    if (name === "hover") {
      if (!a.path || a.line == null || a.character == null) return err("hover needs path, line, character (0-based position).");
      const c = await getClient(root, backendName);
      c.didOpen(a.path, lang); // ensure the TU is open so clangd/Roslyn can answer at the position
      const h = await c.hover(a.path, Number(a.line), Number(a.character));
      return finishOut(h || {}, backendAdvisory(backendName, root) + `hover ${a.path}:${Number(a.line) + 1} (backend: ${backendName}):\n` + fmtHover(h));
    }
    if (name === "document_symbols") {
      const dirScope = a.scope === "directory" || a.directory === true;
      if (!a.path && !dirScope) return err("document_symbols needs `path` (the file to outline), or `scope=\"directory\"` for a signatures-only project skeleton.");
      const c = await getClient(root, backendName);
      if (dirScope) {
        // repo_skeleton: a signatures-only map of a directory — outline each code file (no bodies) so you can
        // see the SHAPE of a module without Reading every file. Bounded (VTS_SKELETON_DIR_MAX + codeFilesUnder's
        // time-box) so a giant tree can't hang it. Reuses codeFilesUnder + fmtDocSymbols (the noise filter).
        const dirRoot = (a.path ? (path.isAbsolute(String(a.path)) ? String(a.path) : path.join(root, String(a.path))) : root).replace(/\\/g, "/");
        const cap = envInt("VTS_SKELETON_DIR_MAX", 40);
        const files = codeFilesUnder(dirRoot, cap);
        const parts = [];
        for (const f of files) {
          c.didOpen(f, langIdForPath(f, backendName));
          const syms = (await c.documentSymbol(f)) || [];
          if (syms.length) parts.push(`# ${f.replace(/\\/g, "/")}\n` + fmtDocSymbols(syms, max));
        }
        try { recordQueryResults(root, files); } catch { /* best-effort */ }
        const capNote = files.length >= cap ? ` (capped at ${cap}; raise VTS_SKELETON_DIR_MAX or narrow the path)` : "";
        return finishOut({}, backendAdvisory(backendName, root) + `repo skeleton — ${files.length} file(s) under ${dirRoot}${capNote} (backend: ${backendName}):\n` + (parts.join("\n\n") || "(no outlined symbols)"));
      }
      c.didOpen(a.path, lang);
      const syms = (await c.documentSymbol(a.path)) || [];
      try { recordQueryResults(root, [a.path]); } catch { /* best-effort */ }
      // Baseline = the whole FILE you'd otherwise Read for its structure (avoided-read), not the raw symbol
      // tree — outlining a 700-line file saves the 700-line Read, which is what the ledger should reflect.
      let _dsBase = syms; try { _dsBase = fs.readFileSync(a.path, "utf8"); } catch { /* keep syms baseline */ }
      return finishOut(_dsBase, backendAdvisory(backendName, root) + `outline of ${a.path} (backend: ${backendName}):\n` + fmtDocSymbols(syms, max));
    }
    if (name === "read_symbol") {
      // READ-side twin of replace_symbol_body: name a symbol → return ONLY that symbol's source (its outline
      // span), never the whole file. Kills the whole-file Read that precedes most edits (measured ~468k tok/30d
      // in the savings ledger). Reuses resolveSymbolForEdit verbatim; signatureOnly trims to the declaration head.
      const c = await getClient(root, backendName);
      const r = await resolveSymbolForEdit(c, root, backendName, a);
      if (r.error) return err(r.error);
      const sLine = r.ds.range.start.line, eLine = r.ds.range.end.line;
      const all = fs.readFileSync(r.file, "utf8").split(/\r?\n/);
      const sigOnly = a.signatureOnly === true || a.signatureOnly === "true";
      const cap = envInt("VTS_SYMBOL_MAX_LINES", 200);
      let end = eLine, structural = false;
      if (sigOnly) { end = sLine; for (let i = sLine; i <= Math.min(eLine, sLine + 8); i++) { end = i; if (all[i] && (all[i].includes("{") || /[:=]\s*$/.test(all[i]))) break; } }
      else if (eLine - sLine + 1 > cap) {
        // cAST migration (arXiv:2506.15655): over the line budget → cut at a STRUCTURAL boundary (end of a whole
        // child member/statement) instead of mid-statement, so the body stays syntactically whole. Falls back to
        // the plain line-cap when tree-sitter can't help (deps absent / unsupported lang / parse fail).
        let chunk = null; try { chunk = await tsChunkEnd(r.file, sLine, eLine, cap); } catch { /* fall back */ }
        if (chunk && chunk.endRow > sLine && chunk.endRow < eLine) { end = chunk.endRow; structural = true; }
        else end = sLine + cap - 1;
      }
      const body = all.slice(sLine, end + 1).join("\n");
      const omitted = eLine - end;
      const note = omitted > 0 ? `\n… ${omitted} more line(s)${sigOnly ? " (signature only — omit signatureOnly for the body)" : structural ? ` (structural cut — whole member(s) omitted, no mid-statement break; raise VTS_SYMBOL_MAX_LINES, now ${cap})` : ` — raise VTS_SYMBOL_MAX_LINES (now ${cap})`}.` : "";
      const fp = r.file.replace(/\\/g, "/");
      const ambl = r.ambiguous > 1 ? ` (${r.ambiguous} same-named — pass line= to disambiguate)` : "";
      try { recordQueryResults(root, [r.file]); } catch { /* best-effort */ }
      // #4 read-avoidance framing (Semble's "combined with file reading"): read_symbol's real win is the
      // WHOLE-FILE Read it replaces, so the savings baseline is the whole file (not the tiny {file,range}) —
      // the ledger then credits the avoided read, not ~0. (search/refs keep their index baseline.)
      return finishOut(all.join("\n"), backendAdvisory(backendName, root) + `${SYMBOL_KIND[r.ds.kind] || "symbol"} "${a.symbol}" @ ${fp}:${sLine + 1}-${eLine + 1}${ambl} (backend: ${backendName}):\n` + body + note);
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
      let written = 0; let p4ed = 0; const failed = [];
      for (const [p, edits] of m) {
        if (ensureWritableForEdit(p)) p4ed++; // P4: open each read-only ref-file for edit before writing
        try { fs.writeFileSync(p, applyEditsToText(fs.readFileSync(p, "utf8"), edits)); written++; }
        catch (e) { failed.push(`${p.replace(/\\/g, "/")} (${e.code || e.message})`); }
      }
      const p4note = p4ed ? ` (p4 edit'd ${p4ed} file(s))` : "";
      const note = failed.length ? `\n⚠ ${failed.length} file(s) not written (read-only? check out of Perforce first; vts auto-runs \`p4 edit\` unless VTS_P4_EDIT=0): ${failed.slice(0, 5).join("; ")}` : "";
      return finishOut(we, `rename → "${a.newName}" APPLIED: ${total} edit(s) across ${written}/${m.size} file(s).${p4note}${note}\n${shown}`);
    }
    if (name === "replace_symbol_body" || name === "insert_symbol" || name === "safe_delete") {
      const c = await getClient(root, backendName);
      const r = await resolveSymbolForEdit(c, root, backendName, a);
      if (r.error) return err(`${name}: ${r.error}`);
      try { recordEditEvent("symbol-edit"); } catch { /* best-effort: adoption ledger feeds the edit-steer loop */ }
      const apply = a.apply === true || a.apply === "true";
      const rng = r.ds.range;
      const ambl = r.ambiguous > 1 ? ` (⚠ ${r.ambiguous} symbols named "${a.symbol}"; editing the first — pass line=<0-based> to disambiguate)` : "";
      if (name === "replace_symbol_body") {
        if (a.body == null) return err("replace_symbol_body needs `body` (the new full text for the declaration — signature + body).");
        return symbolEditResult(r.file, { range: rng, newText: String(a.body) }, apply, `replace_symbol_body "${a.symbol}"${ambl}`, r.ds);
      }
      if (name === "insert_symbol") {
        if (a.text == null) return err("insert_symbol needs `text` (the declaration to insert).");
        const before = String(a.position || "after").toLowerCase() === "before";
        const at = before ? rng.start : rng.end;
        const newText = before ? String(a.text) + "\n" : "\n" + String(a.text);
        return symbolEditResult(r.file, { range: { start: at, end: at }, newText }, apply, `insert_symbol ${before ? "before" : "after"} "${a.symbol}"${ambl}`, r.ds);
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
