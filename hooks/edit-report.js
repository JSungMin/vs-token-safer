#!/usr/bin/env node
// SessionStart self-report — re-inject ONE coherent tool-routing policy (the decision tree + the live
// adoption posture) so the model reads a single integrative guide instead of N scattered reflexive nudges.
// This is the "learning" half of the steer loop: the hook + discover MEASURE, this RE-INJECTS the gap + the
// when-to-use-what policy, behavior shifts, the next session measures again (the SkillOpt textual-gradient
// cadence — a static rule can't self-improve, a re-injected live metric + policy can). Quiet until there's
// enough activity to be worth a line of context.
import { readEditLedger, adoptionPct } from "../server/edit-ledger.js";
import { routingDigest } from "../server/policy.js";

try {
  const o = readEditLedger();
  const pct = adoptionPct(o);
  const total = (o.builtin || 0) + (o.symbol || 0);
  if (pct === null || total < 3) process.exit(0); // too little data — don't nag on a fresh/idle session
  const msg = routingDigest(o);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: msg } }) + "\n");
} catch { /* best-effort — never break session start */ }
process.exit(0);
