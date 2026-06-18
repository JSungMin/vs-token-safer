/*
 * vs-token-safer dashboard data + page — the "what vts knows + how much it saved" view, rendered as an
 * interactive local dashboard (served by serve.js on 127.0.0.1 ONLY; never off-machine — zero-transmission
 * holds). Pure assembly over the EXISTING local stores (savings ledger, include-graph cache, language
 * census). The page itself lives in `dashboard.html` (a SELF-CONTAINED file — inlined CSS/JS, NO CDN /
 * external script, works offline; the force-graph is vanilla JS, no D3) so design iteration doesn't fight
 * JS template-literal escaping; renderDashboardHtml() just reads it. buildVizData + renderDashboardHtml are
 * exported so the eval tests them without a server. Reads the same files core.js/warmset.js write, honoring
 * the VTS_* path overrides.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { languageCensus } from "./warmset.js";

const CONFIG_DIR = path.join(os.homedir(), ".vs-token-safer");
const SAVINGS_FILE = process.env.VTS_SAVINGS_FILE || path.join(CONFIG_DIR, "savings.json");
const GRAPH_FILE = process.env.VTS_INCLUDE_GRAPH || path.join(CONFIG_DIR, "include-graph.json");
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")) || {}; } catch { return {}; } };
const envInt = (name, def) => { const v = parseInt(process.env[name], 10); return Number.isFinite(v) && v > 0 ? v : def; };

// Build the dashboard model from the local ledgers + include-graph cache + a language census of `root`.
// Bounded (node cap) so a huge include graph can't choke the browser. Pure, best-effort — every section
// degrades to empty/zero on a missing store rather than throwing.
export function buildVizData(root) {
  const s = readJson(SAVINGS_FILE);
  const totalSaved = Math.max(0, (s.rawTok || 0) - (s.outTok || 0));
  const ratio = s.outTok > 0 ? +(s.rawTok / s.outTok).toFixed(1) : 0;
  const usdRate = parseFloat(process.env.VTS_USD_PER_MTOK || "3") || 3;
  // last-30-day buckets (saved tokens / day), oldest→newest, zero-filled for the trend chart.
  const days = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const k = d.toISOString().slice(0, 10);
    const b = (s.days || {})[k];
    days.push({ k, saved: b ? Math.max(0, b.rawTok - b.outTok) : 0 });
  }
  const tools = Object.entries(s.tools || {})
    .map(([tool, v]) => ({ tool, saved: Math.max(0, (v.rawTok || 0) - (v.outTok || 0)), runs: v.runs || 0 }))
    .sort((a, b) => b.saved - a.saved).slice(0, 12);

  let census = { clangd: 0, roslyn: 0, typescript: 0, pyright: 0, total: 0 };
  try { if (root) census = languageCensus(root); } catch { /* best-effort */ }

  // include-graph → force-graph: nodes = cached files, edges = include relationships (basename match), node
  // weight = include fan-in (how many files include it). Capped to the highest-weight VTS_VIZ_MAX_NODES so the
  // browser sim stays smooth; links to dropped nodes are pruned.
  const graph = (() => {
    const g = readJson(GRAPH_FILE);
    const entries = Object.entries(g).filter(([, e]) => e && Array.isArray(e.i));
    if (!entries.length) return { nodes: [], links: [] };
    const byBase = new Map();
    for (const [p] of entries) { const b = path.basename(p).toLowerCase(); if (!byBase.has(b)) byBase.set(b, p); }
    const fanin = new Map();
    const rawLinks = [];
    for (const [p, e] of entries) {
      const seen = new Set();
      for (const b of e.i) {
        const tgt = byBase.get(b);
        if (tgt && tgt !== p && !seen.has(tgt)) { seen.add(tgt); rawLinks.push([p, tgt]); fanin.set(tgt, (fanin.get(tgt) || 0) + 1); }
      }
    }
    const cap = envInt("VTS_VIZ_MAX_NODES", 200);
    const ranked = entries.map(([p]) => p).sort((a, b) => (fanin.get(b) || 0) - (fanin.get(a) || 0)).slice(0, cap);
    const keep = new Set(ranked);
    const nodes = ranked.map((p) => ({ id: p, label: path.basename(p), weight: fanin.get(p) || 0 }));
    const links = rawLinks.filter(([a, b]) => keep.has(a) && keep.has(b)).map(([a, b]) => ({ source: a, target: b }));
    return { nodes, links };
  })();

  return {
    root: root || "",
    savings: { totalSaved, rawTok: s.rawTok || 0, outTok: s.outTok || 0, ratio, runs: s.runs || 0, usd: +((totalSaved / 1e6) * usdRate).toFixed(2), days, tools },
    census,
    graph,
  };
}

// The self-contained dashboard page, read from dashboard.html (sibling file). It has all CSS/JS inlined —
// NO external <script src>/CDN (renders offline; an external fetch would break zero-transmission) — and
// fetches /data (same-origin, localhost) to render. Kept as a file (not an inline template literal) so the
// page's own backticks/${} don't fight JS escaping and design iteration is clean.
export function renderDashboardHtml() {
  return fs.readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");
}
