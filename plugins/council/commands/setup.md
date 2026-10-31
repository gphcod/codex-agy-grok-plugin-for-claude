---
description: Check binaries, login, versions, catalog age and resolved tiers for each provider
argument-hint: "[--to codex|gemini|grok]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Make one Bash tool call in the foreground. It starts no provider CLI. It runs each provider's documented probe commands.
If a line of the arguments is exactly `COUNCIL_EOF`, use another delimiter that is not in the text, in both places; otherwise keep the command exactly as shown.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council.mjs" setup --session "${CLAUDE_SESSION_ID}" <<'COUNCIL_EOF'
$ARGUMENTS
COUNCIL_EOF
```

Act on the output or summarize it briefly; do not repeat it. `/council:wait <job>` prints a finished result again.
