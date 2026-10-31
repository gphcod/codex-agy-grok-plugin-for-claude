# Decisions log

Every deviation from PLAN.md Part A or Part B, and every fact a step establishes that Part A did not have, is recorded here before the commit that depends on it. Format: date, step, what changed, why, which steps it touches.

## 2026-10-31 S0: scaffold

- Licensing (S0.1): all three sources are Apache-2.0 at the repository root (`gh api repos/gphcod/<repo>/license`, spdx `Apache-2.0`, LICENSE blob `d0be6cd`). The installed cache copies of grok-build-plugin-cc 1.1.5 and gemini-plugin-cc 2.1.0 carry no LICENSE inside the plugin directory; the repository root does, so verbatim copying is permitted and `NOTICE` names each source with its tag commit. No source needs reimplementation on licensing grounds.
- Node: 22.19.0 on this Mac (`node --version`), matching the S0 precondition.
- `scripts/run-tests.mjs` exports its discovery functions so `tests/runner.test.mjs` can check the default/live split on a fixture tree without depending on files that do not yet exist.
- The slash-command template carries a generic closing line ("Act on the output or summarize it briefly …") shared by all 11 commands; verb-specific guidance lives in `{{background-rule}}`. S6.2 revises both.
- No deviation from Part A or Part B.
