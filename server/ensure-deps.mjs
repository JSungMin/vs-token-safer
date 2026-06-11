#!/usr/bin/env node
// Cross-platform dependency installer for the plugin MCP server, run from a SessionStart hook.
// Installs node_modules into ${CLAUDE_PLUGIN_DATA} (persists across plugin updates) the first
// time, and re-installs whenever the bundled package.json changes. Best-effort and silent.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const ROOT = process.env.CLAUDE_PLUGIN_ROOT;
const DATA = process.env.CLAUDE_PLUGIN_DATA;
const SUBDIR = process.argv[2] || "."; // package.json lives in ROOT/SUBDIR
if (!ROOT || !DATA) process.exit(0); // dev / not an installed plugin → use local node_modules

const src = path.join(ROOT, SUBDIR, "package.json");
const dst = path.join(DATA, "package.json");
try {
  const bundled = fs.readFileSync(src, "utf8");
  let stored = "";
  try {
    stored = fs.readFileSync(dst, "utf8");
  } catch {
    /* first run */
  }
  const haveModules = fs.existsSync(path.join(DATA, "node_modules"));
  if (bundled === stored && haveModules) process.exit(0); // up to date
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(dst, bundled);
  // Use the npm shipped next to this node binary: a SessionStart hook may run with a thin PATH
  // that hides `npm` (resolves to npm.cmd via PATH only on Windows), which silently broke installs.
  const isWin = process.platform === "win32";
  const local = path.join(path.dirname(process.execPath), isWin ? "npm.cmd" : "npm");
  const npm = fs.existsSync(local) ? `"${local}"` : "npm";
  // Deps grew (typescript + typescript-language-server + pyright ≈ 50 MB), so a stalled registry could
  // otherwise block this SessionStart hook indefinitely. Bound it; on timeout the catch drops the marker
  // so the next session retries.
  execSync(`${npm} install --no-audit --no-fund --loglevel=error`, { cwd: DATA, stdio: "ignore", timeout: 300000 });
} catch (e) {
  // Surface the reason on stderr (visible in hook logs) instead of failing completely silently;
  // the MCP server self-heals at spawn, but a logged cause speeds diagnosis when even that can't.
  console.error("[ensure-deps] install failed:", e?.message || e);
  try {
    fs.rmSync(dst); // failed → drop the marker so next session retries
  } catch {
    /* ignore */
  }
  process.exit(0);
}
