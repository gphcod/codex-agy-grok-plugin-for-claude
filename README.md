# council

A Claude Code plugin through which Claude asks Codex (`codex`), Gemini (`agy`, the Antigravity CLI) and Grok (`grok`) questions, runs discussions with them, requests reviews and, when you authorize it, delegates edits. Each call names its provider and may choose the model, the thinking effort or a named tier.

council 1.0 replaces three plugins: codex-plugin-cc 2.3.2, gemini-plugin-cc 2.1.0 and grok-build-plugin-cc 1.1.5. Each call runs one companion process (`scripts/council.mjs`) and one provider CLI child. The model sees one skill (`skills/council/SKILL.md`, under 3,000 B). The eleven `/council:*` slash commands are user-only. The plugin has no runtime dependencies, no MCP server and no hooks.

## Install

Requirements: Node `>=22.19.0`. Install whichever of `codex`, `agy` and `grok` you want to use, put them on `PATH`, and log in to each once.

```text
/plugin marketplace add gphcod/codex-agy-grok-plugin-for-claude
/plugin install council@gphcod-council
/council:setup
```

To try a checkout without installing it, run `claude --plugin-dir "<absolute path>/plugins/council"` from any directory, then run `/council:setup`.

`setup` prints one block per provider: binary and launcher kind, version, login, catalog source and age, the three resolved tiers, and that provider's notes and warnings. It runs only the providers' probe commands (`--version`, the login check, the model listing) and makes no model call. It exits 1 when an installed provider is not ready.

## Calling council

Claude makes one Bash call per provider call. Options go on argv; the text goes after `--` in a quoted heredoc:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council.mjs" ask --to grok --session "${CLAUDE_SESSION_ID}" --tier consult -- <<'COUNCIL_EOF'
Is this lock ordering safe? …
COUNCIL_EOF
```

The slash commands use the second form. `$ARGUMENTS` goes inside the heredoc and argv carries no `--`. The companion parses the leading options out of the text and keeps everything after them byte for byte. A `--` in the text ends option parsing, so text that starts with a dash can follow it:

```text
/council:ask --to codex --effort low Why does this test flake?
/council:grok -- --verbose is part of the question
/council:review --to gemini --uncommitted --adversarial focus on the retry loop
```

The turn commands (`ask`, `reply`, `review`, `task` and the three provider shortcuts) also carry `--request-id @RID@`. Claude replaces `@RID@` with 8 random letters and digits, a fresh id for each new call, and keeps that id when it retries the same command, so a lost result replays instead of starting a second CLI. An id reused with different text exits 2 (`already used with different input`); Claude then picks a new id and reruns. A `--request-id` in your arguments takes precedence. If the placeholder is left unreplaced, the call exits 2.

Text can also come on stdin with no `--`. With no input, use `</dev/null`. Stdin that stays open for 10 s without a byte or its end is refused. Claude Code's Bash tool leaves stdin open when a command holds a heredoc.

### Verbs

| Verb | Does | Mode |
|---|---|---|
| `ask --to <p>` | New thread, one answer | read-only |
| `reply --thread <job\|thread>`, `--last`, or the job id as the first word | Delta on an existing thread. The provider comes from the record; a different `--to` exits 2. Model, effort and tier are inherited unless given | read-only, also after a task |
| `review --to <p> [--base <ref> \| --commit <sha> \| --uncommitted] [--adversarial] [focus]` | Structured review. With no target flag: uncommitted changes when the tree is dirty, otherwise the branch against the default branch. `--base <ref>` reviews from the merge base through the working tree, including untracked files | read-only |
| `task --to <p> [--thread <id>]` | Work that may edit the working tree. Runs only when you ask for it; the skill never starts one on its own | edit |
| `wait [job] [--timeout <s>]` | Lists this session's jobs in this workspace, or waits for one (90 s default) and prints its result again. Returns 20 while the job runs; stops nothing | — |
| `cancel [job] [--timeout <s>]` | Stops a job and confirms cleanup (30 s default) | — |
| `models [--to <p>] [--refresh]` | Static catalog plus the cached listing; `--refresh` reruns the providers' listings | — |
| `setup [--to <p>]` | See Install | — |

Slash commands: `/council:ask`, `/council:reply`, `/council:review`, `/council:task`, `/council:wait`, `/council:cancel`, `/council:models`, `/council:setup`, plus `/council:codex`, `/council:gemini` and `/council:grok`, which equal `/council:ask --to <p>`. All eleven are generated from `scripts/templates/command.md` (`npm run gen`; `npm run gen:check` fails on drift).

### Flags

- `--to codex|gemini|grok`: required on `ask`, `review` and a fresh `task`. council never infers the provider from the model name.
- `--model <id|alias>`: an exact CLI id, or an alias inside that provider's catalog. Codex: `sol`, `terra`, `luna`, `astra`. Gemini: `argon`, `flash`. Grok: `4.7`, `4.6`, `4.5`, `build-fast`. An unknown id is passed through unchanged, and the footer then says `model unverified`.
- `--effort low|medium|high|xhigh|max`: see the clamp rules below. `ultra` is accepted for Codex only.
- `--tier consult|exec|deep`: default `consult`; `task` defaults to `exec`. An explicit `--model` or `--effort` overrides the tier's value.
- `--thread`, `--last`: select the thread for `reply` and `task --thread`. `--last` is the latest threaded job of this session in this workspace.
- `--base`, `--commit`, `--uncommitted`, `--adversarial`: review only. `--adversarial` applies to Gemini and Grok, which review a collected diff with `prompts/adversarial-review.md`. Codex's native review has no adversarial mode, so `review --to codex --adversarial` exits 2; give focus text instead.
- `--web`: Grok only, off by default; `reply` inherits it. Codex has no tested mapping and Gemini cannot switch web search off (see Known trade-offs), so both exit 2. `review --web` exits 2 for every provider.
- `--rounds <n>`: the reply budget of a thread (default 9, or `COUNCIL_ROUNDS`). The thread keeps it. Refused on `review`.
- `--request-id <id>`: 1–128 characters, `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. Retrying an identical call with the same id replays or awaits the first result and never starts a second CLI. The same id with different input exits 2.
- `--deadline <s>` (default 14400) and `--inactivity-timeout <s>` (default 1200) stop a turn and clean up, exit 1. `wait --timeout` only stops waiting.
- `--json`: one JSON object instead of the text output: `provider, job, thread, session, model, modelVerified, effort, requestedEffort, tier, round, rounds, verdict, findings, coverage, edited, failedCommands, costUsd, exit, answerFile`, plus `verb, status, elapsedMs, error, attention, cleanupPending, answer, clipped`. `attention` is the footer's reason, or null.
- `--session <id>`: the Claude session that scopes `--last`, bare `wait` and bare `cancel`. When it is absent, empty or still the literal `${CLAUDE_SESSION_ID}`, council uses `CLAUDE_CODE_SESSION_ID` from the environment if that is UUID-like, and otherwise runs with no session. Provider children never receive that variable.

Any flag that a provider has no tested mapping for exits 2 before a job is recorded and before any process starts.

### Tiers

| Provider | consult | exec | deep |
|---|---|---|---|
| codex | gpt-6.1-sol / high | gpt-6-luna / max | gpt-6.1-sol / xhigh |
| grok | grok-4.7 / high | grok-4.7-build-fast / xhigh | grok-4.7 / xhigh |
| gemini | gemini-4-argon / high | gemini-3.8-flash / high | gemini-4-argon / high |

Gemini has no effort above high, so its consult and deep tiers are the same. Tiers live in `plugins/council/tiers.json`.

### Effort clamp rules

No CLI clamps an effort by itself, so council does it against each model's effort list in the catalog. It clamps downward only. A request gets the greatest offered effort at or below it, or the lowest offered effort when the request is below all of them. A clamp shows in the footer, for example `grok-4.7/xhigh<=max`, and as `effort`/`requestedEffort` in `--json`.

- Grok offers low through xhigh, so `max` becomes `xhigh`.
- Gemini offers low, medium and high, so `xhigh` and `max` become `high`. A suffixed id such as `gemini-4-argon-high` is passed through unchanged. Its suffix is the effort, and a different `--effort` with it exits 2. A bare family is passed as `--model <family> --effort <clamped>`.
- Codex accepts low through max; the sol, terra and astra families also accept `ultra`. `ultra` on a catalogued model whose list lacks it exits 2. The Codex CLI itself does not check the effort.
- An unknown model id is neither verified nor clamped.

The static catalog is `plugins/council/models.json`. `models --refresh` merges each provider's live listing on top of it and caches the result under the state root.

## Output and exit codes

A start line on stderr (left out under `--json`):

```text
[council] provider=grok job=0j52lxy97fhtkbom thread=6f1c2d3e-…
```

The answer, then a one-line footer on stdout:

```text
council grok ok · job 0j52lxy97fhtkbom · grok-4.7/low · 3s · round 1/9 · next: reply 0j52lxy97fhtkbom
```

Grammar: `council <provider> <ok|needs attention|failed|cancelled> · job <16 chars> · <model>/<effort>[<=requested] · <duration>[ · round N/M][ · edited N][ · unreviewed N][ · model unverified][ · full: <file>][ · error: <msg> | · attention: <reason>][ · <recovery hint>]`. `round` appears on `ask`, `reply` and `task`; `edited` on `task` only; `unreviewed` on `review` only. `attention:` says why a turn needs attention, in one line of at most 200 B: `denied <action>` (with ` (+N more)` for several), `open questions in the answer`, or why a review is incomplete or malformed. Plain review findings add no token; they are the answer. `edited N` is the union of the provider's edit events and the working-tree changes between the start and the end of the turn (a Git snapshot of HEAD and the dirty paths' contents). So an edit made through a shell counts, and so does anything else that changes the tree during the turn, such as you or another job. Outside a Git repository, on a Git failure or timeout, over 5,000 dirty paths, or past 10 s it is the provider's edit events alone. At most 4 MiB is hashed in total; a file past that is compared by size and mtime. A submodule counts as one path when its dirty state changes, so edits inside an already dirty one count only through the provider's events. The starting snapshot and the event count live in the companion's memory, so a job whose companion died prints `edited 0` whatever it changed. An answer over 24 KiB is clipped, and `full:` names the file that holds all of it.

| Exit | Meaning |
|---|---|
| 0 | done |
| 10 | needs attention: review findings, an incomplete or malformed review, open questions in the answer, a denied action |
| 20 | still running (`wait`) |
| 1 | failed, cancelled or busy |
| 2 | invalid input |

Reviews are reported as `Verdict: …`, then findings `F1 BLOCKER path:line: title`. Severity mapping: critical or high → BLOCKER, medium → MAJOR, low → MINOR; Codex `[P0]` → BLOCKER, `[P1]` → MAJOR, `[P2]`/`[P3]` → MINOR. Malformed output is never an approval. Files a review left out (over the size limit) are listed and counted as `unreviewed N`, with exit 10.

A denied action exits 10 on every provider. The signals are:

- Codex: a failed command whose output carries one of the sandbox-denial keywords that codex-rs uses.
- Gemini: agy's deny-rule tool-step signature, or a non-empty `denied_actions`.
- Grok: its own `cancelled` stop, meaning a tool needed a permission that headless Grok cannot ask for.

council's read-only guard for Grok is a separate check. When a writing tool is advertised or called on a read-only turn, the turn fails closed with exit 1.

## Discussion protocol and fan-out

The skill tells Claude to open with Goal, Known, Files, Constraints and Done when, and to number findings F1, F2 … with BLOCKER/MAJOR/MINOR and file:line evidence. Replies carry only `F1 AGREE`, `F2 CHANGE: …`, `F3 REJECT: …` and new facts. Claude stops when nothing changes or at the footer's `round N/N`. A REJECT that stays unresolved is reported as disagreement. `contract.md` gives every provider the same closing-field contract.

For a fan-out, Claude issues one background `ask` per provider in a single response. Each call carries the same brief, its own `--request-id` and the `consult` tier, unless you chose otherwise. Claude then compares the answers side by side. Follow-ups use `reply --thread <job>`, never `--last`. 1.0 has no coordinating `panel` process.

When you did not name a model, the skill uses `ask`, `reply` and `review` only, passes `--tier consult`, asks you once before a higher effort (except for Gemini, whose consult tier is already its highest) and never starts a `task`, even when you ask for a fix or an edit. A provider name is not a model: it does the `ask` or `review`, then tells you to run `/council:task` or name a model if you want the provider to edit. When you named one, it picks the tier by complexity. Reviews, tasks and deep, xhigh, max or ultra calls run in the background with a `--request-id`.

## State and recovery

State lives under `~/.council/` (override with `COUNCIL_HOME`): `jobs/`, `claims/`, `threads/`, `catalog/`, `trash/`. In practice:

- **Scope.** `--last`, bare `wait` and bare `cancel` see only jobs of the same Claude session in the same workspace (realpath of the working directory). A named job id is found across sessions.
- **Threads belong to one provider and one workspace.** Two providers that report the same native id never share claims or history, and a thread is never resumed from another workspace.
- **One turn per thread at a time.** A second call on a busy thread exits 1 (busy).
- **Lost results.** Rerun the identical call with the same `--request-id`. The retry prints or awaits the first result; if that job was pruned, it prints `result expired` and starts nothing.
- **Cleanup pending.** When council cannot confirm that a stopped or finished child is gone, the footer says `cleanup pending; next: cancel <job>; do not resume`, and the thread stays blocked until `cancel` confirms. `cancel` signals only processes it can identify by the job's own argv evidence and creation time. It never signals the companion or an unverified pid.
- **`thread locked`.** A process outside the job held the output pipes for more than 12 s after a clean exit. Start a new `ask`.
- **`session not confirmed: start a new ask`.** Grok finished without confirming its session. The answer and exit code stand, but the thread cannot be resumed.
- **Pruning.** Finished job bodies beyond the newest 100 are deleted. Running, lost, cleanup-pending and claim-holding jobs and all thread records are kept.
- **Nesting.** Every provider child gets `COUNCIL_DEPTH`, `CODEX_COMPANION_DEPTH`, `GROK_BUILD_DEPTH` and `CLAUDE_PLUGIN_CODEX_DEPTH`. council refuses to start when any of them is set, so no child can call back into council or into one of the replaced plugins.
- Never delete files under `claims/` by hand.

Environment variables: `COUNCIL_HOME`, `COUNCIL_CODEX_BIN`, `COUNCIL_AGY_BIN`, `COUNCIL_GROK_BIN` (binary overrides, which take precedence over `PATH`), `COUNCIL_CODEX_MCP=inherit|off`, `COUNCIL_ROUNDS`.

## Platforms

| | Codex | Grok | Gemini |
|---|---|---|---|
| macOS | live contract tests passed (S3.5); matrix in S7.1 | live contract tests passed (S4.6); matrix in S7.1 | live contract tests passed (S5.6); matrix in S7.1 |
| Windows | checked: the npm `codex.cmd` shim, run through its native executable | checked: native `grok.exe`; the npm shim is not yet checked | checked: native `agy.exe` (`docs/qualification/windows.md`) |
| Linux | optional, not qualified | optional, not qualified | optional, not qualified |

On Windows council never launches through `cmd.exe`. An npm `.cmd` shim runs its JS entry with node. Process queries run inline in PowerShell with `PSModulePath` set.

## Known trade-offs

- **Codex MCP servers (`COUNCIL_CODEX_MCP`).** The default, `inherit`, keeps your MCP servers, plugins and apps on `ask`, `reply` and `review`. `off` drops them there, which measured 19–29 % fewer input tokens on a fresh ask. Each such call then makes one or two extra `codex mcp list --json` calls (two when servers are configured), about 90–100 ms each on macOS. `setup` prints the trade-off and, under `off`, the measured time. Tasks always keep your tools.
- **A clean Codex review reports `incomplete` (exit 10).** `codex exec review` writes the same explanation-only text for a clean review as for output it could not parse. council therefore cannot prove a clean review and reports `codex reported no findings; its output cannot prove a clean review` with Codex's text. Read it; it is not an approval.
- **Codex needs a Git repository or a trusted directory.** Elsewhere, `codex exec` exits 1 with its own message. council does not add `--skip-git-repo-check`.
- **Gemini web search cannot be blocked.** agy's `search_web` tool ignores a `search_web(*)` deny rule, so read-only Gemini turns may search the web, and `--web --to gemini` exits 2 instead of pretending to switch it. `setup` says so.
- **A hard-killed companion on Windows** takes its provider child with it, unlike POSIX; `cancel` still recovers the job.
- **Gemini settings.** Every turn passes a job-specific `--settings` file. It starts from the `allow`/`ask`/`deny` lists in your `~/.gemini/antigravity-cli/settings.json`, because a session list replaces the global one. On read-only turns it keeps only `read_file`/`read_url` allow rules and adds a deny list: `write_file(*)`, `edit_file(*)`, `command(*)`, `unsandboxed(*)`, `mcp(*)`, `execute_url(*)`. On tasks it keeps your lists unchanged. `--sandbox` is always on, and `--mode accept-edits` is passed only on tasks.
- **Grok** runs read-only turns on the explore agent, or with the RESUME_DENY tool list once a task ran on the thread. It denies MCP tools, disables Claude skills, agents, hooks and MCP servers through its environment variables (and Claude rules on read-only turns), and turns web search off unless `--web`. Reviews run with `--cwd` at the repository root, because Grok sessions refuse `--add-dir`. Every Grok turn ends with a process scan for leftovers.

## Differences from the replaced plugins

The full lists are in `docs/parity/codex.md`, `docs/parity/gemini.md` and `docs/parity/grok.md`. Nothing is missing. The intentional differences:

- **All three.** One state root `~/.council` and one footer grammar, `council <p> <status> · job … · model/effort …`. The start line names the provider. Costs and counters move to `--json`. `round N/M` appears on every threaded verb, and `edited N` appears on `task` only. `reply` is always read-only, also after a task. Efforts are clamped against the catalog. Every child gets four guard variables. `rescue` is renamed `task`. `models` is a new verb.
- **codex-plugin-cc.** A clean review is `incomplete` (exit 10) instead of exit 0. `[P2]`/`[P3]` findings are MINOR. A sandbox denial exits 10 instead of counting as a failed command. `ultra` on a model whose catalog entry lacks it exits 2. `--adversarial` and `--web` exit 2 (use focus text).
- **grok-build-plugin-cc.**
  - `max` is clamped to `xhigh`.
  - Reviews add `--commit`, `--uncommitted` and `--adversarial` and use the shared review prompts.
  - Malformed review output is `incomplete` (10) instead of exit 1.
  - A stop other than `end_turn` keeps the answer and exits 1 as `incomplete: <reason>`. Grok's own `cancelled` stop is a denied action (10).
  - An end event without a session id keeps the answer and exit code but makes the thread non-resumable (`session not confirmed: start a new ask`).
  - Cost moves to `--json`.
- **gemini-plugin-cc.**
  - A denied action exits 10, not 20; 20 now means still running.
  - `--mode accept-edits` is passed only on tasks.
  - Settings merge your global lists instead of replacing them.
  - The stop-review gate and its hooks are dropped.
  - `result` and `status` become `wait`, and `rescue --plan` becomes `ask`.
  - `--timeout` becomes `--deadline`, which also sets agy's `--print-timeout`.
  - Malformed review output is `incomplete` (10).

## Per-CLI-release checklist

When `codex`, `agy` or `grok` ships a new version, recheck these before trusting it. The S1 records under `docs/spike/` hold the baseline, and the live tests run with `npm run test:live`.

1. **Flags**: every argv element the adapter builds still exists with the same meaning. Codex: `exec`, `exec resume`, `exec review`, `-o`, `-C`, `-s`, `-c sandbox_mode=`, `-c model_reasoning_effort=`, `-c developer_instructions=`. agy: `--input-format`/`--output-format stream-json`, `--settings`, `--sandbox`, `--mode`, `--conversation`, `--print-timeout`, `--json-schema`, `--disable-slash-commands`. grok: `--prompt-file`, `--output-format streaming-json`, `--session-id`, `-r`, `--agent`, `--deny`, `--disallowed-tools`, `--no-subagents`, `--always-approve`, `--disable-web-search`, `--rules`, `--json-schema`, `--no-auto-update`, `--cwd`.
2. **Event names and shapes**: Codex `thread.started`, `turn.completed`, `turn.failed`, `error`, `item.completed` (`file_change`, `command_execution`); agy `step_update`, `result` (`status`, `denied_actions`, `finished_reason`, `structured_output`) and the deny-rule tool-step signature; grok `available_commands`, `text`, `tool_call`/`tool_call_update`, `end` (`stopReason`, `sessionId`, `structuredOutput`), `max_turns_reached`.
3. **Effort rules**: which efforts each model accepts and the error text for the others (Grok `max`, Gemini `xhigh`/`max`, a Gemini suffix conflict, Codex `ultra`).
4. **Model listing format**: `codex debug models` (JSON, `supported_reasoning_levels`), `agy models` (effort-suffixed ids), `grok models`. Run `models --refresh` and compare with `models.json` and `tiers.json`.
5. **Process-table argv**: the job-specific operand stays visible in `ps`. Codex `-o <answer>`, agy `--settings <job-dir>/settings.json`, grok `--prompt-file <job-dir>/prompt.md`. Also check which children the CLI starts and how it reacts to SIGTERM.
6. **Review output**: Codex `[P<n>]` finding lines and its no-findings text; the agy and grok structured output against `schemas/review-output.schema.json`.

## Development

```bash
npm test            # fake CLIs only; no real codex, agy or grok is started
npm run test:live   # tests/live/*.live.test.mjs against the real CLIs (costs quota)
npm run gen         # regenerate the 11 commands; npm run gen:check fails on drift
npm run measure     # per-call framing bytes and the skill size, against the fakes
node scripts/run-tests.mjs --ratio   # core test-to-code ratio (≥ 1.5)
```

Design and procedure: `PLAN.md`. Every deviation is recorded in `docs/decisions.md`; parity, qualification and measurement records are under `docs/`.

## License

Apache-2.0. See `LICENSE` and `NOTICE`, which names the three source plugins.
