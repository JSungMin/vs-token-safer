---
description: Configure the vs-token-safer plugin (project path, backend, result cap). Writes ~/.vs-token-safer/config.json and tells you to /reload-plugins.
---

# vs-token-safer — setup

Configure the plugin by writing its config file (`~/.vs-token-safer/config.json`), which the CLI and
MCP server read at startup. Use the `vts_admin` MCP tool (server: `vs-search`) with an `op` +
`params` — the admin/meta ops (`setup`, `config`, …) are folded behind it, e.g.
`vts_admin { "op": "setup", "params": { "projectPath": "<root>" } }`. Do NOT edit the user's OS environment.

Steps:
1. **Show current settings:** call `vts_admin { "op": "config" }`.
2. **Detect/confirm the backend.** Backend auto-detects from the project root:
   - C/C++ → needs `compile_commands.json` in (or under) the root → **clangd**. Unreal: generate via
     UBT `-mode=GenerateClangDatabase` (add **`-Compiler=VisualCpp`** if the targets build with clang-cl,
     else clang-toolchain validation fails); CMake: `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`.
     **Use clangd ≥ 22** — the VS-bundled clangd 19.1.x deadlocks indexing Unreal TUs; if vts prints a
     clangd-version advisory, point `VTS_CLANGD_CMD` at a current clangd (https://github.com/clangd/clangd/releases).
   - C#/.NET → a `.sln`/`.csproj` → **roslyn** (default engine `csharp-ls`; install with
     `dotnet tool install --global csharp-ls`, or point `VTS_ROSLYN_CMD` at MS C# LSP).
   - JS/TS → a `tsconfig`/`jsconfig`/`package.json` or `*.ts/js` → **typescript** (bundled
     `typescript-language-server`, auto-installed). Python → `pyproject.toml`/`*.py` → **pyright**
     (bundled, auto-installed). Nothing to install for these two.
3. **Gather values** (ask one at a time, or an `AskUserQuestion` for the common ones):
   - `projectPath` — default project root (where the compile DB / .sln / package.json lives).
   - `backend` — `clangd` | `roslyn` | `typescript` | `pyright` (omit to auto-detect).
   - `maxResults` — cap on returned `file:line` locations (default 60).
   - `prewarmBackends` — `auto` (warm the dominant backend) | `all` (warm every language present, each in
     proportion to its file count) | a comma list. Omit it: `vts_admin { op: "setup" }` runs a **language
     census** of the root and picks `auto` for a single-language repo or `all` for a multi-language one automatically.
4. **Apply:** call `vts_admin { "op": "setup", "params": { … } }` with only the keys to change, e.g.
   `vts_admin { "op": "setup", "params": { "projectPath": "<root>", "backend": "clangd" } }`. It reports the
   detected language mix (e.g. `clangd(820), typescript(40)`) and the `prewarmBackends` it chose.
5. **Unmet C++ prerequisites → present clickable choices, don't ask in prose.** When the clangd backend
   is missing `compile_commands.json` and/or a clangd ≥ 22 binary, the user should **click**, not type. Use
   the **`AskUserQuestion`** tool — one question per missing prerequisite, each with concrete options:
   - **compile_commands.json missing** → question "Generate the C++ compile database now?" options:
     - `Dry-run first (Recommended)` → call `vts_admin { op: "setup", params: { genCompileDb: true } }` (prints
       the exact UBT `GenerateClangDatabase` command, runs nothing) — show it, then re-ask to apply.
     - `Run it now (apply)` → `vts_admin { op: "setup", params: { genCompileDb: "apply" } }` (heavy: indexes
       engine headers, minutes, needs clangd ≥ 22). DB parks out-of-tree (`~/.vs-token-safer/db/<project>`), git/p4 never see it.
     - `Skip — I'll generate it myself` → leave as-is (text fallback stays active).
   - **clangd ≥ 22 not on PATH** → question "clangd binary?" options:
     - `Point vts at an installed clangd` → ask for the path, then
       `vts_admin { op: "setup", params: { clangdCmd: "<path>" } }` (writes `VTS_CLANGD_CMD`).
     - `I'll install it` → link https://github.com/clangd/clangd/releases (VS-bundled 19.1.x deadlocks on UE).
     - `Skip for now` → text fallback stays active.
   Only fall back to a free-text question if `AskUserQuestion` is unavailable. Always dry-run the DB before
   apply.
6. **Tell the user to run `/reload-plugins`** (or restart) — settings are read at startup.

Notes:
- Precedence is **environment variable (`VTS_*`) > config file > default**; a same-named env var wins.
- Shell alternative: `vts setup --projectPath <root> --backend clangd`, then `vts config`.
- Engine overrides: `VTS_CLANGD_CMD`/`VTS_CLANGD_ARGS`, `VTS_ROSLYN_CMD`/`VTS_ROSLYN_ARGS`.
- Cold/large (e.g. UE) index: raise `VTS_LSP_TIMEOUT_MS` (default 30000) and `VTS_LSP_INDEX_WAIT_MS`
  (default 120000) so the first query doesn't time out while clangd indexes engine headers; tune the
  warm-up open set with `VTS_CLANGD_OPEN_CAP` (default 100).
- Never write internal project paths or symbol names into any public/shared location.

$ARGUMENTS
