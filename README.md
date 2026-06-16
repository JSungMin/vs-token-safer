# vs-token-safer · gamedev-log-analyzer

**English** · [한국어](README.ko.md)

[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-7C3AED)](https://code.claude.com/docs/en/plugins)
[![MCP](https://img.shields.io/badge/MCP-server-1f6feb)](https://modelcontextprotocol.io)
[![release](https://img.shields.io/github/v/release/JSungMin/vs-token-safer)](https://github.com/JSungMin/vs-token-safer/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/JSungMin/vs-token-safer/pulls)
[![Stars](https://img.shields.io/github/stars/JSungMin/vs-token-safer?style=social)](https://github.com/JSungMin/vs-token-safer/stargazers)

> **Search and edit a large Unreal C++ / Visual Studio / .NET codebase through an official language
> server's index (clangd / Roslyn / tsserver / pyright) instead of `grep` — token-capped to `file:line`,
> never source bodies.** Plus a sibling plugin that reads tens-of-MB editor logs without dumping them into
> the conversation. Both cost ~99% fewer tokens than the naive approach. **Local-only. No IDE required.**

```text
# Claude tries to grep code → the hook REWRITES it to the indexed query, in place:
$ grep -rn "SpawnActor" Source/**/*.cpp
↻ [vs-token-safer] Rerouted → search_symbol "SpawnActor"      # semantic, not a text match
  func SpawnActor (in AGameMode)   @ Source/GameMode.cpp:142   (+2 more)
  → ~120 tokens   (grep would have dumped thousands of lines)

# Editing that symbol? Name it — no Read-the-whole-file, no line counting:
$ replace_symbol_body symbol="SpawnActor" body="…"           # preview; apply=true writes
  replace_symbol_body "SpawnActor" — PREVIEW at Source/GameMode.cpp:142-160
```
<sub>Illustrative output with public Unreal Engine symbols. `VTS_REWRITE=0` blocks instead of rewriting.</sub>

## Why

- `grep` on a giant Unreal C++ / .NET repo floods the context. The clangd/Roslyn index stays token-capped — ~97–99% smaller ([benchmarks](#performance)).
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

## Tools

All search/edit goes through an official language-server index — **clangd** (C/C++), **Roslyn** (C#/.NET),
**tsserver** (JS/TS), **pyright** (Python) — and comes back as a compact, capped `file:line` list (never
source bodies). MCP server `vs-search`; same tools as the `vts` CLI.

**Search / navigate**

| Tool | CLI | Does |
| --- | --- | --- |
| `search_symbol` | `vts symbol` | Find a symbol declaration by name/substring (semantic, not text). |
| `find_references` | `vts references` | Every call site of a symbol. Takes the **name directly** (`symbol="FooBar"`) — the one to reach for when you change a function/type and must touch every use. |
| `goto_definition` | `vts definition` | Definition of the symbol at a position. |
| `hover` | `vts hover` | Type/signature at a position. |
| `document_symbols` | `vts symbols` | Outline a file (classes/functions/types as `file:line`). |
| `find_files` | `vts files` | Find files by name/glob — token-capped stand-in for `find -name`. |
| `search_text` | `vts text` | Raw text/regex search — capped stand-in for `grep` (`path=`/`glob=`/`docs=true` to target). |

**Edit (symbol-level — name it, don't line-count)** — preview by default, `apply=true` writes.

| Tool | CLI | Does |
| --- | --- | --- |
| `rename` | `vts rename` | Semantic project-wide rename (every reference, not a text sed). |
| `replace_symbol_body` | `vts replace-symbol` | Replace a whole declaration (signature + body) by name — the index supplies the span. |
| `insert_after_symbol` | `vts insert-after` | Insert text after a declaration (e.g. add a sibling method). |
| `insert_before_symbol` | `vts insert-before` | Insert text before a declaration (e.g. an import/attribute). |
| `safe_delete` | `vts safe-delete` | Delete a declaration — **refuses while it's still referenced** unless `force=true`. |

**Version control (output compaction, read-only)**

| Tool | CLI | Does |
| --- | --- | --- |
| `vts_git` | `vts git` | Run a read-only `git status/log/diff` and group/dedup/cap the output. Mutating subcommands refused. |
| `vts_p4` | `vts p4` | Same for Perforce `opened/status/changes/reconcile`. |

Plus `vts_warmup`, `vts_setup`, `vts_config`, `vts_savings`, `vts_savings_reset`, `vts_discover`,
`vts_gen_compile_db`. Or hand a whole "where is X / what calls Y / find file W" lookup to the
**`code-locator` subagent** — it searches in its own context and returns only the `file:line` table.

```
$ vts symbol --q SpawnActor --projectPath ./MyGame
3 symbol(s) matching "SpawnActor" (backend: clangd, root: ./MyGame):
func SpawnActor (in AGameMode)  @ MyGame/Source/GameMode.cpp:142
method SpawnActorDeferred (in UWorld)  @ MyGame/Source/World.cpp:88
func SpawnActorFromClass  @ MyGame/Source/SpawnLib.cpp:31

✓ Saved ~4,200 tokens here (96.8% / 31× smaller than the raw index response).
```

## How it works

clangd and Roslyn already do the semantic analysis. What this plugin adds is **enforcement, a token cap,
and a headless spawn + warm-up**, so Claude actually uses the index instead of grep:

| Layer | Effect |
| --- | --- |
| **Rewrite/enforcement hook** | Covers three surfaces. **Bash** grep/rg/`find -name` over source → **rewritten to the equivalent `vts` query in place** (identifier → `search_symbol`, literal → `search_text`, `find <dir> -name` → `find_files` rooted at `<dir>`); ambiguous cases (pipeline, multi-`-name`) block. **Grep tool** symbol hunt (bare identifier, `::`/`(`/`void·class` regex, or a `FooBar\|BazQux` CamelCase alternation) → **blocked** with a ready-to-use call; freeform/keyword alternations stay a warn. **Glob tool** concrete code file (`*.cpp`, `Foo.h`) → **blocked** toward `find_files`. Messages are agent-directed and i18n'd (EN/KO). Logs/`.md`/config pass through. Knobs: `VTS_REWRITE=0`, `VTS_GREP_BLOCK=0`, `VTS_ENFORCE=0`. |
| **Token-capping core** | Turns LSP results into `kind name @ file:line`, caps, appends `… N more`. A refs-heavy result collapses to one row per file (`Foo.cpp:42,88,120`) with a shared dir prefix factored out once (`VTS_COMPACT_RESULTS=0` restores per-line). A truncated `find_files`/`search_text` tees the full set to a recovery file. |
| **Symbol-level editing** | `replace_symbol_body`/`insert_*`/`safe_delete` resolve a declaration by name via the outline and splice text at its exact span — preview by default, `apply=true` writes, `safe_delete` refuses while referenced. No whole-file Read into context. |
| **Headless LSP client** | A fully-owned LSP client spawns the official engine over stdio. The project root is resolved **per call** (explicit `projectPath` → the file's enclosing project → the MCP workspace root), so one global server answers for **every repo a session touches**. Live backends are pooled and bounded (`VTS_MAX_BACKENDS` + idle reaper). |
| **Savings + discover** | A local ledger records every search's tokens-saved (`vts savings`, with a 30-day graph). `vts discover` scans recent sessions for searches that *bypassed* the index — so you see the catch-rate, not just the wins. |

> **Engine = official, glue = ours.** clangd (LLVM) and Roslyn (Microsoft) do the analysis; this repo
> only writes the LSP↔MCP glue. No third-party MCP server runs over your source. Local-only, nothing uploaded.

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
- **C/C++ → clangd ≥ 22** ([releases](https://github.com/clangd/clangd/releases)). The clangd 19.1.x bundled with Visual Studio **deadlocks** indexing real Unreal TUs in server mode; vts warns on an older one. Needs a `compile_commands.json`.
- **C#/.NET → a Roslyn LSP.** Install the VS Code C# extension (`ms-dotnettools.csharp`) — vts auto-detects `Microsoft.CodeAnalysis.LanguageServer` and its runtime from the bundle. Fallback: `dotnet tool install --global csharp-ls`. Needs a `.sln`/`.csproj`.
- **JS/TS → typescript-language-server, Python → pyright.** Ship as plugin deps, install automatically on the first session (one-time ~50 MB; JS/TS wants Node 20+, skipped on 18).

**clangd needs a compile database:**
- **Unreal:** `<UE>/Engine/Build/BatchFiles/RunUBT … -mode=GenerateClangDatabase`. If targets build with clang-cl, add **`-Compiler=VisualCpp`** or it fails clang-toolchain validation.
- **CMake:** `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`.

**No compile DB yet?** You still get answers — `search_symbol` falls back to a bounded literal text
search, labeled as such, and the first result carries a one-time advisory. The one-command fix:
`vts_gen_compile_db` (CLI `vts gen-compile-db`) assembles the exact UBT command (finds the `.uproject`,
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
Configure via `/vs-token-safer:setup` (guided), `vts_setup`/`vts_config` tools, or `vts setup
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
| — | `VTS_CLANGD_CMD` / `VTS_CLANGD_ARGS` | `clangd` | Override the clangd executable / args. |
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
| — | `VTS_EXCLUDE_COMMANDS` | — | Comma list of executables to exempt (also `excludeCommands` in config). |
| — | `VTS_COMPACT_VCS` | `1` | `0` stops rerouting read-only `git`/`p4` to the compacted wrapper. |
| `lang` | `VTS_LANG` | auto | Hook message language: `ko` / `en` (auto-detects from OS locale). |
| — | `VTS_TEE` / `VTS_TEE_DIR` | `truncate` | Recovery file for a capped `find_files`/`search_text` result. |
| — | `VTS_USD_PER_MTOK` | `3` | $/Mtok rate for the estimated-value line (informational). |
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

## License

MIT © 2026 JSungMin
