# Gemini (agy) on macOS: live record (S5.6)

Date: 2026-10-31. Host: macOS (Darwin 27.0.0), Node 22.19.0, agy 1.4.12 at `/Users/cia/.local/bin/agy` (launcher kind `native`), signed in. Branch `s5-gemini`.

Command: `COUNCIL_LIVE_LOG=<scratch>/agy-live.log node --test tests/live/agy.live.test.mjs`, run once. Each council turn ran at `--effort low` with a short prompt, in a throwaway `git init` repository and a temporary `COUNCIL_HOME`. The real `HOME` was kept so agy could find its sign-in; council only read the global `settings.json` there and never wrote it. Result: **7/7 passed** in 54.9 s. agy reports no cost figure, so none is recorded.

| Case | Command | Exit | Time | Footer or result |
|---|---|---|---|---|
| version, listing | `agy --version`, `agy models` | 0, 0 | — | `1.4.12`; gemini-4-argon-{low,medium,high}, gemini-3.8-flash-{low,medium,high} listed |
| ask | `ask --to gemini --effort low --session live -- Reply with the single word pong.` | 0 | 7.0 s | `council gemini ok · job 8q8roe5ezfyu0g0d · gemini-4-argon/low · 7s · round 1/9 · next: reply 8q8roe5ezfyu0g0d`; session `settings.json` carried the six A2 deny rules |
| reply | `reply --thread 8q8roe5ezfyu0g0d --effort low -- Reply with the single word again.` | 0 | 7.6 s | `council gemini ok · job ci0ri12gmys6zoto · gemini-4-argon/low · 8s · round 2/9 · next: reply ci0ri12gmys6zoto` |
| review | `review --to gemini --uncommitted --effort low` (a `<` changed to `<=` in a loop bound) | 10 | 13.9 s | `council gemini needs attention · job js5qbp2yx0abafe0 · gemini-4-argon/low · 14s`; the verdict was `changes requested` |
| refresh | `models --to gemini --refresh` | 0 | 1.7 s | `gemini (refreshed …)`, `gemini-4-argon: low, medium, high`; tiers consult gemini-4-argon/high · exec gemini-3.8-flash/high · deep gemini-4-argon/high |
| setup | `setup --to gemini` | 0 | 1.6 s | `gemini: ready · /Users/cia/.local/bin/agy (native) · 1.4.12 · logged in`; the web-search note; no tier warning (every resolved suffixed tier id is listed) |
| cancel | slow `ask`, then `cancel <job>` after 2 s | cancel 0, turn 1 | 2.7 s | `cancelled · gemini · job xvg06uzwxm07tusw`; `council gemini cancelled · job xvg06uzwxm07tusw · gemini-4-argon/low · 3s · round 1/9 · error: cancelled` |
| effort 1 | `agy --model gemini-3.8-flash-low --effort high` | 1 | 2.5 s | `ERROR invalid model selection (…): --model gemini-3.8-flash-low conflicts with --effort=high` |
| effort 2 | `agy --model gemini-3.8-flash-high --effort high` | 0 | 4.4 s | `SUCCESS pong` |
| effort 3 | `agy --model gemini-3.8-flash --effort high` | 0 | 6.0 s | `SUCCESS pong` |
| effort 4 | `agy --model gemini-3.8-flash --effort xhigh` / `max` | 1 / 1 | 2.5 s each | `… gemini-3.8-flash has no "xhigh" effort (available: low, medium, high)`, the same for `max` |

All of these agree with S1.2 and A2. The effort cases run directly against agy because council never forwards them: it refuses a suffix conflict with exit 2 and clamps `xhigh`/`max` to `high` itself. Both of those council behaviours are covered against the fake in `tests/gemini.test.mjs`.

## S5 verification

From a scratch `git init` directory with a temporary `COUNCIL_HOME`:

```
node plugins/council/scripts/council.mjs ask --to gemini --effort low -- Reply with pong </dev/null
```

Exit 0. Output was `pong`, then the contract's closing block, then the footer:

```
council gemini ok · job 7ndoguytwdjj1lsn · gemini-4-argon/low · 6s · round 1/9 · next: reply 7ndoguytwdjj1lsn
```

## Not covered here

- `task` was not run live here, because PLAN.md marks every `task` that edits a working tree as **[user]**. It ran on 2026-11-01, see below; S7.1's matrix still covers it through the installed plugin.
- Windows is S7.2, recorded in `docs/qualification/windows.md`.

## S7.1 live task (2026-11-01)

Run directly through `council.mjs`, not yet through the installed plugin (that is the S7.1 matrix proper). A scratch driver created a throwaway Git repository holding `calc.js`, whose `sum` started its loop at index 1, and a temporary `COUNCIL_HOME`. It ran three calls in order:

1. `task --to gemini --effort low --request-id live-task-gemini -- <fix the bug in calc.js, then run node -e "…sum([1,2]) === 3…" and report the exit code>`.
2. `reply --thread <task job> --effort low -- Now edit calc.js: append the comment line // reviewed …`. A reply is read-only, also after a task.
3. The task command again with the same request id, which must replay the stored result without a second CLI.

The task tier defaulted to `exec`; `--effort low` overrode its effort.

| Call | Exit | Time | Footer |
|---|---|---|---|
| task | 0 | 22.5 s | `council gemini ok · job 08fe2781b85d7f06 · gemini-3.8-flash/low · 22s · round 1/9 · edited 0 · next: reply 08fe2781b85d7f06` |
| read-only reply | 10 | 11.8 s | `council gemini needs attention · job c45cew4s95ycmuix · gemini-3.8-flash/low · 12s · round 2/9 · next: reply c45cew4s95ycmuix` |
| replay | 0 | 35 ms | the task's footer again, same job id |

The fix was correct (the check exits 0), but the footer said `edited 0`. **Defect found:** the Gemini adapter emitted no `edited` or `failedCommand` events at all. PLAN.md's Gemini event list (A5.1, S5.3) named neither, unlike Codex and Grok. agy reports the edit as an `edit_file` tool step with `Path`. The adapter now counts a completed write-tool step as an edit and a `run_command` that fails or exits non-zero as a failed command. A completed write on a read-only turn is reported as `incomplete`. The stream is kept as `tests/fixtures/streams/agy/task-edit.jsonl`; `tests/gemini.test.mjs` asserts `edited` = 1 on it. See the decision-log entry of 2026-11-01 "Gemini edits".

The reply exited 10 with the file unchanged. agy's `edit_file` step failed with `Permission denied for write_file(…). Matches user-configured deny rule.`, the S1.2 denial signature.
