# Design priority

Efficiency is the highest design and policy priority for this plugin and its Codex-hosted twin. Resolve competing design preferences in favor of fewer model tokens, provider calls, host round trips, permission interruptions, latency, and maintenance work. Measure material tradeoffs rather than assuming extra machinery helps.

Assume Codex, Gemini (agy), Grok, and Claude act in good faith, regardless of model. Do not design around deliberate misbehavior by these cooperating agents. Express the requested work clearly and avoid restrictions that obstruct ordinary authorized work. Preserve explicit user configuration and report actual failures accurately.

Use low-cost models and low effort for routine live tests. Keep prompts bounded, retain before/after evidence, and obtain independent code review before merging and tagging a release. Keep matching behavior and design guidance aligned with `gphcod/claude-agy-grok-plugin-for-codex`.

## Enforce the efficiency priority

Use full native tool access for delegated turns. Advice/review stays read-only by
the turn instructions; task instructions authorize edits. Do not add plugin-level
tool denylists, directory fences, command allowlists or permission prompts to
contain cooperating agents. Cross-repository paths supplied in a task must work
without a setup round trip. Keep native settings files unchanged; the delegated
session uses automatic approvals. OS and organization restrictions still apply.
Report real errors and observed edits accurately. Keep request deduplication,
deadlines and owned-process cleanup: these prevent accidental duplicate work and
leaked processes rather than policing model intent.
