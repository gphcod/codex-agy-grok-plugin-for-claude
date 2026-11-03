# rc.8 Windows efficiency and publication qualification

Owner date: 2026-11-02 Pacific; raw records use UTC. [Final raw benchmark](../measurements/benchmark-rc8-windows.json), [historical native workflow record](../measurements/live-rc7-windows.json), [Windows lock qualification](windows-request-lock.md), [service qualification](gemini-service-recovery.md).

Baseline rc.6: a26329f20f7443f603a95f322db25cb551a47a52 / 44e0e67c44b67ce1b8860ba66eeb290a2cf351ce6009c7a985d7725c3e20bb0b. Frozen rc.8 runtime: a222187ca2d34c1fa7b84bd98a63beacca6eb819 / ca8610fc6792de94e27060f532e97745616cd1623a72247ea7cfa36b100525d4. Later documentation commits do not change these plugin bytes. The rc.7 measurement remains historical and is superseded for latest-payload qualification by this run.

Ten samples per arm/provider/workload, 100 retained jobs, identical pinned rc.6 fakes/defaults/inputs, alternating sequential arm order. All 240 calls meet expected 0/10 results; hashes stay unchanged. No other tests or paid model calls ran alongside this measurement. Normal desktop/OS activity was not controlled.

## Complete results

| Arm | Provider / workload | n | Median / p95 | Framing B | Provider input B | Inventory / metadata reads |
|---|---|---|---|---|---|---|
| baseline | codex / ask | 10 | 0.974 / 1.317 s | 203 | 875 | 2 / 202 |
| baseline | codex / reply | 10 | 0.988 / 1.066 s | 203 | 875 | 2 / 204 |
| baseline | codex / review | 10 | 1.043 / 1.083 s | 224 | 0 | 2 / 203 |
| baseline | codex / discussion | 10 | 0.978 / 1.030 s | 203 | 868 | 2 / 204 |
| baseline | gemini / ask | 10 | 0.985 / 1.061 s | 209 | 877 | 2 / 202 |
| baseline | gemini / reply | 10 | 0.991 / 1.058 s | 209 | 877 | 2 / 204 |
| baseline | gemini / review | 10 | 1.243 / 1.352 s | 230 | 5128 | 2 / 203 |
| baseline | gemini / discussion | 10 | 0.989 / 1.012 s | 209 | 870 | 2 / 204 |
| baseline | grok / ask | 10 | 0.974 / 1.006 s | 197 | 875 | 2 / 202 |
| baseline | grok / reply | 10 | 0.978 / 1.001 s | 197 | 875 | 2 / 204 |
| baseline | grok / review | 10 | 1.223 / 1.245 s | 218 | 4286 | 2 / 203 |
| baseline | grok / discussion | 10 | 0.975 / 0.991 s | 197 | 868 | 2 / 204 |
| candidate | codex / ask | 10 | 0.984 / 1.002 s | 127 | 744 | 2 / 202 |
| candidate | codex / reply | 10 | 0.982 / 1.001 s | 127 | 744 | 2 / 204 |
| candidate | codex / review | 10 | 1.043 / 1.081 s | 180 | 0 | 2 / 203 |
| candidate | codex / discussion | 10 | 0.981 / 1.037 s | 127 | 737 | 2 / 204 |
| candidate | gemini / ask | 10 | 0.993 / 1.043 s | 133 | 746 | 2 / 202 |
| candidate | gemini / reply | 10 | 0.985 / 1.057 s | 133 | 746 | 2 / 204 |
| candidate | gemini / review | 10 | 1.235 / 1.271 s | 186 | 5128 | 2 / 203 |
| candidate | gemini / discussion | 10 | 0.981 / 1.033 s | 133 | 739 | 2 / 204 |
| candidate | grok / ask | 10 | 0.979 / 1.014 s | 121 | 744 | 2 / 202 |
| candidate | grok / reply | 10 | 0.984 / 0.997 s | 121 | 744 | 2 / 204 |
| candidate | grok / review | 10 | 1.237 / 1.306 s | 174 | 4286 | 2 / 203 |
| candidate | grok / discussion | 10 | 0.981 / 1.022 s | 121 | 737 | 2 / 204 |

Ask framing remains 203/209/197 → 127/133/121 B, saving 76 B for Codex/Gemini/Grok. Advice wrapper text saves 131 B per provider (about 15%); review framing saves 44 B and review input stays unchanged. Native Codex target-flag review reads its own diff; that context is outside this wrapper-byte count. Discussion is a third ask-thread turn because this host’s review is not resumable.

The final request protocol adds immutable names, stage reads and data flushes. Four request-index names are retained per completed request. Inventory/meta-file counters do not cover every request-stage read; no 40% inventory reduction is claimed. Timings and tails are reported per cell without claiming a universal speedup. No billed-token or model-quality comparison is implied.

## Source, tests and communication

Runtime 4593 → 4853 lines, 20 → 24 files; largest module 647 → 473 lines. The skill is 2,996 B / description 122 B; per-turn contract and permissions remain. Compact metadata preserves recovery handles, native IDs stay in JSON/state, and speculative history is refreshed under admission. Owner liveness checks scope a PID; cleanup keeps full process evidence.

Final `npm test`: **525 total, 502 pass, 23 platform skips, zero failures**, 154,929 ms. Eighteen new publication regressions cover native held files, immutable/flush ordering, progress races, competing cleanup/preparation, downgrade behavior and no duplicate submission. Ten service regressions and all six final cross-host recovery/outage/partial UAT cases pass. The earlier 31 Codex shell carriers and rc.6 86-case Claude Windows matrix remain separately dated evidence.

Fifteen native workflow/input checks on efficiency source 913aa35 and three real-Claude/fake-provider normal smokes remain historical evidence for unchanged normal prompts/permissions. Final installed default asks are recorded separately in the handbook. Native input pairs are mixed: Codex 17,390 → 19,702 (+2,312; cache 13,440 both), Gemini 11,881 → 11,851 (−30), Grok input+cache 8,533 → 7,883 (−650 with changed cache mix). One exploratory pair per provider with varying output/context/cache cannot establish billed-cost or general native-token savings.

The source review decisions, including Claude’s stage-read/durability findings and extra paired preparation/cleanup protection, are in docs/decisions.md. Argon found no actionable findings in its compact review; Grok source reviews hit bounded deadlines and are not approvals. 

This remains **1.0.0-rc.8**. Exact macOS/interactive qualification still gates final 1.0.0; Linux is optional. Windows full-machine power-loss recovery remains unqualified. Completed legacy combined-plugin records replay; unfinished legacy records stay occupied for explicit reconciliation. The two small shared helpers are byte-identical, not the full host cores.
