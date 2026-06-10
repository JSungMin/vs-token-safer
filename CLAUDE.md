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
- **clangd** (C++): needs `compile_commands.json` (Unreal: UBT `-mode=GenerateClangDatabase`). Build +
  live-verify this FIRST (the user's Unreal stack).
- **roslyn** (C#/.NET): `.sln/.csproj`, default `csharp-ls`. Currently **⚠️ best-effort, unverified** —
  mark as such until live-tested on a real `.sln`.

## Next (see wiki "Status and TODO")
P1 DONE: core rename, `index.js`/`sdk.js`/`ensure-deps.mjs`, grep-block `hooks/`, `skills/`+`commands/`,
`.claude-plugin/*`+`.mcp.json`, README EN/KO + PRIVACY/SECURITY/CONTRIBUTING/CoC/BENCHMARK, `.github` CI,
lint/prettier configs, `bump.mjs`. P1 remaining: `gh repo create JSungMin/vs-token-safer --public` +
push; optionally **bundle gamedev-log-analyzer** as a 2nd marketplace plugin. P2: live-verify clangd
then roslyn on real projects.
