// treesitter.js — SYNTACTIC symbol tier (the zero-setup fallback below the semantic LSP).
//
// Charter: "engine = official, glue = ours." The LSP backends (clangd/Roslyn/tsserver/pyright) stay the
// PRIMARY engine — compiler-grade, semantic. But they need a toolchain (a compile_commands.json, clangd ≥ 22,
// a .sln, an installed LSP). On a repo with none of that, vts used to fall straight to a literal `grep <name>`
// scan (scanTextUnder) — which returns every USAGE line, not declarations, and can't tell a class from a
// comment. Tree-sitter is an OFFICIAL standard parser (the GitHub / neovim engine), shipped here as prebuilt
// wasm grammars (tree-sitter-wasms) run by the wasm runtime (web-tree-sitter) — no native build, works on
// Windows. It gives a real AST → DECLARATIONS with names + lines, with ZERO project setup. 36 grammars ship;
// declaration extraction is configured for ~17 languages today — 10 with a hand-tuned node-type walk (the
// flagship set: C/C++/C#/JS/TS/Py/Go/Java/Rust/Ruby, where C++ declarator-drilling needs care) and 7 more via
// canonical `tags.scm` queries (php/swift/kotlin/scala/dart/zig/bash) — and a grammar with neither degrades
// to a generic walk rather than going dark. Adding a language = a hand config OR a server/tags/<grammar>.scm.
//
// This tier is SYNTACTIC, not semantic: it finds where a symbol is DECLARED (and a file's outline), but it
// does NOT resolve references, overloads, or types across files — that stays the LSP's job. So it slots
// BETWEEN the semantic LSP (when available) and the literal text scan (last resort). Output is the same
// token-capped file:line; nothing is transmitted; wasm + grammars load lazily only when actually used.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { splitIdent, symbolMatchScore } from "./concept.js";

const TAG = "vs-token-safer";

// ── Module resolution (mirrors sdk.js): try the installed data dir, the bundled plugin copy, then local
// node_modules. web-tree-sitter + tree-sitter-wasms are optionalDependencies, so any of these may be absent —
// every failure degrades to "tree-sitter unavailable" (the caller then uses the literal scan).
function anchors() {
  const a = [];
  const DATA = process.env.CLAUDE_PLUGIN_DATA;
  const ROOT = process.env.CLAUDE_PLUGIN_ROOT;
  if (DATA) a.push(path.join(DATA, "package.json"));
  if (ROOT) a.push(path.join(ROOT, "server", "package.json"));
  a.push(
    path.join(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
      "package.json",
    ),
  );
  return a;
}
function resolver() {
  for (const anchor of anchors()) {
    try {
      const req = createRequire(pathToFileURL(anchor).href);
      req.resolve("web-tree-sitter");
      req.resolve("tree-sitter-wasms/package.json");
      return req;
    } catch {
      /* try next */
    }
  }
  return null;
}

// ── Language map: file extension → { grammar wasm basename, decl node types, kind label per type }.
// Kept compact: the DECL set names the node types that are declarations worth indexing; KIND maps a node
// type to a short human label. A grammar not listed here still loads via the generic config (childForFieldName
// "name" + a default decl set) so coverage degrades gracefully rather than going dark.
const C_CPP = {
  decl: new Set([
    "function_definition",
    "declaration",
    "field_declaration",
    "class_specifier",
    "struct_specifier",
    "union_specifier",
    "enum_specifier",
    "namespace_definition",
    "type_definition",
    "alias_declaration",
    "concept_definition",
    "template_declaration",
    // §9.3: clangd routinely leaves preprocessor symbols UNRESOLVED (macros aren't in its AST symbol table)
    // and enum constants are easy to miss on a cold/partial index — tree-sitter sees them syntactically, so
    // the committed index carries `#define` macros and enumerators that the semantic tier can't answer.
    "preproc_def", // #define MAX 10
    "preproc_function_def", // #define SQ(x) ((x)*(x))
    "enumerator", // enum { RED, GREEN } → each constant
  ]),
  kind: {
    function_definition: "func",
    declaration: "decl",
    field_declaration: "member",
    class_specifier: "class",
    struct_specifier: "struct",
    union_specifier: "union",
    enum_specifier: "enum",
    namespace_definition: "namespace",
    type_definition: "type",
    alias_declaration: "type",
    concept_definition: "concept",
    template_declaration: "template",
    preproc_def: "macro",
    preproc_function_def: "macro",
    enumerator: "const",
  },
};
const CSHARP = {
  decl: new Set([
    "class_declaration",
    "struct_declaration",
    "interface_declaration",
    "enum_declaration",
    "record_declaration",
    "method_declaration",
    "property_declaration",
    "constructor_declaration",
    "delegate_declaration",
    "namespace_declaration",
    "field_declaration",
    "event_declaration",
    "event_field_declaration",
  ]),
  kind: {
    class_declaration: "class",
    struct_declaration: "struct",
    interface_declaration: "interface",
    enum_declaration: "enum",
    record_declaration: "record",
    method_declaration: "method",
    property_declaration: "property",
    constructor_declaration: "ctor",
    delegate_declaration: "delegate",
    namespace_declaration: "namespace",
    field_declaration: "field",
    event_declaration: "event",
    event_field_declaration: "event",
  },
};
const JSTS = {
  decl: new Set([
    "function_declaration",
    "generator_function_declaration",
    "class_declaration",
    "method_definition",
    "interface_declaration",
    "enum_declaration",
    "type_alias_declaration",
    "lexical_declaration",
    "variable_declaration",
    "public_field_definition",
    "abstract_method_signature",
    "function_signature",
    "abstract_class_declaration",
    "internal_module",
    "module",
  ]),
  kind: {
    function_declaration: "func",
    generator_function_declaration: "func",
    class_declaration: "class",
    abstract_class_declaration: "class",
    method_definition: "method",
    interface_declaration: "interface",
    enum_declaration: "enum",
    type_alias_declaration: "type",
    lexical_declaration: "const",
    variable_declaration: "var",
    public_field_definition: "field",
    abstract_method_signature: "method",
    function_signature: "func",
    internal_module: "namespace",
    module: "namespace",
  },
};
const PYTHON = {
  decl: new Set(["function_definition", "class_definition"]),
  kind: { function_definition: "func", class_definition: "class" },
};
const GO = {
  decl: new Set([
    "function_declaration",
    "method_declaration",
    "type_declaration",
    "const_declaration",
    "var_declaration",
  ]),
  kind: {
    function_declaration: "func",
    method_declaration: "method",
    type_declaration: "type",
    const_declaration: "const",
    var_declaration: "var",
  },
};
const JAVA = {
  decl: new Set([
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
    "record_declaration",
    "method_declaration",
    "constructor_declaration",
    "annotation_type_declaration",
  ]),
  kind: {
    class_declaration: "class",
    interface_declaration: "interface",
    enum_declaration: "enum",
    record_declaration: "record",
    method_declaration: "method",
    constructor_declaration: "ctor",
    annotation_type_declaration: "annotation",
  },
};
const RUST = {
  decl: new Set([
    "function_item",
    "struct_item",
    "enum_item",
    "trait_item",
    "impl_item",
    "mod_item",
    "type_item",
    "macro_definition",
    "const_item",
    "static_item",
    "union_item",
  ]),
  kind: {
    function_item: "func",
    struct_item: "struct",
    enum_item: "enum",
    trait_item: "trait",
    impl_item: "impl",
    mod_item: "mod",
    type_item: "type",
    macro_definition: "macro",
    const_item: "const",
    static_item: "static",
    union_item: "union",
  },
};
const RUBY = {
  decl: new Set(["method", "singleton_method", "class", "module"]),
  kind: { method: "method", singleton_method: "method", class: "class", module: "module" },
};
// §9.3: high-use untuned grammars promoted to the hand-tuned tier (node types verified against the bundled
// tree-sitter-lua / tree-sitter-solidity via a fixture — see eval/fixtures). Lua is ubiquitous in game/config
// scripting; Solidity has no clangd/LSP most devs run, so tree-sitter is the ONLY decl source.
const LUA = {
  decl: new Set([
    "function_definition_statement", // function foo() / function M.foo()
    "local_function_definition_statement", // local function foo()
    "local_variable_declaration", // local x = …
  ]),
  kind: {
    function_definition_statement: "func",
    local_function_definition_statement: "func",
    local_variable_declaration: "var",
  },
};
const SOLIDITY = {
  decl: new Set([
    "contract_declaration",
    "interface_declaration",
    "library_declaration",
    "function_definition",
    "constructor_definition",
    "modifier_definition",
    "event_definition",
    "struct_declaration",
    "enum_declaration",
    "state_variable_declaration", // storage vars (fields)
    "constant_variable_declaration",
    "error_declaration",
    "user_defined_type_definition",
  ]),
  kind: {
    contract_declaration: "class",
    interface_declaration: "interface",
    library_declaration: "namespace",
    function_definition: "func",
    constructor_definition: "ctor",
    modifier_definition: "modifier",
    event_definition: "event",
    struct_declaration: "struct",
    enum_declaration: "enum",
    state_variable_declaration: "field",
    constant_variable_declaration: "const",
    error_declaration: "error",
    user_defined_type_definition: "type",
  },
};
const GENERIC = {
  decl: new Set([
    "function_declaration",
    "function_definition",
    "class_declaration",
    "class_definition",
    "method_declaration",
    "method_definition",
  ]),
  kind: {},
};
// Sentinel config: "extract declarations via the canonical tags query in server/tags/<grammar>.scm" instead
// of a hand-tuned node-type walk. This is how coverage EXTENDS beyond the flagship languages — the official
// tree-sitter tags-query DSL (`@definition.<kind>` + `@name`) is loaded from a file, so adding a language is
// adding a .scm (+ an EXT_MAP entry), no JS. Charter-pure: tree-sitter's own query interface, glue = ours.
const TAGS = { tags: true };

// ext → { wasm, cfg }. wasm = tree-sitter-wasms/out/<wasm>.wasm basename (no extension).
const EXT_MAP = {
  c: ["c", C_CPP],
  h: ["cpp", C_CPP],
  hpp: ["cpp", C_CPP],
  hh: ["cpp", C_CPP],
  hxx: ["cpp", C_CPP],
  cpp: ["cpp", C_CPP],
  cc: ["cpp", C_CPP],
  cxx: ["cpp", C_CPP],
  inl: ["cpp", C_CPP],
  ipp: ["cpp", C_CPP],
  tpp: ["cpp", C_CPP],
  cs: ["c_sharp", CSHARP],
  ts: ["typescript", JSTS],
  mts: ["typescript", JSTS],
  cts: ["typescript", JSTS],
  tsx: ["tsx", JSTS],
  js: ["javascript", JSTS],
  jsx: ["javascript", JSTS],
  mjs: ["javascript", JSTS],
  cjs: ["javascript", JSTS],
  py: ["python", PYTHON],
  pyi: ["python", PYTHON],
  go: ["go", GO],
  java: ["java", JAVA],
  rs: ["rust", RUST],
  rb: ["ruby", RUBY],
  lua: ["lua", LUA], // §9.3: game/config scripting (verified node types)
  sol: ["solidity", SOLIDITY], // §9.3: no LSP most devs run → tree-sitter is the only decl source
  // Tags-query tier (canonical .scm extraction; validated against the bundled grammars). Extends the
  // syntactic rung past the hand-tuned flagship languages — see server/tags/*.scm.
  php: ["php", TAGS],
  php5: ["php", TAGS],
  phtml: ["php", TAGS],
  sh: ["bash", TAGS],
  bash: ["bash", TAGS],
  swift: ["swift", TAGS],
  kt: ["kotlin", TAGS],
  kts: ["kotlin", TAGS],
  scala: ["scala", TAGS],
  sc: ["scala", TAGS],
  dart: ["dart", TAGS],
  zig: ["zig", TAGS],
};

let _req; // createRequire anchor (or false once we know it's unavailable)
let _TS; // the web-tree-sitter module
let _initDone = false;
let _grammarsDir;
const _langCache = new Map(); // wasm basename → loaded Language (or null on failure)

function ensureReq() {
  if (_req === undefined) _req = resolver() || false;
  return _req;
}

// Lazy one-time wasm-runtime init. Returns the web-tree-sitter module, or null if unavailable.
async function ensureTS() {
  if (_initDone) return _TS;
  _initDone = true;
  const req = ensureReq();
  if (!req) return (_TS = null);
  try {
    _TS = await import(pathToFileURL(req.resolve("web-tree-sitter")).href);
    await _TS.Parser.init();
    _grammarsDir = path.join(path.dirname(req.resolve("tree-sitter-wasms/package.json")), "out");
  } catch (e) {
    console.error(`[${TAG}] tree-sitter unavailable: ${e?.message || e}`);
    _TS = null;
  }
  return _TS;
}

async function loadLanguage(wasmBase) {
  if (_langCache.has(wasmBase)) return _langCache.get(wasmBase);
  const TS = await ensureTS();
  if (!TS) {
    _langCache.set(wasmBase, null);
    return null;
  }
  try {
    const lang = await TS.Language.load(path.join(_grammarsDir, `tree-sitter-${wasmBase}.wasm`));
    _langCache.set(wasmBase, lang);
    return lang;
  } catch (e) {
    console.error(`[${TAG}] grammar ${wasmBase} failed: ${e?.message || e}`);
    _langCache.set(wasmBase, null);
    return null;
  }
}

function extOf(file) {
  const m = /\.([A-Za-z0-9]+)$/.exec(file);
  return m ? m[1].toLowerCase() : "";
}

// Is there a tree-sitter grammar for this file? (cheap, no load — drives the "should we even try" check.)
export function tsSupports(file) {
  return !!EXT_MAP[extOf(file)];
}

// Whether the tree-sitter tier is usable at all (deps resolve). Used for advisories / eval gating.
export function tsAvailable() {
  return !!ensureReq();
}

// Drill an identifier name out of a declaration node. childForFieldName("name") covers most grammars; C/C++
// hides the name inside nested declarators (function_declarator → … → identifier/field_identifier/
// qualified_identifier), so we walk declarator fields, then fall back to the first identifier-ish descendant.
const ID_TYPES =
  /^(identifier|type_identifier|field_identifier|qualified_identifier|scoped_identifier|namespace_identifier|constant|property_identifier|simple_identifier)$/;
function nameOf(node) {
  let n = node.childForFieldName && node.childForFieldName("name");
  if (n) return n.text;
  // C/C++: walk declarator chain to the innermost identifier.
  let d = node.childForFieldName && node.childForFieldName("declarator");
  let guard = 0;
  while (d && guard++ < 8) {
    if (ID_TYPES.test(d.type)) return d.text;
    const inner = d.childForFieldName && (d.childForFieldName("declarator") || d.childForFieldName("name"));
    if (!inner) break;
    d = inner;
  }
  // generic fallback: first identifier-ish named child (shallow), else first identifier descendant.
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (ID_TYPES.test(c.type)) return c.text;
  }
  const found = node.descendantsOfType
    ? node.descendantsOfType(["identifier", "type_identifier", "field_identifier"])
    : null;
  if (found && found[0]) return found[0].text;
  return null;
}

// ── TAGS-QUERY tier (the canonical, file-driven extractor for languages without a hand-tuned node config).
// A `server/tags/<grammar>.scm` written in tree-sitter's own query DSL captures `@definition.<kind>` on each
// declaration node and `@name` on its identifier; we read those out of the query matches. The file ships
// with the package (next to this module), so it resolves in every install layout without createRequire.
function tagsDir() {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  return path.join(here, "tags");
}
const _defTagsCache = new Map(); // wasm base → constructed Query | null (absent/failed)
async function defTagsQueryFor(wasmBase) {
  if (_defTagsCache.has(wasmBase)) return _defTagsCache.get(wasmBase);
  let q = null;
  try {
    const src = fs.readFileSync(path.join(tagsDir(), `${wasmBase}.scm`), "utf8");
    const lang = await loadLanguage(wasmBase);
    if (lang && _TS) q = new _TS.Query(lang, src);
  } catch {
    q = null; // no .scm for this grammar, or it failed to construct against the bundled version → graceful
  }
  _defTagsCache.set(wasmBase, q);
  return q;
}
// Map a `@definition.<suffix>` capture to a short kind label (parity with the hand-tuned KIND maps).
const TAG_KIND = {
  function: "func", method: "method", class: "class", struct: "struct", interface: "interface",
  enum: "enum", trait: "trait", type: "type", module: "namespace", namespace: "namespace",
  constant: "const", field: "field", macro: "macro", object: "object", protocol: "protocol", union: "union",
};
// Pull declarations out of a tags query's matches: each match carries a `@definition.<kind>` and a `@name`.
function extractTagDefs(q, root) {
  const out = [];
  for (const m of q.matches(root)) {
    let nameNode = null, kind = null;
    for (const c of m.captures) {
      if (c.name === "name") nameNode = c.node;
      else if (c.name.startsWith("definition.")) kind = TAG_KIND[c.name.slice(11)] || c.name.slice(11);
    }
    if (nameNode && kind && /[A-Za-z_]/.test(nameNode.text))
      out.push({ name: nameNode.text.slice(0, 80), kind, line: nameNode.startPosition.row + 1, col: nameNode.startPosition.column });
  }
  return out;
}
// Pull call references named `want` out of a tags query's `@reference.*` captures. A reference pattern
// captures the call target either directly (`@reference.call`) or via `@name` alongside a `@reference.*`;
// match the named node's text and dedupe by position.
function extractTagRefs(q, root, want) {
  const out = [];
  for (const m of q.matches(root)) {
    const hasRef = m.captures.some((c) => c.name.startsWith("reference"));
    if (!hasRef) continue;
    for (const c of m.captures) {
      if ((c.name.startsWith("reference") || c.name === "name") && c.node.text === want)
        out.push({ name: want, line: c.node.startPosition.row + 1, col: c.node.startPosition.column });
    }
  }
  const seen = new Set();
  return out.filter((r) => { const k = `${r.line}:${r.col}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// Parse one file and return its declarations: [{ name, kind, line (1-based), col (0-based) }].
// Bounded by maxBytes (a 2 MB generated file isn't worth parsing). Best-effort: any failure → [].
export async function tsFileSymbols(absPath, { maxBytes = 2_000_000 } = {}) {
  const ext = extOf(absPath);
  const entry = EXT_MAP[ext];
  if (!entry) return [];
  const [wasmBase, cfgIn] = entry;
  const cfg = cfgIn || GENERIC;
  let src;
  try {
    const st = fs.statSync(absPath);
    if (st.size > maxBytes) return [];
    src = fs.readFileSync(absPath, "utf8");
  } catch {
    return [];
  }
  const lang = await loadLanguage(wasmBase);
  if (!lang) return [];
  const TS = _TS;
  let parser, tree;
  try {
    parser = new TS.Parser();
    parser.setLanguage(lang);
    tree = parser.parse(src);
  } catch {
    return [];
  }
  // A recovered (ERROR/MISSING) tree still yields decls, but silently DROPS others — report it rather than
  // hide it. Carried as a property on the returned array: the array-with-extra-property idiom this module
  // already uses (tsSearchSymbols carries .truncated/.filesParsed/.unavailable; searchSymIndex carries
  // .fromIndex), so every existing caller keeps working unchanged and only the cert-aware ones read it.
  const health = parseHealth(tree);
  // Tags-query tier: a file-driven .scm extracts declarations for languages without a hand-tuned node config.
  if (cfg.tags) {
    const q = await defTagsQueryFor(wasmBase);
    let defs = [];
    try {
      if (q) defs = extractTagDefs(q, tree.rootNode);
    } catch {
      defs = [];
    }
    try {
      tree.delete && tree.delete();
      parser.delete && parser.delete();
    } catch {
      /* ignore */
    }
    const tagged = defs.slice(0, 5000);
    if (health.bad) { tagged.parseError = true; tagged.parseMissing = health.missing; }
    return tagged;
  }
  const out = [];
  const decl = cfg.decl,
    kindMap = cfg.kind;
  // Iterative DFS (deep files would blow a recursive stack). Skip diving into a node we've already captured?
  // No — methods live inside classes, so we must descend; we just don't double-count (each node tested once).
  const stack = [tree.rootNode];
  let guard = 0;
  while (stack.length && out.length < 5000 && guard++ < 200000) {
    const node = stack.pop();
    if (decl.has(node.type)) {
      // C/C++ `declaration`/`field_declaration` is only a symbol if it actually names something callable or a
      // member — a bare statement (`int x;` at file scope is fine, but `return x;` parses as neither). nameOf
      // returns null when there's nothing to name, so we drop those.
      const nm = nameOf(node);
      if (nm && /[A-Za-z_]/.test(nm)) {
        out.push({
          name: nm.slice(0, 80),
          kind: kindMap[node.type] || node.type,
          line: node.startPosition.row + 1,
          col: node.startPosition.column,
        });
      }
    }
    for (let i = node.namedChildCount - 1; i >= 0; i--) stack.push(node.namedChild(i));
  }
  try {
    tree.delete && tree.delete();
    parser.delete && parser.delete();
  } catch {
    /* ignore */
  }
  if (health.bad) { out.parseError = true; out.parseMissing = health.missing; }
  return out;
}

// PARSE HEALTH. tree-sitter never throws on input it can't parse — it RECOVERS, producing a tree with
// ERROR/MISSING nodes, and a decl walk over that tree quietly returns whatever survived. That is a silently
// incomplete answer with a confident label, the exact failure this project criticises grep for. Ask the
// engine's own API instead: `hasError` covers ERROR and MISSING descendants; the bounded isMissing scan is
// belt-and-braces for grammars where the flag doesn't propagate, and yields the `missing` count for the
// message. Real case: the bundled tree-sitter-lua parses a table constructor `local M = {}` as an
// unterminated string (ERROR + MISSING _string_end), and — because Lua's external scanner carries state in
// wasm memory — the error RECOVERY shifts with how many grammars are resident, so a following decl is
// dropped only sometimes. Not repairable from here (tree-sitter-wasms has no build past 0.1.13 and
// web-tree-sitter 0.26 can't load those wasms at all), so the answer is honesty, not repair.
function parseHealth(tree) {
  const root = tree && tree.rootNode;
  if (!root || !root.hasError) return { bad: false, missing: 0 };
  let missing = 0, guard = 0;
  const stack = [root];
  while (stack.length && guard++ < 20000) {
    const n = stack.pop();
    if (n.isMissing) missing++;
    for (let i = n.namedChildCount - 1; i >= 0; i--) stack.push(n.namedChild(i));
  }
  return { bad: true, missing };
}

// Resolve a symbol NAME to its FULL declaration span via tree-sitter — the read_symbol / edit twin of the
// LSP documentSymbol range, but with zero backend. Needed because read_symbol previously went STRAIGHT to
// clangd's documentSymbol: on a huge UE tree clangd can't serve fast, so the call timed out / returned an
// empty outline and read_symbol dead-ended (live: 6 failures in a row → the model gave up and Read the
// whole file). This mirrors the committed-index tier the search tools already fall back to.
//   name match: exact (`Foo`) OR trailing-qualified (`UAssetManager::Foo` matches a query of `Foo`), so a
//   bare method name resolves to its out-of-class definition. `line` (1-based, optional) disambiguates
//   same-named decls by nearest start. Returns { startRow, endRow (0-based, inclusive), name, kind, matches }
//   or null (deps absent / unsupported / too big / parse fail / no match).
export async function tsReadSymbol(absPath, want, { line = null, maxBytes = 2_000_000 } = {}) {
  const ext = extOf(absPath);
  const entry = EXT_MAP[ext];
  if (!entry || !want) return null;
  const [wasmBase, cfgIn] = entry;
  const cfg = cfgIn || GENERIC;
  if (!cfg.decl) return null; // tags-query langs don't carry node ranges here — LSP/structure tier handles them
  let src;
  try {
    const st = fs.statSync(absPath);
    if (st.size > maxBytes) return null;
    src = fs.readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
  const lang = await loadLanguage(wasmBase);
  if (!lang) return null;
  const TS = _TS;
  let parser, tree;
  try {
    parser = new TS.Parser();
    parser.setLanguage(lang);
    tree = parser.parse(src);
  } catch {
    return null;
  }
  try {
    // REFUSE on a bad parse. This span is not a report — it feeds tsResolveForEdit → replace_symbol_body /
    // safe_delete, which SPLICE THE FILE at it. A span computed from a recovered (wrong) tree overwrites the
    // wrong lines, i.e. silently corrupts the user's source. A read-only decl list can be honestly degraded;
    // a span cannot. Rule: read-only lists report, span-producing functions refuse. Null → the caller falls
    // back to the LSP/other tiers exactly as it already does when tree-sitter is unavailable.
    if (parseHealth(tree).bad) return null;
    const decl = cfg.decl, kindMap = cfg.kind || {};
    const hits = [];
    const stack = [tree.rootNode];
    let guard = 0;
    while (stack.length && guard++ < 200000) {
      const node = stack.pop();
      if (decl.has(node.type)) {
        const nm = nameOf(node);
        // exact, or the query is the trailing segment of a qualified name (Class::method, ns::fn)
        if (nm && (nm === want || nm.endsWith("::" + want) || nm.split("::").pop() === want)) {
          hits.push({ startRow: node.startPosition.row, endRow: node.endPosition.row, name: nm.slice(0, 120), kind: kindMap[node.type] || node.type });
        }
      }
      for (let i = node.namedChildCount - 1; i >= 0; i--) stack.push(node.namedChild(i));
    }
    if (!hits.length) return null;
    // Prefer a match whose name is EXACTLY the query (a bare-name decl over a coincidental qualified one),
    // then — when a line hint is given — the nearest start; otherwise the LARGEST span (the definition with a
    // body beats a one-line forward declaration).
    hits.sort((a, b) => {
      const ax = a.name === want ? 0 : 1, bx = b.name === want ? 0 : 1;
      if (ax !== bx) return ax - bx;
      if (line != null) return Math.abs(a.startRow - (line - 1)) - Math.abs(b.startRow - (line - 1));
      return (b.endRow - b.startRow) - (a.endRow - a.startRow);
    });
    return { ...hits[0], matches: hits.length };
  } catch {
    return null;
  } finally {
    try {
      tree.delete && tree.delete();
      parser.delete && parser.delete();
    } catch {
      /* ignore */
    }
  }
}

// cAST-inspired structural chunking (migrated from "cAST: Structural Chunking via AST", arXiv:2506.15655):
// when a declaration body exceeds a line budget, cut at a STRUCTURAL boundary (the end of a complete child
// node — a member/statement) instead of mid-statement, so read_symbol returns syntactically whole output
// rather than a body truncated in the middle of an expression. Greedy: keep whole children from the decl's
// start until the next one would exceed `maxLines`, end at the last child that fits.
//   Returns { endRow (0-based, inclusive), omitted } — the structural cut row + how many trailing children
//   were dropped. Returns null (caller falls back to the plain line-cap) when tree-sitter is unavailable, the
//   file is unsupported/too big, parsing fails, no covering node is found, or there's nothing to gain (a single
//   over-budget child, or every child already fits). Charter-pure: official parser, local, no transmission.
export async function tsChunkEnd(absPath, startRow, endRow, maxLines) {
  const ext = extOf(absPath);
  const entry = EXT_MAP[ext];
  if (!entry) return null;
  const [wasmBase] = entry;
  let src;
  try {
    const st = fs.statSync(absPath);
    if (st.size > 2_000_000) return null;
    src = fs.readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
  const lang = await loadLanguage(wasmBase);
  if (!lang) return null;
  const TS = _TS;
  let parser, tree;
  try {
    parser = new TS.Parser();
    parser.setLanguage(lang);
    tree = parser.parse(src);
  } catch {
    return null;
  }
  try {
    // REFUSE on a bad parse — same rule as tsReadSymbol: this produces a SPAN, not a report. The whole point
    // of a structural cut is that it lands on a complete child; computed from a recovered tree it can cut
    // mid-statement, which is worse than the plain line-cap the caller falls back to on null.
    if (parseHealth(tree).bad) return null;
    // Locate the declaration node: the smallest named node at the start position, climbed up to the largest
    // node that still begins at startRow and ends within the decl span (the function/class/etc. itself).
    let node = tree.rootNode.namedDescendantForPosition({ row: startRow, column: 0 });
    while (node && node.parent && node.parent.startPosition.row >= startRow && node.parent.endPosition.row <= endRow) node = node.parent;
    if (!node) return null;
    // Prefer the BODY container (block/suite/...) — its children are the members/statements to chunk over. If
    // none is found (a flat decl), chunk the decl's own named children.
    let body = null;
    for (let i = 0; i < node.namedChildCount; i++) {
      const ch = node.namedChild(i);
      if (ch.endPosition.row > ch.startPosition.row && /block|body|suite|declaration_list|statement_block|compound_statement|class_body|object/.test(ch.type)) { body = ch; break; }
    }
    const container = body || node;
    let cut = startRow, kept = 0, total = 0;
    for (let i = 0; i < container.namedChildCount; i++) {
      const k = container.namedChild(i);
      total++;
      if (k.endPosition.row - startRow + 1 > maxLines) continue; // this child overflows the budget — skip, try smaller siblings
      if (k.endPosition.row > cut) { cut = k.endPosition.row; kept++; }
    }
    if (kept === 0 || kept === total) return null; // single over-budget child, or everything fit → no structural win
    return { endRow: cut, omitted: total - kept };
  } catch {
    return null;
  } finally {
    try {
      tree.delete && tree.delete();
      parser.delete && parser.delete();
    } catch {
      /* ignore */
    }
  }
}

// Walk a directory subtree, parse supported files, return declarations whose name matches `q`, ranked
// exact-before-substring. Bounded by a time box and a file cap so a huge tree can't hang. skipDir decides
// which directories to descend (shared with scanTextUnder's SKIP_DIRS via the injected predicate).
// Returns an array of { name, kind, file, line } with a `.truncated` marker ("time"|"cap") when bounded.
export async function tsSearchSymbols(
  root,
  q,
  { max = 40, skipDir, timeBudgetMs = 6000, fileCap = 4000 } = {},
) {
  const qToks0 = splitIdent(q); // token-aware (LocAgent): a multi-word query scores by coverage, not literal substring
  await ensureTS();
  if (!_TS) {
    const e = [];
    e.unavailable = true;
    return e;
  }
  const hits = [];
  const partials = []; // multi-word coverage >= VTS_SYM_COVER_MIN, used ONLY if the strict AND pass is empty
  const multiWord = qToks0.length >= 2 && /\s/.test(q);
  const partialMin = Number(process.env.VTS_SYM_COVER_MIN ?? 0.6);
  const stack = [root];
  const t0 = Date.now();
  let filesParsed = 0,
    timedOut = false,
    capped = false;
  const skip = skipDir || (() => false);
  while (stack.length) {
    if (Date.now() - t0 >= timeBudgetMs) {
      timedOut = true;
      break;
    }
    const dir = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip(e.name)) stack.push(p);
        continue;
      }
      if (!tsSupports(e.name)) continue;
      if (Date.now() - t0 >= timeBudgetMs) {
        timedOut = true;
        break;
      }
      if (filesParsed >= fileCap) {
        capped = true;
        break;
      }
      filesParsed++;
      let syms;
      try {
        syms = await tsFileSymbols(p);
      } catch {
        continue;
      }
      for (const s of syms) {
        const r = symbolMatchScore(s.name, qToks0, q);
        if (r) hits.push({ ...s, file: p.replace(/\\/g, "/"), rank: r });
        else if (multiWord) {
          const rp = symbolMatchScore(s.name, qToks0, q, partialMin); // partial coverage — kept only as a fallback
          if (rp) partials.push({ ...s, file: p.replace(/\\/g, "/"), rank: rp });
        }
      }
    }
    if (timedOut || capped) break;
  }
  // strict AND results win; partials surface ONLY when AND found nothing (recall on an otherwise-empty
  // multi-word query, no precision cost to a non-empty precise result).
  const out = hits.length ? hits : partials;
  out.sort((a, b) => b.rank - a.rank || a.name.length - b.name.length);
  const sliced = out.slice(0, max);
  if (out.length > max) sliced.truncated = "cap";
  else if (timedOut) sliced.truncated = "time";
  else if (capped) sliced.truncated = "files";
  sliced.filesParsed = filesParsed;
  return sliced;
}

// ── REFERENCES (tree-sitter tags-query, the codebase-memory-mcp lesson). The node-type walk above finds
// DECLARATIONS; tree-sitter's `tags.scm` convention also captures call SITES. So even with no language
// server, find_references gets a real *call reference* fallback — strictly better than the literal `grep
// <name>` it replaces (a call site, not every textual mention). Still SYNTACTIC: it does not resolve which
// overload/scope, so the LSP stays the source of truth above it. Queries validated per grammar (11 langs);
// a grammar without one (or a query that fails to construct) simply yields no syntactic refs (graceful).
const REF_QUERIES = {
  python: `(call function: [(identifier) @ref (attribute attribute: (identifier) @ref)])`,
  javascript: `(call_expression function: [(identifier) @ref (member_expression property: (property_identifier) @ref)])`,
  typescript: `(call_expression function: [(identifier) @ref (member_expression property: (property_identifier) @ref)])`,
  tsx: `(call_expression function: [(identifier) @ref (member_expression property: (property_identifier) @ref)])`,
  go: `(call_expression function: [(identifier) @ref (selector_expression field: (field_identifier) @ref)])`,
  java: `(method_invocation name: (identifier) @ref)`,
  c_sharp: `(invocation_expression (member_access_expression name: (identifier) @ref)) (invocation_expression function: (identifier) @ref)`,
  c: `(call_expression function: (identifier) @ref)`,
  cpp: `(call_expression function: [(identifier) @ref (field_expression field: (field_identifier) @ref) (qualified_identifier name: (identifier) @ref)])`,
  rust: `(call_expression function: (identifier) @ref) (macro_invocation macro: (identifier) @ref)`,
  ruby: `(call method: (identifier) @ref)`,
};
const _refQueryCache = new Map(); // wasm base → constructed Query | null

async function refQueryFor(wasmBase) {
  if (_refQueryCache.has(wasmBase)) return _refQueryCache.get(wasmBase);
  const src = REF_QUERIES[wasmBase];
  const lang = src ? await loadLanguage(wasmBase) : null;
  let q = null;
  if (lang && _TS) {
    try {
      q = new _TS.Query(lang, src);
    } catch {
      q = null;
    }
  }
  _refQueryCache.set(wasmBase, q);
  return q;
}

// Capture call references to `name` in one file. Returns [{ name, line (1-based), col }]. Best-effort → [].
export async function tsFileReferences(absPath, name, { maxBytes = 2_000_000 } = {}) {
  const entry = EXT_MAP[extOf(absPath)];
  if (!entry) return [];
  const wasmBase = entry[0];
  const cfg = entry[1] || GENERIC;
  // TAGS languages carry their `@reference.*` captures in the same .scm; others use the inline REF_QUERIES.
  const q = cfg.tags ? await defTagsQueryFor(wasmBase) : await refQueryFor(wasmBase);
  if (!q) return [];
  let src;
  try {
    const st = fs.statSync(absPath);
    if (st.size > maxBytes) return [];
    src = fs.readFileSync(absPath, "utf8");
  } catch {
    return [];
  }
  const lang = await loadLanguage(wasmBase);
  if (!lang) return [];
  let parser, tree;
  try {
    parser = new _TS.Parser();
    parser.setLanguage(lang);
    tree = parser.parse(src);
  } catch {
    return [];
  }
  let out = [];
  const want = String(name);
  try {
    if (cfg.tags) {
      out = extractTagRefs(q, tree.rootNode, want);
    } else {
      for (const c of q.captures(tree.rootNode)) {
        if (c.node.text === want)
          out.push({ name: want, line: c.node.startPosition.row + 1, col: c.node.startPosition.column });
      }
    }
  } catch {
    /* ignore */
  }
  try {
    tree.delete && tree.delete();
    parser.delete && parser.delete();
  } catch {
    /* ignore */
  }
  return out;
}

// Walk a subtree and collect call references to `name` across files (bounded). Same shape/markers as
// tsSearchSymbols ({ name, line, col, file } + `.truncated`/`.filesParsed`; `.unavailable` if deps absent).
export async function tsSearchReferences(
  root,
  name,
  { skipDir, timeBudgetMs = 6000, fileCap = 4000, max = 200 } = {},
) {
  await ensureTS();
  if (!_TS) {
    const e = [];
    e.unavailable = true;
    return e;
  }
  const hits = [];
  const stack = [root];
  const t0 = Date.now();
  let filesParsed = 0,
    timedOut = false,
    capped = false;
  const skip = skipDir || (() => false);
  while (stack.length) {
    if (Date.now() - t0 >= timeBudgetMs) {
      timedOut = true;
      break;
    }
    const dir = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip(e.name)) stack.push(p);
        continue;
      }
      if (!tsSupports(e.name)) continue;
      if (Date.now() - t0 >= timeBudgetMs) {
        timedOut = true;
        break;
      }
      if (filesParsed >= fileCap) {
        capped = true;
        break;
      }
      filesParsed++;
      let refs;
      try {
        refs = await tsFileReferences(p, name);
      } catch {
        continue;
      }
      for (const r of refs) hits.push({ ...r, file: p.replace(/\\/g, "/") });
      if (hits.length > max) {
        capped = true;
        break;
      }
    }
    if (timedOut || capped) break;
  }
  const sliced = hits.slice(0, max);
  if (hits.length > max) sliced.truncated = "cap";
  else if (timedOut) sliced.truncated = "time";
  else if (capped) sliced.truncated = "files";
  sliced.filesParsed = filesParsed;
  return sliced;
}

// ── CONCEPT UNITS (approach B's input): a declaration plus the comment/docstring attached to it. The concept
// dictionary (concept.js) is mined from these — tokens that name the same thing co-occur within one unit. We
// collect decls AND comment nodes in one AST walk, then attach each contiguous comment block sitting in the
// `gap` lines directly above a decl to that decl (the standard leading-comment convention). Returns
// [{ name, kind, line, doc }] where doc is the joined leading-comment text (empty string if none).
export async function tsFileDeclDocs(absPath, { maxBytes = 2_000_000, gap = 3 } = {}) {
  const entry = EXT_MAP[extOf(absPath)];
  if (!entry) return [];
  const [wasmBase, cfgIn] = entry;
  // TAGS-tier languages have no node-type `decl` set — use the GENERIC walk for the concept-unit doc pass
  // (best-effort; the tags tier itself drives symbol/reference, this only feeds the fuzzy concept dictionary).
  const cfg = cfgIn && cfgIn.decl ? cfgIn : GENERIC;
  let src;
  try {
    const st = fs.statSync(absPath);
    if (st.size > maxBytes) return [];
    src = fs.readFileSync(absPath, "utf8");
  } catch {
    return [];
  }
  const lang = await loadLanguage(wasmBase);
  if (!lang) return [];
  let parser, tree;
  try {
    parser = new _TS.Parser();
    parser.setLanguage(lang);
    tree = parser.parse(src);
  } catch {
    return [];
  }
  const decls = [];
  const comments = []; // { startRow, endRow, text }
  const decl = cfg.decl;
  const stack = [tree.rootNode];
  let guard = 0;
  while (stack.length && guard++ < 200000) {
    const node = stack.pop();
    if (node.type === "comment") {
      comments.push({ startRow: node.startPosition.row, endRow: node.endPosition.row, text: node.text });
    } else if (decl.has(node.type)) {
      const nm = nameOf(node);
      if (nm && /[A-Za-z_]/.test(nm)) {
        decls.push({
          name: nm.slice(0, 80),
          kind: cfg.kind[node.type] || node.type,
          row: node.startPosition.row,
        });
      }
    }
    for (let i = node.namedChildCount - 1; i >= 0; i--) stack.push(node.namedChild(i));
  }
  try {
    tree.delete && tree.delete();
    parser.delete && parser.delete();
  } catch {
    /* ignore */
  }
  // Attach: a comment whose LAST line is within `gap` lines above a decl's first line belongs to it — BUT a
  // block spanning >= maxDocLines is a FILE header, not this decl's docstring, so skip it, and cap the joined
  // doc to maxDocChars. maxDocLines was 4, which dropped a well-written multi-line section/function docstring
  // (e.g. a 12-line "ANTI-FABRICATION GUARD" header above verifyAnswerPaths) — so the better-documented a
  // function, the LESS concept_search could find it. Raised to 20: a real file header is longer still (and is
  // separated from the first decl by imports/gap anyway), while maxDocChars keeps the token cost bounded.
  comments.sort((a, b) => a.startRow - b.startRow);
  // Tree-sitter emits each `//` line as its OWN comment node, so a 12-line `//` docstring arrived as 12
  // separate 1-line comments — only the last stayed within `gap` of the decl, dropping the rest INCLUDING the
  // leading summary line (e.g. "ANTI-FABRICATION GUARD" above verifyAnswerPaths → concept_search never saw it).
  // Fuse adjacent comments (no blank line between: next.startRow <= prev.endRow + 1) into one block first, so
  // the whole docstring reconciles against the decl below by its LAST line.
  const merged = [];
  for (const c of comments) {
    const last = merged[merged.length - 1];
    if (last && c.startRow <= last.endRow + 1) { last.endRow = c.endRow; last.text += " " + c.text; }
    else merged.push({ startRow: c.startRow, endRow: c.endRow, text: c.text });
  }
  const out = [];
  const maxDocLines = Number(process.env.VTS_CONCEPT_DOC_LINES) || 20,
    maxDocChars = 200;
  for (const d of decls) {
    const docs = [];
    for (const c of merged) {
      if (c.endRow < d.row && d.row - c.endRow <= gap && c.endRow - c.startRow < maxDocLines)
        docs.push(c.text);
    }
    out.push({ name: d.name, kind: d.kind, line: d.row + 1, doc: docs.join(" ").slice(0, maxDocChars) });
  }
  return out;
}

// ── HTML EMBEDDED-CODE INJECTION (the robustness upgrade over the textstruct.js heuristic brace-scan). The
// HTML structure provider locates `<script>`/`<style>` blocks and, WITHIN them, the top-level JS functions /
// CSS rules by counting brace depth — exact for well-formatted code, but a minified or oddly-formatted block
// degrades to the whole block. Tree-sitter is the official parser for those very languages, so here we re-parse
// each embedded block with the real javascript / css grammar and hand back EXACT decl ranges. textstruct.js
// stays pure (no fs/async/tree-sitter) — it tags its heuristic embedded heads with `embedded` and core.js
// supplies THIS as the injector, which REPLACES those heads when tree-sitter is available. Returns null when
// tree-sitter is unavailable (caller keeps the heuristic) — never throws.

// Count of newlines before a string offset (= the 0-based line the offset sits on; added to a within-block
// 1-based line to get the absolute 1-based line).
function _newlinesBefore(s, idx) {
  let n = 0;
  for (let i = 0; i < idx && i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

// Walk a raw source STRING with a hand-tuned cfg (decl set + kind map) and return declarations with EXACT
// start+end lines (1-based, within the string). `maxBlockDepth` bounds how deeply nested a decl may be (depth =
// the count of enclosing `{ }` scopes — statement_block / class_body): 0 = top-level only, 1 ALSO captures the
// VERY common pattern of a script wrapped in one top-level IIFE (`(function(){ … })()`) and the methods of a
// top-level class, while still skipping the inner helper closures (depth ≥ 2) that would clutter the outline.
// This is the robustness win over the heuristic, which — like a depth-0 filter — misses an IIFE-wrapped decl
// entirely. Best-effort → [].
const _TS_BLOCK = new Set(["statement_block", "class_body"]);
async function tsDeclsInString(wasmBase, src, cfg, maxBlockDepth = 1) {
  const lang = await loadLanguage(wasmBase);
  if (!lang || !_TS) return [];
  let parser, tree;
  try {
    parser = new _TS.Parser();
    parser.setLanguage(lang);
    tree = parser.parse(src);
  } catch {
    return [];
  }
  const out = [];
  const stack = [[tree.rootNode, 0]]; // [node, enclosing-block depth]
  let guard = 0;
  while (stack.length && out.length < 5000 && guard++ < 200000) {
    const [node, bd] = stack.pop();
    if (cfg.decl.has(node.type) && (maxBlockDepth == null || bd <= maxBlockDepth)) {
      const nm = nameOf(node);
      if (nm && /[A-Za-z_$]/.test(nm))
        out.push({
          name: nm.slice(0, 80),
          kind: cfg.kind[node.type] || node.type,
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });
    }
    const childBd = bd + (_TS_BLOCK.has(node.type) ? 1 : 0);
    for (let i = node.namedChildCount - 1; i >= 0; i--) stack.push([node.namedChild(i), childBd]);
  }
  try {
    tree.delete && tree.delete();
    parser.delete && parser.delete();
  } catch {
    /* ignore */
  }
  return out;
}

// Top-level CSS rules / at-rules with EXACT ranges (the css grammar has its own node shapes, so a small
// dedicated walk rather than the cfg-driven one). rule_set → its selector text; at-rules → the text up to `{`.
const _CSS_AT = new Set(["media_statement", "keyframes_statement", "supports_statement", "at_rule"]);
async function tsCssDeclsInString(src) {
  const lang = await loadLanguage("css");
  if (!lang || !_TS) return [];
  let parser, tree;
  try {
    parser = new _TS.Parser();
    parser.setLanguage(lang);
    tree = parser.parse(src);
  } catch {
    return [];
  }
  const out = [];
  const root = tree.rootNode;
  for (let i = 0; i < root.namedChildCount; i++) {
    const node = root.namedChild(i);
    let name = null,
      kind = null;
    if (node.type === "rule_set") {
      let sel = null;
      for (let j = 0; j < node.namedChildCount; j++)
        if (node.namedChild(j).type === "selectors") {
          sel = node.namedChild(j);
          break;
        }
      name = (sel ? sel.text : node.text.split("{")[0]).replace(/\s+/g, " ").trim();
      kind = "rule";
    } else if (_CSS_AT.has(node.type)) {
      name = node.text.split("{")[0].replace(/\s+/g, " ").trim();
      kind = "at-rule";
    }
    if (name && /\S/.test(name))
      out.push({ name: name.slice(0, 80), kind, line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
  }
  try {
    tree.delete && tree.delete();
    parser.delete && parser.delete();
  } catch {
    /* ignore */
  }
  return out;
}

// Re-parse every `<script>`/`<style>` block of an HTML document with the real javascript/css grammar and return
// the embedded decls as flat heads [{ level:2, title, line, endLine, kind, embedded }] in ABSOLUTE 1-based
// lines. core.js merges these over textstruct's heuristic embedded heads. null ⇒ tree-sitter unavailable.
export async function htmlEmbeddedDecls(text) {
  await ensureTS();
  if (!_TS) return null;
  const src = String(text);
  const out = [];
  let m;
  const reScript = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  while ((m = reScript.exec(src))) {
    const attrs = m[1] || "";
    const inner = m[2] || "";
    // Skip non-JS scripts (JSON, importmap, text/template) — only real JS/module blocks carry decls.
    const ty = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    if (ty && !/^(text\/)?(javascript|ecmascript|babel|jsx)$|module/i.test(ty[1])) continue;
    if (!inner.trim()) continue;
    const offset = _newlinesBefore(src, m.index + (m[0].length - inner.length - 9)); // 9 = "</script>"
    let decls;
    try {
      decls = await tsDeclsInString("javascript", inner, JSTS, 1); // depth ≤ 1 → top-level + one IIFE wrapper
    } catch {
      decls = [];
    }
    for (const d of decls)
      out.push({ level: 2, title: d.name, line: d.line + offset, endLine: d.endLine + offset, kind: d.kind, embedded: "script" });
  }
  const reStyle = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  while ((m = reStyle.exec(src))) {
    const inner = m[1] || "";
    if (!inner.trim()) continue;
    const offset = _newlinesBefore(src, m.index + (m[0].length - inner.length - 8)); // 8 = "</style>"
    let decls;
    try {
      decls = await tsCssDeclsInString(inner);
    } catch {
      decls = [];
    }
    for (const d of decls)
      out.push({ level: 2, title: d.name, line: d.line + offset, endLine: d.endLine + offset, kind: d.kind, embedded: "style" });
  }
  return out;
}
