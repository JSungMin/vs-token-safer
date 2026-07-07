// Tool DEFINITIONS for the MCP server, isolated from index.js so they can be measured/asserted
// WITHOUT importing the SDK-dependent server (the toolchain-free eval gate spawns nothing). index.js
// imports TOOLS + ADMIN_OPS from here. Pure data + one Set — no imports, no side effects.
//
// SCHEMA IS A FIXED PER-REQUEST CONTEXT COST (the tool list rides in every API call). So descriptions are
// TERSE and self-evident common params (projectPath/backend/maxResults) carry NO description — their name
// says it. The routing cue (use-instead-of-grep/Edit) and the `0-based` note on positions are kept; those
// change model behaviour. eval guard 62 caps the total token budget so prose can't creep back.
const ROOT = { type: "string" }; // projectPath — project root (default: configured/cwd)
const BACKEND = { type: "string" }; // clangd|roslyn|typescript|pyright — auto-detected
const CAP = { type: "number" }; // maxResults — result cap (default 60)

export const TOOLS = [
  {
    name: "search_symbol",
    description:
      "Find a symbol DECLARATION (class/function/type/var) by name/substring — semantic index, not grep. → capped `kind name @ file:line`, no bodies. Use instead of grep/rg to locate a symbol.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Symbol name or substring." },
        path: { type: "string", description: "Scope to a file/class (basename or path substring). An inherited symbol not declared there is reported tree-wide." },
        projectPath: ROOT,
        backend: BACKEND,
        maxResults: CAP,
      },
      required: ["q"],
    },
  },
  {
    name: "find_references",
    description:
      "Every call site of a symbol (semantic, not grep) — pass `symbol` (a name); resolves the decl + returns all refs in one call. → capped `file:line`; detail=file|dir for a blast-radius summary; direction=callers|callees switches to a multi-hop call hierarchy. Use before changing a function.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol NAME — resolved via the index, no position needed." },
        path: { type: "string", description: "Source file (+line/character for an exact position, or with `symbol` to disambiguate an overload)." },
        line: { type: "number", description: "0-based line." },
        character: { type: "number", description: "0-based column." },
        includeDeclaration: { type: "boolean" },
        detail: { type: "string", description: "`file`|`dir` blast-radius summary." },
        direction: { type: "string", description: "callers|callees call hierarchy." },
        depth: { type: "number", description: "Call-hierarchy hops (default 2)." },
        projectPath: ROOT,
        backend: BACKEND,
        maxResults: CAP,
      },
    },
  },
  {
    name: "goto_definition",
    description: "Jump from a 0-based position to a definition (semantic). `kind`: definition (default)|type_definition|implementation|declaration. → capped `file:line`. For usages, use find_references.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Source file containing the symbol." },
        line: { type: "number", description: "0-based line." },
        character: { type: "number", description: "0-based column." },
        kind: { type: "string", description: "definition (default)|type_definition|implementation|declaration." },
        projectPath: ROOT,
        backend: BACKEND,
        maxResults: CAP,
      },
      required: ["path", "line", "character"],
    },
  },
  {
    name: "diagnostics",
    description: "Compiler/linter errors + warnings (semantic) → capped `file:line:col severity [code]: message`, sorted error→hint with a count — the compact stand-in for raw build output. Empty = clean. Default = one `path`; scope=\"directory\" scans the project.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to check (or, with scope=directory, the subtree to scan; default = root)." },
        scope: { type: "string", description: "`file` (default) | `directory` (scan project)." },
        projectPath: ROOT,
        backend: BACKEND,
        maxResults: CAP,
      },
    },
  },
  {
    name: "hover",
    description: "Type/signature of the symbol at a 0-based position (hover) — a few lines, no file open.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Source file." },
        line: { type: "number", description: "0-based line." },
        character: { type: "number", description: "0-based column." },
        projectPath: ROOT,
        backend: BACKEND,
      },
      required: ["path", "line", "character"],
    },
  },
  {
    name: "document_symbols",
    description: "Outline a file — classes/functions/types as a capped `kind name :line` list. Cheaper than reading the whole file for its structure. scope=\"directory\" builds a signatures-only skeleton of every code file under `path`.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to outline (or, with scope=directory, the subtree; default = root)." },
        scope: { type: "string", description: "`file` (default) | `directory` (skeleton of every file under it)." },
        projectPath: ROOT,
        backend: BACKEND,
        maxResults: CAP,
      },
    },
  },
  {
    name: "read_symbol",
    description: "USE INSTEAD OF Read on a file when you only need ONE function/class — returns just that named declaration's source (its span), not the whole file (the read twin of replace_symbol_body). `signatureOnly` = head only; body capped by VTS_SYMBOL_MAX_LINES.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Declaration name to read." },
        path: { type: "string", description: "File holding the symbol (else resolved via the index)." },
        line: { type: "number", description: "0-based line; disambiguate same-named (optional)." },
        signatureOnly: { type: "boolean", description: "Return just the declaration head." },
        projectPath: ROOT,
        backend: BACKEND,
      },
      required: ["symbol"],
    },
  },
  {
    name: "rename",
    description: "Rename the symbol at a 0-based position project-wide (semantic — every reference, not a sed). PREVIEW by default (affected `file:line`); apply=true writes. Use instead of editing call sites by hand.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Source file containing the symbol." },
        line: { type: "number", description: "0-based line." },
        character: { type: "number", description: "0-based column." },
        newName: { type: "string", description: "New name." },
        apply: { type: "boolean", description: "Write to disk (default false = preview)." },
        projectPath: ROOT,
        backend: BACKEND,
        maxResults: CAP,
      },
      required: ["path", "line", "character", "newName"],
    },
  },
  {
    name: "replace_symbol_body",
    description: "Change a whole function/class/method by NAMING it — USE INSTEAD OF Read-the-file + Edit (the outline gives the span, so you skip the whole-file Read and exact-match line-counting). PREVIEW by default; apply=true writes in ONE call.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Declaration name to replace." },
        body: { type: "string", description: "New full text (signature + body)." },
        path: { type: "string", description: "File holding the symbol (else resolved via the index)." },
        line: { type: "number", description: "0-based line; disambiguate same-named (optional)." },
        apply: { type: "boolean", description: "Write to disk (default false = preview)." },
        projectPath: ROOT,
        backend: BACKEND,
        maxResults: CAP,
      },
      required: ["symbol", "body"],
    },
  },
  {
    name: "insert_symbol",
    description: "Insert text next to a named declaration — position=after (default)|before. The outline gives the point (no Read). PREVIEW by default; apply=true writes. Use instead of Read-then-Edit to add a declaration.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Declaration to insert next to." },
        text: { type: "string", description: "Text to insert (own line)." },
        position: { type: "string", description: "`after` (default) | `before`." },
        path: { type: "string", description: "File holding the symbol (else resolved via the index)." },
        line: { type: "number", description: "0-based line; disambiguate same-named (optional)." },
        apply: { type: "boolean", description: "Write to disk (default false = preview)." },
        projectPath: ROOT,
        backend: BACKEND,
        maxResults: CAP,
      },
      required: ["symbol", "text"],
    },
  },
  {
    name: "safe_delete",
    description: "Delete a named declaration — USE INSTEAD OF Edit-deleting it; REFUSES while still referenced (lists the refs, force=true overrides) so a delete can't silently orphan call sites. PREVIEW by default; apply=true writes.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Declaration to delete." },
        path: { type: "string", description: "File holding the symbol (else resolved via the index)." },
        line: { type: "number", description: "0-based line; disambiguate same-named (optional)." },
        force: { type: "boolean", description: "Delete even if referenced (default false = refuse)." },
        apply: { type: "boolean", description: "Write to disk (default false = preview)." },
        projectPath: ROOT,
        backend: BACKEND,
        maxResults: CAP,
      },
      required: ["symbol"],
    },
  },
  {
    name: "find_files",
    description: "Find files by name (substring or glob like *Manager.cpp) — replaces Bash `find -name`. → capped file list; walk-bounded (skips node_modules/build, time-boxed).",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Filename substring or glob (* ? supported)." },
        projectPath: ROOT,
        maxResults: CAP,
      },
      required: ["q"],
    },
  },
  {
    name: "search_text",
    description: "Raw text/regex search (string literals, comments, config — what the symbol index can't answer). Replaces Bash grep when you need text, not symbols. → capped `file:line: line`. For code symbols prefer search_symbol.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "String or regular expression." },
        path: { type: "string", description: "Search ONE file (any extension auto-included)." },
        glob: { type: "string", description: "Only files matching this basename glob (e.g. *.md)." },
        projectPath: ROOT,
        maxResults: CAP,
        docs: { type: "boolean", description: "With no path/glob, widen the sweep to docs/config text (md/json/yaml/…)." },
      },
      required: ["q"],
    },
  },
  {
    name: "concept_search",
    description: "FUZZY search for a concept you can't name (\"how does auth work\"). Mines a dictionary from the repo's own identifier+comment co-occurrence (no embeddings, nothing sent) → ranked `file:line`. Use when you don't know the symbol name. flow=true traces the top hit's call graph.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Concept/intent phrase (concrete nouns work best)." },
        flow: { type: "boolean", description: "Also trace the top hit along the call graph." },
        projectPath: ROOT,
        maxResults: CAP,
      },
      required: ["q"],
    },
  },
  {
    // vts_admin folds the 12 RARELY-reflexive admin/meta ops behind ONE schema to cut the fixed per-session
    // tool-definition cost (the hot search/nav/edit tools stay first-class so the model still reaches for them
    // over grep/Edit). index.js maps vts_admin{op,params} → runTool("vts_"+op, params); core.js + the CLI keep
    // the individual vts_* implementations unchanged (the grep-block hook still reroutes git/p4 to the CLI).
    name: "vts_admin",
    description:
      "vs-token-safer admin/meta ops (rarely needed reflexively) — set `op`, put that op's args in `params`:\n" +
      "  setup·config·savings{graph|daily|history}·savings_reset — configure / settings / tokens saved\n" +
      "  discover{since,learn} — code searches that BYPASSED vts · warmup·preindex — pre-build the index\n" +
      "  scope — indexing scope + TU stats · index{status} — build the committable .vts-index (cold-start tier)\n" +
      "  gen_compile_db{apply,…} — generate the UE clangd compile DB\n" +
      "  git·p4{argv} — run a READ-ONLY VCS command, output compacted (mutating REFUSED)",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["setup", "config", "savings", "savings_reset", "discover", "warmup", "preindex", "scope", "index", "gen_compile_db", "git", "p4"], description: "Which admin op (see description)." },
        params: { type: "object", description: 'Args for the op, e.g. {"argv":["status"]} for git, {"since":30} for discover.' },
      },
      required: ["op"],
    },
  },
];

// vts_admin folds these cold ops; index.js maps vts_admin{op} -> runTool("vts_"+op).
export const ADMIN_OPS = new Set(["setup", "config", "savings", "savings_reset", "discover", "warmup", "preindex", "scope", "index", "gen_compile_db", "git", "p4"]);
