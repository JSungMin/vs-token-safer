// SkillOpt scorer — the deterministic, testable core of the behavioral-eval harness. A "rollout" is one
// sub-agent run on one editing scenario under one skill/warn VARIANT; the agent self-reports the edit tools
// it used. This module classifies that report and aggregates an ADOPTION score per variant, then a
// validation GATE decides whether a candidate variant beats the baseline. The live rollouts (spawning the
// agents) live in rollout.workflow.js — they're token-heavy and opt-in; the SCORING is kept here so the
// gate logic itself is deterministic and CI-testable (a gate you can't trust isn't a gate).
const SYMBOL_EDIT_TOOLS = new Set(["replace_symbol_body", "insert_symbol", "insert_after_symbol", "insert_before_symbol", "safe_delete", "rename"]);
const BUILTIN_EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);

// Classify one rollout by the edit tool that ACTUALLY APPLIED the change. `appliedTool` (the single tool
// that made the final edit) is the honest signal — a smoke run showed an agent that TRIED a symbol-edit,
// hit a backend failure, and fell back to the built-in Edit; counting it as "symbol" off `toolsUsed` (which
// listed both) inflated adoption. Prefer appliedTool; fall back to toolsUsed only when it's absent. MCP
// names (mcp__…__replace_symbol_body) are normalized to the bare tool. "other" = no edit (not scorable).
const bare = (t) => String(t).replace(/^.*__/, "");
export function classifyRollout(r) {
  if (r && r.appliedTool) {
    const t = bare(r.appliedTool);
    if (SYMBOL_EDIT_TOOLS.has(t)) return "symbol";
    if (BUILTIN_EDIT_TOOLS.has(t)) return "builtin";
  }
  const norm = ((r && r.toolsUsed) || []).map(bare);
  if (norm.some((t) => SYMBOL_EDIT_TOOLS.has(t))) return "symbol";
  if (norm.some((t) => BUILTIN_EDIT_TOOLS.has(t))) return "builtin";
  return "other";
}

// Aggregate a variant's rollouts into an adoption rate = symbol-edits / (symbol-edits + builtin-edits).
// "other" rollouts (no edit) are excluded from the denominator — they carry no tool-choice signal.
export function variantScore(rollouts) {
  let symbol = 0, builtin = 0, other = 0;
  for (const r of rollouts) {
    const c = classifyRollout(r);
    if (c === "symbol") symbol++; else if (c === "builtin") builtin++; else other++;
  }
  const total = symbol + builtin;
  return { symbol, builtin, other, total, adoption: total ? symbol / total : null };
}

// Validation gate (SkillOpt's "accept only on strict held-out improvement"). Accept the candidate iff its
// held-out adoption beats the baseline by more than minDelta. A candidate that produced no scorable edits
// is rejected (no signal); with no baseline, any positive signal is accepted as the new floor.
export function gate(baseline, candidate, minDelta = 0) {
  if (!candidate || candidate.adoption == null) return { accept: false, delta: null, reason: "candidate produced no scorable edits" };
  if (!baseline || baseline.adoption == null) return { accept: candidate.adoption > 0, delta: null, reason: "no baseline — accept any positive signal" };
  const delta = candidate.adoption - baseline.adoption;
  const pp = (x) => `${Math.round(x * 100)}%`;
  return { accept: delta > minDelta, delta, reason: `adoption ${pp(baseline.adoption)} → ${pp(candidate.adoption)} (Δ ${Math.round(delta * 100)}pp, need > ${Math.round(minDelta * 100)}pp)` };
}
