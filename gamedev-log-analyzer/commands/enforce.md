---
description: Show or set Bash log-grep enforcement (block / warn / off) — controls whether raw grep/tail/cat over .log/.jsonl/Logs is intercepted and steered to gamedev-log.
---

# gamedev-log-analyzer — enforcement control

A `PreToolUse` hook intercepts two raw-log vectors and steers them to `gamedev-log` (parse + dedup +
token-cap) instead of dumping raw lines into context:

- **Bash** raw reads (`grep`/`rg`/`ack`/`ag`/`findstr`/`tail`/`head`/`cat`) over a `.log` / `.jsonl` /
  rotated `.log.N` file or a `Logs/` · `Saved/Logs/` path.
- **Read tool** — an *unbounded* read of a *large* (≥ 200 KB) log file. A sliced read (`offset`/`limit`)
  always passes (one-step escape + fallback for poorly-parsed formats); small logs pass.

Code grep (`.cpp`/`.cs`/`src/…`), non-log reads, and the `Grep` tool (already result-capped) pass through.

Run the CLI through Bash (no setup; pure Node):

```bash
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" enforce            # show current mode + source
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" enforce warn       # allow, but nudge (soft)
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" enforce off        # disable enforcement
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" enforce block      # re-enable (default)
```

Modes:
- **warn** *(default)* — allow the command, but inject the `gamedev-log` equivalent into the model's
  context as a nudge. Steers without friction.
- **block** — deny the raw read (exit 2) and show the nudge — the command does **not** run. Opt-in.
- **off** — silent passthrough, no enforcement.

Mode precedence: env **`GDLOG_ENFORCE`** > `~/.gamedev-log-analyzer/config.json` (`"enforce"`) > default
`block`. For a one-shot bypass in the current shell, prefix the command with `GDLOG_ENFORCE=off`. After
changing the persisted mode, run `/reload-plugins`.

When a user hits the block but genuinely needs the raw bytes: for a `Read`, re-Read with `offset`/`limit`
(a bounded slice always passes); for Bash `tail -f` live-watching, suggest `enforce warn` (or `off`)
rather than working around the hook.
