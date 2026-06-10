// Resolve the MCP SDK across the locations an installed plugin might keep node_modules.
//
// Installed plugins store deps in ${CLAUDE_PLUGIN_DATA} (persists across updates), normally
// populated by the SessionStart `ensure-deps` hook. That hook is async, best-effort, and only
// runs when Claude Code passes CLAUDE_PLUGIN_DATA to hooks — so it can silently no-op, leaving
// an empty data dir. The MCP server spawn DOES receive CLAUDE_PLUGIN_DATA, so we self-heal here:
// try every known node_modules location and, if none resolve, install synchronously before
// importing. Failures go to stderr (visible in MCP logs) instead of crashing with an opaque
// JSON-RPC -32000. ESM ignores NODE_PATH and the SDK remaps subpaths via "exports", so we use
// createRequire (which honours "exports") anchored at a package.json next to a node_modules.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const SUBDIR = "server"; // package.json lives at ROOT/SUBDIR for installed plugins
const TAG = "vs-token-safer";
const DATA = process.env.CLAUDE_PLUGIN_DATA;
const ROOT = process.env.CLAUDE_PLUGIN_ROOT;
const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/

// Candidate require-anchors, in priority order: data dir (installed), the plugin's own bundled
// copy (cache), then local node_modules (dev). The first whose node_modules resolves the SDK wins.
function anchors() {
  const a = [];
  if (DATA) a.push(path.join(DATA, "package.json"));
  if (ROOT) a.push(path.join(ROOT, SUBDIR, "package.json"));
  a.push(path.join(HERE, "package.json")); // server/package.json (dev / local)
  return a;
}

function resolver() {
  for (const anchor of anchors()) {
    try {
      const req = createRequire(pathToFileURL(anchor).href);
      req.resolve("@modelcontextprotocol/sdk/types.js"); // probe before trusting it
      return req;
    } catch {
      /* try the next location */
    }
  }
  return null;
}

// Synchronously install deps into the data dir. Protocol-safe: child stdout is discarded (the MCP
// stdio transport owns our stdout), child stderr is inherited so npm errors surface in MCP logs.
function installIntoData() {
  if (!DATA || !ROOT) return; // dev mode — rely on local node_modules
  const src = path.join(ROOT, SUBDIR, "package.json");
  const dst = path.join(DATA, "package.json");
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(dst, fs.readFileSync(src, "utf8"));
    // Use the npm shipped next to this node binary so a thin hook PATH can't hide it (the original
    // SessionStart failure mode on Windows, where `npm` resolves to npm.cmd only via PATH).
    const isWin = process.platform === "win32";
    const local = path.join(path.dirname(process.execPath), isWin ? "npm.cmd" : "npm");
    const npm = fs.existsSync(local) ? `"${local}"` : "npm";
    execSync(`${npm} install --no-audit --no-fund --loglevel=error`, {
      cwd: DATA,
      stdio: ["ignore", "ignore", "inherit"],
    });
  } catch (e) {
    console.error(`[${TAG}] dependency install failed:`, e?.message || e);
    try {
      fs.rmSync(dst); // drop the marker so the next spawn / SessionStart hook retries
    } catch {
      /* ignore */
    }
  }
}

let req = resolver();
if (!req) {
  console.error(`[${TAG}] MCP SDK not found — installing dependencies (first run, one moment)…`);
  installIntoData();
  req = resolver();
}
if (!req) {
  console.error(
    `[${TAG}] FATAL: could not resolve @modelcontextprotocol/sdk. ` +
      `Check that Node can run 'npm install' for this plugin, then restart the MCP server.`,
  );
  process.exit(1);
}

const load = (sub) => import(pathToFileURL(req.resolve("@modelcontextprotocol/sdk/" + sub)).href);

export const { Server } = await load("server/index.js");
export const { StdioServerTransport } = await load("server/stdio.js");
export const { ListToolsRequestSchema, CallToolRequestSchema } = await load("types.js");
