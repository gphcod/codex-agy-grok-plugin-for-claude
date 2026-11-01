# S7.1 macOS matrix (Claude Code host)

Date 2026-11-01. Candidate: `main` at 49b020d, plugin version 1.0.0-rc.1, loaded with `claude -p --plugin-dir` (see "How it was run"). Providers: codex-cli 0.163.0, agy 1.4.12, grok 1.0.70, all native launchers. Claude Code 2.1.314, model opus.

Each cell: expected exit / observed exit / job id or output file. Turn cells were driven by the slash commands at `--effort low` unless noted. Evidence files are under the tester's scratch directory `…/scratchpad/install/cc/out/` (`<name>.jsonl` is the stream-json of the host session, `bgout/*.output` the Bash output of background calls); job records are under `~/.council/jobs/<job>/`.

| Row | codex | gemini | grok |
|---|---|---|---|
| `ask` | 0 / 0 / `15608a62e1de1e41` | 0 / 0 / `6c6b2e07a1791f5f` | 0 / 0 / `fdb41527024b944b` |
| `reply --last` | 0 / 0 / `fcef2c4f7eda9d0d` (round 2/9) | 0 / 0 / `12a45460aa7d5db4` (round 2/9) | 0 / 0 / `7ec3cd50135a9567` (round 2/9) |
| `reply --thread <ask job>` | 0 / 0 / `b0dc26fa4ecc79d8` (round 3/9) | 0 / 0 / `74988126598a143d` (round 3/9) | 0 / 0 / `c390a024176cfa5a` (round 3/9) |
| `review --uncommitted` | 10 / 10 / `84e8ba5d1f15fc53` (1 finding, calc.js:10) | 10 / 10 / `2d3c129c5b84008a` (1 finding) | 10 / 10 / `f9516007659521bd` (1 finding) |
| `review --base main` | 10 / 10 / `d1d134363478f59b` (3 findings) | 10 / 10 / `469aceeb5db8caf0` (3 findings) | 10 / 10 / `a70aa72b11fd4b93` (3 findings) |
| `review --commit ad6d642` | 10 / 10 / `89b2853a63b9ca09` (stats.js:5) | 10 / 10 / `b742a73d6d8e34ff` (stats.js:5) | 10 / 10 / `a6ab4cb64e7260bc` (stats.js:5) |
| `review --uncommitted --adversarial` | 2 / 2 / no job; `review-adv-codex.jsonl` (`review --to codex has no --adversarial`) | 10 / 10 / `725fbffef33051f4` | 10 / 10 / `62bc4224f3754ee2` |
| `task` (authorized, scratch tree) | 0 / 0 / `d26572844e2c98ce`, footer `edited 0` although calc.js changed (issue 2) | 0 / 0 / `1d627f1193edc15e`, `edited 1` | 0 / 0 / `820e5769a15d9334`, `edited 1` |
| `wait` (bare list) | 0 / 0 / `wait-list-codex.jsonl` (3 jobs) | 0 / 0 / `wait-list-gemini.jsonl` (3 jobs) | 0 / 0 / `wait-list-grok.jsonl` (3 jobs) |
| `wait <job>` (replay) | 0 / 0 / `wait-job-codex.jsonl` | 0 / 0 / `wait-job-gemini.jsonl` | 0 / 0 / `wait-job-grok.jsonl` |
| `cancel <job>` | 0 / 0 / `cancel-codex.jsonl`; job `5c7012cacfee4db3` cancelled, exit 1 | 0 / 0 / `cancel-gemini.jsonl`; job `84f3d97de3602084` cancelled, exit 1 | 0 / 0 / `cancel-grok.jsonl`; job `612088fbce7655f8` cancelled, exit 1 |
| `models --refresh` | 0 / 0 / `models-refresh.jsonl` (one run, all three) | same file | same file |
| `setup` | 0 / 0 / `../cc-setup.jsonl` (one run, all three ready) | same file | same file |
| `/council:codex` · `/council:gemini` · `/council:grok` | 0 / 0 / `b54bb31b3026150a` | 0 / 0 / `c0887df38036b5d8` | 0 / 0 / `3de6d25d6030d0d0` |

Every review flagged the planted bugs: the uncommitted `n > lo` (calc.js:10), the off-by-one in `mean` (stats.js:5, commit ad6d642) and the wrong comparison in `max` (max.js:4). `--base` reviews the branch plus the working tree (label `branch against main (…) plus working tree`), as PLAN.md's diff-collection rule specifies; the README review row does not say so.

## Host integration

- **`@RID@`.** Replaced in all 30 slash-command turn calls with 8 letters/digits; never left literal. The ids are not random: `k7Qm2xP9` appears in 9 jobs from 9 different sessions and 22 of 37 jobs start with `k7`. No collision followed, because request claims are scoped by session and workspace.
- **Background.** Every `/council:review` and `/council:task` ran with `run_in_background: true`; `ask`, `reply` and the shortcuts at low effort ran in the foreground with timeout 600000; `wait`, `cancel`, `models` and `setup` ran in the foreground.
- **`-p` and background calls.** The `-p` process does not exit while a background Bash call runs. It receives the `task_notification`, starts a further turn in the same session, reads the output file and reports. So `-p` exercises the notification path faithfully; it differs from the app only in that no user can type in between.
- **`--resume`.** Keeps the Claude session id, so `--session` stays the same and `reply --last` and bare `wait` see earlier jobs.
- **Fan-out** (`fanout.jsonl`, natural-language prompt naming council and all three providers): the `council:council` skill loaded; the three `ask` calls were issued in one assistant message (`msg_011Cgckcb55EY66EgLLNWKAq`), each `run_in_background: true`, `--tier consult`, its own request id, the same Goal/Known/… brief. Jobs `3c10aa489067e89a`, `5286fb7677d60941`, `2846ef21f17a836e` (exit 0). The resumed turn (`fanout-reply.jsonl`) issued three `reply --thread <job> --tier consult` calls in one message: jobs `ef958fc4be966950`, `4f181da215333c95`, `3d85f16a898cefce` (round 2/9, exit 0). No `--last`.
- **Skill choice.** "Use council to have Codex review my uncommitted changes" → `council:council`, `review --to codex --tier consult --uncommitted` in the background with a request id (job `a5ad81bd28795889`, exit 10). "Have Grok review my uncommitted changes" (provider named, council not named) → the old `grok-build:grok` skill, at its deep tier. Expected until S8 removes the old plugins.
- **Task without a named model.** "Use council to get Grok to fix the inRange bug in calc.js" → the council skill started `task --to grok` (job `0d2254b09c482cc9`, exec tier, xhigh) without `--session`, against the skill's "User named no model: … never task" (`nl-task.jsonl`).

## How it was run

- Route: `claude -p "<prompt>" --plugin-dir <repo>/plugins/council --output-format stream-json --verbose < /dev/null`, launched through a wrapper that unsets `CLAUDE*`/`CODEX*`/`COUNCIL*`, cwd in a scratch git repository per provider (base commit on `main`, branch `feature` with two buggy commits, one uncommitted bug). Tasks ran in separate copies. This is the headless route, not the interactive app; the interactive part of S7.1 stays with the user.
- Follow-up cells (`reply --last`, `reply --thread`, `wait`) continued the `ask` session with `--resume <session_id>`. Reviews, tasks, shortcuts, cancel and models ran in fresh sessions.
- Cancel: a foreground `/council:<p> --effort low -- Count from 1 to 1500…` session, and, once its job was running, a second session ran `/council:cancel <job>`.
- Slash-command sessions ran in the default permission mode; the commands' `allowed-tools: Bash(node:*)` covered their calls. Natural-language sessions were given `--allowedTools "Bash(node:*)"`, because in `-p` mode nothing can answer a permission prompt.
- The three old plugins (codex 2.3.2, grok-build 1.1.5, gemini 2.1.0) were installed and visible throughout.
- Cost: 45 host sessions, $10.88 as reported by the streams' `total_cost_usd` (plus the earlier setup session, $0.18). 37 council provider turns, 1 grok-build review, one `models --refresh` (three listings).

## Fixes after the matrix

Branch `s7-fixes-cc`. The shared rulings are recorded in `docs/decisions.md` under "2026-11-01 S7.1 fixes". Evidence files are under the tester's scratch directory `…/scratchpad/install/fix-cc/`.

| Issue | Fix | Commit | Evidence |
|---|---|---|---|
| X1: a turn exiting 10 printed a bare `needs attention` | Footer token `attention: <reason>` and `--json` field `attention` | 15ce244 | Fakes only: `tests/core-attention.test.mjs`, all three providers' denials, open questions, malformed review, plain findings, replay through `wait`. No live denial was re-run. |
| X2: `edited 0` after a shell edit (`d26572844e2c98ce`) | Git snapshot before and after every task, unioned with the edit events | dbe78f5 | Fakes: `tests/core-edited.test.mjs`. Live, one paid run: job `hjcit7rpicgm4mpk`, Codex edited `calc.js` with `sed -i`, no `file_change` event, footer below. |
| X3: the footer's 200 B clip dropped a message's action | Messages that can exceed it say the action first (`MESSAGES`) | 1f5e8c6 | `tests/core-messages.test.mjs`, at the longest ids the code accepts. |
| C1: a task started with no model named (`0d2254b09c482cc9`) | Skill: "Never task, even for a fix or edit", then points to `/council:task` or naming a model | ae912fa | Live: same prompt, `c1.jsonl`, session `4253112b-b268-44f4-b599-50d40a515a18`, $0.25. One `ask --to grok --tier consult`, job `abyvpa6rhbcfbjdi`, exit 0; no task. `calc.js` unchanged, and the host told the user how to get the edit. |
| C1b: that task had `session: null` | Fallback to `CLAUDE_CODE_SESSION_ID`; provider children never receive it | 09c49a6 | Fakes: `tests/core-session.test.mjs`. Live: job `hjcit7rpicgm4mpk` ran without `--session` with the variable set by hand, and recorded it. Bare `wait` listed the job with the variable and printed `no council jobs in this workspace/session` without it. Not re-run from a host's Bash call: the C1 session passed `--session` itself. |
| C3: request ids repeated across sessions | Skill and generated commands: a fresh id per call; on `already used with different input`, a new id and a rerun | 5626908 | Wording tests only (`tests/skill-size.test.mjs`, `tests/commands-e2e.test.mjs`). Whether hosts now pick better ids was not measured. |
| C4: README's `review` row did not describe `--base` | Row says it reviews from the merge base through the working tree, including untracked files | c948856 | Doc only; matches `collectReview` in `lib/core/git.mjs`. |

Live footers:

```text
council codex ok · job hjcit7rpicgm4mpk · gpt-6-luna/low · 9s · round 1/9 · edited 1 · next: reply hjcit7rpicgm4mpk
council grok ok · job abyvpa6rhbcfbjdi · grok-4.7/high · 19s · round 1/9 · next: reply abyvpa6rhbcfbjdi
```

The skill is 2,999 B (3,000 B at the matrix). The other rows of this matrix were not re-run after the fixes.

## Installed-route re-test after the fixes (2026-11-01, main cda39a2)

Route: `claude -p --plugin-dir`. Not the interactive app.

| Behaviour | Prompt | Result |
|---|---|---|
| A denial names itself | `/council:ask --to gemini --effort low` asked to write a file | exit 10, job `5eba85c6e9afa5ec`, `attention: denied write_file <path>`; no file created |
| No `--session` falls back to the host's session | `ask --to grok --effort low` with no `--session`, then bare `wait` | job `f0e3z7x71meck5jv` was recorded and listed |
| `edited` counts a task's changes | `/council:task --to codex --effort low` asked for a shell edit | `edited 1`, job `0c3cbd6e325018f8`. The direct-script check (job `hjcit7rpicgm4mpk`) is the one proven to use `sed -i` with no `file_change` event |
| No model named means no task | "Use council to get Grok to fix the inRange bug" (run before round 2; the skill text is unchanged since) | one consult `ask`, job `abyvpa6rhbcfbjdi`, no task, file unchanged |

**Not fixed: request ids stay patterned.** After the wording change the ids were still `k7Qm2xPd` and `k7Qm2xPz`. The model chooses them and tends to repeat a prefix. The harm is bounded: claims are scoped to session and workspace, and a same-session reuse with new text exits 2 and tells the host to pick a new id.
