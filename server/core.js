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
import { LspClient, fromUri } from "./lsp.js";
import { pickBackend, BACKENDS, clangdAdvisory } from "./backends/index.js";
import { recordQueryResults } from "./warmset.js";

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
const CONFIG_KEYS = ["projectPath", "backend", "maxResults"];

const tok = (s) => Math.round(Buffer.byteLength(String(s), "utf8") / 4);
const SYMBOL_KIND = { 5: "class", 6: "method", 9: "ctor", 12: "func", 13: "var", 23: "struct", 26: "type", 11: "interface", 10: "enum" };

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
    const c = new LspClient(b.cmd, b.args(root), { cwd: root });
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

// ---- single dispatcher (async) ----
export async function runTool(name, a = {}) {
  const out = (text) => ({ text, isError: false });
  const err = (text) => ({ text, isError: true });
  const finishOut = (rawObj, body) => {
    const rawTok = tok(JSON.stringify(rawObj)), outTok = tok(body);
    try { recordSavings(rawTok, outTok); } catch { /* best-effort */ }
    return out(body + savingsLine(rawTok, outTok));
  };
  try {
    if (name === "vts_setup") {
      const { current, changed } = applySetup(a);
      return out((changed.length ? `Updated ${changed.join(", ")}.` : "No recognized keys.") + `\nConfig: ${CONFIG_FILE}\n${JSON.stringify(current, null, 2)}`);
    }
    if (name === "vts_config") {
      return out(`Effective settings (env > config > default):\n` + JSON.stringify({ projectPath: PROJECT_PATH || "(unset)", backend: BACKEND || "(auto)", maxResults: MAX_RESULTS }, null, 2) + `\n\nConfig file: ${CONFIG_FILE}`);
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

    const root = a.projectPath || PROJECT_PATH || process.cwd();
    const backendName = a.backend || BACKEND || pickBackend(root);
    if (!backendName) return err(`No backend resolved. Pass backend=clangd|roslyn, set VTS_BACKEND, or ensure the project root has compile_commands.json (C++) or a .sln/.csproj (C#).`);
    const max = Number(a.maxResults) || MAX_RESULTS;

    if (name === "search_symbol") {
      if (!a.q) return err("search_symbol needs q (the symbol name/substring).");
      const c = await getClient(root, backendName);
      const syms = (await c.symbol(String(a.q))) || [];
      try { recordQueryResults(root, syms.map((s) => fromUri(s.location.uri))); } catch { /* best-effort */ }
      const adv = backendAdvisory(backendName);
      if (!syms.length) return finishOut([], adv + `No symbols matching "${a.q}" (backend: ${backendName}).`);
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
    return err(`Unknown tool: ${name}`);
  } catch (e) {
    return err(`vs-token-safer error: ${e.message}`);
  }
}
