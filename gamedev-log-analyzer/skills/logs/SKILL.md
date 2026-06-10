---
name: gamedev-log-analyzer
description: >-
  Analyze an editor, build, or structured trace log (Unreal Engine Saved/Logs, Unity Editor.log, Godot
  output, MSVC/UBT/MSBuild build output, JSONL / structured `.jsonl` traces, or any text log)
  token-efficiently. Use when the user
  mentions checking,
  reading, searching, summarizing, or diffing a log; investigating editor/engine errors, warnings,
  crashes, asserts, callstacks, or log spam; or asks "what's flooding the log" / "what changed since
  the last run". Parses, deduplicates, classifies by severity/category, and extracts decisive fields
  via the `gamedev-log` CLI instead of dumping the raw file (logs can be tens of MB).
---

# gamedev-log-analyzer — game-engine/build log analysis (CLI)

Read logs through the **`gamedev-log` CLI**, never `cat`/`grep`/`Get-Content` the raw file — these logs
are routinely tens of MB and will flood the context. The CLI parses → classifies → deduplicates →
returns a compact, token-capped summary (often ~99% smaller than the raw log).

> Format coverage: **Unreal runtime + MSVC/UBT/MSBuild/Unity-C# build + JSONL are live-verified**
> (JSONL on a real UE `AIMovementDebug.jsonl`). For JSONL, `fields` also extracts `Key=value` /
> `Key=(x,y,z)` from inside the `message` plus top-level keys, so per-frame scalar tracking over a
> `--window` works. **Unity-deep, Godot, Python-logging, and bracketed-level parsing are best-effort
> from public docs and NOT verified against a specific app's real logs** — say so if you report results
> for those, and run `gamedev-log learnings` to see what went unparsed.

## How to run it

Invoke via **Bash** using the plugin-root absolute path (no PATH/setup needed; pure Node, no deps):

```bash
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" <command> [--flags]
```

Quote every path argument (Windows paths/spaces). `--help` lists everything.

## Commands

- `detect` — find editor logs (newest first). `--projectPath <dir>` (UE: scans `<dir>/Saved/Logs`,
  one subdir deep; Unity: `Editor.log`). Run this first if you don't have a path.
- `summary` — severity counts + top categories, no message bodies. `--path | --projectPath`.
- `search` — parse + dedup into templated groups with `×count` + locations, severity-sorted, capped.
  - `--severityMin Error|Warning|Display` (default Warning) · `--query <substr>` · `--category <Cat>`
  - `--file <pathfrag>` · `--groupBy template|callsite|code` (callsite = roll up by `file:line`, best
    for "which callsite floods the log"; code = roll up by diagnostic code like `C4996`/`LNK2019`,
    collapsing a noisy build to one line per code) · `--maxGroups N`
- `diff` — compare two logs, emit ONLY the delta (new / gone / count-changed groups; unchanged
  omitted). `--pathA <before> --pathB <after>`, or omit both to auto-pick the two newest detected
  logs. Same filters as `search` plus `--minDelta N`. Token-cheap "what changed since last run?".
- `locate` — jump list: just the distinct `file:line` of matched entries (no message bodies), ranked
  by severity then count. `--severityMin Error` (default) · `--basename` (strip to filename, for
  Rider's name search) · `--query --category --file --max`. The compact handoff for opening source.
- `fields` — pull just decisive scalars from dense per-frame trace logs into a compact table.
  `--fields Pawn,Alpha,ts,Pos.x,step:Pos,d:Yaw` (forms: `Key`, `Key.x|.y|.z`, `Key.Y|.P|.R`, `ts`,
  `dts`, `d:Key`, `step:Key`) · `--query` · `--window t0,t1` · `--max N`. Biggest win on per-frame logs.
  Add **`--stats`** to collapse to per-column `min/max/avg/first/last/Δ` (one line per field) instead of
  rows — use it for "what's the range/trend of X over this window?" (even fewer tokens than the table).
- `tail` — last N raw lines (escape hatch). `--lines N`.
- `setup` / `config` — persist/show settings (`~/.gamedev-log-analyzer/config.json`). Keys: `--projectPath
  --logPath --logMaxBytes --maxGroups --maxLineChars`.
- `learnings` / `learnings-reset` — local sanitized parse-coverage report + top unparsed line shapes
  (new-parser candidates). See *Growing format coverage* below; a low-coverage file also auto-nudges.
- `savings` / `savings-reset` — local cumulative report of how many tokens you've saved vs dumping raw
  logs into context. Each analysis also appends a one-line `✓ Saved ~N tokens (M× smaller)` for big logs.
- `enforce <block|warn|off>` (or no arg = status) — log-read enforcement. A `PreToolUse` hook
  intercepts raw Bash log reads (`grep`/`tail`/`cat`/… over `.log`/`.jsonl`/`Logs`) **and unbounded
  `Read`s of large (≥ 200 KB) logs**, steering them here. A sliced `Read` (`offset`/`limit`) always
  passes — that's the one-step escape when you truly need raw bytes or when a format parses poorly.
  `warn` (default) allows + nudges; `block` denies + nudges; `off` disables. Env: `GDLOG_ENFORCE`. If a
  user hits the block and genuinely wants raw bytes, tell them to re-Read with `offset`/`limit`, or
  `gamedev-log enforce warn|off`.

## Inline lookup vs. delegating to the `log-analyst` subagent
- A single quick check on a log — one summary, one search — whose result you want to see: run the CLI
  inline. Cheapest path; a subagent costs ~15k tokens of its own to return a few hundred.
- Once you reach a third *related* pass over the same log (severity, then a trace tag, then a scalar
  window), or you know up front it's a multi-step investigation, hand the whole thing to the
  `log-analyst` subagent in one call. It runs every pass in its own context and returns one compact
  answer, so the raw output never piles up in yours.
- Rule of thumb: inline for 1–2; batch-delegate at 3+ related passes or a multi-step dig. Don't spawn a
  subagent for one summary, and don't run ten sequential inline reads when one delegation would do.
  "Related" is the signal — count alone doesn't decide it.

## Default flow ("check the logs")

```bash
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" detect  --projectPath "<project>"
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" summary --path "<log>"
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" search  --path "<log>" --severityMin Error
```

Then report the errors with their `file:line` locations. For per-frame/trace noise use `fields`; for
regression triage across two runs use `diff`.

## Jump from a log error to the source (with rider-mcp-enforcer)

Log entries carry `file:line`. When the user wants to **open / fix the offending code** and
`rider-mcp-enforcer` is installed, use this token-frugal loop instead of reading whole files:

1. **Get the jump list** — distinct locations only, no bodies:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" locate --path "<log>" --severityMin Error --basename
   ```
   `--basename` strips paths to `Foo.cpp:123` so Rider's filename search can resolve them.
2. **Resolve each filename → full path** via Rider: `find_files_by_name_keyword` (or `search_file`)
   with the basename. Logs often carry partial/relative paths; Rider's index has the real one.
3. **Read just the relevant window** at that line via Rider `read_file` (a small line range around the
   number), or `get_symbol_info` for the enclosing symbol — never dump the whole file.

Skip `locate` and read directly only when there's a single known location. For many errors, `locate`
first so you batch-resolve the distinct callsites instead of re-scanning the log per file.

## Growing format coverage (self-learning loop)

The analyzer keeps a **local, sanitized learnings ledger** (`~/.gamedev-log-analyzer/learnings.json`):
every run records parse coverage + **templated shapes of UNPARSED lines** (variable parts masked; never
transmitted). When a log barely parses, `summary`/`search`/`fields` print a one-line nudge
(`⚠ Only N% of lines parsed …`). That is the signal to **grow a new format** — and you (Claude) are the
right layer to do it, not a heuristic. The loop:

1. **See the gap** — the low-coverage hint, or run `gamedev-log learnings` for the top unparsed shapes.
2. **Draft a parser** — add a branch to `server/logs.js` `parseLine` (or a JSON-key alias / `--window`
   field) that covers the shape. Match the existing style; mark it **best-effort / ⚠️ unverified** in
   comments unless you have a real sample to verify against.
3. **Add an eval fixture** — a synthetic line in `eval/run.mjs`'s `engineCases` (or a field-extraction
   case) asserting the new shape's severity/category/location, so it can't silently regress.
4. **Update the support matrix** (README EN+KO) with the new row + its verification status.
5. **Open a PR** (`enhancement`), bump `gamedev` minor, tag `gamedev-v<x.y.z>` to publish to npm.

This is how JSONL support was added: a real `.jsonl` log tripped the low-coverage path, the ledger
showed the `{"<q>":…}` shape, and that became the JSON branch + eval guard. Prefer this over inventing a
CLI "auto-propose" command — the LLM writes better parsers than a regex heuristic, and the eval gate
keeps it honest.

## Why CLI (not an MCP server) by default

The CLI carries **no always-on context cost** — nothing sits in the prompt until you run it — whereas
an MCP server injects its tool schemas into every session. The ~99% output reduction is identical
either way. Users who prefer typed MCP tools can opt in (see the README), but the CLI is the default.
