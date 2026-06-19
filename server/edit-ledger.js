// Edit-adoption ledger + adaptive escalation controller — the live metric AND the closed loop for the
// symbol-edit steering (the SkillOpt-style "score"): how often a whole-declaration edit went through a vts
// symbol-edit tool (the behavior we want) vs the built-in Edit (which we warned on). The hook records a
// builtin-warn; core.js records a symbol-edit. The `streak` (consecutive builtin-warns since the last
// symbol-edit) is the patience floor; on top of it an ADAPTIVE CONTROLLER decides whether to escalate from a
// warn to the one-shot block, using MEASURED per-modality conversion rather than a fixed threshold. The
// SessionStart self-report reads the ratio back to the model as a goal. Local JSON, best-effort, never throws.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LEDGER = () => process.env.VTS_EDIT_LEDGER || path.join(os.homedir(), ".vs-token-safer", "edit-adoption.json");
const freshMod = () => ({ warn: { shown: 0, converted: 0 }, block: { shown: 0, converted: 0 } });

export function readEditLedger() {
  try {
    const o = JSON.parse(fs.readFileSync(LEDGER(), "utf8"));
    o.mod = o.mod || freshMod();
    o.mod.warn = o.mod.warn || { shown: 0, converted: 0 };
    o.mod.block = o.mod.block || { shown: 0, converted: 0 };
    if (!("pending" in o)) o.pending = null;
    return o;
  } catch { return { builtin: 0, symbol: 0, streak: 0, mod: freshMod(), pending: null }; }
}
function write(o) {
  try { const p = LEDGER(); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); } catch { /* best-effort */ }
}
// kind: "symbol-edit" (a vts symbol-edit tool was used → adoption up, ignore-streak reset, and the steer
// modality last shown is CREDITED as having converted) or anything else (a whole-decl edit went through the
// built-in Edit and we warned → builtin up, streak up; the pending modality stays shown-not-converted).
// Returns the updated ledger so the caller (the hook) can read the fresh streak/stats for an escalation call.
export function recordEditEvent(kind) {
  const o = readEditLedger();
  if (kind === "symbol-edit") {
    o.symbol = (o.symbol || 0) + 1; o.streak = 0;
    // The agent SWITCHED to a symbol-edit — credit whichever steer modality was last shown (the conversion).
    if (o.pending && o.mod[o.pending]) o.mod[o.pending].converted = (o.mod[o.pending].converted || 0) + 1;
    o.pending = null;
  } else {
    o.builtin = (o.builtin || 0) + 1; o.streak = (o.streak || 0) + 1;
    // A whole-decl edit went to the built-in tool: the previously-shown modality (still pending) did NOT
    // convert. Leave it shown-not-converted; recordSteerShown sets the next pending modality.
  }
  write(o);
  return o;
}
// Record that a steer MODALITY was just shown ("warn" | "block") and mark it pending, so the next symbol-edit
// (if any) credits it as a conversion. This is what gives the controller its per-modality conversion signal.
export function recordSteerShown(modality) {
  const o = readEditLedger();
  if (o.mod[modality]) { o.mod[modality].shown = (o.mod[modality].shown || 0) + 1; o.pending = modality; }
  write(o);
  return o;
}
// Adoption % = symbol-edits / all whole-decl edits. null when there's no data yet.
export function adoptionPct(o = readEditLedger()) {
  const total = (o.builtin || 0) + (o.symbol || 0);
  return total ? Math.round((100 * (o.symbol || 0)) / total) : null;
}
// Clear the ignore-streak without touching the counts — used after an L2 block FIRES so it backs off
// (fire-once, not a persistent wall: a permanent block trapped the agent, which fought it with Edit retries
// and code contortions instead of switching tools).
export function resetStreak() {
  const o = readEditLedger();
  o.streak = 0;
  write(o);
}

// Laplace-smoothed conversion rate of a modality: (converted+1)/(shown+2). The +1/+2 prior reads an unproven
// modality as ~0.5 (neither trusted nor distrusted), so the controller will EXPLORE it once before judging.
function rate(m) { const s = (m && m.shown) || 0, c = (m && m.converted) || 0; return (c + 1) / (s + 2); }

// Adaptive escalation controller — the closed loop. Given a warn-eligible whole-decl edit, decide whether to
// ESCALATE to the one-shot block instead of merely warning, using MEASURED conversion rather than a fixed
// streak threshold. Returns true (escalate → block) or false (warn only). Self-correcting:
//   • warns ARE converting (warnRate ≥ VTS_WARN_OK) → stay soft (don't escalate).
//   • warns failing AND the block is untried-or-PROVEN-better → escalate (explore/exploit the block).
//   • warns failing AND the block was tried but is NOT out-converting the warn (the documented "agent fights
//     the wall" failure) → BACK OFF to warn (escalating again would only re-trap it).
// `threshold` is the patience floor (VTS_EDIT_BLOCK_AFTER); 0 keeps escalation OFF entirely (current default),
// so this is a strict superset of the old static behavior — opt-in, and safer once on.
export function decideEscalation(o = readEditLedger(), threshold = 0) {
  if (!(threshold > 0)) return false;             // escalation is opt-in; OFF by default
  if ((o.streak || 0) < threshold) return false;  // respect the patience floor first
  // 0.6 (not 0.5): an UNPROVEN warn reads ~0.5 under the Laplace prior, which must NOT count as "working" —
  // otherwise escalation could never start on fresh data. So a warn must demonstrably convert (rate > 0.6)
  // before it holds off the block; until then, the patience-floor behavior matches the old static threshold.
  const warnOk = parseFloat(process.env.VTS_WARN_OK || "0.6") || 0.6;
  const warnRate = rate(o.mod.warn), blockRate = rate(o.mod.block);
  if (warnRate >= warnOk) return false;                                    // warns are working — don't escalate
  if ((o.mod.block.shown || 0) > 0 && blockRate < warnRate) return false;  // block tried & not better → back off
  return true;                                                             // warns failing, block unproven-or-better → escalate
}

// One-line controller state for the SessionStart self-report — surfaces WHICH lever is moving the number.
export function controllerReport(o = readEditLedger()) {
  const pc = (m) => `${(m && m.converted) || 0}/${(m && m.shown) || 0}`;
  const willEsc = decideEscalation(o, Number(process.env.VTS_EDIT_BLOCK_AFTER) || 0);
  return `steer conversions — warn ${pc(o.mod.warn)}, block ${pc(o.mod.block)} (adaptive escalation: ${willEsc ? "→ block" : "warn-only"})`;
}
