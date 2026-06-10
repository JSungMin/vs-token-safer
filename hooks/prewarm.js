#!/usr/bin/env node
/*
 * SessionStart hook — optional IDE-style index pre-warm.
 *
 * OFF by default; enable with VTS_PREWARM_HOOK=1. When on AND a project root is configured
 * (VTS_PROJECT_PATH or ~/.vs-token-safer/config.json `projectPath`), it spawns `vts warmup` DETACHED
 * (fire-and-forget) so clangd's on-disk index (.cache/clangd) is warming before the first search.
 *
 * The MCP server already pre-warms at boot (VTS_PREWARM, default on) — this hook is mainly for
 * CLI-centric / non-MCP use, so it's opt-in to avoid double-warming. It never blocks the session.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const on = (v, d) => (v === undefined || v === "" ? d : !/^(0|false|off|no)$/i.test(v));
if (!on(process.env.VTS_PREWARM_HOOK, false)) process.exit(0);

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".vs-token-safer", "config.json"), "utf8")) || {}; } catch { /* none */ }
const root = process.env.VTS_PROJECT_PATH || cfg.projectPath;
if (!root) process.exit(0);

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const cli = path.join(pluginRoot, "server", "cli.js");
try {
  const child = spawn(process.execPath, [cli, "warmup", "--projectPath", root], { detached: true, stdio: "ignore" });
  child.unref();
} catch { /* best-effort */ }
process.exit(0);
