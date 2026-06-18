// Minimal Language Server Protocol client over a child process's stdio.
// Engine-neutral: spawn ANY language server (clangd for C++, the Roslyn/C# LSP, …) and call
// workspace/symbol, references, definition, hover. JSON-RPC 2.0 with `Content-Length` framing.
//
// This is the one genuinely new piece of vs-token-safer: the official engine (clangd from LLVM,
// Roslyn from Microsoft) does the analysis; this thin, fully-owned glue speaks to it locally. No
// third-party MCP glue runs over your source — only this file. Nothing leaves the machine.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// Positive-integer env override, else default. Used so huge-project users (e.g. a cold UE-scale clangd
// index) can raise the per-request timeout instead of hitting the hardcoded 30s ceiling.
export const envInt = (name, def) => { const v = parseInt(process.env[name], 10); return Number.isFinite(v) && v > 0 ? v : def; };

export const toUri = (p) => pathToFileURL(path.resolve(p)).href;
export const fromUri = (u) => {
  try { return fileURLToPath(u); } catch { return u.replace(/^file:\/\//, ""); }
};
// LSP servers disagree on file-uri spelling — clangd/tsserver emit a lowercase, %3A-encoded Windows drive
// (`file:///g%3A/…`) while ours is `file:///G:/…`. Compare by the DECODED os path with a lowercased Windows
// drive + forward slashes, so a per-file/diagnostics lookup matches regardless of the spelling.
export const canonFsPath = (uriOrPath) => {
  let p; try { p = fromUri(String(uriOrPath).startsWith("file:") ? uriOrPath : toUri(uriOrPath)); } catch { p = String(uriOrPath); }
  p = p.replace(/\\/g, "/");
  return /^[a-zA-Z]:/.test(p) ? p[0].toLowerCase() + p.slice(1) : p;
};

// LSP `textDocument/didOpen` wants a languageId. One backend can serve several extensions
// (typescript-language-server handles .ts/.tsx/.js/.jsx; pyright handles .py/.pyi), so derive the id
// from the file extension and fall back to the backend's primary language when the extension is unknown.
const EXT_LANG = {
  ".c": "c", ".cc": "cpp", ".cxx": "cpp", ".cpp": "cpp", ".h": "cpp", ".hpp": "cpp", ".hh": "cpp", ".inl": "cpp", ".ipp": "cpp", ".tpp": "cpp",
  ".cs": "csharp",
  ".ts": "typescript", ".tsx": "typescriptreact", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".pyi": "python",
};
const BACKEND_LANG = { clangd: "cpp", roslyn: "csharp", typescript: "typescript", pyright: "python" };

// Server→client requests whose result is void/optional, so `null` (acknowledged / no selection / no edit
// to make) is the spec-correct reply. window/workDoneProgress/create MUST be here — clangd waits for the
// ack before it streams the $/progress we use for index-ready. The */refresh family is a void ack too.
const SERVER_REQ_NULL_OK = new Set([
  "client/registerCapability", "client/unregisterCapability",
  "window/workDoneProgress/create", "window/showMessageRequest",
  "workspace/codeLens/refresh", "workspace/semanticTokens/refresh",
  "workspace/inlayHint/refresh", "workspace/inlineValue/refresh", "workspace/diagnostic/refresh",
]);
export function langIdForPath(p, backend) {
  const m = String(p || "").toLowerCase().match(/\.[^.\\/]+$/);
  return (m && EXT_LANG[m[0]]) || BACKEND_LANG[backend] || "cpp";
}

export class LspClient {
  constructor(cmd, args = [], { cwd = process.cwd(), env = process.env, shell = false } = {}) {
    this.cmd = cmd;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    // On Windows, npm-installed LSP CLIs (typescript-language-server, pyright-langserver) are `.cmd`
    // shims that child_process.spawn can't launch without a shell. Enabled per-backend (winShell) only
    // for those — clangd.exe / the dotnet host resolve directly and may sit under a path with spaces
    // that shell-quoting would mangle, so they stay shell:false.
    this.shell = shell;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.notified = new Map(); // server-notification method -> latest params (for late waiters)
    this.openDocs = new Map(); // uri -> last didOpen/didChange version (re-sync stale buffers, spec-correctly)
    this.notifyWaiters = new Map(); // method -> [resolve, …]
    this.diagnostics = new Map(); // uri -> latest textDocument/publishDiagnostics array (per file, not just last)
    this.buf = Buffer.alloc(0);
    this.stderr = "";
    this._initialized = false;
  }

  start() {
    // In shell mode, fold args into the command string and pass [] — spawn(cmd, [non-empty], {shell:true})
    // is deprecated (DEP0190: args aren't escaped). Our shell-mode args are simple flags (`--stdio`); a
    // user override with spaces should quote inside VTS_TS_CMD/VTS_PY_CMD.
    const cmd = this.shell ? [this.cmd, ...this.args].join(" ") : this.cmd;
    const args = this.shell ? [] : this.args;
    this.proc = spawn(cmd, args, { cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"], shell: this.shell });
    this.proc.stdout.on("data", (d) => this._onData(d));
    this.proc.stderr.on("data", (d) => { this.stderr += d.toString(); if (this.stderr.length > 20000) this.stderr = this.stderr.slice(-20000); });
    this.proc.on("error", (e) => this._failAll(new Error(`failed to spawn ${this.cmd}: ${e.message}`)));
    this.proc.on("exit", (code) => this._failAll(new Error(`${this.cmd} exited (code ${code}). stderr tail:\n${this.stderr.slice(-400)}`)));
  }

  _failAll(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  // ---- framing ----
  _send(obj) {
    const json = Buffer.from(JSON.stringify(obj), "utf8");
    const header = Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, "ascii");
    this.proc.stdin.write(Buffer.concat([header, json]));
  }
  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    // Parse as many complete messages as are buffered.
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buf.slice(0, headerEnd).toString("ascii");
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) { this.buf = this.buf.slice(headerEnd + 4); continue; } // malformed header; skip
      const len = parseInt(m[1], 10);
      const start = headerEnd + 4;
      if (this.buf.length < start + len) return; // wait for the rest of the body
      const body = this.buf.slice(start, start + len).toString("utf8");
      this.buf = this.buf.slice(start + len);
      let msg; try { msg = JSON.parse(body); } catch { continue; }
      this._dispatch(msg);
    }
  }
  _dispatch(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) { const e = new Error(`LSP error ${msg.error.code}: ${msg.error.message}`); e.code = msg.error.code; p.reject(e); }
      else p.resolve(msg.result);
    }
    // Server-initiated requests (have id + method) MUST get a reply or the server can stall the handshake.
    // Reply with the spec-correct RESULT SHAPE per method (a blanket null violates e.g.
    // workspace/configuration, which must be an array) — see _serverRequestReply.
    else if (msg.id !== undefined && msg.method) {
      this._send(this._serverRequestReply(msg));
    }
    // Server notifications (method, no id): record the latest params and wake any waiters. Used to
    // await load-complete signals like Roslyn's `workspace/projectInitializationComplete`.
    else if (msg.method && msg.id === undefined) {
      const params = msg.params ?? null;
      this.notified.set(msg.method, params);
      // Keep diagnostics PER FILE (notified only holds the last publish, of any uri) so a later
      // `diagnosticsFor(uri)` can answer from the right file even after other files published.
      if (msg.method === "textDocument/publishDiagnostics" && params && params.uri) this.diagnostics.set(params.uri, Array.isArray(params.diagnostics) ? params.diagnostics : []);
      const waiters = this.notifyWaiters.get(msg.method);
      if (waiters && waiters.length) {
        const remain = [];
        for (const w of waiters) { if (w.predicate(params)) w.resolve(params); else remain.push(w); }
        if (remain.length) this.notifyWaiters.set(msg.method, remain);
        else this.notifyWaiters.delete(msg.method);
      }
    }
  }

  // Build the spec-correct response to a server→client REQUEST we don't otherwise act on. The blanket
  // `result: null` we used to send is wrong for methods whose result has a required shape (an empty/void
  // reply is only correct for some). Unknown methods get MethodNotFound (-32601) per spec — servers handle
  // that gracefully — rather than a fake success.
  _serverRequestReply(msg) {
    const id = msg.id, method = msg.method, p = msg.params || {};
    // workspace/configuration → one config value PER requested item; null means "no override, use defaults".
    if (method === "workspace/configuration") {
      const items = Array.isArray(p.items) ? p.items : [];
      return { jsonrpc: "2.0", id, result: items.map(() => null) };
    }
    // We never apply server-driven workspace edits (vts is read-mostly; rename is client-side).
    if (method === "workspace/applyEdit") return { jsonrpc: "2.0", id, result: { applied: false } };
    // ShowDocumentResult has a required `success`.
    if (method === "window/showDocument") return { jsonrpc: "2.0", id, result: { success: false } };
    // Methods whose result is void / optional → null is the correct "acknowledged / no selection" answer.
    // window/workDoneProgress/create MUST stay here (clangd needs the ack before it streams $/progress).
    if (SERVER_REQ_NULL_OK.has(method)) return { jsonrpc: "2.0", id, result: null };
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
  }

  // Resolve when the server next sends `method` whose params satisfy `predicate` (or immediately if
  // a matching one was already seen). Resolves null on timeout — best-effort, so a server that never
  // emits the signal doesn't hang the caller forever. Used to await load/index-complete signals
  // (Roslyn `workspace/projectInitializationComplete`, clangd `$/progress` end / `publishDiagnostics`).
  waitForNotification(method, timeoutMs = 60000, predicate = () => true) {
    if (this.notified.has(method) && predicate(this.notified.get(method))) {
      return Promise.resolve(this.notified.get(method));
    }
    return new Promise((resolve) => {
      const arr = this.notifyWaiters.get(method) || [];
      const t = setTimeout(() => resolve(null), timeoutMs);
      arr.push({ predicate, resolve: (v) => { clearTimeout(t); resolve(v); } });
      this.notifyWaiters.set(method, arr);
    });
  }

  // Sync a document's CURRENT disk content to the server. First time → didOpen (forces clangd/tsserver to
  // parse + dynamically index that TU so workspace/symbol returns its symbols before the full background
  // index). Already open → didChange with a bumped version, so a file that changed on disk after warm-up
  // (an edit, a branch switch) is refreshed instead of the server answering from a stale in-memory buffer.
  // Position tools call this before every query, so each hover/goto/outline/rename re-reads the file. This
  // is also spec-correct — repeatedly sending didOpen (version 1) for an already-open doc is a soft
  // protocol violation that clangd/Roslyn merely tolerate.
  didOpen(filePath, languageId = "cpp") {
    let text;
    try { text = fs.readFileSync(filePath, "utf8"); } catch { this.didClose(filePath); return; }
    const uri = toUri(filePath);
    const prev = this.openDocs.get(uri);
    if (prev === undefined) {
      this.openDocs.set(uri, 1);
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
    } else {
      const version = prev + 1;
      this.openDocs.set(uri, version);
      this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
    }
  }
  // Drop a document the server may be holding (e.g. it was deleted/moved on disk) so it stops answering
  // from a stale buffer. No-op if we never opened it.
  didClose(filePath) {
    const uri = toUri(filePath);
    if (!this.openDocs.has(uri)) return;
    this.openDocs.delete(uri);
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  request(method, params, timeoutMs = envInt("VTS_LSP_TIMEOUT_MS", 30000)) {
    const id = this.nextId++;
    this._send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        // Tell the server to stop computing the abandoned request (frees a cold-UE clangd worker). Best-effort.
        try { this.notify("$/cancelRequest", { id }); } catch { /* ignore */ }
        reject(new Error(`LSP request '${method}' timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
    });
  }
  notify(method, params) { this._send({ jsonrpc: "2.0", method, params }); }

  // ---- high-level ----
  async initialize(rootPath) {
    this.start();
    const rootUri = toUri(rootPath);
    await this.request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(rootPath) }],
      capabilities: {
        workspace: { symbol: { dynamicRegistration: false }, workspaceFolders: true, configuration: true },
        textDocument: {
          // We send didOpen/didChange/didClose, so declare synchronization (full-text; no save/willSave).
          synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: false },
          references: { dynamicRegistration: false },
          definition: { dynamicRegistration: false },
          typeDefinition: { dynamicRegistration: false },
          implementation: { dynamicRegistration: false },
          declaration: { dynamicRegistration: false },
          hover: { contentFormat: ["plaintext", "markdown"] },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          rename: { dynamicRegistration: false, prepareSupport: false },
          callHierarchy: { dynamicRegistration: false }, // trace_calls: prepareCallHierarchy → incoming/outgoingCalls
          publishDiagnostics: { relatedInformation: false }, // we wait on diagnostics in the clangd warm-up fallback
        },
      },
    });
    this.notify("initialized", {});
    this._initialized = true;
  }
  symbol(query) { return this.request("workspace/symbol", { query }); }
  references(uriOrPath, line, character, includeDeclaration = false) {
    return this.request("textDocument/references", {
      textDocument: { uri: uriOrPath.startsWith("file:") ? uriOrPath : toUri(uriOrPath) },
      position: { line, character },
      context: { includeDeclaration },
    });
  }
  definition(uriOrPath, line, character) { return this.gotoByKind("definition", uriOrPath, line, character); }
  // Definition / type-definition / implementation / declaration share one position-request shape; the kind
  // just picks the LSP method (textDocument/definition|typeDefinition|implementation|declaration). Folded so
  // goto_definition can expose all four without four separate MCP tools.
  async gotoByKind(kind, uriOrPath, line, character) {
    const method = kind === "type_definition" ? "textDocument/typeDefinition"
      : kind === "implementation" ? "textDocument/implementation"
        : kind === "declaration" ? "textDocument/declaration"
          : "textDocument/definition";
    try {
      return await this.request(method, {
        textDocument: { uri: uriOrPath.startsWith("file:") ? uriOrPath : toUri(uriOrPath) },
        position: { line, character },
      });
    } catch (e) {
      // A backend without this provider (e.g. tsserver has no textDocument/declaration) replies MethodNotFound
      // (-32601). That's "this nav kind isn't available here", not a failure → return empty so the kind degrades
      // gracefully (caller renders "0 definition(s)") instead of surfacing a raw `-32601` LSP error to the model.
      if (e && (e.code === -32601 || /-32601/.test(String(e.message)))) return [];
      throw e;
    }
  }
  // Diagnostics (errors/warnings) for ONE file. The server pushes textDocument/publishDiagnostics after it
  // parses a didOpen'd file; we store them per-uri (_dispatch) and return the latest, waiting briefly for the
  // first publish if none arrived yet. Returns [] for a clean file (server publishes an empty array). The
  // caller didOpens the file first so the parse is triggered.
  async diagnosticsFor(uriOrPath, timeoutMs = 8000) {
    const want = canonFsPath(uriOrPath); // match by canonical path — servers spell the uri differently (Win drive case/%3A)
    for (const [k, ds] of this.diagnostics) if (canonFsPath(k) === want) return ds;
    const p = await this.waitForNotification("textDocument/publishDiagnostics", timeoutMs, (pp) => { try { return pp && canonFsPath(pp.uri) === want; } catch { return false; } });
    if (p && Array.isArray(p.diagnostics)) return p.diagnostics;
    for (const [k, ds] of this.diagnostics) if (canonFsPath(k) === want) return ds;
    return [];
  }
  hover(uriOrPath, line, character) {
    return this.request("textDocument/hover", {
      textDocument: { uri: uriOrPath.startsWith("file:") ? uriOrPath : toUri(uriOrPath) },
      position: { line, character },
    });
  }
  documentSymbol(uriOrPath) {
    return this.request("textDocument/documentSymbol", {
      textDocument: { uri: uriOrPath.startsWith("file:") ? uriOrPath : toUri(uriOrPath) },
    });
  }
  rename(uriOrPath, line, character, newName) {
    return this.request("textDocument/rename", {
      textDocument: { uri: uriOrPath.startsWith("file:") ? uriOrPath : toUri(uriOrPath) },
      position: { line, character },
      newName,
    });
  }
  // Call hierarchy (the 3-step LSP protocol behind trace_calls): prepare an item at a position, then walk
  // its incoming (callers) / outgoing (callees) edges. A backend without a callHierarchy provider replies
  // MethodNotFound (-32601) — caught here → [] so the tool degrades gracefully instead of surfacing a raw
  // LSP error, exactly like gotoByKind. The engine resolves the call graph; we only walk + token-cap it.
  async _callHierGraceful(method, params) {
    try { return (await this.request(method, params)) || []; }
    catch (e) { if (e && (e.code === -32601 || /-32601/.test(String(e.message)))) return []; throw e; }
  }
  prepareCallHierarchy(uriOrPath, line, character) {
    return this._callHierGraceful("textDocument/prepareCallHierarchy", {
      textDocument: { uri: uriOrPath.startsWith("file:") ? uriOrPath : toUri(uriOrPath) },
      position: { line, character },
    });
  }
  incomingCalls(item) { return this._callHierGraceful("callHierarchy/incomingCalls", { item }); }
  outgoingCalls(item) { return this._callHierGraceful("callHierarchy/outgoingCalls", { item }); }
  async shutdown() {
    // Teardown must RELIABLY release the child + all its handles — the backend-pool memory guard depends
    // on an evicted client actually freeing its process (else the LRU/idle reap leaves zombies and memory
    // never drops). A graceful LSP shutdown round-trip is skipped on purpose: it queued a WriteWrap to a
    // child that may have stopped reading and a 3s pending request, both of which kept the event loop
    // alive after teardown (eval hung post-PASS; CI never exited the test step). Kill decisively, reject
    // any pending requests so their timeout timers clear, and destroy the stdio pipes so no queued write
    // lingers. clangd/roslyn handle SIGTERM/TerminateProcess fine (shards are written atomically).
    try { this.proc && this.proc.kill(); } catch { /* ignore */ }
    try { this._failAll(new Error("client shut down")); } catch { /* ignore */ }
    try { this.proc?.stdin?.destroy(); this.proc?.stdout?.destroy(); this.proc?.stderr?.destroy(); } catch { /* ignore */ }
    this.proc = null;
  }
}
