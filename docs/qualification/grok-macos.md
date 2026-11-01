# grok on macOS: live record (S4.6)

Date 2026-10-31. Darwin 27.0.0, Node 22.19.0, `grok 1.0.70 (f50904eaee6c) [stable]` at `/Users/cia/.grok/bin/grok` (launcher kind `native`). Branch `s4-grok`.

## Live contract tests

Command: `COUNCIL_LIVE_LOG=<file> node --test tests/live/grok.live.test.mjs` (throwaway repository and `COUNCIL_HOME` under the system temp directory, removed afterwards). Result: 6 pass, 0 fail.

| Test | Exit | Time | Footer or outcome |
|---|---|---|---|
| `grok --version`, `grok models` | 0 | <1 s | version line; listing shows the login line and `grok-4.7` |
| `ask --to grok --model grok-4.7 --effort low` | 0 | 12.0 s | `council grok ok · job 133h0wc29vh2oahk · grok-4.7/low · 12s · round 1/9 · next: reply 133h0wc29vh2oahk` |
| `reply --thread <ask job> --effort low` | 0 | 5.4 s | `council grok ok · job 9hcouue4ywuaxah8 · grok-4.7/low · 5s · round 2/9 · next: reply 9hcouue4ywuaxah8` |
| `review --to grok --uncommitted --effort low` (one-line `<=` bug) | 10 | 7.4 s | `council grok needs attention · job j23e12bc3alumj3l · grok-4.7/low · 7s` |
| `models --to grok --refresh` | 0 | 0.6 s | refreshed catalog; `grok-4.7: low, medium, high, xhigh`; tiers line |
| `setup --to grok` | 0 | 0.6 s | ready, native, version, logged in; `warning: 2 grok executables on PATH; the first one runs` (this Mac has `~/.grok/bin/grok` and `~/.local/bin/grok`) |
| `cancel <job>` on a long ask, 2 s after the spawn | 0 | 1.4 s | `cancelled · grok · job ahyhg02zw8cf6adc`; the ask exited 1 with `council grok cancelled · … · error: cancelled`; no grok process left afterwards |

## Step verification

`node plugins/council/scripts/council.mjs ask --to grok --effort low -- Reply with pong </dev/null` from a scratch repository with a scratch `COUNCIL_HOME`: exit 0, answer `pong` followed by the contract's closing lines, footer

```
council grok ok · job 0j52lxy97fhtkbom · grok-4.7/low · 3s · round 1/9 · next: reply 0j52lxy97fhtkbom
```

`costUsd` 0.008342, 7305 tokens (from the job record).

## Cost

The test runner does not print costs; the job records were removed with the temporary home. One trivial low-effort turn costs about $0.008 (verification turn above; S1.3 recorded $0.011), so the run's four model turns plus the cancelled one are estimated at under $0.06.

The live file ran **twice**: a first run started by mistake (`node scripts/run-tests.mjs --live --help` was meant to print the runner's usage; the runner has no `--help` and ran the live selection), its output piped into `head` and lost. It completed the same six tests (same prompts, low effort) and left no process behind. The table above is the second, recorded run. Estimated total for both runs plus the verification call: under $0.13.

## S7.1 live task (2026-11-01)

Run directly through `council.mjs`, not yet through the installed plugin (that is the S7.1 matrix proper). A scratch driver created a throwaway Git repository holding `calc.js`, whose `sum` started its loop at index 1, and a temporary `COUNCIL_HOME`. It ran three calls in order:

1. `task --to grok --effort low --request-id live-task-grok -- <fix the bug in calc.js, then run node -e "…sum([1,2]) === 3…" and report the exit code>`.
2. `reply --thread <task job> --effort low -- Now edit calc.js: append the comment line // reviewed …`. A reply is read-only, also after a task.
3. The task command again with the same request id, which must replay the stored result without a second CLI.

The task tier defaulted to `exec`; `--effort low` overrode its effort.

| Call | Exit | Time | Footer |
|---|---|---|---|
| task | 0 | 8.8 s | `council grok ok · job 1936af2a78bfe0c4 · grok-4.7-build-fast/low · 9s · round 1/9 · edited 1 · next: reply 1936af2a78bfe0c4` |
| read-only reply | 0 | 44.6 s | `council grok ok · job b5jpydgzcxx5gg6f · grok-4.7-build-fast/low · 45s · round 2/9 · next: reply b5jpydgzcxx5gg6f` |
| replay | 0 | 34 ms | the task's footer again, same job id |

The fix was correct (the check exits 0). The reply left `calc.js` unchanged and exited 0, which is correct. Grok's catalogue for the turn offered only `read_file`, `list_dir` and `grep`, the RESUME_DENY list after a task. The model kept trying to reach an editor through `grep` and ended with "Goal not met. No files changed." No writing tool was advertised or called, so the read-only guard had nothing to fail.
