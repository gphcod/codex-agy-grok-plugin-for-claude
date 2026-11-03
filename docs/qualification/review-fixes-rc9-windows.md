# rc.9 review fixes: Windows qualification

Owner date: 2026-11-03 Pacific; raw records use UTC. [Raw benchmark](../measurements/benchmark-rc9-windows.json), [live checks](../measurements/live-rc9-windows.json), [rulings](../decisions.md).

Baseline rc.8: 7cd34cec3d71f1ad021950e981945c7beedc9ca7 / plugin SHA-256 ca8610fc6792de94e27060f532e97745616cd1623a72247ea7cfa36b100525d4. Frozen rc.9 runtime: 6d407a6a5001403430aeb999ccd388135f229622 / 1497202da3eaf35b17f71eedbc1c9a7d6de20952e150243c628f1ec08b783d3b. Later documentation commits do not change these plugin bytes.

Windows 11 Enterprise, Node 22.19.0, Git 2.51.0, codex-cli 0.166.0, agy 1.4.12, grok 1.0.70.

## Regression

`npm test`: **537 total, 514 pass, 23 platform skips, zero failures** (rc.8: 525, 502, 23, 0). `gen:check` reports the 11 commands up to date, and `claude plugin validate` passes.

| Fix | Regression test |
|---|---|
| `reply --last` and open jobs | `tests/core-rc9-fixes.test.mjs` (running, lost and unadmitted refused; finished ones and reviews still skipped) |
| Closed stderr | `tests/core-rc9-fixes.test.mjs` (the real entry, a closed pipe and fake Grok: exit 0 and `done`). Before the fix: exit 1, no `done`, no footer |
| Locked thread record, id check | `tests/core-rc9-fixes.test.mjs` (`resumable:false` survives a persistent EBUSY; `../` reads nothing), `tests/core-messages.test.mjs` |
| Canonical diff headers | `tests/core-rc9-fixes.test.mjs` (`diff.noprefix`, `diff.mnemonicPrefix` through uncommitted, commit and base; `diff.submodule=log` with a real submodule) |
| Thread record and unstarted turns | `tests/core-turn-failures.test.mjs` (failed spawn, throwing `beforeTurn`, cancel before spawn; a started failure still counts) |
| Resumed 503 with no thread named | `tests/gemini-service.test.mjs` (the real entry and fake agy: `retry.eligible=false`); the existing named-thread replies stay eligible |
| `[Pn]` in a Codex finding body | `tests/codex.test.mjs` |
| Pruning | `tests/core-rc9-fixes.test.mjs` |

## Benchmark

Ten samples per arm/provider/workload, 100 retained jobs, the baseline's fakes, default models and inputs, alternating sequential arm order. All 240 calls meet the expected exit 0 or 10. No other tests or paid model calls ran alongside it. Normal desktop and OS activity was not controlled.

| Provider / workload | rc.8 median / p95 | rc.9 median / p95 | Framing B | Provider input B |
|---|---|---|---|---|
| codex / ask | 1.099 / 1.220 s | 1.098 / 1.299 s | 127 → 127 | 744 → 744 |
| codex / reply | 1.103 / 1.160 s | 1.100 / 1.460 s | 127 → 127 | 744 → 744 |
| codex / review | 1.163 / 1.213 s | 1.153 / 3.139 s | 180 → 180 | 0 → 0 |
| codex / discussion | 1.096 / 1.154 s | 1.114 / 1.168 s | 127 → 127 | 737 → 737 |
| gemini / ask | 1.108 / 1.411 s | 1.120 / 1.152 s | 133 → 133 | 746 → 746 |
| gemini / reply | 1.131 / 1.173 s | 1.112 / 1.164 s | 133 → 133 | 746 → 746 |
| gemini / review | 1.338 / 1.445 s | 1.321 / 1.465 s | 186 → 186 | 5128 → 5128 |
| gemini / discussion | 1.114 / 1.158 s | 1.111 / 1.214 s | 133 → 133 | 739 → 739 |
| grok / ask | 1.096 / 1.189 s | 1.111 / 1.160 s | 121 → 121 | 744 → 744 |
| grok / reply | 1.113 / 1.133 s | 1.114 / 1.134 s | 121 → 121 | 744 → 744 |
| grok / review | 1.332 / 1.391 s | 1.320 / 1.369 s | 174 → 174 | 4286 → 4286 |
| grok / discussion | 1.127 / 1.151 s | 1.096 / 1.160 s | 121 → 121 | 737 → 737 |

Framing and provider input are byte-identical in all twelve pairs. Medians move −2.8% to +1.6%, in both directions, which is no measurable change. At ten samples p95 is the slowest call, so two rc.9 Codex tails are single calls: review 3.139 s against nine at 1.112 to 1.213 s, and reply 1.460 s. Both come from one round, sample 4 of the Codex rc.9 arm. Its discussion call (1.168 s) was also that workload's slowest, and its reply's process query took 1.10 s against about 0.77 s for rc.8 in the same round. One transient slowdown on a machine whose desktop activity was not controlled fits, but it is not proven: the cause was not investigated. Compare arms only within this run: this run's rc.8 medians are about 0.1 s slower than the rc.8 run in `efficiency-rc8-windows.md`, on the same bytes.

## Live checks

Real CLIs, on the frozen rc.9 runtime, at the owner's settings: Codex 6.1 Sol/xhigh, Gemini 4 Argon/high, Grok 4.7/low.

| Check | Result |
|---|---|
| `reply --last` 1.5 s into a running Grok `ask`, with an older finished Grok thread present | Exit 2 in 0.14 s: `native thread not confirmed yet; wait or cancel`. Nothing was submitted |
| The same `reply --last` after that `ask` finished | Exit 0 on the newest thread, round 2/9; the older thread was not touched |
| `review --to grok --uncommitted` in a repository with `diff.noprefix=true` | Exit 0, coverage `reviewed: ["f.txt"]` |
| `ask --to codex` | `pong`, exit 0, 8.5 s, cleanup confirmed |
| `ask --to gemini` | `pong`, exit 0, 18.3 s, cleanup confirmed |

The fix diff's own reviews also ran on this code: `review --to codex`, `--to gemini` and `--to grok`, with no cleanup pending. A real 503 and a real locked thread record were not produced; those two rely on the tests above.

## Source

Runtime 4853 → 4870 lines in 24 files; largest module `lifecycle.mjs` 473 → 476; entry 413 → 419; lines over 120 / 160 characters 387 / 125 → 391 / 127. Tests 11,768 → 12,033 lines in 69 files. Skill 2,996 B, description 122 B, contract, model defaults and the 11 commands are unchanged. `gemini-service.mjs` and `request-publication.mjs` are unchanged, so they stay byte-identical with the Codex-hosted release.

## Limits

This remains **1.0.0-rc.9**. Exact macOS and interactive qualification still gates final 1.0.0, so the macOS behaviour of these fixes rests on their platform-independent tests, which were run only on Windows here. Linux stays optional. The Codex-hosted twin was not changed. It has the same `--last` filter and stdout-only error handler at v1.1.2, and needs its own check.
