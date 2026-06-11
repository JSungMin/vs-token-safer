// Resolve a bundled language-server's bin entry to an absolute .js path, searching the SAME
// node_modules locations as the MCP SDK (sdk.js): the plugin data dir (installed, populated by the
// ensure-deps SessionStart hook / sdk self-heal), the plugin's bundled copy, then local node_modules
// (dev). typescript-language-server and pyright ship as npm deps in server/package.json, so they get
// installed automatically for every user — no manual `npm i -g`. We launch them with `node <bin.js>`
// rather than the PATH shim so there's no Windows `.cmd`/shell quoting to get wrong, and a path with
// spaces is passed literally. Returns null if the package isn't installed anywhere; the caller then
// falls back to a PATH-resolved global binary (with winShell on Windows).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const DATA = process.env.CLAUDE_PLUGIN_DATA;
const ROOT = process.env.CLAUDE_PLUGIN_ROOT;
const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/

function anchors() {
  const a = [];
  if (DATA) a.push(path.join(DATA, "package.json"));
  if (ROOT) a.push(path.join(ROOT, "server", "package.json"));
  a.push(path.join(HERE, "package.json")); // dev / local node_modules
  return a;
}

export function resolveBinJs(pkg, binName) {
  for (const anchor of anchors()) {
    try {
      const req = createRequire(pathToFileURL(anchor).href);
      const pj = req.resolve(`${pkg}/package.json`);
      const meta = JSON.parse(fs.readFileSync(pj, "utf8"));
      const rel = typeof meta.bin === "string" ? meta.bin : meta.bin && meta.bin[binName];
      if (!rel) continue;
      const abs = path.join(path.dirname(pj), rel);
      if (fs.existsSync(abs)) return abs;
    } catch {
      /* try the next anchor */
    }
  }
  return null;
}
