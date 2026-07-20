#!/usr/bin/env node
// SessionStart self-report — re-inject ONE coherent tool-routing policy (the decision tree + the live
// adoption posture) so the model reads a single integrative guide instead of N scattered reflexive nudges.
// This is the "learning" half of the steer loop: the hook + discover MEASURE, this RE-INJECTS the gap + the
// when-to-use-what policy, behavior shifts, the next session measures again (the SkillOpt textual-gradient
// cadence — a static rule can't self-improve, a re-injected live metric + policy can). Quiet until there's
// enough activity to be worth a line of context.
//
// ALSO (independent of adoption): if the committed tree-sitter index (.vts-index) has gone STALE, surface the
// one-command refresh. This is decoupled from the adoption gate below — a stale index matters even on a fresh
// session with no edit history, so it must not be suppressed by `total < 3`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEditLedger, adoptionPct } from "../server/edit-ledger.js";
import { routingDigest, stalenessLine } from "../server/policy.js";
import { hasSymIndex, indexFreshness } from "../server/symindex.js";

// Best-effort locale for the staleness line: explicit VTS_LANG wins, else the config's lang, else the OS locale.
function wantKo() {
  try {
    const v = String(process.env.VTS_LANG || "").toLowerCase();
    if (v === "ko" || v === "en") return v === "ko";
    const cfgPath = process.env.VTS_CONFIG_FILE || path.join(os.homedir(), ".vs-token-safer", "config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (cfg && typeof cfg.lang === "string") return cfg.lang.toLowerCase() === "ko";
  } catch { /* fall through */ }
  const loc = (process.env.LANG || process.env.LC_ALL || process.env.LC_MESSAGES || Intl.DateTimeFormat().resolvedOptions().locale || "").toLowerCase();
  return /^ko\b|[-_]kr\b|^ko[-_]/.test(loc);
}

// Staleness of the committed index for the configured project — an fs walk, so gated to run only when an index
// actually exists (nothing to be stale otherwise) and VTS_STALE_CHECK isn't off. Returns "" if fresh/absent.
function stalePart() {
  try {
    const cfgPath = process.env.VTS_CONFIG_FILE || path.join(os.homedir(), ".vs-token-safer", "config.json");
    let root = process.env.VTS_PROJECT_PATH || "";
    if (!root) { try { root = (JSON.parse(fs.readFileSync(cfgPath, "utf8")) || {}).projectPath || ""; } catch { /* no config */ } }
    if (!root || !hasSymIndex(root)) return ""; // no committed index → nothing can be stale
    return stalenessLine(indexFreshness(root), { ko: wantKo() });
  } catch { return ""; }
}

try {
  const o = readEditLedger();
  const pct = adoptionPct(o);
  const total = (o.builtin || 0) + (o.symbol || 0);
  const parts = [];
  const stale = stalePart();
  if (stale) parts.push(stale);
  if (pct !== null && total >= 3) parts.push(routingDigest(o)); // adoption posture only when there's data
  if (!parts.length) process.exit(0); // nothing worth a line of context
  const msg = parts.join("\n\n");
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: msg } }) + "\n");
} catch { /* best-effort — never break session start */ }
process.exit(0);
