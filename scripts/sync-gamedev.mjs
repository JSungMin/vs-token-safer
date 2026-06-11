#!/usr/bin/env node
// Sync the bundled gamedev-log-analyzer mirror from the maintained source AND keep the marketplace entry
// version in lockstep. `claude plugin validate . --strict` (CI `validate` job) and the eval parity guard
// both require marketplace.json `plugins[].version` === that plugin's `plugin.json` version, so syncing the
// bundle without bumping the entry breaks CI (this is exactly what happened at v0.10.0). Run this whenever
// you refresh the bundle instead of copying by hand:
//
//   node scripts/sync-gamedev.mjs [sourceDir]
//
// sourceDir defaults to ../rider-mcp-enforcer/gamedev-log-analyzer (the maintained copy; this repo does not
// npm-publish gamedev-log-analyzer). After it runs: `node eval/run.mjs` then `claude plugin validate . --strict`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const DEST = path.join(REPO, "gamedev-log-analyzer");
const SRC = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(REPO, "..", "rider-mcp-enforcer", "gamedev-log-analyzer");

const srcManifest = path.join(SRC, ".claude-plugin", "plugin.json");
if (!fs.existsSync(srcManifest)) {
  console.error(`[sync-gamedev] source not found: ${srcManifest}\n` +
    `Pass the source dir as arg 1, or ensure ../rider-mcp-enforcer/gamedev-log-analyzer exists.`);
  process.exit(1);
}
const srcVer = JSON.parse(fs.readFileSync(srcManifest, "utf8")).version;

// Mirror SRC → DEST, skipping node_modules/.git so source deletions propagate (rm DEST first → true mirror).
const skip = (p) => /(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(p);
fs.rmSync(DEST, { recursive: true, force: true });
fs.cpSync(SRC, DEST, { recursive: true, filter: (s) => !skip(s) });

// Keep the marketplace entry version == the synced plugin.json version.
const mktPath = path.join(REPO, ".claude-plugin", "marketplace.json");
const mkt = JSON.parse(fs.readFileSync(mktPath, "utf8"));
const entry = mkt.plugins.find((p) => p.name === "gamedev-log-analyzer");
if (!entry) { console.error("[sync-gamedev] no gamedev-log-analyzer entry in .claude-plugin/marketplace.json"); process.exit(1); }
const prev = entry.version;
entry.version = srcVer;
fs.writeFileSync(mktPath, JSON.stringify(mkt, null, 2) + "\n");

console.log(`[sync-gamedev] mirrored ${SRC}`);
console.log(`[sync-gamedev]        → ${DEST}`);
console.log(`[sync-gamedev] marketplace gamedev-log-analyzer entry: ${prev} → ${srcVer}`);
console.log(`[sync-gamedev] next: \`node eval/run.mjs\` (parity guard) + \`claude plugin validate . --strict\`.`);
