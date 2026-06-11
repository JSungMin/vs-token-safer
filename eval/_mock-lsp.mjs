// Minimal mock language server: speaks LSP framing so we can test LspClient without clangd/Roslyn.
let buf = Buffer.alloc(0);
const send = (obj) => {
  const j = Buffer.from(JSON.stringify(obj), "utf8");
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${j.length}\r\n\r\n`, "ascii"), j]));
};
process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const he = buf.indexOf("\r\n\r\n");
    if (he === -1) return;
    const len = parseInt(buf.slice(0, he).toString().match(/Content-Length:\s*(\d+)/i)[1], 10);
    if (buf.length < he + 4 + len) return;
    const msg = JSON.parse(buf.slice(he + 4, he + 4 + len).toString("utf8"));
    buf = buf.slice(he + 4 + len);
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { workspaceSymbolProvider: true, referencesProvider: true } } });
    else if (msg.method === "initialized") {
      // Simulate clangd's background-index work-done progress: a begin then an end notification.
      // The clangd backend's afterInit waits for the kind:"end" before the first query.
      send({ jsonrpc: "2.0", method: "$/progress", params: { token: "backgroundIndexProgress", value: { kind: "begin", title: "indexing" } } });
      send({ jsonrpc: "2.0", method: "$/progress", params: { token: "backgroundIndexProgress", value: { kind: "end" } } });
    } else if (msg.method === "workspace/symbol") {
      const q = (msg.params && msg.params.query) || "";
      // "SLOW" delays past a short request timeout — exercises VTS_LSP_TIMEOUT_MS handling.
      if (q === "SLOW") { setTimeout(() => send({ jsonrpc: "2.0", id: msg.id, result: [] }), 300); continue; }
      // "MISS" returns no symbols — exercises search_symbol's ts/pyright text-search fallback for a name
      // the workspace/symbol index doesn't surface (e.g. a non-exported local / unopened file).
      if (q === "MISS") { send({ jsonrpc: "2.0", id: msg.id, result: [] }); continue; }
      let result;
      if (q === "ALL") {
        // big result set with verbose container names — to exercise the token cap
        result = Array.from({ length: 1000 }, (_, i) => ({
          name: `Symbol_${i}`, kind: 12, containerName: `Namespace::Deeply::Nested::Container_${i % 50}`,
          location: { uri: `file:///proj/src/Module_${i % 80}/File_${i}.cpp`, range: { start: { line: i, character: 4 }, end: { line: i, character: 24 } } },
        }));
      } else {
        result = [
          { name: `${q}Handler`, kind: 5, location: { uri: "file:///proj/src/Foo.cpp", range: { start: { line: 41, character: 6 }, end: { line: 41, character: 20 } } } },
          { name: `${q}Util`, kind: 12, location: { uri: "file:///proj/src/Bar.cpp", range: { start: { line: 9, character: 0 }, end: { line: 9, character: 10 } } } },
        ];
      }
      send({ jsonrpc: "2.0", id: msg.id, result });
    } else if (msg.method === "textDocument/hover") {
      send({ jsonrpc: "2.0", id: msg.id, result: { contents: { kind: "plaintext", value: "int Foo(int x)" } } });
    } else if (msg.method === "textDocument/documentSymbol") {
      send({ jsonrpc: "2.0", id: msg.id, result: [{ name: "Foo", kind: 12, range: { start: { line: 4, character: 0 }, end: { line: 4, character: 10 } }, selectionRange: { start: { line: 4, character: 4 }, end: { line: 4, character: 7 } } }] });
    } else if (msg.method === "textDocument/rename") {
      const uri = msg.params.textDocument.uri, p = msg.params.position;
      if (msg.params.newName === "MULTI") {
        // Two non-overlapping edits on the SAME line, supplied front-to-back. applyEditsToText must
        // apply them back-to-front or the first edit shifts the second edit's offsets and corrupts.
        send({ jsonrpc: "2.0", id: msg.id, result: { changes: { [uri]: [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "X" },
          { range: { start: { line: 0, character: 8 }, end: { line: 0, character: 11 } }, newText: "ZZZZ" },
        ] } } });
        continue;
      }
      send({ jsonrpc: "2.0", id: msg.id, result: { changes: { [uri]: [{ range: { start: { line: p.line, character: p.character }, end: { line: p.line, character: p.character + 3 } }, newText: msg.params.newName }] } } });
    } else if (msg.method === "shutdown") send({ jsonrpc: "2.0", id: msg.id, result: null });
    else if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: null });
  }
});
