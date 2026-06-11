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
import { LspClient, fromUri, langIdForPath } from "./lsp.js";
import { pickBackend, BACKENDS, clangdAdvisory } from "./backends/index.js";
import { recordQueryResults, languageCensus } from "./warmset.js";

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
const CONFIG_KEYS = ["projectPath", "backend", "maxResults", "prewarmBackends"];

const tok = (s) => Math.round(Buffer.byteLength(String(s), "utf8") / 4);
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
function recordSavings(rawTok, outTok) {
  const s = readSavings();
  s.runs = (s.runs || 0) + 1;
  s.rawTok = (s.rawTok || 0) + rawTok;
  s.outTok = (s.outTok || 0) + outTok;
  const saved = rawTok - outTok;
  if (saved > (s.bestSaved || 0)) { s.bestSaved = saved; s.bestRaw = rawTok; s.bestOut = outTok; }
  try { fs.mkdirSync(path.dirname(SAVINGS_FILE), { recursive: true }); fs.writeFileSync(SAVINGS_FILE, JSON.stringify(s, null, 2)); } catch { /* best-effort */ }
}
function savingsLine(rawTok, outTok) {
  if (rawTok < 2000) return "";
  const ratio = outTok > 0 ? Math.round(rawTok / outTok) : rawTok;
  const pct = (100 * (1 - outTok / Math.max(rawTok, 1))).toFixed(1);
  return `\n\n✓ Saved ~${(rawTok - outTok).toLocaleString()} tokens here (${pct}% / ${ratio}× smaller than the raw index response).`;
}
function savingsReport() {
  const s = readSavings();
  if (!s.runs) return "No savings recorded yet — run a search first.";
  const ratio = s.outTok > 0 ? Math.round(s.rawTok / s.outTok) : "∞";
  const best = s.bestRaw ? `\n  biggest single run: ${s.bestRaw.toLocaleString()} → ${s.bestOut.toLocaleString()} tok` : "";
  return `vs-token-safer savings (local, ${s.runs} search(es))\n  total saved: ~${(s.rawTok - s.outTok).toLocaleString()} tokens vs forwarding raw index responses\n  raw → output: ${s.rawTok.toLocaleString()} → ${s.outTok.toLocaleString()} tok (~${ratio}× smaller)${best}\n\nLedger: ${SAVINGS_FILE}`;
}

// ---- LSP client cache (one per root+backend; reused across calls in a process) ----
// key -> Promise<LspClient>. We cache the PROMISE (not the resolved client) so a boot-time pre-warm
// racing the first real query share ONE clangd instead of spawning two (the warmup is expensive).
const clients = new Map();
function getClient(root, backendName) {
  const key = `${backendName}|${root}`;
  if (clients.has(key)) return clients.get(key);
  const b = BACKENDS[backendName];
  const p = (async () => {
    const c = new LspClient(b.cmd, b.args(root), { cwd: root, shell: process.platform === "win32" && !!b.winShell });
    await c.initialize(root);
    if (typeof b.afterInit === "function") await b.afterInit(c, root); // e.g. Roslyn solution/open + load wait
    return c;
  })();
  clients.set(key, p);
  p.catch(() => clients.delete(key)); // a failed warmup shouldn't poison the cache — allow a retry
  return p;
}
export async function disposeClients() {
  for (const p of clients.values()) { try { (await p).shutdown(); } catch { /* ignore */ } }
  clients.clear();
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
function backendAdvisory(backendName) {
  if (backendName !== "clangd" || _advisoryShown) return "";
  const a = clangdAdvisory(BACKENDS.clangd.cmd);
  if (a) _advisoryShown = true;
  return a ? a + "\n\n" : "";
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
function fmtLocations(locs, max, label) {
  const arr = Array.isArray(locs) ? locs : locs ? [locs] : [];
  const shown = arr.slice(0, max);
  const body = shown.map((l) => `  @ ${locLine(l.uri, l.range)}`).join("\n");
  const more = arr.length - shown.length;
  return `${arr.length} ${label}:\n${body}${more > 0 ? `\n… ${more} more.` : ""}`;
}
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
function fmtDocSymbols(syms, max, file) {
  const rows = [];
  const walk = (arr, parent) => {
    for (const s of arr || []) {
      const r = s.range || (s.location && s.location.range);
      const ln = r ? r.start.line + 1 : 1;
      const loc = s.location ? fromUri(s.location.uri).replace(/\\/g, "/") : file;
      rows.push(`${SYMBOL_KIND[s.kind] || `k${s.kind}`} ${parent ? parent + "::" : ""}${s.name}  @ ${loc}:${ln}`);
      if (s.children) walk(s.children, (parent ? parent + "::" : "") + s.name);
    }
  };
  walk(syms, "");
  const shown = rows.slice(0, max);
  return `${rows.length} symbol(s):\n` + shown.join("\n") + (rows.length > shown.length ? `\n… ${rows.length - shown.length} more.` : "");
}
// File-by-name search (no LSP) — basename glob (* ?) or substring, bounded. Sanctioned replacement for
// `find -name` (which the grep-block hook discourages).
function findFilesUnder(root, q, max) {
  const useGlob = /[*?]/.test(q);
  const re = useGlob ? new RegExp("^" + q.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i") : null;
  const ql = q.toLowerCase();
  const out = [];
  const stack = [root]; let scanned = 0;
  while (stack.length && out.length < max && scanned < 300000) {
    const dir = stack.pop();
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith(".") && e.name !== "node_modules") stack.push(p); }
      else { scanned++; if (re ? re.test(e.name) : e.name.toLowerCase().includes(ql)) { out.push(p.replace(/\\/g, "/")); if (out.length >= max) break; } }
    }
  }
  return out;
}
// Bounded, token-capped raw-text search (no LSP) — the sanctioned alternative to grep for strings/comments
// /config keys the symbol index can't answer. Returns file:line: trimmed-line, capped in count and time.
function scanTextUnder(root, q, max) {
  let re; try { re = new RegExp(q); } catch { re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); }
  const exts = /\.(c|cc|cxx|cpp|h|hpp|hh|inl|ipp|tpp|cs|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi)$/i;
  const out = []; const stack = [root]; const t0 = Date.now();
  while (stack.length && out.length < max && Date.now() - t0 < 4000) {
    const dir = stack.pop();
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith(".") && e.name !== "node_modules") stack.push(p); continue; }
      if (!exts.test(e.name)) continue;
      let txt; try { txt = fs.readFileSync(p, "utf8"); } catch { continue; }
      if (!re.test(txt)) continue;
      const lines = txt.split(/\r?\n/);
      for (let i = 0; i < lines.length && out.length < max; i++) if (re.test(lines[i])) out.push(`${p.replace(/\\/g, "/")}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
      if (out.length >= max) break;
    }
  }
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

// ---- single dispatcher (async) ----
export async function runTool(name, a = {}) {
  const out = (text) => ({ text, isError: false });
  const err = (text) => ({ text, isError: true });
  const finishOut = (rawObj, body) => {
    const rawTok = tok(JSON.stringify(rawObj)), outTok = tok(body);
    try { recordSavings(rawTok, outTok); } catch { /* best-effort */ }
    // One-time setup nudge if never configured; additive log steer if this call targets a log. Neither blocks.
    let pre = "";
    if (!_setupNudged && needsSetup()) { _setupNudged = true; pre = SETUP_NUDGE; }
    return out(pre + body + (looksLogTarget(a) ? LOG_STEER : "") + savingsLine(rawTok, outTok));
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
      } catch { /* census is best-effort */ }
      return out((changed.length ? `Updated ${changed.join(", ")}.` : "No recognized keys.") + langLine + `\nConfig: ${CONFIG_FILE}\n${JSON.stringify(current, null, 2)}`);
    }
    if (name === "vts_config") {
      return out(`Effective settings (env > config > default):\n` + JSON.stringify({ projectPath: PROJECT_PATH || "(unset)", backend: BACKEND || "(auto)", maxResults: MAX_RESULTS, prewarmBackends: PREWARM_BACKENDS || "(auto)" }, null, 2) + `\n\nConfig file: ${CONFIG_FILE}`);
    }
    if (name === "vts_savings") return out(savingsReport());
    if (name === "vts_savings_reset") { try { fs.writeFileSync(SAVINGS_FILE, "{}"); } catch { /* ignore */ } return out("Savings ledger cleared."); }
    if (name === "vts_warmup") {
      const root = a.projectPath || PROJECT_PATH || process.cwd();
      const backendName = a.backend || BACKEND || pickBackend(root);
      if (!backendName) return err(`No backend to warm. Pass backend=clangd|roslyn or ensure ${root} has compile_commands.json / a .sln.`);
      const t0 = Date.now();
      await getClient(root, backendName); // spawn + afterInit (index-ready wait) → primes the on-disk + in-process index
      return out(backendAdvisory(backendName) + `Warmed ${backendName} for ${root} in ${((Date.now() - t0) / 1000).toFixed(1)}s. Queries in this process are now warm; clangd's on-disk index (.cache/clangd) also persists for faster cold starts.`);
    }
    // find_files / search_text are pure filesystem (no language server) — they work even when no backend
    // is set, and are the sanctioned, token-capped replacements for `find -name` / `grep`.
    if (name === "find_files") {
      if (!a.q) return err("find_files needs q (a filename substring or glob like *Manager.cpp).");
      const root = a.projectPath || PROJECT_PATH || process.cwd();
      const max = Number(a.maxResults) || MAX_RESULTS;
      const files = findFilesUnder(root, String(a.q), max);
      if (!files.length) return finishOut([], `No files matching "${a.q}" under ${root}.` + LOG_EMPTY_HINT);
      return finishOut(files, `${files.length} file(s) matching "${a.q}":\n` + files.join("\n"));
    }
    if (name === "search_text") {
      if (!a.q) return err("search_text needs q (a string or regex to find in code).");
      const root = a.projectPath || PROJECT_PATH || process.cwd();
      const max = Number(a.maxResults) || MAX_RESULTS;
      const hits = scanTextUnder(root, String(a.q), max);
      if (!hits.length) return finishOut([], `No text matches for "${a.q}" under ${root}.` + LOG_EMPTY_HINT);
      return finishOut(hits, `${hits.length} match(es) for "${a.q}" (text search; for symbols prefer search_symbol):\n` + hits.join("\n"));
    }

    const root = a.projectPath || PROJECT_PATH || process.cwd();
    const backendName = a.backend || BACKEND || pickBackend(root);
    if (!backendName) return err(`No backend resolved. Pass backend=clangd|roslyn|typescript|pyright, set VTS_BACKEND, or ensure the project root has compile_commands.json (C++), a .sln/.csproj (C#), a tsconfig/package.json (JS/TS), or a pyproject.toml/*.py (Python).`);
    const max = Number(a.maxResults) || MAX_RESULTS;
    const lang = langIdForPath(a.path, backendName); // languageId for didOpen (hover/document_symbols/rename); unused by search_symbol

    if (name === "search_symbol") {
      if (!a.q) return err("search_symbol needs q (the symbol name/substring).");
      const c = await getClient(root, backendName);
      const syms = (await c.symbol(String(a.q))) || [];
      try { recordQueryResults(root, syms.map((s) => fromUri(s.location.uri))); } catch { /* best-effort */ }
      const adv = backendAdvisory(backendName);
      if (!syms.length) {
        // tsserver / pyright answer workspace/symbol from the files they have OPEN/indexed, so a symbol
        // whose file the warm-up didn't open (or a non-exported local) can come back empty even though it
        // exists. Fall back to a bounded literal text search so it's still locatable (clangd/roslyn index
        // the whole project, so they skip this). Clearly labeled: text matches, not semantic declarations.
        if (backendName === "typescript" || backendName === "pyright") {
          const hits = scanTextUnder(root, String(a.q), Math.min(max, 20));
          if (hits.length) return finishOut(hits, adv + `No indexed symbol for "${a.q}" — ${backendName} answers from open/indexed files, so a symbol whose file isn't open yet (or a non-exported local) can be missed. Literal text matches instead (open the file or run document_symbols to confirm the decl):\n` + hits.join("\n"));
        }
        return finishOut([], adv + `No symbols matching "${a.q}" (backend: ${backendName}).` + EMPTY_HINT);
      }
      return finishOut(syms, adv + `${syms.length} symbol(s) matching "${a.q}" (backend: ${backendName}, root: ${root}):\n` + fmtSymbols(syms, max));
    }
    if (name === "find_references") {
      if (!a.path || a.line == null || a.character == null) return err("find_references needs path, line, character (0-based position of the symbol).");
      const c = await getClient(root, backendName);
      const locs = (await c.references(a.path, Number(a.line), Number(a.character), a.includeDeclaration === true)) || [];
      try { recordQueryResults(root, (Array.isArray(locs) ? locs : [locs]).filter(Boolean).map((l) => fromUri(l.uri))); } catch { /* best-effort */ }
      return finishOut(locs, backendAdvisory(backendName) + `references of ${a.path}:${Number(a.line) + 1} (backend: ${backendName}):\n` + fmtLocations(locs, max, "reference(s)"));
    }
    if (name === "goto_definition") {
      if (!a.path || a.line == null || a.character == null) return err("goto_definition needs path, line, character (0-based position).");
      const c = await getClient(root, backendName);
      const locs = (await c.definition(a.path, Number(a.line), Number(a.character))) || [];
      try { recordQueryResults(root, (Array.isArray(locs) ? locs : [locs]).filter(Boolean).map((l) => fromUri(l.uri))); } catch { /* best-effort */ }
      return finishOut(locs, backendAdvisory(backendName) + `definition of ${a.path}:${Number(a.line) + 1} (backend: ${backendName}):\n` + fmtLocations(locs, max, "definition(s)"));
    }
    if (name === "hover") {
      if (!a.path || a.line == null || a.character == null) return err("hover needs path, line, character (0-based position).");
      const c = await getClient(root, backendName);
      c.didOpen(a.path, lang); // ensure the TU is open so clangd/Roslyn can answer at the position
      const h = await c.hover(a.path, Number(a.line), Number(a.character));
      return finishOut(h || {}, backendAdvisory(backendName) + `hover ${a.path}:${Number(a.line) + 1} (backend: ${backendName}):\n` + fmtHover(h));
    }
    if (name === "document_symbols") {
      if (!a.path) return err("document_symbols needs path (the file to outline).");
      const c = await getClient(root, backendName);
      c.didOpen(a.path, lang);
      const syms = (await c.documentSymbol(a.path)) || [];
      try { recordQueryResults(root, [a.path]); } catch { /* best-effort */ }
      return finishOut(syms, backendAdvisory(backendName) + `outline of ${a.path} (backend: ${backendName}):\n` + fmtDocSymbols(syms, max, a.path.replace(/\\/g, "/")));
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
    return err(`Unknown tool: ${name}`);
  } catch (e) {
    return err(`vs-token-safer error: ${e.message}`);
  }
}
