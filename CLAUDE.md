# vs-token-safer — Claude rules

Routes an agent's code search through an **official language server's index** (clangd, a Roslyn LSP,
tsserver, pyright), falls back to tree-sitter / a mined concept dictionary / document sections, and
**token-caps** every answer to a compact `file:line` list. Local-only. Ships as an MCP server (`vs-search`),
a CLI (`vts`, on the plugin PATH via `bin/`), and PreToolUse hooks. Config `~/.vs-token-safer`, env `VTS_*`.

This file is loaded into EVERY session and subagent turn here, so it stays short. The per-module design,
the measurements behind each rule, and the rejected alternatives live in **`docs/ARCHITECTURE.md`** — read
the section for the code you are changing (Layout / Conventions / Backends / Identity) before editing it.

## First, orient (every session)
1. `node eval/run.mjs` must print `EVAL PASSED` before you change anything.
2. Context: this file · `docs/ARCHITECTURE.md` · the wiki (`wiki_query "vs-token-safer"`, `.omc/wiki/`; the
   **Status and TODO** page is the live checklist) · memory anchor `project-vs-token-safer`.

## Identity and the roadmap rule
The layer an agent talks to instead of reading the repository: it answers at the highest precision it can
reach and labels the rung (`completenessCert`): **exact** (language server) → **syntactic** (tree-sitter) →
**fuzzy** (concept dictionary, no embeddings) → **section** (docs/config by heading/selector), plus
`PARTIAL`/`INCONCLUSIVE` coverage. A feature earns its place only by adding a rung or covering more of the
repo, and must keep the three disciplines: **capped** output, **honest** precision label, **nothing leaves
the machine**.

## Map (details: docs/ARCHITECTURE.md → Layout)
- `server/core.js` — `runTool()` dispatch for every tool, token-cap formatters, savings ledger, discover.
- `server/lsp.js` — LSP client. `server/backends/index.js` — backend spawn configs, `pickBackend`, CDB dirs.
- `server/treesitter.js` + `symindex.js` — syntactic tier + committable `.vts-index`. `server/concept.js` —
  fuzzy tier. `server/textstruct.js` — section tier. `server/scope.js` — indexing scope / preindex.
- `server/policy.js` — routing digest + suppression. `server/squeeze.js` — passthrough compaction.
- `server/compact.js` — git/p4 output compaction. `server/psearch.js` — PowerShell search classifier.
- `server/viz.js` / `serve.js` / `dashboard.html` — local dashboard (`vts serve`, 127.0.0.1).
- `hooks/block-code-grep.js` — the enforcement hook (Bash/Grep/Glob/Read/Edit/PowerShell).
  `hooks/orchestrator-redirect.js` — qvts delegation. `hooks/edit-report.js` — SessionStart digest.
- `agents/code-locator.md` — locate-only subagent (tools restricted). `eval/run.mjs` — the eval.
- `gamedev-log-analyzer/` — static mirror; the source is `../rider-mcp-enforcer`.

## Non-negotiable conventions (why + measurements: docs/ARCHITECTURE.md → Conventions)
- **Token-first.** Output is `file:line`, capped, no bodies. Every new path gets an `eval/run.mjs` guard, and
  you verify the guard FAILS without your change before trusting it.
- **Judge by billed cost, not token count.** Cache reads dominate the bill; a token in context is re-billed
  every later turn until a compaction (`core.js lifetimeCost`). A cap only helps if it ends the lookup. The
  fixed prefix (tool schemas, SessionStart digest, agent/skill text, this file) is paid on every turn.
- **Transparent rewrites convert; warnings and blocks barely do** (2 of 1,694 warnings acted on). Prefer
  `updatedInput` rewrites; a search that can't be translated exactly runs as-is through `vts squeeze`
  (`VTS_PASSTHROUGH=0` restores the block).
- **Never widen a scoped call.** A file-scoped search stays native or stays file-scoped; a dir scope is
  carried into any delegation (`under <dir>`); several operands mean no single scope.
- **A miss must never look like an absence** — say which root/rung answered and how to widen
  (`widenRootHint`). Do not re-propose retrying an empty path-less search at the enclosing root (rejected:
  second clangd, LRU-evicts the warm one, cold path, voids scope).
- **Unattended work stays bounded, deduped, stoppable** (`ensureAutoIndex`: size ceiling, pid-liveness lock,
  `vts index --stop`).
- **No console windows on Windows:** every `spawn`/`execFile*`/`execSync` in `server/` passes
  `windowsHide: true` (eval guard scans every site).
- **Local-only, zero transmission; engine = official, glue = ours.** Never reuse a 3rd-party MCP server over
  source, never reimplement Roslyn, no embeddings, no network calls.
- **No proprietary leak.** No real paths/symbols/company names in the repo, commits or PRs; eval/docs use
  synthetic names; scan the tree + git log before any push.
- **Async.** `runTool` is async; adapters `await` it and call `disposeClients()`.
- **Bash tool hygiene.** Use Edit/Write for files; keep Bash to short `git`/`gh` commands; pass long commit/PR
  bodies via a file (`-F <file>` / `--body-file`); `timeout: 300000` for network commands.

## Release workflow — gitflow (details: docs/ARCHITECTURE.md → Conventions)
- `main` = tagged releases only · `dev` = integration · `feature/<slug>` off `dev` · `hotfix/<slug>` off `main`.
- Bump by Conventional-Commit type, not batch size (`node scripts/bump.mjs <level>`): `feat:` → minor,
  `fix:`/`perf:`/`refactor:`/`docs:`/`chore:` → patch, `!`/BREAKING → major. One release = one theme.
- Feature: squash-PR into `dev`; a themed `dev → main` PR; bump + `git tag -a v<x>` on main; push the tag
  (release.yml publishes); merge `main` back into `dev` (ask before any force-push of a shared branch). Minor
  releases roll up the preceding patch line in the GitHub release notes.
- Hotfix: `hotfix/*` off `main` → PR → patch bump + tag immediately → merge `main` into `dev`.
- Every PR green on CI (eval/lint/validate, Ubuntu + Windows) before merge.
- No npm publish from this repo. Refresh the gamedev mirror only with `node scripts/sync-gamedev.mjs [src]`
  (it also bumps the marketplace entry; CI validate fails on a version mismatch).
- Commit author `JSungMin <jsm1505104@gmail.com>`; end commits with the Claude Code co-author line.

## Backends — essentials (details: docs/ARCHITECTURE.md → Backends)
- **clangd** needs `compile_commands.json` (UE: UBT `-mode=GenerateClangDatabase -Compiler=VisualCpp`,
  `vts gen-compile-db`), kept out-of-tree by default. Use clangd **≥ 22** — VS-bundled 19.1.5 deadlocks on UE
  TUs (`clangdCmd` config). A persisted index answers queries by polling instead of blocking (369 s → 51 s).
- **roslyn**: Microsoft.CodeAnalysis.LanguageServer from the VS Code C# extension (`csharp-ls` fallback).
- **typescript** / **pyright**: npm language servers; a zero-result `search_symbol` falls back to literal text.
- A query naming a file uses that file's own backend (`backendForPath`); an empty path-less result retries the
  other languages present (`censusFallbackBackends`) before the syntactic tier.
