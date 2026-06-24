# vs-token-safer × Codex CLI

Run vs-token-safer under OpenAI's [Codex CLI](https://developers.openai.com/codex/). Codex speaks MCP, so
the **tools port for free** — `search_symbol`, `find_references`, `goto_definition`, `concept_search`, the
symbol-edit set, `search_text`/`find_files`, the git/p4 compactors — all answer with the same token-capped
`file:line` output, all local, nothing transmitted.

What does **not** port is the Claude Code enforcement hook (it can't auto-rewrite a stray `grep` here). On
Codex the swap is **instructed, not intercepted**: a routing block in `AGENTS.md` (see below) tells the agent
to prefer the vts tools by habit. Everything that travels *inside* a tool result (the precision certificate,
empty-result steers, the navigation nudges) still works — those are part of the answer, not the hook.

## 1. Register the MCP server

**The CLI helper (recommended)** — Codex writes the correct `config.toml` table:

```bash
# a local clone of this repo (no npm publish needed):
codex mcp add vs-search -- node /ABSOLUTE/PATH/TO/vs-token-safer/server/index.js

# …or the published npm package, if/when vs-token-safer is on npm:
codex mcp add vs-search -- npx -y vs-token-safer
```

**Or edit `~/.codex/config.toml` by hand** — copy the table from [`config.toml`](./config.toml) in this
directory. It also shows the optional `env` block (`PROJECT_PATH`, `VTS_SCOPE`, `VTS_CLANGD_CMD`, …).

Verify it's wired:

```bash
codex mcp list      # vs-search should appear
```

## 2. Add the routing guidance

Append the block from [`AGENTS.md`](./AGENTS.md) to your project's `AGENTS.md`. Regenerate it any time so it
stays in sync with the engine:

```bash
vts routing --native "Codex's native read_file / shell (grep, sed) / apply_patch" >> AGENTS.md
```

## 3. (Optional) the `vts` CLI as a fallback

Even without MCP, any Codex `shell` step can call the `vts` CLI directly — it's the same engine:

```bash
vts symbol --q SpawnActor --projectPath /path/to/project
vts references --symbol HandlePayment --projectPath /path/to/project
vts concept --q "auth login flow" --projectPath /path/to/project
```

This is the lowest-common-denominator path — it works under any agent that can run a shell, not just Codex.

## Notes

- **Same trust model**: local-only, official language servers (clangd / Roslyn / tsserver / pyright) +
  tree-sitter, no embeddings, nothing leaves the machine.
- **C++ / Unreal**: needs `compile_commands.json` and clangd ≥ 22 (VS-bundled 19.1.x deadlocks on UE TUs).
  See the repo root `CLAUDE.md` / `README.md` for the generate-DB flow (`vts gen-compile-db`).
- **Version**: pinned to the repo — one engine, one version across every adapter (no per-harness fork).
