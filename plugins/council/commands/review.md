---
description: Review uncommitted changes, a branch against a base, or one commit
argument-hint: "--to codex|gemini|grok [--base <ref> | --commit <sha> | --uncommitted] [--adversarial] [--tier consult|deep] [focus]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Make one Bash tool call with `run_in_background: true`. Exit 10 means findings need attention.
If a line of the arguments is exactly `COUNCIL_EOF`, use another delimiter that is not in the text, in both places; otherwise keep the command exactly as shown.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council.mjs" review --session "${CLAUDE_SESSION_ID}" <<'COUNCIL_EOF'
$ARGUMENTS
COUNCIL_EOF
```

Act on the output or summarize it briefly; do not repeat it. `/council:wait <job>` prints a finished result again.
