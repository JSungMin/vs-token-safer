---
description: Stop the vs-token-safer dashboard server started by /vs-token-safer:viz (frees the port; nothing was ever transmitted).
---

# vs-token-safer — stop the dashboard

Shut down the local dashboard server. It reads the pidfile written at start and signals that process.

Do this:

1. Run:
   ```
   vts serve --stop
   ```
   or, if `vts` is not on PATH:
   ```
   node "$CLAUDE_PLUGIN_ROOT/server/cli.js" serve --stop
   ```

2. Report its output verbatim — it says whether it stopped the dashboard, found nothing running, or
   cleared a stale pidfile.

(If the dashboard was started in this session as a background process, you may also stop that background
task directly. `--stop` is the reliable way when the process was launched in another turn/session.)
