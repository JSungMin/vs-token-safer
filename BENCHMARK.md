# Benchmark: vs-token-safer (clangd / Roslyn index) vs Bash grep

vs-token-safer's whole point is **token efficiency**: return the answer to a code-search question as a
compact `file:line` list instead of dumping raw source (or a raw language-server index response) into
the model's context. Benchmarks here are **A/B**: the same query **without the plugin** (Arm A — raw
`grep`/`rg`, i.e. what the model receives when it greps) versus **with the plugin** (Arm B — the
clangd/Roslyn index, formatted and token-capped).

> **Run it yourself (zero API, deterministic):** `npm run bench` sweeps synthetic corpora in **three
> languages** (TypeScript, Python, Go) across sizes and prints a per-language grep-vs-vts token table + a
> per-model cost table — no API key, no spend, same numbers on any machine. The token *delta* is
> model-independent; cost = `delta × input price`. Two axes on purpose: a single corpus could be
> cherry-picked, so the same four scenarios run on a language vts has a **semantic** backend for
> (TypeScript/Python) AND one it has **no** backend for (Go → the **syntactic** tree-sitter tier), at three
> sizes each. Details, methodology, and honest caveats in [`benchmarks/README.md`](benchmarks/README.md).
> Representative: at a 150-file corpus the all-language total cuts **~87%** of search tokens (per language:
> TypeScript ~87%, Python ~83%, Go ~91%); the reduction **climbs with repo size** (grep scales with matches,
> vts stays capped). The numbers below are the large real-world UE ceiling.

> No source code, file paths, or project symbol names are reproduced here — only aggregate counts,
> sizes, and timings. The query below is a **public Unreal Engine framework symbol** (`FGameplayTag`),
> not a symbol from any private project.

## The gate (runs on every commit)

`eval/run.mjs` exercises the genuinely-new layer against a **mock language server** (no clangd / Roslyn
toolchain needed, so it runs in CI on Windows + Linux across Node 18/20/22). It asserts:

| Check | What it proves |
| --- | --- |
| LSP client handshake + `workspace/symbol` | The JSON-RPC / `Content-Length` framing client talks to a real LSP. |
| symbol → `file:line` (no bodies) | The formatter emits `kind name @ file:line` and **never** ranges/kinds/source. |
| token cap (1,000 syms → capped) | A large index response collapses to a capped list with a `… N more` footer. |
| **token reduction vs raw index ≥ 70%** | The core promise — the response is dramatically smaller. |
| references + goto wiring | `find_references` / `goto_definition` resolve and format locations. |
| `runTool` dispatch | MCP and CLI share one implementation. |
| LSP timeout / index-ready wait / clangd advisory | Cold-index handling, `$/progress` end wait, old-clangd gate. |
| prewarm + `vts_warmup` + warm ordering + centrality | The IDE-style warm-up path and its hit-rate ordering. |

Run it:

```
node eval/run.mjs
```

Representative output:

```
✓ token reduction vs raw index          97.4%   ≥ 70%
…
raw index ~57,308 tok → capped output ~1,515 tok
EVAL PASSED.
```

- **Raw index response** = the JSON the language server returns for a broad `workspace/symbol` query
  (1,000 symbols, each with name, kind, container, and a full URI + range). ~57k tokens.
- **Capped output** = what vs-token-safer hands the model: `maxResults` lines of
  `kind name (in container) @ file:line`, plus a `… N more` footer. ~1.5k tokens.
- The reduction is **~97.4%** on this synthetic-but-realistic shape. The threshold is set at **70%** so
  the gate fails loudly if a change ever starts leaking bodies or stops capping.

## Token savings (the dominant, always-on win)

Real A/B on a large **Unreal Engine 5** project, finding one public engine symbol (`FGameplayTag`):

| | Bash grep-and-paste (whole repo) | **Plugin (clangd index, capped)** |
| --- | ---: | ---: |
| What the model receives | 5,654 lines / 1,010 files | 47 semantic declarations (`file:line`) |
| Tokens to the model | **~282,194** | **~2,048** |

- vs whole-repo grep-and-paste: `~2,048` vs `~282,194` → **~99.3% fewer (~138×)**.
- The win has two sources: grep returns the **full text** of every matching line, and grep matches by
  **text**, so it returns far more lines (comments, strings, unrelated identifiers, generated headers).
  The plugin returns one `file:line` per **semantic** hit, capped at `maxResults`.

Even against a *line-capped* grep (Claude Code's built-in Grep tool truncates output at ≈250 lines), the
capped semantic list is still dramatically smaller — and every line is a real `file:line`, not raw
bytes.

## Search time — depends on scope (honest)

- vs **whole-repo** grep (the common case: Claude doesn't know where a symbol lives and scans the repo
  root, Engine included): indexed lookup beats scanning the UE Engine tree once the index is warm.
- vs a **narrow** grep over a small, known directory: ripgrep is very fast on a small scope; a cold
  clangd index pays a one-time warm-up (it indexes the engine headers) on the first query. After that,
  queries in the same session are sub-second because the client + index are cached.

vts hides the warm-up cost the way an IDE does: the MCP server **pre-warms at boot** (`VTS_PREWARM`) and
keeps the client warm for its lifetime, so you pay it **once per session, not per query**. `vts warmup`
builds the on-disk index up front, and `VTS_CLANGD_REMOTE` lets a team share one prebuilt index. See the
hit-rate table in the [README](README.md#pre-warming--hit-rate) for how the warm-up set is ordered
likely-query-first.

**Takeaway:** tokens win massively and unconditionally (~97–99%). Wall-clock wins when the scope is
large/unknown (Engine included) and the index is warm; a cold first query is the price you pay once.

## Syntactic tier (tree-sitter) vs semantic (clangd) — the graceful-degradation payoff

When clangd is **missing, cold, or still indexing**, vs-token-safer answers on the **SYNTACTIC** (tree-sitter)
tier from a committable index instead of blocking — then climbs to EXACT once clangd is warm. Measured on a
**second real Unreal Engine 5 game module** (3,143 files, 133,890 symbols — aggregate counts only; no paths or
project symbol names reproduced):

| | tree-sitter tier (SYNTACTIC) | clangd (EXACT) |
| --- | ---: | ---: |
| Locate latency | **~240 ms** | ~127 s (cold-to-first-answer) |
| Position accuracy | reference | **identical — 4/4 sampled symbols, line delta 0** |
| Index build | ~62 s one-time (133,890 symbols) | cold-index each cold session |

- **Accuracy:** across a sample of unique class/struct declarations, the tree-sitter position matched clangd's
  authoritative EXACT position **exactly** (line delta 0). For *declaration location*, the syntactic tier is as
  correct as the semantic one — it just can't resolve overloads/types, which is what the EXACT rung is for.
- **Latency:** the tree-sitter answer returns in ~240 ms; clangd's **first (cold)** answer on the same module
  took ~127 s — a **~530×** gap that clangd's semantic power does not close for a plain locate. (In a warm
  session clangd is sub-second; the point is you no longer wait for warm to get the location.)
- **Token flood, same module:** on high-usage symbols, `search_symbol` (capped declarations) vs whole-tree
  grep-and-paste (every usage) came out to **~43× fewer tokens (97.7% saved)** — grep dumps every
  comment/usage/include line; the plugin returns the capped declaration list.

This is why the ladder answers **tree-sitter-first** on a cold/large tree and climbs to EXACT once clangd is
warm: you get the same `file:line` **now**, and semantic certainty **later**.

## Accuracy difference (and why)

The two paths optimize differently — it is a **precision/recall trade**, not "one is simply correct":

| Aspect | Bash grep | clangd / Roslyn index (this plugin) |
| --- | --- | --- |
| Match basis | Literal substring | Symbol index (`search_symbol`) / position resolve (`find_references`, `goto_definition`) |
| Recall (completeness) | 100% of literal hits | **Capped at `maxResults`** — top N only |
| Precision (relevance) | Low — matches comments, includes, substrings (`Foo` also hits `FooBar`) | Higher — distinct **semantic** declarations, no substring false positives |
| Result shape | Raw lines, undeduped | `kind name (in container) @ file:line`, capped, no bodies |

**Degree of difference, measured here:** grep's 5,654 matching lines across 1,010 files collapse to 47
distinct semantic declarations from the index — grep over-reports heavily because most lines are
comments, `#include`s, generated-header references, and substring noise, not declarations.

- **Recall:** with the default cap (60), the plugin surfaces the top semantic hits, not every textual
  occurrence. If you need an exhaustive list, raise `maxResults` / `VTS_MAX_RESULTS` or use grep
  deliberately.
- **Precision:** the index never returns a substring false positive, and `goto_definition` /
  `find_references` resolve the symbol at a position — they answer "where is *this* symbol", not "what
  text looks like this".

Net: for **navigation** (jump to the definition / see representative usages), the plugin is more
accurate *and* far cheaper. For an **exhaustive audit** of every textual occurrence, raise the cap or
use grep on purpose.

# Logs: A/B (gamedev-log-analyzer)

Same A/B framing for the bundled log analyzer: **Arm A** = paste the raw editor log into context;
**Arm B** = the `gamedev-log` CLI (summary / search / locate / diff). Token ≈ bytes ÷ 4. No log lines
are reproduced — only sizes.

| Operation (Arm B) | Editor log ~1 MB (~267,000 tok raw) |
| --- | ---: |
| `summary` (severity counts + top categories) | ~130 tok · **~99.95%** fewer |
| `search` Error+ (dedup groups by callsite) | a few hundred tok · ~99.8% fewer |
| `locate` Error+ (`file:line` jump list) | ~77 tok · ~99.97% fewer |

**The win grows with log size** — raw logs scale linearly (a 1 MB log is ~267k tokens), while the
`summary` stays flat (~130 tokens) because it reports counts, not bodies. `search`/`locate` stay small
by deduping repeated lines into templated groups and capping. `diff` reads two runs and returns only
what changed, instead of pasting both logs to compare. The bundled plugin's own eval reduces a
representative log from ~117k tokens to ~77 tokens.

# Reproduce

```bash
# Code search — the committed, toolchain-free gate (mock LSP):
node eval/run.mjs           # → EVAL PASSED, 97.4% reduction

# Warm-up hit-rate (synthetic workload, real orderForWarm()):
node eval/bench-hitrate.mjs # → OK — ordering beats arbitrary at every cap

# Live A/B against your own project (counts only, never source):
#   grep side
rg -n "<Symbol>" "<project>"                     # whole repo (incl. Engine)
#   index side (clangd needs compile_commands.json; Roslyn needs a .sln/.csproj)
vts symbol --q "<Symbol>" --projectPath "<project>"

# Logs A/B (bundled gamedev-log-analyzer) — counts only, never log content:
node gamedev-log-analyzer/eval/bench-ab.mjs
```

Keep all benchmark inputs **synthetic** or **public** (Unreal Engine framework symbols) — no real
paths, symbols, or project identifiers (see [CONTRIBUTING.md](CONTRIBUTING.md)).
