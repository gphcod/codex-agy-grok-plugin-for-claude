---
description: Ask Codex a question on a new read-only thread
argument-hint: "[--tier consult|exec|deep] [--model <m>] [--effort <e>] <question>"
disable-model-invocation: true
allowed-tools: Bash(node:*), PowerShell(node:*), Write
---

Make one Bash tool call. Run it with `run_in_background: true` when the tier is deep or the effective effort is xhigh or above: the arguments carry `--tier deep`, `--effort xhigh`, `max` or `ultra`, or `--tier exec` and no `--effort` below xhigh (codex's exec tier runs at max). Default consult calls for `codex` also run in the background when `--tier` is omitted or consult, unless `--effort` is below xhigh. Otherwise run it in the foreground with timeout 600000.
Replace `@RID@` with 8 random letters and digits, a fresh id never used earlier in this conversation; a `--request-id <id>` in the arguments takes precedence. If the result is lost, rerun the identical command with the same id: it replays the first result and never starts a second CLI. If it says the id was already used with different input, pick a new id and rerun.
If a line of the arguments is exactly `COUNCIL_EOF`, use another delimiter that is not in the text, in both places. Apart from that and the request id where the command has one, keep the command exactly as shown.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council.mjs" ask --to codex --request-id @RID@ --session "${CLAUDE_SESSION_ID}" <<'COUNCIL_EOF'
$ARGUMENTS
COUNCIL_EOF
```

If this session has no Bash tool, use the PowerShell tool with the same background and timeout rule. Never put the arguments in a PowerShell command: use the Write tool to save them verbatim, even when empty, to a new UTF-8 file named `council-${CLAUDE_SESSION_ID}-<8 random letters and digits>.txt` in the system temp directory, outside the repository. Once it is written, run this with `<file>` replaced by its full path:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/council.mjs" ask --to codex --request-id @RID@ "--session=${CLAUDE_SESSION_ID}" "--input-file=<file>"
```

Act on the output or summarize it briefly; do not repeat it. A background call reports through its task notification; `/council:wait <job>` prints a finished result again. After `thread locked` or `session not confirmed`, start a new ask; after `cleanup pending`, run `/council:cancel <job>`.
