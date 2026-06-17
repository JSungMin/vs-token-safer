---
description: Routing rules for code search in C/C++, C#/.NET, JS/TS, and Python projects via vs-token-safer — use the vs-search MCP tools (clangd/Roslyn/tsserver/pyright language-server index) or the `vts` CLI instead of Bash grep. Use whenever searching for a symbol, definition, function, variable, type, or finding references/usages in a C/C++, C#/.NET (incl. Unreal, Visual Studio), JavaScript/TypeScript, or Python codebase.
---

# vs-token-safer search routing

Code search runs through an OFFICIAL language server's index (clangd for C++, a Roslyn-based LSP for
C#) and the result is token-capped to a compact `file:line` list — no source bodies. No IDE needs to
be open; the engine is spawned headlessly. Karpathy-style rules: do the listed thing, do not improvise.

## Tools (MCP server name: `vs-search`)
- Symbol / class / function / type / variable → `search_symbol`  (args: `q`, `projectPath`, `backend`, `maxResults`). Never `grep`/`rg` for this.
- References / usages of a symbol → `find_references`  (args: `path`, `line`, `character` — 0-based — `includeDeclaration`). Semantic, not a text match.
- Definition of a symbol → `goto_definition`  (args: `path`, `line`, `character` — 0-based).
- Type / signature at a position → `hover`  (args: `path`, `line`, `character`).
- Outline a file (its classes/functions) → `document_symbols`  (args: `path`).
- Rename a symbol project-wide → `rename`  (args: `path`, `line`, `character`, `newName`, `apply`). Semantic (every reference), not a `sed`. Preview by default; `apply=true` writes the edits.
- **Add / replace / delete a WHOLE declaration → edit it by NAME**, don't Read-the-file-then-Edit:
  - Replace a function/method/class body (signature included) → `replace_symbol_body`  (args: `symbol`, `body`, optional `path`/`line`, `apply`).
  - Add a sibling declaration after/before one → `insert_after_symbol` / `insert_before_symbol`  (args: `symbol`, `text`, `apply`).
  - Remove a declaration → `safe_delete`  (args: `symbol`, `force`, `apply`). Refuses while it's still referenced unless `force=true`.
  - The outline supplies the exact span, so you skip reading the whole file into context. Preview by default; `apply=true` writes. Use the built-in Edit for a sub-declaration tweak (a few lines inside a body); use these when the unit is the whole declaration.
- Raw text / string / comment / config key (the symbol index can't answer) → `search_text`  (args: `q`, `projectPath`). Token-capped; the sanctioned grep replacement.
- File by name (substring or glob) → `find_files`  (args: `q`, `projectPath`). Replaces `find -name`.
- Admin/meta (rarely needed reflexively) → `vts_admin` with an `op`: `config`/`setup` (settings), `savings`/`savings_reset` (token ledger), `warmup` (pre-build the index), `discover` (find searches that bypassed vts), `gen_compile_db` (UE clangd DB), `git`/`p4` (read-only VCS, output compacted). Put the op's args in `params`, e.g. `vts_admin {op:"git", params:{argv:["status"]}}`. (CLI keeps the bare subcommands: `vts setup`, `vts git`, …)
- **Log file** (`.log`/`.jsonl`, or a `Logs/` dir) → NOT a vs-search tool. The language-server index covers
  source, not logs — use **gamedev-log** (`/gamedev-log-analyzer:logs`). vts-search results aimed at a log
  carry a one-line pointer there.

Delegate a whole "where is X / what calls Y / find file W" lookup to the **`code-locator`** subagent —
it runs the searches in its own context and returns just the `file:line` table, so the matches never
land in yours.

CLI equivalent (no MCP needed): `vts symbol --q <name> --projectPath <root>`,
`vts references --path <file> --line N --character N`, `vts definition --path <file> --line N --character N`,
`vts hover …`, `vts symbols --path <file>`, `vts text --q <pattern>`, `vts files --q <glob>`.

## Backends & projectPath
- Backend auto-detects from the project root (strongest build-artifact first): `compile_commands.json`
  (or a `.uproject`) → **clangd**; a `.sln`/`.csproj` → **roslyn**; a `tsconfig`/`jsconfig`/`package.json`
  → **typescript** (tsserver); a `pyproject.toml`/`*.py` → **pyright**. Override with
  `backend=clangd|roslyn|typescript|pyright` or env `VTS_BACKEND` when a root carries more than one.
- Set the root via `projectPath` or env `VTS_PROJECT_PATH` (default: cwd).
- **clangd needs `compile_commands.json`.** Unreal: generate via UBT
  `-mode=GenerateClangDatabase`; CMake: `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`. Without it, clangd
  indexes nothing useful — tell the user to generate it.
- **roslyn** defaults to the `csharp-ls` dotnet tool; point `VTS_ROSLYN_CMD`/`VTS_ROSLYN_ARGS` at
  `Microsoft.CodeAnalysis.LanguageServer` for the exact Visual Studio engine. Currently best-effort.
- **typescript** (JS/TS) and **pyright** (Python) ship as plugin deps and auto-install — no setup. vts
  launches the bundled copy with `node`. Override via `VTS_TS_CMD`/`VTS_PY_CMD`.

## Truncated results
Symbol/reference lists are capped at `maxResults` (default 60). A trailing `… N more` means the set
was truncated — raise `maxResults` or narrow the query. For refactors/renames that must touch every
call site, raise the cap (or narrow with a more specific symbol) before acting; don't act on a
partial set and claim it's complete.

## Why
- The language-server index resolves symbols semantically (no full-tree scan) and the result is
  token-capped to `file:line` — far less raw source reaches the model than grep-and-paste.
- grep over a large UE/.NET codebase floods context with thousands of lines; this caps the response.
- Caveat: on Unreal C++, `search_symbol` quality depends on `compile_commands.json` being current.
  Verify the result; regenerate the compile DB if a known symbol is missing.

## Fallback
If a `vs-search` tool errors (engine missing/failed to spawn): clangd not installed → install LLVM
clangd; roslyn not installed → `dotnet tool install --global csharp-ls`; typescript/pyright not found →
re-run the session so the bundled deps reinstall (or set `VTS_TS_CMD`/`VTS_PY_CMD`). Until the engine works,
code-grep is blocked by the hook — the user can set `VTS_ENFORCE=0` to allow grep as a fallback. Do
not loop on blocked grep; surface the fix and move on.
