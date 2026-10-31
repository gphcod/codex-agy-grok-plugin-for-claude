---
description: Continue a thread with a delta reply (provider inherited, read-only)
argument-hint: "[--thread <job|thread> | --last] [--model <m>] [--effort <e>] <reply>"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Make one Bash tool call: foreground with timeout 600000, or `run_in_background: true` for `--tier deep` or an effort of xhigh, max or ultra.
If a line of the arguments is exactly `COUNCIL_EOF`, use another delimiter that is not in the text, in both places; otherwise keep the command exactly as shown.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council.mjs" reply --session "${CLAUDE_SESSION_ID}" <<'COUNCIL_EOF'
$ARGUMENTS
COUNCIL_EOF
```

Act on the output or summarize it briefly; do not repeat it. `/council:wait <job>` prints a finished result again.
