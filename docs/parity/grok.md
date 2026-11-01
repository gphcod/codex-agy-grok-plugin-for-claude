# Parity: grok-build-plugin-cc 1.1.5 → council (grok)

Every command, flag, footer field and documented caveat of grok-build-plugin-cc 1.1.5 (`~/.claude/plugins/cache/gphcod-grok-build/grok-build/1.1.5`: `commands/*.md`, `scripts/grok.mjs`, `lib/*.mjs`, `skills/grok/SKILL.md`), marked **same**, **renamed**, **intentionally different** or **missing**. Nothing is missing. Status 2026-10-31, branch `s4-grok`; evidence in `tests/grok*.test.mjs` and `docs/qualification/grok-macos.md`.

## Commands

| grok-build | council | Status | Notes |
|---|---|---|---|
| `ask` (new read-only session, explore agent) | `ask --to grok` | same | Explore recipe, `--session-id <uuid>`; `/council:grok` equals `/council:ask --to grok`. |
| `reply <job\|session> \| --last` | `reply --thread <job\|thread> \| --last` | same | Read-only, `-r <session>`; explore, or RESUME_DENY once the session ran the default agent. A leading job id as first word still works (core `splitReply`). Provider is inherited and locked; a conflicting `--to` exits 2. |
| `review [--base <ref>] [focus]` | `review --to grok [--base <ref> \| --commit <sha> \| --uncommitted] [--adversarial] [focus]` | intentionally different | Same collected-diff route with an inline `--json-schema` and no `--rules`. Adds `--commit` and `--uncommitted` (A5.2) and `--adversarial`. The prompt is the shared `prompts/review.md` / `prompts/adversarial-review.md` instead of grok-build's `reviewPrompt`. Grok runs with `--cwd` at the repository root (grok 1.0.70 lists `--add-dir`, but its sessions refuse it (`additionalDirectories is not supported`, S1 spike)); grok-build used the caller's directory. |
| `rescue [--thread <id>]` | `task --to grok` / `task --thread <job\|thread>` | renamed | Write recipe (default agent, HOSTILE disallowed, `--deny Bash(git push*)`, `--deny Bash(rm -rf *)`), `exec` tier by default, as `rescue` had. |
| `wait [job] [--timeout s] [--json]` | `wait [job] [--timeout s] [--json]` | same | 90 s default, exit 20 while running; lists jobs of this session and workspace across providers (`--to grok` filters). |
| `cancel [job] [--timeout s] [--json]` | `cancel [job] [--timeout s] [--json]` | same | 30 s default; confirms cleanup; "the session stays resumable" reads "the thread stays resumable". |
| `setup [--json]` | `setup [--to grok] [--json]` | same | Binary, launcher kind, version, login, catalog, tiers; warnings for several `grok` on PATH, no login, a tier model missing from `grok models` (live: `warning: 2 grok executables on PATH`). Adds `note:` lines for the trade-offs below. grok-build's `grok version` fallback for 0.4.x is dropped (1.0.70 is the qualified CLI). |
| — | `models [--to grok] [--refresh]` | intentionally different | New verb; `grok models` parsed into the catalog with the CLI-wide effort set. |

## Flags

| grok-build | council | Status | Notes |
|---|---|---|---|
| `--session <id>` | `--session` | same | Claude session scope. |
| `--tier consult\|exec\|deep` | `--tier` | same | Same tiers (`tiers.json`), same models and efforts. |
| `--model <m>` | `--model <id\|alias>` | same | Adds aliases `4.7`, `4.6`, `4.5`, `build-fast`; unknown ids pass through with `model unverified`. |
| `--effort <e>` | `--effort low…max` | intentionally different | `max` is clamped to `xhigh` by the core (grok rejects `max`); footer `grok-4.7/xhigh<=max`. grok-build passed `max` through and failed. |
| `--thread`, `--last` | same | same | |
| `--base <ref>` | same | same | |
| `--web` | `--web` | same | Omits `--disable-web-search`; inherited by `reply` from the thread record. `review --web` exits 2 in both. |
| `--rounds n`, `GROK_BUILD_ROUNDS` | `--rounds n`, `COUNCIL_ROUNDS` | renamed | Default 9; a set budget is inherited. |
| `--request-id <id>` | `--request-id <id>` | same | Replay of the first result; changed input exits 2. grok-build's `NEW_ID` placeholder refusal is not ported (S2 decision). |
| `--timeout`, `--deadline`, `--inactivity-timeout` | same | same | 1200 s inactivity, 14400 s deadline; `--timeout` on `wait`/`cancel` only. |
| `--json` | `--json` | intentionally different | A3.4 object: `provider, job, thread, session, model, modelVerified, effort, requestedEffort, tier, round, rounds, verdict, findings, coverage, edited, failedCommands, costUsd, exit, answerFile, …`. grok-build's `session`/`requestedSession` become `thread`/`session` (Claude session); `editedCount` is `edited.length`; `stopReason` is gone because a stop other than `end_turn` now ends the turn as `incomplete: <reason>` in `error`. |
| `GROK_BINARY` | `COUNCIL_GROK_BIN` | renamed | Then PATH, then `%USERPROFILE%\.grok\bin\grok.exe` on Windows, as before. |
| `GROK_BUILD_DEPTH` guard | four guard variables | intentionally different | Every child gets `COUNCIL_DEPTH`, `CODEX_COMPANION_DEPTH`, `GROK_BUILD_DEPTH`, `CLAUDE_PLUGIN_CODEX_DEPTH`; any of them set refuses the call (A5.1). |

## Footer fields

| grok-build | council | Status | Notes |
|---|---|---|---|
| `-- grok <status>` | `council grok <status>` | renamed | A3.4 prefix. |
| `job <id>` | `job <16 chars>` | same | |
| `<model>@<effort>` | `<model>/<effort>[<=requested]` | intentionally different | Clamp token. |
| elapsed | elapsed | same | |
| cost | — (in `--json` `costUsd`) | intentionally different | PLAN S4.7: cost moves to `--json`. |
| `edited N` on every non-review verb | `edited N` on `task` only | intentionally different | Read-only turns cannot edit; `--json` keeps the list. |
| `files a, b (+n more)` on rescue | `--json` `edited` | intentionally different | |
| `unreviewed N` | `unreviewed N` | same | Review only; exit 10 whenever non-zero. |
| `round N/M` on reply | `round N/M` on ask, reply, task | intentionally different | A3.4: every threaded verb. |
| `full: <file>` | same | same | 24 KiB cap. |
| `error: <msg>` | same | same | |
| `cleanup pending; next: cancel <job>; do not resume` | same | same | |
| `next: reply <job>` | same | same | |
| `session not confirmed; start a new ask` | `session not confirmed: start a new ask` | same | An end event without a session id keeps the answer and exit 0 and prints the hint instead of `next: reply`; the thread is marked not resumable, so `reply`/`task --thread` on it exits 2 with the hint (review Q4, core `unconfirmed`). An end event naming another session fails (exit 1). A stream without an end event fails as before (`grok ended without finishing the turn`, or the error event / stderr line). |
| — | `thread locked: …` | intentionally different | codex-plugin-cc's 12 s held-pipe rule, now for every provider. |

## Isolation and reader behaviour

| grok-build | council | Status | Notes |
|---|---|---|---|
| Recipes (`recipes.mjs`: explore, RESUME_DENY, write; `--deny MCPTool(*)` read-only) | `providers/grok.mjs` `recipe()` | same | Ported whole; `tests/grok-turn.test.mjs`. |
| `compatEnv()` (skills, agents, hooks, MCP off; rules off read-only, dropped on writes) | `compatEnv(readOnly)` | same | Returned as additions; the write turn's `GROK_CLAUDE_RULES_ENABLED: undefined` removes an inherited value. |
| `--rules <contract on one line>` | same | same | Not on reviews. |
| `--no-auto-update`, `--always-approve`, `--no-subagents`, `--output-format streaming-json`, `--cwd` | same | same | |
| Reader FORBIDDEN catalogue check, MCP/forbidden call check, tool before validation, end before validation | `parseEvent` | same | Moved from the reader into the adapter (A5.1) through `state.turn` (core fix d09247d); fails closed before any text (`tests/grok.test.mjs`). |
| Edit paths from `rawInput`, diff content, locations, `EditsApplied` | `parseEvent` `edited` | same | |
| Text after a tool call separated by a blank line | same | same | |
| `max_turns_reached` → failure; `end_turn` only normal stop; `cancelled` stop text | `max_turns_reached` and any other stop: `incomplete: <reason>`; Grok's own `cancelled` stop: a denied action | intentionally different | The answer is kept and printed. `max_turns_reached` and stops other than `end_turn`/`cancelled` exit 1 with `error: incomplete: <reason>` (core `incomplete`), the session stays confirmed and resumable, structured output is kept. A `cancelled` stop (a tool needed a permission headless Grok cannot ask for) is a denial: exit 10, `needs attention`, the refusal sentence is the answer when Grok sent no text, the thread stays resumable (S4.9, as the Codex-host twin). grok-build failed all of these as errors. |
| Session id check on `end` | same plus core `onThread` | same | |
| Review validation `reviewProblem`, `renderReview` | core `reviewProblem`, `normalizeStructuredReview`, `renderReview` | intentionally different | Same validation; mapped into A5.2 (BLOCKER/MAJOR/MINOR, `changes`/`approve`/`incomplete`); malformed output is `incomplete`, exit 10, as grok-build failed it (exit 1 there). |
| 1 MiB JSONL line cap | `maxLineBytes` 1 MiB | same | |

## Documented caveats

| Caveat | council | Status |
|---|---|---|
| Post-exit scan after every exit (no qualified clean exit) | `trustsCleanExit` always false; `setup` note | same |
| `session not confirmed` | footer hint, thread not resumable | same |
| Lost or cleanup-pending job blocks its session until `cancel` confirms | core A7.8 | same |
| Grok starts Claude plugins' MCP servers despite `GROK_CLAUDE_MCPS_ENABLED=0`; read-only turns cannot call them | `--deny MCPTool(*)` plus the call guard | same |
| Grok loads a trusted repository's CLAUDE.md / AGENTS.md | unchanged behaviour of the CLI | same |
| Stdin idle deadline 10 s | core `STDIN_IDLE_S` | same |
| Windows: never through cmd.exe; `.cmd` shim runs its node entry | core launcher | same |
| `edited N` counts edit-tool changes only; shell edits are named in the answer | contract asks for files changed by shell | same |
| `unreviewed N` is not an approval | review exit 10 | same |
