---
description: Preview-only dead-code analysis — from a seed symbol, walk the call graph to a fixpoint and list what is provably DEAD (and what cascades), without deleting anything.
---

# vs-token-safer — dead-code elimination (preview only)

Use this when the user wants to know what code can be safely removed starting from one or more symbols
("is `Foo` used anywhere?", "what becomes dead if I delete `Foo`?", "find unused code reachable from here").

Run it with the seed symbol(s). Prefer the `vts_admin` MCP tool (server `vs-search`):

```
vts_admin { "op": "dce", "params": { "seed": "Foo", "projectPath": "<the project root>" } }
```

For several seeds use `"seeds": "Foo,Bar,Baz"`. If the `vs-search` server is unavailable, run the CLI instead:

```
vts dce --seed Foo --projectPath <root>
# or:  vts dce --seeds Foo,Bar,Baz --projectPath <root> [--entry main,registerPlugin --maxNodes 120]
```

Then show the output **verbatim**. It classifies every symbol reachable from the seeds as:

- **DEAD** — no live caller remains; listed in a safe deletion order (top is removable first).
- **HELD** — still referenced; not dead (shows who calls it).
- **ENTRY** — a root kept on purpose (main / public API / a name you passed via `--entry`).
- **INCONCLUSIVE** — could not be resolved, or its caller set could not be proven complete.

## Important — this NEVER deletes

`dce` only proposes candidates from the **call graph**. To actually remove one, run `safe_delete`
(`vts safe-delete --symbol <name> --apply`), which independently re-checks `find_references` and refuses while
the symbol is still referenced. So even a wrong DEAD candidate cannot delete live code: **dce proposes, safe_delete disposes.**

Always surface the CAVEAT in the output: the call graph does not see non-call references (a function used as a
value/callback, reflection, string/dynamic dispatch, cross-language calls, or test-only usage). Delete DEAD
candidates one at a time, top of the list first, and let `safe_delete`'s guard be the final gate.
