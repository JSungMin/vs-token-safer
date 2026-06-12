# vs-token-safer — Claude rules

Force code search through an **official language server's index** (clangd for C++, a Roslyn-based C# LSP)
instead of Bash grep, and **token-cap** the result to a compact `file:line` list. The
Visual-Studio / IDE-agnostic sibling of `rider-mcp-enforcer`. Local-only. Ships as MCP server + CLI
(`vts`). npm package + plugin name: `vs-token-safer`.

## First, orient (every session)
1. Read this file, then `node eval/run.mjs` — must print `EVAL PASSED` (41/41) before you change anything.
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
- `server/lsp.js` — generic LSP client (JSON-RPC/stdio). The one new, careful piece. `didOpen` is
  open-or-refresh: first call → `didOpen(v1)`, a re-call on an already-open doc → `didChange` (bumped
  version, current disk text) so a file changed after warm-up isn't answered from a stale buffer; a
  since-deleted file → `didClose`. Position tools re-call `didOpen` before each query, so hover/goto/
  outline/rename always re-read the file. The LSP engine keeps UNOPENED files fresh itself (clangd
  file-watch + background re-index); our warmset caches self-invalidate (include-graph by mtime,
  query-history by re-record; `_censusCache` is process-lifetime → restart/re-setup to refresh).
  LSP-spec conformance: server→client requests get shape-correct replies (`_serverRequestReply`:
  `workspace/configuration`→array, `workspace/applyEdit`→`{applied:false}`, `window/showDocument`→
  `{success:false}`, void reqs→null, unknown→MethodNotFound -32601); a timed-out request sends
  `$/cancelRequest`; client declares `synchronization` + `workspace.configuration` capabilities.
- `server/backends/index.js` — clangd/roslyn/typescript/pyright spawn configs + `pickBackend(root)`
  (detect order: compile_commands→clangd > .sln/.csproj→roslyn > tsconfig/package.json→typescript >
  pyproject/*.py→pyright; strongest build-artifact first). Override via `VTS_CLANGD_CMD/ARGS`,
  `VTS_ROSLYN_CMD/ARGS`, `VTS_TS_CMD/ARGS`, `VTS_PY_CMD/ARGS`. `winShell` flag spawns the npm `.cmd`
  shims (ts/pyright) through a shell on Windows. `langIdForPath` (lsp.js) maps file ext → LSP languageId.
- `server/core.js` — `runTool()` dispatch, token-cap formatters, savings ledger. Tools: `search_symbol`,
  `find_references` (accepts EITHER a 0-based `path`+`line`+`character` position OR a `symbol` NAME — the
  code-modification primitive: by-name resolves the decl via `c.symbol` [exact-name-then-`path`-endsWith
  ranking], `didOpen`s it, queries references at `location.range.start`; no indexed decl → `scanTextUnder`
  literal-usage fallback. Discover showed name-driven usage hunts = the top bypass; this collapses the
  locate→position→refs dance that pushed the model to grep), `goto_definition`, `hover`, `document_symbols`,
  `rename` (LSP; rename = preview by default, `apply=true` writes — the only mutating tool); `find_files`,
  `search_text`
  (filesystem — sanctioned `find`/`grep` replacements, no backend needed; `search_text` TARGETING: `path=<file>`
  searches one named file / `glob=<pat>` matching files — naming it AUTO-INCLUDES that extension (a `.md` etc),
  no docs flag; `docs=true` (no path/glob) widens the project-wide sweep to README/docs/config exts — default
  stays code-only. The grep-block hook reroutes a file-targeted text grep [`grep X README.md`] → `vts text
  --path README.md` via `buildDocsGrepRewrite`, rewrite-only never blocks); `vts_git`,
  `vts_p4` (OUTPUT COMPACTION, not index — run the real `git`/`p4` and group/dedup/cap the result via
  `server/compact.js`: git status→by change-type+dir, log→one line/commit, diff→per-file +/- diffstat;
  p4 opened/status/reconcile→by action+depot-dir, changes→terse. The rtk slice under our roof + ledger;
  the grep-block hook reroutes a single read-only `git status|log|diff` / `p4 opened|status|changes|reconcile`
  here via `buildVcsRewrite` — never blocks, `VTS_COMPACT_VCS=0` disables. `git grep` stays a CODE search.
  CLI `vts git/p4` are full arg passthrough → run in cwd, no `--projectPath`); `vts_warmup`, `vts_setup`,
  `vts_config`, `vts_savings` (RTK-gain-style: `graph`/`daily`/`history` + est. USD over timestamped day
  buckets), `vts_savings_reset`, `vts_discover` (scans `~/.claude/projects/*.jsonl` for code searches that
  BYPASSED vts → missed-token report + catch-rate; `learn=true` feeds their result files into the warm-set).
  `find_files`/`search_text` write a recovery TEE file (`VTS_TEE_DIR`, default on-truncate) when a result is
  capped so the full set is recoverable without re-running; a capped `search_symbol`/`find_references`
  ("… N more") tees too (`teeOverflow` — the rows are already in memory, no re-query). The ledger
  aggregates PER TOOL (`by tool:` line in `vts savings`) so you can see where the win comes from. BOOT AUTO-LEARN (`index.js`, `VTS_AUTO_LEARN`
  default on when projectPath set): 3s after boot, `autoLearn(root, 7)` (core.js, shares `scanBypasses`
  with discover) harvests bypassed-search result files into query-history — the self-improvement loop runs
  unattended every server start.
- `agents/code-locator.md` — context-isolated locator subagent (delegates a lookup, returns only file:line).
- `server/compact.js` — PURE output-compaction fns (`compactGit`/`compactP4`/`compactGrepLines`, string→string,
  no spawn) for the `vts_git`/`vts_p4` wrappers. Eval exercises them on canned input (deterministic).
- `server/cli.js` — `vts <cmd>`. `server/index.js` — MCP server (async handler → `await runTool`).
- `server/sdk.js` — createRequire MCP-SDK resolution. `server/ensure-deps.mjs` — SessionStart installer.
- `server/warmset.js` — prewarm ORDERING: `orderForWarm` (query-history > working-now [`git status` /
  `p4 opened`] > git-log recency > include-centrality [adaptive: prefix-read + `VTS_CENTRALITY_BUDGET_MS`
  + persistent include-graph cache that grows across warmups; `VTS_CENTRALITY_MAX` bounds the loop] > mtime) +
  `recordQueryResults`. Steers clangd's open-set so the warm window hits likely queries; git + Perforce.
  Used by `backends/index.js` afterInit + `core.js` (records result files per search). Also LANGUAGE-MIX
  warm sizing: `languageCensus(root)` (cached file-count per backend lang, skips node_modules/build/...),
  `warmCap(root,backend,env,base)` (per-backend open-cap scales to that lang's file count × `VTS_WARM_CAP_RATIO`,
  clamped `[base,VTS_WARM_CAP_MAX]`; explicit `VTS_*_OPEN_CAP` wins), and `prewarmBackends(root,picked)`
  (`VTS_PREWARM_BACKENDS` auto→[dominant] / `all`→every detected lang dominant-first / comma-list). `index.js`
  boot warms each selected backend with its adaptive cap → a multi-lang repo warms in language proportion.
- `hooks/block-code-grep.js` + `hooks.json` — grep-block. A Bash code search (grep/rg/ack/ag/findstr/
  `git grep`/`find -name`) that is a SINGLE safe segment is REWRITTEN to the equivalent `vts` CLI command via
  PreToolUse `updatedInput` (token-capped, flow unbroken); anything ambiguous (pipeline, unsafe pattern,
  quote in the root) falls back to the exit-2 block. Segment splitting is QUOTE-AWARE (`splitSegments` in
  `server/shell-split.js`, SHARED with `vts discover` so enforcement and measurement agree): a `|` inside
  quotes is pattern, not pipeline — so `grep "FooA|FooB"` / `grep "^#include"` (the top bypass shapes per
  `vts discover`) rewrite to `vts text` (regex); inside double quotes `\"` is an escaped literal; SAFE_TEXT
  allows `| ^ #` (always double-quoted; `$`/space/backslash still rejected). The Grep TOOL stays warn-only but `grepNudgeFor` embeds a
  READY-TO-USE equivalent call (identifier→search_symbol, regex→search_text) in the nudge. `VTS_REWRITE=0`
  → block instead of rewrite; `excludeCommands` (config) / `VTS_EXCLUDE_COMMANDS` (csv) opt a command out;
  escape hatch `VTS_ENFORCE=0`.
- `skills/vs-search/SKILL.md` — routing. `commands/{setup,savings}.md`.
- `eval/run.mjs` + `eval/_mock-lsp.mjs` — mock-LSP eval (no toolchain). Add a guard for every new path.
- Config dir `~/.vs-token-safer`, env prefix `VTS_`. MCP server name `vs-search`.

## Conventions (inherited — non-negotiable)
- **Token-first.** Every feature must keep/raise the token win. Output is `file:line`, capped, no bodies.
  Add an `eval/run.mjs` guard for anything new.
- **No proprietary leak.** Never put real paths/symbols/company names in the repo or commits; sanitize;
  scan tree + git log before any push. Eval/docs use synthetic names only.
- **Security/local-only.** No network calls; nothing transmitted. PRIVACY.md says so.
- **Release/branch workflow.** Work accumulates on the **`dev`** integration branch; land via a single
  **`dev → main` PR** (`Closes #N`, "Review points") → squash-merge, then resync `dev` to `main`. Bump on
  main + tag `v<x>` (`node scripts/bump.mjs <level>`, then commit + `git tag -a`); the `v*` tag publishes a
  **GitHub Release** (release.yml). **No npm publish from this repo** — the gamedev-log-analyzer npm
  package is maintained in `../rider-mcp-enforcer`; the bundled copy here is a static mirror. To refresh it
  run **`node scripts/sync-gamedev.mjs`** — it mirrors the source AND bumps the `.claude-plugin/marketplace.json`
  gamedev entry to match (never hand-copy: `claude plugin validate . --strict` / CI `validate` fails if
  `plugins[].version` ≠ the plugin's `plugin.json` version, and the eval guards this parity). Use Edit/Write
  for files + short `git`/`gh` Bash (no heredocs/`node -e` — they break tool calls). `timeout: 300000` for network Bash.
- **Reuse, don't reinvent.** Pull patterns from `../rider-mcp-enforcer` and `../gamedev-log-analyzer`
  (token-cap, savings ledger, grep-block hook, routing skill, CLI-first, release CI).
- Commit author: `JSungMin <jsm1505104@gmail.com>`. End commits with the Claude Code co-author line.

## Backends
- **clangd** (C++): needs `compile_commands.json` (Unreal: UBT `-mode=GenerateClangDatabase`).
  **✅ live-verified** (search/refs/def) via VS-bundled clangd (`…/VC/Tools/Llvm/bin/clangd.exe`).
  clangd indexes async → `afterInit` (`backends/index.js`) opens the compile_commands TUs + nearby
  headers (cap 100) and waits for `textDocument/publishDiagnostics` before the first query. CAVEAT: a
  compile DB without include dirs → system/3rd-party headers fail to resolve → only header-free symbols
  index; UBT-generated DBs include the paths. NO compile_commands.json at all (a `.uproject`-only project
  still picks clangd) → `compileDbAdvisory`/`hasCompileDb` (core.js) prepend a one-time UBT-generate advisory
  to clangd results AND vts_setup warns proactively; `search_symbol` then falls back to a literal text search
  (same path as ts/py 0-results) so the name is still locatable without a DB. The user's CHOICE: tool
  **`vts_gen_compile_db`** (CLI `vts gen-compile-db`) builds the UBT `GenerateClangDatabase` command (auto:
  .uproject→target `<Name>Editor`, engine root via `VTS_UE_ROOT`/arg/walk-up, `-Compiler=VisualCpp`) — DRY
  RUN by default (prints the exact command), `apply=true` runs it (`VTS_UBT_TIMEOUT_MS`). APPLY runs the
  `.bat` THROUGH THE SHELL (`execSync(plan.cmdline)`) — Node refuses to spawn `.bat`/`.cmd` directly
  (EINVAL, CVE-2024-27980 hardening; found live on the real UE depot). The DB lands **OUT-OF-TREE by
  default**: `dbDirFor(root)` (backends/index.js) = `~/.vs-token-safer/db/<basename>-<sha1[:10]>`
  (`VTS_DB_DIR` overrides the base); `resolveCdbDir(root)` (in-tree shallow scan WINS, else the
  out-of-tree home) feeds clangd's `--compile-commands-dir`, `detect`, `afterInit`, and `hasCompileDb` —
  and clangd writes its `.cache/` index NEXT TO the CDB, so the whole artifact set stays outside the
  source tree (nothing for git or `p4 reconcile`). `inTree=true` keeps the classic project-root layout,
  protected by `ensureDbIgnored(root)`: appends `compile_commands.json` + `.cache/` to `.gitignore` (git
  work tree) or an existing P4IGNORE/.p4ignore (walk-UP to the depot root — the live depot keeps it 2
  levels above the game dir; read-only/versioned file → exact `p4 edit` instructions instead). The
  engine-root DB copy is removed after the move in both modes. `genCompileDbPlan` + `ensureDbIgnored` +
  `dbDirFor` + `resolveCdbDir` exported for the eval. **✅ real UE 5.x project live-verified end-to-end**
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
  - **LATENCY (why it felt slower than a warm IDE like Rider — root-caused on a real 26k-TU UE project, all
    fixed; THE BIG ONE is #3):** (1) clangd's background-index priority defaults to `background` =
    MINIMUM/idle-CPU-only → we pass **`--background-index-priority=normal`** (`VTS_CLANGD_INDEX_PRIORITY`) +
    **`-j=`**`cores-1` (`VTS_CLANGD_JOBS`). (2) afterInit `didOpen`s up to `VTS_CLANGD_OPEN_CAP` (100) UE TUs
    and clangd PARSES each — when a persisted index exists, **`hasPersistedIndex`** (checks
    `<cdbDir>/.cache/clangd/index/*.idx`) shrinks the open-set to `VTS_CLANGD_WARM_CAP_PERSISTED` (8). (3)
    **the killer**: afterInit waited for clangd's FULL background-index completion (`$/progress kind:end`,
    up to `VTS_LSP_INDEX_WAIT_MS`) before the first query — but workspace/symbol answers from the loaded
    static shards LONG before the full re-validation finishes. **Measured: 369s (full wait) vs 51s (static
    index loaded) = 7×.** FIX: when persisted, afterInit no longer blocks — it returns after a short floor
    (`VTS_CLANGD_PERSISTED_FLOOR_MS`, 3s) and flips `client.indexLoaded` on `$/progress end`; the QUERY then
    POLLS (`symbolReady` in core.js: re-issue with backoff, capped `VTS_CLANGD_PERSISTED_WAIT_MS` 60s) and
    returns the INSTANT the sought symbol's shard loads — not at a fixed deadline. Once `indexLoaded`, an
    empty result is genuine (stop). Cold (no index) still BLOCKS on the build (a poll would just spin). Used
    by search_symbol + find_references-by-name. clangd stores
    `.cache/clangd` at the **cdbDir** (it honors `--compile-commands-dir` as the index ROOT — live-verified:
    6166 shards under the out-of-tree dir, none in the source tree), so the out-of-tree layout keeps the
    index out of VCS too. Rider is fast because it proxies a RUNNING IDE; our MCP server keeps clangd alive
    so the per-spawn cost is paid once per session (the one-shot CLI pays it each call).
- **roslyn** (C#/.NET): `.sln/.csproj`. **✅ live-verified** against **Microsoft.CodeAnalysis.LanguageServer**
  (the real VS / C# Dev Kit engine), auto-detected from the VS Code C# extension bundle + its net10
  runtime; opens the workspace via `solution/open`/`project/open` then waits for
  `workspace/projectInitializationComplete` (see `backends/index.js` `afterInit`, `lsp.js`
  `waitForNotification`). `csharp-ls` is the fallback. Overrides: `VTS_ROSLYN_DLL`, `VTS_ROSLYN_CMD/ARGS`.
- **typescript** (JS/TS): `typescript-language-server --stdio` (wraps tsserver). Install
  `npm i -g typescript-language-server typescript`. Detect: tsconfig/jsconfig/package.json or `*.ts/js`.
  `afterInit` opens top-N (`VTS_TS_OPEN_CAP`, 60) likely-query files; `workspace/symbol` answers
  project-wide. Override `VTS_TS_CMD/ARGS`. **✅ live-verified by dogfooding vts on its own `server/*.js`**
  (search_symbol/find_references/document_symbols returned correct `file:line` incl. cross-file refs).
- **pyright** (Python): `pyright-langserver --stdio` (`npm i -g pyright`). Detect:
  pyproject/setup.py/setup.cfg/requirements/Pipfile or `*.py`. `afterInit` opens top-N
  (`VTS_PY_OPEN_CAP`). Override `VTS_PY_CMD/ARGS`. Same generic glue as typescript.
- **document_symbols outline filter (dogfood-found).** `fmtDocSymbols` hides outline noise by default —
  anonymous callbacks/function-expressions (`arr.map() callback`, `<function>`) and NESTED var/const/key
  locals (kinds 13/14/20 at depth>0) — keeping the declaration structure (classes/functions/methods/
  fields/types). A `(N local/anonymous hidden …)` note shows the count; `VTS_OUTLINE_RAW=1` shows all,
  `VTS_OUTLINE_DEPTH` caps nesting (default 4). Live: a 105-symbol warmset.js outline → 32. Token + clarity win.
- **ts/py search_symbol fallback (dogfood-found).** tsserver/pyright answer `workspace/symbol` from
  OPEN/indexed files, so a symbol whose file the warm-up didn't open (or a non-exported local) returns 0.
  `search_symbol` then falls back to a bounded literal text search (`scanTextUnder`, labeled "Literal text
  matches"; clangd/roslyn index the whole project so they skip it). Also `scanTextUnder` (`search_text`) now
  scans `js/ts/tsx/.../py/pyi` — it was C/C++/C# only, a real bug once the JS/TS/Py backends landed.
- **Windows spawn:** npm-installed JS LSPs are `.cmd` shims → `winShell:true` on those backends spawns
  through a shell (clangd.exe / dotnet host stay shell:false to survive paths with spaces). `langIdForPath`
  (lsp.js) maps file ext → LSP languageId so one backend serves several extensions.
- **grep-block hook** now covers `js/jsx/mjs/cjs/ts/tsx/mts/cts/py/pyi` too (default on, per user) so vts
  self-enforces while we develop it; `VTS_ENFORCE=0` still the escape hatch. matcher is `Bash|Grep`: Bash
  code-grep BLOCKS (vts default), the built-in **Grep tool** WARNS-only (never block — it's the fallback),
  and a search aimed at a LOG (`Logs/` dir or `.log/.jsonl`) WARNS+allows with a gamedev-log pointer.
- **log steer (rider 0.2.8 parity).** `core.js` `looksLogTarget(a)` (path/projectPath/paths vs `LOG_PATHISH`)
  appends a one-line gamedev-log pointer (`LOG_STEER`) to ANY tool result whose target is a log; empty
  symbol results carry `EMPTY_HINT` (stale-index + definitions-only + log→gamedev-log), find_files/search_text
  empties carry `LOG_EMPTY_HINT`. Additive text only, never blocks. Mirrors `../rider-mcp-enforcer` proxy steer.

## Next (see wiki "Status and TODO")
P1 DONE: core rename, `index.js`/`sdk.js`/`ensure-deps.mjs`, grep-block `hooks/`, `skills/`+`commands/`,
`.claude-plugin/*`+`.mcp.json`, README EN/KO + PRIVACY/SECURITY/CONTRIBUTING/CoC/BENCHMARK, `.github` CI,
lint/prettier configs, `bump.mjs`. P1 remaining: `gh repo create JSungMin/vs-token-safer --public` +
push; optionally **bundle gamedev-log-analyzer** as a 2nd marketplace plugin. P2: live-verify clangd
then roslyn on real projects.
