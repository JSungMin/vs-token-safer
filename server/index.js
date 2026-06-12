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
import { Server, StdioServerTransport, ListToolsRequestSchema, CallToolRequestSchema } from "./sdk.js";
import { runTool, disposeClients, prewarm, autoLearn, PROJECT_PATH, BACKEND, PREWARM_BACKENDS } from "./core.js";
import { pickBackend } from "./backends/index.js";
import { prewarmBackends } from "./warmset.js";

const log = (...a) => console.error("[vs-token-safer]", ...a);
const envBool = (name, def) => { const v = process.env[name]; if (v === undefined || v === "") return def; return !/^(0|false|off|no)$/i.test(v); };

const TOOLS = [
  {
    name: "search_symbol",
    description:
      "Search symbol DECLARATIONS by name/substring across the project via the language server's index " +
      "(clangd for C++, Roslyn for C#) — NOT grep. Returns a token-capped `kind name @ file:line` list, " +
      "no source bodies. Use this instead of Bash grep/rg for finding a class/function/type/variable.",
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
      "Find references/usages of the symbol at a 0-based position (semantic, via the language server) — " +
      "NOT a text grep. Returns a token-capped `file:line` list, no bodies. Use for refactors/renames " +
      "where you must touch every call site.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Source file containing the symbol." },
        line: { type: "number", description: "0-based line of the symbol position." },
        character: { type: "number", description: "0-based character/column of the symbol position." },
        includeDeclaration: { type: "boolean", description: "Include the declaration in the results." },
        projectPath: { type: "string" },
        backend: { type: "string" },
        maxResults: { type: "number" },
      },
      required: ["path", "line", "character"],
    },
  },
  {
    name: "goto_definition",
    description:
      "Resolve the definition of the symbol at a 0-based position (semantic, via the language server). " +
      "Returns a token-capped `file:line` list, no bodies.",
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
    description:
      "Type/signature info for the symbol at a 0-based position (language-server hover). A few plaintext " +
      "lines, no walls of docs. Use to check a type/overload without opening the file.",
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
    description:
      "Outline a single file: its classes/functions/types as a token-capped `kind name @ file:line` list. " +
      "Cheaper than reading the whole file to see its structure.",
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
      "Semantically rename the symbol at a 0-based position across the whole project (language-server " +
      "rename — updates every reference, never a text sed). Default is a PREVIEW returning the affected " +
      "`file:line` list; pass apply=true to write the edits to disk. Use this instead of editing call " +
      "sites by hand.",
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
    name: "find_files",
    description:
      "Find files by name (substring or glob like *Manager.cpp) under the project root — token-capped " +
      "`file` list. The sanctioned replacement for Bash `find -name`. No language server needed.",
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
      "Raw text/regex search in source (string literals, comments, config keys — things the symbol index " +
      "can't answer). Bounded and token-capped to `file:line: trimmed-line`. The sanctioned replacement " +
      "for Bash grep when you genuinely need text, not symbols. Prefer search_symbol for code symbols.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "String or regular expression to find." },
        projectPath: { type: "string" },
        maxResults: { type: "number" },
      },
      required: ["q"],
    },
  },
  {
    name: "vts_setup",
    description:
      "Configure vs-token-safer (projectPath, backend, maxResults). Writes ~/.vs-token-safer/config.json; " +
      "run /reload-plugins after. Precedence: env (VTS_*) > config file > default.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "Default project root." },
        backend: { type: "string", description: "clangd | roslyn | typescript | pyright (default: auto)." },
        maxResults: { type: "number", description: "Default cap on returned locations." },
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
    description: "Scan recent Claude Code transcripts (local, read-only) for code searches that BYPASSED vts — Bash grep/rg/find or the Grep tool aimed at source — and report the raw tokens they spent (the missed savings). Use to see where token-heavy text search is still slipping past vts.",
    inputSchema: { type: "object", properties: { since: { type: "number", description: "Look back this many days (default 7)." }, all: { type: "boolean", description: "Scan all projects, all time (ignore the since window)." }, learn: { type: "boolean", description: "Feed the files those bypassed searches hit into the warm-set query-history (front-loads them in prewarm)." }, projectPath: { type: "string", description: "Root to attribute learned files to (default: configured projectPath or cwd)." } } },
  },
  {
    name: "vts_warmup",
    description: "Pre-build the language-server index (IDE-style) so later searches are fast. Spawns + warms the backend without running a query.",
    inputSchema: { type: "object", properties: { projectPath: { type: "string" }, backend: { type: "string", enum: ["clangd", "roslyn", "typescript", "pyright"] } } },
  },
  {
    name: "vts_gen_compile_db",
    description: "Generate compile_commands.json for an Unreal project (so clangd gets a full semantic index) by running UBT GenerateClangDatabase. The user's choice vs staying in no-DB text mode. DRY RUN by default (prints the exact command); apply=true runs it (takes minutes, needs the UE build env). The DB and clangd's .cache/ index land OUTSIDE the source tree (~/.vs-token-safer/db/<project>) so git/p4 never see them; inTree=true keeps the classic project-root layout (then a VCS-ignore guard protects it).",
    inputSchema: { type: "object", properties: { projectPath: { type: "string", description: "Unreal project root (contains the .uproject)." }, apply: { type: "boolean", description: "false (default) = print the command only; true = run UBT now." }, inTree: { type: "boolean", description: "true = put the DB at the project root (classic layout, VCS-ignore-guarded) instead of the out-of-tree default." }, engineRoot: { type: "string", description: "UE engine root (contains Engine/Build/BatchFiles/RunUBT). Default: VTS_UE_ROOT or a walk-up from the project." }, target: { type: "string", description: "UBT target (default <ProjectName>Editor)." }, platform: { type: "string", description: "default Win64." }, config: { type: "string", description: "default Development." }, compiler: { type: "string", description: "default VisualCpp (needed for clang-cl targets)." } } },
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

await server.connect(new StdioServerTransport());
log("ready on stdio.");

// IDE-style background pre-warm: when a project root is configured, spawn + index the backend now so
// the user's first search reuses an already-warming/warm client instead of paying cold warmup inline.
// Default on when projectPath is set; disable with VTS_PREWARM=0 (fire-and-forget — never blocks boot).
if (PROJECT_PATH && envBool("VTS_PREWARM", true)) {
  // Single dominant backend by default; VTS_PREWARM_BACKENDS=all (or a comma list) warms every detected
  // language, each with its language-proportional adaptive cap (warmCap). Fire-and-forget — never blocks boot.
  const picked = BACKEND || pickBackend(PROJECT_PATH);
  const backends = prewarmBackends(PROJECT_PATH, picked, process.env.VTS_PREWARM_BACKENDS || PREWARM_BACKENDS);
  for (const backend of backends) {
    log(`pre-warming ${backend} index for ${PROJECT_PATH} …`);
    prewarm(PROJECT_PATH, backend).then(
      (c) => { if (c) log(`index warm (${backend}).`); },
      (e) => log(`pre-warm failed (${backend}): ${e.message}`),
    );
  }
}

// Boot-time self-improvement (VTS_AUTO_LEARN, default on when projectPath is set): harvest the files
// that recent BYPASSED code searches actually hit (local transcript scan, bounded, read-only) into the
// warm-set query-history — the same write `vts discover --learn` does, with no human in the loop. The
// next warm-up front-loads what past sessions really searched for. Deferred so boot/prewarm goes first.
if (PROJECT_PATH && envBool("VTS_AUTO_LEARN", true)) {
  setTimeout(() => {
    try {
      const n = autoLearn(PROJECT_PATH, 7);
      if (n) log(`auto-learn: ${n} file(s) from recent bypassed searches → warm-set for ${PROJECT_PATH}.`);
    } catch { /* best-effort — never disturb the server */ }
  }, 3000).unref?.();
}
