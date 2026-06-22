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

For several seeds use `"seeds": "Foo,Bar,Baz"`. Prefer the MCP tool — it runs in the warm server process, and
`vts` is often not on PATH in Bash. If the `vs-search` server is unavailable, run the bundled CLI:

```
node "$CLAUDE_PLUGIN_ROOT/server/cli.js" dce --seed Foo --projectPath <root>
# (if vts is on PATH:  vts dce --seeds Foo,Bar,Baz --projectPath <root> [--entry main,registerPlugin --maxNodes 120])
```

## Warm-index requirement (C++/clangd)

For a clangd (C/C++) project the call graph must be **warm** — a cold or large tree (e.g. an Unreal monorepo,
~26k TUs) under-reports callers, so a live symbol could look DEAD. `dce` therefore **refuses on a cold clangd
index** and tells you to build one. Indexing the whole tree is heavy, so scope it first:

```
vts setup --scope Source --projectPath <root>   # narrow to the module subtree, not the whole monorepo
vts preindex --projectPath <root>               # build the scoped index (or keep the MCP server warm)
```

Then re-run `dce`. To inspect the structure on a cold index anyway, pass `allowCold=true` — every verdict is
then forced to INCONCLUSIVE (nothing is ever marked DEAD). TypeScript/Python/C# index on open and are not gated.

Then show the output **verbatim**. It classifies every symbol reachable from the seeds as:

- **DEAD** — no live caller remains; listed in a safe deletion order (top is removable first).
- **HELD** — still referenced; not dead (shows who calls it).
- **ENTRY** — a root kept on purpose (main / public API / a name you passed via `--entry`).
- **INCONCLUSIVE** — could not be resolved, or its caller set could not be proven complete.

## Two modes

- **Caller-cascade** (default): start from the seeds, follow callers; a seed with no live caller is dead, and
  removing it can cascade. Thorough by default — each DEAD candidate is reference-verified.
- **Reachability / mark-sweep** (pass `roots`): the Go-`deadcode`/RTA model — liveness is computed FORWARD from
  the named entry points, so a *missing caller* can't cause a false DEAD; only an incomplete root set can (the
  reference verify catches that). Roots are generic and **framework-agnostic** — name them yourself, or commit a
  `.vts-index/dce-roots.json` (`["main","RunTests","StartupModule", …]`) that your team curates once. vts hard-
  codes NO framework markers (no UFUNCTION / `@Route` / `[Test]`); you declare your own entry points.

```
vts dce --seeds Foo,Bar --roots "main,RunTests,StartupModule" --projectPath <root>
```

## Important — this NEVER deletes

`dce` only proposes candidates from the **call graph**. To actually remove one, run `safe_delete`
(`vts safe-delete --symbol <name> --apply`), which independently re-checks `find_references` and refuses while
the symbol is still referenced. So even a wrong DEAD candidate cannot delete live code: **dce proposes, safe_delete disposes.**

Always surface the CAVEAT in the output: the call graph does not see non-call references (a function used as a
value/callback, reflection, string/dynamic dispatch, cross-language calls, or test-only usage). Delete DEAD
candidates one at a time, top of the list first, and let `safe_delete`'s guard be the final gate.
