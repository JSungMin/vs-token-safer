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
// B (concrete nudge): a ready-to-use `read_symbol symbol="Foo"` converts far better than the `<name>` placeholder
// (the grep-block work proved it). policy.js stays PURE — the HOOK extracts the names (it has fs access) and
// passes them in like sizeBytes. `symbols` non-empty → render concrete calls; empty → the placeholder, unchanged.
export function readSteerDecision(file, sizeBytes, { sliced = false, minBytes = 6000, ko = false, symbols = [] } = {}) {
  if (!readSteerOn() || !file) return null;
  if (sliced) return null;                            // a partial read (offset/limit) is already a slice
  if (!READ_CODE_EXT.test(String(file))) return null; // only code files (the syntactic/semantic tiers cover these)
  if (shouldSuppressSteer(file)) return null;         // generated/build/vendored path — a symbol-read buys nothing
  if (!(sizeBytes >= minBytes)) return null;          // small file: cheap to read whole, not worth a nudge
  const kb = Math.round(sizeBytes / 1024);
  const all = Array.isArray(symbols) ? symbols.filter((s) => typeof s === "string" && s) : [];
  const names = all.slice(0, 4);
  if (names.length) {
    const calls = names.map((n) => `read_symbol symbol="${n}"`).join(" · ");
    const more = all.length > names.length ? ` (+${all.length - names.length} more — read_symbol lists them)` : "";
    return ko
      ? `↪ vs-token-safer: 큰 코드파일(~${kb}KB) 통째 읽기. 한 선언만 필요하면 ${calls}${more} 처럼 그 선언만 반환(토큰캡); 통째 편집이면 replace_symbol_body / insert_symbol 이 읽지 않고 이름으로 편집. 끄기: VTS_READ_STEER=0.`
      : `↪ vs-token-safer: reading a large code file (~${kb} KB) whole. Need ONE declaration? ${calls}${more} returns just that decl (token-capped); for a whole-decl edit, replace_symbol_body / insert_symbol edit by name with no read. VTS_READ_STEER=0 to hide.`;
  }
  return ko
    ? `↪ vs-token-safer: 큰 코드파일(~${kb}KB)을 통째로 읽네요. 한 선언만 필요하면 read_symbol symbol="<name>" 이 그 선언만 반환(토큰캡)하고, 통째 편집이면 replace_symbol_body / insert_symbol 이 읽지 않고 이름으로 편집합니다. 끄기: VTS_READ_STEER=0.`
    : `↪ vs-token-safer: reading a large code file (~${kb} KB) whole. If you only need ONE declaration, read_symbol symbol="<name>" returns just that decl (token-capped); for a whole-decl edit, replace_symbol_body / insert_symbol edit by name with no read. VTS_READ_STEER=0 to hide.`;
}

// PURE top-level declaration-name extractor (no fs — the hook reads the file and passes the text). Heuristic,
// best-effort: a column-0 declaration line per language (top-level only — indented members are skipped, which
// is what we want: name the file's outermost decls). Used to make the read-steer nudge concrete; a wrong-but-
// plausible name still teaches the tool, and document_symbols recovers the full set. Returns up to `max` names.
// STRONG = functions / classes / types / methods (the decls you usually edit); WEAK = bare const/let/var (named
// last so a function outranks a top-level constant — the "demote const locals" bias the concept tier uses).
function declPatternsFor(ext) {
  if (/^(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(ext)) return {
    strong: [
      /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
      /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
      /^(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    ],
    weak: [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/],
  };
  if (/^(py|pyi)$/.test(ext)) return { strong: [/^(?:async\s+)?def\s+([A-Za-z_]\w*)/, /^class\s+([A-Za-z_]\w*)/], weak: [] };
  if (/^(c|cc|cxx|cpp|h|hpp|hh|inl|ipp|tpp|cs)$/.test(ext)) return {
    strong: [
      /^(?:class|struct|enum|namespace|interface|record)\s+([A-Za-z_]\w*)/,
      /^[\w:<>,*&\s]*?(?:[A-Za-z_]\w*::)+([A-Za-z_]\w*)\s*\(/,           // Class::Method(  → the method name
      /^(?:[A-Za-z_][\w:<>,*&]*\s+)+\*?\s*([A-Za-z_]\w*)\s*\(/,          // free/member function definition
    ],
    weak: [],
  };
  return { strong: [], weak: [] };
}
export function topLevelDeclNames(text, file, max = 8) {
  if (!text || typeof text !== "string") return [];
  const m = /\.([a-z0-9]+)$/i.exec(String(file || ""));
  const { strong, weak } = declPatternsFor(m ? m[1].toLowerCase() : "");
  if (!strong.length && !weak.length) return [];
  const lines = text.slice(0, 200000).split(/\r?\n/);                  // bound the work on a huge file
  const seen = new Set();
  const collect = (pats, into) => { for (const raw of lines) { if (into.length >= max) break; if (!raw || /^\s/.test(raw)) continue; for (const re of pats) { const mm = re.exec(raw); if (mm && mm[1] && !seen.has(mm[1])) { seen.add(mm[1]); into.push(mm[1]); break; } } } };
  const out = [];
  collect(strong, out);                                               // functions/classes/types first (source order)
  if (out.length < max) collect(weak, out);                           // then bare const/var to fill remaining slots
  return out;
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
    "  • SINGLE lookup → call vts tools DIRECTLY (no agent). code-locator only for a genuine multi-FILE locate; never for an AUDIT/REVIEW/전수조사 and never a FLEET of them — document_symbols + a few search_symbol map a whole file far cheaper than N body-reading agents",
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
