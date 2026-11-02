# Changelog

## 1.0.0 (unreleased; 1.0.0-rc.2 candidate)

First release of `council`. A single plugin now provides the following, through one companion process and one provider CLI child per call:

- questions to Codex (`codex`), Gemini (`agy`) and Grok (`grok`)
- discussions with delta replies
- reviews
- authorized delegated edits

The release check is S7 of `PLAN.md`: a macOS matrix, a Windows session and the tag.

### Windows (checked 2026-11-01, `docs/qualification/windows.md`)

- Gemini (agy) runs on Windows; the refusal stays behind `WINDOWS_QUALIFIED`.
- Requires Node 22.19.0 or later; Node 18 is no longer supported.
- `git rev-parse --show-toplevel` output is made native, so repository roots compare equal to other paths.
- PowerShell and taskkill run from their system paths, so a narrow or planted PATH cannot break cleanup.
- `cancel` no longer records a recovery on a job its owner finished during a slow process query.
- Guard variables are the union of every replaced plugin's, so a call inside a council child cannot start one of them.
- The test runner stops leftover fixture processes, retries removing its temp root and fails the run if it cannot.
- `.gitattributes` keeps every text file LF, so a Windows checkout sends the same contract and templates.
- A file name with a space no longer carries the tab Git ends its diff header with.

### Replaces

| Replaced | By |
|---|---|
| codex-plugin-cc 2.3.2 (`codex@gphcod-codex`): `/codex:ask`, `reply`, `review`, `rescue`, `wait`, `cancel`, `setup`, the `codex` skill | `/council:ask --to codex` (or `/council:codex`), `/council:reply`, `/council:review --to codex`, `/council:task --to codex`, `/council:wait`, `/council:cancel`, `/council:setup`, the `council` skill |
| grok-build-plugin-cc 1.1.5 (`grok-build@gphcod-grok-build`): `ask`, `reply`, `review`, `rescue`, `wait`, `cancel`, `setup`, the `grok` skill | the same verbs with `--to grok` (`/council:grok` for ask) |
| gemini-plugin-cc 2.1.0 (`gemini@gemini-plugin-cc`): `/gemini:review`, `adversarial-review`, `rescue` (`--resume`, `--fresh`, `--plan`), `result`, `status`, `cancel`, `setup`, the stop-review gate | `review --to gemini [--adversarial]`, `task --to gemini [--thread]`, `ask --to gemini` for `--plan`, `wait` for `result` and `status`, `cancel`, `setup`; the gate is dropped |
| `CODEX_COMPANION_*`, `GROK_BINARY`, `GROK_BUILD_ROUNDS` | `COUNCIL_HOME`, `COUNCIL_CODEX_BIN`, `COUNCIL_AGY_BIN`, `COUNCIL_GROK_BIN`, `COUNCIL_CODEX_MCP`, `COUNCIL_ROUNDS` |
| three state roots (`~/.claude/codex-companion`, grok-build's, gemini-plugin-cc's per-workspace state) | one root, `~/.council`; old job records are not migrated |

### Added

- `--to codex|gemini|grok` on every new thread, review and task. The provider is never inferred. A reply inherits the provider and locks it; a conflicting `--to` exits 2.
- `models [--to <p>] [--refresh]`: a static catalog (`models.json`) plus each CLI's cached listing.
- Per-call `--model` (exact id or alias), `--effort low…max` with a downward clamp against the catalog shown in the footer (`grok-4.7/xhigh<=max`), and `--tier consult|exec|deep` from `tiers.json`.
- Reviews of `--uncommitted`, `--base <ref>` or `--commit <sha>` on all three providers. `--adversarial` on Gemini and Grok.
- Fan-out: the skill issues up to three background `ask` calls in one response, each with its own `--request-id`.
- `--request-id` replay across providers. One binding per session, workspace and id means a retry never starts a second CLI, even when `--last` or the catalog would now resolve differently.
- Four guard variables (`COUNCIL_DEPTH`, `CODEX_COMPANION_DEPTH`, `GROK_BUILD_DEPTH`, `CLAUDE_PLUGIN_CODEX_DEPTH`) on every child, probes included. council refuses to start when any of them is set.
- Eleven generated user-only slash commands with a drift check. The turn commands carry a fresh `--request-id` that Claude substitutes. One model-visible skill of 2,998 B.

### Intentional differences

These come from `docs/parity/*.md` and `docs/decisions.md`.

**All providers**

- The footer grammar is shared: `council <p> <ok|needs attention|failed|cancelled> · job <16> · <model>/<effort>[<=req] · <duration> …`.
- The start line names the provider.
- Cost and counters move to `--json`.
- `round N/M` appears on every threaded verb.
- `edited N` appears on `task` only.
- `reply` is always read-only, also after a task.
- A thread is never resumed from another workspace.
- `rescue` is renamed `task`. The skill never starts one on its own.

**Codex**

- A review with no finding reports `incomplete` (exit 10), not exit 0. `codex exec review` writes the same text for a clean review as for output it could not parse, so a clean review cannot be proven; read Codex's text.
- `[P2]`/`[P3]` findings map to MINOR.
- A command refused by the sandbox is a denied action (exit 10), not only a failed command.
- `ultra` on a model whose catalog entry lacks it exits 2.
- `review --adversarial` and `--web` exit 2. Focus text gives the focused route.

**Grok**

- `max` is clamped to `xhigh`; grok-build passed it through and Grok rejected it.
- Grok's own `cancelled` stop (a tool needed a permission that headless Grok cannot ask for) is a denied action (exit 10). Any other stop except `end_turn`, and `max_turns_reached`, keep the answer and exit 1 as `incomplete: <reason>`.
- An end event without a session id keeps the answer and exit code. The footer says `session not confirmed: start a new ask`, and the thread cannot be resumed.
- Malformed review output is `incomplete` (exit 10) instead of a failure.
- Reviews run at the repository root and use the shared review prompts.
- A writing tool advertised or called on a read-only turn still fails closed (exit 1).

**Gemini**

- A denied action exits 10 (was 20); 20 now means still running.
- agy's deny-rule tool-step signature counts as a denial even when `denied_actions` is absent.
- `--mode accept-edits` is passed only on tasks.
- The session settings file merges your global `allow`/`ask`/`deny` lists instead of replacing them. Read-only turns add the six deny rules and keep `--sandbox`.
- `--web` exits 2, because agy's `search_web` cannot be denied. `setup` notes that read-only turns may still search.
- `print_timeout` exits 1 and keeps the partial answer.
- Malformed review output is `incomplete` (exit 10).
- The stop-review gate and hooks are dropped.
- Windows is refused (exit 2, reported by `setup`) until it is qualified.

### Known limits

- Windows qualification for Codex and Grok, and the Gemini decision on Windows, are S7.2.
- Linux is optional and not qualified.
- `COUNCIL_CODEX_MCP=off` saves 19–29 % input tokens per ask. It costs one or two `codex mcp list` calls before each ask, reply and review. The default stays `inherit`.
