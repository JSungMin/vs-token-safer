# Benchmark

vs-token-safer's whole point is **token efficiency**: return the answer to a code-search question as a
compact `file:line` list instead of dumping raw source (or a raw language-server index response) into
the model's context. This file documents how that's measured and how to reproduce it.

## The gate (runs on every commit)

`eval/run.mjs` exercises the genuinely-new layer against a **mock language server** (no clangd / Roslyn
toolchain needed, so it runs in CI on Windows + Linux across Node 18/20/22). It asserts:

| Check | What it proves |
| --- | --- |
| LSP client handshake + `workspace/symbol` | The JSON-RPC / `Content-Length` framing client talks to a real LSP. |
| symbol → `file:line` (no bodies) | The formatter emits `kind name @ file:line` and **never** ranges/kinds/source. |
| token cap (1,000 syms → capped) | A large index response collapses to a capped list with a `… N more` footer. |
| **token reduction vs raw index ≥ 70%** | The core promise — the response is dramatically smaller. |
| references wiring | `find_references` resolves and formats locations. |
| `runTool` dispatch | MCP and CLI share one implementation. |

Run it:

```
node eval/run.mjs
```

Representative output:

```
✓ LSP client handshake + symbol          true   true
✓ symbol → file:line (no bodies)         true   true
✓ token cap (1000 syms → capped)         true   true
✓ token reduction vs raw index          97.4%   ≥ 70%
✓ references wiring                       true   true
✓ runTool dispatch                        true   true

raw index ~57,308 tok → capped output ~1,515 tok
EVAL PASSED.
```

## What the number means

- **Raw index response** = the JSON the language server returns for a broad `workspace/symbol` query
  (1,000 symbols, each with name, kind, container, and a full URI + range). ~57k tokens.
- **Capped output** = what vs-token-safer actually hands the model: `maxResults` lines of
  `kind name (in container) @ file:line`, plus a `… N more` footer. ~1.5k tokens.
- The reduction is **~97%** on this synthetic-but-realistic shape. The threshold is set at **70%** so
  the gate fails loudly if a change ever starts leaking bodies or stops capping.

## vs Bash grep

The eval measures the *response-shaping* win (raw index → capped list). Against pasting `grep`/`rg`
output into context, the saving is typically **larger** still, because grep returns the full text of
every matching line (and matches by text, so it returns more lines — comments, strings, unrelated
identifiers). vs-token-safer returns one `file:line` per semantic hit, capped.

## Live numbers

clangd / Roslyn live runs on real projects are tracked in the
[Status & TODO](#) wiki and will be added here once the live-verification pass (P2) lands. Until then
the mock-LSP eval is the committed, reproducible figure. Keep all benchmark inputs **synthetic** — no
real paths, symbols, or project identifiers (see [CONTRIBUTING.md](CONTRIBUTING.md)).
