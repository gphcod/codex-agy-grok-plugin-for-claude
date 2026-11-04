# rc.11 lost-turn commands: Windows qualification

Owner date: 2026-11-03 Pacific; raw records use UTC. [Raw benchmark](../measurements/benchmark-rc11-windows.json), [live checks](../measurements/live-unrecorded-rc11-windows.json), [rulings](../decisions.md).

Baseline rc.10: dc4b763ad7581f75d3e8f3c7488fb6a1d482775a / plugin SHA-256 8a108374d8c504a1f8facacc12e343de23e9f65df49342ec67885b1cc3213a7e. Frozen rc.11 runtime: 383910c7644247c9b2514ce303ecfca45bef9ab7 / 9ce76dd394c7229be8f2adcca35aa342987d011abe5b3c0983a9f42d52e815d6. Later documentation commits do not change these plugin bytes.

Windows 11 Enterprise, Node 22.19.0, codex-cli 0.166.0, agy 1.4.12, grok 1.0.70.

Reviews ran on **Codex 6.1 Sol/high, Grok 4.7/high and Gemini 4 Argon/low**, the owner's settings for this session. Live tests ran on the cheap models, the owner's rule being that those are for testing and not for reviewing.

## What was wrong

The real Grok sessions recorded a command outliving `cancel` after a lost companion, and called that an unfixed limit on both plugins. On this plugin that was too broad. This plugin already records identities at every heartbeat on every platform, and that run killed the companion before the first one. A real run that waited 25 s past the command's start recorded it, and `cancel` stopped it.

What remained wrong:

- `cancel` reported `cancelled`, exit 0, cleanup not pending, with nothing to tell the caller that a command no heartbeat recorded could still be running.
- A recorded helper still exiting at the scan after a clean exit, such as `conhost.exe`, failed a good turn at once. This rests on the code; no live turn hit it.

## The fix

| Change | Where | Check |
|---|---|---|
| A recovering `cancel` warns that a command no heartbeat recorded may still be running, as text and as a `warning` JSON field. It has no time limit in it, is never in `job.error`, and does not print on a repeat `cancel` or when no spawn was attempted. | `control.mjs`, `output.mjs` | Orphan never signalled; repeat; text and JSON; never-spawned |
| A recorded process alive after a clean exit gets up to 5 s before it counts as a survivor, and each scan's rows are saved before the next look. One that stays is stopped and fails the turn. | `lifecycle.mjs` | Helper exiting by itself; survivor; wrapper exiting during the wait; failed query during the wait |
| The notes saying a session on Grok's default agent cannot switch to explore are corrected. Behaviour is unchanged. | `grok.mjs`, `control.mjs` | None needed |

## Reviews

- **Plan.** Codex showed that the warning's first wording, "started in the last seconds", understated the gap, because a shell can start a detached command and exit between two heartbeats; the warning now has no time limit. Codex and Gemini asked for the wait after a clean exit. Grok would have added it only if a live check failed; it was added, because the code path is plain and it costs nothing unless the first scan finds a process. Gemini and Grok narrowed where the warning prints. Gemini's option of not failing a turn after a successful stop was rejected; Codex and Grok kept the rule.
- **Diff.** Codex and Grok found independently that the new wait could lose a command known only through a wrapper that exits during it. Each scan's rows are now saved first. Gemini found nothing.
- **Fix.** All three found nothing in that fix on this plugin. Grok's further macOS finding applied only to the Codex-hosted plugin, whose ownership rule differs.

## Regression

`npm test`: **561 total, 538 pass, 23 platform skips, zero failures**, from both Git Bash (116.446 s) and PowerShell (116.371 s). `gen:check` reports the 11 commands up to date, and `claude plugin validate` passes.

The 7 new tests are in `tests/core-unrecorded-command.test.mjs`, including an end-to-end kill of a real companion and provider. Removing the save during the wait fails the wrapper and failed-query tests.

## Benchmark

Ten samples per arm/provider/workload, 100 retained jobs, the baseline's fakes, default models and inputs, alternating sequential arm order. All 240 calls meet the expected exit 0 or 10. No other tests or paid model calls ran alongside it. Normal desktop and OS activity was not controlled.

| Provider / workload | rc.10 median / p95 | rc.11 median / p95 | Framing B | Provider input B |
|---|---|---|---|---|
| codex / ask | 1.073 / 1.116 s | 1.070 / 1.089 s | 127 → 127 | 744 → 744 |
| codex / reply | 1.078 / 1.104 s | 1.078 / 1.092 s | 127 → 127 | 744 → 744 |
| codex / review | 1.131 / 1.163 s | 1.128 / 1.156 s | 180 → 180 | 0 → 0 |
| codex / discussion | 1.082 / 1.405 s | 1.072 / 1.092 s | 127 → 127 | 737 → 737 |
| gemini / ask | 1.086 / 1.298 s | 1.077 / 2.071 s | 133 → 133 | 746 → 746 |
| gemini / reply | 1.093 / 1.176 s | 1.078 / 1.115 s | 133 → 133 | 746 → 746 |
| gemini / review | 1.331 / 1.412 s | 1.328 / 1.660 s | 186 → 186 | 5128 → 5128 |
| gemini / discussion | 1.084 / 1.113 s | 1.082 / 1.174 s | 133 → 133 | 739 → 739 |
| grok / ask | 1.063 / 1.097 s | 1.073 / 1.145 s | 121 → 121 | 744 → 744 |
| grok / reply | 1.072 / 1.098 s | 1.067 / 1.104 s | 121 → 121 | 744 → 744 |
| grok / review | 1.325 / 1.381 s | 1.312 / 1.353 s | 174 → 174 | 4286 → 4286 |
| grok / discussion | 1.069 / 1.087 s | 1.073 / 1.098 s | 121 → 121 | 737 → 737 |

Framing, provider input, fsyncs, process queries, inventory reads and metadata reads are identical in all twelve pairs. Medians move −1.41% to +0.88%, in both directions, which is no measurable change. The median of all 120 calls per arm is 1,089 ms for rc.10 and 1,082 ms for rc.11. One p95 stands out, gemini / ask at 2.071 s against 1.298 s; its median moved −0.8%, and no code in this release runs on that path on a healthy turn. It was not rerun, so that is a reading and not a proof.

Runtime 4,927 lines / 24 files, largest module 484 lines, CLI 423 lines; compared with rc.10, runtime grows 11 lines and test source 174 lines. Skill, description, model defaults, contracts, permissions and commands are unchanged.

## Live checks

On the frozen commit, Grok 1.0.70, throwaway repository, scratch state root, five submitted turns.

| Check | Result |
|---|---|
| Grok task, companion killed 25 s after the command started | Grok and its wrapper had gone and the command was alive. `job.execution` held grok, conhost, pwsh, conhost and node. `cancel` exited 0 with the warning, and the command was gone when checked 2 s later |
| Grok task, companion killed right after the command started, before the first heartbeat | `job.execution` was empty. The command survived `cancel`, which exited 0 with the warning. The script then stopped it |
| Clean `task`, grok-4.6 low, 23 s with a 15 s command | `ok`, processes recorded, nothing left |
| Clean `task`, gpt-6-luna low, 27 s with a 15 s command | `ok`, processes recorded, nothing left. A clean Codex exit on Windows is trusted, so it runs no exit scan |
| Clean `task`, gemini-3.8-flash low, 36 s with a 15 s command | `ok`, processes recorded, nothing left |

## Not verified

- **The remaining gap is real.** A command started since the last heartbeat, or started and orphaned between two heartbeats, keeps running. The second live row shows it. `cancel` warns and cannot do more, because nothing it can read links that process to the job.
- The live commands only slept, so whether a surviving command could go on editing files is inferred.
- The cause, Grok and its wrapper ending by themselves, is observed in the process table. Why they end is inferred.
- No live turn hit the new wait, so how often a recorded helper is still exiting at the scan is unknown. It is covered by fake-provider tests only.
- Other providers through a lost companion were not run live; only Grok was. Their clean long turns were.
- grok-4.7, Linux and macOS were not run live. It remains a release candidate pending macOS and interactive qualification.
- A first pass of the clean turns ran both plugins at once with the same durations, so each could match and stop the other's command. It was discarded, and the turns above ran one at a time with unique durations.
