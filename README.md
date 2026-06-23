# vs-token-safer

**English** · [한국어](README.ko.md)

> A token-saving code layer for Claude Code on **any** codebase — TypeScript, JavaScript, Python, C#, C++, Go, and
> more. (Battle-tested down to a 26k-translation-unit Unreal Engine monorepo; bundles a game/build-log analyzer too.)

[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-7C3AED)](https://code.claude.com/docs/en/plugins)
[![MCP](https://img.shields.io/badge/MCP-server-1f6feb)](https://modelcontextprotocol.io)
[![Glama](https://glama.ai/mcp/servers/JSungMin/vs-token-safer/badges/score.svg)](https://glama.ai/mcp/servers/JSungMin/vs-token-safer)
[![release](https://img.shields.io/github/v/release/JSungMin/vs-token-safer)](https://github.com/JSungMin/vs-token-safer/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/JSungMin/vs-token-safer/pulls)
[![Stars](https://img.shields.io/github/stars/JSungMin/vs-token-safer?style=social)](https://github.com/JSungMin/vs-token-safer/stargazers)

> Your coding agent has a small context window. Your repo is large. **vs-token-safer sits in between.**
>
> Ask where something is, what calls it, or even "how does the auth flow work?" when the name escapes you — and
> instead of pasting a wall of source into the chat, it replies with a short `file:line` list.
>
> When your project builds normally, the answers are exact: it reads the same code index your editor relies on.
> When it doesn't, it still locates your functions and classes with nothing to set up. And when you've forgotten
> the name and only remember what the code does, it finds it from the vocabulary your own code already uses — no
> AI model, nothing uploaded. Markdown and config files work the same way: jump straight to one section by its
> heading instead of opening the whole file.
>
> A companion plugin does the same for giant editor and build logs. **None of it leaves your machine.**

<p align="center">
  <img src="docs/vts-savings.png" alt="87% fewer tokens than grep — a deterministic 3-language, 150-file benchmark (47,547 grep tokens vs 6,195); ~99% on the zero-setup tree-sitter tier; ~138x on a real Unreal Engine 5 tree" width="900">
</p>

<p align="center">
  <img src="docs/vts-dashboard.gif" alt="The vs-token-safer local dashboard — the indexed repo as a live, rotating 3D graph (Three.js, served on 127.0.0.1)" width="640"><br>
  <sub>The built-in dashboard (<code>vts serve</code>) — your indexed repo as a live 3D graph, all on 127.0.0.1.</sub>
</p>

```text
# Claude tries to grep code → the hook REWRITES it to the indexed query, in place:
$ grep -rn "createSession" src/
↻ [vs-token-safer] Rerouted → search_symbol "createSession"   # semantic, not a text match
  func createSession (in AuthService)  @ src/auth/session.ts:142   (+2 more)
  → ~120 tokens   (grep would have dumped thousands of lines)

# Editing that symbol? Name it — no Read-the-whole-file, no line counting:
$ replace_symbol_body symbol="createSession" body="…"        # preview; apply=true writes
  replace_symbol_body "createSession" — PREVIEW at src/auth/session.ts:142-160
```
<sub>Same flow on TypeScript, Python, C#, C++, Go and more (clangd · Roslyn · tsserver · pyright · tree-sitter). `VTS_REWRITE=0` blocks instead of rewriting.</sub>

## Why

- `grep` on a large repo — a TypeScript/Python monorepo, a C#/.NET solution, even a 26k-TU Unreal C++ tree — floods the context. The language-server index stays token-capped — ~97–99% smaller ([benchmarks](#performance)).
- Claude keeps reaching for `grep`. The hook doesn't just block it — it **rewrites the command to the indexed query in place**, so the search still runs and the flow never breaks.
- **Edit by symbol, not by line.** Replace/insert-around/delete a declaration by *naming* it — the index supplies the span, so you skip reading the whole file into context.
- You can't tell how much grep still slips through. `vts discover` reads your recent sessions and reports exactly which searches bypassed the index and what they cost.
- The language server runs **headlessly** — no editor open, unlike an IDE-proxy approach.

## Quickstart

```bash
# 1) Install (also auto-installs the gamedev-log-analyzer sibling)
/plugin marketplace add JSungMin/vs-token-safer
/plugin install vs-token-safer@vs-token-safer
/reload-plugins        # first run auto-installs the server deps (no manual npm)

# 2) Configure — detects the backend, asks for the project path, writes the config
/vs-token-safer:setup
```

Then **restart the Claude Code session** (the `vs-search` MCP server only starts on a fresh session).
Verify the tools appear and that `grep src/**/*.cpp` is rerouted to the index. Prerequisites: **Node ≥ 18**
and a language server — clangd (C/C++) / Roslyn (C#) you install; JS/TS + Python auto-install. Details in
[Prerequisites](#prerequisites-details) below.

> Want only the log analyzer? `/plugin install gamedev-log-analyzer@vs-token-safer`.

## How it works

<p align="center">
  <img src="docs/vts-how-it-works.png" alt="vs-token-safer answers on one precision ladder: EXACT (semantic language server) → SYNTACTIC (tree-sitter, zero setup) → FUZZY (concept dictionary, no embeddings) → SECTION (docs/config by heading), and switches rungs as it learns — a fuzzy concept_search surfaces a real name, then climbs to EXACT to confirm it; every answer is capped to file:line and labeled with the rung it came from — 87% fewer tokens than grep" width="900">
</p>

vs-token-safer isn't a search box — it's a **precision ladder**. You ask where something is, what calls it,
or "how does the auth flow work?" when the name escapes you, and it answers at the highest precision it can
reach, then tells you which rung the answer came from:

- **EXACT** — you know the name and the project builds → the official language server (clangd / Roslyn /
  tsserver / pyright), the semantic ground truth.
- **SYNTACTIC** — no toolchain set up → a tree-sitter parse (36 languages, bundled, no native build) still
  returns real *declarations*, not a grep.
- **FUZZY** — you only remember what the code *does* → a concept dictionary mined from the repo's own
  identifiers + comments (no AI model, nothing uploaded).
- **SECTION** — it's a doc or config, not code → Markdown / TOML / YAML / CSS / HTML addressed by heading.

The rungs aren't a one-time pick — they connect, and vts **switches between them as it learns more**. Start
on FUZZY when you only know the intent; the moment `concept_search` surfaces a real name, vts climbs to
EXACT to confirm it against the semantic index (and an exact search that misses drops back down to FUZZY).
The hooks steer that hand-off in both directions, so "I don't know the name" turns into a precise,
semantically-verified `file:line` instead of a dead end.

Every answer comes back capped to `file:line` (never source bodies) and carries a one-line **completeness
certificate** naming the rung — so the model always knows whether it got the semantic truth or a fallback.
On a 3-language, 150-file benchmark that's **87% fewer tokens than grep** (~138× on a real Unreal Engine 5
tree). Underneath, four mechanisms make Claude actually *use* the ladder instead of reaching for grep:

| Layer | Effect |
| --- | --- |
| **Rewrite/enforcement hook** | Covers four surfaces. **Bash** grep/rg/`find -name` over source → **rewritten to the equivalent `vts` query in place** (identifier → `search_symbol`, literal → `search_text`, `find <dir> -name` → `find_files` rooted at `<dir>`); ambiguous cases (pipeline, multi-`-name`) block. **Grep tool** symbol hunt (bare identifier, `::`/`(`/`void·class` regex, or a `FooBar\|BazQux` CamelCase alternation) → **blocked** with a ready-to-use call; freeform/keyword alternations stay a warn. **Glob tool** concrete code file (`*.cpp`, `Foo.h`) → **blocked** toward `find_files`. **Edit/MultiEdit** that replaces or adds a **whole declaration** → a model-visible nudge toward the symbol-edit tools (`replace_symbol_body`/`insert_symbol`), escalating to a block on a safe insert after repeated ignores (`VTS_EDIT_WARN`, `VTS_EDIT_BLOCK_AFTER`); a sub-declaration tweak stays silent. Messages are agent-directed and i18n'd (EN/KO). Logs/`.md`/config pass through. Knobs: `VTS_REWRITE=0`, `VTS_GREP_BLOCK=0`, `VTS_ENFORCE=0`. |
| **Token-capping core** | Turns LSP results into `kind name @ file:line`, caps, appends `… N more`. A refs-heavy result collapses to one row per file (`Foo.cpp:42,88,120`) with a shared dir prefix factored out once (`VTS_COMPACT_RESULTS=0` restores per-line). A truncated `find_files`/`search_text` tees the full set to a recovery file. |
| **Symbol-level editing** | `replace_symbol_body`/`insert_*`/`safe_delete` resolve a declaration by name via the outline and splice text at its exact span — preview by default, `apply=true` writes, `safe_delete` refuses while referenced. No whole-file Read into context. |
| **Headless LSP client** | A fully-owned LSP client spawns the official engine over stdio. The project root is resolved **per call** (explicit `projectPath` → the file's enclosing project → the MCP workspace root), so one global server answers for **every repo a session touches**. Live backends are pooled and bounded (`VTS_MAX_BACKENDS` + idle reaper). |
| **Savings + discover** | A local ledger records every search's tokens-saved (`vts savings`, with a 30-day graph). `vts discover` scans recent sessions for searches that *bypassed* the index — so you see the catch-rate, not just the wins. |

> **Engine = official, glue = ours.** clangd (LLVM) and Roslyn (Microsoft) do the analysis; this repo
> only writes the LSP↔MCP glue. No third-party MCP server runs over your source. Local-only, nothing uploaded.

## Tools

All search/edit goes through an official language-server index — **clangd** (C/C++), **Roslyn** (C#/.NET),
**tsserver** (JS/TS), **pyright** (Python) — and comes back as a compact, capped `file:line` list (never
source bodies). MCP server `vs-search`; same tools as the `vts` CLI.

**Search / navigate**

| Tool | CLI | Does |
| --- | --- | --- |
| `search_symbol` | `vts symbol` | Find a symbol declaration by name/substring (semantic, not text). |
| `find_references` | `vts references` | Every call site of a symbol. Takes the **name directly** (`symbol="FooBar"`) — the one to reach for when you change a function/type and must touch every use. `detail=file`/`dir` → a **blast-radius summary** (dependents grouped + ranked) instead of the per-line list. `direction=callers`/`callees` switches to a **multi-hop call hierarchy** (who *transitively* calls this = blast radius / what it calls) to `depth` hops — built on LSP `callHierarchy`, the semantic call graph, not a text scan. `vts trace-calls` = shorthand for `references --direction callers`. |
| `read_symbol` | `vts read-symbol` | Return the **source of one named declaration** (its span) — not the whole file. The read-side twin of `replace_symbol_body`: skip Read-ing a 700-line file to see one function. `signatureOnly` trims to the head. |
| `goto_definition` | `vts definition` | Jump to the definition at a position. `kind=` also does `type_definition` / `implementation` (concrete impls of an interface/virtual) / `declaration`. |
| `hover` | `vts hover` | Type/signature at a position. |
| `document_symbols` | `vts symbols` | Outline a file (classes/functions/types as `file:line`). `scope=directory` → a **signatures-only repo skeleton** of every code file under a dir (the shape of a module without Reading each file). |
| `diagnostics` | `vts diagnostics` | Compiler/linter errors + warnings as a token-capped `file:line:col severity: message` list — the compact stand-in for reading raw build output. One file by default; `scope=directory` scans the project. |
| `find_files` | `vts files` | Find files by name/glob — token-capped stand-in for `find -name`. |
| `search_text` | `vts text` | Raw text/regex search — capped stand-in for `grep` (`path=`/`glob=`/`docs=true` to target). |
| `concept_search` | `vts concept` | **Fuzzy** search for a concept you can't name (`"auth login flow"`) — mines a dictionary from the repo's own identifier+comment co-occurrence (no embeddings, nothing sent) and ranks declarations; `--flow` traces the top hit's call graph. |

**Edit (symbol-level — name it, don't line-count)** — preview by default, `apply=true` writes.

| Tool | CLI | Does |
| --- | --- | --- |
| `rename` | `vts rename` | Semantic project-wide rename (every reference, not a text sed). |
| `replace_symbol_body` | `vts replace-symbol` | Replace a whole declaration (signature + body) by name — the index supplies the span. |
| `insert_symbol` | `vts insert` | Insert text next to a declaration — `position=after` (default, e.g. a sibling method) or `before` (e.g. an import/attribute). |
| `safe_delete` | `vts safe-delete` | Delete a declaration — **refuses while it's still referenced** unless `force=true`. |

> **Docs & config too (structure tier).** Point any of `document_symbols` / `read_symbol` / `replace_symbol_body` / `insert_symbol` / `safe_delete` at a **Markdown / AsciiDoc / reST / TOML / INI / YAML / JSON / text** file and the "symbol" is a **section** (heading, `[section]`, or key): outline a 2000-line `CLAUDE.md` in ~30 lines, read or replace one `## Section` by name without Reading the whole file. No language server, no new tools — same token-safer move, for documents.

**Admin / meta — one MCP tool `vts_admin {op, params}`** (folded to keep the per-session tool-definition
cost small; the CLI keeps the bare subcommands):

| `op` | CLI | Does |
| --- | --- | --- |
| `git` / `p4` | `vts git` / `vts p4` | Run a read-only `git status/log/diff` or Perforce `opened/status/changes/reconcile`, output grouped/deduped/capped. Mutating subcommands refused. |
| `setup` / `config` | `vts setup` / `vts config` | Configure / show settings (projectPath, backend, maxResults, clangdCmd, genCompileDb). |
| `savings` / `savings_reset` | `vts savings` | Token-savings ledger (graph/daily/history) / clear it. |
| `warmup` | `vts warmup` | Pre-build the language-server index. |
| `discover` | `vts discover` | Find code searches that bypassed vts (missed savings). |
| `gen_compile_db` | `vts gen-compile-db` | Generate the Unreal clangd compile DB (UBT). |

e.g. `vts_admin {op:"git", params:{argv:["status","-s"]}}`. Or hand a whole "where is X / what calls Y /
find file W" lookup to the **`code-locator` subagent** — it searches in its own context and returns only
the `file:line` table.

**Dashboard — `vts serve`.** A local, interactive view of what vts knows + how much it saved: the
savings trend, language mix, per-tool savings, and an **interactive 3D graph** (WebGL / Three.js) with two
modes — the **include graph** (files sized by include fan-in) and an **on-demand call graph** (type a symbol
→ its transitive callers/callees, traced live through LSP `callHierarchy` — no persistent index; shows
**call counts** per node/edge). Nodes are laid out on a **spherical shell** (so they spread out, not clump);
drag/`WASD` to orbit, wheel/`+`-`-` to zoom, `R` to fit, hover for `file:line`. Symbol search has **live
autocomplete** (`/symbols`); **color by** connected-component **groups** · **repo** (which repository each
node is from, with a legend) · **heat**; **click a node to drill into its group** (`Esc`/`Backspace` to pop
out); a **focus/maximize** toggle, a highlight filter, and a node/edge metrics overlay.

Easiest via the slash commands: **`/vs-token-safer:viz`** (open) and **`/vs-token-safer:viz-stop`** (close).
Or the CLI:

```bash
vts serve --open     # → http://127.0.0.1:8731/  (launches the browser; --port N to change)
vts serve --stop     # stop it (or Ctrl-C the process)
```

It's **127.0.0.1-only and serves a fully self-contained page** — CSS/JS inlined and **Three.js vendored
locally** (`server/vendor/`, served same-origin, never a CDN), so nothing leaves the machine; it renders
with the network unplugged. Same trust model as the rest of vts. Built on Node's stdlib `http` (no
web-framework dependency), and it runs **only when you invoke it** — the MCP server never starts it, so the
steady-state package stays a thin stdio client. The 3D graph caps at `VTS_VIZ_MAX_NODES` (200) for smoothness.

```
$ vts symbol --q createSession --projectPath ./app
3 symbol(s) matching "createSession" (backend: typescript, root: ./app):
func createSession (in AuthService)  @ app/src/auth/session.ts:142
method createSessionToken (in TokenStore)  @ app/src/auth/token.ts:88
func createSessionCookie  @ app/src/http/cookies.ts:31

✓ Saved ~4,200 tokens here (96.8% / 31× smaller than the raw index response).
```

## The two plugins

| Plugin | Does | Needs |
| --- | --- | --- |
| **vs-token-safer** (this page) | Force code search/edit through the clangd/Roslyn/tsserver/pyright index over Bash grep, token-capped to `file:line` | Node + a language server (clangd / Roslyn you install; JS/TS + Python auto). No IDE. |
| **[gamedev-log-analyzer](gamedev-log-analyzer/README.md)** | Parse/dedup/classify huge Unreal/Unity/Godot/MSVC-UBT logs, search + diff + extract scalars | Node only |

`vs-token-safer` declares `gamedev-log-analyzer` as a dependency, so one install pulls in both. **Used
together:** the log analyzer emits `file:line` per entry → hand it to `goto_definition`/`find_references`
to open the code, without grepping or dumping the raw log. The handoff runs in reverse too — a code search
aimed at a log (`Logs/`, `.log`/`.jsonl`) points you back at gamedev-log instead of an empty result.

| Combined savings (measured) | Bash / raw | Plugin | Reduction |
| --- | ---: | ---: | ---: |
| Symbol search on a real UE5 repo (`FGameplayTag`) | ~282,194 tok | ~2,048 tok | **~99.3% (~138×)** |
| Raw index response → capped list (eval, 1,000 symbols) | ~57,308 tok | ~1,549 tok | **~97.3%** |
| Read a ~1 MB editor log (`summary`) | ~267,000 tok | ~130 tok | **~99.95%** |

## Performance

A real A/B on a large Unreal Engine 5 project: finding one public engine symbol (`FGameplayTag`) via Bash
grep-and-paste vs this plugin. No project source is reproduced, only aggregate counts; see
[BENCHMARK.md](BENCHMARK.md).

| | Bash grep-and-paste (whole repo) | **Plugin (clangd index, capped)** |
| --- | ---: | ---: |
| What the model receives | 5,654 lines / 1,010 files | 47 semantic decls (`file:line`) |
| Tokens to the model | ~282,194 | **~2,048** |

**~99.3% fewer (~138×).** grep returns the full text of every matching line and matches by text (comments,
strings, unrelated identifiers); the plugin returns one `file:line` per semantic hit, capped. The mock-LSP
eval (`node eval/run.mjs`, no toolchain) gates this on every commit: `~57,308 → ~1,549 tok` = **97.3%**
(53/53 checks).

<details>
<summary><b>Accuracy: precision/recall trade-off</b></summary>

- **Recall:** the plugin returns the top `N` (cap), not every textual occurrence — the withheld tail is mostly comments/includes/substring noise. Need exhaustive? Raise `maxResults`, or use grep.
- **Precision:** grep matches every substring (`Foo` also hits `FooBar`); the index returns distinct semantic declarations.

So for navigation (a definition plus representative usages) the plugin is both more accurate and far
cheaper. For an exhaustive occurrence audit, raise the cap or fall back to grep on purpose.
</details>

<details>
<summary><b>Pre-warming &amp; hit-rate</b></summary>

clangd indexes asynchronously, so the *first* search pays a one-time warm-up. vts handles this like an IDE:
the MCP server **pre-warms at boot** (`VTS_PREWARM`, on when `projectPath` is set) and keeps the client
cached for the session, so you pay it once. `vts warmup` builds the on-disk index up front (CLI/CI), and
`VTS_CLANGD_REMOTE` points clangd at a shared prebuilt index server.

Ordering matters: clangd boosts the priority of files you open, so vts warms **query-history-first**, then
what you're editing now (`git status` / `p4 opened`), then git-log recency, then include-centrality, then
mtime. On a huge tree you can only warm a small slice, so this is what makes the warm window contain what
you search for. Measured lift (`node eval/bench-hitrate.mjs`, 2,000 files):

| warm-up cap | arbitrary order | history-ordered | lift |
| --- | --- | --- | --- |
| 3% of files | 1.5% | **54.3%** | **36×** |
| 5% | 7.8% | **56.5%** | 7.3× |
| 10% | 11.3% | **62.5%** | 5.6× |
| 20% | 24.8% | **68.5%** | 2.8× |
| 50% | 46.3% | **80.5%** | 1.7× |

The smaller the slice you can afford to warm, the bigger the win.
</details>

<details>
<summary><b>Big trees: scope &amp; pre-index (cold-start)</b></summary>

On a huge monorepo (e.g. a full Unreal Engine source tree, ~26k translation units) the cold index is the
one real cost. Two opt-in levers cut it — both stay local, nothing is transmitted:

**1. Scope — index a subtree, not the whole tree.** See what you'd scope, then set it:

```bash
vts scope --projectPath /path/to/UE        # shows current scope, kept/total TUs, and top-level dirs to pick
vts setup --scope "TSGame,Plugins"         # persist it (or set VTS_SCOPE="TSGame,Plugins"); then reload/restart
```

clangd then indexes only the in-scope translation units (live UE5: `TSGame` → 3,377 of 26,488 TUs, **13%**),
and every backend's warm-up is scoped with it. No scope set = whole-tree behavior, unchanged.

**2. Pre-index — build the index ahead of the first query.**

```bash
vts preindex --projectPath /path/to/UE     # honors the scope above
```

With the **full LLVM release** installed (it bundles `clangd-indexer` next to `clangd`), this builds a
monolithic static index offline and clangd loads it via `--index-file` — a local file, no server — so the
first query is instant instead of waiting on the lazy background crawl. Without `clangd-indexer` it falls
back to a warm pass (and tells you to install full LLVM). Override the binary with `VTS_CLANGD_INDEXER_CMD`.

**3. Zero-setup tier — works before any toolchain, on any repo.** No compile DB, no language server, no
wait? vts still answers `search_symbol` from a **tree-sitter** parse (an official standard parser, 36
languages, bundled as wasm — no native build) — real *declarations*, not a usage grep, in the same
token-capped `file:line` shape. Make it instant and shareable by committing an index:

```bash
vts index --projectPath /path/to/repo      # writes .vts-index/symbols.jsonl (commit it!)
vts index --status                          # show the current committed index
```

`.vts-index/symbols.jsonl` is plain, git-committable, and portable — commit it so teammates (and your own
cold starts) get instant symbol search with zero setup. A language server, once it indexes, automatically
supersedes it (the syntactic tier locates decls; the LSP adds reference/overload/type resolution on top).
Benchmark (150-file symbol search): grep `4917` → tree-sitter `53` tokens = **98.9%**, no toolchain.

**Do existing users need to re-run setup?** For default (whole-tree) behavior, **no** — just update the
plugin and `/reload-plugins`. You only run `vts setup --scope …` (once) if you want to *opt into* scoping;
the `clangd-indexer` path needs no vts setup at all (it's auto-detected — you just need full LLVM installed).
</details>

<details>
<summary><b>Savings &amp; discover (catch-rate)</b></summary>

Each search records the tokens it saved vs forwarding the raw index response. Check it with
`/vs-token-safer:savings`, `vts savings` (`--graph`/`--daily`/`--history`), or reset via `vts savings-reset`.

```
vs-token-safer savings (local, 1 search(es))
  total saved: ~4,200 tokens vs forwarding raw index responses
  raw → output: 4,340 → 140 tok (~31× smaller)
  est. value: ~$0.01 (@ $3/Mtok — set VTS_USD_PER_MTOK)
```

That's the *caught* side. `vts discover` scans recent sessions for searches that went **around** the index:

```
$ vts discover --since 1
  86 code search(es) bypassed vts (Grep×48, Glob×18, grep×12, find×8)
  catch-rate: ~770,333 tok caught (via vts) vs ~28,692 still bypassing → 96.4% routed through vts
```

(Searches the hook *blocked* don't count as bypasses.) `discover` is local and read-only — it reads
transcript metadata and tool I/O sizes, never ships any of it anywhere. `--learn` feeds the files past
searches hit into the warm-up set, so each session leaves the index warmer.
</details>

## Prerequisites (details)

<details>
<summary><b>Language servers &amp; the compile database</b></summary>

- **Node.js ≥ 18** on PATH.
- **C/C++ → clangd ≥ 22** ([releases](https://github.com/clangd/clangd/releases)). The clangd 19.1.x bundled with Visual Studio **deadlocks** indexing real Unreal TUs in server mode; vts warns on an older one. Needs a `compile_commands.json`. Prefer the **full LLVM release** — it bundles `clangd-indexer` alongside `clangd`, which `vts preindex` uses for an instant static index (see *Big trees: scope &amp; pre-index*).
- **C#/.NET → a Roslyn LSP.** Install the VS Code C# extension (`ms-dotnettools.csharp`) — vts auto-detects `Microsoft.CodeAnalysis.LanguageServer` and its runtime from the bundle. Fallback: `dotnet tool install --global csharp-ls`. Needs a `.sln`/`.csproj`.
- **JS/TS → typescript-language-server, Python → pyright.** Ship as plugin deps, install automatically on the first session (one-time ~50 MB; JS/TS wants Node 20+, skipped on 18).
- **Mixed repo?** A query that targets a file uses that file's own language backend — a `.py`/`.ts` inside a C++/C# (clangd/roslyn-rooted) tree gets pyright/typescript automatically, so vts works in a UE tree with a Python tooling dir without a manual `backend=`. This even **overrides a pinned `backend` / `VTS_BACKEND`** when they conflict: one global server serves every repo you touch, so a `backend:"clangd"` set for a C++ project never sends another repo's `.js`/`.cs`/`.py` to clangd (which would answer `-32001 invalid AST`). A query with no file target (e.g. `search_symbol` by name) keeps the pinned backend.

**clangd needs a compile database:**
- **Unreal:** `<UE>/Engine/Build/BatchFiles/RunUBT … -mode=GenerateClangDatabase`. If targets build with clang-cl, add **`-Compiler=VisualCpp`** or it fails clang-toolchain validation.
- **CMake:** `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`.

**No compile DB yet?** You still get answers — `search_symbol` falls back to a bounded literal text
search, labeled as such, and the first result carries a one-time advisory. The one-command fix:
`vts_admin {op:"gen_compile_db"}` (CLI `vts gen-compile-db`) assembles the exact UBT command (finds the `.uproject`,
derives the `<Name>Editor` target, locates the engine, adds `-Compiler=VisualCpp`). **Dry-run by default**;
`apply=true` runs UBT and parks the DB **outside the source tree** (`~/.vs-token-safer/db/<project>`, with
clangd's `.cache/` next to it, so git/`p4 reconcile` never see an artifact). `inTree=true` keeps the
classic project-root layout, protected by a VCS-ignore guard.
</details>

<details>
<summary><b>Standalone CLI (no IDE, no Claude Code)</b></summary>

Not published to npm — install `vts` from a clone:

```bash
git clone https://github.com/JSungMin/vs-token-safer
cd vs-token-safer/server && npm install && npm link   # provides `vts`
# or run directly: node /path/to/vs-token-safer/server/cli.js symbol --q SpawnActor --projectPath /path/to/proj
```
</details>

## Configuration

<details>
<summary><b>Setup command &amp; updating</b></summary>

Settings live in `~/.vs-token-safer/config.json` (read at startup — `/reload-plugins` after changes).
Configure via `/vs-token-safer:setup` (guided), `vts_admin {op:"setup"}` / `{op:"config"}`, or `vts setup
--projectPath <root> --backend clangd`. Backend auto-detects from the root. Precedence: **env (`VTS_*`) >
config file > default.**

**Updating:** Claude Code caches the marketplace, so new commits aren't auto-fetched:
```bash
/plugin marketplace update vs-token-safer
/plugin update vs-token-safer
/reload-plugins
# then RESTART the session — REQUIRED.
```
> ⚠️ A new version only takes full effect after a **session restart**. `/reload-plugins` updates
> hooks/commands/skills, but the running `vs-search` MCP server serves the old tool code until you quit
> and reopen. Version history: [Releases](https://github.com/JSungMin/vs-token-safer/releases).
</details>

<details>
<summary><b>All environment variables</b></summary>

Precedence: **`VTS_*` env > `~/.vs-token-safer/config.json` > default.**

| Config key | Env var | Default | Meaning |
| --- | --- | --- | --- |
| `projectPath` | `VTS_PROJECT_PATH` | cwd | Project root (where the compile DB / `.sln` lives). |
| `backend` | `VTS_BACKEND` | auto | `clangd` \| `roslyn` \| `typescript` \| `pyright`. |
| `maxResults` | `VTS_MAX_RESULTS` | `60` | Cap on returned `file:line` locations. |
| — | `VTS_COMPACT_RESULTS` | `1` | `0` restores one-location-per-line output. |
| — | `VTS_MAX_BACKENDS` | `2` | Max concurrently-live language servers (LRU-evict past the cap). |
| — | `VTS_BACKEND_IDLE_MS` | `300000` | Idle language server shut down after this (`0` = off). |
| `clangdCmd` | `VTS_CLANGD_CMD` / `VTS_CLANGD_ARGS` | `clangd` | clangd executable (persist via `vts setup --clangdCmd <path>` — VS-bundled 19.1.x deadlocks UE, use ≥ 22) / args. |
| — | `VTS_ROSLYN_DLL` | auto | Path to a specific `Microsoft.CodeAnalysis.LanguageServer.dll`. |
| — | `VTS_ROSLYN_CMD` / `VTS_ROSLYN_ARGS` | auto → `csharp-ls` | Override the C# LSP. |
| — | `VTS_TS_CMD` / `VTS_PY_CMD` (+ `_ARGS`) | bundled | Override the JS/TS / Python LSP. |
| — | `VTS_TS_OPEN_CAP` / `VTS_PY_OPEN_CAP` | `60` | Files the JS/TS / Python warm-up opens. |
| — | `VTS_LSP_TIMEOUT_MS` | `30000` | Per-request LSP timeout. Raise for a cold, large index. |
| — | `VTS_LSP_INDEX_WAIT_MS` | `120000` | How long the clangd warm-up waits for background-index completion. |
| — | `VTS_CLANGD_OPEN_CAP` | `100` | Files the cold warm-up opens to prime clangd. |
| — | `VTS_CLANGD_WARM_CAP_PERSISTED` | `8` | Open cap when a persisted `.cache/clangd` index exists. |
| — | `VTS_CLANGD_PERSISTED_WAIT_MS` | `60000` | Cap on how long a query polls a still-loading persisted index. |
| — | `VTS_CLANGD_PERSISTED_FLOOR_MS` | `3000` | Brief floor before the first query starts polling. |
| — | `VTS_CLANGD_INDEX_PRIORITY` | `normal` | clangd background-index priority (`background` = idle-CPU-only). |
| — | `VTS_CLANGD_JOBS` | `cores-1` | clangd async/index workers (`-j`). |
| — | `VTS_PREWARM` | on (if `projectPath`) | MCP server pre-warms at boot; `0` disables. |
| — | `VTS_PREWARM_BACKENDS` | auto | `auto` / `all` / comma list — which backends to pre-warm. |
| — | `VTS_WARM_CAP_RATIO` / `VTS_WARM_CAP_MAX` | `0.1` / `300` | Adaptive warm-up open-cap (fraction of a language's files, clamped). |
| — | `VTS_CLANGD_REMOTE` | — | Address of a shared/prebuilt clangd index server. |
| — | `VTS_QUERY_HISTORY` / `VTS_INCLUDE_GRAPH` | `~/.vs-token-safer/…` | Warm-up ordering caches. |
| — | `VTS_CENTRALITY_MAX` / `VTS_CENTRALITY_BUDGET_MS` | `20000` / `400` | Include-centrality scan bounds (`0` disables / cache-only). |
| — | `VTS_ENFORCE` | `1` | `0` lets Bash code-grep through (escape hatch). |
| — | `VTS_REWRITE` | `1` | `0` makes the hook block a Bash code-grep instead of rewriting it. |
| — | `VTS_GREP_BLOCK` | `1` | `0` reverts the **Grep/Glob tool** escalation from block to warn-only. |
| — | `VTS_EDIT_STEER` | `1` | `0` hides the one-line hint (on a focused `search_symbol`/`goto_definition` result) pointing at the symbol-edit tools. `VTS_EDIT_STEER_MAX` (`10`) caps the result size that gets it. |
| — | `VTS_EDIT_WARN` | `1` | `0` silences the model-visible nudge when a built-in Edit/MultiEdit replaces or adds a **whole declaration** (it points at `replace_symbol_body` / `insert_symbol`). Sub-declaration tweaks are never nudged. |
| — | `VTS_TEXT_STEER` | `1` | `0` hides the one-line hint appended to a `search_text` result whose query is really a **symbol/class usage hunt** (a `Foo<Bar>` template arg, `::` scope, or CamelCase/snake identifier) — it points at `find_references` / `search_symbol`, which are semantic and **complete** (no 4s time-box). Fires only when the scan was truncated or the query carries a `<>`/`::` cue. |
| — | `VTS_EDIT_BLOCK_AFTER` | `0` (off) | **Opt-in.** Set ≥1 to escalate the warn to a one-time **block** on a safe insert after that many consecutive ignored nudges (then it resets — fire-once, not a wall). Default off: a persistent block trapped the agent (it fought the wall with Edit retries instead of switching). A replace always stays a warn; `VTS_GREP_BLOCK=0` also holds it to warn. |
| — | `VTS_EXCLUDE_COMMANDS` | — | Comma list of executables to exempt (also `excludeCommands` in config). |
| — | `VTS_COMPACT_VCS` | `1` | `0` stops rerouting read-only `git`/`p4` to the compacted wrapper. |
| `lang` | `VTS_LANG` | auto | Hook message language: `ko` / `en` (auto-detects from OS locale). |
| — | `VTS_TEE` / `VTS_TEE_DIR` | `truncate` | Recovery file for a capped `find_files`/`search_text` result. |
| — | `VTS_USD_PER_MTOK` | `3` | $/Mtok rate for the estimated-value line (informational). |
| `starMin` | `VTS_STAR_MIN` | `50000` | Cumulative-saving threshold (tokens) past which `vts savings` appends a one-line ⭐ pointer. |
| — | `VTS_STAR_NUDGE` | `1` | `0` hides the ⭐ line. Shown ONLY in the manual `vts savings` report (never in the search/edit flow); pure, **no network / no star-status check**. |
| — | `VTS_SAVINGS_GRAPH` | `1` | `vts savings` shows the 30-day graph by default; `0` (or `graph:false`) omits it for a terse report. |
| — | `VTS_P4_EDIT` | `1` | A symbol-edit / `rename` **apply** auto-runs `p4 edit` on a read-only (Perforce) file before writing — symbol edits write via the server, bypassing any built-in Edit/Write p4 hook. Only fires on read-only files (a writable/git repo never invokes p4); `0` disables. |
| — | `VTS_P4_CMD` | `p4` | Perforce CLI used for the auto-checkout above (`VTS_P4_TIMEOUT_MS`, default 15000, caps it). |
| — | `VTS_INDEX_ADVISORY` | `1` | On an EMPTY clangd result, append a why-advisory: the file isn't in `compile_commands.json`, or the background index is only N% built. `0` silences it. |
| — | `VTS_CLAUDE_PROJECTS` | `~/.claude/projects` | Where `vts discover` looks for transcripts. |
| — | `VTS_DB_DIR` | `~/.vs-token-safer/db` | Out-of-tree home for generated compile DBs. |
</details>

<details>
<summary><b>Troubleshooting</b></summary>

| Symptom | Cause | Fix |
| --- | --- | --- |
| `/vs-token-safer:setup` not in autocomplete | Plugin not installed (only marketplace added), or stale | `/plugin install vs-token-safer@vs-token-safer` → `/reload-plugins`. |
| First clangd query very slow | Per-spawn clangd cost on a UE-scale tree (cold index, or re-validating a persisted one) | Keep the **MCP server** running so clangd spawns once. Tune `VTS_CLANGD_PERSISTED_WAIT_MS` / `VTS_LSP_INDEX_WAIT_MS`. |
| clangd query never returns (hangs) on UE | clangd 19.1.x bundled with VS **deadlocks** on UE TUs | Install **clangd ≥ 22**, point `VTS_CLANGD_CMD` at it. |
| `GenerateClangDatabase` fails: "Unable to find valid C++ toolchain for Clang x64" | Targets build with clang-cl | Add **`-Compiler=VisualCpp`** to the UBT command. |
| clangd resolves only header-free symbols | Compile DB has no include dirs | Use a UBT-generated DB (it includes the paths). |
| No C# results / "No backend resolved" | Roslyn engine not found | Install the VS Code C# extension, or `csharp-ls`; or set `VTS_ROSLYN_DLL` / `VTS_ROSLYN_CMD`. |
| No JS/TS or Python results | Bundled LSP didn't install (offline first run) | Re-run the session, or set `VTS_TS_CMD` / `VTS_PY_CMD`. |
| Code search blocked when you wanted plain grep | The hook is steering you to the index | `VTS_ENFORCE=0` lets grep through. |
| Wrong backend picked | Multiple project files under the root | Pin `VTS_BACKEND=clangd` (or pass `backend` per call). |
| `-32001 invalid AST` / nothing on a non-C++ file | A `backend` pinned for a C++ repo was reaching another repo's `.js`/`.cs`/`.py` | Fixed in 0.28.4 — the file's own backend now wins on conflict; update the plugin (`/plugin marketplace update`). |
| clangd finds nothing on a symbol you KNOW exists | The compile DB doesn't cover that module, OR the background index isn't built yet (vts prints which — see `VTS_INDEX_ADVISORY`) | If "not in compile_commands.json": build the editor target + regenerate the DB. If "index N% complete": keep the server warm so indexing finishes, or scope the DB to your game modules (a 26k-TU full-engine DB indexes slowly — exclude `Engine/` for ~8× faster, complete coverage). |
</details>

## Status &amp; safety

- **clangd & Roslyn live-verified** — `search_symbol`/`find_references`/`goto_definition` confirmed against real clangd (incl. a real Unreal 5.x game project end-to-end) and **Microsoft.CodeAnalysis.LanguageServer**. Needs clangd ≥ 22 and a correct compile DB.
- **Local-only, nothing uploaded.** The hook only inspects the command string (honors `VTS_ENFORCE=0`); the language server runs over stdio; the only outbound call is the first-run `npm install` of the MCP SDK. It writes only its config + a local savings ledger under `~/.vs-token-safer/`. See [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md).
- Savings/benchmark numbers are response-shaping (raw index → capped); savings vs grep are larger ([BENCHMARK.md](BENCHMARK.md)).

## Contributing

Issues and PRs welcome — bug reports, new backends/engines, language mappings, docs. Keep PRs small,
evidence-backed, and free of proprietary data (real paths/symbols/project IDs); add an `eval/run.mjs` guard
for any new code path. See [CONTRIBUTING.md](CONTRIBUTING.md). If this saved you tokens, a star helps
others find it. ⭐

## Acknowledgments

vs-token-safer stands on ideas from the open-source code-intelligence community. With gratitude to:

- **[codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)** (DeusData) — the tree-sitter
  `tags.scm` call-site approach, the multi-hop call-hierarchy (`trace_path`) shape, and content-hash-keyed
  caching. _Our difference:_ we keep the **official language server** as the semantic source of truth and use
  tree-sitter only as a zero-setup syntactic tier **below** it — no reimplemented type-resolution layer, no
  persistent semantic DB; everything stays local and nothing is transmitted.
- **Codeix** (montanetech) — the idea of a plain, git-committable JSONL symbol index. _Our difference:_ ours
  is a cold-start accelerator that a language server automatically supersedes once it has indexed.
- **Code Context Engine** (elara-labs) — the token-savings framing for AI code search. _Our difference:_ no
  embeddings/vectors (so no nearest-but-wrong retrieval) — exact `file:line`, token-capped.
- **[Serena](https://github.com/oraios/serena)** — symbol-level editing (`replace_symbol_body` /
  `insert_symbol` / `safe_delete`), here layered on the LSP with preview-by-default.
- The **tree-sitter** project and **tree-sitter-wasms** for the prebuilt grammars that power the syntactic tier.

Each of these made vs-token-safer better. Thank you. (Reuse here always keeps our charter: official engines do
the analysis, output is token-capped `file:line`, and nothing leaves your machine.)

## References & related work

The design choices here have academic backing, and the field is moving fast. The companion papers carry the
full treatment — `paper/vs-token-safer.tex` and the fuzzy-retrieval follow-up `paper/fuzzy-concept-dictionary.tex`.
Key references:

**Foundations we build on**

- **HyperAgent** — Phan et al., [arXiv:2409.16299](https://arxiv.org/abs/2409.16299). Generalist software-engineering agents; motivates giving the model structured tools instead of raw grep.
- **Codebase-Memory: Tree-Sitter Knowledge Graphs for LLM Code Exploration via MCP** — [arXiv:2603.27277](https://arxiv.org/abs/2603.27277). The closest sibling. _Our difference:_ official-LSP ground truth + capped `file:line`, no persistent semantic DB, nothing transmitted.
- **Dead-code lineage** — Rapid Type Analysis (Bacon & Sweeney, OOPSLA'96) and demand-driven reachability (the Go `deadcode` model) underpin `vts dce`'s preview-only call-graph reachability.

**Related & subsequent work (2024–2026)** — two of these are now **migrated into vs-token-safer** (marked _Migrated_).

- **LARGER: Lexically Anchored Repository Graph Exploration and Retrieval** — Hu et al., [arXiv:2605.16352](https://arxiv.org/abs/2605.16352). Formalizes "lexical anchor → structural expansion" — the academic shape of our fuzzy→climb-to-exact ladder, also without embeddings. _Migrated_ → `concept_search` now expands the import-graph neighbourhood **only from high-confidence lexical anchors** (a neighbour lifts a symbol only if its own match clears a fraction of the strongest one; `VTS_CONCEPT_ANCHOR_MIN`), so a weak/cross-cutting neighbour can't drag its imports up the ranking.
- **Rethinking Agentic Search with Pi-Serini: Is Lexical Retrieval Sufficient?** — Hsu, Yang & Lin, [arXiv:2605.10848](https://arxiv.org/abs/2605.10848). Empirical case that lexical retrieval suffices inside the agent loop — backing for our no-embeddings charter.
- **One Tool Is Enough: RL for Repository-Level LLM Agents (RepoNavigator)** — Zhang et al., [arXiv:2512.20957](https://arxiv.org/abs/2512.20957). A single jump-to-definition tool, RL-trained, beats large multi-tool agents — a strong recent endorsement of LSP navigation over grep.
- **DCE-LLM: Dead Code Elimination with Large Language Models** — [arXiv:2506.11076](https://arxiv.org/abs/2506.11076). LLM-judged dead code. _Our difference:_ `vts dce` stays preview-only static reachability — deterministic, no model judgment, with `safe_delete` as the disposal backstop.
- **cAST: Structural Chunking via Abstract Syntax Tree** — Zhang et al., [arXiv:2506.15655](https://arxiv.org/abs/2506.15655). Tree-sitter chunking for code RAG — the neighbor of our SYNTACTIC tier. _Migrated_ → `read_symbol` now cuts an over-budget body at a **whole-child AST boundary** (the end of a complete member/statement), **never mid-statement**, so the returned source stays syntactically whole (falls back to the plain line cap when tree-sitter is absent).
- **RepoGraph** ([arXiv:2410.14684](https://arxiv.org/abs/2410.14684)) and **LocAgent** ([arXiv:2503.09089](https://arxiv.org/abs/2503.09089)) — repository code-graph localization; we reach the same call/dependency structure via live LSP call-hierarchy, with no prebuilt graph and no embeddings.

## License

MIT © 2026 JSungMin
