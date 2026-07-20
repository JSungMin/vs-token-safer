---
description: Refresh the committable tree-sitter symbol index (.vts-index) when it has gone STALE — one incremental re-index so the syntactic tier answers CURRENT code, not the state it was built at. Use when search_symbol shows "SYNTACTIC · STALE", after a big branch switch / pull / large refactor, or when the file:line answers look out of date.
---

# Update the vs-token-safer index

The committable tree-sitter index (`.vts-index/symbols.jsonl`) powers the **SYNTACTIC tier** — instant symbol
search with no language server, shareable with the team by committing it. It is built once; after the code
moves a lot it goes **STALE** and its `file:line` answers drift from where symbols actually are. This command
brings it current in ONE incremental re-index: only stat/hash-changed files are re-parsed, the rest are reused
verbatim, so even a long-stale index refreshes fast.

Do this:

1. **Check staleness first** — call the `vts_admin` MCP tool with a status probe (no rebuild):

   `vts_admin { "op": "index", "params": { "status": true } }`

   It reports the index's build date, file/symbol counts, and whether it is stale (how many files changed
   since it was built). If it reports **fresh (0 changed)**, tell the user the index is already current and
   STOP — a rebuild would do nothing.

2. **Rebuild incrementally** — if it is stale (or no index exists yet), call:

   `vts_admin { "op": "index" }`

   This re-parses ONLY the changed files, reuses the rest, and writes the updated `.vts-index/symbols.jsonl`.
   Report the `re-parsed N, reused M` counts back to the user so they see exactly what was refreshed.

3. **Remind to commit it** — `.vts-index/` is committable and team-shared. Tell the user to
   `git add .vts-index && git commit` so teammates get the fresh index too (that is the whole point of the
   committable tier — one person re-indexes, everyone benefits).

Notes:
- This refreshes ONLY the tree-sitter (syntactic) tier — the tier that goes stale because it is a *stored*
  snapshot. The clangd/LSP **semantic** index re-indexes itself on file changes (file-watch + background), so
  it does not need this. If you *also* want to warm the semantic tier (e.g. a fresh clone), run `vts preindex`
  separately — that is a different concern from index staleness.
- `detect_changes` and the dashboard symbol graph run **live** (git + LSP + tree-sitter), so they are never
  stale and need no refresh — this command is specifically for the committed `.vts-index` symbol search.

$ARGUMENTS
