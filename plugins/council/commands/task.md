---
description: Delegate work that may edit the working tree (user-authorized only)
argument-hint: "--to codex|gemini|grok [--thread <id>] [--tier exec] <task>"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Make one Bash tool call with `run_in_background: true`. The user authorizes every task by running this command; never start one on your own.
Replace `@RID@` with 8 random letters and digits; a `--request-id <id>` in the arguments takes precedence. If the result is lost, rerun the identical command with the same id: it replays the first result and never starts a second CLI. New work needs a new id.
If a line of the arguments is exactly `COUNCIL_EOF`, use another delimiter that is not in the text, in both places. Apart from that and the request id where the command has one, keep the command exactly as shown.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council.mjs" task --request-id @RID@ --session "${CLAUDE_SESSION_ID}" <<'COUNCIL_EOF'
$ARGUMENTS
COUNCIL_EOF
```

Act on the output or summarize it briefly; do not repeat it. A background call reports through its task notification; `/council:wait <job>` prints a finished result again. After `thread locked` or `session not confirmed`, start a new ask; after `cleanup pending`, run `/council:cancel <job>`.
