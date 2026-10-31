# grok spike record (S1.3, 2026-10-31, macOS)

## Version and launcher

`grok --version` → `grok 1.0.70 (f50904eaee6c) [stable]`. Launcher on this Mac: `/Users/cia/.grok/bin/grok` (native binary on PATH; kind `native`). `grok models` doubles as the login check: its first line is `You are logged in with grok.com.`

## Headless invocation (exact argv)

Read-only turn with the explore recipe (GROK `lib/recipes.mjs:3-41`), exit 0, 2.8 s:

```
grok --prompt-file <tmp>/prompt-pong.txt --session-id 6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f --cwd <tmp>/work --output-format streaming-json --model grok-4.7 --effort low --no-auto-update --agent explore --always-approve --no-subagents --disable-web-search --disallowed-tools Agent,ask_user_question,enter_plan_mode,exit_plan_mode,image_gen,image_edit,image_to_video,reference_to_video --deny MCPTool(*)
```

Environment: `compatEnv()` variables `GROK_DISABLE_AUTOUPDATER=1`, `GROK_CLAUDE_SKILLS_ENABLED=0`, `GROK_CLAUDE_AGENTS_ENABLED=0`, `GROK_CLAUDE_HOOKS_ENABLED=0`, `GROK_CLAUDE_MCPS_ENABLED=0`, `GROK_CLAUDE_RULES_ENABLED=0`, `GROK_BUILD_DEPTH=1`. Review with the inline schema: the same plus `--json-schema '<minified review-output.schema.json>'` (exit 0, 5.9 s). `--no-auto-update` is absent from `grok --help` (`docs/spike/grok-help.txt`) and accepted, as the A5.1 note says.

## Stdin shape

None: the prompt is read from `--prompt-file`; stdin was closed empty on every probe.

## Event names seen (start, thread/session id, text delta, tool step, denied, result, error)

NDJSON on stdout, `type` discriminator: `available_commands` (`tools[]`, `commands[]`; emitted **three times** per turn: twice before the answer and once after), `thought` (`data`, reasoning deltas), `text` (`data`, answer deltas), `usage` (`usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, reasoning_tokens}`, `signature`), `end` (`stopReason: "end_turn"`, `sessionId` echoing the requested id, `requestId`, `cwd`, `usage` with `total_tokens`, `num_turns`, `total_cost_usd`, `total_cost_usd_ticks`, `modelUsage`, `structuredOutput?`), `error` (`message`, `cwd`). The advertised tool catalogue on the explore agent was exactly `["read_file","list_dir","grep"]`. No `tool_call` happened on these turns, so the `tool_call`/`tool_call_update` shapes come from GROK `lib/reader.mjs` only. Grok has no denial event; a forbidden tool advertised or called is the reader's fail-closed check. Streams: `tests/fixtures/streams/grok/*.jsonl`.

## Resume form

`-r 6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f` with a new prompt file and the same explore recipe: exit 0, 2.1 s, `end.sessionId` equals the resumed id, `end.num_turns: 1` (per call, not per session).

## Read-only controls and their evidence

`--agent explore` limits the advertised catalogue to `read_file`, `list_dir`, `grep` (no `write`, `search_replace`, `run_terminal_command`, `search_tool`, `use_tool`), with `--disallowed-tools <HOSTILE>` and `--deny MCPTool(*)`; `--disable-web-search` present; `--always-approve --no-subagents`. Evidence is the catalogue in every `available_commands` event of the four read-only probes. The write recipe and RESUME_DENY recipe were not probed live (no task was authorized); their argv comes from `lib/recipes.mjs:34-38`.

## Effort rules (accepted, rejected, error text)

`--effort xhigh` → exit 0 (`pong`, `reasoning_tokens: 30`). `--effort max` → exit 1 in 0.9 s, one stdout event `{"type":"error","message":"--effort/--reasoning-effort: unknown effort level 'max'; use one of: xhigh, high, medium, low","cwd":"<cwd>"}` and stderr `Error: --effort/--reasoning-effort: unknown effort level 'max'; use one of: xhigh, high, medium, low`. As A2 states. `low` accepted.

## Model listing (command, raw output file)

`grok models` → `docs/spike/grok-models.txt`: login line, `Default model: grok-4.6`, then `  - grok-4.7`, `  - grok-4.7-build-fast`, `  * grok-4.6 (default)`, `  - grok-4.5`. No per-model effort list exists; the effort vocabulary is CLI-wide (low, medium, high, xhigh). `grok --help` → `docs/spike/grok-help.txt`. `end.modelUsage` named the model `grok-4.7-build` for `--model grok-4.7`.

## Process table (argv as `ps` shows it, child processes, pgid)

`ps -axo pid,ppid,pgid,lstart,command` 3 s into the long-prompt turn shows `grok --prompt-file <path> --session-id … --cwd … --output-format streaming-json --model grok-4.7 --effort low --no-auto-update --agent explore …`; the `--prompt-file` operand is visible and job-specific. grok was its own group leader (spawned detached). No child process was observed (the minimal turn finished before the 3 s snapshot; the cancel probe's snapshot showed grok alone).

## Cancel behaviour (signal, exit code, time to exit, orphans)

Long prompt, `kill -TERM -- -<pgid>` 3.5 s after the first line (the stream had two `available_commands` and three `thought` events, no `end`): grok exited with **code 143** 607 ms after the signal, nothing on stderr, no orphans after 5 s. Without an `end` event the reader reports `session not confirmed`, as GROK `lib/reader.mjs` does.

## Timeouts

None built in; the companion owns `--deadline` and `--inactivity-timeout`. A trivial turn takes 2–3 s; the review with schema 6 s.

## Windows launcher kind (filled in S7 if not available now)

Not available on this Mac; S7.2 records it (`where.exe grok`: native `grok.exe` under `%USERPROFILE%\.grok\bin` versus the npm `.cmd` shim, per GROK `lib/launcher.mjs`).

## Surprises

1. `available_commands` is emitted three times per turn, including once after the answer text; the catalogue check must tolerate repeats.
2. `end.num_turns` is 1 on a resumed session (per call), unlike agy's running count.
3. `end.modelUsage` keys the model as `grok-4.7-build` although `--model grok-4.7` was passed.
4. SIGTERM to the group yields exit code 143 rather than a signal death, about 0.6 s later.
5. Every effort token outside `xhigh, high, medium, low` fails before any network call (0.9 s), so a wrong effort costs nothing.
