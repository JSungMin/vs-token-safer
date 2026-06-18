/*
 * vts serve — the local dashboard server. node:http ONLY (no express / ws / external dep), bound to
 * 127.0.0.1 so it is unreachable off-machine — the page, /data, and the vendored Three.js never leave the
 * host, preserving the zero-transmission guarantee. Opt-in + ephemeral: it runs ONLY when the user types
 * `vts serve` (or the /vs-token-safer:viz command) and stops on Ctrl-C / `vts serve --stop`; it is NOT
 * started by the MCP server, so the steady-state package stays a thin stdio client. Routes: `/` (the page),
 * `/data` (the dashboard JSON), `/vendor/three.module.min.js` (the locally-vendored 3D lib, same-origin —
 * NEVER a CDN). A pidfile lets the `/viz` + `/viz-stop` commands open/close it without hunting the process.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildVizData, renderDashboardHtml } from "./viz.js";
import { buildCallGraph, listSymbols } from "./core.js";

const LOCALHOST = "127.0.0.1"; // never 0.0.0.0 — local-only by construction
const VENDOR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "vendor");
// Only these vendored files are served — an explicit allowlist so the /vendor route can never become an
// arbitrary-file read (no path traversal).
const VENDOR_FILES = new Set(["three.module.min.js"]);
export const PID_FILE = process.env.VTS_SERVE_PID || path.join(os.homedir(), ".vs-token-safer", "serve.pid");

// Build (don't listen) so the eval can drive it on an ephemeral port. `port=0` lets the OS pick one.
export function createServer(root) {
  return http.createServer(async (req, res) => {
    try {
      const url = (req.url || "/").split("?")[0];
      if (url === "/" || url === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(renderDashboardHtml());
      } else if (url === "/data" || url === "/data.json") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(buildVizData(root)));
      } else if (url === "/callgraph") {
        // ON-DEMAND call graph (the comparable-to-cbm "call graph" view) — resolve a symbol and walk LSP
        // callHierarchy live (no persistent graph). Query: ?symbol=Foo&direction=both|callers|callees&depth=N.
        const q = new URL(req.url, "http://127.0.0.1").searchParams;
        const a = { projectPath: q.get("projectPath") || root, symbol: q.get("symbol") || undefined, direction: q.get("direction") || "both", depth: q.get("depth") || undefined, backend: q.get("backend") || undefined };
        if (q.get("path")) { a.path = q.get("path"); a.line = q.get("line"); a.character = q.get("character"); }
        let data; try { data = await buildCallGraph(a); } catch (e) { data = { error: e && e.message ? e.message : String(e), nodes: [], links: [] }; }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(data));
      } else if (url === "/symbols") {
        // Symbol-name autocomplete for the call-graph search box. Query: ?q=<prefix>&backend=.
        const q = new URL(req.url, "http://127.0.0.1").searchParams;
        const a = { projectPath: q.get("projectPath") || root, q: q.get("q") || "", backend: q.get("backend") || undefined };
        let data; try { data = await listSymbols(a); } catch (e) { data = { error: e && e.message ? e.message : String(e), symbols: [] }; }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(data));
      } else if (url.startsWith("/vendor/")) {
        const name = path.basename(url); // basename strips any ../ — and the allowlist is the real guard
        if (!VENDOR_FILES.has(name)) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }
        let body; try { body = fs.readFileSync(path.join(VENDOR_DIR, name)); } catch { res.writeHead(404); res.end("not found"); return; }
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "max-age=86400" });
        res.end(body);
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("error: " + (e && e.message ? e.message : String(e)));
    }
  });
}

// Start listening on 127.0.0.1:port (port 0 → OS-assigned). Resolves with { server, port, url }.
export function startServer(root, port = 8731) {
  const server = createServer(root);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LOCALHOST, () => {
      const p = server.address().port;
      resolve({ server, port: p, url: `http://${LOCALHOST}:${p}/` });
    });
  });
}

// --- pidfile (so /viz can open and /viz-stop can close the dashboard without the user hunting the PID) ---
export function writePid(info) {
  try { fs.mkdirSync(path.dirname(PID_FILE), { recursive: true }); fs.writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, ...info })); } catch { /* best-effort */ }
}
export function readPid() { try { return JSON.parse(fs.readFileSync(PID_FILE, "utf8")); } catch { return null; } }
export function clearPid() { try { fs.rmSync(PID_FILE, { force: true }); } catch { /* ignore */ } }
// Stop a running dashboard: read the pidfile, signal the process, remove the file. Returns a status string.
export function stopServer() {
  const info = readPid();
  if (!info || !info.pid) return "No dashboard appears to be running (no pidfile).";
  try { process.kill(info.pid); clearPid(); return `Stopped the dashboard (pid ${info.pid}${info.url ? `, was ${info.url}` : ""}).`; }
  catch (e) {
    clearPid(); // stale pidfile (process already gone) — clean it up and say so
    return /ESRCH/.test(String(e.code || e.message)) ? "Dashboard wasn't running (cleared a stale pidfile)." : `Could not stop pid ${info.pid}: ${e.message}`;
  }
}

// Open a URL in the OS default browser (best-effort, detached, errors swallowed). Used by `vts serve --open`.
export function openBrowser(url) {
  try {
    const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const c = spawn(cmd, args, { detached: true, stdio: "ignore" });
    c.on("error", () => {}); c.unref();
  } catch { /* best-effort */ }
}
