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
      // 2nd line is a pathological 300-char "type" — fmtHover must trim each line to ≤200 (not just cap lines).
      send({ jsonrpc: "2.0", id: msg.id, result: { contents: { kind: "plaintext", value: "int Foo(int x)\n" + "T".repeat(300) } } });
    } else if (msg.method === "textDocument/documentSymbol") {
      // Foo (top-level func) with children: a real method (kept), an anonymous callback + a nested local
      // var (both outline noise → hidden by default; shown under VTS_OUTLINE_RAW=1).
      const rng = { start: { line: 4, character: 0 }, end: { line: 4, character: 10 } };
      const sel = { start: { line: 4, character: 4 }, end: { line: 4, character: 7 } };
      send({ jsonrpc: "2.0", id: msg.id, result: [
        { name: "Foo", kind: 12, range: rng, selectionRange: sel, children: [
          { name: "keepMethod", kind: 6, range: rng, selectionRange: sel },
          // anonymous callback (hidden) that CONTAINS a real nested decl — must NOT be orphaned.
          { name: "arr.map() callback", kind: 12, range: rng, selectionRange: sel, children: [
            { name: "realInner", kind: 12, range: rng, selectionRange: sel },
          ] },
          { name: "localTmp", kind: 13, range: rng, selectionRange: sel },
          // object-literal property key (kind 7) under a FUNCTION → data, hidden by default.
          { name: "noiseKey", kind: 7, range: rng, selectionRange: sel },
        ] },
        // a top-level symbol literally named "callback" — a real declaration, must be KEPT (depth-0).
        { name: "callback", kind: 12, range: rng, selectionRange: sel },
        // a CLASS whose property (kind 7) IS structure → must be KEPT (parent is class-like).
        { name: "Cls", kind: 5, range: rng, selectionRange: sel, children: [
          { name: "keepProp", kind: 7, range: rng, selectionRange: sel },
        ] },
      ] });
    } else if (msg.method === "textDocument/definition") {
      // One definition location — lets goto_definition return a non-empty result (e.g. to exercise the
      // edit-steer that rides a focused nav result).
      send({ jsonrpc: "2.0", id: msg.id, result: [{ uri: "file:///proj/src/Foo.cpp", range: { start: { line: 41, character: 6 }, end: { line: 41, character: 20 } } }] });
    } else if (msg.method === "textDocument/typeDefinition") {
      send({ jsonrpc: "2.0", id: msg.id, result: [{ uri: "file:///proj/src/Type.cpp", range: { start: { line: 200, character: 0 }, end: { line: 200, character: 5 } } }] });
    } else if (msg.method === "textDocument/implementation") {
      send({ jsonrpc: "2.0", id: msg.id, result: [{ uri: "file:///proj/src/Impl.cpp", range: { start: { line: 100, character: 0 }, end: { line: 100, character: 5 } } }] });
    } else if (msg.method === "textDocument/declaration") {
      send({ jsonrpc: "2.0", id: msg.id, result: [{ uri: "file:///proj/src/Decl.cpp", range: { start: { line: 300, character: 0 }, end: { line: 300, character: 5 } } }] });
    } else if (msg.method === "textDocument/didOpen") {
      // Push diagnostics after a parse, keyed on the uri: a file whose name contains "diag" gets an
      // error + a warning (out of severity order, to exercise the sort); any other file is clean ([]).
      const uri = (msg.params && msg.params.textDocument && msg.params.textDocument.uri) || "";
      const diags = /diag/i.test(uri)
        ? [{ severity: 2, range: { start: { line: 9, character: 0 }, end: { line: 9, character: 4 } }, message: "unused variable 'x'" },
          { severity: 1, range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } }, code: "E001", message: "use of undeclared identifier 'foo'" }]
        : [];
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: diags } });
    } else if (msg.method === "textDocument/references") {
      // "Foo"'s name sits at line 4 (its selectionRange) — return one usage there so safe_delete sees a
      // referrer and refuses; any other position (e.g. the find_references guard at line 41) returns none.
      const rp = msg.params.position;
      send({ jsonrpc: "2.0", id: msg.id, result: rp.line === 4 ? [{ uri: "file:///proj/src/User.cpp", range: { start: { line: 7, character: 2 }, end: { line: 7, character: 5 } } }] : [] });
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
