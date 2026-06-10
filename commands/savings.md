---
description: Report how many tokens the vs-token-safer plugin has saved (vs forwarding the language server's raw index responses).
---

# vs-token-safer — token savings

Call the `vts_savings` MCP tool (server: `vs-search`) and show the user its output verbatim:
cumulative searches, raw vs sent tokens, total saved (and %), and the biggest single run.

If the `vs-search` server is unavailable, run instead: `vts savings` and report its output.

Note: "saved" = tokens that would have been spent forwarding the language server's raw index
response, minus what the plugin actually sent after token-capping to `file:line`. Savings vs Bash
grep-and-paste are typically far larger. To reset the counter, call the `vts_savings_reset` tool
(or `vts savings-reset`).
