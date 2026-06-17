# vs-token-safer benchmark — Bash grep vs vts (deterministic, no API)

Synthetic TypeScript corpus, 4 code-search scenarios, swept across corpus size.
Token ≈ bytes ÷ 4 (same as the product ledger). Grep arm = matching `file:line:text` (or a path
list for file-by-name) capped at 250 lines (Claude's Grep tool). vts arm = the
token-capped `file:line` output. Reproduce: `npm run bench`.

## Reduction vs corpus size (the win scales)

| caller files | grep tokens | vts tokens | reduction |
|--:|--:|--:|--:|
| 10 | 1409 | 1203 | **14.6%** |
| 50 | 6639 | 3656 | **44.9%** |
| 150 | 16634 | 6505 | **60.9%** |

Grep grows with the match count; vts stays capped — so the reduction climbs with repo size. On a
tiny corpus a narrow text/file search is a wash (vts's header overhead ≈ grep); the semantic
scenarios (symbol/refs) win even there because grep over-reports comments/strings/substrings.

## Per-scenario at 150 files

| Scenario | grep tokens | vts tokens | reduction | vts mode |
|---|--:|--:|--:|---|
| find symbol declaration | 4917 (capped) | 775 | **84.2%** | text-fallback |
| find all references | 4917 (capped) | 2204 | **55.2%** | semantic |
| text search ('retry loop') | 4917 (capped) | 2242 | **54.4%** | filesystem |
| find file by name ('caller') | 1883 (capped) | 1284 | **31.8%** | filesystem |
| **TOTAL** | **16634** | **6505** | **60.9%** | |

## Cost per model at 150 files (token delta × input price)

Saved = (grep − vts) input tokens × list input price. List prices, verify at anthropic.com/pricing.

| Model | $/Mtok (in) | grep cost | vts cost | saved | cheaper |
|---|--:|--:|--:|--:|--:|
| Haiku 4.5 | $1.00 | $0.016634 | $0.006505 | $0.010129 | 60.9% |
| Sonnet 4.x | $3.00 | $0.049902 | $0.019515 | $0.030387 | 60.9% |
| Opus 4.x | $15.00 | $0.249510 | $0.097575 | $0.151935 | 60.9% |

> Absolute $ per query is tiny — the win compounds across the many searches in a real session and
> grows with repo size. On a real Unreal Engine project the same A/B is ~282k → ~2k tokens (~138×);
> see BENCHMARK.md.
