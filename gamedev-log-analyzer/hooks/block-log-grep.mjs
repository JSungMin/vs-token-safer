#!/usr/bin/env node
/*
 * gamedev-log-analyzer — PreToolUse hook (matchers: Bash, Read).
 *
 * Steers raw log reads to `gamedev-log` (which parses + dedups + token-caps) instead of flooding raw
 * lines into context. Two vectors:
 *   - Bash: grep/rg/tail/cat/… over a .log/.jsonl/Logs target. A single clean segment is first REWRITTEN
 *     to the gamedev-log CLI equivalent (grep→search, cat/tail→summary) via updatedInput — the model's
 *     flow is unbroken AND the output is token-capped (mirrors vs-token-safer). Anything ambiguous
 *     (pipelines, vars, quoted/multi paths) falls back to the warn/block nudge. Opt out: GDLOG_REWRITE=0.
 *   - Read tool: an UNBOUNDED read of a LARGE log file (>= READ_MIN_BYTES). A sliced read
 *     (offset/limit present) ALWAYS passes — that's the one-step escape and the fallback for formats
 *     the analyzer parses poorly, so a blocked Read never strands the model.
 * Code grep (.cpp/.cs/src/…) and non-log reads pass through — that domain belongs to rider-mcp-enforcer.
 *
 * Modes (env GDLOG_ENFORCE > ~/.gamedev-log-analyzer/config.json "enforce" > "warn"):
 *   warn (default)  -> exit 0, allowed, nudge shown (soft)
 *   block           -> exit 2, denied, nudge shown to the model
 *   off             -> exit 0, silent passthrough
 * The rewrite (above) supersedes warn/block when it can build a safe equivalent (unless GDLOG_REWRITE=0).
 *
 * Protocol: exit 0 = allow; exit 2 + stderr = block. Fail-open: any parse/IO error allows the command.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shouldBlockLogBash, shouldBlockRead, enforceMode, nudgeText, buildLogRewrite } from "../server/enforce.js";

// Absolute path to the bundled CLI (../server/cli.js) — `gamedev-log` may not be on PATH, so a rewrite
// runs it via `node "<cli.js>"`, which is always available.
const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "cli.js");
const rewriteOn = () => !/^(0|false|off|no)$/i.test(String(process.env.GDLOG_REWRITE ?? "1"));

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

  let mode = "warn"; // matches enforceMode()'s actual default; only used if enforceMode() throws (then we fail open below)
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
      const sliced = (ti.offset !== undefined && ti.offset !== null) || (ti.limit !== undefined && ti.limit !== null);
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

  // #1 transparent rewrite (Bash only): a single clean raw log-read segment is rerouted to the
  // gamedev-log CLI via updatedInput — the model's flow is unbroken AND the output is guaranteed
  // parsed/token-capped. Applies in BOTH warn and block modes (it beats both). Anything ambiguous
  // (pipelines, vars, quoted/multi paths) → null → fall through to the warn/block nudge below.
  if (hit.kind === "bash" && rewriteOn()) {
    const segs = String(ti.command).split(/\|\||&&|[|;&\n]/g).filter((s) => s.trim());
    if (segs.length === 1) {
      let rw = null;
      try {
        rw = buildLogRewrite(segs[0], CLI_PATH);
      } catch {
        rw = null; // any rewrite error → fall back to warn/block
      }
      if (rw) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              permissionDecisionReason: `Rerouted raw log read → gamedev-log ${rw.tool} (parsed, deduped, token-capped).`,
              updatedInput: { ...ti, command: rw.cmd },
              additionalContext:
                `[gamedev-log-analyzer] Rewrote your log read → \`gamedev-log ${rw.tool}\`` +
                (rw.q ? ` (query="${rw.q}")` : "") +
                ` — parsed + deduped + token-capped instead of a raw dump. Need other facets? ` +
                `gamedev-log search/locate/fields/diff. Disable rewrite: GDLOG_REWRITE=0 (then it nudges/blocks instead).`,
            },
          }) + "\n"
        );
        process.exit(0);
      }
    }
  }

  const nudge = nudgeText(hit.target, hit.kind);
  if (mode === "warn") {
    // allow the command, but inject the nudge into the model's context (stderr on exit 0 is not
    // reliably surfaced; additionalContext is). Trailing newline for line-buffered stdout readers.
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: nudge } }) + "\n"
    );
    process.exit(0);
  }
  process.stderr.write(nudge + "\n"); // block: deny + show nudge
  process.exit(2);
});
