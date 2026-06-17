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
    name: "vts_git",
    description:
      "Run a READ-ONLY git command, output COMPACTED/token-capped (status by change-type+dir, log one line/" +
      "commit, diff per-file diffstat). Mutating subcommands REFUSED. Use instead of raw `git status/log/diff`.",
    inputSchema: {
      type: "object",
      properties: {
        argv: { type: "array", items: { type: "string" }, description: 'Git subcommand + flags, e.g. ["status","-s"] or ["log","--oneline"].' },
        args: { type: "string", description: 'Alternative to argv: the subcommand as one string, e.g. "status -s".' },
        projectPath: { type: "string", description: "Repo root to run in (default: configured projectPath or cwd)." },
        maxResults: { type: "number" },
      },
    },
  },
  {
    name: "vts_p4",
    description:
      "Run a READ-ONLY p4 command, output COMPACTED/token-capped (opened/status/reconcile/changes grouped by " +
      "action+depot dir; reconcile forced to -n). Mutating subcommands REFUSED. Use instead of raw `p4 opened`.",
    inputSchema: {
      type: "object",
      properties: {
        argv: { type: "array", items: { type: "string" }, description: 'p4 subcommand + flags, e.g. ["opened"] or ["changes","-m","50"].' },
        args: { type: "string", description: 'Alternative to argv: the subcommand as one string, e.g. "opened".' },
        projectPath: { type: "string", description: "Workspace root to run in (default: configured projectPath or cwd)." },
        maxResults: { type: "number" },
      },
    },
  },
  {
    name: "vts_setup",
    description:
      "Configure vs-token-safer (projectPath/backend/maxResults) → ~/.vs-token-safer/config.json; " +
      "/reload-plugins after. Can also generate the C++ compile DB in this step (genCompileDb).",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "Default project root." },
        backend: { type: "string", description: "clangd | roslyn | typescript | pyright (default: auto)." },
        maxResults: { type: "number", description: "Default cap on returned locations." },
        genCompileDb: { description: "Generate the C++ compile DB here: `true` = DRY-RUN (print the UBT command); \"apply\" = run UBT (heavy, needs clangd ≥ 22). Parked out-of-tree (~/.vs-token-safer/db).", "type": ["boolean", "string"] },
        clangdCmd: { type: "string", description: "Path to a clangd ≥ 22 binary (persists to config). VS-bundled clangd 19.x deadlocks on Unreal TUs. Env VTS_CLANGD_CMD overrides." },
      },
    },
  },
  {
    name: "vts_config",
    description: "Show current effective vs-token-safer settings + config-file path.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "vts_savings",
    description: "Report how many tokens you've saved vs forwarding raw index responses (local, cumulative). Optional graph/daily/history breakdowns + an estimated USD value.",
    inputSchema: { type: "object", properties: { graph: { type: "boolean", description: "Show a 30-day ASCII graph of saved tokens." }, daily: { type: "boolean", description: "Show a day-by-day breakdown (last 14)." }, history: { type: "boolean", description: "Show the most recent runs." } } },
  },
  {
    name: "vts_savings_reset",
    description: "Clear the local savings ledger.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "vts_discover",
    description: "Scan local Claude Code transcripts (read-only) for code searches that BYPASSED vts (grep/rg/find or the Grep tool) and report the tokens they spent — where text search still slips past vts.",
    inputSchema: { type: "object", properties: { since: { type: "number", description: "Look back this many days (default 7)." }, all: { type: "boolean", description: "Scan all projects, all time (ignore the since window)." }, learn: { type: "boolean", description: "Feed the files those bypassed searches hit into the warm-set query-history (front-loads them in prewarm). Only files under projectPath are attributed." }, projectPath: { type: "string", description: "Scope the scan to transcript entries that ran under this root, and attribute learned files to it (default for learn: configured projectPath or cwd)." } } },
  },
  {
    name: "vts_warmup",
    description: "Pre-build the language-server index (IDE-style) so later searches are fast. Spawns + warms the backend without running a query.",
    inputSchema: { type: "object", properties: { projectPath: { type: "string" }, backend: { type: "string", enum: ["clangd", "roslyn", "typescript", "pyright"] } } },
  },
  {
    name: "vts_gen_compile_db",
    description: "Generate compile_commands.json for an Unreal project (clangd semantic index) via UBT GenerateClangDatabase. DRY-RUN by default (prints the command); apply=true runs it (minutes, needs the UE build env). DB + .cache/ land out-of-tree (~/.vs-token-safer/db) so git/p4 never see them; inTree=true uses the project root.",
    inputSchema: { type: "object", properties: { projectPath: { type: "string", description: "Unreal project root (has the .uproject)." }, apply: { type: "boolean", description: "false (default) = print the command; true = run UBT." }, inTree: { type: "boolean", description: "true = DB at the project root (VCS-ignore-guarded) instead of out-of-tree." }, engineRoot: { type: "string", description: "UE engine root. Default: VTS_UE_ROOT or a walk-up." }, target: { type: "string", description: "UBT target (default <Project>Editor)." }, platform: { type: "string", description: "default Win64." }, config: { type: "string", description: "default Development." }, compiler: { type: "string", description: "default VisualCpp (for clang-cl targets)." } } },
  },
];

const server = new Server({ name: "vs-search", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { text, isError } = await runTool(req.params.name, req.params.arguments || {});
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
