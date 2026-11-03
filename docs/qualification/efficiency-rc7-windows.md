# rc.7 Windows efficiency qualification

Owner date: 2026-11-02 Pacific; raw records use UTC. [Raw final benchmark](../measurements/benchmark-rc7-windows.json), [native workflow/input record](../measurements/live-rc7-windows.json), [service recovery qualification](gemini-service-recovery.md).

## Frozen source and method

Baseline v1.0.0-rc.6: a26329f20f7443f603a95f322db25cb551a47a52 / plugin SHA-256 44e0e67c44b67ce1b8860ba66eeb290a2cf351ce6009c7a985d7725c3e20bb0b. Final runtime candidate: 8ccb120f9a67b3a0e3fc3b36110b099e878f9025 / plugin SHA-256 4a90f88ce24d3b75143ba9a8005a40cf6036eccf72d27432189bc61f56d54dc3. Later qualification-only commits do not change these plugin bytes. An earlier pre-503 benchmark is superseded by this final run.

Ten samples per arm/provider/workload, 100 seeded completed jobs, identical rc.6 fakes/default models/inputs, alternating sequential arm order. Four workloads: ask, reply, planted-bug review and a third ask-thread discussion turn (reviews are not resumable here). All 240 calls meet their expected 0/10 outcomes. The harness verifies hashes before/after and rejects source drift. No other tests or paid model calls ran alongside the final benchmark; normal desktop/OS activity was not controlled.

## Results

Ask framing is Codex 203 → 127 B, Gemini 209 → 133 B, Grok 197 → 121 B: 76 B less each. Advice wrapper-controlled input is 875/877/875 → 744/746/744 B, saving 131 B (about 15%). Review framing saves 44 B; review input stays unchanged. Codex native target-flag review carries zero wrapper prompt bytes but reads its own diff, excluded here. Per-turn contract/permission recipes remain, including resumes; native usage and cache counters are separate from wrapper bytes.

| Arm | Provider / workload | n | Median / p95 | Framing B | Provider-input B | Inventory / metadata reads |
|---|---|---|---|---|---|---|
| baseline | codex / ask | 10 | 1.001 / 1.962 s | 203 | 875 | 2 / 202 |
| baseline | codex / reply | 10 | 0.999 / 1.021 s | 203 | 875 | 2 / 204 |
| baseline | codex / review | 10 | 1.061 / 1.333 s | 224 | 0 | 2 / 203 |
| baseline | codex / discussion | 10 | 1.001 / 1.044 s | 203 | 868 | 2 / 204 |
| baseline | gemini / ask | 10 | 1.013 / 1.077 s | 209 | 877 | 2 / 202 |
| baseline | gemini / reply | 10 | 1.017 / 1.090 s | 209 | 877 | 2 / 204 |
| baseline | gemini / review | 10 | 1.253 / 1.339 s | 230 | 5128 | 2 / 203 |
| baseline | gemini / discussion | 10 | 1.012 / 1.041 s | 209 | 870 | 2 / 204 |
| baseline | grok / ask | 10 | 1.007 / 1.038 s | 197 | 875 | 2 / 202 |
| baseline | grok / reply | 10 | 0.998 / 1.028 s | 197 | 875 | 2 / 204 |
| baseline | grok / review | 10 | 1.260 / 1.275 s | 218 | 4286 | 2 / 203 |
| baseline | grok / discussion | 10 | 1.006 / 1.305 s | 197 | 868 | 2 / 204 |
| candidate | codex / ask | 10 | 1.003 / 1.180 s | 127 | 744 | 2 / 202 |
| candidate | codex / reply | 10 | 1.001 / 1.027 s | 127 | 744 | 2 / 204 |
| candidate | codex / review | 10 | 1.062 / 1.080 s | 180 | 0 | 2 / 203 |
| candidate | codex / discussion | 10 | 1.001 / 1.055 s | 127 | 737 | 2 / 204 |
| candidate | gemini / ask | 10 | 1.008 / 1.054 s | 133 | 746 | 2 / 202 |
| candidate | gemini / reply | 10 | 1.015 / 1.069 s | 133 | 746 | 2 / 204 |
| candidate | gemini / review | 10 | 1.253 / 1.313 s | 186 | 5128 | 2 / 203 |
| candidate | gemini / discussion | 10 | 1.013 / 1.058 s | 133 | 739 | 2 / 204 |
| candidate | grok / ask | 10 | 0.997 / 1.012 s | 121 | 744 | 2 / 202 |
| candidate | grok / reply | 10 | 0.998 / 1.012 s | 121 | 744 | 2 / 204 |
| candidate | grok / review | 10 | 1.246 / 1.264 s | 174 | 4286 | 2 / 203 |
| candidate | grok / discussion | 10 | 1.000 / 1.026 s | 121 | 737 | 2 / 204 |

Median inventory and meta-file reads are unchanged. The avoided redundant thread-record read is outside that tracer’s meta-file count; no 40% inventory saving is claimed. Owner reservation queries scope one PID; unknown identity stays unknown, while cleanup still takes a full snapshot. The fake Node Codex launcher uses a query path; the qualified native fast path differs. Timings are mixed, including slightly worse tails; no universal latency improvement is claimed.

## Maintenance and communication

Runtime grows 4593 → 4681 lines, 20 → 23 files. Splitting control/recovery reduces the largest file 647 → 473 lines without another execution path. Speculative reply resolution is reused, then refreshed under the claim. The skill is 3,000 → 2,996 B and description 150 → 122 B after adding 503 guidance. Healthy redundant reply hints and repeated native IDs are removed; durable job handles are announced after spawn and before native init, while native IDs remain in JSON/state/wait. Unknown thread confirmation still requires wait/cancel. Native usage is added to JSON; the pre-existing costUsd mapping was correct and unchanged.

Final `npm test`: **507 total, 484 pass, 23 platform skips, zero failures**, 110,357 ms. Generated commands, skill cap, fixture invocation contracts, and core-density checks pass (6,093 test / 3,123 core lines, 1.95×). The rc.6 baseline had 493 total / 470 pass / 23 skip. New service regressions total ten per host.

Fifteen native workflow/input calls on efficiency commit 913aa35 pass. Read-only reply after a task did not edit its file: Codex/Grok refused in text with exit 0, Gemini denied with exit 10. Three real-Claude/fake-provider normal smokes pass with exactly one model submission and no permission denials. The final six-case cross-host 503 qualification additionally verifies recovery, persistent stopping and partial draft retention.

Native input pairs are exploratory: Codex 17,390 → 19,702 (+2,312; cache 13,440 both), Gemini 11,881 → 11,851 (−30), Grok input+cache 8,533 → 7,883 (−650; cache mix changes). Output/context vary; the Codex increase has no established cause. No billed-cost, long-session or across-provider token improvement is inferred.

## Release limits

This remains **1.0.0-rc.7**, not final 1.0.0. The rc.6 86-case Windows matrix separately covers launcher/call-form/default-permission behavior; exact rc.7 macOS and interactive release checks remain open. Cross-host neutral-core comparison remains deferred; only the service helper is independently verified byte-identical. Claude-hosted Gemini read-only recovery relies on native no-visible-work evidence without a Git mutation comparison; the Codex host additionally excludes unknown snapshot coverage. Native backend availability is external.
