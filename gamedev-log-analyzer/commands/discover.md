---
description: Scan local Claude Code transcripts and report (aggregate, local-only) how many raw log reads bypassed gamedev-log vs went through it — to find missed token savings. No log content in the output.
---

# gamedev-log — discover (missed token savings)

Quantifies how often logs were read raw (grep/tail/cat over a `.log`, or a full-file Read) instead of
through `gamedev-log`, so you can see where tokens leaked. Adapted from RTK's `discover`, scoped to logs.

**Run from the project root you launched Claude Code from** (it keys off the working directory):

```
gamedev-log discover                 # this project, all sessions
gamedev-log discover --since 7       # sessions from the last 7 days
gamedev-log discover --all           # every project — cross-project AGGREGATE only
gamedev-log discover --session <path-to.jsonl>
```

(or `node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" discover …`)

It reports **aggregate counts + coarse, estimated token numbers + a coverage ratio** (reads routed
through gamedev-log vs bypassed). It is **local-only** — reads transcripts, writes/transmits nothing, and
**never prints a command, file path, or any log content** (proprietary). Token counts are estimated
(`chars / 4`), rounded coarsely, and labelled as estimates. Some "bypassed" reads are legitimate (a
bounded peek, or a format gamedev-log parses poorly). The same detectors that drive the enforcement hook
drive this, so the two never disagree.

$ARGUMENTS
