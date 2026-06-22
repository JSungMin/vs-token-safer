// treesitter.js — SYNTACTIC symbol tier (the zero-setup fallback below the semantic LSP).
//
// Charter: "engine = official, glue = ours." The LSP backends (clangd/Roslyn/tsserver/pyright) stay the
// PRIMARY engine — compiler-grade, semantic. But they need a toolchain (a compile_commands.json, clangd ≥ 22,
// a .sln, an installed LSP). On a repo with none of that, vts used to fall straight to a literal `grep <name>`
// scan (scanTextUnder) — which returns every USAGE line, not declarations, and can't tell a class from a
// comment. Tree-sitter is an OFFICIAL standard parser (the GitHub / neovim engine), shipped here as prebuilt
// wasm grammars (tree-sitter-wasms) run by the wasm runtime (web-tree-sitter) — no native build, works on
// Windows. It gives a real AST → DECLARATIONS with names + lines, for 36 languages, with ZERO project setup.
//
// This tier is SYNTACTIC, not semantic: it finds where a symbol is DECLARED (and a file's outline), but it
// does NOT resolve references, overloads, or types across files — that stays the LSP's job. So it slots
// BETWEEN the semantic LSP (when available) and the literal text scan (last resort). Output is the same
// token-capped file:line; nothing is transmitted; wasm + grammars load lazily only when actually used.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

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

// Last segment of a qualified name (FooBar::DoThing → DoThing, a.b.c → c) for matching against a bare query.
function tailName(name) {
  const m = String(name).split(/::|\.|\//);
  return m[m.length - 1] || name;
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
  return out;
}

// Match a declaration name against a query. Exact (case-insensitive) on the full name or its last segment
// wins; otherwise a case-insensitive substring (so "Foo" finds "FooBar" and "ns::FooBar").
function matches(name, q) {
  const ln = name.toLowerCase(),
    lq = q.toLowerCase();
  if (ln === lq || tailName(name).toLowerCase() === lq) return 2; // exact
  if (ln.includes(lq)) return 1; // substring
  return 0;
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
      let syms;
      try {
        syms = await tsFileSymbols(p);
      } catch {
        continue;
      }
      for (const s of syms) {
        const r = matches(s.name, q);
        if (r) hits.push({ ...s, file: p.replace(/\\/g, "/"), rank: r });
      }
    }
    if (timedOut || capped) break;
  }
  hits.sort((a, b) => b.rank - a.rank || a.name.length - b.name.length);
  const sliced = hits.slice(0, max);
  if (hits.length > max) sliced.truncated = "cap";
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
  const q = await refQueryFor(wasmBase);
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
  const out = [];
  const want = String(name);
  try {
    for (const c of q.captures(tree.rootNode)) {
      if (c.node.text === want)
        out.push({ name: want, line: c.node.startPosition.row + 1, col: c.node.startPosition.column });
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
  // long block is a file/section header, not this decl's docstring, so skip blocks spanning >= maxDocLines and
  // cap the joined doc to maxDocChars. Keeps the unit a tight name+docstring scope (the concept signal) rather
  // than letting a header pollute the first decl below it.
  comments.sort((a, b) => a.startRow - b.startRow);
  const out = [];
  const maxDocLines = 4,
    maxDocChars = 200;
  for (const d of decls) {
    const docs = [];
    for (const c of comments) {
      if (c.endRow < d.row && d.row - c.endRow <= gap && c.endRow - c.startRow < maxDocLines)
        docs.push(c.text);
    }
    out.push({ name: d.name, kind: d.kind, line: d.row + 1, doc: docs.join(" ").slice(0, maxDocChars) });
  }
  return out;
}
