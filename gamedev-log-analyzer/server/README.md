# gamedev-log-analyzer

Token-efficient **game-engine & build log analysis** for the terminal and for MCP agents (Claude Code).
Parses, deduplicates, and classifies huge **Unreal / Unity / Godot / MSVC-UBT-MSBuild** logs — search by
severity/category, roll up by callsite, diff runs, locate `file:line`, and extract scalar fields —
instead of pasting a tens-of-MB log into context. **No IDE required.** The CLI has **no runtime
dependencies**.

> Measured: a ~1 MB editor log (~267k tokens raw) → a `summary` of ~130 tokens (~99.95% fewer). See the
> [benchmark](https://github.com/JSungMin/rider-mcp-enforcer/blob/main/BENCHMARK.md).

## Use without installing

```bash
npx -p gamedev-log-analyzer gamedev-log detect --projectPath /path/to/UEProject
npx -p gamedev-log-analyzer gamedev-log summary --path /path/to/Editor.log
```

Or install the `gamedev-log` command globally:

```bash
npm i -g gamedev-log-analyzer
gamedev-log search --path Editor.log --severityMin Error --groupBy callsite
```

## Commands

| Command | What it does |
| --- | --- |
| `detect` | Find editor logs (newest first). |
| `summary` | Severity counts + top categories (no bodies). |
| `search` | Parse + dedup into templated groups with counts. `--groupBy callsite\|code` (code = roll up by diagnostic code like `C4996`/`LNK2019`). |
| `fields` | Columnar scalar extraction from trace logs. |
| `diff` | Delta between two logs (new/gone/changed only). |
| `locate` | Jump list: distinct `file:line` of matches. |
| `tail` | Last N raw lines. |
| `enforce` | Show/set log-read enforcement (PreToolUse hook over **Bash** raw reads *and* unbounded **Read**s of ≥200 KB logs; sliced `Read` passes): `warn` (default, allow + nudge), `block` (deny + nudge), `off`. Env override `GDLOG_ENFORCE`. |
| `setup` / `config` | Persist / show settings (`~/.gamedev-log-analyzer/config.json`). |

Run `gamedev-log` with no arguments for full usage. Settings precedence: env (`GDLOG_*`) > config file >
default.

## MCP server

The same engine is also an MCP server (`gamedev-log-analyzer` bin / `index.js`) used by the
[rider-mcp-enforcer](https://github.com/JSungMin/rider-mcp-enforcer) Claude Code marketplace, where it
installs as a plugin. The MCP server uses `@modelcontextprotocol/sdk` (an optional dependency); the CLI
does not.

## Privacy

Reads local files you point it at and prints compact summaries. It uploads nothing. See
[PRIVACY.md](https://github.com/JSungMin/rider-mcp-enforcer/blob/main/PRIVACY.md).

MIT © JSungMin
