# codex spike record (S1.1, 2026-10-31, macOS)

## Version and launcher

`codex --version` → `codex-cli 0.163.0`. `codex login status` → `Logged in using ChatGPT`. Launcher on this Mac: `/opt/homebrew/bin/codex` (native binary on PATH; kind `native`).

## Headless invocation (exact argv)

Minimal turn (exit 0, 4.8 s):

```
codex exec --json -o <tmp>/answer.md -C <tmp> -s read-only -m gpt-6.1-sol -c model_reasoning_effort=low -
```

The answer (`pong`) landed in the `-o` file; the stream carried it too as an `item.completed` `agent_message`. Unfocused review (exit 0, 20 s): `codex exec review --uncommitted --json -o <tmp>/r1.md -c sandbox_mode=read-only -m gpt-6.1-sol -c review_model=gpt-6.1-sol -c model_reasoning_effort=low`. Focused review (exit 0, 12.7 s): the same without `--uncommitted`, with `-` and the target sentence plus focus on stdin. Target flags plus `-` together exit 2 in 10 ms without a model call: `error: the argument '--uncommitted' cannot be used with '[PROMPT]'` (stderr, followed by a usage line). `codex exec` in a directory that is neither a Git repository nor a trusted directory exits 1 with `Not inside a trusted directory and --skip-git-repo-check was not specified.`; all probes ran inside a `git init` directory.

## Stdin shape

Plain text, the whole prompt, closed after writing; only read when the trailing `-` operand is present. Without `-` (unfocused review) stdin is ignored. The focused review's stdin was `Review the uncommitted changes in this working tree (staged, unstaged and untracked); run \`git status\` and \`git diff HEAD\`.\n\nFocus on loop bounds only.` (codex-plugin-cc `lib/git.mjs:28` sentence).

## Event names seen (start, thread/session id, text delta, tool step, denied, result, error)

NDJSON on stdout, one object per line, `type` discriminator: `thread.started` (`thread_id`), `turn.started`, `item.started` and `item.completed` with `item.type` ∈ `command_execution` (`command`, `aggregated_output`, `exit_code`, `status`) and `agent_message` (`text`), `turn.completed` (`usage` with `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`). No text deltas: the message arrives whole in `item.completed`. No `turn.failed`, `error` or `file_change` event occurred in these read-only probes; CODEX `lib/reader.mjs:50-74` consumes them as recorded in A5.1. No denial event exists; a sandbox refusal would appear as a `command_execution` item with a non-zero `exit_code`. Review output form (`r1.md`, `r2.md`): a summary paragraph, `Review comment:`, then `- [P1] <title> — <absolute path>:<line>-<line>` followed by an indented body; `[P0]`/`[P1]` is what `lib/answer.mjs:16` scans. Streams: `tests/fixtures/streams/codex/*.jsonl`.

## Resume form

`codex exec resume <thread_id> --json -o <tmp>/answer2.md -c sandbox_mode=read-only -m gpt-6.1-sol -c model_reasoning_effort=low -` spawned with `cwd` set (no `-C`, no `-s`): exit 0, 4.9 s, `thread.started` repeats the same `thread_id`, answer in the `-o` file.

## Read-only controls and their evidence

`-s read-only` on `exec`; `-c sandbox_mode=read-only` on `exec resume` and `exec review`. The review's `command_execution` items show the sandbox at work indirectly: `git` inside it logged `couldn't create cache file '/tmp/xcrun_db-…' (errno=Operation not permitted)` while reading the tree succeeded. No write was attempted in these probes.

## Effort rules (accepted, rejected, error text)

`-c model_reasoning_effort=ultra` on `gpt-6.1-sol`: accepted, exit 0, `pong`. `-c model_reasoning_effort=ultra` on `gpt-6-luna`, whose listing lacks `ultra`: **also accepted**, exit 0, `turn.completed` with `reasoning_output_tokens: 9`; no error text exists. The CLI does not validate the effort against the catalog, so the A2 expectation ("per catalog") was wrong; A2 is corrected and `docs/decisions.md` records it. Council's catalog check (A3.3: exit 2 for `ultra` on a model whose list lacks it) is council policy, not CLI behaviour.

## Model listing (command, raw output file)

`codex debug models` → `docs/spike/codex-models.json` (686 KB: each of the 11 models carries its `base_instructions`). Fields used: `models[].slug`, `models[].supported_reasoning_levels[].effort`, `models[].default_reasoning_level`. Models and efforts: gpt-6.1-sol, gpt-6-astra, gpt-6.1-terra, gpt-6-sol, gpt-5.6-sol, gpt-5.6-terra: low…max plus ultra; gpt-6-chat-thinking, gpt-reserve, gpt-6-luna, gpt-5.6-luna, codex-auto-review: low…max.

## Process table (argv as `ps` shows it, child processes, pgid)

`ps -axo pid,ppid,pgid,lstart,command` during the turn shows the full argv: `codex exec --json -o <answer path> -C <cwd> -s read-only -m gpt-6.1-sol -c model_reasoning_effort=low -`; the `-o` operand is visible and job-specific. Spawned detached, codex is its own group leader (pid = pgid). Children seen during every turn: the MCP servers of the user's Codex plugins (`node … cua-repl.mjs`, `node_repl`, `node … codex-security/…/mcp/server.mjs --stdio`), each in **its own process group** (pgid = own pid), plus a `git clone https://github.com/gphcod/gemini-plugin-for-codex.git …/.codex/.tmp/marketplaces/.staging/marketplace-upgrade-…` in codex's group (a marketplace refresh codex runs in the background).

## Cancel behaviour (signal, exit code, time to exit, orphans)

Long prompt, `kill -TERM -- -<pgid>` 3 s after the first stream line: codex died on `SIGTERM` (no exit code) 6 ms after the signal; 5 s later no descendant remained, including the MCP server children in their own groups (codex stops them on the way out). No `-o` file was written.

## Timeouts

None built in on `exec`; the companion owns the deadline (A3.3 `--deadline`, `--inactivity-timeout`). `codex mcp list --json` returns in well under a second. With `--disable plugins --disable apps`, this machine still lists 4 enabled servers (`node_repl`, `openaiDeveloperDocs`, `tradier`, `tradier_sandbox`; `computer-use` disabled), so CODEX `lib/tools.mjs:30-41` makes **two** `codex mcp list --json` invocations per read-only turn here (one to list, one to confirm the `-c mcp_servers=…` override) and **one** on a machine without enabled servers; without the `--disable` flags the plain listing has 7 entries.

## Windows launcher kind (filled in S7 if not available now)

Not available on this Mac; S7.2 records it (`where.exe codex`, npm `.cmd` shim versus native `codex.exe`).

## Surprises

1. `ultra` is accepted on every model, including `gpt-6-luna` (A2 correction).
2. `codex exec` refuses a cwd that is neither a Git repository nor a trusted directory (exit 1) unless `--skip-git-repo-check` is passed; council's cwd is the user's repository, so S3 keeps the current behaviour and reports the message.
3. Every `codex exec` starts the user's plugin MCP servers as children in separate process groups and runs a marketplace `git clone` in the background; a group signal reaches the clone but relies on codex to stop the MCP children (it did).
4. `turn.completed` on the review stream reported all-zero `usage`.
5. `codex exec review` output is plain Markdown in the `-o` file with `[P1]` lines and an absolute path, not a schema object.
