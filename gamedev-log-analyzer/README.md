# gamedev-log-analyzer

**English** · [한국어](README.ko.md) · part of the [rider-mcp-enforcer marketplace](../README.md#marketplace--two-plugins)

[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-7C3AED)](https://code.claude.com/docs/en/plugins)
[![CLI](https://img.shields.io/badge/CLI-zero%20deps-1f6feb)](#how-claude-uses-it-cli-by-default)
[![npm](https://img.shields.io/npm/v/gamedev-log-analyzer)](https://www.npmjs.com/package/gamedev-log-analyzer)
[![release](https://img.shields.io/github/v/release/JSungMin/rider-mcp-enforcer)](https://github.com/JSungMin/rider-mcp-enforcer/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](../LICENSE)
[![Stars](https://img.shields.io/github/stars/JSungMin/rider-mcp-enforcer?style=social)](https://github.com/JSungMin/rider-mcp-enforcer/stargazers)

A Claude Code plugin that reads huge editor logs without blowing up the context. Unreal
`Saved/Logs/*.log` and Unity `Editor.log` are often tens of MB of repeated spam, and `cat`/`grep` dumps
all of it into the conversation. This plugin parses, deduplicates, and classifies the log instead. No
IDE needed; it's pure file parsing.

## Why it's fast (measured)

Real numbers on a live Unreal log (no project source reproduced):

| Task | Raw | This plugin | Reduction |
| --- | ---: | ---: | ---: |
| Read a 57 MB UE log | ~1,250,000 tok | ~2,500 tok (deduped summary) | **~99.8%** |
| Search one trace tag (9,226 hits) | ~690,000 tok | ~1,700 tok (callsite rollup) | **~99.8% (~410×)** |
| Pull decisive scalars from a window | ~35,000 tok (raw dump) | ~160 tok (`log_fields`) | **~99.5%** |

The idea is simple: never put raw log lines in the context. Emit deduped groups, a callsite rollup, or
just the scalar columns that actually decide the answer.

## What it does

- **Parses** each line into `{severity, category, file:line, message}` across several engines (see the
  support matrix below), with a generic severity-keyword fallback for anything unrecognized.
- **Template dedup:** numbers/addresses/GUIDs/paths/instance-ids are normalized so repeated spam
  collapses into one group with a `×count` and representative locations.
- **Search/filter:** by `severityMin`, `category`, `file`, `query`; `groupBy: "callsite"` rolls
  everything up by `file:line` (best for "what's flooding my log"), and `groupBy: "code"` rolls up by
  diagnostic code (`C4996`, `LNK2019`, `CS1002` …) — a noisy build with hundreds of warnings collapses
  to one line per code (`C4996: … (×37)`), the cheapest way to triage a build instead of grepping it.
- **`log_fields`:** generic columnar extractor for dense per-frame trace logs — pulls only the chosen
  scalars (`Key`, `Key.x|.y|.z`, `Key.Y|.P|.R`, `ts`, `dts`, `d:Key`, `step:Key`).
- **`log_diff`:** compare two logs (before/after) and emit **only the delta** — new errors, errors that
  disappeared, and groups whose count changed. Unchanged groups are omitted, so a regression-triage diff
  across runs costs a fraction of re-reading either log.
- **Enforcement (opt-out):** a `PreToolUse` hook catches raw Bash log dumps (`grep`/`tail`/`cat`/`rg`
  over a `.log`/`.jsonl`/`Logs` path) and unbounded `Read`s of large (≥ 200 KB) logs, and points them
  here, so the cheap path is the default rather than something you have to remember. A sliced `Read`
  (`offset`/`limit`) always goes through. `warn` (the default) runs the command and nudges, `block`
  denies it, `off` turns the hook off; switch with `gamedev-log enforce <mode>` or `GDLOG_ENFORCE`. You
  can also hand the whole job to the `log-analyst` subagent.

## Supported log formats

| Source | Example line | Category | Verification |
| --- | --- | --- | --- |
| **Unreal runtime** | `[..][f]LogTemp: Error: msg` | the `Log*` category | ✅ live-verified (18–57 MB real logs) |
| **MSVC / UBT / MSBuild compile** | `Foo.cpp(120): error C2065: msg` | `Build` | ✅ live-verified |
| **MSVC / UBT linker** | `Foo.obj : error LNK2019: msg` | `Build` | ✅ live-verified |
| **Unity C# compile** | `Assets/X.cs(12,34): error CS1002: msg` | `Build` | ✅ verified (shares the compile path) |
| **Unity runtime / stack** | `NullReferenceException …`, `(at Assets/X.cs:42)` | generic + location | ⚠️ best-effort — **not** verified against real Unity logs |
| **Godot** | `SCRIPT ERROR: …`, `at: f (res://x.gd:42)` | `Godot` | ⚠️ best-effort — **not** verified against real Godot logs |
| **JSONL** (UE structured / bunyan / pino / Serilog) | `{"ts":..,"verbosity":..,"stage":..,"message":..}` | `stage`/`logger`/`category` | ✅ live-verified (real UE `AIMovementDebug.jsonl`) |
| **Python logging** | `2024-01-02 03:04:05,123 - app - ERROR - msg` | the logger name | ⚠️ best-effort |
| **Bracketed level** | `[WARN] msg`, `[ERROR] msg` | `Log` | ⚠️ best-effort |
| **Anything else** | severity keyword (`error`/`warning`/`exception`/…) | generic + location | partial fallback |

**JSONL is fully supported**, including `log_fields`: top-level keys (`ts`, …) and any `Key=value` /
`Key=(x,y,z)` inside the `message` string are extracted, so a structured per-frame trace like
`{"ts":…,"stage":"Pos","message":"Pawn=A Actor=(x,y,z) Vel=…"}` works with
`gamedev-log fields --category Pos --fields ts,Actor.x,Actor.y,Vel,step:Actor --window t0,t1`.

> ⚠️ **Unity-deep and Godot parsing are best-effort from each engine's public docs/console output — they
> have NOT been verified against real Unity/Godot project logs yet.** Unrecognized lines still get the
> generic fallback, and the local **learnings ledger** (`gamedev-log learnings`) reports templated shapes of
> unparsed lines so real-world gaps surface as concrete parser candidates. When a file barely parses,
> `summary`/`search`/`fields` also print a one-line `⚠ Only N% parsed` nudge — that's the self-learning
> loop that grew JSONL support (see the skill's *Growing format coverage*). Real Unity/Godot log samples
> (sanitized) are very welcome — please open an issue.

## How Claude uses it (CLI by default)
Claude reaches the analyzer through a **skill** that shells out to the `gamedev-log` CLI — there is **no
always-on context cost** (nothing sits in the prompt until a log is actually relevant). Just ask
"check the editor logs" / "what's flooding the log" / "what changed since the last run", or run the
`/gamedev-log-analyzer:logs` command. Under the hood it runs:

```bash
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" <command> [--flags]
```

**Commands** (`gamedev-log <command>`): `detect`, `summary`, `search`, `fields` (`--stats` for
per-column min/max/avg/Δ), `diff`, `locate`, `tail`, `learnings`, `learnings-reset`, `savings`,
`savings-reset`, `enforce` (`block`/`warn`/`off`), `setup`, `config`.

```bash
# Run directly too — in scripts, CI, or any agent (pure Node, no dependencies):
node server/cli.js detect --projectPath /path/to/UEProject
node server/cli.js search --path Editor.log --severityMin Error --groupBy callsite
node server/cli.js fields --path trace.log --fields Pawn,Alpha,ts --query Tick --max 20
node server/cli.js diff   --pathA before.log --pathB after.log --severityMin Error
node server/cli.js locate --path Editor.log --severityMin Error --basename
node server/cli.js --help
```

To jump from a log error to its source, `locate` emits just the distinct `file:line` (no message
bodies). If [rider-mcp-enforcer](../README.md) is installed, resolve each basename via its
`find_files_by_name_keyword`, then `read_file` a small window at that line instead of dumping whole files.

## The `log-analyst` subagent

The plugin ships a subagent, `gamedev-log-analyzer:log-analyst`. Rather than run the CLI in your own
context, hand it the task and let it do the parsing in a separate context, returning only the answer.
The raw log lines never reach your main context, so a multi-MB log costs a few hundred tokens and your
working set stays small.

Ask for it in plain language and Claude routes to it from the agent's description:

> "analyze `…/Saved/Logs/Editor.log` — top errors and warnings, and roll the build warnings up by code"

You can also name it directly. It picks the right command (`summary`/`search`/`diff`/`locate`/`fields`/
`--groupBy code`), runs it, and replies with a deduped severity picture and the `file:line`s worth
opening, not a raw dump. It only needs Node, since it shells out to the CLI. The enforcement hook below
is the fallback for when a raw `grep` or `Read` slips through.

## Enforcement

Reading a log with `tail … | grep …`, or opening a multi-MB log with the `Read` tool, dumps raw lines
straight into the context, which is exactly what this plugin exists to avoid. A `PreToolUse` hook closes
both gaps:

- **Bash**: an **unbounded** read (`cat`, a bare `grep`/`rg`, `tail -f`, `tail -n +N`, or a large
  `tail -n N`) of a **log target** (`.log`, `.jsonl`, rotated `.log.N`, or a path under `Logs/` /
  `Saved/Logs/`) is intercepted — including when the path is held in a shell variable
  (`log="….log"; cat "$log"`), where the read and the path live in different segments. A **bounded
  peek** — `tail`/`head` of ≤ 50 lines (default 10), or a count-only `grep -c`/`rg -c` — **passes**,
  since its output is a handful of lines or a single number, not a context flood (the Bash analogue of
  the Read-slice escape). (A non-`.log`/`.jsonl` extension like `.output` is **not** matched unless it
  sits under a `Logs/` path — by design, since it can't be size-gated on Bash.)
- **Read tool**: an **unbounded** read of a **large** log file (≥ 200 KB) is intercepted. A *sliced*
  read (`offset`/`limit` present) always passes — that's a one-step escape and the fallback for any
  format the analyzer parses poorly, so a blocked Read never strands you. Small logs (< 200 KB) pass
  (a raw read is already cheap).

Code grep (`.cpp`/`.cs`/`src/…`) and non-log reads pass through untouched — that domain belongs to
[rider-mcp-enforcer](../README.md), which deliberately lets logs through. The `Grep` tool is left
alone: it's already line-scoped and result-capped, so it isn't a context flood.

| Mode | Behavior |
| --- | --- |
| `warn` *(default)* | Allow the command, but inject the `gamedev-log` equivalent into the model's context as a nudge. Steers without friction. |
| `block` | Deny the command (exit 2) and show the nudge — the raw read does **not** run. Opt-in hard enforcement. |
| `off` | Silent passthrough — no enforcement. |

Why `warn` by default: the hard-block guarantee was always porous — the `Grep` tool, MCP search, and
the `Read` tool bypass enforcement entirely — so denying-by-default paid friction (false-blocks on
commands that merely *mention* a log path) for a guarantee that didn't hold. `warn` keeps the steering,
drops the friction; `block` remains one command away when you want a hard gate.

```bash
gamedev-log enforce            # show current mode + source
gamedev-log enforce block      # opt into hard denial
gamedev-log enforce off        # disable entirely
gamedev-log enforce warn       # back to the default (nudge only)
GDLOG_ENFORCE=block <cmd>      # per-shell override (env beats config)
```

Mode is read **env `GDLOG_ENFORCE` > `~/.gamedev-log-analyzer/config.json` > default `warn`**. The hook
fails open — any parse/IO error (missing file, permission denied, a directory, an unstattable path)
allows the action, so it never wedges your workflow.

## Optional: enable the MCP server
The same engine ([`server/logs.js`](server/logs.js) + [`server/core.js`](server/core.js)) also runs as
an MCP server (typed `log_*` tools, auto-discovered inside Claude Code). It is **off by default**
because a connected MCP server injects its tool schemas into **every** session (~1–1.5k tok always-on),
whereas the CLI costs nothing until used. The headline **~99% reduction is output compression and is
identical either way** — only the always-on overhead differs.

Turn it on if you prefer typed tools / structured args (no shell quoting):

```bash
# 1) install the MCP SDK once (the CLI needs no deps; the MCP server does)
cd server && npm install && cd ..
# 2) add .mcp.json at the plugin root, then /reload-plugins:
#    { "mcpServers": { "gamedev-log": { "command": "node",
#      "args": ["${CLAUDE_PLUGIN_ROOT}/server/index.js"] } } }
```

This exposes `log_detect`, `log_summary`, `log_search`, `log_fields`, `log_diff`, `log_tail`,
`log_learnings`, `log_learnings_reset`, `log_savings`, `log_savings_reset`, `log_setup`, `log_config`
— byte-identical output to the CLI.

## Prerequisites
- **Node.js ≥ 18** on PATH. (No Rider/Unity install needed — it only reads the log file. The default
  CLI path has **zero npm dependencies**; only the optional MCP server needs `npm install`.)

## Install
```bash
/plugin marketplace add JSungMin/rider-mcp-enforcer
/plugin install gamedev-log-analyzer@rider-mcp-enforcer
/reload-plugins
/gamedev-log-analyzer:logs                        # or: ask "check the editor logs"
```
No build, no `npm install` — the CLI is pure Node. (Installing `rider-mcp-enforcer` also pulls this in
automatically — see the [marketplace](../README.md#marketplace--two-plugins).) To use typed MCP tools
instead, see [Optional: enable the MCP server](#optional-enable-the-mcp-server).

### Standalone CLI (npm — no Claude Code needed)
The analyzer is also published to **[npm](https://www.npmjs.com/package/gamedev-log-analyzer)**, so you
can run it anywhere — scripts, CI, other agents:
```bash
npx -p gamedev-log-analyzer gamedev-log --help
npx -p gamedev-log-analyzer gamedev-log search --path Editor.log --severityMin Error --groupBy callsite
npx -p gamedev-log-analyzer gamedev-log fields --path trace.jsonl --category Pos --fields ts,Actor.x,Vel,step:Actor
# or install globally, then just `gamedev-log <command>`:
npm i -g gamedev-log-analyzer
```

## Setup
Settings live in `~/.gamedev-log-analyzer/config.json` (precedence: env > config > default). Configure via
`gamedev-log setup …` (e.g. `node server/cli.js setup --projectPath "<dir>"`) or env vars:

| env | config key | default | meaning |
| --- | --- | --- | --- |
| `GDLOG_PROJECT_PATH` | `projectPath` | — | Project root; UE logs auto-found under `<root>/Saved/Logs` (incl. one subdir level for the `.uproject` dir). |
| `GDLOG_PATH` | `logPath` | — | Explicit default log file. |
| `GDLOG_MAX_BYTES` | `logMaxBytes` | `5000000` | Huge logs: read only the last N bytes. |
| `GDLOG_MAX_GROUPS` | `maxGroups` | `40` | Max deduped groups per `log_search`. |
| `GDLOG_MAX_LINE_CHARS` | `maxLineChars` | `200` | Max chars per shown snippet. |

## Pairs with rider-mcp-enforcer
Log entries carry `file:line`. If [rider-mcp-enforcer](../README.md) is also installed, feed those
locations to its `get_symbol_info` / `read_file` to jump straight to the source. See
[Using both together](../README.md#using-both-together).

## Version history
See the **[Releases](https://github.com/JSungMin/rider-mcp-enforcer/releases)** page — every `v*` tag
publishes categorized, PR-linked notes automatically. The release badge above always points at the latest.

## License
MIT © 2026 JSungMin
