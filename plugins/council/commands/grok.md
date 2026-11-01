---
description: Ask Grok a question on a new read-only thread
argument-hint: "[--tier consult|exec|deep] [--model <m>] [--effort <e>] <question>"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Make one Bash tool call: in the foreground with timeout 600000, or with `run_in_background: true` when the arguments carry `--tier deep` or `--effort xhigh`, `max` or `ultra`.
If a line of the arguments is exactly `COUNCIL_EOF`, use another delimiter that is not in the text, in both places; otherwise keep the command exactly as shown.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council.mjs" ask --to grok --session "${CLAUDE_SESSION_ID}" <<'COUNCIL_EOF'
$ARGUMENTS
COUNCIL_EOF
```

Act on the output or summarize it briefly; do not repeat it. A background call reports through its task notification; `/council:wait <job>` prints a finished result again. After `thread locked` or `session not confirmed`, start a new ask; after `cleanup pending`, run `/council:cancel <job>`.
