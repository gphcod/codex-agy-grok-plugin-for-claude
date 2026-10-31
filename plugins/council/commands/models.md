---
description: Print the model catalog and cached listings; --refresh re-runs the listings
argument-hint: "[--to codex|gemini|grok] [--refresh]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Make one Bash tool call in the foreground. It starts no provider CLI. With `--refresh` it runs each provider's model-listing command once.
If a line of the arguments is exactly `COUNCIL_EOF`, use another delimiter that is not in the text, in both places; otherwise keep the command exactly as shown.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council.mjs" models --session "${CLAUDE_SESSION_ID}" <<'COUNCIL_EOF'
$ARGUMENTS
COUNCIL_EOF
```

Act on the output or summarize it briefly; do not repeat it. `/council:wait <job>` prints a finished result again.
