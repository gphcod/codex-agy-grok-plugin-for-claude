# Gemini efficiency fixes and macOS evidence — 2026-11-04

Claude Opus 5.5 (low effort) implemented and exercised this change in a real interactive Claude Code 2.1.318 session on jef, macOS 26.7.1, Node 24.21.0. Runtime changes were reviewed independently before merge.

The previous installed 1.0.1 build denied Gemini routine shell inspection; task d85d0662031b4628 ended with attention and no edit. The first patch allowed finite inspection commands and task command(*), preserving configured ask/deny rules. Source task 38e46edc9a4bdf67 then edited calc.js (exit 0); review ba4940a4f47914bf found the planted bug (expected exit 10) with no attention. Native sandbox still blocked node execution, so the final patch forces --sandbox only on inspection turns. Replies after tasks regain inspection settings and sandbox; no global provider settings changed.

The matching Codex-hosted runtime passed live task 29a2817d762bd4fd: Gemini gemini-3.8-flash/low fixed calc.js and ran npm test, one test passed, exit 0, no failed commands. This is cross-host supporting evidence, not a claim of installed Claude 1.0.2 validation. Follow-up installed results belong in a separate record.

Interactive 1.0.1 coverage: asks, last-thread and explicit-thread replies, supported review modes, three-provider background fanout and explicit followups, wait listing/replay, setup, and model refresh. Models were gpt-6-luna, gemini-3.8-flash, and grok-4.7-build-fast, all low effort. Codex adversarial review correctly rejected with exit 2. Full details are in macos-opus-baseline.json; earlier Gemini review findings with denied inspection are not clean qualification passes.

Remaining installed-host cells at this release: rerun Gemini task/review on installed 1.0.2; live cancellation must catch running jobs (previous attempts arrived after completion); type Gemini/Grok slash shortcuts. Do not interpret this patch release as all-platform qualification.

Review: two independent gpt-6-luna/low reviewers found no substantive defect. The final conditional-sandbox delta and cross-host parity were approved. Reviewers made no paid provider calls.

Final `npm test`: 560 tests, 557 passed, 3 skipped, 0 failed after the sandbox fix and version bump. Skips are the opt-in live suites.
