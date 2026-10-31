---
description: List this session's council jobs or await one and print its result
argument-hint: "[job] [--timeout <s>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Make one Bash tool call in the foreground. It starts no provider CLI. Exit 20 means the job is still running.
If a line of the arguments is exactly `COUNCIL_EOF`, use another delimiter that is not in the text, in both places; otherwise keep the command exactly as shown.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council.mjs" wait --session "${CLAUDE_SESSION_ID}" <<'COUNCIL_EOF'
$ARGUMENTS
COUNCIL_EOF
```

Act on the output or summarize it briefly; do not repeat it. `/council:wait <job>` prints a finished result again.
