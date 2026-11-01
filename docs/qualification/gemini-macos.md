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

- `task` was not run live, because PLAN.md marks every `task` that edits a working tree as **[user]**. S7.1's matrix covers it.
- Windows is S7.2. Until S7.2 runs, `checkRequest` refuses every Gemini turn verb on `win32` with the A8 message.
