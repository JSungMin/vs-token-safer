---
description: Open the vs-token-safer dashboard — a local (127.0.0.1, nothing transmitted) page showing tokens saved, language mix, per-tool savings, and the include graph as an interactive 3D force graph (Three.js, vendored locally — no CDN).
---

# vs-token-safer — open the dashboard

Start the local dashboard server and open it in the browser. It is **local-only** (binds `127.0.0.1`,
serves a fully self-contained page + the locally-vendored Three.js — nothing leaves the machine) and
**opt-in** (it is NOT the always-on MCP server; it runs only while this command's process is alive).

Do this:

1. Run the dashboard **in the background** (it's a long-running server), opening the browser automatically:
   ```
   vts serve --open --projectPath "<the current project root>"
   ```
   If `vts` is not on PATH, run the bundled CLI instead:
   ```
   node "$CLAUDE_PLUGIN_ROOT/server/cli.js" serve --open --projectPath "<the current project root>"
   ```
   Launch it with `run_in_background: true` so it keeps serving across turns. Pass `--port <N>` if 8731 is
   taken (the error message says so).

2. Tell the user the URL it printed (e.g. `http://127.0.0.1:8731/`) and that it's local-only.

3. If the include-graph panel is empty, note that the graph fills in after some searches — they can run
   `vts warmup --projectPath <root> --backend <clangd|typescript|…>` or just keep using the search/nav tools
   (each search records into the warm-set + include-graph).

To close it later, use **/vs-token-safer:viz-stop** (or `vts serve --stop`, or Ctrl-C the process).
