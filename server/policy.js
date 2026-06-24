// Unified tool-routing policy — the "integratively wise" layer that makes vts COMPLEMENT Claude Code's native
// tools (Read / Grep / Glob / Edit / native LSP) instead of competing with them. Two jobs:
//
//   1. shouldSuppressSteer(file) — stay SILENT where a CC-native tool is clearly the better choice, so vts
//      never nags on a case it can't improve. The clear wins (aggressive default: only obvious cases): a
//      GENERATED or BUILD-OUTPUT path (Intermediate / Binaries / Saved / *.generated.* / node_modules / build
//      …) where a semantic index is noise. (The doc/log carve-out, sub-declaration ignore, and freeform-grep
//      warn already live in the hook — this fills the generated/build-output gap.)
//
//   2. routingDigest() — ONE coherent SessionStart message: a when-to-use-what decision tree PLUS the live
//      adoption posture (edit-adoption % + the adaptive controller state), so the model reads a single policy
//      instead of N scattered reflexive nudges. This is the "integrative" half — vts and CC-native each named
//      for what they're best at.
import { readEditLedger, adoptionPct, adoptionPctRecent, controllerReport } from "./edit-ledger.js";

// Generated code / build output / vendored deps — a semantic index adds nothing here; CC-native is fine.
const SUPPRESS_DIR = /(^|[/\\])(Intermediate|Binaries|Saved|DerivedDataCache|node_modules|build|dist|out|obj|\.git)([/\\]|$)/i;
const GENERATED = /\.(generated\.[a-z0-9]+|g\.cs|designer\.cs|pb\.(go|cc|h)|min\.js)$/i;
export function shouldSuppressSteer(file) {
  if (!suppressOn() || !file) return false;
  const f = String(file).replace(/\\/g, "/");
  return SUPPRESS_DIR.test(f) || GENERATED.test(f);
}
const onOff = (v, d) => !/^(0|false|off|no)$/i.test(String(v ?? d));
export function suppressOn() { return onOff(process.env.VTS_SUPPRESS, "1"); }

// The decision-tree lines, parameterized by the HOST agent's native-tool labels so the SAME guidance serves
// every harness (Claude Code, Codex, a generic MCP client). `headerLabel` names the native tools in the
// header, `nativeTools` in the doc/log bullet. routingDigest passes the Claude-Code labels (output stays
// byte-identical); routingBlock passes harness-neutral ones for AGENTS.md / rules files.
function routingTree(headerLabel, nativeTools) {
  return [
    `[vs-token-safer] Tool routing — vts + ${headerLabel} are COMPLEMENTARY; cheapest tool that fits:`,
    "  • symbol / refs / rename on INDEXED code → vts search_symbol / find_references / rename (not grep)",
    "  • ADD/REPLACE a whole decl → vts replace_symbol_body / insert_symbol (by name, skips the Read)",
    `  • doc/log, quick literal peek, JUST-edited or unindexed file, sub-decl tweak → ${nativeTools}`,
    "  • big tree, slow first query → vts setup --scope <module>; vts preindex",
  ];
}

// Harness-neutral routing block for an adapter's AGENTS.md / rules file. NO live posture (a static doc), and
// — since a non-Claude-Code harness has no PreToolUse hook to REWRITE a stray grep — a one-line note that the
// swap is by HABIT here, not intercepted (the "instructed" rung of the enforcement ladder). `native` overrides
// the tool label for a specific harness. Used by `vts routing` (cli.js) to generate the adapter doc in sync.
export function routingBlock({ native = "the agent's native Read/Grep/Edit" } = {}) {
  return [
    ...routingTree("the agent's native tools", native),
    "  (no PreToolUse hook here — vts can't auto-rewrite a stray grep, so prefer the vts tool by habit.)",
  ].join("\n");
}

// The single routing digest. Always emits the decision tree (the integrative guidance); appends the live
// adoption posture + adaptive-controller state when there is enough data.
export function routingDigest(o = readEditLedger()) {
  const pct = adoptionPct(o);
  const total = (o.builtin || 0) + (o.symbol || 0);
  const lines = routingTree("CC-native", "CC-native Read/Grep/Edit");
  if (pct !== null && total >= 3) {
    const hasSteer = (((o.mod || {}).warn || {}).shown || 0) + (((o.mod || {}).block || {}).shown || 0) > 0;
    // Lead with the ROLLING rate (current behavior) and keep the all-time ratio as context — the recent
    // number is what tells the model whether the steer is converting now, the lever the loop can actually move.
    const recent = adoptionPctRecent(o);
    const recentStr = recent !== null && recent !== pct ? `, recent ${recent}%` : "";
    lines.push(`  posture: symbol-edit adoption ${pct}% (${o.symbol || 0}/${total})${recentStr}${hasSteer ? " · " + controllerReport(o) : ""}`);
  }
  return lines.join("\n");
}
