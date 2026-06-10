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
    else if (msg.method === "workspace/symbol") {
      const q = (msg.params && msg.params.query) || "";
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
    } else if (msg.method === "shutdown") send({ jsonrpc: "2.0", id: msg.id, result: null });
    else if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: null });
  }
});
