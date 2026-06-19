# vs-token-safer benchmark — Bash grep vs vts (deterministic, no API)

Synthetic TypeScript corpus, 4 code-search scenarios, swept across corpus size.
Token ≈ bytes ÷ 4 (same as the product ledger). Grep arm = matching `file:line:text` (or a path
list for file-by-name) capped at 250 lines (Claude's Grep tool). vts arm = the
token-capped `file:line` output. Reproduce: `npm run bench`.

## Reduction vs corpus size (the win scales)

| caller files | grep tokens | vts tokens | reduction |
|--:|--:|--:|--:|
| 10 | 1409 | 792 | **43.8%** |
| 50 | 6639 | 1955 | **70.6%** |
| 150 | 16634 | 2222 | **86.6%** |

Grep grows with the match count; vts stays capped — so the reduction climbs with repo size. On a
tiny corpus a narrow text/file search is a wash (vts's header overhead ≈ grep); the semantic
scenarios (symbol/refs) win even there because grep over-reports comments/strings/substrings.

## Per-scenario at 150 files

| Scenario | grep tokens | vts tokens | reduction | vts mode |
|---|--:|--:|--:|---|
| find symbol declaration | 4917 (capped) | 170 | **96.5%** | semantic |
| find all references | 4917 (capped) | 435 | **91.2%** | semantic |
| text search ('retry loop') | 4917 (capped) | 1288 | **73.8%** | filesystem |
| find file by name ('caller') | 1883 (capped) | 329 | **82.5%** | filesystem |
| **TOTAL** | **16634** | **2222** | **86.6%** | |

## Zero-setup symbol search: grep vs tree-sitter (no toolchain) vs LSP

The tree-sitter tier needs NO compile DB / language server — it indexes 36 languages instantly — yet
returns the same token-capped `file:line` shape, so toolchain-free costs no more tokens than semantic.

| caller files | grep tokens | tree-sitter (no setup) | LSP (semantic) | grep→tree-sitter |
|--:|--:|--:|--:|--:|
| 10 | 439 | 52 | 154 | **88.2%** |
| 50 | 1999 | 52 | 154 | **97.4%** |
| 150 | 4917 | 53 | 170 | **98.9%** |

Both vts tiers stay flat while grep grows; the tree-sitter tier is the cold-start / no-toolchain path,
the LSP tier adds reference/overload/type resolution on top. Build a committable index with `vts index`.

## Cost per model at 150 files (token delta × input price)

Saved = (grep − vts) input tokens × list input price. List prices, verify at anthropic.com/pricing.

| Model | $/Mtok (in) | grep cost | vts cost | saved | cheaper |
|---|--:|--:|--:|--:|--:|
| Haiku 4.5 | $1.00 | $0.016634 | $0.002222 | $0.014412 | 86.6% |
| Sonnet 4.x | $3.00 | $0.049902 | $0.006666 | $0.043236 | 86.6% |
| Opus 4.x | $15.00 | $0.249510 | $0.033330 | $0.216180 | 86.6% |

> Absolute $ per query is tiny — the win compounds across the many searches in a real session and
> grows with repo size. On a real Unreal Engine project the same A/B is ~282k → ~2k tokens (~138×);
> see BENCHMARK.md.
