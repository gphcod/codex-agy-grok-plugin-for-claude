---
description: Check binaries, login, versions, catalog age and resolved tiers for each provider
argument-hint: "[--to codex|gemini|grok]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Make one Bash tool call in the foreground. It runs each provider's version, login and model-listing probes and no model turn.
If a line of the arguments is exactly `COUNCIL_EOF`, use another delimiter that is not in the text, in both places. Apart from that and the request id where the command has one, keep the command exactly as shown.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council.mjs" setup --session "${CLAUDE_SESSION_ID}" <<'COUNCIL_EOF'
$ARGUMENTS
COUNCIL_EOF
```

Act on the output or summarize it briefly; do not repeat it. A background call reports through its task notification; `/council:wait <job>` prints a finished result again. After `thread locked` or `session not confirmed`, start a new ask; after `cleanup pending`, run `/council:cancel <job>`.
