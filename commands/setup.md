---
description: Configure the vs-token-safer plugin (project path, backend, result cap). Writes ~/.vs-token-safer/config.json and tells you to /reload-plugins.
---

# vs-token-safer — setup

Configure the plugin by writing its config file (`~/.vs-token-safer/config.json`), which the CLI and
MCP server read at startup. Use the `vts_setup` MCP tool (server: `vs-search`) — do NOT edit the
user's OS environment.

Steps:
1. **Show current settings:** call `vts_config`.
2. **Detect/confirm the backend.** Backend auto-detects from the project root:
   - C/C++ → needs `compile_commands.json` in (or under) the root → **clangd**. Unreal: generate via
     UBT `-mode=GenerateClangDatabase`; CMake: `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`.
   - C#/.NET → a `.sln`/`.csproj` → **roslyn** (default engine `csharp-ls`; install with
     `dotnet tool install --global csharp-ls`, or point `VTS_ROSLYN_CMD` at MS C# LSP).
3. **Gather values** (ask one at a time, or an `AskUserQuestion` for the common ones):
   - `projectPath` — default project root (where the compile DB / .sln lives).
   - `backend` — `clangd` | `roslyn` (omit to auto-detect).
   - `maxResults` — cap on returned `file:line` locations (default 60).
4. **Apply:** call `vts_setup` with only the keys to change, e.g.
   `vts_setup { "projectPath": "<root>", "backend": "clangd" }`.
5. **Tell the user to run `/reload-plugins`** (or restart) — settings are read at startup.

Notes:
- Precedence is **environment variable (`VTS_*`) > config file > default**; a same-named env var wins.
- Shell alternative: `vts setup --projectPath <root> --backend clangd`, then `vts config`.
- Engine overrides: `VTS_CLANGD_CMD`/`VTS_CLANGD_ARGS`, `VTS_ROSLYN_CMD`/`VTS_ROSLYN_ARGS`.
- Never write internal project paths or symbol names into any public/shared location.

$ARGUMENTS
