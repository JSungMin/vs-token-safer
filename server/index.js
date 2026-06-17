#!/usr/bin/env node
/*
 * vs-token-safer — MCP server (thin adapter over core.js).
 * Forces code search through an official language server's index (clangd for C++, the Roslyn/C# LSP)
 * instead of Bash grep, and TOKEN-CAPS the result to a compact file:line list (no source bodies).
 *
 * All tool logic lives in core.js (shared with the CLI at cli.js, `vts`) so there is exactly one
 * implementation per tool. This file only maps MCP requests to runTool(). runTool is ASYNC (LSP is
 * async); the handler awaits it. Each LSP backend is spawned lazily and cached for the process — we
 * dispose clients on shutdown so no language-server child is left running.
 */
import { Server, StdioServerTransport, ListToolsRequestSchema, CallToolRequestSchema, RootsListChangedNotificationSchema } from "./sdk.js";
import { runTool, disposeClients, prewarm, autoLearn, setMcpRoots, getMcpRoots, PROJECT_PATH, BACKEND, PREWARM_BACKENDS } from "./core.js";
import { pickBackend } from "./backends/index.js";
import { fromUri } from "./lsp.js";
import { prewarmBackends } from "./warmset.js";

const log = (...a) => console.error("[vs-token-safer]", ...a);
const envBool = (name, def) => { const v = process.env[name]; if (v === undefined || v === "") return def; return !/^(0|false|off|no)$/i.test(v); };

const TOOLS = [
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
      "Every usage/call site of a symbol (semantic, not a text grep). THE tool for editing code: pass " +
      "`symbol` (just the name) → it resolves the decl + returns all refs in one call, no line/column needed " +
      "(a 0-based path+line+character also works, to disambiguate an overload). → token-capped `file:line`.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol NAME — resolved via the index, no position needed (the usual way when editing)." },
        path: { type: "string", description: "Source file (with line/character for an exact position; or with `symbol` to disambiguate)." },
        line: { type: "number", description: "0-based line." },
        character: { type: "number", description: "0-based column." },
        includeDeclaration: { type: "boolean", description: "Include the declaration." },
        projectPath: { type: "string" },
        backend: { type: "string" },
        maxResults: { type: "number" },
      },
    },
  },
  {
    name: "goto_definition",
    description: "Definition of the symbol at a 0-based position (semantic). → token-capped `file:line`.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Source file containing the symbol." },
        line: { type: "number", description: "0-based line of the symbol position." },
        character: { type: "number", description: "0-based character/column of the symbol position." },
        projectPath: { type: "string" },
        backend: { type: "string" },
        maxResults: { type: "number" },
      },
      required: ["path", "line", "character"],
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
        projectPath: { type: "string" },
        backend: { type: "string" },
      },
      required: ["path", "line", "character"],
    },
  },
  {
    name: "document_symbols",
    description: "Outline one file (classes/functions/types) → `kind name @ file:line`. Cheaper than reading it.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to outline." },
        projectPath: { type: "string" },
        backend: { type: "string" },
        maxResults: { type: "number" },
      },
      required: ["path"],
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
        projectPath: { type: "string" },
        backend: { type: "string" },
        maxResults: { type: "number" },
      },
      required: ["path", "line", "character", "newName"],
    },
  },
  {
    name: "replace_symbol_body",
    description:
      "Replace a whole declaration (signature + body) by NAMING it — the outline gives the exact span, so no " +
      "Read-the-file + line-counting for an exact-match Edit. PREVIEW by default; apply=true writes.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Declaration name to replace (e.g. a function/class name)." },
        body: { type: "string", description: "New full text for the declaration (signature + body)." },
        path: { type: "string", description: "File holding the symbol (pins the outline; else resolved via the index)." },
        line: { type: "number", description: "0-based line to disambiguate same-named symbols (optional)." },
        apply: { type: "boolean", description: "Write to disk (default false = preview only)." },
        projectPath: { type: "string" },
        backend: { type: "string" },
        maxResults: { type: "number" },
      },
      required: ["symbol", "body"],
    },
  },
  {
    name: "insert_after_symbol",
    description:
      "Insert text after a named declaration (e.g. a sibling function/method) — outline gives the point, no " +
      "Read needed. PREVIEW by default; apply=true writes.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Declaration to insert after." },
        text: { type: "string", description: "Text inserted on a new line after the declaration." },
        path: { type: "string", description: "File holding the symbol (else resolved via the index)." },
        line: { type: "number", description: "0-based line to disambiguate same-named symbols (optional)." },
        apply: { type: "boolean", description: "Write to disk (default false = preview only)." },
        projectPath: { type: "string" },
        backend: { type: "string" },
        maxResults: { type: "number" },
      },
      required: ["symbol", "text"],
    },
  },
  {
    name: "insert_before_symbol",
    description:
      "Insert text before a named declaration (e.g. an import/attribute/decorator above it). PREVIEW by " +
      "default; apply=true writes.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Declaration to insert before." },
        text: { type: "string", description: "Text inserted on a line before the declaration." },
        path: { type: "string", description: "File holding the symbol (else resolved via the index)." },
        line: { type: "number", description: "0-based line to disambiguate same-named symbols (optional)." },
        apply: { type: "boolean", description: "Write to disk (default false = preview only)." },
        projectPath: { type: "string" },
        backend: { type: "string" },
        maxResults: { type: "number" },
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
        projectPath: { type: "string" },
        backend: { type: "string" },
        maxResults: { type: "number" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "find_files",
    description:
      "Find files by name (substring or glob like *Manager.cpp) — replaces Bash `find -name`. → token-capped " +
      "file list. No backend needed.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Filename substring or glob (* ? supported)." },
        projectPath: { type: "string" },
        maxResults: { type: "number" },
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
        projectPath: { type: "string" },
        maxResults: { type: "number" },
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
      "  • gen_compile_db {projectPath,apply,inTree,engineRoot,target,…} — generate the UE clangd compile DB\n" +
      "  • git {argv|args,projectPath} · p4 {argv|args,projectPath} — run a READ-ONLY VCS command, output compacted (mutating REFUSED)",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["setup", "config", "savings", "savings_reset", "discover", "warmup", "gen_compile_db", "git", "p4"], description: "Which admin operation (see the description)." },
        params: { type: "object", description: 'Arguments for the op, e.g. {"argv":["status"]} for git, {"since":30} for discover, {"projectPath":"…"} for setup.' },
      },
      required: ["op"],
    },
  },
];

const server = new Server({ name: "vs-search", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
// vts_admin is an MCP-surface alias that folds the 9 cold admin/meta tools behind one schema (token-cap of
// the fixed tool-definition cost). Translate vts_admin{op,params} → the real vts_<op> tool here; everything
// else (the hot search/nav/edit tools) dispatches by name unchanged. core.js / the CLI never see vts_admin.
const ADMIN_OPS = new Set(["setup", "config", "savings", "savings_reset", "discover", "warmup", "gen_compile_db", "git", "p4"]);
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  let name = req.params.name;
  let args = req.params.arguments || {};
  if (name === "vts_admin") {
    const op = String(args.op || "");
    if (!ADMIN_OPS.has(op)) return { isError: true, content: [{ type: "text", text: `vts_admin: unknown op "${op}". One of: ${[...ADMIN_OPS].join(", ")}.` }] };
    name = "vts_" + op;
    args = args.params && typeof args.params === "object" ? args.params : {};
  }
  const { text, isError } = await runTool(name, args);
  return { isError, content: [{ type: "text", text }] };
});

// Dispose spawned language-server children on process exit so none are orphaned.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => { try { await disposeClients(); } catch { /* ignore */ } process.exit(0); });
}

// MCP roots handshake: the client (Claude Code) advertises its workspace folder(s) via the `roots`
// capability. Used to resolve a per-call project root, so ONE globally-installed server serves every repo
// a session touches instead of being pinned to a single configured projectPath (resolveRoot in core.js).
// Degrades silently to "no roots" (→ PROJECT_PATH || cwd, the old behavior) when the client doesn't
// advertise roots. Re-fetched on roots/list_changed so switching the workspace updates the resolution.
async function refreshRoots() {
  try {
    const caps = server.getClientCapabilities?.();
    if (!caps || !caps.roots) return;
    const res = await server.listRoots();
    const paths = (res?.roots || []).map((r) => { try { return fromUri(r.uri); } catch { return null; } }).filter(Boolean);
    setMcpRoots(paths);
    if (paths.length) log(`workspace roots: ${paths.join(", ")}`);
  } catch (e) { log(`roots query failed: ${e.message}`); }
}
if (RootsListChangedNotificationSchema) {
  try { server.setNotificationHandler(RootsListChangedNotificationSchema, () => refreshRoots()); } catch { /* client/SDK without roots — ignore */ }
}

await server.connect(new StdioServerTransport());
log("ready on stdio.");
await refreshRoots(); // populate MCP_ROOTS before prewarm so a config-less install warms the current workspace

// IDE-style background pre-warm: spawn + index the backend now so the user's first search reuses an
// already-warming/warm client instead of paying cold warmup inline. The warm root is the configured
// projectPath, or — for a config-less global install — the first MCP workspace root. Only ONE root is
// prewarmed (never every advertised root — that would defeat the backend-pool memory guard). Default on;
// disable with VTS_PREWARM=0 (fire-and-forget — never blocks boot).
const warmRoot = PROJECT_PATH || getMcpRoots()[0] || "";
if (warmRoot && envBool("VTS_PREWARM", true)) {
  // Single dominant backend by default; VTS_PREWARM_BACKENDS=all (or a comma list) warms every detected
  // language, each with its language-proportional adaptive cap (warmCap). Fire-and-forget — never blocks boot.
  const picked = BACKEND || pickBackend(warmRoot);
  const backends = prewarmBackends(warmRoot, picked, process.env.VTS_PREWARM_BACKENDS || PREWARM_BACKENDS);
  for (const backend of backends) {
    log(`pre-warming ${backend} index for ${warmRoot} …`);
    prewarm(warmRoot, backend).then(
      (c) => { if (c) log(`index warm (${backend}).`); },
      (e) => log(`pre-warm failed (${backend}): ${e.message}`),
    );
  }
}

// Boot-time self-improvement (VTS_AUTO_LEARN, default on when a warm root exists): harvest the files
// that recent BYPASSED code searches actually hit (local transcript scan, bounded, read-only) into the
// warm-set query-history — the same write `vts discover --learn` does, with no human in the loop. The
// next warm-up front-loads what past sessions really searched for. Deferred so boot/prewarm goes first.
if (warmRoot && envBool("VTS_AUTO_LEARN", true)) {
  setTimeout(() => {
    try {
      const n = autoLearn(warmRoot, 7);
      if (n) log(`auto-learn: ${n} file(s) from recent bypassed searches → warm-set for ${warmRoot}.`);
    } catch { /* best-effort — never disturb the server */ }
  }, 3000).unref?.();
}
