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
import { runTool, disposeClients, prewarm, PROJECT_PATH, BACKEND } from "./core.js";
import { pickBackend } from "./backends/index.js";

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
        backend: { type: "string", description: "clangd | roslyn (default: auto-detect from the root)." },
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
        backend: { type: "string", description: "clangd | roslyn (default: auto)." },
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
    description: "Report how many tokens you've saved vs forwarding raw index responses (local, cumulative).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "vts_savings_reset",
    description: "Clear the local savings ledger.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "vts_warmup",
    description: "Pre-build the language-server index (IDE-style) so later searches are fast. Spawns + warms the backend without running a query.",
    inputSchema: { type: "object", properties: { projectPath: { type: "string" }, backend: { type: "string", enum: ["clangd", "roslyn"] } } },
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
  const backend = BACKEND || pickBackend(PROJECT_PATH);
  if (backend) {
    log(`pre-warming ${backend} index for ${PROJECT_PATH} …`);
    prewarm(PROJECT_PATH, backend).then(
      (c) => { if (c) log(`index warm (${backend}).`); },
      (e) => log(`pre-warm failed (${backend}): ${e.message}`),
    );
  }
}
