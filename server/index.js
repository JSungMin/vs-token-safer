#!/usr/bin/env node
/*
 * vs-token-safer — MCP server (thin adapter over core.js).
 * Forces code search through an official language server's index (clangd for C++, the Roslyn/C# LSP)
 * instead of Bash grep, and TOKEN-CAPS the result to a compact file:line list (no source bodies).
 *
 * All tool logic lives in core.js (shared with the CLI at cli.js, `vts`) so there is exactly one
 * implementation per tool. This file only maps MCP requests to runTool(). runTool is ASYNC (LSP is
 * async); the handler awaits it. Each LSP backend is spawned lazily and cached for the process — we
 * dispose clients on shutdown so no language-server child is left running.
 */
import { Server, StdioServerTransport, ListToolsRequestSchema, CallToolRequestSchema, RootsListChangedNotificationSchema } from "./sdk.js";
import { runTool, disposeClients, prewarm, autoLearn, setMcpRoots, getMcpRoots, PROJECT_PATH, BACKEND, PREWARM_BACKENDS } from "./core.js";
import { pickBackend } from "./backends/index.js";
import { fromUri } from "./lsp.js";
import { prewarmBackends } from "./warmset.js";
import { TOOLS, ADMIN_OPS } from "./tools.js";

const log = (...a) => console.error("[vs-token-safer]", ...a);
const envBool = (name, def) => { const v = process.env[name]; if (v === undefined || v === "") return def; return !/^(0|false|off|no)$/i.test(v); };


const server = new Server({ name: "vs-search", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
// vts_admin is an MCP-surface alias that folds the 9 cold admin/meta tools behind one schema (token-cap of
// the fixed tool-definition cost). Translate vts_admin{op,params} → the real vts_<op> tool here; everything
// else (the hot search/nav/edit tools) dispatches by name unchanged. core.js / the CLI never see vts_admin.
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  let name = req.params.name;
  let args = req.params.arguments || {};
  if (name === "vts_admin") {
    const op = String(args.op || "");
    if (!ADMIN_OPS.has(op)) return { isError: true, content: [{ type: "text", text: `vts_admin: unknown op "${op}". One of: ${[...ADMIN_OPS].join(", ")}.` }] };
    name = "vts_" + op;
    args = args.params && typeof args.params === "object" ? args.params : {};
  }
  const { text, isError } = await runTool(name, args);
  return { isError, content: [{ type: "text", text }] };
});

// Dispose spawned language-server children on process exit so none are orphaned.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => { try { await disposeClients(); } catch { /* ignore */ } process.exit(0); });
}
// If the controlling parent dies (its stdin pipe to us closes) — including an uncatchable SIGKILL that no
// parent-side handler can survive — the MCP transport can deliver nothing more, but a spawned clangd's pipes
// can keep our event loop alive, orphaning us + clangd. Exit on stdin EOF (disposing clients first) so a dead
// parent never leaves this server running. Guarded so we tear down exactly once.
let _stdinGone = false;
const _onStdinGone = async () => { if (_stdinGone) return; _stdinGone = true; try { await disposeClients(); } catch { /* ignore */ } process.exit(0); };
process.stdin.on("end", _onStdinGone);
process.stdin.on("close", _onStdinGone);

// MCP roots handshake: the client (Claude Code) advertises its workspace folder(s) via the `roots`
// capability. Used to resolve a per-call project root, so ONE globally-installed server serves every repo
// a session touches instead of being pinned to a single configured projectPath (resolveRoot in core.js).
// Degrades silently to "no roots" (→ PROJECT_PATH || cwd, the old behavior) when the client doesn't
// advertise roots. Re-fetched on roots/list_changed so switching the workspace updates the resolution.
async function refreshRoots() {
  try {
    const caps = server.getClientCapabilities?.();
    if (!caps || !caps.roots) return;
    const res = await server.listRoots();
    const paths = (res?.roots || []).map((r) => { try { return fromUri(r.uri); } catch { return null; } }).filter(Boolean);
    setMcpRoots(paths);
    if (paths.length) log(`workspace roots: ${paths.join(", ")}`);
  } catch (e) { log(`roots query failed: ${e.message}`); }
}
if (RootsListChangedNotificationSchema) {
  try { server.setNotificationHandler(RootsListChangedNotificationSchema, () => refreshRoots()); } catch { /* client/SDK without roots — ignore */ }
}

await server.connect(new StdioServerTransport());
log("ready on stdio.");
await refreshRoots(); // populate MCP_ROOTS before prewarm so a config-less install warms the current workspace

// IDE-style background pre-warm: spawn + index the backend now so the user's first search reuses an
// already-warming/warm client instead of paying cold warmup inline. The warm root is the configured
// projectPath, or — for a config-less global install — the first MCP workspace root. Only ONE root is
// prewarmed (never every advertised root — that would defeat the backend-pool memory guard). Default on;
// disable with VTS_PREWARM=0 (fire-and-forget — never blocks boot).
const warmRoot = PROJECT_PATH || getMcpRoots()[0] || "";
if (warmRoot && envBool("VTS_PREWARM", true)) {
  // Single dominant backend by default; VTS_PREWARM_BACKENDS=all (or a comma list) warms every detected
  // language, each with its language-proportional adaptive cap (warmCap). Fire-and-forget — never blocks boot.
  const picked = BACKEND || pickBackend(warmRoot);
  const backends = prewarmBackends(warmRoot, picked, process.env.VTS_PREWARM_BACKENDS || PREWARM_BACKENDS);
  for (const backend of backends) {
    log(`pre-warming ${backend} index for ${warmRoot} …`);
    prewarm(warmRoot, backend).then(
      (c) => { if (c) log(`index warm (${backend}).`); },
      (e) => log(`pre-warm failed (${backend}): ${e.message}`),
    );
  }
}

// Boot-time self-improvement (VTS_AUTO_LEARN, default on when a warm root exists): harvest the files
// that recent BYPASSED code searches actually hit (local transcript scan, bounded, read-only) into the
// warm-set query-history — the same write `vts discover --learn` does, with no human in the loop. The
// next warm-up front-loads what past sessions really searched for. Deferred so boot/prewarm goes first.
if (warmRoot && envBool("VTS_AUTO_LEARN", true)) {
  setTimeout(() => {
    try {
      const n = autoLearn(warmRoot, 7);
      if (n) log(`auto-learn: ${n} file(s) from recent bypassed searches → warm-set for ${warmRoot}.`);
    } catch { /* best-effort — never disturb the server */ }
  }, 3000).unref?.();
}
