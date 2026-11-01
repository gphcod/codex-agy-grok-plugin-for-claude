---
description: List this session's council jobs or await one and print its result
argument-hint: "[job] [--timeout <s>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Make one Bash tool call in the foreground. It starts no provider CLI. It waits up to `--timeout` seconds (90 by default); exit 20 means the job is still running.
If a line of the arguments is exactly `COUNCIL_EOF`, use another delimiter that is not in the text, in both places. Apart from that and the request id where the command has one, keep the command exactly as shown.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council.mjs" wait --session "${CLAUDE_SESSION_ID}" <<'COUNCIL_EOF'
$ARGUMENTS
COUNCIL_EOF
```

Act on the output or summarize it briefly; do not repeat it. A background call reports through its task notification; `/council:wait <job>` prints a finished result again. After `thread locked` or `session not confirmed`, start a new ask; after `cleanup pending`, run `/council:cancel <job>`.
