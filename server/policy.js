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

// READ-SIDE steer (H1) — the dominant token leak is a whole-file Read of a LARGE code file BEFORE a one-decl
// edit (discover, real data: ~66% of edit-pre-read tokens sit in reads ≥ ~1K tok, and ~86% of them had no prior
// vts search so the search-result steer can't reach them — but a Read always has a target, so a READ-time steer
// can). When the agent Reads a big code file whole, point it at read_symbol (reads ONE decl, capped) and the
// symbol-edit tools (edit by name, no read). PURE decision — the hook supplies the byte size; warn-only, never
// blocks a Read. Gated TIGHT to avoid nagging legitimate whole-file reads: code ext only, not generated/build,
// not an already-sliced read (offset/limit), and at/above `minBytes`. Returns the nudge text or null.
const READ_CODE_EXT = /\.(c|cc|cxx|cpp|h|hpp|hh|inl|ipp|tpp|cs|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi)$/i;
export function readSteerOn() { return onOff(process.env.VTS_READ_STEER, "1"); }
export function readSteerDecision(file, sizeBytes, { sliced = false, minBytes = 6000, ko = false } = {}) {
  if (!readSteerOn() || !file) return null;
  if (sliced) return null;                            // a partial read (offset/limit) is already a slice
  if (!READ_CODE_EXT.test(String(file))) return null; // only code files (the syntactic/semantic tiers cover these)
  if (shouldSuppressSteer(file)) return null;         // generated/build/vendored path — a symbol-read buys nothing
  if (!(sizeBytes >= minBytes)) return null;          // small file: cheap to read whole, not worth a nudge
  const kb = Math.round(sizeBytes / 1024);
  return ko
    ? `↪ vs-token-safer: 큰 코드파일(~${kb}KB)을 통째로 읽네요. 한 선언만 필요하면 read_symbol symbol="<name>" 이 그 선언만 반환(토큰캡)하고, 통째 편집이면 replace_symbol_body / insert_symbol 이 읽지 않고 이름으로 편집합니다. 끄기: VTS_READ_STEER=0.`
    : `↪ vs-token-safer: reading a large code file (~${kb} KB) whole. If you only need ONE declaration, read_symbol symbol="<name>" returns just that decl (token-capped); for a whole-decl edit, replace_symbol_body / insert_symbol edit by name with no read. VTS_READ_STEER=0 to hide.`;
}

// The single routing digest. Always emits the decision tree (the integrative guidance); appends the live
// adoption posture + adaptive-controller state when there is enough data.
export function routingDigest(o = readEditLedger()) {
  const pct = adoptionPct(o);
  const total = (o.builtin || 0) + (o.symbol || 0);
  const lines = [
    "[vs-token-safer] Tool routing — vts + CC-native are COMPLEMENTARY; cheapest tool that fits:",
    "  • symbol / refs / rename on INDEXED code → vts search_symbol / find_references / rename (not grep)",
    "  • ADD/REPLACE a whole decl → vts replace_symbol_body / insert_symbol (by name, skips the Read)",
    "  • doc/log, quick literal peek, JUST-edited or unindexed file, sub-decl tweak → CC-native Read/Grep/Edit",
    "  • big tree, slow first query → vts setup --scope <module>; vts preindex",
  ];
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
