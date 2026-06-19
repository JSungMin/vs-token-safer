// Tool DEFINITIONS for the MCP server, isolated from index.js so they can be measured/asserted
// WITHOUT importing the SDK-dependent server (the toolchain-free eval gate spawns nothing). index.js
// imports TOOLS + ADMIN_OPS from here. Pure data + one Set — no imports, no side effects.

export const TOOLS = [
  {
    name: "search_symbol",
    description:
      "Find a symbol DECLARATION (class/function/type/variable) by name/substring — semantic index, not grep. " +
      "→ token-capped `kind name @ file:line`, no bodies. Use instead of grep/rg to locate a symbol.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Symbol name or substring to search for." },
        projectPath: { type: "string", description: "Project root (default: configured projectPath or cwd)." },
        backend: { type: "string", description: "clangd | roslyn | typescript | pyright (default: auto-detect from the root)." },
        maxResults: { type: "number", description: "Cap on returned locations (default 60)." },
      },
      required: ["q"],
    },
  },
  {
    name: "find_references",
    description:
      "Every call site of a symbol (semantic, not grep) — pass `symbol` (a name): resolves the decl + returns " +
      "all refs in one call (a 0-based path+line+character disambiguates an overload). → token-capped " +
      "`file:line`; detail=file|dir for a blast-radius summary. `direction`=callers|callees switches to a " +
      "MULTI-HOP call hierarchy (transitive callers = blast radius / callees) to `depth` hops — use before changing a function.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol NAME — resolved via the index, no position needed (the usual way when editing)." },
        path: { type: "string", description: "Source file (with line/character for an exact position; or with `symbol` to disambiguate)." },
        line: { type: "number", description: "0-based line." },
        character: { type: "number", description: "0-based column." },
        includeDeclaration: { type: "boolean", description: "Include the declaration." },
        detail: { type: "string", description: "`file` or `dir` → a blast-radius summary (dependents grouped + ranked by ref count) instead of the per-line list; omit for the full list." },
        direction: { type: "string", description: "callers | callees → a multi-hop CALL HIERARCHY (who transitively calls this / what it calls) instead of flat references; omit for usages." },
        depth: { type: "number", description: "Call-hierarchy hops when direction is set (default 2; capped by VTS_TRACE_MAX_DEPTH)." },
        projectPath: { type: "string", description: "Project root (cwd)." },
        backend: { type: "string", description: "Backend override; auto-detected." },
        maxResults: { type: "number", description: "Result cap (60)." },
      },
    },
  },
  {
    name: "goto_definition",
    description: "Jump from a 0-based position to a definition (semantic). `kind`: definition (default) | type_definition | implementation | declaration. → token-capped `file:line`. For usages, use find_references.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Source file containing the symbol." },
        line: { type: "number", description: "0-based line of the symbol position." },
        character: { type: "number", description: "0-based character/column of the symbol position." },
        kind: { type: "string", description: "definition (default) | type_definition | implementation | declaration." },
        projectPath: { type: "string", description: "Project root (cwd)." },
        backend: { type: "string", description: "Backend override; auto-detected." },
        maxResults: { type: "number", description: "Result cap (60)." },
      },
      required: ["path", "line", "character"],
    },
  },
  {
    name: "diagnostics",
    description: "Compiler/linter errors + warnings (semantic, via the language server) → a token-capped `file:line:col severity [code]: message` list, sorted error→hint with a count summary. The compact alternative to reading raw build/compiler output. Read-only; empty = clean. Default scope is ONE file (`path`); `scope=\"directory\"` scans the project (a bounded set of code files — see VTS_DIAG_DIR_MAX).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Source file to check (or, with scope=directory, the subdirectory to scan; default = project root)." },
        scope: { type: "string", description: "`file` (default) checks one `path`; `directory` scans the project for errors/warnings across files." },
        projectPath: { type: "string", description: "Project root (cwd)." },
        backend: { type: "string", description: "Backend override; auto-detected." },
        maxResults: { type: "number", description: "Max diagnostics returned (default 60)." },
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
        character: { type: "number", description: "0-based character/column." },
        projectPath: { type: "string", description: "Project root (cwd)." },
        backend: { type: "string", description: "Backend override; auto-detected." },
      },
      required: ["path", "line", "character"],
    },
  },
  {
    name: "document_symbols",
    description: "Outline a file — its classes/functions/types as a token-capped `kind name :line` list (file named once in the header; read-only, capped). Cheaper than reading the whole file to see its structure. `scope=\"directory\"` outlines EVERY code file under `path` (or the root) into a signatures-only project skeleton — the shape of a module without Reading each file (bounded by VTS_SKELETON_DIR_MAX).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to outline (or, with scope=directory, the subdirectory to skeletonize; default = project root)." },
        scope: { type: "string", description: "`file` (default) outlines one `path`; `directory` builds a signatures-only skeleton of every code file under it." },
        projectPath: { type: "string", description: "Project root (cwd)." },
        backend: { type: "string", description: "Backend override; auto-detected." },
        maxResults: { type: "number", description: "Result cap (60)." },
      },
    },
  },
  {
    name: "read_symbol",
    description: "Return the SOURCE of one named declaration (its span), NOT the whole file — the read twin of replace_symbol_body. Skip Read-ing a whole file for one declaration. `signatureOnly` = head only; body capped by VTS_SYMBOL_MAX_LINES.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Declaration name to read (function/class/method/…)." },
        path: { type: "string", description: "File holding the symbol (pins the outline; else resolved via the index)." },
        line: { type: "number", description: "0-based line to disambiguate same-named symbols (optional)." },
        signatureOnly: { type: "boolean", description: "Return just the declaration head (signature), not the full body." },
        projectPath: { type: "string", description: "Project root (cwd)." },
        backend: { type: "string", description: "Backend override; auto-detected." },
      },
      required: ["symbol"],
    },
  },
  {
    name: "rename",
    description:
      "Rename the symbol at a 0-based position project-wide (semantic — every reference, not a sed). " +
      "PREVIEW by default (affected `file:line`); apply=true writes. Use instead of editing call sites by hand.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Source file containing the symbol." },
        line: { type: "number", description: "0-based line of the symbol." },
        character: { type: "number", description: "0-based character/column of the symbol." },
        newName: { type: "string", description: "New name for the symbol." },
        apply: { type: "boolean", description: "Write the edits to disk (default false = preview only)." },
        projectPath: { type: "string", description: "Project root (cwd)." },
        backend: { type: "string", description: "Backend override; auto-detected." },
        maxResults: { type: "number", description: "Result cap (60)." },
      },
      required: ["path", "line", "character", "newName"],
    },
  },
  {
    name: "replace_symbol_body",
    description:
      "Replace a whole declaration (signature + body) by NAMING it — the outline gives the span, no " +
      "Read + line-counting. PREVIEW by default; apply=true overwrites.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Declaration name to replace (e.g. a function/class name)." },
        body: { type: "string", description: "New full text for the declaration (signature + body)." },
        path: { type: "string", description: "File holding the symbol (pins the outline; else resolved via the index)." },
        line: { type: "number", description: "0-based line to disambiguate same-named symbols (optional)." },
        apply: { type: "boolean", description: "Write to disk (default false = preview only)." },
        projectPath: { type: "string", description: "Project root (cwd)." },
        backend: { type: "string", description: "Backend override; auto-detected." },
        maxResults: { type: "number", description: "Result cap (60)." },
      },
      required: ["symbol", "body"],
    },
  },
  {
    name: "insert_symbol",
    description:
      "Insert text next to a named declaration — `position=after` (default) or `before`. The outline gives the " +
      "point (no Read). PREVIEW by default; apply=true writes. Use instead of Read-then-Edit to add a declaration.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Declaration to insert next to." },
        text: { type: "string", description: "Text to insert (on its own line)." },
        position: { type: "string", description: "`after` (default) or `before` the declaration." },
        path: { type: "string", description: "File holding the symbol (else resolved via the index)." },
        line: { type: "number", description: "0-based line to disambiguate same-named symbols (optional)." },
        apply: { type: "boolean", description: "Write to disk (default false = preview only)." },
        projectPath: { type: "string", description: "Project root (cwd)." },
        backend: { type: "string", description: "Backend override; auto-detected." },
        maxResults: { type: "number", description: "Result cap (60)." },
      },
      required: ["symbol", "text"],
    },
  },
  {
    name: "safe_delete",
    description:
      "Delete a named declaration, but REFUSE while still referenced (lists the refs, stops unless force=true) " +
      "— a delete can't silently orphan call sites. PREVIEW by default; apply=true writes.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Declaration to delete." },
        path: { type: "string", description: "File holding the symbol (else resolved via the index)." },
        line: { type: "number", description: "0-based line to disambiguate same-named symbols (optional)." },
        force: { type: "boolean", description: "Delete even if references remain (default false = refuse when referenced)." },
        apply: { type: "boolean", description: "Write to disk (default false = preview only)." },
        projectPath: { type: "string", description: "Project root (cwd)." },
        backend: { type: "string", description: "Backend override; auto-detected." },
        maxResults: { type: "number", description: "Result cap (60)." },
      },
      required: ["symbol"],
    },
  },
  {
    name: "find_files",
    description:
      "Find files by name (substring or glob like *Manager.cpp) — replaces Bash `find -name`. → token-capped " +
      "file list; walk-bounded (skips node_modules/Intermediate/Binaries, time-boxed). Read-only, no backend needed.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Filename substring or glob (* ? supported)." },
        projectPath: { type: "string", description: "Project root (cwd)." },
        maxResults: { type: "number", description: "Result cap (60)." },
      },
      required: ["q"],
    },
  },
  {
    name: "search_text",
    description:
      "Raw text/regex search (string literals, comments, config — what the symbol index can't answer). " +
      "Replaces Bash grep when you need text, not symbols. → token-capped `file:line: line`. For code " +
      "symbols prefer search_symbol.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "String or regular expression to find." },
        path: { type: "string", description: "Search ONE file (any extension auto-included; relative or absolute)." },
        glob: { type: "string", description: "Only files matching this basename glob (e.g. *.md) — any extension it covers." },
        projectPath: { type: "string", description: "Project root (cwd)." },
        maxResults: { type: "number", description: "Result cap (60)." },
        docs: { type: "boolean", description: "With no path/glob, widen the sweep to docs/config text (md/json/yaml/…), not just source." },
      },
      required: ["q"],
    },
  },
  {
    // vts_admin folds the 9 RARELY-reflexive admin/meta tools behind ONE schema to cut the fixed
    // per-session tool-definition cost (the hot search/nav/edit tools stay first-class so the model still
    // reaches for them over grep/Edit). index.js maps vts_admin{op,params} → runTool("vts_"+op, params);
    // core.js + the CLI keep the individual vts_* implementations unchanged (the grep-block hook still
    // reroutes git/p4 to the CLI, not this tool).
    name: "vts_admin",
    description:
      "vs-token-safer admin/meta operations (rarely needed reflexively) — set `op` and put that op's args in " +
      "`params`:\n" +
      "  • setup {projectPath,backend,maxResults,genCompileDb,clangdCmd} — configure (writes config; /reload-plugins after)\n" +
      "  • config {} — show effective settings · savings {graph,daily,history} — tokens saved (local) · savings_reset {} — clear it\n" +
      "  • discover {since,all,learn,projectPath} — find code searches that BYPASSED vts (missed savings)\n" +
      "  • warmup {projectPath,backend} — pre-build the index so later searches are fast\n" +
      "  • preindex {projectPath,backend} — build the index ahead of time (clangd: a static --index-file via clangd-indexer if present, honoring scope)\n" +
      "  • scope {projectPath} — show the indexing scope + TU stats + top-level dirs to pick from (set via setup --scope)\n" +
      "  • gen_compile_db {projectPath,apply,inTree,engineRoot,target,…} — generate the UE clangd compile DB\n" +
      "  • git {argv|args,projectPath} · p4 {argv|args,projectPath} — run a READ-ONLY VCS command, output compacted (mutating REFUSED)",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["setup", "config", "savings", "savings_reset", "discover", "warmup", "preindex", "scope", "gen_compile_db", "git", "p4"], description: "Which admin operation (see the description)." },
        params: { type: "object", description: 'Arguments for the op, e.g. {"argv":["status"]} for git, {"since":30} for discover, {"projectPath":"…"} for setup.' },
      },
      required: ["op"],
    },
  },
];

// vts_admin folds these cold ops; index.js maps vts_admin{op} -> runTool("vts_"+op).
export const ADMIN_OPS = new Set(["setup", "config", "savings", "savings_reset", "discover", "warmup", "preindex", "scope", "gen_compile_db", "git", "p4"]);
