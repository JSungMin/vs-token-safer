#!/usr/bin/env node
// SessionStart self-report — read the edit-adoption ledger and re-inject the symbol-edit adoption ratio as
// a goal the model sees at the top of the session. This is the "learning" half of the steer loop: the hook
// + discover MEASURE, this RE-INJECTS the gap as a concrete goal, behavior shifts, and the next session
// measures again (the SkillOpt textual-gradient cadence — a static skill rule can't self-improve, but a
// re-injected live metric can). Stays quiet until there's enough data to be worth a line of context.
import { readEditLedger, adoptionPct, controllerReport } from "../server/edit-ledger.js";

try {
  const o = readEditLedger();
  const pct = adoptionPct(o);
  const total = (o.builtin || 0) + (o.symbol || 0);
  if (pct === null || total < 5) process.exit(0); // too little data — don't nag
  // Surface the adaptive controller's per-modality conversions only once it has signal (a steer was shown),
  // so the model sees WHICH lever is moving the number, not just the aggregate ratio.
  const hasSteerData = ((o.mod && o.mod.warn && o.mod.warn.shown) || 0) + ((o.mod && o.mod.block && o.mod.block.shown) || 0) > 0;
  const ctrl = hasSteerData ? ` [${controllerReport(o)}]` : "";
  const msg =
    `[vs-token-safer] Symbol-edit adoption: ${pct}% (${o.symbol || 0} symbol-edit vs ${o.builtin || 0} built-in Edit on whole declarations).${ctrl} ` +
    `When you ADD or REPLACE a whole declaration this session, prefer replace_symbol_body / insert_symbol — ` +
    `they edit by NAME and skip reading the file into context. Aim to raise the ratio. (Built-in Edit stays right for sub-declaration tweaks.)`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: msg } }) + "\n");
} catch { /* best-effort — never break session start */ }
process.exit(0);
