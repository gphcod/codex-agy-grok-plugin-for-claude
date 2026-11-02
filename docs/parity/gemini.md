# Parity record: gemini-plugin-cc 2.1.0 → council (S5.7)

Source: `~/.claude/plugins/cache/gemini-plugin-cc/gemini/2.1.0` (github.com/gphcod/gemini-plugin-cc `gemini--v2.1.0`). The installed copy has no LICENSE, so council reimplements its behaviour and copies no code. The session-settings merge comes from gemini-plugin-for-codex (MIT), `skills/agy/scripts/lib/settings.mjs`.

Status values: **same**; **renamed** (the same capability under another name); **intentionally different** (a deliberate change, with its reason); **missing** (none at this gate).

## Commands and verbs

| gemini-plugin-cc | council | Status | Note |
|---|---|---|---|
| `/gemini:review [focus]` | `review --to gemini [focus]` | renamed | Collected-diff review using `prompts/review.md` with `--json-schema`; exit 10 when there are findings |
| `/gemini:adversarial-review [focus]` | `review --to gemini --adversarial [focus]` | renamed | `prompts/adversarial-review.md` |
| `/gemini:rescue <task>` | `task --to gemini` | renamed | A new conversation; the `exec` tier when no model is named |
| `rescue --resume` | `task --thread <job\|conversation>` | renamed | Resumes the recorded conversation with `--conversation`; the thread record pins the provider and workspace |
| `rescue --fresh` | `task --to gemini` without `--thread` | same | A fresh conversation is the default |
| `rescue --plan` (read-only run) | `ask --to gemini` | renamed | A read-only question on a new thread, with deny settings and `--sandbox` |
| companion `reply [--job <handle>]` | `reply --thread <job> \| --last` | renamed | Always read-only, also after a task (A3.2); in gemini-plugin-cc reply took task's flags and edit mode |
| `/gemini:result [job]` | `wait <job>` | renamed | Replays a finished job's stored result |
| `/gemini:status [job]` | `wait` (bare) / `wait <job> --timeout 1` | renamed | Lists this session's jobs in this workspace, or reports one job (exit 20 while it runs) |
| `status --all` | `wait` scoped to session + workspace; a named job id is found across sessions | intentionally different | A7.2 scoping: `--last`, bare `wait` and bare `cancel` never reach another session's jobs |
| `/gemini:cancel [job]` | `cancel [job]` | same | Owner-live and owner-gone paths; identities verified by creation time (A7.5) |
| `/gemini:setup` | `setup --to gemini` | same | Binary, launcher kind, `agy --version`, `agy models` as the login check, catalog age, resolved tiers, the web-search note, and a warning for any tier id that `agy models` does not list |
| `setup --verify` (live model turn) | `setup` runs probes only | intentionally different | A3.2: `setup` runs the documented probe commands and makes no model call; a live check is an `ask` |
| `setup --enable-review-gate` / `--disable-review-gate`, `--stop-gate`, `hooks/`, `stop-review-gate-hook.mjs`, `prompts/stop-review-gate.md` | none | intentionally different (dropped) | A1: no hooks in 1.0; the stop-review gate may return later as an opt-in |
| (none) | `models [--to gemini] [--refresh]` | intentionally different (new) | Static catalog plus the `agy models` listing; suffixed ids index their family |
| (none) | `review --commit <sha>`, `--uncommitted` | intentionally different (new) | Collection per A5.2 |

## Flags

| gemini-plugin-cc | council | Status | Note |
|---|---|---|---|
| `--model <m>` | `--model <id\|alias>` | same | Aliases `argon` and `flash`. A family gets `--model <family> --effort <clamped>`; a suffixed id passes alone |
| `--effort low…max` | `--effort low…max` | intentionally different | gemini-plugin-cc forwarded `xhigh`/`max`, and agy then failed with "invalid model selection" (S1.2, S5.6). Council clamps downward to `high` and shows it in the footer (`gemini-4-argon/high<=xhigh`). A suffixed id with a conflicting `--effort` exits 2 before any spawn |
| (agy default model) | `--tier consult\|exec\|deep` | intentionally different (new) | `tiers.json`; consult and deep coincide for Gemini (both high) |
| `--timeout <s>` (default 540) | `--deadline <s>` (default 14400), `--inactivity-timeout <s>` | renamed | `--print-timeout <deadline>s`; a `print_timeout` result exits 1 (gemini-plugin-cc also failed it); `wait --timeout` returns 20 and stops nothing |
| `--conversation <id>` | `reply --thread <id>` / `task --thread <id>` | renamed | A conversation id is accepted where a job id is |
| `--job <handle>` | `--thread <job>` | renamed | |
| `--request-id <id>` | `--request-id <id>` | same | The A7.4 tombstone and fingerprint; a replay starts no CLI |
| `--json` | `--json` | intentionally different | The object follows A3.4, shared by the three providers. Field mapping: `exitStatus` → `exit`, `ok` → `status` (`ok`/`attention`/`failed`/`cancelled`), `jobId`/`handle` → `job`, `conversationId` → `thread`, `rawOutput` → `answer` (24 KiB preview; `answerFile` for the whole text), `error` → `error`, `answerFile` → `answerFile`, `usage` → the job record (`meta.json`), not the JSON object; `deniedActions` → no field: a denial shows as `status: attention`, `exit: 10` and in the answer text; reviews: `review`/`target` → `verb`/the start line's target, findings normalized per A5.2 in `findings`, `coverage`, `verdict`. New: `model`, `effort`, `requestedEffort`, `tier`, `round`, `rounds`, `costUsd` (null for agy) |
| `--wait` / `--background` | Claude's `run_in_background` plus `wait` | intentionally different | gemini-plugin-cc accepted and ignored them; council's skill and commands choose the background mode (A3.1) |
| `--base <ref>` | `--base <ref>` | same | Collects `<oid>...HEAD` plus the working tree and untracked files |
| `--scope auto\|working-tree\|branch` | implicit default / `--uncommitted` / `--base <ref>` | renamed | `--uncommitted` never falls back to a default branch |
| `--prompt-file <f>` | text after `--` or in the heredoc | intentionally different | One call form for all providers (A3.1) |
| `--cwd <dir>` / `-C` | the companion's working directory | intentionally different | Records carry realpath(cwd); a thread is never adopted across workspaces (A7.3) |
| `--sandbox` / `--no-sandbox` | `--sandbox` on every turn | intentionally different | No opt-out: tasks also run sandboxed (A2, A5.1) |
| `--mode accept-edits` on every turn | only on `task` | intentionally different | A5.1: read-only turns run in the default mode with deny settings |
| (none) | `--web` | intentionally different | `--web --to gemini` exits 2: a `search_web(*)` deny rule does not block agy's `search_web` (S1.2), so there is no tested mapping; `setup` prints a note about it |
| (none) | `--rounds`, `--session` | intentionally different (new) | The 9-reply budget and the session scope (A3.3) |

## Settings and isolation

| gemini-plugin-cc | council | Status | Note |
|---|---|---|---|
| inline `--settings '{"permissions":{"deny":[write_file, edit_file, command, mcp]}}'` on read-only turns only | `--settings <job-dir>/settings.json` on every turn | intentionally different | A session list replaces the global one (S1.2), so gemini-plugin-cc dropped the user's global deny rules on read-only turns. Council merges the global `allow`/`ask`/`deny` lists (gemini-plugin-for-codex `sessionSettings`). Read-only turns keep only `read_file`/`read_url` allow rules and add the A2 union (`write_file`, `edit_file`, `command`, `unsandboxed`, `mcp`, `execute_url`). Tasks keep the global lists. `strict` tool permission is preserved. The path is job-specific, so it doubles as ownership evidence |
| no settings on tasks | merged global lists on tasks | intentionally different | The user's own deny rules also apply to delegated work |
| process group stop, `taskkill /T /F` on Windows | core group stop plus identity-checked escalation, post-exit scan on every exit (`trustsCleanExit` false) | intentionally different | A7.5; no language-server child was observed (S1.2), and the stop path is tested against a fake child in the group and a fake child reparented to pid 1 |
| (none) | four guard variables on the child, admission refused when any is set | intentionally different (new) | gemini-plugin-cc had no nesting guard (A5.1) |

## Results, exit codes, footer

| gemini-plugin-cc | council | Status | Note |
|---|---|---|---|
| exit 0 ok, 10 review findings, 20 action denied, 1 failure, 2 usage | 0 ok, 10 needs attention (findings, denied action, incomplete or malformed review), 20 still running, 1 failed/cancelled/busy, 2 invalid input | intentionally different | A denied action exits **10**, not 20; 20 now means still running |
| `denied_actions` non-empty → denied | the same, plus the S1.2 tool-step signature with the key absent or empty | intentionally different | agy 1.4.12 leaves `denied_actions` out after a denied tool step (S1.2), so the donor's check never fired. A denied turn whose response is empty answers with the denial line |
| duplicate or missing `result`, `status !== "SUCCESS"`, empty response → failure | the same → exit 1, where "empty" means no response and no deltas | same | Checked in that order, with denial before the empty-answer rule (decisions S5) |
| `print_timeout` → failure, with the partial response shown | `incomplete` → exit 1 on every verb, reviews included; the partial answer is kept and printed | same | A3.3; S5.8 keeps the partial answer (it was dropped before) |
| answer = `result.response`, else the partial deltas | the same, also on a print timeout; an answer that came only through deltas is not "empty" | same | Deltas capped at 32 MiB (`MAX_PARTIAL_BYTES`), frames at 32 MiB (`MAX_FRAME_BYTES`) |
| review: `structured_output`, else a brace scan of the response | the same | same | Reimplemented |
| review output unparsable or invalid → exit 1 | `incomplete` → exit 10 | intentionally different | A5.2: malformed output needs attention and is never an approval |
| review rendering (`render.mjs`) | core `renderReview`: verdict line, `F1 BLOCKER file:line` findings, next steps, unreviewed list | intentionally different | One rendering for the gemini and grok reviews; severities are critical/high → BLOCKER, medium → MAJOR, low → MINOR |
| oversized diff written to a file for `read_file` | omitted files named in the prompt and reported as `coverage.unreviewed` (exit 10) | intentionally different | Decisions S2, "ports not taken whole" |
| footer `gemini <status> · job <handle> · <duration> · full: <file>` | `council gemini <ok\|needs attention\|failed\|cancelled> · job <16> · <model>/<effort>[<=req] · <duration> · round N/M · …` | intentionally different | A3.4 footer grammar, shared by the three providers; the start line goes to stderr |
| 24 KiB answer cap with the full answer in a file | 24 KiB cap, `full: <file>` | same | |
| job state under the workspace (`lib/state.mjs`) | `~/.council` (`COUNCIL_HOME`) | intentionally different | A7.1 |

## Caveats carried over

| Caveat | Status | Note |
|---|---|---|
| agy prints `print timeout` and exits 0 with a partial response | same | Exit 1, incomplete |
| SIGTERM makes agy exit 1 with an `interrupted` result | same | Shown as `cancelled` when council cancelled the turn |
| Windows | intentionally different | gemini-plugin-cc had not run on Windows when this was written; council runs Gemini turn verbs on `win32`, checked in `docs/qualification/windows.md` |
| Web search cannot be denied | intentionally different (new, recorded) | S1.2; `setup` note |
