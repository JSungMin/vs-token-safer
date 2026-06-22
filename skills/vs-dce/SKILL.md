---
description: Preview-only dead-code analysis for C/C++, C#/.NET, JS/TS, and Python via vs-token-safer. From one or more seed symbols, walk the official language server's call graph to a fixpoint and report what is provably DEAD (and what transitively becomes dead) — without deleting anything. Use whenever the user asks what code is unused/removable, whether a function is called anywhere, what becomes dead if a symbol is deleted, or for transitive dead-code cleanup. Not for a plain "who calls X" (use find_references) — this is the multi-hop cascade + safe deletion order.
---

# vs-token-safer — dead-code elimination (preview only)

Topological dead-code analysis built on the OFFICIAL language-server call graph (clangd / Roslyn / tsserver /
pyright). You name seed symbol(s); it walks callers/callees to a fixpoint and classifies every reachable
symbol. The output is token-capped (names + `file:line`, no source bodies). Nothing leaves the machine.

## How to run

Prefer the `vts_admin` MCP tool (it runs in the warm server process; `vts` is often not on PATH in Bash). Fall
back to the bundled CLI via node:

```
vts_admin { "op": "dce", "params": { "seed": "Foo", "projectPath": "<root>" } }
# several seeds:  "params": { "seeds": "Foo,Bar", "projectPath": "<root>", "entry": "main,registerPlugin" }
# CLI fallback:   node "$CLAUDE_PLUGIN_ROOT/server/cli.js" dce --seed Foo --projectPath <root>
```

**Warm-index requirement (C++/clangd).** The call graph must be warm. A cold or large clangd tree (e.g. an
Unreal monorepo, ~26k TUs) under-reports callers, so a live symbol could look DEAD — `dce` therefore REFUSES on
a cold clangd index. Scope + build first: `vts setup --scope Source` then `vts preindex` (or keep the MCP server
warm), then re-run. `allowCold=true` inspects a cold index with every verdict forced to INCONCLUSIVE (never
DEAD). TypeScript/Python/C# index on open and are not gated.

Show the result verbatim. Buckets: **DEAD** (no live caller, in safe deletion order) · **HELD** (still called) ·
**ENTRY** (kept root: main / public API / a name passed via `entry`) · **INCONCLUSIVE** (unresolved or the
caller set couldn't be proven complete).

## The safety model — it NEVER deletes

`dce` only PROPOSES candidates from the call graph. The actual removal goes through `safe_delete`
(`vts safe-delete --symbol <name> --apply`), which independently re-checks `find_references` and refuses while
the symbol is still referenced. So a wrong DEAD candidate cannot delete live code: **dce proposes, safe_delete disposes.**

Karpathy-style rules — do the listed thing, do not improvise:
1. Run `dce` with the seed(s); show the buckets verbatim.
2. To remove a DEAD candidate, run `safe_delete` on it, top of the list first, one at a time.
3. Always surface the CAVEAT: the call graph does not see non-call references (function-as-value, reflection,
   string/dynamic dispatch, cross-language, or test-only usage). Treat DEAD as candidates, not a verdict.
4. Never bypass `safe_delete` (no `sed`/manual deletion of a DEAD candidate) — its reference guard is the backstop.

Env: `VTS_DCE_MAX_NODES` (cascade node cap, default 120).
