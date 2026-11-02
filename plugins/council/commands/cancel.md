---
description: Stop a council job and confirm its cleanup
argument-hint: "[job] [--timeout <s>]"
disable-model-invocation: true
allowed-tools: Bash(node:*), PowerShell(node:*), Write
---

Make one Bash tool call in the foreground. It starts no provider CLI. It returns once cleanup is confirmed.
If a line of the arguments is exactly `COUNCIL_EOF`, use another delimiter that is not in the text, in both places. Apart from that and the request id where the command has one, keep the command exactly as shown.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council.mjs" cancel --session "${CLAUDE_SESSION_ID}" <<'COUNCIL_EOF'
$ARGUMENTS
COUNCIL_EOF
```

If this session has no Bash tool, use the PowerShell tool with the same background and timeout rule. Never put the arguments in a PowerShell command: use the Write tool to save them verbatim, even when empty, to a new UTF-8 file named `council-${CLAUDE_SESSION_ID}-<8 random letters and digits>.txt` in the system temp directory, outside the repository. Once it is written, run this with `<file>` replaced by its full path:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/council.mjs" cancel "--session=${CLAUDE_SESSION_ID}" "--input-file=<file>"
```

Act on the output or summarize it briefly; do not repeat it. A background call reports through its task notification; `/council:wait <job>` prints a finished result again. After `thread locked` or `session not confirmed`, start a new ask; after `cleanup pending`, run `/council:cancel <job>`.
