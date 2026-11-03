# Gemini 503 recovery: Windows qualification

Owner date: 2026-11-02 Pacific; raw records use UTC. [Structured evidence](../measurements/gemini-service-recovery-windows.json).

The observed outage occurred through **codex-agy-grok-plugin-for-claude**, the Claude-hosted wrapper. Both original failures had already streamed substantial response work (18,601 and 18,230 characters); the first had 94 tool-type updates, not necessarily 94 distinct tools. These are not eligible for automatic repeat. Their immutable jobs were retained and their partial text recovered privately.

## Implemented behavior

The exact agy 1.4.12 UNAVAILABLE/code-503 signature is classified as a temporary upstream failure, retaining exit 1, usage and the original request. Permanent/authentication errors are unchanged. A host may repeat once per user request only when a plugin footer token starts `temporary 503; next: repeat once` or JSON says `retry.eligible=true`. Keep inputs/model/permissions, wait at least two seconds, use a fresh request id, then stop on a second failure. No transport loop or global cross-call counter is hidden inside the companion. Same-id replay never submits again.

Partial output, started tools, tasks, recorded edits, unconfirmed threads and uncertain cleanup block retry. Codex additionally excludes unknown Git mutation coverage. Claude relies on native no-visible-work evidence; it does not take read-only Git snapshots. Uncertain service failures retain warning information and manual continuation handles without another automatic next-input instruction.

An unfinished response is saved separately in `partial.md`, marked not a completed review or approval, with a footer/conditional JSON pointer. It never becomes the final answer, verdict or reviewed coverage. Draft-write failure retains the original provider error. A denial before a 503 cannot turn it into completed work.

## Final host checks

| Host / fixture | Model submissions | Provider exits | Submission interval | Partial draft | Result |
|---|---|---|---|---|---|
| claude / recover | 2 | 1 → 0 | 7.244 s | — | pass |
| claude / outage | 2 | 1 → 1 | 8.845 s | — | pass |
| claude / partial | 1 | 1 | — | retained, unfinished | pass |
| codex / recover | 2 | 1 → 0 | 15.466 s | — | pass |
| codex / outage | 2 | 1 → 1 | 13.154 s | — | pass |
| codex / partial | 1 | 1 | — | retained, unfinished | pass |

All six final cases pass with confirmed cleanup. Both recoveries reach pong; both persistent outages stop after two model submissions; both partial turns stop after one submission and preserve the unfinished draft without approval. Claude Opus 5.5/high ran with default permissions, Bash and plugin-dir, with zero permission denials. Codex 6.1 Sol/medium used the exact skill explicitly by path. These are functional checks, not latency/billing or desktop-wake measurements.

Ten service regressions pass per host, including ask/reply/review replay, approve-shaped partial reviews, the broken-stream guard and draft-save failure. Code output checks also verify manual continuation and warning precedence. Shared classifier/draft helper SHA-256: 7b21bee1dc4af7a2e9e66c632b2b9fad6718ab502677f4f6e6ba9dca3f29af37. Other core parity is not implied.

## Review and limits

Claude Opus 5.5/high and xhigh (Extra) findings are recorded in `docs/decisions.md`; final minor fixes were locally verified. Argon/high found no actionable issues, with an exit-10 workspace-change notice caused by concurrent documentation edits from the primary agent. Grok’s bounded final review hit its deadline, so it is not an approval; its five native workflow/input checks passed separately. Later native Gemini checks also passed, but cannot guarantee future backend availability.

Only the tested native signature is classified. Old failed jobs are never retroactively marked eligible. macOS, interactive release qualification and Codex desktop discovery/wake remain separate.
