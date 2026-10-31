# agy spike record (S1.2, 2026-10-31, macOS)

## Version and launcher

`agy --version` → `1.4.12`. Launcher on this Mac: `/Users/cia/.local/bin/agy` (native Go binary on PATH; kind `native`). `agy models` doubles as the login check (gemini-plugin-cc `getAgyAuthStatus`): it printed 13 tab-separated rows with `Fetching available models...` on stderr. agy honours `$HOME` for `~/.gemini/antigravity-cli/settings.json`; with a scratch `HOME` whose `.gemini` tree symlinks the real one except that settings file, authentication still worked (used for the settings-merge probe).

## Headless invocation (exact argv)

Minimal read-only turn (exit 0, 5.9 s):

```
agy --input-format stream-json --output-format stream-json --disable-slash-commands --print-timeout 120s --sandbox --settings <tmp>/settings.json --model gemini-4-argon --effort low
```

with `<tmp>/settings.json` = `{"permissions":{"deny":["write_file(*)","edit_file(*)","command(*)","unsandboxed(*)","mcp(*)","execute_url(*)"]}}` (the A2 list). Review with the shared schema: the same plus `--json-schema <repo>/plugins/council/schemas/review-output.schema.json` (exit 0, 8 s). All probes ran in a `git init` scratch directory outside the user's `trustedWorkspaces`; agy ran without a trust prompt.

## Stdin shape

Exactly one NDJSON line, as GEMINI `lib/agy.mjs:72` writes it: `{"event":"user","message":{"content":"<text>"}}\n`, then stdin closed.

## Event names seen (start, thread/session id, text delta, tool step, denied, result, error)

NDJSON on stdout, `event` discriminator: `init` (`conversation_id`, `init.{model, cwd, tools[], permission_mode}`; `tools` lists 60 names such as `view_file`, `write_to_file`, `run_command`, `search_web`, `call_mcp_tool`); `step_update` with `step_update.{conversation_id, step_index, state ∈ ACTIVE|DONE|ERROR, step_type ∈ user_input|agent_response|tool|system_message|finish, text_delta?, duration_seconds?, usage?, tool_name?, tool_info?}`; `result` with `result.{conversation_id, status ∈ SUCCESS|ERROR, response, duration_seconds, num_turns, usage, error?, finished_reason?, structured_output?, json_schema?}`. Text deltas: `step_type: "agent_response"`, `state: "ACTIVE"`, `text_delta`. Tool step: `step_type: "tool"`, `tool_name`, `tool_info.{name, parameters}`. **Denial signature** (read-only turn asked to create a file; no file appeared): the tool step ends with `state: "ERROR"` and `tool_info.error: {"type":"TOOL_ERROR","message":"permission check failed for write_file \"<path>\": Permission denied for write_file(<path>). Matches user-configured deny rule."}`; the terminal `result` is `status: "SUCCESS"` and has **no `denied_actions` key at all** (not an empty array). Error: a model-selection error is a single `result` line with `status: "ERROR"`, `error`, `finished_reason: "error"`, exit 1, the same text on stderr prefixed `error: `. Streams: `tests/fixtures/streams/agy/*.jsonl`.

## Resume form

`--conversation 0aefb9db-c350-4a61-bc6e-b242fc5946bb` with a new user message: exit 0, 18 s, `init` and `result` carry the same `conversation_id`, `num_turns: 2`, a `system_message` step precedes the answer, `result.duration_seconds: 159` (spans the conversation, not the turn).

## Read-only controls and their evidence

`--settings <file>` deny rules plus `--sandbox`. Evidence: the `write_file` step failed with the TOOL_ERROR above and no file was created; `read_file` succeeded unless `read_file(*)` was denied (settings-merge probe). The permission namespace (`write_file`, `read_file`, `command`, `mcp`) differs from the `init.tools` names (`write_to_file`, `view_file`, `run_command`, `call_mcp_tool`). Web search: the tool is `search_web`; a deny rule `search_web(*)` did **not** block it (second run: step `DONE`, model answered `search_web: succeeded`), so read-only turns cannot deny web search and Gemini `--web` exits 2 (A3.3 decision, `docs/decisions.md`). Settings merging (A5.1): with a scratch-HOME global `permissions.deny: ["read_file(*)"]` and no `--settings`, the read was denied; with a session file `{"permissions":{"deny":["write_file(*)"]}}` the read **succeeded** (the session array replaces the global one); with `["write_file(*)","read_file(*)"]` the read was denied again (the merged file restores it). The global `allow` list (`command(which)`, `command(git status)`, …) must therefore be merged into the session file too. `--mode` was omitted on every read-only probe; gemini-plugin-cc passed `--mode accept-edits` on every turn.

## Effort rules (accepted, rejected, error text)

`--model gemini-3.8-flash-low --effort high` → exit 1, `invalid model selection (--model "gemini-3.8-flash-low" --effort "high"): --model gemini-3.8-flash-low conflicts with --effort=high`. `--model gemini-3.8-flash-high --effort high` → exit 0. `--model gemini-3.8-flash --effort high` → exit 0. `--model gemini-3.8-flash --effort xhigh` → exit 1, `invalid model selection (--model "gemini-3.8-flash" --effort "xhigh"): gemini-3.8-flash has no "xhigh" effort (available: low, medium, high)`; `--effort max` → the same text with `max`. All as A2 states; `--help` lists `--effort (low|medium|high|xhigh|max)`, so the token is accepted by the parser and rejected by model selection.

## Model listing (command, raw output file)

`agy models` → `docs/spike/agy-models.txt`: `id<TAB>display name` rows; `gemini-4-argon-{medium,high,low}`, `gemini-3.8-flash-{high,medium,low}`, plus `claude-opus-5-5-*`, `claude-sonnet-5-5-*`, `gpt-oss-120b-medium`, which council does not route to.

## Process table (argv as `ps` shows it, child processes, pgid)

`ps -axo pid,ppid,pgid,lstart,command` 3 s into the turn shows `agy --input-format stream-json … --settings <path> --model gemini-4-argon --effort low`; the `--settings` operand is visible and job-specific. agy was its own group leader (spawned detached). **No child process was observed** in any probe (minimal, denial, web, review, long prompt): no language server appeared in the snapshots, so the "language-server child" of A5.1 is a possibility to defend against, not an observed fact.

## Cancel behaviour (signal, exit code, time to exit, orphans)

Long prompt, `kill -TERM -- -<pgid>` 3.5 s after the first line: agy emitted a final `result` with `status: "ERROR"`, `error: "interrupted"`, `finished_reason: "interrupted"`, wrote `error: interrupted` to stderr and **exited with code 1** (not on the signal) 197 ms after the signal; no orphans after 5 s. `kill -TERM <pid>` alone: identical (exit 1, 161 ms, no orphans, nothing reparented to pid 1 because there was no child).

## Timeouts

`--print-timeout 5s` on a long prompt: exit 0 after 7.5 s, `result.status: "SUCCESS"`, `finished_reason: "print_timeout"`, partial `response`, zero `usage`, stderr `[agy] print timeout after 5s with turn in progress; returning partial output`. A5.1 maps this to `incomplete` → exit 1.

## Windows launcher kind (filled in S7 if not available now)

Not available on this Mac; S7.2 records it or marks Gemini unsupported on Windows (A8).

## Surprises

1. `search_web(*)` in the deny list does not block the `search_web` tool; Gemini `--web` therefore exits 2 in 1.0.
2. `denied_actions` is absent, not empty, on a SUCCESS result after a denied tool step; the adapter's denial signal is the tool step with `tool_info.error.type: "TOOL_ERROR"` and `Permission denied for … Matches user-configured deny rule.`
3. SIGTERM yields exit code 1 with an `interrupted` result, not a signal death.
4. No language-server or other child process appeared in any snapshot.
5. agy ran in an untrusted scratch directory without complaint; `trustedWorkspaces` in the global settings did not gate print mode.
6. `result.duration_seconds` on a resumed conversation spans the whole conversation.
7. The `init` event's `tools` names and the permission-rule names are two different vocabularies.
