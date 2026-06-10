# vs-token-safer

**Force Claude Code to search C++/C# code through an official language server's index — clangd (LLVM)
for C/C++, a Roslyn-based LSP for C#/.NET — instead of Bash `grep`, and token-cap the result to a
compact `file:line` list.** Faster and far fewer tokens on large Unreal C++ / .NET codebases.
**Local-only. No IDE required.** Ships as a Claude Code plugin (MCP server + hook + skill) and as a
standalone CLI (`vts`) you run from a clone.

> 🇰🇷 한국어 문서: [README.ko.md](README.ko.md)

The IDE-agnostic sibling of [rider-mcp-enforcer](https://github.com/JSungMin/rider-mcp-enforcer):
same token-efficiency goal, but instead of proxying a running IDE's MCP server, it spawns the
**official language server headlessly** — so it works with Visual Studio / any C++/C# project without
an editor open.

---

## Why

`grep`/`rg` over a big game or .NET codebase dumps **thousands of lines** into the model's context —
most of it irrelevant, and it's a raw text match (no symbol semantics). vs-token-safer instead:

- asks the **language server's index** for the symbol/references/definition (semantic, not text), and
- returns only a **token-capped `file:line` list** — never source bodies.

On a 1,000-symbol index response that's a **~97% token reduction** (see [Benchmark](#benchmark)).
A `PreToolUse` hook **blocks code-symbol `grep` in Bash** and points Claude at the indexed tools, so
the win happens automatically.

## What it looks like

```
$ vts symbol --q SpawnActor --projectPath ./MyGame
3 symbol(s) matching "SpawnActor" (backend: clangd, root: ./MyGame):
func SpawnActor (in AGameMode)  @ MyGame/Source/GameMode.cpp:142
method SpawnActorDeferred (in UWorld)  @ MyGame/Source/World.cpp:88
func SpawnActorFromClass  @ MyGame/Source/SpawnLib.cpp:31

✓ Saved ~4,200 tokens here (96.8% / 31× smaller than the raw index response).
```

---

## Install

### As a Claude Code plugin

```
/plugin marketplace add JSungMin/vs-token-safer
/plugin install vs-token-safer
/reload-plugins
```

This wires up the `vs-search` MCP server, the grep-blocking hook, and the routing skill. On first
run the MCP server installs its one dependency (`@modelcontextprotocol/sdk`) into the plugin's data
directory.

### As a standalone CLI (no IDE, no Claude Code)

Not published to npm — install from a clone:

```
git clone https://github.com/JSungMin/vs-token-safer
cd vs-token-safer/server && npm install && npm link   # provides `vts`
# or run directly, no link:
node /path/to/vs-token-safer/server/cli.js symbol --q SpawnActor --projectPath /path/to/proj
```

### Prerequisites — the language server

vs-token-safer drives an official engine; install the one(s) you need:

| Backend | Language | Engine | Install | Needs |
| --- | --- | --- | --- | --- |
| `clangd` | C/C++ | clangd (LLVM) — **use clangd ≥ 22** ([clangd releases](https://github.com/clangd/clangd/releases)); the clangd 19.1.x bundled with Visual Studio can deadlock on Unreal | [clangd releases](https://github.com/clangd/clangd/releases) or your package manager | `compile_commands.json` |
| `roslyn` | C#/.NET | **Microsoft.CodeAnalysis.LanguageServer** (the engine Visual Studio / the C# Dev Kit use), `csharp-ls` fallback | install the **VS Code C# extension** (`ms-dotnettools.csharp`) — bundles the engine + its runtime; or `dotnet tool install --global csharp-ls` | `.sln` / `.csproj` |

**clangd needs a compile database** (`compile_commands.json`):
- **Unreal Engine:** generate via UBT — `<UE>/Engine/Build/BatchFiles/RunUBT … -mode=GenerateClangDatabase`.
  - If your targets are configured to **build with clang-cl**, add **`-Compiler=VisualCpp`** — otherwise
    `GenerateClangDatabase` fails clang-toolchain validation (`Unable to find valid <ver> C++ toolchain for
    Clang x64`). The MSVC-compiler database still resolves the full engine include graph for clangd.
  - **Use clangd ≥ 22.** The clangd 19.1.x bundled with Visual Studio (`…/VC/Tools/Llvm/bin/clangd.exe`)
    **deadlocks** indexing real UE translation units in server mode (`clangd --check` parses them, but
    queries never return). Standalone clangd 22.1.6 handles the same project in seconds and returns
    symbols. Point `VTS_CLANGD_CMD` at a current clangd; vts warns if it detects an older one.
  - The database is large (a full editor target ≈ tens of thousands of entries). On a **cold** index the
    first query can be slow while clangd indexes the engine headers — see `VTS_LSP_TIMEOUT_MS` /
    `VTS_LSP_INDEX_WAIT_MS` below, or keep the MCP server running so the index stays warm.
  - **Pre-warm like an IDE:** the MCP server indexes the configured `projectPath` at boot (`VTS_PREWARM`,
    on by default) so the first search is already warm; or run **`vts warmup`** once to build clangd's
    on-disk index (`.cache/clangd`) up front. Either way you pay the warmup once, not per query.
  - **Warm-up ordering (hit-rate):** the open-set is ordered likely-query-first — by query history (files
    that answered past searches), then VCS recency (**git** `log` and **Perforce** `p4 opened`), then mtime.
    This steers clangd's per-file index priority so the warm window covers what you actually search.
  - **Shared/prebuilt index (teams/CI):** set `VTS_CLANGD_REMOTE` to a clangd-index-server address so
    everyone queries one prebuilt index — near-zero per-developer warmup.
- **CMake:** configure with `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`.

**C# uses the official Visual Studio Roslyn engine automatically.** vs-token-safer auto-detects
`Microsoft.CodeAnalysis.LanguageServer` (and the matching .NET runtime) from the VS Code C# extension
bundle, opens your `.sln`/`.csproj`, and waits for the project load before querying — no flags needed.
Point `VTS_ROSLYN_DLL` at a specific `Microsoft.CodeAnalysis.LanguageServer.dll`, or
`VTS_ROSLYN_CMD`/`VTS_ROSLYN_ARGS` at any other Roslyn LSP, to override. If neither the MS engine nor
an override is found, it falls back to `csharp-ls`.

---

## Usage

### MCP tools (server name: `vs-search`)

| Tool | Purpose | Key args |
| --- | --- | --- |
| `search_symbol` | Find symbol declarations by name/substring | `q`, `projectPath`, `backend`, `maxResults` |
| `find_references` | References/usages of the symbol at a position | `path`, `line`, `character` (0-based), `includeDeclaration` |
| `goto_definition` | Definition of the symbol at a position | `path`, `line`, `character` (0-based) |
| `vts_setup` | Persist config (`~/.vs-token-safer/config.json`) | `projectPath`, `backend`, `maxResults` |
| `vts_config` | Show effective settings | — |
| `vts_savings` / `vts_savings_reset` | Token-savings ledger | — |

### CLI (`vts`)

```
vts symbol      --q <name> --projectPath <dir> [--backend clangd|roslyn] [--maxResults N]
vts references  --path <file> --line N --character N [--includeDeclaration]
vts definition  --path <file> --line N --character N
vts setup       [--projectPath <dir>] [--backend …] [--maxResults N]
vts config
vts savings | vts savings-reset
```

Slash commands (plugin): `/vs-token-safer:setup`, `/vs-token-safer:savings`.

---

## Configuration

Precedence: **environment variable (`VTS_*`) > `~/.vs-token-safer/config.json` > default.**

| Config key | Env var | Default | Meaning |
| --- | --- | --- | --- |
| `projectPath` | `VTS_PROJECT_PATH` | cwd | Project root (where the compile DB / `.sln` lives) |
| `backend` | `VTS_BACKEND` | auto | `clangd` \| `roslyn` (auto-detected from the root) |
| `maxResults` | `VTS_MAX_RESULTS` | `60` | Cap on returned `file:line` locations |
| — | `VTS_CLANGD_CMD` / `VTS_CLANGD_ARGS` | `clangd` | Override the clangd executable / args |
| — | `VTS_LSP_TIMEOUT_MS` | `30000` | Per-request LSP timeout. Raise for a cold, large (e.g. UE) index |
| — | `VTS_LSP_INDEX_WAIT_MS` | `120000` | How long the clangd warm-up waits for background-index completion before the first query |
| — | `VTS_CLANGD_OPEN_CAP` | `100` | Max files the warm-up opens to prime clangd's index |
| — | `VTS_PREWARM` | on (if `projectPath` set) | MCP server pre-warms the index at boot (IDE-style) so the first search is warm; set `0` to disable |
| — | `VTS_PREWARM_HOOK` | `0` | SessionStart hook also pre-warms via a detached `vts warmup` (opt-in; mainly for CLI/non-MCP use) |
| — | `VTS_CLANGD_REMOTE` | — | Address of a shared/prebuilt clangd index server (`--remote-index-address`); near-zero per-dev warmup |
| — | `VTS_QUERY_HISTORY` | `~/.vs-token-safer/query-history.json` | Where the query-history ledger lives (used to order the warm-up set by likely-query-first) |
| — | `VTS_CENTRALITY_MAX` | `1500` | Max candidates for which warm-up computes include-centrality (reads files); `0` disables. Skipped on bigger sets |
| — | `VTS_ROSLYN_DLL` | auto | Path to a specific `Microsoft.CodeAnalysis.LanguageServer.dll` |
| — | `VTS_ROSLYN_CMD` / `VTS_ROSLYN_ARGS` | auto (MS engine) → `csharp-ls` | Override the C# LSP executable / args |
| — | `VTS_ENFORCE` | `1` | Set `0`/`false`/`off` to let Bash code-grep through (escape hatch) |

Backend auto-detect: `compile_commands.json` (or a `.uproject`) → **clangd**; a `.sln`/`.csproj` →
**roslyn**.

---

## The grep-blocking hook

A `PreToolUse` (Bash) hook blocks code-symbol searches — `grep`/`rg`/`ack`/`ag`/`findstr`, or
`find -name`, over source files (`.c/.cc/.cpp/.h/.hpp/.cs`, or `src/`, `source/`, `engine/`,
`plugins/`) — and tells Claude to use the indexed tools instead. It is **surgical**: it only fires
when a search tool is the actual executable of a command segment, and it lets **raw text** searches
(logs, `.md`, `.json`, config, build/intermediate dirs) through untouched. If the language server is
unavailable, set `VTS_ENFORCE=0` so grep isn't blocked.

---

## Backend support matrix

| Backend | Status | Notes |
| --- | --- | --- |
| `clangd` (C/C++) | ✅ live-verified (incl. real Unreal 5.x) | `search_symbol` / `find_references` / `goto_definition` confirmed against real clangd on a `compile_commands.json` project, **including a real Unreal 5.x game project end-to-end** (returned the game `UCLASS` + its `*.generated.h` symbols). Needs a **correct** compile DB (with include dirs — Unreal: generate via UBT, `-Compiler=VisualCpp` for clang-cl targets). **Use clangd ≥ 22** — the VS-bundled clangd 19.1.x (`…/VC/Tools/Llvm/bin/clangd.exe`) deadlocks on real UE TUs; vts warns if it detects an older one. Cold UE-scale indexes: raise `VTS_LSP_TIMEOUT_MS` / `VTS_LSP_INDEX_WAIT_MS`. |
| `roslyn` (C#/.NET) | ✅ live-verified | `search_symbol` / `find_references` / `goto_definition` confirmed against **Microsoft.CodeAnalysis.LanguageServer** (the actual VS engine) on a real `.csproj`. Auto-detected; `csharp-ls` fallback. |

---

## How it works (architecture)

```
Claude Code ──(MCP / CLI)──▶ vs-token-safer  ──(LSP over stdio)──▶ clangd / csharp-ls ──▶ your source
                              └ runTool(): token-cap LSP results → file:line, no bodies
```

- `server/lsp.js` — a minimal, fully-owned **LSP client** (JSON-RPC 2.0, `Content-Length` framing).
  The one genuinely new piece.
- `server/backends/index.js` — how to spawn each official engine + `pickBackend(root)` autodetect.
- `server/core.js` — async `runTool()` dispatch, the token-capping formatters, the savings ledger.
  Shared by both adapters so there is exactly one implementation per tool.
- `server/index.js` — the MCP server (thin adapter). `server/cli.js` — the `vts` CLI (thin adapter).

**Engine = official, glue = ours.** clangd (LLVM) and Roslyn (Microsoft) do the analysis; this repo
only writes the LSP↔MCP glue. No third-party MCP server runs over your source.

---

## Benchmark

The eval (`node eval/run.mjs`, mock LSP — no toolchain needed) gates the token win on every commit:

```
raw index ~57,308 tok → capped output ~1,515 tok      = 97.4% reduction (1,000 symbols)
```

That is the response-shaping win (raw index response → capped list). Versus pasting `grep` output
into context, the saving is typically larger still, because grep returns full matching lines.

---

## Pre-warming & hit-rate

clangd indexes asynchronously, so the *first* search after the server starts pays a one-time warm-up
(it indexes the engine headers). vts handles this like an IDE:

- **The MCP server pre-warms at boot** (`VTS_PREWARM`, on by default when `projectPath` is set) — by the
  time you run your first search the index is already warming, and the client is cached for the server's
  lifetime, so you pay the warm-up **once per session, not per query** (later searches are sub-second).
- **`vts warmup`** builds clangd's on-disk index (`.cache/clangd`) up front, for CLI/CI use.
- **`VTS_CLANGD_REMOTE`** points clangd at a shared/prebuilt index server → near-zero per-developer warm-up.

**Which files get warmed first matters.** clangd boosts the indexing priority of files you open, so vts
orders the warm-up set *likely-query-first*: **query history** (files that answered past searches) →
**what you're editing now** (`git status` modified/untracked + Perforce `p4 opened`) → **git-log recency**
→ **include centrality** (headers many candidates `#include`, bounded by `VTS_CENTRALITY_MAX`) → mtime.
On a huge tree you can only warm a small slice, so this ordering is what makes the warm window actually
contain what you search for. Works with both git and Perforce.

Measured lift (`node eval/bench-hitrate.mjs` — the real `orderForWarm()` over a synthetic workload with
realistic locality, 2,000 files):

| warm-up cap | arbitrary order | history-ordered | lift |
| --- | --- | --- | --- |
| 3% of files | 1.5% | **54.3%** | **36×** |
| 5% | 7.8% | **56.5%** | 7.3× |
| 10% | 11.3% | **62.5%** | 5.6× |
| 20% | 24.8% | **68.5%** | 2.8× |
| 50% | 46.3% | **80.5%** | 1.7× |

The smaller the slice you can afford to warm (e.g. ~hundreds of TUs out of tens of thousands in Unreal),
the bigger the win — arbitrary order hits almost nothing; ordering hits the majority.

---

## Privacy & security

**Local-only, zero transmission.** The language server runs on your machine over stdio; the only
outbound network call is the first-run `npm install` of the MCP SDK. No telemetry, no source, no
queries leave your machine. See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

## Development

```
npm install            # dev tooling at repo root (eslint, prettier)
npm test               # node eval/run.mjs → EVAL PASSED
npm run lint
cd server && npm install   # MCP server deps, then `node index.js` to start the server
```

Add an eval guard in `eval/run.mjs` for any new code path. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © JSungMin
