# Changelog

## 1.0.1 (2026-11-03 Pacific)

The owner moved the version from `1.0.0-rc.11` to `1.0.1`. Only the version fields change, so the plugin behaves exactly as rc.11 did. No `1.0.0` was released. The exact-payload macOS and interactive checks in S7 of `PLAN.md` remain open, so this number does not mean they passed.

## 1.0.0 (not released; candidates up to 1.0.0-rc.11)

First release of `council`. A single plugin now provides the following, through one companion process and one provider CLI child per call:

- questions to Codex (`codex`), Gemini (`agy`) and Grok (`grok`)
- discussions with delta replies
- reviews
- authorized delegated edits

The release check is S7 of `PLAN.md`: a macOS matrix, a Windows session and the tag.

### 1.0.0-rc.11 (2026-11-03 Pacific)

Follows the real Grok sessions, which showed a lost turn's command outliving `cancel`. A later real run showed that on this plugin the gap is narrower than first recorded: a command a heartbeat has recorded is stopped. The earlier run killed the companion before its first heartbeat.

- `cancel` of a lost job now warns: `a command the lost turn started may still be running if no heartbeat recorded it; check the process table`. With `--json` this is a `warning` field. A command started and orphaned between two heartbeats stays unseen, so recovery proves only that nothing identified is left. A repeat `cancel`, or a job that never reached its spawn, prints no warning.
- A recorded process still alive after a clean exit gets up to 5 s to exit before it counts as a survivor. One that stays is still stopped and fails the turn. A helper such as `conhost.exe` that is merely still exiting no longer risks failing a good turn.
- Corrected the notes that said a session on Grok's default agent cannot switch to explore. Grok 1.0.70 at grok-4.6 accepted it; the deny recipe and the marker stay, because other versions were not run.

### 1.0.0-rc.10 (2026-11-03 Pacific)

Fixes two thread-state gaps found by checking what the Codex-hosted 1.1.3 added against rc.9. A healthy turn changes only by one extra `stat` per thread-record read: model defaults, framing, skill, contract and commands equal rc.9.

- A reply naming a job no longer resumes from a job whose provider never started. A thread with no record (a companion lost mid-turn writes none) now takes its settings from the newest job on it whose provider started, including the agent, `readOnly`, `web` and any `unconfirmed` refusal. It exits 2 with `<provider> thread <id> has no started history or record; start a new ask` when no job started, or when a newer job may have started: a crash inside the spawn window leaves that unknown. An existing thread record still wins, and by native id it refuses as before.
- A lost turn that ran Grok's default agent no longer leaves its thread asking for `explore`. Recovery by `cancel` now sets a one-way marker beside the thread record, `threads/<provider>-<id>.default-agent`, before the job stops blocking its thread. A later read-only reply then carries the recipe for a session on the default agent instead of `--agent explore`, which the adapter's notes say such a session cannot accept. A job that may have started counts too. If the marker cannot be written, `cancel` exits 1 and keeps the claim, and running it again retries. A marker that cannot be read stops the reply with `retry: thread <id> cannot be read right now`. Recovery never writes the thread record, so concurrent cancels cannot regress it. A job already recovered under rc.9 or earlier is not corrected.

### 1.0.0-rc.9 (2026-11-03 Pacific)

Fixes from a whole-code review by Codex, Gemini, Grok and Claude. Nothing changes for a healthy turn: model defaults, framing, skill, contract and commands are as in rc.8.

- `reply --last` no longer replies on an older thread while the latest thread-starting job is still open. Grok names its session only when a turn ends, so during a running Grok `ask` the job was skipped and the previous thread was resumed with no warning. It now exits 2 with `native thread not confirmed yet; wait or cancel <job>`. A lost job is refused the same way until `cancel` recovers it.
- A caller that closed stderr no longer kills the companion. The start line's write error was unhandled after the provider had started: the call exited 1, the job was never finalized and the provider kept running unsupervised. Stderr now gets the same handler as stdout, and the turn finishes.
- A thread record that stays locked for 2 s now stops the call with exit 1 and `retry: thread <id> cannot be read right now`. It used to read as missing, so a reply fell back to the job's fields and could resume a thread marked not resumable, with old settings and round. A `--thread` value that cannot be a native id reads nothing and reports `no job or thread`.
- Review coverage now names every file whatever the user's Git diff configuration says. `diff.noprefix` or `diff.mnemonicPrefix` turned every tracked file into `unknown file`, including files listed as not reviewed, and `diff.submodule=log` or `diff` dropped a changed submodule from the list. Gemini and Grok reviews collect with `--src-prefix=a/ --dst-prefix=b/ --submodule=short`.
- A resumed turn whose provider never started (a failed spawn, a throwing `beforeTurn`, a cancel before the spawn) leaves its thread record alone. It used to count a round, keep that call's one-shot model and effort, and after an unexecuted `task --thread` make Grok resume with the default agent. A turn that started and failed still counts a round.
- A Gemini 503 on a `reply` whose stream never named its thread is no longer eligible for the one automatic retry. Real agy names it in `init`, so this needs a failure before any event.
- A Codex finding whose indented body mentions `[P0]` to `[P9]` keeps its whole body and its `changes` verdict. It used to become `incomplete` with the body cut there. Exit 10 is unchanged, and a bullet that fails the finding form is still reported.
- A job whose claims cannot be read no longer fails the next turn from inside pruning.

### 1.0.0-rc.8 (2026-11-02 Pacific)

- Fix the recorded pre-provider Windows scope-file rename failure by publishing an immutable generation-specific binding. The reservation is never overwritten while a reader holds it open.
- Preserve legacy request replay and fail closed when an older client sees the new format. Damaged sidecars stay blocked; cleanup only removes its own generation. Keep the original preparation error if cleanup also fails.
- Test a real Windows lock beyond the old five-second retry window and a complete ask/replay with exactly one provider submission while the file remains held. The extra metadata files/source are an explicit maintenance cost; model defaults and healthy framing remain unchanged.

### 1.0.0-rc.7 (2026-11-02 Pacific)

- Compact startup retains provider, recovery job and review target; native ids stay in JSON/state/wait. Announce a durable spawned job before native init; an early reply must wait or cancel until confirmation.
- Omit redundant healthy `next: reply` hints; keep cleanup, unconfirmed, failed and attention hints. Shorten contract/skill prose, retaining per-turn protocol, authorization and Claude background notifications.
- Reuse the just-resolved thread for initial preparation, refreshing under the claim. Scope reservation-owner liveness queries to that pid, retaining unknown on error and full cleanup snapshots.
- Separate wait/cancel/replay and recovery from turn execution, retaining the public lifecycle API. Add native `usage` to JSON; existing `costUsd` mapping is unchanged.
- Final matched benchmark: 240 expected-success calls; ask framing −76 B, advice wrapper input −131 B. Description 150 → 122 B; lifecycle 647 → 473 lines while total source grows. Native inputs/timings are mixed and reported separately. See docs/qualification/efficiency-rc7-windows.md.
- Handle the recorded Gemini 503 in both hosts. Preserve failure usage and unfinished response drafts; permit one separate read-only retry only on explicit eligibility, after 2 seconds with a fresh request id. A task, partial/tool-active turn, unconfirmed thread or uncertain mutation/cleanup never gets an automatic retry. Same-id replay remains immutable.
- Remains a candidate pending final macOS and interactive qualification.

### 1.0.0-rc.6 (2026-11-02)

- The PowerShell form of the commands and the skill is now one statement, with no `; exit $LASTEXITCODE`. Under default permissions the `exit` made every call need approval despite `PowerShell(node:*)`. The tool reports the exit code without it.
- The temp file for that form is named `council-<session>-<random>`, and the command says to use its full path once it is written. A shared name made `Write` refuse a leftover file, and could have picked up another session's text.
- Windows checks: the S7.1 matrix per launcher kind, the npm `grok.cmd` shim and `allowed-tools` under default permissions pass (`docs/qualification/windows-matrix.md`).

### 1.0.0-rc.5 (2026-11-02)

- Default consultations use Codex 6.1 Sol/xhigh, Gemini 4 Argon/medium and Grok 4.7/high. Command guidance accounts for Codex's default background execution; explicit model, effort and tier overrides remain available.
- A leading short flag (`-v`, `-m gpt-5`) exits 2. It used to become the prompt and start a turn, with any model it named ignored. Put `--` first for text that starts with a dash; a bullet (`- item`) and a number (`-5`) stay text.
- A job record locked past 2 s stops `reply --last`, bare `wait`, bare `cancel` and a reply with exit 1 and a retry message. It used to count as no job, so an older job and its thread could be selected.
- A thread claim whose directory cannot be removed goes back to its job, so `cancel` can release it. It used to stay locked until someone repaired it by hand. The removal is also retried for 2 s, including the moment Windows still lists a just-deleted file.
- A failed claim release after a finished turn no longer changes its result. The call used to exit 1 with `finalization failed` while the saved job, and `wait`, said exit 0. Both now report the same result with `cleanup pending; next: cancel <job>`.
- A changed tracked binary file counts as not reviewed (`unreviewed N`, exit 10), as an untracked one already did. It used to count as reviewed, so an empty approval could exit 0.
- `review` runs at the repository root on every provider. Codex and Gemini used to run in the calling subdirectory, where agy could not read the rest of the repository; Codex's MCP discovery now runs at the root too.
- A focused Codex review now covers what its label says: `--base` through the working tree and untracked files, and a merge commit through its first-parent diff, which `git show` leaves out on a clean merge.
- On a review, `attention:` names a denied action before the incomplete reason it can cause.
- The skill's example is a call that may run in the foreground, and its rule says Codex's consult tier runs in the background.
- On Windows the test runner's cleanup stops only `node.exe` processes that name its temp root.

### macOS (checked 2026-11-01, `docs/qualification/macos-check.md`)

- A clean exit now waits up to 5 s for process-group members that are still exiting, so Codex's short-lived MCP servers no longer fail a finished turn with `cleanup pending` (6 of 12 Codex asks on a Mac with MCP servers configured). Nothing signals them; any that outlast the wait still leave cleanup pending.
- agy runs with `PWD` set to the real working directory. agy takes its workspace root from `PWD`, so a folder reached through a symlink (`/tmp` on macOS) had every read and edit denied in headless mode.

### PowerShell (1.0.0-rc.4)

- Commands and the skill have a PowerShell form for a session with no Bash tool. The text goes in a file read through the new `--input-file`, never in the command, because text in a PowerShell here-string can end it and run as a command.

### Windows (checked 2026-11-01, `docs/qualification/windows.md`)

- Gemini (agy) runs on Windows; the refusal stays behind `WINDOWS_QUALIFIED`.
- Requires Node 22.19.0 or later; Node 18 is no longer supported.
- `git rev-parse --show-toplevel` output is made native, so repository roots compare equal to other paths.
- PowerShell and taskkill run from their system paths, so a narrow or planted PATH cannot break cleanup.
- `cancel` no longer records a recovery on a job its owner finished during a slow process query.
- Guard variables are the union of every replaced plugin's, so a call inside a council child cannot start one of them.
- The test runner stops leftover fixture processes, retries removing its temp root and fails the run if it cannot.
- `.gitattributes` keeps every text file LF, so a Windows checkout sends the same contract and templates.
- A file name with a space no longer carries the tab Git ends its diff header with.

### Replaces

| Replaced | By |
|---|---|
| codex-plugin-cc 2.3.2 (`codex@gphcod-codex`): `/codex:ask`, `reply`, `review`, `rescue`, `wait`, `cancel`, `setup`, the `codex` skill | `/council:ask --to codex` (or `/council:codex`), `/council:reply`, `/council:review --to codex`, `/council:task --to codex`, `/council:wait`, `/council:cancel`, `/council:setup`, the `council` skill |
| grok-build-plugin-cc 1.1.5 (`grok-build@gphcod-grok-build`): `ask`, `reply`, `review`, `rescue`, `wait`, `cancel`, `setup`, the `grok` skill | the same verbs with `--to grok` (`/council:grok` for ask) |
| gemini-plugin-cc 2.1.0 (`gemini@gemini-plugin-cc`): `/gemini:review`, `adversarial-review`, `rescue` (`--resume`, `--fresh`, `--plan`), `result`, `status`, `cancel`, `setup`, the stop-review gate | `review --to gemini [--adversarial]`, `task --to gemini [--thread]`, `ask --to gemini` for `--plan`, `wait` for `result` and `status`, `cancel`, `setup`; the gate is dropped |
| `CODEX_COMPANION_*`, `GROK_BINARY`, `GROK_BUILD_ROUNDS` | `COUNCIL_HOME`, `COUNCIL_CODEX_BIN`, `COUNCIL_AGY_BIN`, `COUNCIL_GROK_BIN`, `COUNCIL_CODEX_MCP`, `COUNCIL_ROUNDS` |
| three state roots (`~/.claude/codex-companion`, grok-build's, gemini-plugin-cc's per-workspace state) | one root, `~/.council`; old job records are not migrated |

### Added

- `--to codex|gemini|grok` on every new thread, review and task. The provider is never inferred. A reply inherits the provider and locks it; a conflicting `--to` exits 2.
- `models [--to <p>] [--refresh]`: a static catalog (`models.json`) plus each CLI's cached listing.
- Per-call `--model` (exact id or alias), `--effort low…max` with a downward clamp against the catalog shown in the footer (`grok-4.7/xhigh<=max`), and `--tier consult|exec|deep` from `tiers.json`.
- Reviews of `--uncommitted`, `--base <ref>` or `--commit <sha>` on all three providers. `--adversarial` on Gemini and Grok.
- Fan-out: the skill issues up to three background `ask` calls in one response, each with its own `--request-id`.
- `--request-id` replay across providers. One binding per session, workspace and id means a retry never starts a second CLI, even when `--last` or the catalog would now resolve differently.
- Six guard variables (`COUNCIL_DEPTH`, `CODEX_COMPANION_DEPTH`, `GROK_BUILD_DEPTH`, `CLAUDE_PLUGIN_CODEX_DEPTH`, `GROK_CODEX_DEPTH`, `AGY_BRIDGE_DEPTH`) on every child, probes included. council refuses to start when any of them is set.
- Eleven generated user-only slash commands with a drift check. The turn commands carry a fresh `--request-id` that Claude substitutes. One model-visible skill of 3,000 B.

### Intentional differences

These come from `docs/parity/*.md` and `docs/decisions.md`.

**All providers**

- The footer grammar is shared: `council <p> <ok|needs attention|failed|cancelled> · job <16> · <model>/<effort>[<=req] · <duration> …`.
- The start line names the provider.
- Cost and counters move to `--json`.
- `round N/M` appears on every threaded verb.
- `edited N` appears on `task` only.
- `reply` is always read-only, also after a task.
- A thread is never resumed from another workspace.
- `rescue` is renamed `task`. The skill never starts one on its own.

**Codex**

- A review with no finding reports `incomplete` (exit 10), not exit 0. `codex exec review` writes the same text for a clean review as for output it could not parse, so a clean review cannot be proven; read Codex's text.
- `[P2]`/`[P3]` findings map to MINOR.
- A command refused by the sandbox is a denied action (exit 10), not only a failed command.
- `ultra` on a model whose catalog entry lacks it exits 2.
- `review --adversarial` and `--web` exit 2. Focus text gives the focused route.

**Grok**

- `max` is clamped to `xhigh`; grok-build passed it through and Grok rejected it.
- Grok's own `cancelled` stop (a tool needed a permission that headless Grok cannot ask for) is a denied action (exit 10). Any other stop except `end_turn`, and `max_turns_reached`, keep the answer and exit 1 as `incomplete: <reason>`.
- An end event without a session id keeps the answer and exit code. The footer says `session not confirmed: start a new ask`, and the thread cannot be resumed.
- Malformed review output is `incomplete` (exit 10) instead of a failure.
- Reviews run at the repository root and use the shared review prompts.
- A writing tool advertised or called on a read-only turn still fails closed (exit 1).

**Gemini**

- A denied action exits 10 (was 20); 20 now means still running.
- agy's deny-rule tool-step signature counts as a denial even when `denied_actions` is absent.
- `--mode accept-edits` is passed only on tasks.
- The session settings file merges your global `allow`/`ask`/`deny` lists instead of replacing them. Read-only turns add the six deny rules and keep `--sandbox`.
- `--web` exits 2, because agy's `search_web` cannot be denied. `setup` notes that read-only turns may still search.
- `print_timeout` exits 1 and keeps the partial answer.
- Malformed review output is `incomplete` (exit 10).
- The stop-review gate and hooks are dropped.

### Known limits

- The interactive app under default permissions is not checked yet, and macOS has not been re-run at this version.
- With the Microsoft Store build of `pwsh` on `PATH`, Claude Code 2.1.314 fails every PowerShell tool call under default permissions, with or without this plugin. Windows PowerShell 5.1 or the Bash tool avoids it.
- A model that ignores the command's wording can put the arguments in a PowerShell call. Default permissions refuse a compound call or a here-string; `bypassPermissions` would not. Sonnet did this in 6 of 14 sessions, Opus in 0 of 8.
- Linux is optional and not qualified.
- `COUNCIL_CODEX_MCP=off` saves 19–29 % input tokens per ask. It costs one or two `codex mcp list` calls before each ask, reply and review. The default stays `inherit`.
