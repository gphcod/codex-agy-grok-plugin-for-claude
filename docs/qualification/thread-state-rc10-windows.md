# rc.10 thread-state fixes: Windows qualification

Owner date: 2026-11-03 Pacific; raw records use UTC. [Raw benchmark](../measurements/benchmark-rc10-windows.json), [live checks](../measurements/live-rc10-windows.json), [rulings](../decisions.md).

Baseline rc.9: befea933fe18a55c0385db7a1cfcd32cdd8ce507 / plugin SHA-256 1497202da3eaf35b17f71eedbc1c9a7d6de20952e150243c628f1ec08b783d3b. Frozen rc.10 runtime: e18ce7ce74ee334dcb4ecc14c916f9a684bf0afe / 8a108374d8c504a1f8facacc12e343de23e9f65df49342ec67885b1cc3213a7e. Later documentation commits do not change these plugin bytes.

Windows 11 Enterprise, Node 22.19.0, Git 2.51.0, codex-cli 0.166.0, agy 1.4.12, grok 1.0.70.

## Regression

`npm test`: **554 total, 531 pass, 23 platform skips, zero failures**, from both Git Bash and PowerShell (rc.9: 537, 514, 23, 0). `gen:check` reports the 11 commands up to date, and `claude plugin validate` passes.

The 17 new tests are in `tests/core-rc10-fixes.test.mjs`. They cover the no-record fallback, the marker, concurrent cancels and an end-to-end case. That case runs the real entry and fake Grok: it kills the companion during `task --thread`, then `cancel`, then a reply whose logged argv must carry the RESUME_DENY recipe and no `--agent`.

To check that the tests detect the faults, eight variants were run in a scratch copy, each undoing one part of a fix. All eight were caught:

| Variant | Tests that failed |
|---|---|
| Recovery never marks | 7 |
| The reader ignores the marker | 8 |
| The marker lookup uses `existsSync` | 3 |
| No directory is created before the marker | 3 |
| The fallback uses the named job | 4 |
| An uncertain job does not refuse | 1 |
| The fallback drops the agent, `readOnly` and `web` | 1 |
| Recovery marks jobs that never attempted a spawn | 1 |

No existing test needed changing.

## Benchmark

Ten samples per arm/provider/workload, 100 retained jobs, the baseline's fakes, default models and inputs, alternating sequential arm order. All 240 calls meet the expected exit 0 or 10. No other tests or paid model calls ran alongside it. Normal desktop and OS activity was not controlled.

| Provider / workload | rc.9 median / p95 | rc.10 median / p95 | Framing B | Provider input B |
|---|---|---|---|---|
| codex / ask | 1.062 / 1.150 s | 1.065 / 1.101 s | 127 → 127 | 744 → 744 |
| codex / reply | 1.070 / 1.089 s | 1.065 / 1.129 s | 127 → 127 | 744 → 744 |
| codex / review | 1.123 / 1.164 s | 1.123 / 1.156 s | 180 → 180 | 0 → 0 |
| codex / discussion | 1.063 / 1.128 s | 1.064 / 1.116 s | 127 → 127 | 737 → 737 |
| gemini / ask | 1.077 / 1.093 s | 1.068 / 1.182 s | 133 → 133 | 746 → 746 |
| gemini / reply | 1.084 / 1.151 s | 1.080 / 1.120 s | 133 → 133 | 746 → 746 |
| gemini / review | 1.286 / 1.406 s | 1.283 / 1.312 s | 186 → 186 | 5128 → 5128 |
| gemini / discussion | 1.076 / 1.148 s | 1.073 / 1.232 s | 133 → 133 | 739 → 739 |
| grok / ask | 1.069 / 1.102 s | 1.062 / 1.125 s | 121 → 121 | 744 → 744 |
| grok / reply | 1.060 / 1.087 s | 1.065 / 1.103 s | 121 → 121 | 744 → 744 |
| grok / review | 1.296 / 1.337 s | 1.291 / 1.337 s | 174 → 174 | 4286 → 4286 |
| grok / discussion | 1.070 / 1.101 s | 1.063 / 1.085 s | 121 → 121 | 737 → 737 |

Framing and provider input are byte-identical in all twelve pairs. Medians move −0.85% to +0.53%, in both directions, which is no measurable change. No p95 stands out: all twenty-four lie between 1.085 and 1.406 s. Compare arms only within this run, since the same rc.9 bytes ran about 0.03 to 0.05 s faster here than in the rc.8/rc.9 run.

## Live checks

Real CLIs, on the frozen rc.10 runtime, at the owner's settings: Codex 6.1 Sol/xhigh, Grok 4.7/high, Gemini 4 Argon/medium.

| Check | Result |
|---|---|
| Codex: companion killed mid-turn after the thread was confirmed; no thread record existed | The reply before `cancel` exited 1: `thread … is busy; wait or cancel`, 0.2 s |
| `cancel` on that job | Exit 0, 0.8 s, `the thread stays resumable` |
| `reply --thread <job>` after that, through the no-record fallback | Exit 0, same thread, round 2/9, 4.5 s |
| Grok: healthy `ask`, then `reply --thread` | Exit 0 both, same thread, round 2/9, still `--agent explore`, no marker |
| `ask --to gemini` | `pong`, exit 0, 8.1 s, cleanup confirmed |

The fix diff's own reviews also ran on this code, on all three providers, with no cleanup pending.

Not run live for this release: a Grok `task` through a lost companion. It ran later the same day, and Grok accepted `--agent explore` on such a session; see [Later real Grok sessions](#later-real-grok-sessions). The fix does not depend on that. A real failed marker write and a real locked marker were not produced; those rely on mocked tests.

## Source

Runtime 4870 → 4916 lines in 24 files; largest module `lifecycle.mjs` 476, unchanged; entry 419 → 423; lines over 120 / 160 characters 391 / 127 → 397 / 127. Tests 12,033 → 12,308 lines in 70 files. Skill 2,996 B, description 122 B, contract, model defaults and the 11 commands are unchanged. `gemini-service.mjs` and `request-publication.mjs` are unchanged, so they stay byte-identical with the Codex-hosted release.

## Limits

This remains **1.0.0-rc.10**. Exact macOS and interactive qualification still gates final 1.0.0, so the macOS behaviour of these fixes rests on tests run only on Windows here. Linux stays optional. A job already recovered under rc.9 or earlier keeps its stale thread agent, because reconciliation happens at recovery; a later reply there still requests `--agent explore`. That stays a read-only turn, and real Grok accepted it in the later sessions.

## Later real Grok sessions

Run on 2026-11-03 Pacific, after the owner approved real default-agent sessions, at Grok 1.0.70 and grok-4.6/low to save tokens, in a throwaway repository with a scratch state root. Ten submitted turns on this plugin; the other combined plugin ran the same checks. [Raw record](../measurements/live-default-agent-windows.json). The plugin files equal the v1.0.0-rc.10 tag's.

| Check | Result |
|---|---|
| Task, then read-only replies by native id | The task wrote its file. Replies sent no `--agent`, kept the thread and created no file when asked to write |
| Companion killed after a real edit | A reply was refused as busy until `cancel`. The record stayed on `explore`, and `cancel` set the marker, which is the real case this fix covers. With the job removed by hand to stand in for pruning, a reply by native id kept the thread without `--agent`, offering only `read_file`, `list_dir` and `grep` |
| Record forced back to `explore` on a session that really ran the default agent | The reply sent `--agent explore`. Grok accepted it and exited 0, with the same three tools and no file created |
| `cancel` with a live companion during a long command | Grok, its PowerShell wrapper and the command all stopped |
| `cancel` after a lost companion during a long command | Grok and its wrapper were gone, **but the command kept running**. `cancel` still exited 0 with `cancelled`, `wait` reported `recovered after the companion stopped`, and no cleanup was pending |

The last two rows come from separate runs that waited until the command was running. In the killed-companion run above them, the kill came before that command started.

- **Grok accepts the switch.** The adapter's note that a session on the default agent cannot switch to explore does not hold for Grok 1.0.70 with grok-4.6. The reply this fix protects against would not have failed in this check, and both recipes gave the same read-only tools. The fix caused no problem in these runs and stays, because other CLI versions and models were not run. The note in `grok.mjs` is unchanged, since correcting it changes plugin bytes.
- **A lost task's command can outlive `cancel`.** This is a new limit and is not fixed. The evidence record is empty and the command has no living parent, so recovery has nothing that links it to the job; that cause is inferred. The test command only slept, so edits by a surviving command are also inferred.
- **Not run:** a kill inside the window itself, grok-4.7, and any platform but Windows. No read-only turn tried a write tool, so the advertised tools are the evidence, not a blocked attempt.
