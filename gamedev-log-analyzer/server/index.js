#!/usr/bin/env node
/*
 * gamedev-log-analyzer — MCP server (thin adapter over core.js).
 * Detects and analyzes game-engine/build logs (Unreal Saved/Logs, Unity Editor.log, Godot
 * output, MSVC/UBT/MSBuild, or any structured text log): parse → classify by severity/category →
 * dedup spam → search/filter/diff/locate, and a generic `log_fields` columnar extractor.
 *
 * All tool logic lives in core.js (shared with the CLI at cli.js, `gamedev-log`) so there is
 * exactly one implementation per tool. This file only maps MCP requests to runTool().
 */
import { Server, StdioServerTransport, ListToolsRequestSchema, CallToolRequestSchema } from "./sdk.js";
import { runTool } from "./core.js";

const log = (...a) => console.error("[gamedev-log-analyzer]", ...a);

const TOOLS = [
  {
    name: "log_setup",
    description: "Configure gamedev-log-analyzer (projectPath, logPath, …). Writes ~/.gamedev-log-analyzer/config.json; run /reload-plugins after.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "Project root (UE: finds <root>/Saved/Logs)" },
        logPath: { type: "string", description: "Explicit default log file" },
        logMaxBytes: { type: "number" },
        maxGroups: { type: "number" },
        maxLineChars: { type: "number" },
      },
    },
  },
  {
    name: "log_config",
    description: "Show current effective gamedev-log-analyzer settings + config-file path.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "log_detect",
    description: "Find editor log files (Unreal Saved/Logs, Unity Editor.log) for the project, newest first.",
    inputSchema: { type: "object", properties: { projectPath: { type: "string" } } },
  },
  {
    name: "log_search",
    description:
      "Search/analyze an editor log: parse severity + category + file:line, dedup repeated spam into " +
      "templated groups with counts, severity-sorted + token-capped. Filters: query, severityMin, " +
      "category, file. groupBy 'template' (default), 'callsite' (roll up by file:line), or 'code' " +
      "(roll up by diagnostic code, e.g. C4996/LNK2019 — collapses noisy builds to one line per code).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        projectPath: { type: "string" },
        query: { type: "string" },
        severityMin: { type: "string", description: "Fatal|Error|Warning|Display (default Warning)" },
        category: { type: "string" },
        file: { type: "string" },
        maxGroups: { type: "number" },
        groupBy: { type: "string", description: "'template', 'callsite', or 'code' (roll up by diagnostic code)" },
      },
    },
  },
  {
    name: "log_fields",
    description:
      "Extract ONLY chosen scalar fields from structured trace-log lines into a compact table — the " +
      "biggest token win on dense per-frame logs. Field forms: `Key`, `Key.x|.y|.z`, `Key.Y|.P|.R`, " +
      "`ts`, `dts`, `d:Key`, `step:Key` (deltas vs previous row).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        projectPath: { type: "string" },
        fields: { type: "array", items: { type: "string" } },
        query: { type: "string" },
        category: { type: "string" },
        file: { type: "string" },
        severityMin: { type: "string", description: "default Verbose (all)" },
        window: { type: "array", items: { type: "number" } },
        max: { type: "number" },
        stats: { type: "boolean", description: "Aggregate each numeric column to min/max/avg/Δ (one line/col) instead of rows — fewer tokens." },
      },
      required: ["fields"],
    },
  },
  {
    name: "log_summary",
    description: "Overview of an editor log: counts per severity + top categories. No message bodies.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, projectPath: { type: "string" } } },
  },
  {
    name: "log_locate",
    description:
      "Jump list: distinct `file:line` locations of matched entries only (no message bodies), ranked by " +
      "severity then frequency — the most compact handoff for opening the offending source. Pair with " +
      "rider-mcp-enforcer: feed the (basename) locations to find_files_by_name_keyword → read_file at the " +
      "line. `basename: true` strips paths to filenames for Rider's name search.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        projectPath: { type: "string" },
        query: { type: "string" },
        severityMin: { type: "string", description: "Fatal|Error|Warning|Display (default Error)" },
        category: { type: "string" },
        file: { type: "string" },
        basename: { type: "boolean", description: "Strip paths to filename:line (for Rider file-name search)" },
        max: { type: "number" },
      },
    },
  },
  {
    name: "log_diff",
    description:
      "Compare two logs (A=base/before, B=new/after) and emit ONLY the delta: new errors, errors that " +
      "disappeared, and groups whose count changed. Unchanged groups are omitted — token-cheap regression " +
      "triage across runs. Without pathA/pathB it auto-picks the two newest detected logs (A=older, B=newest). " +
      "Filters: query, severityMin, category, file, groupBy, minDelta.",
    inputSchema: {
      type: "object",
      properties: {
        pathA: { type: "string", description: "Base/before log (older)" },
        pathB: { type: "string", description: "New/after log (newer)" },
        projectPath: { type: "string", description: "If pathA/pathB omitted, detect logs here (A=2nd newest, B=newest)" },
        query: { type: "string" },
        severityMin: { type: "string", description: "Fatal|Error|Warning|Display (default Warning)" },
        category: { type: "string" },
        file: { type: "string" },
        groupBy: { type: "string", description: "'template' (default), 'callsite', or 'code'" },
        minDelta: { type: "number", description: "Only report count-changes with |Δ| ≥ this (default 1)" },
        maxGroups: { type: "number" },
      },
    },
  },
  {
    name: "log_tail",
    description: "Last N raw lines of a log (escape hatch).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, projectPath: { type: "string" }, lines: { type: "number" } },
    },
  },
  {
    name: "log_learnings",
    description:
      "Report what the analyzer is learning from your logs (local): parse coverage, top categories, " +
      "and templated shapes of UNPARSED lines (candidates for a new parser/category). Sanitized.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "log_learnings_reset",
    description: "Clear the local learnings ledger.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "log_savings",
    description: "Report how many tokens you've saved vs dumping raw logs into context (local, cumulative).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "log_savings_reset",
    description: "Clear the local savings ledger.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "log_enforce",
    description:
      "Show or set Bash log-grep enforcement. Pass mode to set ('block' = deny raw grep/tail/cat over " +
      ".log/.jsonl/Logs + nudge to gamedev-log; 'warn' = allow + nudge; 'off' = allow). Omit (or 'status') to show.",
    inputSchema: {
      type: "object",
      properties: { mode: { type: "string", description: "block | warn | off | status" } },
    },
  },
];

const server = new Server({ name: "gamedev-log", version: "0.3.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { text, isError } = runTool(req.params.name, req.params.arguments || {});
  return { isError, content: [{ type: "text", text }] };
});

await server.connect(new StdioServerTransport());
log("ready on stdio.");
