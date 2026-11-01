---
name: council
description: Second opinions, reviews or delegated coding work from Codex, Gemini or Grok. Use when the user names one, or for a hard design or debugging question that needs an independent view.
---

One Bash call per provider call, never PowerShell. Options before `--`, text in a quoted heredoc:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council.mjs" ask --to codex --session "${CLAUDE_SESSION_ID}" --tier consult -- <<'COUNCIL_EOF'
<text>
COUNCIL_EOF
```

Slash form: no `--`, leading flags in the heredoc are parsed. Change the delimiter if a text line equals it. No input: `</dev/null`. Never append `|| true`.

- `ask --to codex|gemini|grok`: new read-only thread. `reply --thread <job|thread>` or `--last`: read-only delta; provider inherited, `--to` must match.
- `review --to <p> [--base ref | --commit sha | --uncommitted] [--adversarial] [focus]`: read-only; `--adversarial` gemini/grok only. A clean Codex review reports `incomplete`: read it, it is no approval.
- `task --to <p> [--thread id]`: may edit files, only when the user authorizes it.
- `wait [job]`, `cancel [job]`, `models [--refresh]`, `setup`. `--model`, `--effort low…max` (clamped, shown as `<=asked`), `--web` (grok).

Tiers consult · exec · deep:
- codex: gpt-6.1-sol/high · gpt-6-luna/max · gpt-6.1-sol/xhigh
- grok: grok-4.7/high · grok-4.7-build-fast/xhigh · grok-4.7/xhigh
- gemini: gemini-4-argon/high · gemini-3.8-flash/high · gemini-4-argon/high
User named no model: ask/reply/review only, pass `--tier consult`, also on replies; ask once before higher effort (not for gemini); never task. User named one: tier by complexity; explicit model/effort wins; `ultra` (codex) only if named.

Fan-out: one background `ask` per provider in one response, same brief, each its own `--request-id`. Compare side by side; report disagreement. Follow up with `reply --thread <job>`, never `--last`.

Open with Goal, Known, Files, Constraints, Done when. F1/F2 findings, BLOCKER/MAJOR/MINOR, file:line. Replies send only `F1 AGREE`, `F2 CHANGE: …`, `F3 REJECT: …` and new facts. Stop when nothing changes or at the footer's `round N/N` (9 unless `--rounds`). Unresolved REJECT is disagreement, never consensus.

`run_in_background: true` for every review, task, exec, deep, xhigh, max or ultra call, with `--request-id <8 random letters/digits>`; others: foreground, timeout 600000. Lost result: rerun it unchanged with the same id (it replays, never a second CLI). New work, new id.
Footer: `council <p> <status> · job <id> · <model>/<effort> · …`. Exit 0 done, 10 needs attention (findings, denied action, incomplete review), 20 still running, 1 failed/cancelled/busy, 2 invalid input. The notification carries completion; `wait <job>` replays it.
Summarize, never repeat the answer. `full: <file>` holds a clipped answer; `unreviewed N` is no approval. `session not confirmed` or `thread locked`: start a new ask. `cleanup pending`: `cancel <job>` first. Never delete claims by hand.
