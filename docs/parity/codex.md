# Parity: codex-plugin-cc 2.3.2 → council (S3.6)

Every command, flag, environment variable, output field and documented caveat of codex-plugin-cc 2.3.2 (`~/.claude/plugins/cache/gphcod-codex/codex/2.3.2`), and what `council` does instead. Status: **same**, **renamed**, **intentionally different** (with the reason), or **missing** (none at the gate). Evidence names the council file or test that shows it.

## Commands

| codex-plugin-cc | council | Status | Evidence / note |
|---|---|---|---|
| `/codex:ask`, `ask` | `/council:ask --to codex`, `/council:codex`, `ask --to codex` | renamed | new read-only thread: `exec -C <cwd> -s read-only`; `tests/codex-turns.test.mjs` "ask" |
| `/codex:reply`, `reply <job\|thread\|--last>` | `/council:reply`, `reply --thread <job\|thread>`, `--last`, or the job id as first word | same | provider inherited from the record; `exec resume <thread> -c sandbox_mode=read-only`, cwd set; `codex-turns` chain test |
| `/codex:review [--base\|--commit] [focus]` | `/council:review --to codex …` | same | both routes of A5.1; `codex-turns` "review, both routes, every target" |
| focus text makes a review adversarial | focus text (stdin route) | same | the donor's skill called the focused review adversarial; council's `--adversarial` is the collected-diff template of gemini/grok and exits 2 on codex (A3.3) |
| `/codex:rescue [--thread]` | `/council:task --to codex [--thread]` | renamed | `exec -s workspace-write` or `exec resume -c sandbox_mode=workspace-write`; default tier `exec`; `codex-turns` chain test |
| `/codex:wait [job] [--timeout]` | `/council:wait [job] [--timeout]` | same | core; lists this session and workspace's jobs of every provider; 20 when still running |
| `/codex:cancel [job] [--timeout]` | `/council:cancel [job] [--timeout]` | same | core `cancelManaged`; owner-death path loads `codex.mjs` for `ownsProcess` only; live cancel in `docs/qualification/codex-macos.md` |
| `/codex:setup` | `/council:setup [--to codex]` | same | binary, launcher kind, version, login, catalog, tiers, MCP note; `codex-turns` "setup and models --refresh" |
| — | `models [--to codex] [--refresh]` | intentionally different (new) | static catalog plus a cached `codex debug models` listing (A3.2) |
| `codex` skill (model-visible) | `council` skill | renamed | one skill for three providers; body written in S6.1 (A3.5 keeps the donor's policy: consult when the user did not ask, never start a task autonomously) |

## Flags

| codex-plugin-cc | council | Status | Note |
|---|---|---|---|
| `--session` | `--session` | same | |
| `--tier consult\|exec\|deep` | `--tier` | same | tiers.json codex rows equal the donor's |
| `--model` | `--model` (id or alias `sol`, `terra`, `luna`, `astra`) | same | aliases added; unknown ids pass through, footer `model unverified` |
| `--effort` (low…max, ultra) | `--effort` | intentionally different | council clamps against the catalog and refuses `ultra` on a model whose list lacks it (exit 2, A3.3); the donor passed any token (the CLI accepts any, S1.1) |
| `--thread` | `--thread` | same | |
| `--last` | `--last` | same | scoped to session and workspace (A7.2) |
| `--base`, `--commit` | `--base`, `--commit` | same | implicit base stays fully qualified (`refs/heads/main`), as in 2.0.3 |
| `--uncommitted` | `--uncommitted` | same | the implicit choice without a flag (dirty tree → uncommitted, clean → default branch) is unchanged |
| `--timeout` (wait, cancel) | `--timeout` | same | 90 s for wait, 30 s for cancel, as in the donor |
| `--inactivity-timeout`, `--deadline` | same | same | 1200 s / 14400 s defaults; not request inputs (A7.4) |
| `--rounds` | `--rounds` | same | default 9, `COUNCIL_ROUNDS`; refused on review (S2.8) |
| `--request-id` | `--request-id` | same | replay without a second CLI; binding across providers (A7.4) |
| `--json` | `--json` | intentionally different | object gains `provider`, `modelVerified`, `requestedEffort`, `verdict`, `findings`, `coverage`, `edited`, `failedCommands`, `costUsd` (A3.4); `patched`/`failedCmds` became `edited`/`failedCommands` |
| — | `--to`, `--adversarial`, `--web` | intentionally different | `--to codex` selects the provider; `--adversarial` and `--web` exit 2 on codex before any job (`checkRequest`, A3.3) |

## Environment

| codex-plugin-cc | council | Status | Note |
|---|---|---|---|
| `CODEX_COMPANION_CODEX_BIN` | `COUNCIL_CODEX_BIN` | renamed | |
| `CODEX_COMPANION_MCP=inherit\|off` | `COUNCIL_CODEX_MCP` | renamed | same policy and calls (`lib/tools.mjs` port); an invalid value exits 2 before any job |
| `CODEX_COMPANION_ROUNDS` | `COUNCIL_ROUNDS` | renamed | shared by all providers |
| `CODEX_COMPANION_DEPTH` (nesting guard) | `COUNCIL_DEPTH` plus the three replaced plugins' variables | intentionally different | every child gets all four; admission refuses when any is set (A5.1) |
| `CODEX_COMPANION_HOME` (default `~/.claude/codex-companion`) | `COUNCIL_HOME` (default `~/.council`) | renamed | one state root for three providers (A7.1); old job records are not migrated |

## Output

| codex-plugin-cc | council | Status | Note |
|---|---|---|---|
| start line `[codex] job=<id> thread=<id>[ target=…]` | `[council] provider=codex job=<id> thread=<id>[ target=…]` | intentionally different | provider named (A3.4) |
| footer prefix `-- codex <status>` | `council codex <status>` | intentionally different | A3.4 grammar shared by three providers |
| footer job id only as follow-up | `job <id>` always, plus the follow-up | intentionally different | frozen footer (S2 freeze) |
| no model/effort in the footer (2.2.2) | `<model>/<effort>[<=requested]` | intentionally different | three providers with clamping; the clamp must be visible (A3.3) |
| elapsed time | elapsed time | same | |
| `patched N` (not on review) | `edited N` on task only | intentionally different | read-only verbs cannot edit; `--json` `edited` on every verb |
| `failed cmds N` | `--json` `failedCommands` | intentionally different | A3.4 moves counters to `--json` |
| `round N/M` on reply | `round N/M` on ask, reply and task | intentionally different | A3.4: threaded verbs show their round |
| `files …`, `failing …` on rescue | `--json` `edited`, `failedCommands` | intentionally different | A3.4 |
| `full: <file>` at 24 KiB | `full: <file>` at 24 KiB | same | |
| `error: <msg>` | `error: <msg>` | same | |
| `thread locked: … next: a new ask` | `thread locked: …` | same | 12 s held-pipe wait, core |
| `cleanup pending; next: cancel <job>; do not resume` | same text | same | |
| `next: reply <job>` | same, never on a review | same | |
| exit codes 0/10/20/1/2 | 0/10/20/1/2 | same | |
| open questions in the answer → needs attention (10) | same | same | core `readAnswer` |
| review `[P0]`/`[P1]` → needs attention (10), otherwise 0 | `[P0]` BLOCKER, `[P1]` MAJOR, `[P2]`/`[P3]` MINOR → `changes` (10); a malformed finding line, empty or fallback text → `incomplete` (10); a review with no finding → `incomplete` (10) with `codex reported no findings; its output cannot prove a clean review` | intentionally different | A5.1/A5.2: Codex turns reviewer output it cannot parse into an explanation with no findings, identical to a genuine clean review (rust-v0.163.0 core/src/tasks/review.rs:175-194, protocol/src/review_format.rs:57-74), so a clean Codex review exits 10 instead of 0; findings are listed as F1/F2 with severity and file:line, and Codex's text is kept after an incomplete verdict (decisions S3.3, S3.7) |
| `--json` review fields | `verdict`, `findings`, `coverage` | intentionally different | A5.2 normalized result |

## Behaviour and caveats

| codex-plugin-cc | council | Status | Note |
|---|---|---|---|
| stdin read stops after 10 s without a byte (2.3.2) | same, `COUNCIL_STDIN_DEADLINE_MS` for tests | same | core `stdin.mjs` |
| held pipes: 12 s wait after a clean exit, then `thread locked` (2.3.0) | same | same | core `PIPE_WAIT_MS` |
| Windows PowerShell queries set `PSModulePath` to `$PSHOME\Modules` (2.3.2) | same, inline, no `.ps1` | same | core `execution.mjs` |
| MCP inheritance default `inherit`; `off` drops servers, plugins, apps on ask/reply/review with one or two `codex mcp list` calls; setup states the trade-off | same | same | `codex-turns` MCP count test (2 with servers, 1 without, 0 on task); setup note |
| post-exit scan on Linux/macOS after every exit; Windows trusts `codex.exe`/npm `codex.js` only | same | same | `trustsCleanExit` (decisions S3.1); `codex.test.mjs` trust matrix |
| ownership by the exact `-o <answer>` operand; macOS matches native `codex` or npm `codex.js` | same | same | `ownsProcess` with `["codex", "codex.js"]`; argv and raw rows tested |
| cancel kills the commands Codex runs in their own sessions (2.0.1) | same | same | core group stop plus persisted descendant identities (A7.5) |
| `ps` in a UTF-8 locale, negative uids (2.0.1, 2.2.1) | same | same | core `processSnapshot` |
| `--request-id` replay, changed input → 2 | same | same | core A7.4 |
| prune finished jobs past 100, 16-character ids | same | same | core `prune`, `jobs.mjs` |
| thread claims, lost or cleanup-pending job blocks its thread | same | same | core claims, A7.8 |
| nested-call refusal after stdin | same | same | core `assertNotNested` |
| reply after rescue is read-only | reply is always read-only | same | `codex-turns` chain test: reply after a task resumes with `sandbox_mode=read-only` |
| `codex exec` refuses an untrusted, non-Git directory | same message passes through (exit 1) | same | council adds no `--skip-git-repo-check` (decisions S1) |
| an `error` event without `turn.completed` fails the turn with its message | same | same | `parseEvent` keeps `error` unlatched (decisions S3.3) |
| a sandbox refusal is a failed command (footer `failed cmds N`), exit 0 | a failed command whose output carries codex-rs's sandbox-denial keywords (`operation not permitted`, `permission denied`, `read-only file system`, `seccomp`, `sandbox`, `landlock`, `failed to write file`) is a denied action: needs attention (10); other failing commands stay `failedCommands` | intentionally different | A3.4: a denied action exits 10; `codex.test.mjs` parseEvent, `codex-turns` denied scenario (decisions S3.7) |
| `ultra` passed to Codex unchecked | refused (2) on models whose catalog list lacks it | intentionally different | A3.3, `codex-turns` ultra test |
| slash commands: seven files | eleven generated `/council:*` files | renamed | `/council:codex` equals `/council:ask --to codex` |
| Stop review gate, hooks (removed in 2.0.0) | none | same | not in 1.0 (A1) |
