# vs-token-safer — Claude rules

Force code search through an **official language server's index** (clangd for C++, a Roslyn-based C# LSP)
instead of Bash grep, and **token-cap** the result to a compact `file:line` list. The
Visual-Studio / IDE-agnostic sibling of `rider-mcp-enforcer`. Local-only. Ships as MCP server + CLI
(`vts`). npm package + plugin name: `vs-token-safer`.

## First, orient (every session)
1. Read this file, then `node eval/run.mjs` — must print `EVAL PASSED` (6/6) before you change anything.
2. Resume context lives in: this file · the wiki (`wiki_query "vs-token-safer"`, pages under
   `.omc/wiki/`) · memory anchor `project-vs-token-safer`. The wiki **Status and TODO** page is the
   live checklist.

## What's true
- **Engine = official, glue = ours.** clangd (LLVM) / Roslyn (MS) do the analysis; we only write the
  LSP↔MCP glue. Never reuse a 3rd-party MCP server over source; never reimplement Roslyn.
- **Local-only, zero transmission.** Same trust model as the other plugins. The token-cap returns
  `file:line` (no bodies) → less raw source reaches the model than grep-and-paste.
- **Async.** `runTool` is async (LSP is async). MCP/CLI adapters must `await` and `disposeClients()`.
- **Naming umbrella.** "token-safer" is deliberately broad — more token-saving features/backends can be
  added under this name beyond C++/C# search.

## Layout
- `server/lsp.js` — generic LSP client (JSON-RPC/stdio). The one new, careful piece.
- `server/backends/index.js` — clangd/roslyn spawn configs + `pickBackend(root)`. Override via
  `VTS_CLANGD_CMD/ARGS`, `VTS_ROSLYN_CMD/ARGS`.
- `server/core.js` — `runTool()` dispatch, token-cap formatters, savings ledger. Tools: `search_symbol`,
  `find_references`, `goto_definition`, `vts_setup`, `vts_config`, `vts_savings`, `vts_savings_reset`.
- `server/cli.js` — `vts <cmd>`. `server/index.js` — MCP server (async handler → `await runTool`).
- `server/sdk.js` — createRequire MCP-SDK resolution. `server/ensure-deps.mjs` — SessionStart installer.
- `hooks/block-code-grep.js` + `hooks.json` — grep-block (escape hatch `VTS_ENFORCE=0`).
- `skills/vs-search/SKILL.md` — routing. `commands/{setup,savings}.md`.
- `eval/run.mjs` + `eval/_mock-lsp.mjs` — mock-LSP eval (no toolchain). Add a guard for every new path.
- Config dir `~/.vs-token-safer`, env prefix `VTS_`. MCP server name `vs-search`.

## Conventions (inherited — non-negotiable)
- **Token-first.** Every feature must keep/raise the token win. Output is `file:line`, capped, no bodies.
  Add an `eval/run.mjs` guard for anything new.
- **No proprietary leak.** Never put real paths/symbols/company names in the repo or commits; sanitize;
  scan tree + git log before any push. Eval/docs use synthetic names only.
- **Security/local-only.** No network calls; nothing transmitted. PRIVACY.md says so.
- **PR workflow.** Issue → in-place branch (NOT worktree) → PR (`Closes #N`, "Review points") →
  squash-merge → label. Bump this package + tag `v<x>` (`node scripts/bump.mjs <level> --tag`); npm
  auto-publishes on the `v*` tag (idempotent). Use Edit/Write for files + short `git`/`gh` Bash (no
  heredocs/`node -e` — they break tool calls). `timeout: 300000` for network Bash.
- **Reuse, don't reinvent.** Pull patterns from `../rider-mcp-enforcer` and `../gamedev-log-analyzer`
  (token-cap, savings ledger, grep-block hook, routing skill, CLI-first, release/npm-publish CI).
- Commit author: `JSungMin <jsm1505104@gmail.com>`. End commits with the Claude Code co-author line.

## Backends
- **clangd** (C++): needs `compile_commands.json` (Unreal: UBT `-mode=GenerateClangDatabase`).
  **✅ live-verified** (search/refs/def) via VS-bundled clangd (`…/VC/Tools/Llvm/bin/clangd.exe`).
  clangd indexes async → `afterInit` (`backends/index.js`) opens the compile_commands TUs + nearby
  headers (cap 100) and waits for `textDocument/publishDiagnostics` before the first query. CAVEAT: a
  compile DB without include dirs → system/3rd-party headers fail to resolve → only header-free symbols
  index; UBT-generated DBs include the paths. **✅ real UE 5.x project live-verified end-to-end**
  (`search_symbol` returned the game `UCLASS` + its `*.generated.h` symbols as `file:line`):
  - `GenerateClangDatabase` needs **`-Compiler=VisualCpp`** when the targets build with clang-cl — else
    clang-toolchain validation fails (`Unable to find valid <ver> C++ toolchain for Clang x64`). Override
    → `Result: Succeeded`, ~26k-entry DB.
  - **CLANGD VERSION MATTERS (root cause of the long stall hunt).** VS-bundled clangd **19.1.5 DEADLOCKS**
    on a real UE TU in LSP-server mode: `clangd --check` parses it in ~19s, but every async path (didOpen
    *and* background-index) never finishes (>250s, 0 symbols). **Standalone clangd 22.1.6 parses the same
    TU in ~13s and returns symbols.** So it's an upstream clangd 19.x bug, not a vts/glue bug. Fix: use
    clangd ≥ `MIN_CLANGD` (22) — `backends/index.js` probes `clangd --version` and `core.js` prepends a
    one-time advisory if it's older. Isolation proved engine headers (CoreMinimal, GameplayTagContainer)
    parse fine; only the full game-TU header chain trips 19.x.
  - Secondary tuning for cold/large indexes: `VTS_LSP_TIMEOUT_MS` (request timeout), `VTS_LSP_INDEX_WAIT_MS`
    (afterInit waits for `$/progress` index-ready), `VTS_CLANGD_OPEN_CAP` (warm-up open cap).
- **roslyn** (C#/.NET): `.sln/.csproj`. **✅ live-verified** against **Microsoft.CodeAnalysis.LanguageServer**
  (the real VS / C# Dev Kit engine), auto-detected from the VS Code C# extension bundle + its net10
  runtime; opens the workspace via `solution/open`/`project/open` then waits for
  `workspace/projectInitializationComplete` (see `backends/index.js` `afterInit`, `lsp.js`
  `waitForNotification`). `csharp-ls` is the fallback. Overrides: `VTS_ROSLYN_DLL`, `VTS_ROSLYN_CMD/ARGS`.

## Next (see wiki "Status and TODO")
P1 DONE: core rename, `index.js`/`sdk.js`/`ensure-deps.mjs`, grep-block `hooks/`, `skills/`+`commands/`,
`.claude-plugin/*`+`.mcp.json`, README EN/KO + PRIVACY/SECURITY/CONTRIBUTING/CoC/BENCHMARK, `.github` CI,
lint/prettier configs, `bump.mjs`. P1 remaining: `gh repo create JSungMin/vs-token-safer --public` +
push; optionally **bundle gamedev-log-analyzer** as a 2nd marketplace plugin. P2: live-verify clangd
then roslyn on real projects.
