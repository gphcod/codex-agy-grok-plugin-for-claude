---
name: council
description: Second opinions, reviews or delegated coding work from Codex, Gemini or Grok. Use when the user names one, or for a hard design or debugging question.
---

One Bash call per provider call. Options before `--`, text in a quoted heredoc:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council.mjs" ask --to grok --session "${CLAUDE_SESSION_ID}" --tier consult -- <<'COUNCIL_EOF'
<text>
COUNCIL_EOF
```

New delimiter if a line equals it. No input: `</dev/null`. Never append `|| true`.
No Bash tool: never put text in a PowerShell command. Write it to a new UTF-8 temp file, then PowerShell `node "…/council.mjs" ask … "--input-file=<file>" --; exit $LASTEXITCODE`.

- `ask --to codex|gemini|grok`: new read-only thread. `reply --thread <job|thread>` or `--last`: read-only delta; provider inherited.
- `review --to <p> [--base ref | --commit sha | --uncommitted] [--adversarial] [focus]`: read-only; `--adversarial` gemini/grok only. A clean Codex review reports `incomplete`: no approval.
- `task --to <p> [--thread id]`: edits files; needs a named model and authorization.
- `wait [job]`, `cancel [job]`, `models [--refresh]`, `setup`. `--model`, `--effort low…max` (clamped: `<=asked`), `--web` (grok).

Tiers consult · exec · deep:
- codex: gpt-6.1-sol/xhigh · gpt-6-luna/max · gpt-6.1-sol/xhigh
- grok: grok-4.7/high · grok-4.7-build-fast/xhigh · grok-4.7/xhigh
- gemini: gemini-4-argon/medium · gemini-3.8-flash/high · gemini-4-argon/high
User named no model (a provider is no model): ask/reply/review only, pass `--tier consult`, also on replies; ask once before higher effort. Never task, even for a fix or edit: ask or review, then say `/council:task` or naming a model lets the provider edit. User named one: tier by complexity; explicit model/effort wins; `ultra` (codex) only if named.

Fan-out: one background `ask` per provider in one response, same brief, each its own `--request-id`. Follow up with `reply --thread <job>`, never `--last`.

Open with Goal, Known, Files, Constraints, Done when. F1/F2 findings, BLOCKER/MAJOR/MINOR, file:line. Replies send only `F1 AGREE`, `F2 CHANGE: …`, `F3 REJECT: …` and new facts. Stop when nothing changes or at the footer's `round N/N`. Unresolved REJECT is disagreement.

`run_in_background: true` for every review, task, exec, deep, xhigh (codex consult), max or ultra call, with a fresh `--request-id <8 random letters/digits>` never used earlier in this conversation; else foreground, timeout 600000. Lost result: rerun unchanged, same id (replays, no second CLI). `already used with different input`: new id, rerun.
Footer: `council <p> <status> · job <id> · …`. Exit 0 done, 10 needs attention (findings, or `attention: <why>`), 20 still running, 1 failed/cancelled/busy, 2 invalid input.
Summarize, never repeat the answer. `full: <file>` holds a clipped answer; `unreviewed N` is no approval. `session not confirmed`, `thread locked`: new ask. `cleanup pending`: `cancel <job>` first.
