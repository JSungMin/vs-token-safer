#!/usr/bin/env node
// Deterministic self-test for the SkillOpt scorer + gate (no live agents — that's rollout.workflow.js). The
// gate decides whether a reworded skill/warn is accepted, so its logic has to be trustworthy on its own.
// Run: `node eval/skillopt/selftest.mjs`.
import { classifyRollout, variantScore, gate } from "./score.mjs";
import { SCENARIOS, train, heldout } from "./scenarios.mjs";
import { VARIANTS, byId } from "./variants.mjs";

const checks = [];
const check = (name, pass) => checks.push([name, pass]);

// classifyRollout: symbol-edit tools (incl. MCP-prefixed) → "symbol"; built-in → "builtin"; nothing → "other".
check("classify: symbol-edit tool → symbol", classifyRollout({ toolsUsed: ["insert_after_symbol"] }) === "symbol");
check("classify: MCP-prefixed symbol-edit → symbol", classifyRollout({ toolsUsed: ["mcp__plugin_vs-token-safer_vs-search__replace_symbol_body"] }) === "symbol");
check("classify: built-in Edit → builtin", classifyRollout({ toolsUsed: ["Read", "Edit"] }) === "builtin");
check("classify: symbol wins when both present (no appliedTool)", classifyRollout({ toolsUsed: ["Edit", "replace_symbol_body"] }) === "symbol");
check("classify: no edit → other", classifyRollout({ toolsUsed: ["Read", "search_symbol"] }) === "other");
// appliedTool is the honest signal: a tried-symbol-but-fell-back-to-Edit rollout is "builtin", not "symbol".
check("classify: appliedTool=Edit overrides symbol in toolsUsed", classifyRollout({ toolsUsed: ["insert_after_symbol", "Edit"], appliedTool: "Edit" }) === "builtin");
check("classify: appliedTool=symbol-edit → symbol", classifyRollout({ toolsUsed: ["Read", "Edit", "replace_symbol_body"], appliedTool: "mcp__x__replace_symbol_body" }) === "symbol");

// variantScore: adoption = symbol / (symbol + builtin); "other" excluded from the denominator.
const vs = variantScore([
  { toolsUsed: ["replace_symbol_body"] },
  { toolsUsed: ["insert_after_symbol"] },
  { toolsUsed: ["Edit"] },
  { toolsUsed: ["search_symbol"] }, // other → excluded
]);
check("variantScore: 2 symbol / 1 builtin → adoption 2/3", vs.symbol === 2 && vs.builtin === 1 && vs.other === 1 && Math.abs(vs.adoption - 2 / 3) < 1e-9);
check("variantScore: no edits → adoption null", variantScore([{ toolsUsed: ["Read"] }]).adoption === null);

// gate: accept only a STRICT held-out improvement; reject a no-signal candidate; floor with no baseline.
const base = { adoption: 0.2 };
check("gate: candidate beats baseline → accept", gate(base, { adoption: 0.6 }).accept === true);
check("gate: candidate equals baseline → reject", gate(base, { adoption: 0.2 }).accept === false);
check("gate: candidate worse → reject", gate(base, { adoption: 0.1 }).accept === false);
check("gate: minDelta margin enforced", gate(base, { adoption: 0.25 }, 0.1).accept === false && gate(base, { adoption: 0.35 }, 0.1).accept === true);
check("gate: candidate with no edits → reject", gate(base, { adoption: null }).accept === false);
check("gate: no baseline + positive signal → accept", gate({ adoption: null }, { adoption: 0.5 }).accept === true);

// fixtures sanity: scenarios cover both insert + replace, have a train/holdout split, and use synthetic names.
const expects = new Set(SCENARIOS.map((s) => s.expect));
check("scenarios: cover insert + replace", expects.has("insert") && expects.has("replace"));
check("scenarios: have a train/holdout split", SCENARIOS.some(train) && SCENARIOS.some(heldout));
// Proprietary-name guard: scenarios must use synthetic names only. The real internal codenames are NOT
// spelled out in this public file (the guard must not become the leak it prevents) — set VTS_PROPRIETARY_DENY
// (csv) locally to also catch your own employer/project terms. The committed list is generic placeholders.
const DENY = ["acmecorp", "internalproj", "secretproject", ...(process.env.VTS_PROPRIETARY_DENY || "").split(",").map((x) => x.trim()).filter(Boolean)];
check("scenarios: no obvious proprietary names", !SCENARIOS.some((s) => DENY.some((d) => new RegExp(d, "i").test(s.content + s.task))));
check("variants: baseline present + ≥2 candidates", byId("baseline") && VARIANTS.length >= 3);

console.log("vs-token-safer — SkillOpt scorer + gate self-test\n");
let ok = true;
for (const [name, pass] of checks) { console.log(`${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; }
if (!ok) { console.error("\nSKILLOPT SELFTEST FAILED."); process.exit(1); }
console.log(`\n${checks.length}/${checks.length} checks. SKILLOPT SELFTEST PASSED.`);
