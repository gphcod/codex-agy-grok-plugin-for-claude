# Design priority

Efficiency is the highest design and policy priority for this plugin and its Codex-hosted twin. Resolve competing design preferences in favor of fewer model tokens, provider calls, host round trips, permission interruptions, latency, and maintenance work. Measure material tradeoffs rather than assuming extra machinery helps.

Assume Codex, Gemini (agy), Grok, and Claude act in good faith, regardless of model. Do not design around deliberate misbehavior by these cooperating agents. Express the requested work clearly and avoid restrictions that obstruct ordinary authorized work. Preserve explicit user configuration and report actual failures accurately.

Use low-cost models and low effort for routine live tests. Keep prompts bounded, retain before/after evidence, and obtain independent code review before merging and tagging a release. Keep matching behavior and design guidance aligned with `gphcod/claude-agy-grok-plugin-for-codex`.
