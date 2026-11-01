# Codex on macOS: live record (S3.5)

Run once by hand on 2026-10-31 (local time; the refreshed catalog stamp reads 2026-11-01T05:25:59Z), branch `s3-codex` at the S3.4 commit (`e9c46ee`, `a19127f` after the rebase onto main `6d0ebb5`; code unchanged) plus the live file, macOS 27.0.1, Node 22.19.0, `codex-cli 0.163.0` at `/opt/homebrew/bin/codex` (launcher kind `native`), logged in with ChatGPT, MCP policy `inherit` (the user's servers and plugins loaded). Every model call ran at `--effort low` on `gpt-6.1-sol` in a throwaway Git repository under `$TMPDIR` with a temporary `COUNCIL_HOME`. Codex reports no cost; none is recorded.

## S3 verification command

```
COUNCIL_HOME=$(mktemp -d) node plugins/council/scripts/council.mjs ask --to codex --effort low -- Reply with pong </dev/null
```

```
[council] provider=codex job=rhfxrv22uir6pq7n thread=01a19591-8819-7742-9b9a-969560d691b6
pong
council codex ok · job rhfxrv22uir6pq7n · gpt-6.1-sol/low · 6s · round 1/9 · next: reply rhfxrv22uir6pq7n
```

Exit 0, 5.6 s wall clock.

## `tests/live/codex.live.test.mjs` (`node --test tests/live/codex.live.test.mjs`)

5 tests, 5 passed, 49.2 s.

| Case | Expected | Observed |
|---|---|---|
| `codex --version`, `codex debug models` shape | version line; `models[]` with `slug` and `supported_reasoning_levels` | `codex-cli 0.163.0`; 11 models, the same ids as `docs/spike/codex-models.json` |
| `ask --to codex --effort low` | exit 0, answer, footer `gpt-6.1-sol/low`, `round 1/9` | exit 0, `pong`, `council codex ok · job b3tsfb4kqo1ldbb5 · gpt-6.1-sol/low · 4s · round 1/9 · next: reply b3tsfb4kqo1ldbb5` |
| `reply --thread <job>` | exit 0, same thread, `round 2/9`, inherited model/effort | exit 0, `ping` plus the contract's closing fields (Outcome, Verification, Open questions: none, Next), same native thread `01a19591-a880-…`, footer `gpt-6.1-sol/low · 5s · round 2/9` |
| `review --uncommitted` unfocused (off-by-one change) | exit 10; `changes` with a `[P1]` finding, or `incomplete` | exit 10, `changes`, `F1 MAJOR <repo>/calc.js:3: Stop iteration before the array length` |
| `review --uncommitted` focused (`Focus on loop bounds only.`) | exit 10 as above, through the stdin route | exit 10, `changes`, `F1 MAJOR <repo>/calc.js:3: Stop the loop before items.length`, 20.6 s |
| `models --refresh --to codex` | exit 0, refreshed catalog | exit 0, 11 models, `ultra` on the sol/terra/astra families only, tiers unchanged |
| `setup --to codex` | ready, native launcher, version, login, MCP note | `codex: ready · /opt/homebrew/bin/codex (native) · codex-cli 0.163.0 · logged in`, catalog refreshed, tiers, `note: mcp: inherit (default): … 19-29% fewer input tokens …` |
| `cancel <job>` of a slow prompt 2 s after its start line | cancel exit 0; the turn ends `cancelled` (exit 1); no process keeps the job's `-o` operand | cancel exit 0 in 325 ms, `cancelled · codex · job jq34u7frs4j3tmtk · the thread stays resumable`; the turn printed `council codex cancelled · … · error: cancelled · next: reply jq34u7frs4j3tmtk` and exited 1; `ps` showed no process with the job's answer path |

## Notes

- Both review routes produced Codex's `[P1]` form, mapped to MAJOR with the absolute path Codex prints.
- The focused review took about 20 s, the unfocused one about the same; a `--effort low` ask takes 4 to 6 s.
- Not run here: `task` (it edits a working tree, a **[user]** action; run on 2026-11-01, see below), `COUNCIL_CODEX_MCP=off` against the real CLI (the S1.1 count of two discovery calls is asserted against the fake in S3.4), Windows (S7.2).

## S7.1 live task (2026-11-01)

Run directly through `council.mjs`, not yet through the installed plugin (that is the S7.1 matrix proper). A scratch driver created a throwaway Git repository holding `calc.js`, whose `sum` started its loop at index 1, and a temporary `COUNCIL_HOME`. It ran three calls in order:

1. `task --to codex --effort low --request-id live-task-codex -- <fix the bug in calc.js, then run node -e "…sum([1,2]) === 3…" and report the exit code>`.
2. `reply --thread <task job> --effort low -- Now edit calc.js: append the comment line // reviewed …`. A reply is read-only, also after a task.
3. The task command again with the same request id, which must replay the stored result without a second CLI.

The task tier defaulted to `exec`; `--effort low` overrode its effort.

| Call | Exit | Time | Footer |
|---|---|---|---|
| task | 0 | 9.0 s | `council codex ok · job a2d9affed70355eb · gpt-6-luna/low · 9s · round 1/9 · edited 1 · next: reply a2d9affed70355eb` |
| read-only reply | 0 | 8.8 s | `council codex ok · job 7j0pc5jf9abxzfqg · gpt-6-luna/low · 9s · round 2/9 · next: reply 7j0pc5jf9abxzfqg` |
| replay | 0 | 33 ms | the task's footer again, same job id |

The fix was correct (the check exits 0) and `calc.js` was the only changed file. The reply left `calc.js` unchanged and exited 0, which is correct. Codex ran only `cat calc.js` and then declined, citing its read-only sandbox. Its answer says "the edit was rejected", but the stream holds no rejected `file_change` or command, so council records no denial.
