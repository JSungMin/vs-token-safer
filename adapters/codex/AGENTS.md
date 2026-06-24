# vs-token-safer — routing for Codex

Append this block to your project's `AGENTS.md` (Codex reads it as standing instructions). It tells the
agent when to reach for the `vs-search` MCP tools instead of a raw `shell` grep — the same when-to-use-what
guidance the Claude Code plugin injects, minus the live adoption stats.

Regenerate it any time (keeps it in sync with the engine):

```
vts routing --native "Codex's native read_file / shell (grep, sed) / apply_patch"
```

---

[vs-token-safer] Tool routing — vts + the agent's native tools are COMPLEMENTARY; cheapest tool that fits:
  • symbol / refs / rename on INDEXED code → vts search_symbol / find_references / rename (not grep)
  • ADD/REPLACE a whole decl → vts replace_symbol_body / insert_symbol (by name, skips the Read)
  • doc/log, quick literal peek, JUST-edited or unindexed file, sub-decl tweak → Codex's native read_file / shell (grep, sed) / apply_patch
  • big tree, slow first query → vts setup --scope <module>; vts preindex
  (no PreToolUse hook here — vts can't auto-rewrite a stray grep, so prefer the vts tool by habit.)
