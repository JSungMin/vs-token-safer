# vs-token-safer · gamedev-log-analyzer

**English** · [한국어](README.ko.md)

[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-7C3AED)](https://code.claude.com/docs/en/plugins)
[![MCP](https://img.shields.io/badge/MCP-server-1f6feb)](https://modelcontextprotocol.io)
[![release](https://img.shields.io/github/v/release/JSungMin/vs-token-safer)](https://github.com/JSungMin/vs-token-safer/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/JSungMin/vs-token-safer/pulls)
[![Stars](https://img.shields.io/github/stars/JSungMin/vs-token-safer?style=social)](https://github.com/JSungMin/vs-token-safer/stargazers)

> Two Claude Code plugins for large Unreal C++, Visual Studio, and .NET projects. Search the codebase
> through an official language server's index (clangd / Roslyn) instead of `grep`, and read tens-of-MB
> editor logs without dumping them into the conversation. Both cost about 99% fewer tokens than the
> naive approach. **Local-only. No IDE required.**

### What it looks like
```text
# Claude tries to grep code → the hook REWRITES it to the indexed query, in place:
$ grep -rn "SpawnActor" Source/**/*.cpp
↻ [vs-token-safer] Rerouted → search_symbol "SpawnActor"   # semantic, not a text match
  func SpawnActor (in AGameMode)   @ Source/GameMode.cpp:142   (+2 more)
  → ~120 tokens   (grep would have dumped thousands of lines)
# No dead end: the search still runs, just through the index. VTS_REWRITE=0 to block instead.

# A 1 MB editor log → parsed, deduped, classified (bundled gamedev-log-analyzer):
▶ /gamedev-log-analyzer:logs
  41,233 lines · 7 errors · 312 warnings
  ERROR   [LogStreaming] Failed to load asset <addr>         (×128)   @ AssetManager.cpp:210
  WARNING [LogPhysics]   Penetration depth <n> exceeds limit (×4,051) @ MyComponent.cpp:88
  → ~130 tokens   (raw log ≈ 267,000)
```
<sub>Illustrative output with public Unreal Engine symbols.</sub>

### Sound familiar?
- `grep` on a giant Unreal C++ or .NET repo floods the context. Searching clangd/Roslyn's index instead stays token-capped, around 97–99% smaller ([benchmarks](#performance-measured)).
- A 50 MB editor log is unreadable as-is. Parse it, dedupe it, classify it, and you're down to a few hundred tokens.
- Claude keeps reaching for `grep` on code. The hook doesn't just block it — it **rewrites the command to the indexed query in place**, so the search still runs and the flow never breaks.
- You can't tell how much grep is still slipping through. `vts discover` reads your recent sessions and shows exactly which searches bypassed the index and what they cost.
- Unlike an IDE-proxy approach, the language server runs headlessly. No editor needs to be open.

### Contents
- [Marketplace — two plugins](#marketplace--two-plugins) · [Combined savings](#combined-token-savings-measured) · [Using both together](#using-both-together)
- [What it does](#what-it-does) · [Performance](#performance-measured) · [Pre-warming & hit-rate](#pre-warming--hit-rate)
- [Prerequisites](#prerequisites) · [Install](#install) · [Setup](#setup--configuration-command) · [Updating](#updating-to-a-new-version)
- [Configuration](#configuration-env) · [Troubleshooting](#troubleshooting) · [Status / caveats](#status--caveats) · [Contributing](#contributing) · [Releases](https://github.com/JSungMin/vs-token-safer/releases)

---

A Claude Code plugin that routes symbol search, find-references, and go-to-definition through an
official language server's index instead of Bash `grep`: **clangd** (LLVM) for C/C++, a Roslyn-based
LSP (`Microsoft.CodeAnalysis.LanguageServer`, the engine Visual Studio and the C# Dev Kit use) for
C#/.NET, **typescript-language-server** (tsserver) for JS/TS, and **pyright** for Python. Hover, file
outline, and a project-wide rename go through the same index. It caps the tokens a search flood can spend
by returning a compact `file:line` list, never source bodies. It's built for large Unreal C++ and .NET/C#
codebases, where `grep` is slow and burns context — and the JS/Python backends let it search its own
source, so we dogfood the plugin while building it.

It's the IDE-agnostic sibling of
[rider-mcp-enforcer](https://github.com/JSungMin/rider-mcp-enforcer). Same token-efficiency goal, but
instead of proxying a running IDE's MCP server, it spawns the official language server headlessly, so it
works with Visual Studio or any C++/C# project without an editor open.

## Marketplace — two plugins

This repo is a Claude Code plugin marketplace. It holds two plugins built around the same goal: reading
big things without paying for all of it in tokens.

| Plugin | Does | Needs |
| --- | --- | --- |
| **vs-token-safer** (this page) | Force code search through clangd/Roslyn/tsserver/pyright's index over Bash grep (hard-block by default, escape hatch opt-out), token-capped to `file:line` | Node + a language server: clangd / Roslyn (you install), JS/TS + Python (auto-installed). No IDE. |
| **[gamedev-log-analyzer](gamedev-log-analyzer/README.md)** | Parse/dedup/classify huge Unreal/Unity/Godot/MSVC-UBT-MSBuild logs (CLI-first), search + diff + locate + extract scalars | Node only (no IDE) |

One-step install: `vs-token-safer` declares `gamedev-log-analyzer` as a dependency, so installing it
pulls in both. Each server's `npm install` runs on the first session, so you don't set anything up by
hand:
```bash
/plugin marketplace add JSungMin/vs-token-safer
/plugin install vs-token-safer@vs-token-safer        # also auto-installs gamedev-log-analyzer
/reload-plugins                                       # first run auto-installs deps for both
```
Want only the log analyzer? Install it alone: `/plugin install gamedev-log-analyzer@vs-token-safer`.

### Combined token savings (measured)
| Task | Bash / raw | Plugin | Reduction |
| --- | ---: | ---: | ---: |
| Symbol search on a real UE5 repo (`FGameplayTag`) | ~282,194 tok | ~2,048 tok | **~99.3% (~138×)** |
| Raw index response → capped list (eval, 1,000 symbols) | ~57,308 tok | ~1,515 tok | **~97.4%** |
| Read a ~1 MB editor log (`summary`) | ~267,000 tok | ~130 tok | **~99.95%** |

### Using both together
The log analyzer emits `file:line` for each entry; vs-token-safer turns a `file:line` into the actual
symbol/source. A typical loop:
1. `/gamedev-log-analyzer:logs` → find the error/warning and its `file:line`.
2. Hand that location to vs-token-safer's `goto_definition` / `find_references` (or `search_symbol`) to
   open and understand the code, without ever grepping or dumping the raw log.

The handoff also runs in reverse: if a code search (a vs-search tool, or a Bash/Grep search) is aimed at a
log — a `Logs/` dir or a `.log`/`.jsonl` file — vs-token-safer points you back at gamedev-log instead of
returning an empty result from the code index. The language-server index covers source, not logs.

## What it does

clangd and Roslyn already do semantic symbol/reference analysis on their own. What this plugin adds on
top is enforcement, a token cap, and a headless spawn plus warm-up, so Claude actually uses the index
instead of grep:

| Layer | File | Effect |
| --- | --- | --- |
| **Rewrite/enforcement hook** | `hooks/block-code-grep.js` | Intercepts Bash `grep`/`rg`/`ack`/`ag`/`findstr`/`git grep` and `find -name` over source files (`.c/.cc/.cpp/.h/.hpp/.cs/.ts/.py`…, or `src/`, `source/`, `engine/`, `plugins/`) and — when the command is a single safe segment — **rewrites it to the equivalent `vts` query in place** (an identifier goes to semantic `search_symbol`, a literal to `search_text`, a `find -name` to `find_files`). The model's flow is unbroken and the output is always token-capped. Anything ambiguous (a pipeline, a non-literal pattern) falls back to a hard block. It's surgical: it only fires when a search tool is the actual executable of a segment, and lets raw-text searches (logs, `.md`, `.json`, config, build dirs) through untouched. `VTS_REWRITE=0` → block instead of rewrite; `excludeCommands` opts a command out; `VTS_ENFORCE=0` disables it. |
| **Routing skill** | `skills/vs-search/SKILL.md` | Rules that bias Claude toward the indexed tools first: symbol/reference/definition lookups go to `search_symbol` / `find_references` / `goto_definition`, and grep is a last resort. |
| **Token-capping core** | `server/core.js` | `runTool()` shared by both adapters: turns LSP results into `kind name (in container) @ file:line`, caps at `maxResults`, appends a `… N more` footer. Never ranges, kinds, or source bodies. A truncated `find_files`/`search_text` writes the full set to a recovery (tee) file so nothing is silently dropped. |
| **Savings + discover** | `server/core.js` | A local ledger records every search's tokens-saved (with a 30-day graph, daily/history, and an estimated value via `vts savings`). `vts discover` scans your recent Claude sessions for code searches that *bypassed* the index and reports the tokens they cost — so you can see the catch-rate, not just the wins. |
| **Headless LSP client** | `server/lsp.js` + `server/backends/index.js` | A minimal, fully-owned LSP client (JSON-RPC 2.0, `Content-Length` framing) that spawns the official engine over stdio, plus the spawn configs, `pickBackend(root)` autodetect, and the IDE-style pre-warm (`afterInit`). |

> **Engine = official, glue = ours.** clangd (LLVM) and Roslyn (Microsoft) do the analysis; this repo
> only writes the LSP↔MCP glue. No third-party MCP server runs over your source.

> **It gets better the more you use it.** The pieces compose into a feedback loop: the rewrite sends a
> bare identifier to the *semantic* `search_symbol` (not just a text grep), `vts discover --learn` feeds
> the files your past searches actually hit into the warm-up set so the next session pre-loads them, and
> `discover` reports a catch-rate so you know what's still slipping through. Each session leaves the index
> warmer and the enforcement tighter.

### Commands & tools
- `/vs-token-safer:setup` — configure the plugin (see [Setup](#setup--configuration-command)).
- `/vs-token-safer:savings` — show cumulative token savings.
- MCP tools (server `vs-search`): `search_symbol`, `find_references`, `goto_definition`, `hover`,
  `document_symbols`, `rename`, `find_files`, `search_text`, `vts_warmup`, `vts_setup`, `vts_config`,
  `vts_savings`, `vts_savings_reset`, `vts_discover`. `find_files` and `search_text` are the token-capped
  stand-ins for `find -name` and `grep` when you genuinely need a filename or raw text rather than a
  symbol. `rename` is a semantic, project-wide rename: preview by default, `apply=true` to write the edits.
  `vts_discover` finds code searches that bypassed the index (missed savings; `learn=true` feeds their
  result files into the warm-up set).
- CLI (`vts`): `symbol`, `references`, `definition`, `hover`, `symbols`, `rename`, `files`, `text`,
  `warmup`, `setup`, `config`, `savings` (`--graph`/`--daily`/`--history`), `savings-reset`, `discover`
  (`--since N`/`--all`/`--learn`).
- Or hand a whole "where is X / what calls Y / find file W" lookup to the `code-locator` subagent. It
  does the searching in its own context and gives you back only the `file:line` table.

```
$ vts symbol --q SpawnActor --projectPath ./MyGame
3 symbol(s) matching "SpawnActor" (backend: clangd, root: ./MyGame):
func SpawnActor (in AGameMode)  @ MyGame/Source/GameMode.cpp:142
method SpawnActorDeferred (in UWorld)  @ MyGame/Source/World.cpp:88
func SpawnActorFromClass  @ MyGame/Source/SpawnLib.cpp:31

✓ Saved ~4,200 tokens here (96.8% / 31× smaller than the raw index response).
```

## Performance (measured)

A real A/B on a large Unreal Engine 5 project: finding one public engine symbol (`FGameplayTag`) via
Bash grep-and-paste vs this plugin. No project source is reproduced, only aggregate counts. See
[BENCHMARK.md](BENCHMARK.md) for method.

| | Bash grep-and-paste (whole repo) | **Plugin (clangd index, capped)** |
| --- | ---: | ---: |
| What the model receives | 5,654 lines / 1,010 files | 47 semantic decls (`file:line`) |
| Tokens to the model | ~282,194 | **~2,048** |

- **Tokens: ~99.3% fewer (~138×).** grep returns the full text of every matching line, and it matches by
  text so it returns more of them (comments, strings, unrelated identifiers). The plugin returns one
  `file:line` per semantic hit, capped.
- The mock-LSP eval (`node eval/run.mjs`, no toolchain) gates the response-shaping win on every commit:
  raw index `~57,308 tok` → capped output `~1,515 tok` = **97.4%** (34/34 checks).

### Accuracy difference (and why)
This is a precision/recall trade-off, not a case of one being more correct than the other:
- **Recall:** the plugin returns the top `N` (cap), not every textual occurrence. The withheld tail is
  mostly comments, includes, and substring noise. Need an exhaustive list? Raise `maxResults`, or use
  grep.
- **Precision:** grep matches every substring (a `Foo` query also hits `FooBar`), so it over-reports
  heavily. The index returns distinct semantic declarations: `search_symbol` is a symbol-index query,
  and `find_references`/`goto_definition` resolve the symbol at a position rather than a text match.

> So for navigation (a definition plus representative usages) the plugin is both more accurate and far
> cheaper. For an exhaustive occurrence audit, raise the cap or fall back to grep on purpose.

## Pre-warming & hit-rate

clangd indexes asynchronously, so the *first* search after the server starts pays a one-time warm-up: it
indexes the engine headers. vs-token-safer handles this like an IDE.

- **The MCP server pre-warms at boot** (`VTS_PREWARM`, on by default when `projectPath` is set). By the
  time you run your first search the index is already warming, and the client is cached for the server's
  lifetime, so you pay the warm-up once per session rather than per query (later searches are
  sub-second).
- **`vts warmup`** builds clangd's on-disk index (`.cache/clangd`) up front, for CLI/CI use.
- **`VTS_CLANGD_REMOTE`** points clangd at a shared/prebuilt clangd-index-server, for near-zero
  per-developer warm-up (teams/CI query one prebuilt index).

Which files get warmed first matters. clangd boosts the indexing priority of files you open, so vts
orders the warm-up set likely-query-first: **query history** (files that answered past searches), then
**what you're editing now** (`git status` modified/untracked + Perforce `p4 opened`), then **git-log
recency**, then **include centrality** (headers that many candidates `#include`, computed adaptively via
a persistent include-graph cache that fills a time budget's worth each warm-up, growing coverage over
runs), then mtime. On a huge tree you can only warm a small slice (hundreds of TUs out of tens of
thousands in Unreal), so this ordering is what makes the warm window actually contain what you search
for. Works with both git and Perforce.

Measured lift (`node eval/bench-hitrate.mjs`, the real `orderForWarm()` over a synthetic workload with
realistic locality, 2,000 files):

| warm-up cap | arbitrary order | history-ordered | lift |
| --- | --- | --- | --- |
| 3% of files | 1.5% | **54.3%** | **36×** |
| 5% | 7.8% | **56.5%** | 7.3× |
| 10% | 11.3% | **62.5%** | 5.6× |
| 20% | 24.8% | **68.5%** | 2.8× |
| 50% | 46.3% | **80.5%** | 1.7× |

The smaller the slice you can afford to warm, the bigger the win. Arbitrary order hits almost nothing;
ordering hits the majority.

## How much did it save? (token-savings command)

For each search, the core records the tokens it saved vs forwarding the language server's raw index
response. Check the running total any of these ways:

- **In Claude Code:** run `/vs-token-safer:savings` (or just ask "how much has the plugin saved?"). It
  calls the `vts_savings` MCP tool.
- **From a shell:** `vts savings`
- **Reset:** call the `vts_savings_reset` tool (or `vts savings-reset`).

Example output:
```
vs-token-safer savings (local, 1 search(es))
  total saved: ~4,200 tokens vs forwarding raw index responses
  raw → output: 4,340 → 140 tok (~31× smaller)
  biggest single run: 4,340 → 140 tok
  est. value: ~$0.01 (@ $3/Mtok — rough, set VTS_USD_PER_MTOK)
```
`vts savings --graph` adds a 30-day ASCII chart of saved tokens; `--daily` and `--history` break it down
by day and by recent run. That's the *caught* side. For the *missed* side, `vts discover` scans your
recent Claude sessions for code searches that went around the index and reports what they cost — together
they give a catch-rate, not just a feel-good total:
```
$ vts discover --since 7
vs-token-safer discover — missed token savings (local scan, last 7 day(s), 9 transcript(s))
  314 code search(es) bypassed vts (Grep×261, grep×43, find×9, findstr×1)
  raw tool output ingested: ~129,052 tok — routed through vts most of this is avoidable
  catch-rate: ~681,036 tok caught (via vts) vs ~129,052 still bypassing → 84.1% routed through vts
```
> "Saved" here is vs the language server's *raw* index response. Savings vs Bash grep are typically far
> larger; see [BENCHMARK.md](BENCHMARK.md). `discover` is local and read-only — it reads transcript
> metadata and tool I/O sizes, never ships any of it anywhere.

## Prerequisites

- **Node.js ≥ 18** on PATH.
- A language server for the language(s) you search:
  - **C/C++ → clangd ≥ 22** ([clangd releases](https://github.com/clangd/clangd/releases)). The clangd
    19.1.x bundled with Visual Studio (`…/VC/Tools/Llvm/bin/clangd.exe`) deadlocks indexing real
    Unreal translation units in server mode, and vts warns if it detects an older one. Needs a
    `compile_commands.json` compile database.
  - **C#/.NET → a Roslyn LSP.** Install the VS Code C# extension (`ms-dotnettools.csharp`) and vts
    auto-detects `Microsoft.CodeAnalysis.LanguageServer` and its private .NET runtime from the bundle.
    Fallback: `dotnet tool install --global csharp-ls`. Needs a `.sln`/`.csproj`.
  - **JS/TS → typescript-language-server, Python → pyright.** These ship as plugin dependencies and
    install automatically on the first session — nothing to set up. vts launches the bundled copy with
    `node`, so there's no global install or PATH dance. Point `VTS_TS_CMD`/`VTS_PY_CMD` at your own if you
    prefer. (Heads-up: bundling them adds a one-time ~50 MB to the plugin's first-run `npm install`, and
    the JS/TS server wants **Node 20+** — on Node 18 it's skipped and the other backends still work.)
- No IDE has to be running.

clangd needs a compile database (`compile_commands.json`):
- **Unreal Engine:** generate via UBT, `<UE>/Engine/Build/BatchFiles/RunUBT … -mode=GenerateClangDatabase`.
  If your targets build with clang-cl, add **`-Compiler=VisualCpp`**, otherwise
  `GenerateClangDatabase` fails clang-toolchain validation (`Unable to find valid C++ toolchain for
  Clang x64`). The MSVC-compiler database still resolves the full engine include graph for clangd.
- **CMake:** configure with `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`.

## Install

```bash
# 1) Add the marketplace and install (also auto-installs gamedev-log-analyzer)
/plugin marketplace add JSungMin/vs-token-safer
/plugin install vs-token-safer@vs-token-safer
/reload-plugins        # first run auto-installs the server deps (no manual npm)

# 2) Configure it — from inside Claude Code, just run:
/vs-token-safer:setup
#   It detects the backend, asks for the project path, and writes the config.
```

Verify the `vs-search` MCP server and its tools appear, and that a `grep src/**/*.cpp` is blocked with a
nudge toward the indexed tools (or runs freely under `VTS_ENFORCE=0`). The MCP server's one dependency
(`@modelcontextprotocol/sdk`) installs automatically on the first session, into the plugin's data
directory.

### As a standalone CLI (no IDE, no Claude Code)

vs-token-safer isn't published to npm, so install the `vts` CLI from a clone:

```bash
git clone https://github.com/JSungMin/vs-token-safer
cd vs-token-safer/server && npm install && npm link   # provides `vts`
# or run directly, no link:
node /path/to/vs-token-safer/server/cli.js symbol --q SpawnActor --projectPath /path/to/proj
```

## Setup / configuration command

You don't edit OS environment variables. Settings live in a config file
(`~/.vs-token-safer/config.json`) the CLI and MCP server read at startup. Configure it any of these ways:

- **In Claude Code (recommended):** `/vs-token-safer:setup` is guided. It shows current settings
  (`vts_config`), detects the backend, asks for `projectPath`, and applies via the `vts_setup` tool.
  Then `/reload-plugins`.
- **Ad-hoc via tools:** ask Claude to call `vts_setup { "projectPath": "…", "backend": "clangd" }`, or
  `vts_config` to show effective settings.
- **From a shell:**
  ```bash
  vts setup --projectPath <root> --backend clangd
  vts config
  ```

Backend auto-detects from the root: `compile_commands.json` (or a `.uproject`) picks **clangd**; a
`.sln`/`.csproj` picks **roslyn**. Settings are read at startup, so **run `/reload-plugins` after
changing them**. Precedence: **environment variable (`VTS_*`) > config file > built-in default**, so a
same-named env var still wins.

## Updating to a new version

Claude Code caches the marketplace repo, so new commits are **not** auto-fetched. To pull a newer
version of this plugin:

```bash
# 1) Refresh the cached marketplace catalog
/plugin marketplace update vs-token-safer

# 2) Update the installed plugin (or uninstall + install to be sure)
/plugin update vs-token-safer
#   fallback: /plugin uninstall vs-token-safer  then  /plugin install vs-token-safer@vs-token-safer

# 3) Reload so the new hook/command/MCP server take effect (deps auto-reinstall on session start)
/reload-plugins        # or restart Claude Code
```

Check what's installed with `/plugin` (it lists each plugin's version). If a command like
`/vs-token-safer:setup` is missing, your installed copy predates it, so update as above.

> Maintainer note: the `version` field in `.claude-plugin/plugin.json` (and the marketplace entry) gates
> updates, so bump it when you want clients to pick up changes. The headline plugin must bump even when
> the change lands only in the bundled `gamedev-log-analyzer` (which keeps its own independent semver),
> otherwise clients see "already at latest". Version history lives in
> [Releases](https://github.com/JSungMin/vs-token-safer/releases) (auto-generated on each `v*` tag), not
> in this README.

## Configuration (env)

Precedence: **environment variable (`VTS_*`) > `~/.vs-token-safer/config.json` > default.**

| Config key | Env var | Default | Meaning |
| --- | --- | --- | --- |
| `projectPath` | `VTS_PROJECT_PATH` | cwd | Project root (where the compile DB / `.sln` lives). |
| `backend` | `VTS_BACKEND` | auto | `clangd` \| `roslyn` (auto-detected from the root). |
| `maxResults` | `VTS_MAX_RESULTS` | `60` | Cap on returned `file:line` locations. |
| — | `VTS_CLANGD_CMD` / `VTS_CLANGD_ARGS` | `clangd` | Override the clangd executable / args. |
| — | `VTS_ROSLYN_DLL` | auto | Path to a specific `Microsoft.CodeAnalysis.LanguageServer.dll`. |
| — | `VTS_ROSLYN_CMD` / `VTS_ROSLYN_ARGS` | auto (MS engine) → `csharp-ls` | Override the C# LSP executable / args. |
| — | `VTS_TS_CMD` / `VTS_TS_ARGS` | bundled `typescript-language-server` | Override the JS/TS LSP executable / args. |
| — | `VTS_PY_CMD` / `VTS_PY_ARGS` | bundled `pyright-langserver` | Override the Python LSP executable / args. |
| — | `VTS_TS_OPEN_CAP` / `VTS_PY_OPEN_CAP` | `60` | Max files the JS/TS / Python warm-up opens to prime the server. |
| — | `VTS_LSP_TIMEOUT_MS` | `30000` | Per-request LSP timeout. Raise for a cold, large (e.g. UE) index. |
| — | `VTS_LSP_INDEX_WAIT_MS` | `120000` | How long the clangd warm-up waits for background-index completion before the first query. |
| — | `VTS_CLANGD_OPEN_CAP` | `100` | Max files the warm-up opens to prime clangd's index. |
| — | `VTS_PREWARM` | on (if `projectPath` set) | MCP server pre-warms the index at boot (IDE-style); set `0` to disable. |
| — | `VTS_PREWARM_HOOK` | `0` | SessionStart hook also pre-warms via a detached `vts warmup` (opt-in; mainly CLI/non-MCP). |
| — | `VTS_PREWARM_BACKENDS` | auto | Which backends to pre-warm. `auto` = the single detected/dominant one; `all` = every language present in the repo (each warmed in proportion to its file count); or a comma list like `clangd,typescript`. |
| — | `VTS_WARM_CAP_RATIO` | `0.1` | Adaptive warm-up: open ~this fraction of a language's files (so a bigger language warms more), clamped to `[per-backend base, VTS_WARM_CAP_MAX]`. An explicit `VTS_*_OPEN_CAP` overrides it. |
| — | `VTS_WARM_CAP_MAX` | `300` | Upper bound on the adaptive per-backend warm-up open-cap. |
| — | `VTS_CLANGD_REMOTE` | — | Address of a shared/prebuilt clangd index server (`--remote-index-address`); near-zero per-dev warmup. |
| — | `VTS_QUERY_HISTORY` | `~/.vs-token-safer/query-history.json` | Where the query-history ledger lives (used to order the warm-up set likely-query-first). |
| — | `VTS_CENTRALITY_MAX` | `20000` | Upper bound on candidates the centrality scan iterates; `0` disables centrality entirely. |
| — | `VTS_CENTRALITY_BUDGET_MS` | `400` | Per-warm-up budget for *new* include-prefix reads. Centrality is adaptive: each warm-up scans a budget's worth of new/changed files into a persistent include-graph cache (`VTS_INCLUDE_GRAPH`), so coverage grows across warm-ups (`0` = cache only). |
| — | `VTS_ENFORCE` | `1` | `0`/`false`/`off` lets Bash code-grep through (escape hatch when the language server is unavailable). |
| — | `VTS_REWRITE` | `1` | `0` makes the hook block a code-grep instead of rewriting it to a `vts` query. |
| — | `VTS_EXCLUDE_COMMANDS` | — | Comma list of executables to exempt from rewrite/block (e.g. `rg,find`). Also `excludeCommands` in config.json. |
| — | `VTS_TEE` | `truncate` | `truncate` writes the full result of a capped `find_files`/`search_text` to a recovery file; `off` disables it. Dir: `VTS_TEE_DIR`. |
| — | `VTS_USD_PER_MTOK` | `3` | $/Mtok rate for the estimated-value line in `vts savings` / `discover`. Informational only. |
| — | `VTS_CLAUDE_PROJECTS` | `~/.claude/projects` | Where `vts discover` looks for transcripts to scan. |

## How enforcement works

- The **hook** runs before every Bash call. If the command is a code search (grep/rg/ack/ag/findstr/
  `git grep` or `find -name` targeting a code extension — `*.c/.cc/.cpp/.h/.hpp/.cs/.ts/.tsx/.js/.jsx/
  .mjs/.cjs/.py` — or `src|source|engine|plugins/`) and is *not* aimed at a log/md/json/build path, it
  **rewrites the command to the equivalent `vts` query** (semantic `symbol` for an identifier, `text` for
  a literal, `files` for `find -name`) so the search still runs, token-capped. If it can't build a safe
  rewrite (a pipeline, a pattern with shell metacharacters), it falls back to blocking. `VTS_REWRITE=0`
  forces block-only; `excludeCommands`/`VTS_EXCLUDE_COMMANDS` exempt a command; `VTS_ENFORCE=0` disables
  it entirely.
- The **skill** biases Claude toward the indexed tools proactively.
- The **core** guarantees the token cap no matter how Claude calls the tool, and tees the full result of a
  truncated `find_files`/`search_text` so nothing is silently dropped.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `/vs-token-safer:setup` not in autocomplete | Plugin not installed (only marketplace added), or stale | `/plugin install vs-token-safer@vs-token-safer` → `/reload-plugins`. Check version with `/plugin`. |
| First clangd query is very slow or times out | Cold UE-scale index; clangd is indexing engine headers | Pre-warm (`VTS_PREWARM` on, or run `vts warmup`); raise `VTS_LSP_TIMEOUT_MS` / `VTS_LSP_INDEX_WAIT_MS`. Keep the MCP server running so the index stays warm. |
| clangd query never returns (hangs) on a real UE project | The clangd 19.1.x bundled with Visual Studio **deadlocks** on UE TUs | Install **clangd ≥ 22** and point `VTS_CLANGD_CMD` at it. vts prints a version advisory when it detects an old clangd. |
| `GenerateClangDatabase` fails: "Unable to find valid C++ toolchain for Clang x64" | Targets build with clang-cl; UBT validates a Clang toolchain | Add **`-Compiler=VisualCpp`** to the UBT command; the MSVC database still resolves the include graph. |
| clangd resolves only header-free symbols | Compile DB has no include dirs → system/3rd-party headers don't resolve | Use a UBT-generated DB (it includes the paths); a hand-rolled `compile_commands.json` must list the include dirs. |
| No C# results / "No backend resolved" | Roslyn engine not found | Install the VS Code C# extension (`ms-dotnettools.csharp`), or `dotnet tool install --global csharp-ls`; or set `VTS_ROSLYN_DLL` / `VTS_ROSLYN_CMD`. |
| No JS/TS or Python results | The bundled LSP didn't install (offline first run, npm failure) | Re-run the session so deps reinstall, or set `VTS_TS_CMD` / `VTS_PY_CMD` at a `typescript-language-server` / `pyright-langserver` on PATH. |
| Code search blocked when you wanted plain grep | The hook is steering you to the index | Set `VTS_ENFORCE=0` to let grep through (e.g. when the language server is unavailable). |
| Wrong backend picked | Multiple project files under the root | Pin it: `VTS_BACKEND=clangd` (or `roslyn`), or pass `backend` per call. |

## Status / caveats

- **clangd live-verified.** `search_symbol` / `find_references` / `goto_definition` confirmed against
  real clangd on a `compile_commands.json` project, including a real Unreal 5.x game project
  end-to-end (it returned the game `UCLASS` plus its `*.generated.h` symbols). Needs a correct compile
  DB (with include dirs) and **clangd ≥ 22**; older clangd deadlocks on real UE TUs.
- **Roslyn live-verified.** Confirmed against **Microsoft.CodeAnalysis.LanguageServer** (the actual VS
  engine) on a real `.csproj`. Auto-detected from the VS Code C# extension bundle, with a `csharp-ls`
  fallback.
- Cold UE-scale indexes are slow on the first query, so pre-warm or raise the LSP wait/timeout envs.
- The savings ledger and benchmark numbers are response-shaping (raw index → capped). Savings vs grep
  are larger; see [BENCHMARK.md](BENCHMARK.md).

## Permissions & safety

Everything runs locally and nothing is uploaded:

- The **hook** (`PreToolUse` on Bash) only inspects the command string to decide whether to redirect a
  code-grep to the index. It doesn't read file contents or run anything. It honors `VTS_ENFORCE=0`.
- The **language server** runs on your machine over stdio. The only outbound network call is the
  first-run `npm install` of the MCP SDK. No telemetry, no source, and no queries leave your machine; it
  writes only its config and a local token-savings ledger under `~/.vs-token-safer/`.
- **gamedev-log-analyzer** reads local log files you point it at and prints summaries.

See [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md).

## Version history

See the **[Releases](https://github.com/JSungMin/vs-token-safer/releases)** page. Every version tag
publishes categorized, PR-linked notes (🚀 Features / 🐛 Bug Fixes / 📝 Documentation / 🔧 Maintenance),
generated automatically. The badge at the top always points at the latest. Highlights so far:

- **v0.1.0** — initial vs-token-safer: clangd/Roslyn-backed `search_symbol` / `find_references` /
  `goto_definition`, token-cap core, grep-blocking hook, routing skill, MCP server + `vts` CLI.
- **v0.2.0** — clangd ≥ 22 advisory (older clangd deadlocks on UE), configurable LSP timeouts, and the
  bundled gamedev-log-analyzer marketplace plugin.
- **v0.3.0** — IDE-style pre-warm at boot + hit-rate-ordered warm-up set (git/Perforce), shared/prebuilt
  remote index (`VTS_CLANGD_REMOTE`).
- **v0.4.0** — warm-up ordering extended with working-now (`git status` / `p4 opened`) and include
  centrality; gamedev-log-analyzer 0.10.1.
- **v0.5.0** — README and community files brought up to a mature-repo standard (badges, env table,
  troubleshooting, version history).
- **v0.6.0** — adaptive include-centrality: prefix reads, a per-warm-up time budget, and a persistent
  include-graph cache that grows coverage across warm-ups instead of skipping big modules.
- **v0.7.0** — navigation parity with the Rider sibling: `hover`, `document_symbols`, `find_files`,
  `search_text`, and a context-isolated `code-locator` subagent — plus `rename`, a semantic
  project-wide rename that previews by default and only writes with `apply=true`.
- **v0.8.0** — two more backends: **JS/TS** (typescript-language-server) and **Python** (pyright), both
  shipped as plugin dependencies so they install automatically. vts now searches its own source, so we
  dogfood it while building it.
- **v0.9.0** — log-analysis steer: a code search aimed at a `Logs/` dir or a `.log`/`.jsonl` file is
  pointed at gamedev-log instead of returning an empty code-index result. The grep-block hook now also
  covers the built-in Grep tool (warn-only).
- **v0.10.0** — language-aware setup and warm-up. `vts_setup` now censuses the project's languages and
  auto-picks `prewarmBackends`; the warm-up open-cap scales to each language's file count and a
  multi-language repo can warm every backend in proportion (`VTS_PREWARM_BACKENDS`). `search_text` now
  scans JS/TS/Python (not just C/C++/C#), and `search_symbol` on tsserver/pyright falls back to a literal
  text search for a symbol the index hasn't opened. Bundled gamedev-log-analyzer → 0.10.3.
- **v0.11.0** — first-use setup nudge (if never configured, the first result and the grep-block hook point
  at `/vs-token-safer:setup`); LSP buffer freshness (a file changed on disk after warm-up is refreshed via
  `didChange`/`didClose`, not answered from a stale buffer) and fuller LSP-spec conformance (server-request
  replies, `$/cancelRequest` on timeout, declared capabilities). `scripts/sync-gamedev.mjs` keeps the
  bundled-plugin version from drifting.
- **v0.12.0** — a C++ project with no `compile_commands.json` no longer returns silent empty results:
  clangd warns how to generate the DB, `search_symbol` falls back to a literal text search, and `vts_setup`
  flags it. New `vts_gen_compile_db` builds (and optionally runs) the UBT `GenerateClangDatabase` command —
  the user's choice between full semantic clangd and lightweight no-DB mode.
- **v0.13.0** — the grep-block hook now **rewrites** a Bash code search (`grep`/`rg`/`findstr`/`git grep`/
  `find -name`) into the equivalent token-capped `vts` command instead of only blocking it, so the model's
  flow is unbroken and the output is always capped (`VTS_REWRITE=0` keeps the old block; `excludeCommands` /
  `VTS_EXCLUDE_COMMANDS` opt a command out). New `vts discover` scans recent Claude transcripts for searches
  that bypassed vts and reports the tokens they spent; `vts savings` gains a 30-day graph, daily/history
  breakdowns and an estimated value; a truncated `find_files`/`search_text` writes the full result to a
  recovery (tee) file. These compose for self-improvement: the rewrite routes a bare identifier to the
  **semantic** `search_symbol` (not just a text grep, degrading to text when no backend resolves); `vts
  discover --learn` feeds the files those bypassed searches hit into the warm-up set so prewarm front-loads
  them next time; and `discover` reports a **catch-rate** (tokens caught by vts vs still bypassing). Also:
  `document_symbols` hides outline noise (anonymous callbacks / nested locals) and truncated sweeps are
  flagged, never silently capped.

## Contributing

Issues and PRs welcome: bug reports, new backends/engines, additional language mappings, or docs.

This repo is maintained with AI-assisted review, so PRs are judged from the diff, description, and
evidence. Keep them small, clearly described, backed by evidence, and free of any proprietary data
(real paths, symbols, or project identifiers). Add an eval guard in `eval/run.mjs` for any new code
path. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

If this saved you tokens or debugging time, a star helps others find it. ⭐

## Privacy

These plugins collect no personal data and process everything locally. See [PRIVACY.md](PRIVACY.md).

## License

MIT © 2026 JSungMin
