// Counterfactual shadow measurement — the quasi-controlled answer to the construct-validity question
// "did the agent reach the SAME answer it would have reached from grep?". When VTS_COUNTERFACTUAL=1 (opt-in:
// it doubles local CPU per semantic query, OFF by default), a semantic search (search_symbol /
// find_references) ALSO runs a LOCAL shadow grep over the same scope. The shadow result NEVER reaches the
// model — only the comparison is recorded: how many tokens grep WOULD have spent, how many vts spent, and how
// the answer SETS relate. Semantic search is expected to REFINE grep — a SUBSET of grep's textual hits (it
// drops comment / string-literal / substring look-alikes) while still covering the real referents — so a
// "subset" verdict is the desired one, not a miss. This turns the observational token-saving telemetry into a
// measured comparison against the baseline it claims to beat. Zero transmission: a local JSON ledger, no
// network; local CPU only. Mirrors the savings-ledger conventions in core.js.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonFsPath } from "./lsp.js";

const tok = (s) => Math.round(Buffer.byteLength(String(s), "utf8") / 4); // core.js:119 parity
export const counterfactualOn = () => /^(1|true|on|yes)$/i.test(String(process.env.VTS_COUNTERFACTUAL ?? "0"));
const LEDGER = () => process.env.VTS_COUNTERFACTUAL_FILE || path.join(os.homedir(), ".vs-token-safer", "counterfactual.json");

export function readCounterfactual() {
  try { return JSON.parse(fs.readFileSync(LEDGER(), "utf8")); } catch { return { runs: 0, tools: {} }; }
}
function write(o) {
  try { const p = LEDGER(); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2)); } catch { /* best-effort */ }
}

// A scanTextUnder hit is `<abs-path>:<line>: <text>` (forward-slash path, 1-based line). Parse to the
// canonical `<canonpath>:<line>` key so it compares against a vts location key on the same basis. The path
// can itself contain a drive colon (`G:/…`), so match the LAST `:<digits>:` — `.*` is greedy.
const HIT_RE = /^(.*):(\d+):/;
export function grepKey(hit) {
  const m = HIT_RE.exec(String(hit));
  if (!m) return null;
  return canonFsPath(m[1]) + ":" + m[2];
}
// A vts location → the same `<canonpath>:<line>` key (1-based line to match the grep hit).
export function locKey(uri, range) {
  const line = (((range || {}).start || {}).line ?? 0) + 1;
  return canonFsPath(uri) + ":" + line;
}

// Relate two answer sets by (canonical-path, line). "equal" | "subset" (vts ⊆ grep — the REFINEMENT case) |
// "superset" (vts ⊇ grep — vts found cross-file/semantic referents grep's literal scan missed) | "overlap" |
// "disjoint". Empty grep set with a non-empty vts set → "superset" (vts found what a literal scan couldn't).
export function relateSets(vtsKeys, grepKeys) {
  const v = new Set(vtsKeys.filter(Boolean));
  const g = new Set(grepKeys.filter(Boolean));
  if (!v.size && !g.size) return "equal";
  if (!g.size) return "superset";
  if (!v.size) return "subset";
  let inG = 0; for (const k of v) if (g.has(k)) inG++;
  const vSubG = inG === v.size;
  const gSubV = [...g].every((k) => v.has(k));
  if (vSubG && gSubV) return "equal";
  if (vSubG) return "subset";
  if (gSubV) return "superset";
  return inG ? "overlap" : "disjoint";
}

// Record one comparison into the per-tool ledger.
export function recordCounterfactual(tool, { grepTok = 0, vtsTok = 0, relation = "n/a", truncatedBaseline = false } = {}) {
  const o = readCounterfactual();
  o.runs = (o.runs || 0) + 1;
  o.tools = o.tools || {};
  const t = (o.tools[tool] = o.tools[tool] || { runs: 0, grepTok: 0, vtsTok: 0, truncatedBaseline: 0, rel: {} });
  t.runs++; t.grepTok += grepTok; t.vtsTok += vtsTok;
  if (truncatedBaseline) t.truncatedBaseline = (t.truncatedBaseline || 0) + 1;
  t.rel = t.rel || {};
  t.rel[relation] = (t.rel[relation] || 0) + 1;
  write(o);
  return o;
}
export { tok as cfTok };

// A `vts savings`-style section: tokens grep WOULD have spent vs vts, and the distribution of set relations.
// Returns "" when no counterfactual data exists (the feature is opt-in, so this is the common case).
export function counterfactualReport(o = readCounterfactual()) {
  if (!o.runs) return "";
  let grepTok = 0, vtsTok = 0, truncated = 0; const rel = {};
  for (const t of Object.values(o.tools || {})) {
    grepTok += t.grepTok || 0; vtsTok += t.vtsTok || 0; truncated += t.truncatedBaseline || 0;
    for (const [k, n] of Object.entries(t.rel || {})) rel[k] = (rel[k] || 0) + n;
  }
  const ratio = vtsTok > 0 ? (grepTok / vtsTok).toFixed(1) : "∞";
  const relStr = Object.entries(rel).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ") || "—";
  // On a giant tree the shadow grep truncates, so its token figure is a LOWER bound and its set relation is
  // not comparable — say so rather than present a misleading "disjoint".
  const caveat = truncated
    ? `\n  note: ${truncated} comparison(s) had a TRUNCATED grep baseline (capped/time-boxed on a large tree) ` +
      `— for those the grep tokens are a lower bound and the set relation is recorded as "baseline-truncated", not a verdict`
    : "";
  return `\n\nCounterfactual (shadow grep, ${o.runs} comparison(s) — opt-in VTS_COUNTERFACTUAL=1):` +
    `\n  grep would have spent ~${grepTok.toLocaleString()} tok vs vts ~${vtsTok.toLocaleString()} tok (~${ratio}× smaller)` +
    `\n  answer-set vs grep: ${relStr}  (subset = vts refined grep's textual hits; superset = vts found referents grep missed)` +
    caveat;
}
