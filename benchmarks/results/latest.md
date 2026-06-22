# vs-token-safer benchmark — Bash grep vs vts (deterministic, no API)

Synthetic corpora in **3 languages** (TypeScript, Python, Go), 4 code-search scenarios each, swept across corpus size. Token ≈ bytes ÷ 4
(same as the product ledger). Grep arm = matching `file:line:text` (or a path list for file-by-name)
capped at 250 lines (Claude's Grep tool). vts arm = the token-capped `file:line` output.
Reproduce: `npm run bench`.

## Token reduction across languages (at 150 files — the not-cherry-picked claim)

| Language | grep tokens | vts tokens | reduction |
|---|--:|--:|--:|
| TypeScript | 16634 | 2269 | **86.4%** |
| Python | 14929 | 2510 | **83.2%** |
| Go | 15984 | 1416 | **91.1%** |
| **All languages** | **47547** | **6195** | **87.0%** |

The win holds across languages vts has a language server for (TypeScript, Python — the SEMANTIC tier)
and one it has no wired backend for (Go — tree-sitter answers symbol queries and a bounded literal scan
answers references, the SYNTACTIC tier). Same token-capped shape either way. Which tier actually answered
each scenario on THIS run (it degrades to syntactic/text-fallback when a language server isn't installed)
is shown in the per-scenario tables below — the token reduction itself is deterministic regardless.

## Reduction vs corpus size, per language (the win scales)

### TypeScript

| caller files | grep tokens | vts tokens | reduction |
|--:|--:|--:|--:|
| 10 | 1409 | 830 | **41.1%** |
| 50 | 6639 | 2044 | **69.2%** |
| 150 | 16634 | 2269 | **86.4%** |

### Python

| caller files | grep tokens | vts tokens | reduction |
|--:|--:|--:|--:|
| 10 | 1577 | 774 | **50.9%** |
| 50 | 7587 | 1867 | **75.4%** |
| 150 | 14929 | 2510 | **83.2%** |

### Go

| caller files | grep tokens | vts tokens | reduction |
|--:|--:|--:|--:|
| 10 | 1350 | 498 | **63.1%** |
| 50 | 6380 | 818 | **87.2%** |
| 150 | 15984 | 1416 | **91.1%** |

Grep grows with the match count; vts stays capped — so the reduction climbs with repo size in every
language. On a tiny corpus a narrow text/file search is a wash (vts's header overhead ≈ grep); the
semantic scenarios (symbol/refs) win even there because grep over-reports comments/strings/qualified calls.

## Per-scenario at 150 files, per language

### TypeScript

| Scenario | grep tokens | vts tokens | reduction | vts mode |
|---|--:|--:|--:|---|
| find symbol declaration | 4917 (capped) | 169 | **96.6%** | syntactic |
| find all references | 4917 (capped) | 485 | **90.1%** | semantic |
| text search ('retry loop') | 4917 (capped) | 1287 | **73.8%** | filesystem |
| find file by name ('caller') | 1883 (capped) | 328 | **82.6%** | filesystem |
| **TOTAL** | **16634** | **2269** | **86.4%** | |

### Python

| Scenario | grep tokens | vts tokens | reduction | vts mode |
|---|--:|--:|--:|---|
| find symbol declaration | 4221 (capped) | 169 | **96.0%** | syntactic |
| find all references | 4221 (capped) | 831 | **80.3%** | syntactic |
| text search ('retry loop') | 4604 (capped) | 1182 | **74.3%** | filesystem |
| find file by name ('caller') | 1883 (capped) | 328 | **82.6%** | filesystem |
| **TOTAL** | **14929** | **2510** | **83.2%** | |

### Go

| Scenario | grep tokens | vts tokens | reduction | vts mode |
|---|--:|--:|--:|---|
| find symbol declaration | 4667 (capped) | 157 | **96.6%** | syntactic |
| find all references | 4667 (capped) | 849 | **81.8%** | syntactic |
| text search ('retry loop') | 4667 (capped) | 81 | **98.3%** | filesystem |
| find file by name ('caller') | 1983 (capped) | 329 | **83.4%** | filesystem |
| **TOTAL** | **15984** | **1416** | **91.1%** | |

## Zero-setup symbol search: grep vs tree-sitter (no toolchain) vs vts tier, per language

The tree-sitter tier needs NO compile DB / language server — it indexes 36 languages instantly — yet
returns the same token-capped `file:line` shape, so toolchain-free costs no more tokens than semantic.

| Language | caller files | grep tokens | tree-sitter (no setup) | vts tier | grep→tree-sitter |
|---|--:|--:|--:|--:|--:|
| TypeScript | 10 | 439 | 50 | 193 | **88.6%** |
| TypeScript | 50 | 1999 | 50 | 193 | **97.5%** |
| TypeScript | 150 | 4917 | 51 | 169 | **99.0%** |
| Python | 10 | 536 | 51 | 169 | **90.5%** |
| Python | 50 | 2536 | 51 | 169 | **98.0%** |
| Python | 150 | 4221 | 52 | 169 | **98.8%** |
| Go | 10 | 415 | 53 | 156 | **87.2%** |
| Go | 50 | 1895 | 53 | 156 | **97.2%** |
| Go | 150 | 4667 | 53 | 157 | **98.9%** |

Both vts tiers stay flat while grep grows; the tree-sitter tier is the cold-start / no-toolchain path,
the LSP tier adds reference/overload/type resolution on top. Build a committable index with `vts index`.

## Cost per model at 150 files, all languages (token delta × input price)

Saved = (grep − vts) input tokens × list input price. List prices, verify at anthropic.com/pricing.

| Model | $/Mtok (in) | grep cost | vts cost | saved | cheaper |
|---|--:|--:|--:|--:|--:|
| Haiku 4.5 | $1.00 | $0.047547 | $0.006195 | $0.041352 | 87.0% |
| Sonnet 4.x | $3.00 | $0.142641 | $0.018585 | $0.124056 | 87.0% |
| Opus 4.x | $15.00 | $0.713205 | $0.092925 | $0.620280 | 87.0% |

> Absolute $ per query is tiny — the win compounds across the many searches in a real session and
> grows with repo size. On a real Unreal Engine project the same A/B is ~282k → ~2k tokens (~138×);
> see BENCHMARK.md.
