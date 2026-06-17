// Shared whole-declaration edit detector — used by BOTH the discover measurement (core.js) and the
// edit-enforcement hook (hooks/block-code-grep.js), so the set we MEASURE and the set we STEER are the
// same (mirrors splitSegments, shared between the grep hook and discover). The token win of the symbol-
// edit tools lives in whole-DECLARATION operations: replacing a function/class body, or adding a new one.
// A sub-declaration tweak (a few lines inside a body — e.g. one more item in an array) is NOT a fit and is
// deliberately ignored; built-in Edit stays correct there.
const CODE_EXT = /\.(c|cc|cxx|cpp|h|hpp|hh|inl|ipp|tpp|cs|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi)\b/;
// A real declaration keyword — its presence alone marks a declaration.
const DECL_KW = /\b(class|struct|enum|interface|namespace|template|def|function|func|fn|public|private|protected|static|void|virtual|override|async|UFUNCTION|UCLASS|USTRUCT)\b/;
// Control-flow keywords whose header ALSO ends in `) {` — they must NOT count as a declaration opener.
// (Dogfood-found false positive: an `if (cond) { … }` block edited inside a function body was flagged a
// whole declaration and suggested `replace_symbol_body symbol="if"` — `if` is not a named symbol.)
const RESERVED_CALLEE = new Set(["if", "for", "while", "switch", "catch", "return", "sizeof", "do", "else", "case", "with"]);
// Signature/body opener on one line: `… name(args) {` where `name` is a callable identifier. Used only when
// no DECL_KW is present, and the callee must be a real name, not a control-flow keyword.
const SIG_OPENER = /([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const|noexcept|override|final|=>)?\s*\{?\s*$/;
function isWholeDecl(s, minLines) {
  const str = String(s);
  if ((str.match(/\n/g) || []).length < minLines) return false;
  if (DECL_KW.test(str)) return true;                       // an explicit declaration keyword
  for (const line of str.split("\n")) {                     // else: a NAMED signature opener (not control flow)
    const m = SIG_OPENER.exec(line);
    if (m && !RESERVED_CALLEE.has(m[1])) return true;
  }
  return false;
}

// Classify a built-in edit tool call against the whole-declaration heuristic.
//   replaceDecl — the text being REPLACED (old_string) is a whole declaration → replace_symbol_body fits.
//   insertDecl  — the text being ADDED (new_string) is a whole declaration while what it replaces is NOT
//                 → an addition; insert_after_symbol / insert_before_symbol fit.
// `file` is the normalized lowercase path, or null when the target isn't a code file (callers early-out).
// Write (a whole new file) and non-edit tools return all-false: not a symbol-level replace/insert.
export function classifyDeclEdit(name, input, minLines = 8) {
  const none = { file: null, replaceDecl: false, insertDecl: false };
  if (!input) return none;
  const fileRaw = String(input.file_path || "").replace(/\\/g, "/");
  if (!CODE_EXT.test(fileRaw)) return none;
  const file = fileRaw.toLowerCase();
  const pairs = [];
  if (name === "Edit") pairs.push([input.old_string, input.new_string]);
  else if (name === "MultiEdit" && Array.isArray(input.edits)) for (const e of input.edits) pairs.push([e.old_string, e.new_string]);
  else return { file, replaceDecl: false, insertDecl: false };
  let replaceDecl = false, insertDecl = false;
  for (const [oldS, newS] of pairs) {
    if (isWholeDecl(oldS || "", minLines)) replaceDecl = true;       // replacing a whole declaration
    else if (isWholeDecl(newS || "", minLines)) insertDecl = true;   // adding a whole declaration (old isn't one)
  }
  return { file, replaceDecl, insertDecl };
}
