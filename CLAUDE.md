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
  file-watch + background re-index); our warmset caches self-invalidate (include-graph by mtime+size composite
  key + an FNV-1a content hash [`warmset.js fnv1a`, zero-dep — codebase-memory-mcp XXH3 parity; reuses cached
  includes when bytes are unchanged despite mtime/size jitter, catches a real change a mtime-only key would miss],
  query-history by re-record; `_censusCache` is process-lifetime → restart/re-setup to refresh).
  LSP-spec conformance: server→client requests get shape-correct replies (`_serverRequestReply`:
  `workspace/configuration`→array, `workspace/applyEdit`→`{applied:false}`, `window/showDocument`→
  `{success:false}`, void reqs→null, unknown→MethodNotFound -32601); a timed-out request sends
  `$/cancelRequest`; client declares `synchronization` + `workspace.configuration` capabilities.
- `server/scope.js` — INDEXING SCOPE (cold-latency attack): index a SUBTREE not the whole monorepo. Config
  `scope` / `VTS_SCOPE` (comma-list of dirs rel to root); `vts setup --scope "MyGame,Plugins"` persists it.
  `scopeDirs`/`inScope`/`scopedCdb` (writes a FILTERED compile_commands.json of only in-scope TUs to the
  out-of-tree dir → clangd `--compile-commands-dir` points there → it background-indexes far fewer TUs;
  live UE5: `VTS_SCOPE=MyGame` = 3,377 of 26,488 TUs (13%), ~7.8× cut) / `scopeStats`. UNIVERSAL: every
  backend's afterInit warm walk is scope-filtered too (no tsconfig/sln edit). `backends/index.js`
  `effectiveCdbDir(root)` = scoped CDB when scope set, else `resolveCdbDir`; `scopeDirsFor(root)`. clangd
  STATIC PREINDEX: `clangd-indexer` (full LLVM release bundles it; `VTS_CLANGD_INDEXER_CMD`/next-to-clangd/
  PATH) builds a monolithic .idx over the scoped CDB → clangd loads it via `--index-file` (LOCAL file, no
  remote server) for an instant project-wide index; `buildStaticIndex`/`hasClangdIndexer`/`staticIndexPath`,
  absent → warm-pass fallback + advisory to install full LLVM. Ops `vts_scope` (show scope + TU stats +
  top-level dirs) / `vts_preindex` (build ahead: static index if indexer present, else warm pass); CLI `vts
  scope`/`vts preindex`, folded into `vts_admin`. Eval guard 79. Env: `VTS_SCOPE`, `VTS_CLANGD_INDEXER_CMD`,
  `VTS_INDEXER_TIMEOUT_MS` (1800000). PREINDEX GATING: `vts preindex` DEFAULT = fast scoped background warm;
  the clangd-indexer STATIC `--index-file` (parses every in-scope TU, tens of min on a big scope) is OPT-IN via
  `static=true`/`--static` — never auto-run just because the indexer exists (an existing `vts-static.idx` is
  still auto-loaded, cheap). within-scope cert: `completenessCert({scoped})` qualifies a semantic COMPLETE/0 as
  "within the configured indexing scope" (search_symbol/find_references), and `clangdIndexAdvisory` counts
  TUs/shards against the EFFECTIVE (scoped) CDB.
- `server/policy.js` — UNIFIED TOOL-ROUTING POLICY (vts COMPLEMENTS Claude Code, not competes). `shouldSuppressSteer(file)`
  stays SILENT where CC-native is clearly better — generated/build-output paths (`Intermediate|Binaries|Saved|
  DerivedDataCache|node_modules|build|dist|out|obj|.git`, `*.generated.*`/`*.g.cs`/`*.min.js`); wired into the
  edit-steer hook (a whole-decl edit there isn't nagged AND isn't counted against adoption). `VTS_SUPPRESS=0` off.
  `routingDigest()` = the SINGLE SessionStart message: a when-to-use-what decision tree (semantic→vts, whole-decl→
  symbol-edit, doc/just-edited/sub-decl→CC-native Read/Grep/Edit, big-tree→scope+preindex) + live adoption posture +
  adaptive-controller state — replaces the adoption-only nudge in `hooks/edit-report.js` (one coherent policy, not
  scattered nudges). Eval guard 80.
- `server/treesitter.js` + `server/symindex.js` — SYNTACTIC TIER (zero-setup fallback BETWEEN the semantic LSP
  and the literal text scan; the answer to "tree-sitter/embedding rivals are popular because they need no
  toolchain"). `treesitter.js`: lazy wasm tree-sitter (`web-tree-sitter` runtime + `tree-sitter-wasms` prebuilt
  grammars, both optionalDependencies — NO native build, Windows-safe; resolved via the sdk.js-style createRequire
  anchors). `tsFileSymbols(abs)` walks an AST → real DECLARATIONS (name+kind+line). 36 grammars ship; decl
  extraction is configured for **~17 languages** — 10 via a hand-tuned node-type walk (C/C++/C#/JS/TS/Py/Go/
  Java/Rust/Ruby; `nameOf` drills C/C++ declarator chains) + 7 via canonical **`server/tags/<grammar>.scm`**
  TAGS QUERIES (php/swift/kotlin/scala/dart/zig/bash) — a grammar with neither degrades to a GENERIC walk, never
  dark. The tags tier is the EXTENSION POINT: a `TAGS` sentinel config in `EXT_MAP` + a `.scm` with canonical
  `@definition.<kind>`/`@name`/`@reference.*` captures = a new language with NO JS (`defTagsQueryFor`/
  `extractTagDefs`/`extractTagRefs`, validated against the bundled grammar; query-construct failure → graceful
  fallback). References too: TAGS langs read `@reference.*` from the same .scm, others use inline `REF_QUERIES`.
  `tsSearchSymbols(root,q)` ranks exact-before-substring across a scope (time+file-box).
  Charter-pure: tree-sitter is an OFFICIAL standard parser (GitHub/neovim), not a reimplement (the tags-query
  DSL is its own official interface, glue = ours);
  output stays token-capped file:line; nothing transmitted; SYNTACTIC means it locates decls but does NOT resolve
  refs/overloads/types (the LSP's job — so it's BELOW the semantic tier). `symindex.js`: COMMITTABLE index
  (Codeix-inspired) — `vts index` writes a portable, git-committable, team-shareable `.vts-index/symbols.jsonl`
  (one record/decl, paths RELATIVE) via tree-sitter; `searchSymIndex` answers `search_symbol` INSTANTLY on a
  toolchain-less machine or before clangd's index builds (the 369s→51s cold problem). INCREMENTAL rebuild: the
  header carries a per-file manifest `h:{rel:{mt,sz,h}}` (mtime+size fast-path → `warmset.fnv1a` content hash);
  a rebuild REUSES unchanged files verbatim (no read, no re-parse — parsing is the cost), reads+hashes only
  stat-changed files, re-parses only on a real content change, drops deleted files. So `vts index` after
  editing a few files re-parses only those (returns `reused`/`reparsed`; shown in the op output). core.js `syntacticSymbols`
  (committed index → live tree-sitter, else literal scan) feeds the search_symbol no-backend / empty-result
  branches; `completenessCert({syntactic})` labels it. Op `vts_index{status}` (CLI `vts index [--status]`, folded
  into `vts_admin`). Eval guard 81; benchmark arm C (zero-setup: 150-file symbol search grep 4917 → tree-sitter
  53 tok = 98.9%, no toolchain).
- `server/concept.js` — FUZZY retrieval WITHOUT embeddings (approach "B"; the charter-pure answer to Code
  Context Engine's exact-vs-fuzzy critique — "how does the auth flow work" when you can't name the symbol).
  THE REPO IS ITS OWN THESAURUS: identifiers + the comments beside them are a distributional signal already in
  the source — tokens that NAME THE SAME THING co-occur. PURE/zero-dep module: `splitIdent`/`tokenize`
  (CamelCase/snake/digit split, drop digit+stop+len1), `tokMatch` (exact 1.0 / prefix≥4 0.7 — no stemmer),
  `buildConceptModel(units,{maxUnitTokens:14})` (df + co-occurrence over per-decl token bags = name subtokens +
  leading-docstring subtokens; the UNIT must be TIGHT — a long header comment attached to the first decl makes a
  giant unit where everything co-occurs → junk, so cap it), `assoc` (PMI-lite c·N/(df·df)), `idf`,
  `expandQuery({k,minAssoc:1.5,minCooc:2})` (gate single-shot noise: cooc≥2 AND df≥2), `scoreSymbol`
  (enriched·idf·bestMatch + comment channel ×0.5). HOT MCP tool **`concept_search`** (core.js: tokenize q →
  `conceptIndexFor(root)` [cached tree-sitter `tsFileDeclDocs` walk, scope-filtered, bounded] → expand → score
  [kind weight demotes const/var locals] → top-N with a relative floor `VTS_CONCEPT_FLOOR` 0.2 + `VTS_CONCEPT_MAX`
  15; `flow=true` expands the top seed along the call graph via find_references direction). CLI `vts concept
  --q "auth login flow" [--flow]`. HONEST: A(subtoken)+D(comment) reliable, B(co-occurrence) recovers domain
  synonyms when vocab clusters (compile database→clang/ubt/generate) but noisy on cross-cutting generics; pure-
  synonym-no-lexical-bridge residual genuinely needs embeddings (stated). `treesitter.js tsFileDeclDocs` = decl +
  attached leading comment (gap≤3, skip header blocks ≥4 lines, cap 200ch) feeds the concept units. NO embeddings,
  nothing transmitted, output token-capped file:line. Eval guard 83; **follow-up paper** `paper/fuzzy-concept-
  dictionary.tex` (companion to the Token-Safer paper, motivated by the CCE correspondence). Env: `VTS_CONCEPT_*`.
  SCORING = 3 deterministic channels (name > **path** > comment; `scoreSymbol`) + 2nd-pass **structural-proximity**
  boosts off TWO neighbour graphs (same LARGER anchor gate, reranks the matched set, never invents a match):
  (a) **import-graph** (`importSpecifiers` → within-repo basename adjacency; lifted by `VTS_CONCEPT_IMPORT_FACTOR`
  0.3 × the neighbour's score) and (b) **git CO-CHANGE** (`server/cochange.js` `cochangeNeighbors` — files
  committed together in the last `VTS_COCHANGE_MAX_COMMITS` 500 commits are coupled; mega-commits >
  `VTS_COCHANGE_MAX_FILES_PER_COMMIT` 30 skipped as merge/format noise; ≥ `VTS_COCHANGE_MIN_WEIGHT` 2 co-commits
  to count; lifted by `VTS_CONCEPT_COCHANGE_FACTOR` 0.25, BELOW imports — a softer signal). Co-change is the M1
  migration toward the Cursor/Augment "what clusters semantically" axis, embedding-free: the repo's own history is
  the cluster signal. PURE `parseCoChange` (git-log text → pair weights, both directions) + thin `git log` read,
  cached in `conceptIndexFor`; absent git → empty map (boost no-ops). `VTS_CONCEPT_COCHANGE=0` off. Eval guard 89;
  live-verified on the vts repo (core.js → 49 co-change neighbours: eval/run.mjs, policy.js, …). A **click-feedback loop was CRITIC-REJECTED** (self-confirming via
  position bias, non-deterministic, unmeasurable, erodes inspectability); the charter-pure adaptation paths are
  these code-mined structural signals + a **committable synonym file** (DONE): a team-curated, git-committable
  `<root>/.vts-index/concept-synonyms.json` (`{ "term": ["syn", …] }`) — `concept.js parseSynonyms` (tokenises
  keys+values) feeds `expandQuery({synonyms})`, injecting a curated bridge at weight 0.95 (below an exact 1.0,
  above a mined neighbour); additive (absent/malformed → mined model alone), inspectable, deterministic, no
  drift. Eval guard 83. TWO PAPER MIGRATIONS (charter-pure, no embeddings): (1) LARGER confidence-gate
  (`concept.js anchorConfident` / `VTS_CONCEPT_ANCHOR_MIN` 0.5) — the import-graph proximity boost fires ONLY
  from high-confidence anchors (a neighbour lifts a symbol only if its own base clears `ratio`×topBase), so a
  weak/cross-cutting neighbour can't drag its imports up (live-verified: cross-repo gamedev/`uiLang` noise
  dropped); (2) RM3 PRF (`concept.js prfTerms` / `VTS_CONCEPT_PRF*`) — a 2nd-pass mines feedback terms from the
  TOP-k pass-1 results' OWN vocabulary (name+comment subtokens, ≥2-doc consensus, idf-ranked, capped) and
  re-scores, bridging a synonym the query missed ("warm"→`warming/dominant`, "reachable"→`fixpoint/cascades`);
  the climb SEED stays the PRE-PRF intrinsic exact match (`base0`) so PRF widens recall without drifting the
  seed. Eval guard 83 (#c anchor, #d prf). PRECISION-LADDER NAV
  (`VTS_CONCEPT_STEER`): search_symbol(exact)+multi-word-miss → steers DOWN to concept_search; concept_search →
  points UP to find_references/goto. See [[identity-and-roadmap]].
- `server/textstruct.js` — STRUCTURE tier for prose/config files (the naming-umbrella extension: token-safer
  for DOCS, not just code). A text file's "symbol tree" = its SECTION hierarchy, so the EXISTING name-addressed
  tools work on it: `document_symbols` → token-capped table of contents, `read_symbol` → ONE section (not the
  whole file), `replace_symbol_body`/`insert_symbol`/`safe_delete` → edit a section BY ITS HEADING/KEY (no
  whole-file Read + line-count). EXTENSIBLE provider registry (`PROVIDERS`: ext→parser): markdown/mdx (ATX+
  setext, fence-aware), asciidoc, reStructuredText, toml/ini (`[section]`), yaml (indent-nested keys), json
  (pretty-printed keys), txt (heuristic), **css/scss/less** (`parseCss`: top-level selectors / at-rules
  (`@media`/`@keyframes`) at L1, SCSS-nested rules deeper, each with an EXACT brace-matched span via the shared
  `htmlNetBraces` scan — a stylesheet's "symbol tree" is its RULE hierarchy, so read/replace_symbol target ONE
  rule), **html/htm/xhtml** (`parseHtml`: `<h1-6>` + `<style>`/`<script>` blocks + id-landmarks at L1, and WITHIN
  style/script the top-level CSS selectors / JS FUNCTIONS at L2 via a brace-depth scan `htmlNetBraces`/
  `htmlJsDecl` — so read/replace_symbol target a rule or function BY NAME; dogfooded on dashboard.html, a
  function read at ~153×). The heuristic embedded JS/CSS decls are tagged `embedded` so they can be REPLACED by
  exact tree-sitter ranges: **tree-sitter INJECTION is DONE** (was the deferred robustness upgrade) — `treesitter.js
  htmlEmbeddedDecls(text)` re-parses each `<script>`/`<style>` with the real javascript/css grammar for EXACT
  decl ranges, recovering decls the heuristic misses (a MINIFIED one-line script, two CSS rules on one line, and
  — crucially — a function inside a top-level **IIFE** `(function(){…})()`, the dashboard.html pattern: the
  heuristic's depth-0 brace scan misses it, the injection's `maxBlockDepth≤1` walk recovers it). textstruct stays
  PURE (no fs/async/tree-sitter) — `structOutlineInjected(file,text,injector)` takes the parser from core.js
  (which owns tree-sitter) and falls back to the heuristic when it returns null (deps absent); `resolveInOutline`
  resolves against the already-computed (refined) outline. Each provider emits `[{level,title,line[,endLine]}]`;
  shared `computeSpans` sets the section span (a provider `endLine` — brace-matched — wins over the to-next-heading
  heuristic), `resolveSection`/`resolveInOutline` (exact-then-substring, `line` disambig) + `fmtOutline` are
  format-agnostic — add a format = add one parser. core.js: `STRUCT_TOOLS` + `structTool` (synthesises an
  LSP-shaped range from a section span → reuses `symbolEditResult`/`applyEditsToText`; computes the injected
  outline ONCE, then resolves against it); an `isStructFile(a.path)` SHORT-CIRCUIT runs BEFORE backend resolution
  (a .md/.toml/.css has no language server); document_symbols + read_symbol carry a `completenessCert({section})`
  (the SECTION rung). NO new MCP tools (the 5 existing symbol tools just work on text files — zero tool-budget
  cost). Zero-dep core, PURE, local, token-capped. Eval guards 84 (CSS provider) + 81 (HTML injection, under the
  tree-sitter block). `vts symbols/read-symbol/replace-symbol/insert/safe-delete --path X.{md,css,html}`.
- `server/backends/index.js` — clangd/roslyn/typescript/pyright spawn configs + `pickBackend(root)`
  (detect order: compile_commands→clangd > .sln/.csproj→roslyn > tsconfig/package.json→typescript >
  pyproject/*.py→pyright; strongest build-artifact first). MIXED-REPO FIX: a query that TARGETS a file uses
  `backendForPath(a.path)` (core.js — ext→backend: .py→pyright, .ts/.js→typescript, .cpp/.h→clangd, .cs→
  roslyn) BEFORE `pickBackend(root)`, so a `.py`/`.ts` file inside a clangd-rooted UE/C++ tree gets pyright/
  typescript instead of clangd (else the query hits the wrong LSP, finds nothing, model abandons vts).
  Precedence (`preferBackend`, core.js): explicit `a.backend` > the path's OWN backend WHEN it CONFLICTS with a
forced backend (one global server serves every repo, so a `backend:"clangd"` pinned for a C++ project must NOT be
sent this repo's `.js`/`.cs`/`.py` → clangd answers `-32001 invalid AST`; live-found dogfooding goto on the vts
repo while config pinned clangd for a UE tree) > forced `VTS_BACKEND`/config `backend` > `backendForPath(a.path)` >
`pickBackend(root)`. A path-less query (search_symbol by name) keeps the forced backend. Eval guard 55.
  CENSUS FALLBACK (core.js `censusFallbackBackends`): a path-less query keeping the forced/root backend is the
  mixed-repo hole — clangd (root) answers 0 for a Python symbol and the model abandons vts. So when the primary
  backend's `search_symbol` comes back EMPTY on a path-less, non-explicit query, retry against the OTHER backends
  the `languageCensus` shows have files (most-code-first) BEFORE the syntactic/literal fallback — still the EXACT
  rung, just from the right LSP. Gated: `!a.path && !a.backend`, count ≥ `VTS_CENSUS_FALLBACK_MIN` (1),
  `VTS_CENSUS_FALLBACK=0` off; no cost on a single-language repo (census returns no other candidate). Eval guard 90.
  Override via `VTS_CLANGD_CMD/ARGS`,
  `VTS_ROSLYN_CMD/ARGS`, `VTS_TS_CMD/ARGS`, `VTS_PY_CMD/ARGS`. `winShell` flag spawns the npm `.cmd`
  shims (ts/pyright) through a shell on Windows. `langIdForPath` (lsp.js) maps file ext → LSP languageId.
  `findProjectRoot(start)` — bounded walk UP from a file to the nearest project marker (compile_commands/
  *.uproject/.sln/.csproj/tsconfig/package.json/pyproject/…/.git as the repo-boundary fallback; nearest
  dir wins, never climbs past a `.git`). Feeds `resolveRoot` (core.js) so a per-call `path` pins the right
  repo on a globally-installed server.
- `server/core.js` — `runTool()` dispatch, token-cap formatters, savings ledger. Tools: `search_symbol`,
  `find_references` (accepts EITHER a 0-based `path`+`line`+`character` position OR a `symbol` NAME — the
  code-modification primitive: by-name resolves the decl via `c.symbol` [exact-name-then-`path`-endsWith
  ranking], `didOpen`s it, queries references at `location.range.start`; no indexed decl → `scanTextUnder`
  literal-usage fallback. Discover showed name-driven usage hunts = the top bypass; this collapses the
  locate→position→refs dance that pushed the model to grep. CALL-HIERARCHY FOLD: a `direction=callers|callees`
  param turns the SAME tool into a MULTI-HOP call hierarchy [transitive callers = blast radius before an edit /
  callees] to `depth` hops [`VTS_TRACE_MAX_DEPTH` 5, node cap `VTS_TRACE_MAX_NODES` 80] via `lsp.js`
  prepareCallHierarchy→incoming/outgoingCalls [graceful -32601→[], `traceFrom` DFS w/ cycle+dedup guard, indented
  file:line tree]; codebase-memory-mcp `trace_path` parity but on the OFFICIAL LSP [zero-transmission, real
  semantic edges] and folded INTO find_references — NOT a new tool [no fixed-surface cost, reuses the symbol→pos
  resolution]. `vts trace-calls` CLI = `references --direction callers`. Eval guard 70; live-verified on the vts
  repo itself. NAV STEER (`refNavSteer`): a LARGE flat ref result (> cap or ≥`VTS_REF_NAV_MIN` 25) with no
  `detail=` appends a one-line nudge to the CHEAPER views of the same set — `detail=file`/`dir` (per-file
  blast-radius summary) or `direction=callers` (transitive caller tree); `VTS_REF_NAV=0` hides), `goto_definition` (a `kind` param folds in
  `type_definition`/`implementation`/`declaration` via `lsp.js gotoByKind` → 3 more LSP nav requests, NO new
  MCP tools), `hover`, `document_symbols`, `diagnostics` (compiler/linter errors+warnings for a file as a
  token-capped `file:line:col severity [code]: msg` list, sorted error→hint + count summary — the compact
  alternative to reading raw build output; `lsp.js diagnosticsFor` stores publishDiagnostics PER-uri since
  `notified` only keeps the last, waits briefly for the first publish after didOpen; eval guard 63),
  `rename` (LSP; preview by default, `apply=true` writes); SYMBOL-LEVEL EDITING (Serena-parity, the mutating
  set — all preview-by-default, `apply=true` writes): `replace_symbol_body` / `insert_symbol`
  (`position=after`[default]`|before` — the after/before inserts MERGED into one tool to shrink the surface) /
  `safe_delete` — `resolveSymbolForEdit` (core.js) resolves a declaration by NAME via
  the LSP outline (`documentSymbol`'s `.range` = whole body, `.selectionRange` = name; `path` pins the file
  else the index resolves it, optional `line` disambiguates), then splices text at the span via
  `applyEditsToText` (`symbolEditResult` shared preview/apply, reuses the rename read-only/Perforce note).
  `safe_delete` refuses while the symbol is still referenced (refs at the name) unless `force=true`. Token win:
  edit by naming a symbol instead of Read-ing the whole file + line-counting for an exact-match Edit. Eval guard
  52; `find_files`, `search_text`
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
  CLI `vts git/p4` are full arg passthrough → run in cwd, no `--projectPath`). MCP-SURFACE FOLD: the 9 cold
  admin/meta tools (`vts_git`/`vts_p4`/`vts_setup`/`vts_config`/`vts_savings`/`vts_savings_reset`/`vts_discover`/
  `vts_warmup`/`vts_gen_compile_db`) are NO LONGER advertised individually — they're folded behind ONE
  `vts_admin{op,params}` MCP tool (index.js maps `vts_admin`→`runTool("vts_"+op,params)`; hot search/nav/edit
  tools stay first-class so the model still reaches for them). core.js runTool + the CLI keep the individual
  `vts_*` names UNCHANGED (the grep-block hook still reroutes git/p4 to the CLI, not this tool); eval guard 62.
  FOOTPRINT SLIM (v0.37.2 — vts's OWN MCP usage measured at ~24%, mostly the per-request tool schema): the
  self-evident common params (`projectPath`/`backend`/`maxResults`) carry NO description (shared `ROOT`/
  `BACKEND`/`CAP` consts in `tools.js`), tool descriptions trimmed (adoption "USE INSTEAD OF" + routing cues
  KEPT) → tool-list schema 3455→2723 tok (−21%, recurring every API call); guard 62 cap 3500→2900. Also the
  per-RESULT `completenessCert` rung lines + `EMPTY_HINT`/`LOG_STEER` and the SessionStart `routingDigest`
  (policy.js) are trimmed ~40-50% (rung keywords + the one actionable command kept; guards 76/16/digest green).
  The folded ops: `vts_warmup`, `vts_setup`,
  `vts_config`, `vts_savings` (RTK-gain-style: `graph`/`daily`/`history` + est. USD over timestamped day
  buckets; ALSO FOLDS IN the bundled gamedev-log-analyzer's ledger [`~/.gamedev-log-analyzer/savings.json`,
  `VTS_GAMEDEV_SAVINGS_FILE` override] → a `+ gamedev-log-analyzer (logs)` line + a COMBINED total, since its
  log-compaction saves toward the same goal; the dashboard `/data` does the same via `savings.sources`. Local
  file read only), `vts_savings_reset`, `vts_discover` (scans `~/.claude/projects/*.jsonl` for code searches that
  BYPASSED vts → missed-token report + catch-rate; `learn=true` feeds their result files into the warm-set;
  ALSO MEASURES THE EDIT HABIT — `classifyDeclEdit` (server/edit-detect.js, SHARED with the enforcement hook)
  flags a built-in Edit/MultiEdit whose `old_string` is a whole declaration (replace → `replaceDecl`) OR whose
  `new_string` is (add → `insertDecl`) on a code file (≥`VTS_EDIT_MIN_LINES`+decl cue). CONTROL-FLOW EXCLUSION
  (dogfood-found FP): a `) {` opener also matches `if/for/while/switch/catch (…) {`, so `isWholeDecl` now only
  counts the opener when the callee identifier is NOT a reserved control-flow keyword (else a multi-line
  `if(…){…}` block edited inside a body was flagged a whole decl → suggested `replace_symbol_body symbol="if"`,
  not a named symbol); the hook's `declSymbolName` likewise refuses a reserved keyword as the symbol name. v0.26.2
  GENERALIZED it: the construct is decided by the chunk's FIRST meaningful line — a `CTRL_FLOW_FIRST` header
  short-circuits to false BEFORE the DECL_KW check, so an `if(…){ (void)x; … }` / `if(…){ static int n; … }`
  block (DECL_KW `void`/`static` in the BODY) no longer false-positives (the v0.26.1 callee guard only covered
  the signature-opener branch). Eval guard 59. It attributes that
  file's PRIOR Read tokens [`reads`/`readUse` Read↔Edit correlation in `scanBypasses`, read counted ONCE] = the
  read a symbol-edit would've skipped → `edit habit:` line; ALSO `editUnreached` = how many had NO prior vts
  search on that file [`searchUse`/`searchedBn` basename match] = the fraction the search-result steer CAN'T
  reach. Measured 30d: 1284 whole-decl edits, ~468k tok read-first, 1194/1284 (93%) search-unreachable). STEER
  is THREE layers, soft→hard (Edit-rewrite impossible: cross-tool `updatedInput` can't switch Edit→MCP, and the
  read is sunk by Edit time so a block recovers nothing — only a LEARNING signal): (B) `EDIT_STEER` on a FOCUSED
  `search_symbol` (≤`VTS_EDIT_STEER_MAX` 10) / `goto_definition` result (`VTS_EDIT_STEER=0` hides); (L1) the
  grep-block hook now also matches `Edit|MultiEdit` — a whole-decl replace/insert gets a MODEL-VISIBLE
  `emitWarn` with a READY symbol-edit call (`replace_symbol_body`/`insert_symbol`, `declSymbolName`
  best-effort names it), `VTS_EDIT_WARN=0` off; (L1-Bash) the hook ALSO catches a code-file edit done via
  BASH — `sed -i`, an `awk` inplace/redirect, or a `python`/`perl` heredoc that opens a code file for write
  (`isBashCodeEdit`: a code-ext path AND an explicit write/in-place signal must BOTH be present, so a
  read-only `sed` pipe or a `python build.py` isn't nagged) — warn-only toward replace_symbol_body/
  insert_symbol; the Edit-tool steer alone MISSED this (a python brace-match splice bypasses it — live-found
  on a large irregular-indent function), and Bash file-surgery is a big slice of the low symbol-edit adoption;
  (L2) OPT-IN escalation, `VTS_EDIT_BLOCK_AFTER` DEFAULT 0=OFF — set ≥1 and once the
  adoption ledger's ignore-`streak` hits it, a SAFE insert (`insertDecl && !replaceDecl` — `insert_symbol`
  can't corrupt) is BLOCKED ONCE (exit 2) then `resetStreak()` (fire-once, NOT a wall — a permanent block
  TRAPPED the agent: it fought the wall with Edit retries / code contortions instead of switching, and each
  blocked attempt re-escalated the streak; live-reproduced on US editing edit-ledger.js); a replace stays warn. ADOPTION LEDGER (server/edit-ledger.js, `~/.vs-token-safer/
  edit-adoption.json`, `VTS_EDIT_LEDGER` override): hook records `builtin-warn` (streak++), core.js records
  `symbol-edit` on every symbol-edit dispatch (streak→0); `hooks/edit-report.js` (SessionStart) re-injects the
  adoption % as a goal = the SkillOpt-style measure→re-inject loop (static skill can't self-improve, a
  re-injected live metric can). Eval guards 53 (steer+discover) + 54 (L1/L2 hook); `eval/test-edit-steer.mjs`.
  `find_files`/`search_text` write a recovery TEE file (`VTS_TEE_DIR`, default on-truncate) when a result is
  capped so the full set is recoverable without re-running; a capped `search_symbol`/`find_references`
  ("… N more") tees too (`teeOverflow` — the rows are already in memory, no re-query). The ledger
  aggregates PER TOOL (`by tool:` line in `vts savings`) so you can see where the win comes from. BOOT AUTO-LEARN (`index.js`, `VTS_AUTO_LEARN`
  default on when projectPath set): 3s after boot, `autoLearn(root, 7)` (core.js, shares `scanBypasses`
  with discover) harvests bypassed-search result files into query-history — the self-improvement loop runs
  unattended every server start.
- `agents/code-locator.md` — context-isolated locator subagent (delegates a lookup, returns only file:line).
- `server/compact.js` — PURE output-compaction fns (`compactGit`/`compactP4`, string→string, no spawn) for the
  `vts_git`/`vts_p4` wrappers. Eval exercises them on canned input (deterministic). (No grep compaction here —
  grep reroutes to search_text, which scans + token-caps itself; there is no raw grep output to compact.)
- `server/viz.js` + `server/serve.js` + `server/dashboard.html` + `server/vendor/` — LOCAL DASHBOARD (`vts
  serve`, cbm-style viz but local-only/zero-transmission). `viz.js` `buildVizData(root)` assembles the savings
  ledger + language census + include-graph cache into one model; `renderDashboardHtml()` reads the SELF-CONTAINED
  `dashboard.html` (CSS/JS inlined; **3D graph via Three.js** rendered WebGL). NO CDN — Three.js is VENDORED at
  `server/vendor/three.module.min.js` (MIT, r160) and served SAME-ORIGIN (`/vendor/...`); the page imports it
  relative, so nothing leaves the host. `serve.js` is node:http ONLY (no express/ws), binds `127.0.0.1` (never
  0.0.0.0), routes `/`→html · `/data`→JSON (include graph) · `/callgraph?symbol=&direction=&depth=`→JSON
  (ON-DEMAND call graph via `core.js buildCallGraph` = LSP callHierarchy live, NOT a persistent semantic DB —
  the cbm-parity "call graph" view our charter allows; nodes carry `calls`/`calledBy`/`repo`, edges a call-site
  `count` [fromRanges], + `totalCallSites`) · `/symbols?q=`→JSON (`core.js listSymbols` = workspace/symbol
  autocomplete for the search box) · `/vendor/<allowlisted file>`. `core.js repoLabelFor` (findProjectRoot →
  basename) tags every node with its repository. The 3D viz: two modes (include / call-graph-by-symbol with live
  symbol autocomplete dropdown), **spherical-SHELL layout** (radius ∝ node count+footprint, radius-aware collision
  so orbs don't clump/overlap), `color:` **groups** (union-find connected components) / **repo** (per-repository
  hue + legend) / **heat**, **click-to-drill-into-a-group** (Esc/Backspace pops out), focus/maximize + keyboard
  camera (WASD/arrows/+-/R/Esc), distance-scaled labels, highlight filter, metrics overlay (incl. call counts). OPT-IN + CLI-ONLY: started only by
  `vts serve` (cli.js special-cases it — long-running, `--open` launches the browser, `--stop`/SIGINT stop via a
  pidfile), NEVER by the MCP server, so the steady-state package stays a thin stdio client. Easy open/close via
  the **`skills/vs-viz`** skill + **`commands/viz.md` / `commands/viz-stop.md`** (`/vs-token-safer:viz[-stop]`).
  `VTS_VIZ_MAX_NODES` (200) bounds the graph. Eval guards 72 (dashboard + server) + 73 (buildCallGraph + /callgraph).
- `server/cli.js` — `vts <cmd>`. `server/index.js` — MCP server (async handler → `await runTool`). PER-CALL
  ROOT: `resolveRoot(a)` (core.js) replaces the old single-pin `a.projectPath || PROJECT_PATH || cwd` for
  every query — precedence: explicit `projectPath` > a `path`'s enclosing project (`findProjectRoot`, only
  when OUTSIDE every known root so an inside-path keeps clangd's compile-DB rooting) > an MCP workspace root
  > `PROJECT_PATH` > cwd. `resolveCwdRoot(a)` for git/p4 (MCP root beats server cwd; pin still ignored). One
  global server now serves every repo a session touches, not just the pinned one. index.js does the MCP
  `roots` handshake (`getClientCapabilities`→`listRoots`→`setMcpRoots`, re-fetched on `roots/list_changed`,
  undefined-safe on old SDKs); no roots advertised → collapses to the old `PROJECT_PATH || cwd`. Boot
  prewarm/auto-learn use `PROJECT_PATH || first MCP root` so a config-less install warms the current
  workspace (ONE root only). BACKEND POOL (memory guard for dynamic roots): the `clients` map is BOUNDED —
  `VTS_MAX_BACKENDS` (2) LRU-evicts the least-recently-used idle client past the cap, `VTS_BACKEND_IDLE_MS`
  (300000, 0=off) reaps idle clients via an unref'd sweep; a client with an in-flight request (`pending.size`)
  is never evicted/reaped. Steady state ≈ 1 warm backend; bouncing 2 repos keeps both warm; a 3rd evicts LRU.
  `__pool` test surface + eval guards 45 (pool) / 46 (root resolution).
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
  allows `| ^ #` (always double-quoted; `$`/space/backslash still rejected). `grepNudgeFor` embeds a
  READY-TO-USE equivalent call (identifier→search_symbol, regex→search_text) in every Grep nudge/block.
  GREP-TOOL enforcement v2 (A+) + v2.1: a clear SYMBOL HUNT is BLOCKED (exit 2) and routed to search_symbol/
  search_text per `isSymbolHuntGrep` — (1) a bare identifier, (2) a regex with a code-structural cue (`::` /
  literal `(` / `void·class·struct·enum·template`), OR (3) **v2.1** an ALTERNATION (`A|B|C`) carrying a
  CamelCase/snake identifier (`MaxWalkSpeed|MaxExcessSpeed`, `get_value|set_value`) — the top measured bypass
  (UE type/symbol enumeration). KEPT as warn (false-positive-safe): freeform single tokens, AND keyword
  alternations (`TODO|FIXME`/`GET|POST` — ALL-CAPS, no lower→upper transition, so no CamelCase signal). The
  reroute is search_text (same regex, token-capped) → no wrong/missing results, just friction. `VTS_GREP_BLOCK=0`
  reverts all of it to warn-only. Measured: v2 block ~172k tok/30d; v2.1 adds ~319k (CamelCase alternation).
  GLOB/Search TOOL (filename search) **v2.2**: a CONCRETE code-file glob (`*.cpp` / `Foo.h` / `**/Bar.*` per
  `isBlockableGlob`) is BLOCKED → `find_files` (which is a DIFFERENT tool — can't updatedInput-rewrite a Glob —
  so it's a block with a ready-to-use `find_files q=… projectPath=<dir hint from the glob/path>`); a bare
  `*`/`**/*` or code-DIR glob stays a warn. The warn alone was IGNORED — the model kept Glob-ing a giant UE tree
  and narrowing the path instead of switching (live dogfood). find_files/search_text are walk-BOUNDED: shared
  `SKIP_DIRS` (node_modules/Intermediate/Binaries/Saved/build/… ) + a 4s time box so a huge tree can't hang them.
  FIND-DIR FIX (v2.2): a Bash `find <dir> -name X` rewrite now HONORS `<dir>` as the find_files root
  (`extractFindDir`) — it was dropped, so `find /abs/UE/path -name X` searched the configured vts repo and falsely
  reported "No files" (a live correctness bug on a UE worktree). `vts discover` also counts the Glob tool as a
  find_files bypass. FILE-OPS FIND FP FIX (v0.33.14): a `find` doing FILE-OPS — its own `-exec`/`-delete`/
  `-type d` (`isFindFileOps`), or alongside a file-op exec in the same command (`hasFileOpsContext`:
  cp/mv/tar/rsync/xargs/zip/du/… — a backup/copy `du …; find … -name "*.cpp"`) — is NOT a code search →
  never blocked AND never rerouted to a (token-CAPPED) find_files, which would silently drop files from a
  copy/delete. A genuine code-file `find -name "*.cpp"` with no file-op still rewrites to find_files. Live-found:
  a UE-depot backup find got blocked + the capped reroute would corrupt the backup. grep stays strict (a literal
  grep in a pipeline is usually content filtering). Eval guard 17b. `VTS_REWRITE=0` → block
  instead of rewrite; `excludeCommands` (config) / `VTS_EXCLUDE_COMMANDS` (csv) opt a command out; escape hatch
  `VTS_ENFORCE=0`. Messages i18n'd (`uiLang()`: Korean when `VTS_LANG`/config `lang`=`ko` OR OS locale `ko-*`,
  else English; `VTS_LANG=en|ko` forces). Copy is AGENT-DIRECTED — the actionable part instructs the assistant
  ("re-run with the vts tool matching the intent" + the concrete call), with a brief human-facing reassurance
  that the red box is a redirect ("hold on"), not a failure — the hook output is consumed by the MODEL, which
  is the one that re-runs, not a human picking from a menu.
- `skills/vs-search/SKILL.md` — routing. `commands/{setup,savings}.md`.
- `eval/run.mjs` + `eval/_mock-lsp.mjs` — mock-LSP eval (no toolchain). Add a guard for every new path.
- Config dir `~/.vs-token-safer`, env prefix `VTS_`. MCP server name `vs-search`.

## Conventions (inherited — non-negotiable)
- **Token-first.** Every feature must keep/raise the token win. Output is `file:line`, capped, no bodies.
  Add an `eval/run.mjs` guard for anything new.
- **No proprietary leak.** Never put real paths/symbols/company names in the repo or commits; sanitize;
  scan tree + git log before any push. Eval/docs use synthetic names only.
- **Security/local-only.** No network calls; nothing transmitted. PRIVACY.md says so.
- **Release/branch workflow — gitflow.** Branches: **`main`** = production (tagged releases ONLY, always
  shippable) · **`dev`** = develop/integration · **`feature/<slug>`** (off `dev`) · **`hotfix/<slug>`** (off
  `main`) · optional **`release/<x.y>`** (stabilize before a big minor/major). **Bump level is decided by
  Conventional-Commit type, NOT by batch size** (`node scripts/bump.mjs <major|minor|patch>`):
  `feat:` → **minor** · `fix:`/`perf:`/`refactor:`/`docs:`/`chore:` → **patch** · `!`/BREAKING → **major**.
  ONE release = ONE coherent theme — do NOT lump unrelated fixes into a minor.
  - **Feature flow:** `feature/<slug>` off `dev` → squash-PR into `dev` → accumulate. When a theme is ready,
    one **`dev → main` PR** (`Closes #N`, "Review points") → squash-merge → on `main` bump **minor** (or major)
    + `git tag -a v<x>` → push tag (release.yml publishes) → resync `dev` to `main`. **Release-note rollup:** for a
    **minor/major** release, curate the GitHub release notes (`gh release edit v<x> --notes-file -`) to ROLL UP the
    preceding patch line — a brief, theme-grouped summary of every `x.y.z` since the prior minor, then this release's
    own changes on top (see v0.35.0). A patch release's notes can stay terse (its own change).
  - **Hotfix flow (urgent prod fix — keeps minors clean):** `hotfix/<slug>` off **`main`** → PR into `main` →
    bump **patch** + tag IMMEDIATELY (do NOT wait for / bundle into the next minor) → merge `main` back into
    `dev`. A standalone non-urgent fix is still its OWN `fix:` patch PR, not a passenger on a feature minor.
  - Every PR is green on CI (eval/lint/validate, Ubuntu+Windows) before merge; resyncing `dev` to `main` after
    a squash needs `git push origin main:dev --force-with-lease` (ask before force-pushing the shared branch).
  **No npm publish from this repo** — the gamedev-log-analyzer npm
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
    parse fine; only the full game-TU header chain trips 19.x. The clangd path is a first-class CONFIG key
    `clangdCmd` (in `CONFIG_KEYS`; `vts_setup`/`vts setup --clangdCmd <path>` persists it, so a setup click
    survives restart WITHOUT editing the user's OS env) — `backends/index.js` `cfgCmd()` resolves it as
    `VTS_CLANGD_CMD` env > config `clangdCmd` > `clangd`. Eval guard 57. The `commands/setup.md` flow now
    presents unmet C++ prereqs (no compile DB / no clangd ≥ 22) as `AskUserQuestion` clickable choices, not a
    free-text prompt — generate-DB routes to `vts_setup { genCompileDb }`, clangd path to `{ clangdCmd }`.
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
- **output cap v2 — collapse repetition (caveman-inspired).** `fmtLocations` (find_references + any
  multi-location result) no longer prints one line PER location — a refs-heavy result repeats the same long
  path on every row. `compactLocationLines` groups by FILE (one row, all line numbers joined/deduped/sorted:
  `Foo.cpp:42,88,120`) then `commonDirPrefix` factors the shared directory tree out once (`under <prefix>/`
  + relative tails). Every location preserved + recoverable (full path = prefix + tail). Est. ~4× (coalesce)
  → ~10× (prefix) on a deep UE refs result. `VTS_COMPACT_RESULTS=0` restores the classic `  @ path:line`.
  fmtSymbols/search_text keep per-row (distinct payload each). eval guard 47.
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
- **search_text → symbol steer (dogfood-found).** `core.js` `symbolHuntInText(q)` pulls the hunted NAME from a
  TEXT query that is really a symbol/class usage hunt — a `Foo<Bar>` template arg (the `<Type>` wins), a `::`
  scope, or the longest CamelCase/snake identifier; null for `TODO|FIXME`/prose. `textSymbolSteer(q,truncated)`
  appends a one-line nudge to `find_references symbol="X"` / `search_symbol q="X"` (semantic, COMPLETE, no 4s
  time-box, ~10–20× smaller). The steer now LEADS the output (top, not trailing under 60 matches — the model
  acts on the first lines it reads) and fires on a TRUNCATED scan, a `<>`/`::` cue, OR a BARE identifier (the
  whole query is one symbol — the case the model keeps reaching for instead of the semantic tool). ALTERNATION
  (`altSymbols(q)`, GENERAL over `|`, any N): `A|B|C` of CamelCase/snake identifiers → steers to `find_references`
  PER symbol (find_references can't take a regex; search_text matched the whole alternation as full line text) —
  lists each (cap 6 shown + "+N more"); a keyword/ALL-CAPS alternation (`TODO|FIXME`, `GET|POST`) is NOT a symbol
  list → spared. The EMPTY-but-timed-out branch also steers AND flags that a `0` from a truncated walk is NOT
  conclusive. `VTS_TEXT_STEER=0` off. Born live: `search_text "FindComponentByClass<UMyComp>"` → 8-of-49 slice,
  `find_references` all 49 at 19×; and a UE `search_text "GetSyncModeComponent|GetSmoothSyncComponent"` that a
  single search_symbol can't answer (regex) → per-symbol find_references. Eval guard 58 (`symbolHuntInText` +
  `altSymbols` unit + integration).

## Identity (what we are) — and the roadmap rule it implies
vs-token-safer is not "a code search tool." It is the layer an agent talks to instead of reading the
repository. You ask where something is, what calls it, or — when you don't know the name — what the auth flow
is, and it hands back the smallest faithful answer (a capped `file:line` list, no bodies) instead of letting
raw source flood the context window. It answers at the highest precision it can reach and tells you which rung
it's on:
- **exact** when the name is known and a toolchain is present → the language server (semantic, ground truth);
- **syntactic** when there's no toolchain → tree-sitter (zero setup, 36 langs);
- **fuzzy** when only the intent is known → a concept dictionary mined from the repo's own naming (no embeddings);
- **section-level** when it's a doc/config, not code → Markdown/TOML/YAML/CSS/HTML/… addressed by heading/selector.

UNIFIED PRECISION LABEL: every answer carries ONE `completenessCert(...)` line that names the RUNG it came from —
`EXACT rung` (semantic), `SYNTACTIC rung`, `FUZZY rung`, `SECTION rung` — plus the coverage state a capped/
timed-out answer of any rung falls through to (`PARTIAL` / `INCONCLUSIVE`). So the model always sees exactly which
rung answered, never a fuzzy result mislabeled syntactic. The `INCONCLUSIVE` advisory is ACTIONABLE — it names the
auto-scope commands (`vts setup --scope <module>`, then `vts preindex`) because a bounded walk on a big tree is
exactly the case a scoped index fixes. `core.js completenessCert({semantic|syntactic|fuzzy|section|scoped})`; the
viz tiers/certs legend mirrors the 4 rungs + 2 coverage states (`server/viz.js`). `VTS_CERT=0` hides it. Eval guard 76.

Three things make it ours, and none of them is a backend: (1) it covers the WHOLE repo an agent sees — code,
the "I don't know the name" case, and documents; (2) every answer is capped to `file:line`, labeled with its
precision (the completeness certificate), and the swap to it is ENFORCED, not merely offered; (3) it's all
local — official engines, no embeddings, nothing transmitted. The name fits: "token-safer" is a safety device
for the context budget, which is why it survives growing past C++/C# into fuzzy and docs (the naming umbrella).

**Roadmap rule.** A feature earns its place one of two ways: it adds a rung to the precision ladder (a new way
to answer when the agent knows more, or less, about what it's after), or it covers more of the repo (a new file
type, a new kind of question). It must never break the three things that make the tool worth trusting — the
answer stays capped, it stays honest about precision, and nothing leaves the machine. Judge every proposal by
"which rung / which surface, and does it keep the discipline" before anything else.

## Next (see wiki "Status and TODO")
P1 DONE: core rename, `index.js`/`sdk.js`/`ensure-deps.mjs`, grep-block `hooks/`, `skills/`+`commands/`,
`.claude-plugin/*`+`.mcp.json`, README EN/KO + PRIVACY/SECURITY/CONTRIBUTING/CoC/BENCHMARK, `.github` CI,
lint/prettier configs, `bump.mjs`. P1 remaining: `gh repo create JSungMin/vs-token-safer --public` +
push; optionally **bundle gamedev-log-analyzer** as a 2nd marketplace plugin. P2: live-verify clangd
then roslyn on real projects.
