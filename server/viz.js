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
import { findProjectRoot } from "./backends/index.js";

// Which repository a file belongs to (nearest project root's basename) — so the viz can group/color nodes by
// repo. Cached per dir. "external" when no enclosing project. Mirrors core.js repoLabelFor for the include graph.
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

const CONFIG_DIR = path.join(os.homedir(), ".vs-token-safer");
const SAVINGS_FILE = process.env.VTS_SAVINGS_FILE || path.join(CONFIG_DIR, "savings.json");
const GRAPH_FILE = process.env.VTS_INCLUDE_GRAPH || path.join(CONFIG_DIR, "include-graph.json");
// The bundled sibling gamedev-log-analyzer keeps its OWN savings ledger (same shape) — its log-compaction
// savings count toward the same goal (fewer tokens reach the model), so the dashboard folds them in.
const GAMEDEV_SAVINGS_FILE = process.env.VTS_GAMEDEV_SAVINGS_FILE || path.join(os.homedir(), ".gamedev-log-analyzer", "savings.json");
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")) || {}; } catch { return {}; } };
const envInt = (name, def) => { const v = parseInt(process.env[name], 10); return Number.isFinite(v) && v > 0 ? v : def; };

// Build the dashboard model from the local ledgers + include-graph cache + a language census of `root`.
// Bounded (node cap) so a huge include graph can't choke the browser. Pure, best-effort — every section
// degrades to empty/zero on a missing store rather than throwing.
export function buildVizData(root) {
  const s = readJson(SAVINGS_FILE);
  const gd = readJson(GAMEDEV_SAVINGS_FILE);
  // COMBINED savings — vts code-search + the bundled gamedev-log-analyzer's log compaction. Both keep fewer
  // tokens out of the model, so the headline total/ratio/$/runs sum them; `sources` carries the split.
  const vtsSaved = Math.max(0, (s.rawTok || 0) - (s.outTok || 0));
  const gdSaved = Math.max(0, (gd.rawTok || 0) - (gd.outTok || 0));
  const rawCombined = (s.rawTok || 0) + (gd.rawTok || 0);
  const outCombined = (s.outTok || 0) + (gd.outTok || 0);
  const totalSaved = Math.max(0, rawCombined - outCombined);
  const ratio = outCombined > 0 ? +(rawCombined / outCombined).toFixed(1) : 0;
  const runsCombined = (s.runs || 0) + (gd.runs || 0);
  const sources = [{ key: "vs-token-safer", name: "code search", saved: vtsSaved, runs: s.runs || 0 }];
  if (gdSaved > 0 || gd.runs) sources.push({ key: "gamedev-log-analyzer", name: "log analysis", saved: gdSaved, runs: gd.runs || 0 });
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

  // PRECISION LADDER (the paper's identity made visible): vts answers at the highest precision it can reach
  // and labels which rung. Each rung carries its engine, WHEN it applies, the completeness-certificate label
  // it stamps, and — where the per-tool ledger attributes UNAMBIGUOUSLY — live saved/runs.
  // ATTRIBUTION HONESTY (the per-tool ledger has no per-tier tag): the exact rung sums ONLY tools that are
  // never anything but semantic-code — search_symbol/find_references/goto/hover/rename/diagnostics. The five
  // DUAL-USE tools (read_symbol/document_symbols/replace_symbol_body/insert_symbol/safe_delete) also serve
  // the SECTION tier (structTool runs them on .md/.toml/.yaml), so their savings can't be split code-vs-doc
  // from the ledger alone — they are deliberately LEFT OUT of every rung's `saved` (they still count in the
  // headline total + the per-tool bars). So a rung's `saved` is a clean lower bound, never cross-attributed.
  // Syntactic activity flows through the exact tools as a documented fallback; its own saved stays 0 (reach
  // shown instead). Section/syntactic show `reach`, not `saved` — no rung claims another's tokens.
  const toolStat = (names) => names.reduce((a, n) => {
    const v = (s.tools || {})[n];
    if (v) { a.saved += Math.max(0, (v.rawTok || 0) - (v.outTok || 0)); a.runs += v.runs || 0; }
    return a;
  }, { saved: 0, runs: 0 });
  const EXACT_TOOLS = ["search_symbol", "find_references", "goto_definition", "hover", "rename", "diagnostics"];
  const exactStat = toolStat(EXACT_TOOLS), fuzzyStat = toolStat(["concept_search"]), fsStat = toolStat(["find_files", "search_text"]);
  const tiers = [
    { key: "exact", rung: 1, name: "Exact", engine: "Language server — clangd · Roslyn · tsserver · pyright", when: "you know the name and a toolchain is present", cert: "COMPLETE", tools: EXACT_TOOLS, saved: exactStat.saved, runs: exactStat.runs },
    { key: "syntactic", rung: 2, name: "Syntactic", engine: "tree-sitter — 17 languages, zero setup", when: "no toolchain — declarations + tag-query references", cert: "SYNTACTIC", tools: [], reach: "17 languages", saved: 0, runs: 0 },
    { key: "fuzzy", rung: 3, name: "Fuzzy", engine: "concept dictionary mined from the repo's own naming — no embeddings", when: "you only know the intent, not the symbol name", cert: "SYNTACTIC", tools: ["concept_search"], saved: fuzzyStat.saved, runs: fuzzyStat.runs },
    { key: "section", rung: 4, name: "Section", engine: "Markdown · TOML · YAML · JSON · … addressed by heading", when: "it's a doc or config, not code", cert: "COMPLETE", tools: [], reach: "md · mdx · adoc · rst · toml · ini · yaml · json · txt", saved: 0, runs: 0 },
  ];
  // SURFACE COVERAGE (the "whole repo an agent sees" pillar): semantic backends detected in this root + the
  // syntactic language reach + the document formats. filesystem (find_files/search_text) is the non-tiered
  // sanctioned grep replacement.
  const surfaces = {
    semantic: census, // per-backend file counts in this root
    syntacticLangs: 17, // tree-sitter: 10 hand-tuned + 7 tags-query
    docFormats: ["markdown", "mdx", "asciidoc", "rst", "toml", "ini", "yaml", "json", "txt"],
    filesystem: { saved: fsStat.saved, runs: fsStat.runs },
  };
  // Completeness-certificate legend (the precision-honesty pillar) — the labels vts stamps on every answer.
  const certs = [
    { key: "COMPLETE", desc: "semantic, every match returned (within the indexed/scoped set)" },
    { key: "SYNTACTIC", desc: "tree-sitter declarations, zero setup — does not resolve refs/overloads/types" },
    { key: "PARTIAL", desc: "capped or time-boxed — more exists, recoverable via the tee / a higher cap" },
    { key: "INCONCLUSIVE", desc: "index still building or a 0 from a truncated walk — not a true zero" },
  ];

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
    const nodes = ranked.map((p) => ({ id: p, label: path.basename(p), repo: repoLabelFor(p), weight: fanin.get(p) || 0 }));
    const links = rawLinks.filter(([a, b]) => keep.has(a) && keep.has(b)).map(([a, b]) => ({ source: a, target: b }));
    return { nodes, links };
  })();

  return {
    root: root || "",
    savings: { totalSaved, rawTok: rawCombined, outTok: outCombined, ratio, runs: runsCombined, usd: +((totalSaved / 1e6) * usdRate).toFixed(2), days, tools, sources },
    census,
    tiers,
    surfaces,
    certs,
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
