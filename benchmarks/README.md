# vs-token-safer benchmark suite

A **reproducible, deterministic, zero-API** A/B benchmark: for the same code-search question, how many
tokens does **Bash grep** inject into the model's context versus **vts**?

```bash
npm run bench          # → prints the table, writes results/latest.{json,md}
```

## Why deterministic (and not promptfoo with a live model)

ponytail-style benchmarks run a real model and measure the **output** it generates. That fits a tool that
shapes output. vts is different: it's a **tool that shapes the *input* context** a search puts in front of
the model — it doesn't change what the model writes, it changes how many tokens the model has to *read* to
answer "where is X?".

So the honest metric is **model-independent and needs no API call**: count the tokens each arm injects for
an identical query. That makes it:

- **Reproducible by anyone** — no API key, no spend, no rate limits. `npm run bench` gives the same numbers
  on any machine (it's a pure measurement over a synthetic corpus).
- **Model-matrix for free** — the token *delta* is fixed; the per-model **cost** table is just
  `delta × that model's input price`. No run-to-run variance.

The trade-off: this measures the *token cost of search*, not an end-to-end agent session. The real-session
win is larger (fewer search tokens → less context bloat → fewer follow-up turns), but that's not what this
suite claims — it claims the floor.

## What it measures

Synthetic projects in **three languages** — TypeScript, Python, and Go — built in a temp dir. TypeScript and
Python exercise the **semantic** tier (a language server resolves symbols/refs when installed); Go has **no
wired backend**, so it exercises the **syntactic** tree-sitter tier and a bounded literal scan. Running the
same scenarios across all three is the controlled, multi-repo claim — a single corpus could be cherry-picked
on the one shape vts is best at. Four everyday code-search scenarios per language, each run as:

- **Arm A — grep**: what the built-in Grep/Glob tool hands the model — every matching `relpath:line:text`
  (or a path list for file-by-name), **capped at 250 lines** (Claude's Grep tool truncates ~there). This is
  the *conservative* baseline; an uncapped `grep -rn`-and-paste is far larger.
- **Arm B — vts**: the `runTool` output — a token-capped `file:line` list, no bodies.

Token estimate = `bytes ÷ 4`, identical to the product's own savings ledger (`server/core.js`).

**The key variable is repo size.** grep returns every matching line (full text), so its cost scales with
the match count; vts stays roughly flat (capped). So the suite **sweeps corpus size** (10 / 50 / 150 caller
files) and reports the reduction climbing — the honest shape of the win.

## Representative results

(From `results/latest.md`; re-run to refresh. Exact numbers depend on which backends are installed — a
missing language server only changes vts's *tier* label, never the token-capped shape.)

All-language total at 150 caller files (per corpus, the not-cherry-picked claim):

| Language | vts tier (designed) | grep tokens | vts tokens | reduction |
|---|---|--:|--:|--:|
| TypeScript | semantic (LSP) | ~16,600 | ~2,200 | **~87%** |
| Python | semantic (LSP) | ~14,900 | ~2,500 | **~83%** |
| Go | syntactic (tree-sitter, no backend) | ~16,000 | ~1,400 | **~91%** |
| **All languages** | — | ~47,500 | ~6,100 | **~87%** |

The reduction climbs with repo size in every language (10 / 50 / 150 caller files); on a tiny corpus a
narrow text/file search is a wash, the semantic scenarios win even there. See `results/latest.md` for the
full per-language, per-scenario, per-size breakdown.

## Honest caveats (read these)

- **Small repos are a wash for narrow text/file search.** On a 10-file toy, vts's header overhead ≈ grep's
  output — the reduction is small. The win opens up as the repo grows. The *semantic* scenarios (symbol,
  references) win even on small repos because grep over-reports comments / strings / substrings.
- **vts caps results (a precision/recall trade).** vts returns the top-N semantic hits (`maxResults`,
  default capped) plus a `… N more` footer and a recovery tee file — it does **not** dump every textual
  occurrence. The token win partly reflects this deliberate cap. For an exhaustive textual audit, raise
  `maxResults` / `VTS_MAX_RESULTS` or use grep on purpose. (See [BENCHMARK.md](../BENCHMARK.md).)
- **`find_files` is a robustness win first, a token win second.** Its main value is walk-bounding
  (skipping `node_modules`/`Intermediate`/`Binaries`, time-boxed) so it doesn't hang on a giant tree; the
  token reduction only appears once a tree carries ignored junk or exceeds the cap (the corpus includes a
  `node_modules` dir to reflect this).
- **`search_symbol` may fall back to a literal text scan** on a ts/py backend when the symbol's file wasn't
  in the warm-up open set (the `mode` column shows `text-fallback`). That path still returns correct
  `file:line` and still saves tokens; it's disclosed, not hidden.
- **Prices are list input prices** (`PRICES` in `run.mjs`), verify at <https://www.anthropic.com/pricing>.
  The token delta is the deterministic claim; the dollar figures re-price by editing that constant.

## Files

- `run.mjs` — the harness (self-contained; builds the corpus, runs both arms, writes results).
- `results/latest.{json,md}` — the most recent run (committed as a baseline; regenerated by `npm run bench`).

See the root [BENCHMARK.md](../BENCHMARK.md) for the real Unreal Engine A/B (~282k → ~2k tokens, ~138×) and
the bundled log-analyzer benchmark. Keep all inputs **synthetic** — no real paths/symbols (CONTRIBUTING.md).
