---
description: How to open/close and reason about the vs-token-safer local dashboard — an interactive page (savings trend, language mix, per-tool savings, and a 3D Three.js include-graph) served on 127.0.0.1. Use when the user wants to SEE/visualize what vs-token-safer has indexed or how many tokens it saved, or asks to open/close/show the dashboard or token visualization.
---

# vs-token-safer dashboard (`vts serve`)

A local, interactive view of what vts knows + how much it saved. **Local-only and opt-in**: the server
binds `127.0.0.1`, serves a fully self-contained page (inline CSS/JS + a **locally-vendored** Three.js —
no CDN, no external fetch), and runs ONLY while explicitly started — the always-on MCP server never starts
it. Same zero-transmission trust model as the rest of vts (localhost ≠ off-machine).

## Open / close (prefer the commands)
- Open: **/vs-token-safer:viz** — starts the server (background) + opens the browser.
- Close: **/vs-token-safer:viz-stop** — stops it via the pidfile.

Under the hood (if running the CLI directly):
- `vts serve --open --projectPath <root>` — start + launch browser. Run it with `run_in_background: true`
  (it's a long-running server). `--port N` if 8731 is busy. Falls back to
  `node "$CLAUDE_PLUGIN_ROOT/server/cli.js" serve …` when `vts` isn't on PATH.
- `vts serve --stop` — shut it down. `Ctrl-C` also works on the foreground process.

## What it shows (all from local stores — no network)
- **Tokens saved / ratio / $ / searches** — from the savings ledger (`~/.vs-token-safer/savings.json`).
- **30-day savings trend** + **per-tool savings** bars.
- **Language mix** donut — file counts per backend (clangd/roslyn/tsserver/pyright) for the project.
- **3D include graph** — nodes = files, sized + heat-colored by include fan-in (how many files include them),
  edges = include relationships. Drag to orbit, wheel to zoom, hover a node for its path + fan-in. Built on
  Three.js (WebGL); falls back to a message if WebGL is unavailable.

## Notes
- The graph fills in as searches run (each records into the warm-set + include-graph). Empty graph → suggest
  `vts warmup --projectPath <root> --backend <clangd|typescript|…>` or just keep using the search tools.
- It's a viewer, not a data source — read actual numbers from `vts savings` / `vts_admin {op:"savings"}`.
- Bounded: the graph caps at `VTS_VIZ_MAX_NODES` (200) highest-fan-in nodes so the WebGL sim stays smooth.
