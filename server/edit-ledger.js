// Edit-adoption ledger — the live metric for the symbol-edit steering loop (the SkillOpt-style "score"):
// how often a whole-declaration edit went through a vts symbol-edit tool (the behavior we want) vs the
// built-in Edit (which we warned on). The hook records a builtin-warn; core.js records a symbol-edit. The
// `streak` (consecutive builtin-warns since the last symbol-edit) drives the L2 auto-escalation, and the
// SessionStart self-report reads the ratio back to the model as a goal. Local JSON, best-effort, never throws.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LEDGER = () => process.env.VTS_EDIT_LEDGER || path.join(os.homedir(), ".vs-token-safer", "edit-adoption.json");

export function readEditLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER(), "utf8")); } catch { return { builtin: 0, symbol: 0, streak: 0 }; }
}
function write(o) {
  try { const p = LEDGER(); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); } catch { /* best-effort */ }
}
// kind: "symbol-edit" (a vts symbol-edit tool was used → adoption up, ignore-streak reset) or anything else
// (a whole-decl edit went through the built-in Edit and we warned → builtin up, streak up). Returns the
// updated ledger so the caller (the hook) can read the fresh streak for an escalation decision.
export function recordEditEvent(kind) {
  const o = readEditLedger();
  if (kind === "symbol-edit") { o.symbol = (o.symbol || 0) + 1; o.streak = 0; }
  else { o.builtin = (o.builtin || 0) + 1; o.streak = (o.streak || 0) + 1; }
  write(o);
  return o;
}
// Adoption % = symbol-edits / all whole-decl edits. null when there's no data yet.
export function adoptionPct(o = readEditLedger()) {
  const total = (o.builtin || 0) + (o.symbol || 0);
  return total ? Math.round((100 * (o.symbol || 0)) / total) : null;
}
