/*
 * detect-changes.js — PURE risk model + diff→hunk parsing for the `detect_changes` tool (impact radius +
 * risk score for a git diff). No fs, no LSP, no git, no network — the caller (core.js) does the impure work
 * (git diff, document_symbols, buildCallGraph, cochangeNeighbors) and hands the assembled signals here. Kept
 * pure for the same reason as dce.js / cochange.js: it is testable with canned input, no toolchain (eval guard).
 *
 * CHARTER: this adds a SURFACE (a new question — "what does this diff touch, and how risky is it") not a rung.
 * The risk score is DELIBERATELY deterministic and inspectable — four code-mined channels, fixed weights, no
 * learned artifact, no click-feedback loop (that was critic-rejected elsewhere: self-confirming, non-
 * deterministic, unmeasurable). A reader can recompute the number by hand. Output stays capped file:line.
 */

// ---- diff parsing -------------------------------------------------------------------------------------
// Parse a unified `git diff` into per-file changed LINE RANGES (new-side), so the caller can map each range
// to the symbol that encloses it via document_symbols. We only need the new-side line numbers of added/
// context-changed hunks; deletions collapse to the hunk's start line.
export function parseDiffHunks(diffText) {
  if (typeof diffText !== "string" || !diffText) return [];
  const files = [];
  let cur = null;
  const lines = diffText.split("\n");
  for (const line of lines) {
    const mFile = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (mFile) {
      cur = { file: mFile[2], ranges: [], binary: false };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^Binary files /.test(line)) { cur.binary = true; continue; }
    // hunk header: @@ -oldStart,oldLen +newStart,newLen @@
    const mHunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (mHunk) {
      const start = Number(mHunk[1]);
      const len = mHunk[2] === undefined ? 1 : Number(mHunk[2]);
      // a pure deletion hunk has newLen 0 → still record the anchor line so a deleted symbol is caught
      cur.ranges.push({ start, end: start + Math.max(0, len - 1) });
    }
  }
  return files.filter((f) => !f.binary || f.ranges.length);
}

// A line is inside a symbol's [start,end] span (1-based, inclusive). Used to attribute a changed hunk to the
// enclosing declaration. When several symbols enclose a line (nested), the caller picks the innermost.
export function lineInSpan(line, start, end) {
  return line >= start && (end == null ? line === start : line <= end);
}

// ---- risk model ---------------------------------------------------------------------------------------
// Four channels, each normalized to [0,1] against a soft cap, then a fixed weighted sum. Weights sum to 1
// across the three "up" channels; test-reach is a separate DAMPENER (multiplies the risk down), because a
// well-tested blast radius is genuinely safer to touch — it is not just "one more additive signal".
//
//   blast      — how many transitive callers the changed symbols have. More reach = more can break.
//   depth      — how DEEP the caller cascade goes. A change felt 5 hops away is riskier than a leaf tweak.
//   coupling   — historical co-change partners of the changed files that are ABSENT from this diff. If files
//                that always move together no longer do, that is the classic "forgot to update the other one"
//                signal. This is the channel a pure call-graph misses and git history supplies for free.
//   testReach  — fraction of changed symbols whose caller set includes a test file. A dampener in [0,1].
//
// Env knobs (all optional; defaults chosen so a self-contained leaf edit reads LOW and a widely-called core
// symbol with missing co-change partners reads HIGH):
//   VTS_RISK_BLAST_CAP (20)      blast normalization cap
//   VTS_RISK_DEPTH_CAP (5)       depth normalization cap
//   VTS_RISK_COUPLING_CAP (8)    coupling-gap normalization cap
//   VTS_RISK_W_BLAST/DEPTH/COUPLING (0.5/0.2/0.3)   channel weights
//   VTS_RISK_TEST_DAMPEN (0.4)   max fraction the risk is reduced when every changed symbol is test-reached
//   VTS_RISK_MED/HIGH (0.34/0.67) band thresholds
const numEnv = (k, d) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v >= 0 ? v : d;
};

export function riskWeights(env = process.env) {
  const g = (k, d) => {
    const v = Number(env[k]);
    return Number.isFinite(v) && v >= 0 ? v : d;
  };
  return {
    blastCap: g("VTS_RISK_BLAST_CAP", 20),
    depthCap: g("VTS_RISK_DEPTH_CAP", 5),
    couplingCap: g("VTS_RISK_COUPLING_CAP", 8),
    wBlast: g("VTS_RISK_W_BLAST", 0.5),
    wDepth: g("VTS_RISK_W_DEPTH", 0.2),
    wCoupling: g("VTS_RISK_W_COUPLING", 0.3),
    testDampen: g("VTS_RISK_TEST_DAMPEN", 0.4),
    medBand: g("VTS_RISK_MED", 0.34),
    highBand: g("VTS_RISK_HIGH", 0.67),
  };
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// signals: { blast:int, depth:int, couplingGap:int, testReach:float[0,1] }
// Returns { score:[0,1], band:"LOW"|"MED"|"HIGH", channels:{blast,depth,coupling,testReach} } — channels are
// the NORMALIZED contributions so the output can show WHY a score is what it is (inspectable, not a black box).
export function scoreRisk(signals, w = riskWeights()) {
  const blastN = clamp01((signals.blast || 0) / (w.blastCap || 1));
  const depthN = clamp01((signals.depth || 0) / (w.depthCap || 1));
  const couplingN = clamp01((signals.couplingGap || 0) / (w.couplingCap || 1));
  const testReach = clamp01(signals.testReach || 0);

  const wsum = w.wBlast + w.wDepth + w.wCoupling || 1;
  const raw = (w.wBlast * blastN + w.wDepth * depthN + w.wCoupling * couplingN) / wsum;
  // dampen by test coverage: full coverage removes up to testDampen of the risk
  const score = clamp01(raw * (1 - w.testDampen * testReach));

  const band = score >= w.highBand ? "HIGH" : score >= w.medBand ? "MED" : "LOW";
  return {
    score: Math.round(score * 100) / 100,
    band,
    channels: {
      blast: Math.round(blastN * 100) / 100,
      depth: Math.round(depthN * 100) / 100,
      coupling: Math.round(couplingN * 100) / 100,
      testReach: Math.round(testReach * 100) / 100,
    },
  };
}

// Heuristic: does a path look like a test file? Used to compute testReach from a caller set. Deliberately
// broad (many ecosystems) but path-based only — no execution, no framework detection.
export function isTestPath(p) {
  if (typeof p !== "string") return false;
  const s = p.toLowerCase().replace(/\\/g, "/");
  return (
    /(^|\/)(tests?|__tests__|spec|specs|e2e)\//.test(s) ||
    /\.(test|spec)\.[a-z]+$/.test(s) ||
    /(^|\/)test_[^/]+$/.test(s) ||
    /_test\.[a-z]+$/.test(s)
  );
}

// Assemble the per-symbol result rows into an overall summary. Overall band = the MAX band present (one HIGH
// symbol makes the diff HIGH — the review needs to look). Pure.
export function summarize(rows) {
  const rank = { LOW: 0, MED: 1, HIGH: 2 };
  let worst = "LOW";
  let totalCallers = 0;
  const files = new Set();
  for (const r of rows) {
    if (rank[r.risk.band] > rank[worst]) worst = r.risk.band;
    totalCallers += r.callers || 0;
    if (r.file) files.add(r.file);
  }
  return { band: worst, symbols: rows.length, files: files.size, totalCallers };
}

// ---- formatting (token-capped) ------------------------------------------------------------------------
// Output is file:line + risk band + the channel breakdown, NO bodies. Capped rows; a "+N more" tail when over.
export function formatDetectChanges(result, max = 40) {
  const { rows, summary, base, cert } = result;
  const out = [];
  out.push(
    `impact of ${base || "working tree"}: ${summary.symbols} changed symbol(s) in ${summary.files} file(s), ` +
      `${summary.totalCallers} caller edge(s) — overall risk ${summary.band}`
  );
  if (!rows.length) {
    out.push("no changed symbols resolved (no diff, or changes outside any declaration).");
    if (cert) out.push(cert);
    return out.join("\n");
  }
  // most-risky first
  const rank = { LOW: 0, MED: 1, HIGH: 2 };
  const sorted = [...rows].sort((a, b) => rank[b.risk.band] - rank[a.risk.band] || (b.callers || 0) - (a.callers || 0));
  const shown = sorted.slice(0, max);
  for (const r of shown) {
    const c = r.risk.channels;
    const bits = [`blast ${r.callers}`];
    if (r.depth > 1) bits.push(`depth ${r.depth}`);
    if (r.couplingGap) bits.push(`coupling-gap ${r.couplingGap}`);
    if (r.testReached) bits.push("tested");
    out.push(`  [${r.risk.band}] ${r.symbol}  ${r.file}:${r.line}  (${bits.join(", ")})`);
  }
  if (sorted.length > max) out.push(`  … ${sorted.length - max} more`);
  if (cert) out.push(cert);
  return out.join("\n");
}
