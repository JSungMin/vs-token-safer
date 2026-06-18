/*
 * vts serve — the local dashboard server. node:http ONLY (no express / ws / external dep), bound to
 * 127.0.0.1 so it is unreachable off-machine — the page + /data never leave the host, preserving the
 * zero-transmission guarantee. Opt-in + ephemeral: it runs ONLY when the user types `vts serve` and stops
 * on Ctrl-C; it is NOT started by the MCP server, so the steady-state package stays a thin stdio client.
 * Two same-origin routes: `/` (the inlined HTML page) and `/data` (the dashboard JSON for `root`).
 */
import http from "node:http";
import { buildVizData, renderDashboardHtml } from "./viz.js";

const LOCALHOST = "127.0.0.1"; // never 0.0.0.0 — local-only by construction
// Build (don't listen) so the eval can drive it on an ephemeral port. `port=0` lets the OS pick one.
export function createServer(root) {
  return http.createServer((req, res) => {
    try {
      const url = (req.url || "/").split("?")[0];
      if (url === "/" || url === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(renderDashboardHtml());
      } else if (url === "/data" || url === "/data.json") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(buildVizData(root)));
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
