---
description: {{description}}
argument-hint: "{{argument-hint}}"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

{{background-rule}}
If a line of the arguments is exactly `COUNCIL_EOF`, use another delimiter that is not in the text, in both places; otherwise keep the command exactly as shown.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council.mjs" {{verb}}{{fixed-flags}} --session "${CLAUDE_SESSION_ID}" <<'COUNCIL_EOF'
$ARGUMENTS
COUNCIL_EOF
```

Act on the output or summarize it briefly; do not repeat it. `/council:wait <job>` prints a finished result again.
