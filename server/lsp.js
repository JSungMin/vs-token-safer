// Minimal Language Server Protocol client over a child process's stdio.
// Engine-neutral: spawn ANY language server (clangd for C++, the Roslyn/C# LSP, …) and call
// workspace/symbol, references, definition, hover. JSON-RPC 2.0 with `Content-Length` framing.
//
// This is the one genuinely new piece of vs-token-safer: the official engine (clangd from LLVM,
// Roslyn from Microsoft) does the analysis; this thin, fully-owned glue speaks to it locally. No
// third-party MCP glue runs over your source — only this file. Nothing leaves the machine.
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export const toUri = (p) => pathToFileURL(path.resolve(p)).href;
export const fromUri = (u) => {
  try { return fileURLToPath(u); } catch { return u.replace(/^file:\/\//, ""); }
};

export class LspClient {
  constructor(cmd, args = [], { cwd = process.cwd(), env = process.env } = {}) {
    this.cmd = cmd;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.buf = Buffer.alloc(0);
    this.stderr = "";
    this._initialized = false;
  }

  start() {
    this.proc = spawn(this.cmd, this.args, { cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"] });
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
      if (msg.error) p.reject(new Error(`LSP error ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
    }
    // Server-initiated requests/notifications (window/logMessage, client/registerCapability, …) are
    // ignored except those that need a reply to avoid blocking the handshake.
    else if (msg.id !== undefined && msg.method) {
      this._send({ jsonrpc: "2.0", id: msg.id, result: null }); // benign default reply
    }
  }

  request(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    this._send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`LSP request '${method}' timed out`)); }, timeoutMs);
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
        workspace: { symbol: { dynamicRegistration: false }, workspaceFolders: true },
        textDocument: {
          references: { dynamicRegistration: false },
          definition: { dynamicRegistration: false },
          hover: { contentFormat: ["plaintext", "markdown"] },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
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
  definition(uriOrPath, line, character) {
    return this.request("textDocument/definition", {
      textDocument: { uri: uriOrPath.startsWith("file:") ? uriOrPath : toUri(uriOrPath) },
      position: { line, character },
    });
  }
  async shutdown() {
    try { await this.request("shutdown", null, 3000); this.notify("exit", null); } catch { /* ignore */ }
    try { this.proc && this.proc.kill(); } catch { /* ignore */ }
  }
}
