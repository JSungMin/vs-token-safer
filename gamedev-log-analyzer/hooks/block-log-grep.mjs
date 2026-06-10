#!/usr/bin/env node
/*
 * gamedev-log-analyzer — PreToolUse hook (matchers: Bash, Read).
 *
 * Steers raw log reads to `gamedev-log` (which parses + dedups + token-caps) instead of flooding raw
 * lines into context. Two vectors:
 *   - Bash: grep/rg/tail/cat/… over a .log/.jsonl/Logs target.
 *   - Read tool: an UNBOUNDED read of a LARGE log file (>= READ_MIN_BYTES). A sliced read
 *     (offset/limit present) ALWAYS passes — that's the one-step escape and the fallback for formats
 *     the analyzer parses poorly, so a blocked Read never strands the model.
 * Code grep (.cpp/.cs/src/…) and non-log reads pass through — that domain belongs to rider-mcp-enforcer.
 *
 * Modes (env GDLOG_ENFORCE > ~/.gamedev-log-analyzer/config.json "enforce" > "block"):
 *   block (default) -> exit 2, denied, nudge shown to the model
 *   warn            -> exit 0, allowed, nudge shown (soft)
 *   off             -> exit 0, silent passthrough
 *
 * Protocol: exit 0 = allow; exit 2 + stderr = block. Fail-open: any parse/IO error allows the command.
 */
import fs from "node:fs";
import { shouldBlockLogBash, shouldBlockRead, enforceMode, nudgeText } from "../server/enforce.js";

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let toolName = "";
  let ti = {};
  try {
    const j = JSON.parse(input);
    toolName = j.tool_name || "";
    ti = j.tool_input || {};
  } catch {
    process.exit(0); // unparseable — don't block
  }

  let mode = "block";
  try {
    mode = enforceMode();
  } catch {
    process.exit(0); // config trouble — fail open
  }
  if (mode === "off") process.exit(0);

  let hit = null; // { kind: "bash"|"read", target: string }
  try {
    if (toolName === "Bash") {
      if (shouldBlockLogBash(ti.command)) hit = { kind: "bash", target: ti.command || "" };
    } else if (toolName === "Read") {
      const fp = ti.file_path || "";
      const sliced = ti.offset !== undefined && ti.offset !== null || (ti.limit !== undefined && ti.limit !== null);
      let size = 0;
      try {
        size = fs.statSync(fp).size; // follows symlinks; throws on missing/EACCES/dir
      } catch {
        size = 0; // fail open — any stat error means "don't block"
      }
      if (shouldBlockRead(fp, size, sliced)) hit = { kind: "read", target: fp };
    }
  } catch {
    process.exit(0); // any classifier error — fail open
  }
  if (!hit) process.exit(0);

  const nudge = nudgeText(hit.target, hit.kind);
  if (mode === "warn") {
    // allow the command, but inject the nudge into the model's context (stderr on exit 0 is not
    // reliably surfaced; additionalContext is).
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: nudge } })
    );
    process.exit(0);
  }
  process.stderr.write(nudge + "\n"); // block: deny + show nudge
  process.exit(2);
});
