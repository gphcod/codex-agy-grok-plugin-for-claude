# council: implementation procedure

One Claude Code plugin, `council`, through which Claude calls Codex (`codex`), Gemini (`agy`, the Antigravity CLI) and Grok (`grok`) for questions, discussions, reviews and user-authorized tasks, choosing provider, model and thinking effort per call.

Status: procedure version, 2026-10-31. The design was reviewed by Codex gpt-6.1-sol, Grok 4.7 and Gemini 4 Argon over two rounds (Part C, rounds 1–2). This procedural rewrite was reviewed by Codex gpt-6.1-sol and Gemini 4 Argon (Part C, round 3) and revised before commit.

## 0. How to use this document

- **Part A** holds the frozen decisions. Every step in Part B refers to them by number (A3, A7.2). Nothing in Part B may contradict Part A; when a step discovers that a CLI fact in Part A is wrong, the step stops, Part A is corrected, the correction is logged in `docs/decisions.md`, and the affected step restarts.
- **Part B** is the procedure: steps S0 to S8. Each step lists its preconditions, numbered actions, the verification that proves each action, the files it leaves behind, and a gate. A step starts only when all of its listed prerequisite gates have passed.
- **Part C** is the review record.

Execution rules:

1. Steps run in the order of the dependency map. S3, S4 and S5 (the three adapters) are independent of each other once S2 is done and may run in parallel, each in its own git worktree and branch, touching only its own provider module, its own uniquely named test files and its own `docs/parity` and `docs/qualification` records. A defect found in the shared core during an adapter step is fixed on `main` in its own commit, then rebased into every open adapter branch; adapter branches never edit `core/` or `council.mjs`.
2. From S2 onward, every code sub-step (S2.1 … S2.7, S3.1 … S3.6, …) ends with `npm test` green and one commit whose subject starts with the sub-step id, for example `S2.3: port jobs and claims`. S0 and S1 commit once each at their gate, because the test runner and the first tests appear during them.
3. Everything a step says to **record** goes under `docs/` in the repository, never only into chat.
4. Any deviation from Part A or Part B is written to `docs/decisions.md` (date, what changed, why, which steps it touches) before the deviating commit.
5. Claude executes the steps. The user authorizes the actions marked **[user]**: installing or uninstalling plugins, tagging a release, running the Windows session, interactive `claude --plugin-dir` sessions, and every `task` that edits a working tree.
6. Live CLI calls cost money and quota; a step runs them only where the procedure names them. Everything else runs against the fakes with a temporary `COUNCIL_HOME` and the `COUNCIL_<PROVIDER>_BIN` overrides pointing at the fakes.

---

# Part A. Decisions

## A1. Scope

Replace codex-plugin-cc 2.3.2, gemini-plugin-cc 2.1.0 and grok-build-plugin-cc 1.1.5 with one plugin that lets Claude:

- ask any of the three models a question on a new read-only thread,
- continue a discussion with delta replies and stable finding ids,
- request a review of uncommitted changes, of a branch against a base, or of one commit, plain or adversarial,
- assign a task that may edit the working tree, only when the user authorizes it,
- fan one brief out to several models and compare the answers,
- choose provider, exact model and effort per call, or use a named tier.

Kept from the design the handbook ranks first (codex-plugin-cc): one companion process and one model-bearing child CLI per provider call, one Bash call per provider call, background task plus notification instead of polling, one model-visible skill under 3,000 B, user-only slash commands generated from one template, a 24 KiB answer cap with `full: <file>`, `--request-id` replays, exit codes 0/10/20/1/2. The only other processes a turn may start are `git` for review collection; the process-table query the lifecycle needs (`ps`, or PowerShell on Windows); with `COUNCIL_CODEX_MCP=off`, the up to two `codex mcp list --json` discovery calls codex-plugin-cc already makes; and, on `setup` and `models --refresh` only, each provider's documented probe commands. S3.4 counts them.

Not in 1.0: MCP server, daemon, hooks (the Gemini stop-review gate may return as an opt-in later), a coordinating multi-child `panel` process (A6), `--worktree`, model-quality ranking, Linux qualification before macOS and Windows pass.

## A2. CLI facts (checked 2026-10-31 on this Mac; S1 re-checks and records them)

| Provider | CLI | Version | Headless form | Resume | Model | Effort | Read-only enforcement |
|---|---|---|---|---|---|---|---|
| Codex | `codex` | 0.163.0 | `codex exec --json -o <file> -C <cwd> -s <mode> … -` (prompt on stdin) | `codex exec resume <thread> … -`; `resume` and `review` accept neither `-C` nor `-s`, so the companion spawns them with `cwd` set and passes `-c sandbox_mode=<mode>` | `-m <id>` | `-c model_reasoning_effort=<e>` | `-s read-only`; `exec review` for native reviews |
| Gemini | `agy` | 1.4.12 | `--input-format stream-json --output-format stream-json`, one NDJSON `user` message on stdin | `--conversation <id>` | `--model <id>` | `--effort low\|medium\|high` | `--settings <file>` whose read-only `deny` list is the union of gemini-plugin-cc's and gemini-plugin-for-codex's: `write_file(*)`, `edit_file(*)`, `command(*)`, `unsandboxed(*)`, `mcp(*)`, `execute_url(*)`; plus `--sandbox`; `--mode accept-edits` only on tasks |
| Grok | `grok` | 1.0.70 | `--prompt-file <f> --output-format streaming-json` | `-r <session>`; `--session-id <uuid>` for a new one | `--model <id>` | `--effort <e>` (alias of `--reasoning-effort`) | `--agent explore`, `--deny` rules, `--disallowed-tools`, `--no-subagents`, `--disable-web-search` |

Codex `exec review` accepts either the target flags (`--base`, `--commit`, `--uncommitted`) or a prompt on stdin, not both (exit 2). codex-plugin-cc therefore runs an unfocused review with the flags and a focused review with the target sentence plus the focus text on stdin (`codex-companion.mjs:150-154`).

Model listings, all headless: `codex debug models` (JSON, each model with `supported_reasoning_levels`; all accept low…max, the sol/terra/astra families also `ultra`), `agy models` (effort-suffixed ids only: `gemini-4-argon-{low,medium,high}`, `gemini-3.8-flash-{low,medium,high}`, plus Claude and GPT-OSS entries council does not route to), `grok models` (`grok-4.7`, `grok-4.7-build-fast`, `grok-4.6` default, `grok-4.5`).

Effort behaviour, probed live:

| Provider | Accepts | On an unsupported value |
|---|---|---|
| Codex | low, medium, high, xhigh, max; `ultra` on the listed families | accepted without error: codex-cli 0.163.0 completed `-c model_reasoning_effort=ultra` on `gpt-6-luna`, whose listing lacks `ultra` (S1.1, 2026-10-31); the CLI does not check the effort against the catalog, council does (A3.3) |
| Grok | low, medium, high, xhigh | `max` → "unknown effort level" |
| Gemini | low, medium, high, or an effort-suffixed id | xhigh/max → "invalid model selection"; suffixed id with a different `--effort` → the same error |

No CLI clamps; council does (A3.3).

Tiers (`tiers.json`, family and effort stored separately):

| Provider | consult | exec | deep |
|---|---|---|---|
| codex | gpt-6.1-sol / xhigh | gpt-6-luna / max | gpt-6.1-sol / xhigh |
| grok | grok-4.7 / high | grok-4.7-build-fast / xhigh | grok-4.7 / xhigh |
| gemini | gemini-4-argon / medium | gemini-3.8-flash / high | gemini-4-argon / high |

The owner set consultation defaults on 2026-11-02 to Codex 6.1 Sol/xhigh, Grok 4.7/high and Gemini 4 Argon/medium. Codex's default consultation therefore follows the background-call rule; Gemini's deep tier remains Argon/high.

## A3. Call surface

### A3.1 Call template

Direct call (flags on argv, text after `--`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council.mjs" <verb> --to <provider> --session "${CLAUDE_SESSION_ID}" [flags] -- <<'COUNCIL_EOF'
<text>
COUNCIL_EOF
```

Generated slash command (the user's leading flags arrive inside the heredoc, so argv carries no `--` and the companion parses leading options out of the text, as codex-plugin-cc's `commands/ask.md` does):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council.mjs" <verb> [fixed flags] --session "${CLAUDE_SESSION_ID}" <<'COUNCIL_EOF'
$ARGUMENTS
COUNCIL_EOF
```

One Bash call and one companion per provider call. A turn makes one call, except a fan-out (A6), which issues up to three background `ask` calls in one response. Reviews, tasks, deep/xhigh/max/ultra calls run with `run_in_background: true`; other calls may run in the foreground with timeout 600000.

### A3.2 Verbs

| Verb | Does | Mode |
|---|---|---|
| `ask --to <p>` | New thread, one answer | read-only |
| `reply --thread <job\|thread> \| --last` | Delta on an existing thread. Provider inherited and locked (a conflicting `--to` exits 2); model and effort inherited unless `--model`, `--effort` or `--tier` is given explicitly, in which case the explicit value wins for that turn and is persisted (the skill passes `--tier consult` only when the user did not ask for the provider, and so may deliberately lower a thread's effort) | always read-only, also after a task |
| `review --to <p> [--base <ref> \| --commit <sha> \| --uncommitted] [--adversarial] [focus]` | Structured review; exit 10 when findings exist | read-only |
| `task --to <p> [--thread <id>]` | Delegated work that may edit the working tree; never started by Claude on its own. `--thread` resumes the recorded native thread with the task's edit mode; without it a new thread starts | edit |
| `wait [job] [--timeout <s>]` | List this session's jobs or await one; replays a finished result; returns 20 without stopping anything | — |
| `cancel [job]` | Stop a job and confirm cleanup (A7.5) | — |
| `models [--to <p>] [--refresh]` | Print the catalog from `models.json` plus the cached listing; `--refresh` re-runs the three listings | — |
| `setup [--to <p>]` | Binary, login, version, catalog age, resolved tiers, launcher kind, known trade-offs; runs each provider's probe commands | — |

`wait` and `cancel` start no provider CLI. `models` reads static and cached data unless `--refresh`. `setup` runs the documented probes.

### A3.3 Flags

- `--to <codex|gemini|grok>`: required on `ask`, `review`, `task`. No inference from the model name.
- `--model <id|alias>`: exact CLI id, or an alias resolved inside that provider's catalog (`sol`, `terra`, `luna`, `astra`, `argon`, `flash`, `4.7`, `4.6`, `build-fast`). An unknown id passes through unchanged; the footer then says `model unverified`.
- `--effort low|medium|high|xhigh|max`: one vocabulary. Council clamps downward only, against the catalog's per-model effort list: the greatest offered effort at or below the request, or the lowest offered when the request is below all. A clamp is shown in the footer token (`gemini-4-argon/high<=xhigh`) and as `effort`/`requestedEffort` in `--json`. `ultra` is a codex-only pass-through token outside the shared enum; on a catalogued model whose list lacks it, exit 2, with or without a refreshed catalog. For Gemini an effort-suffixed id is an explicit effort: the id is passed unchanged, its suffix is parsed only to detect a conflicting `--effort`, which exits 2.
- `--tier consult|exec|deep`: defaults from `tiers.json`; explicit `--model`/`--effort` win. Default `consult`.
- `--thread`, `--last`, `--base`, `--commit`, `--uncommitted`, `--adversarial`, `--rounds`, `--request-id`, `--json`, `--session`. `--adversarial` applies to collected-diff reviews (gemini, grok), which render `prompts/adversarial-review.md`; Codex's native `exec review` has no adversarial mode, so `review --to codex --adversarial` exits 2. `review` refuses `--rounds` (a review starts no thread) and `--web` (it reads the collected diff; grok-build refused it too) with exit 2 (S2.8).
- `--request-id <id>`: 1 to 128 characters matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`; the skill's convention is 8 random characters. The job id is 16 characters derived from provider, session, realpath(cwd) and the request id, so a replay finds the same job.
- Timing: `--deadline <s>` (execution deadline, starts cleanup), `--inactivity-timeout <s>` (no output for that long, starts cleanup), `wait --timeout <s>` (returns 20, stops nothing). agy's `--print-timeout` is set from the deadline; a `print_timeout` result is exit 1, never 20.
- `--web`: web search, off by default. Grok: omit `--disable-web-search`. Codex: no tested mapping in 1.0, exit 2. Gemini: `--web` exits 2 (S1.2 probed the `search_web` tool; a `search_web(*)` deny rule did not block it, so read-only turns cannot deny web search and no mapping exists). Any flag an adapter has no tested mapping for exits 2.

### A3.4 Output grammar, exit codes, slash commands

Start line, stderr, suppressed under `--json`: `[council] provider=<p> job=<id>[ target=<review target>]`. Since rc.7 the durable job is announced after spawn/save, before native init; native ids remain in JSON, state and `wait`. A running job without native confirmation cannot be resumed: wait or cancel it. Healthy footers omit the redundant `next: reply`; failure, attention and cleanup hints remain.

Footer, stdout, one line: `council <provider> <ok|needs attention|failed|cancelled> · job <16 chars> · <model>/<effort>[<=requested] · <duration>[ · round N/M][ · edited N][ · unreviewed N][ · model unverified][ · full: <file>][ · error: <msg> | · attention: <reason>][ · <recovery hint>]`. `round N/M` appears on threaded verbs (`ask` and a fresh `task` print `1/M`; `reply` and `task --thread` print the incremented round), never on `review`. `edited N` appears only on `task`; `unreviewed N` only on `review`. Cost, failed-command count and provider counters go to `--json`, whose object carries `provider`, `job`, `thread`, `session`, `model`, `modelVerified`, `effort`, `requestedEffort`, `tier`, `round`, `rounds`, `verdict`, `findings`, `coverage`, `edited`, `failedCommands`, `costUsd`, `exit`, `answerFile`. (2026-11-01, S7.1 fix X1: the optional `attention: <reason>` token and the `--json` field `attention` were added; one line, at most 200 B, cause first: `denied <action>[ (+N more)]`, `open questions in the answer`, or why a review is incomplete or malformed; never for plain findings and never with `error:`.)

Exit 0 done, 10 needs attention (review findings, denied action, incomplete or malformed review output), 20 still running, 1 failed/cancelled/busy, 2 invalid input.

Slash commands (user-only, `disable-model-invocation: true`, generated from one template): `/council:ask`, `/council:reply`, `/council:review`, `/council:task`, `/council:wait`, `/council:cancel`, `/council:models`, `/council:setup`, and `/council:codex`, `/council:gemini`, `/council:grok` equal to `/council:ask --to <p>`.

### A3.5 Skill policy

When the user did not name a model: `ask`/`reply`/`review` only, `--tier consult` passed explicitly, ask once before higher effort, never `task`, even when the user asks for a fix or edit (2026-11-01, S7.1 fix C1: a provider name is not a model; do the `ask` or `review`, then point to `/council:task` or naming a model). When the user named a model or family: tier by complexity. Discussion protocol: F1/F2 findings tagged BLOCKER/MAJOR/MINOR with file:line; replies carry only `AGREE`, `CHANGE: …`, `REJECT: …` and new facts; 9-reply budget per thread in the footer; unresolved REJECT is reported as disagreement. Fan-out recipe per A6.

## A4. Repository layout

```
.claude-plugin/marketplace.json          marketplace "gphcod-council", plugin ./plugins/council
package.json                             type module, engines, scripts test / test:live / gen / gen:check / measure
plugins/council/
  .claude-plugin/plugin.json             name "council"
  skills/council/SKILL.md                only model-visible file; ≤ 3,000 B (test-enforced)
  commands/*.md                          11 generated files (test-enforced, no drift)
  contract.md                            F1/F2 protocol, one for all providers
  tiers.json  models.json                tiers (A2); static catalog: per-model effort lists, aliases, Gemini family/suffix rule
  prompts/review.md  prompts/adversarial-review.md   provider-neutral collected-diff review templates
  schemas/review-output.schema.json
  scripts/council.mjs                    entry: parse → admit → load adapter → turn → print
  scripts/lib/core/                      args stdin jobs claims heartbeat reader lifecycle execution output launcher git review catalog tiers types fs
  scripts/lib/providers/                 codex.mjs gemini.mjs grok.mjs (each loaded by dynamic import)
scripts/gen-commands.mjs  scripts/measure.mjs  scripts/run-tests.mjs  scripts/templates/command.md
tests/
  fixtures/fake-codex.mjs fake-agy.mjs fake-grok.mjs   fakes that validate the launch contract before answering
  fixtures/null-adapter.mjs fake-child.mjs             core test transport with several profiles
  fixtures/build-repos.mjs               builds the git fixtures on demand (root commit, shallow clone, symlinks, odd paths)
  core-*.test.mjs (incl. core-catalog.test.mjs)  fakes.test.mjs  commands*.test.mjs  <provider>.test.mjs  integration.test.mjs
  live/*.live.test.mjs                   per-CLI contract tests; excluded from `npm test`
docs/
  decisions.md  spike/  parity/  measurements/  qualification/
```

No runtime dependencies. Node `>=22.19.0` (Node 18 support dropped, Node 20 excluded). Refreshed listings live under the state root (A7), never in the plugin directory. Core baseline: grok-build-plugin-cc 1.1.5 (PSModulePath set explicitly, zero-thread handle filter, printable-ASCII fast path, claim before prepare with release on failure, heartbeat before the job record) plus codex-plugin-cc's 12 s held-pipe wait, `trustsCleanExit`, job-body pruning and 16-character ids.

## A5. Adapter interface (frozen in S2.7)

```js
export default {
  id, binEnv,                              // "codex", "COUNCIL_CODEX_BIN"
  resolveLauncher(env, platform),          // {command, args, path, kind} | null; kind ∈ native | node-script | shim-native | shim-node; never via cmd.exe
  trustsCleanExit(launcher),               // true only for provider/launcher pairs qualified on Windows
  ownsProcess(row, job, platform),         // job-specific argv evidence via core hasFlagOperand (A5.1)
  maxLineBytes,                            // enforced by the core reader before parseEvent
  probe(launcher, env),                    // {version, loggedIn, models: [{id, efforts}]} for setup / models --refresh
  catalog,                                 // this provider's models.json entry
  checkRequest?(request, env),             // optional; throws UsageError (exit 2) for a flag the adapter has no tested mapping for, before any job record or spawn
  buildTurn(request),                      // request + {jobId, jobDir, env, launcher} → {args, env, stdin | promptFile, answerFile, readOnly, agent?, contractCarrier, threadId?}
  beforeTurn?(ctx), afterTurn?(ctx, outcome), // optional and independent; ctx {job, request, turn, home, env}; beforeTurn once before the spawn, afterTurn once after finalization when cleanup is verified (also on failure or cancel); no adapter uses them in this host's 1.0
  parseEvent(line, state),                 // {threadId?, textDelta?, toolStep?, completed?, fatal?, denied?, deniedAction?, deniedTotal?, incomplete?, structured?, edited?, failedCommand?, costUsd?} | null (deniedAction, deniedTotal: 2026-11-01, S7.1 fix X1)
  reviewPlan(gitInfo, request),            // gitInfo {root, target, collect()}; → {native: true, flags, stdin} | {native: false, template, schemaCarrier?, diff?} (the core collects and renders)
  finalizeReview({answerText, answerFile, structured, unreviewed}), // whole answer, never the 24 KiB preview → A5.2 result plus renderedText
};
```

`request` carries verb, provider, cwd, session, tier, model, effort, requestedEffort, thread record (or null), readOnly, text, review target, deadline, web, rounds and round; `buildTurn` also receives the caller's `env` and the resolved `launcher`, and `probe`/`checkRequest` receive `env`, so no adapter reads `process.env` (S2.8). The core supplies `hasFlagOperand(row, flag, value, job, platform, bins)`, which matches both `row.argv` (Linux, Windows) and `row.raw` (macOS `ps` output); `bins` are the provider's binary names, which qualify on macOS even when the recorded launcher was a node script.

### A5.1 Per provider

- **codex**: `exec --json -o <answer> -C <cwd> -s <sandbox> -m <model> -c model_reasoning_effort=<e> -c developer_instructions=<contract as a JSON string literal> -`; `exec resume <thread> --json -o <answer> -c sandbox_mode=<mode> -m <model> -c model_reasoning_effort=<e> -c developer_instructions=… -` with `read-only` on `reply` and the task sandbox on `task --thread`, spawned with `cwd` set because `resume` has no `-C`/`-s` (codex-plugin-cc `codex-companion.mjs:156-159`). Review: without focus `exec review <target flags> --json -o <answer> -c sandbox_mode=read-only -m <model> -c review_model=<model>`; with focus the same without target flags and with `<target sentence>\n\n<focus>` on stdin and a trailing `-`. MCP inheritance default `inherit`, `COUNCIL_CODEX_MCP=off` opt-in (A1 names its extra discovery calls); `setup` states the measured trade-off. Ownership: the answer-file operand. Events: `thread.started`, `turn.completed`, `turn.failed`, `error`, `item.completed` for `file_change` (edited) and `command_execution` (failed command); the answer is read from the answer file, not from deltas. Review `[P0]`/`[P1]` lines → BLOCKER/MAJOR; any other finding form, or no recognizable completed review, → `incomplete`.
- **gemini**: one NDJSON `user` message on stdin, contract prepended to the text (no rules flag); `--disable-slash-commands --print-timeout <deadline>s --sandbox`, and `--mode accept-edits` only on tasks (gemini-plugin-cc passed it on every turn; the change is recorded in S5.7); `--settings <job-dir>/settings.json` on every turn, which makes argv job-specific; its content starts from the user's global `permissions` lists in `~/.gemini/antigravity-cli/settings.json` (a session `deny`/`ask` array replaces the global one, so the lists are merged, as gemini-plugin-for-codex's `sessionSettings` does), then on read-only turns filters `allow` to `read_file(...)`/`read_url(...)` and adds the deny rules of A2, and on tasks keeps the global lists; `strict` tool permission is preserved; `--conversation <id>` on `reply` and `task --thread`. Unsuffixed family → `--model <family> --effort <clamped>`; suffixed id → the id alone, `--effort` only when equal. Reviews fill `prompts/review.md` or `prompts/adversarial-review.md` and pass `--json-schema <path>`. `setup` validates the tiers' resolved suffixed ids against `agy models`. Terminal result validation ported from gemini-plugin-cc: duplicate or missing `result`, `status !== "SUCCESS"`, empty response → exit 1; `print_timeout` → `incomplete` → exit 1; `denied_actions` non-empty, or the S1-recorded permission-denied tool-step signature (a `tool` step in state `ERROR` with `tool_info.error.type: "TOOL_ERROR"` and `Matches user-configured deny rule.`, after which the SUCCESS result carries no `denied_actions` key at all; the adapter treats an absent key and an empty array alike) → exit 10. The child's identity is recorded at spawn; agy's language-server child is part of the group to stop.
- **grok**: `--prompt-file <f> --output-format streaming-json --model <m> --effort <e> --no-auto-update` (absent from `grok --help`, accepted by 1.0.70 and used by both donors) `--always-approve --no-subagents --disallowed-tools <HOSTILE>`, `--disable-web-search` unless `--web`, `--rules <contract>` except on reviews, `--json-schema <inline>` on reviews, `--session-id <uuid>` new / `-r <id>` on `reply` and `task --thread`. Recipes ported whole from `recipes.mjs`: `--agent explore` on a fresh read-only session; default agent with RESUME_DENY after an edit turn; `--deny MCPTool(*)` read-only; `--deny "Bash(git push*)"`, `--deny "Bash(rm -rf *)"` on tasks; `compatEnv()` (skills, agents, hooks, MCP, rules off); the guard variables come from the core rule below. `buildTurn` returns `agent`, which the thread record persists. The reader fails a read-only turn closed when a FORBIDDEN tool is advertised. `trustsCleanExit` is always false: post-exit scan after every exit. Ownership: the prompt-file operand.

Every provider child receives all four guard variables, `COUNCIL_DEPTH`, `CODEX_COMPANION_DEPTH`, `GROK_BUILD_DEPTH` and `CLAUDE_PLUGIN_CODEX_DEPTH` (the three replaced plugins read the last three; gemini-plugin-cc has none), and admission refuses to start when any of them is set, so neither council nor a replaced plugin still installed during S8 can nest from any child. S2.4 tests the guard over all four.

### A5.2 Normalized review result

`{ verdict: approve|changes|incomplete, findings: [{severity, file, line, title, text, recommendation?}], coverage: {reviewed, unreviewed}, incomplete: reason|null }`. critical/high → BLOCKER, medium → MAJOR, low → MINOR; a native `needs-attention` verdict → `changes`. The native output is validated against the shared schema (grok-build's `reviewProblem`, dependency-free) before mapping. `coverage.unreviewed` comes from the core's collection omissions, never from model output. Exit 10 when findings exist, when coverage is incomplete, when the output is malformed or missing, or when a verdict of approval accompanies findings; malformed output never becomes an approval.

Diff collection (gemini, grok): `--base <ref>` collects `<oid>...HEAD` plus the working tree and untracked files; `--uncommitted` the working tree and untracked files only, with no fallback to a default branch; `--commit <sha>` resolves `<sha>^{commit}` (exit 2 on failure) and collects `git diff-tree --no-commit-id -p --root --no-color --no-ext-diff <oid>` for a non-merge commit and `git diff <oid>^1 <oid>` for a merge (first-parent semantics, stated in the review label); a shallow clone whose parent is missing exits 2, never a clean review. Paths come from `-z` output; symlinks contribute their link text through `lstat`/`readlink` and regular files are read with `O_NOFOLLOW`, so an untracked symlink to an outside file never leaks its target. All paths share the size limit (`omitted` list), symlink and path handling. Codex passes the target flags to `exec review`.

## A6. Fan-out

1.0 has no coordinating process. Claude issues one background `ask` per provider in a single response, each with its own `--request-id`, the same brief, that provider's `consult` tier unless the user chose otherwise, then summarizes side by side and reports disagreements as disagreements. Follow-ups use `reply --thread <job>`, never `--last`. A coordinating `panel` verb is a 1.1 candidate only with: repeatable member specs, a parent job owning request id, `wait`, `cancel` and digest, every child identity persisted before any spawn, replay from the manifest, parent cancel covering unfinished children while member cancel spares siblings, signal handling and pruning hoisted out of per-member turns, per-member outcomes, deterministic digest with no extra synthesis call. Cross-critique is also 1.1.

## A7. State and recovery

1. Root `~/.council/` (override `COUNCIL_HOME`) with `jobs/`, `claims/`, `threads/`, `catalog/`, `trash/`. Each record carries realpath(cwd) and the Claude session. Git root is resolved lazily, only for reviews: `ask`, `reply`, `wait` and `cancel` start no git process.
2. `--last`, bare `wait`, bare `cancel` are scoped to `job.cwd === realpath(cwd)` and `job.session === (session ?? null)`, both conditions; a named job id is found across sessions.
3. Claim key = provider + session + realpath(cwd) + request id. Thread locks under `claims/<provider>/<threadId>`; every thread lookup, history query, blocking query and metadata access is namespaced by provider, so two providers reporting the same native thread id never share claims, history, inheritance or cancellation. A native thread is never adopted across workspaces.
4. Request lifecycle: claim → prepare → tombstone → run. A request id is looked up before anything else: an existing reservation or tombstone recovers the original provider binding and replays, so no implicit selector or catalog change can redirect a retry. The request fingerprint is taken over the raw inputs (verb, provider, text, flags other than the output, scope and timing flags `--json`, `--session`, `--request-id`, `--timeout`, `--deadline`, `--inactivity-timeout`) before thread, tier or catalog resolution, so changed input under the same request id exits 2 rather than replaying, and a retry with longer timers replays. Before any provider is resolved, the call takes one provider-neutral binding keyed by session + realpath(cwd) + request id with an exclusive create (`claims/requests/scope-<hash>.json`); it stores the fingerprint and, once resolved, the provider and job id. A second caller waits on that binding and replays its job, or exits 2 on a different fingerprint; a binding whose call failed before its tombstone is released with its job claim (S2.9). A claim that fails before preparation completes is released (same `--request-id` may run again). The tombstone `claims/requests/<id>.json`, written after preparation succeeds, carries the fingerprint and is immutable: a replay prints or awaits the first result; with the job body pruned it returns `result expired` (exit 1) without starting a CLI. Concurrent identical requests start one CLI.
5. Cancel (`cancelManaged`): while the owner companion is live, `cancel` only writes the marker and the owner stops its child (snapshot the owned descendants, SIGTERM the process group `-pid`, then SIGKILL; `taskkill /T /F` on Windows) and finalizes; when the owner is gone, `cancel` stops the child through a creation-timestamp-verified identity, marks the job stopped and releases claims. Never signals a live companion or an unverified pid. On macOS the process snapshot includes `pgid`, so a group member reparented to pid 1 is still found: the child's identity is recorded as the group leader right after the spawn, and the identities (pid + creation time) of its owned descendants are persisted in the job record at every heartbeat and every stop snapshot. While the recorded leader is alive with its recorded creation time, a member of its group born at or after that start is owned (`lstart` parsed to epoch seconds); once the leader is gone, a group member is owned only when its pid and creation time match a persisted descendant identity. Any other member is never signalled and is reported as unverified, so cleanup reads as unconfirmed rather than gone (S2.9).
6. Thread records `threads/<provider>-<threadId>.json`: provider, native thread id, cwd, model, effort, tier, round counter, rounds budget, Grok `agent`. Kept apart from job bodies; never pruned.
7. Pruning (from codex-plugin-cc: rename into `trash/`, then remove) deletes finished job bodies past 100; never a running, lost, cleanup-pending or claim-holding job.
8. A lost or cleanup-pending job blocks its thread until `cancel` confirms; `thread locked` after 12 s of held pipes on a clean exit; next step is a new `ask`.
9. `--request-id` on every review, task, deep, xhigh, max, ultra call; a repeat never starts a second CLI.

## A8. Platform policy and release gate

macOS and Windows qualified before release; Linux optional, never blocking. Windows: never launch through cmd.exe; identity by the adapter's ownership evidence; no process query after a clean exit only for qualified provider/launcher pairs; PowerShell scans inline (no `.ps1` on disk) with PSModulePath set.

Release gate 1.0: Codex and Grok qualified on macOS and Windows; Gemini qualified on macOS; on Windows the agy path is qualified, or `setup` reports Gemini unsupported there and `ask`/`reply`/`review`/`task --to gemini` exit 2 on `win32` with that message (gemini-plugin-cc never ran on Windows, so no parity is lost).

---

# Part B. Procedure

## Dependency map

| Step | Needs | Produces | Can run with |
|---|---|---|---|
| S0 Scaffold | this plan | loadable plugin skeleton, test runner, command generator | — |
| S1 Spike and catalog | S0; the three CLIs installed and logged in | `docs/spike/*`, review schema, fakes and `fakes.test.mjs`, `tiers.json`, `models.json`, `core/catalog.mjs`, `core/tiers.mjs`, `core-catalog.test.mjs` | — |
| S2 Core port | S1 | provider-neutral core; `contract.md`; review templates; every verb wired against the null adapter; frozen contracts | — |
| S3 Codex adapter | S2 | `providers/codex.mjs`, parity record, live record | S4, S5 |
| S4 Grok adapter | S2 | `providers/grok.mjs`, parity record, live record | S3, S5 |
| S5 Gemini adapter | S2 | `providers/gemini.mjs`, parity record, live record | S3, S4 |
| S6 Integration, skill, commands, docs, measurement | S3, S4, S5 merged | `integration.test.mjs`, SKILL.md, 11 commands, README, CHANGELOG, framing record | — |
| S7 Qualification and release | S6 | qualification records, `v1.0.0` | — |
| S8 Migration | S7 | `council` installed, three plugins removed; handbook row | — |

Sources to port from (installed copies, read-only):

| Short name | Path |
|---|---|
| CODEX | `~/.claude/plugins/cache/gphcod-codex/codex/2.3.2` (github.com/gphcod/codex-plugin-cc `v2.3.2`) |
| GROK | `~/.claude/plugins/cache/gphcod-grok-build/grok-build/1.1.5` (github.com/gphcod/grok-build-plugin-cc `v1.1.5`) |
| GEMINI | `~/.claude/plugins/cache/gemini-plugin-cc/gemini/2.1.0` (github.com/gphcod/gemini-plugin-cc `gemini--v2.1.0`) |

## S0. Scaffold

Preconditions: clean `main` of github.com/gphcod/codex-agy-grok-plugin-for-claude; Node 22.19.0 (`node --version`).

Actions:

1. **S0.1 Licensing.** Read `CODEX/LICENSE` and `CODEX/NOTICE` (Apache-2.0, OpenAI copyright, gphcod fork). Check the GROK and GEMINI repositories' license files (`gh api repos/gphcod/grok-build-plugin-cc/license`, same for gemini-plugin-cc). Write `LICENSE` (Apache-2.0) and `NOTICE` naming the three sources, their versions, commits and licenses. A source without a license is not copied verbatim; its behaviour is reimplemented and the NOTICE says so.
2. **S0.2 Package and test runner.** `package.json`: `"type": "module"`, `"private": true`, `"engines": {"node": ">=22.19.0"}`, scripts `test` → `node scripts/run-tests.mjs`, `test:live` → `node scripts/run-tests.mjs --live`, `gen` → `node scripts/gen-commands.mjs`, `gen:check` → `node scripts/gen-commands.mjs --check`, `measure` → `node scripts/measure.mjs`. No dependencies. `scripts/run-tests.mjs`: default discovery is `tests/**/*.test.mjs` excluding `tests/live/**` and every `*.live.test.mjs`; `--live` selects only `tests/live/**/*.live.test.mjs`; `--ratio` counts non-blank lines of `tests/core-*.test.mjs` divided by `plugins/council/scripts/lib/core/*.mjs`, prints the ratio and exits 1 below 1.5; the runner spawns `node --test <files>` itself, so no shell globbing is needed on Windows. `tests/runner.test.mjs` asserts the default and live sets are disjoint and that a live file name never matches the default pattern. `scripts/measure.mjs` is a stub exiting 0 until S6.5. `.gitignore`: `node_modules/`, `tests/fixtures/repos/`, `.DS_Store`.
3. **S0.3 Manifests.** `.claude-plugin/marketplace.json` with `name` `gphcod-council`, owner `gphcod`, one plugin `council` at `./plugins/council`. `plugins/council/.claude-plugin/plugin.json` with `name` `council`, `version` `0.1.0`, description, author `gphcod`, homepage this repository.
4. **S0.4 Entry stub.** `plugins/council/scripts/council.mjs` exports `main(argv, env, io)` and, when run directly, calls it with the process values. The stub parses the verb, prints usage with exit 2 for everything not implemented, and implements `setup` as far as resolving the three binaries on PATH (`which`/`where.exe` semantics in Node, no spawn).
5. **S0.5 Generator.** `scripts/templates/command.md` holds the command body with placeholders `{{verb}}`, `{{description}}`, `{{argument-hint}}`, `{{background-rule}}`, `{{fixed-flags}}`. `scripts/gen-commands.mjs` writes the 11 files of A3.4 under `plugins/council/commands/`; `--check` regenerates in memory, compares byte for byte, exits 1 on drift with the file names. Frontmatter per file: `description`, `argument-hint`, `disable-model-invocation: true`, `allowed-tools: Bash(node:*)`. Body: the slash-command form of A3.1 (no `--` on argv; `$ARGUMENTS` inside the heredoc), plus the CODEX `commands/ask.md` delimiter rule.
6. **S0.6 Skill stub.** `plugins/council/skills/council/SKILL.md` with frontmatter `name: council` and a two-line description; body is written in S6.
7. **S0.7 Tests.** `tests/commands.test.mjs` runs `gen-commands.mjs --check`; `tests/skill-size.test.mjs` asserts `Buffer.byteLength(SKILL.md) <= 3000`; `tests/manifests.test.mjs` parses both manifests and checks `name` values.
8. **S0.8 Docs skeleton.** `docs/decisions.md` (header and the S0 entry), empty `docs/spike/`, `docs/parity/`, `docs/measurements/`, `docs/qualification/` with `.gitkeep`.

Verification:

```bash
npm test
node plugins/council/scripts/council.mjs setup </dev/null
node plugins/council/scripts/council.mjs ask --to codex -- hello </dev/null
```

The first passes (4 test files); the second prints the three binary paths; the third prints usage and exits 2. **[user]** optionally: `REPO="$PWD"` in the repository root, then from a scratch directory `claude --plugin-dir "$REPO/plugins/council"` and `/council:setup`.

Gate: all three checks pass; commit `S0: scaffold`.

## S1. Capability spike and catalog

Preconditions: S0; `codex`, `agy`, `grok` on PATH and logged in (`codex login status`, `agy` once interactively, `grok` once interactively). Each probe writes into a scratch directory outside the repository; only the records and captured listings go under `docs/spike/`.

Record template `docs/spike/<cli>.md`, one per CLI, with these headings and nothing else: Version and launcher; Headless invocation (exact argv); Stdin shape; Event names seen (start, thread/session id, text delta, tool step, denied, result, error); Resume form; Read-only controls and their evidence; Effort rules (accepted, rejected, error text); Model listing (command, raw output file); Process table (argv as `ps` shows it, child processes, pgid); Cancel behaviour (signal, exit code, time to exit, orphans); Timeouts; Windows launcher kind (filled in S7 if not available now); Surprises.

Actions:

1. **S1.0 Shared schema.** Copy `GEMINI/schemas/review-output.schema.json` to `plugins/council/schemas/review-output.schema.json`. During S1 only, compare it with `GROK/schemas/review-output.schema.json` (structurally identical today; if they differ, keep the superset and record the difference) and commit the result as `tests/fixtures/review-output.reference.json` with a provenance comment naming both sources and commits. `tests/schema.test.mjs` compares the repository schema with that committed fixture and never reads an installed plugin cache, so the suite runs on any machine.
2. **S1.1 Codex probes.**
   - `codex --version`; `codex login status`.
   - `codex debug models > docs/spike/codex-models.json`; note the fields used: id, `supported_reasoning_levels`.
   - Minimal turn: `printf 'Reply with the single word pong.' | codex exec --json -o <tmp>/answer.md -C <tmp> -s read-only -m gpt-6.1-sol -c model_reasoning_effort=low -`; save the event stream; record `thread.started`, `turn.completed`, `turn.failed`, `error`, `item.completed` as CODEX `lib/reader.mjs:50-74` consumes them, and confirm the answer lands in the `-o` file.
   - Resume: `codex exec resume <thread_id> --json -o <tmp>/answer2.md -` with a one-line follow-up.
   - Review, both routes, in a fixture repository with one uncommitted change: unfocused `codex exec review --uncommitted --json -o <tmp>/r1.md -c sandbox_mode=read-only`; focused `printf '<target sentence>\n\nfocus text' | codex exec review --json -o <tmp>/r2.md -c sandbox_mode=read-only -` (no target flags). Record the `[P0]`/`[P1]` output form and the exit-2 text when flags and a prompt are combined.
   - Effort: `-c model_reasoning_effort=ultra` on `gpt-6-luna` and on `gpt-6.1-sol`; record the outcome and any error text. (Recorded 2026-10-31: both accepted, exit 0; the CLI does not validate the effort against the catalog, see A2.)
   - MCP: `CODEX_COMPANION_MCP=off` equivalent: run `codex mcp list --json` and count how many CLI invocations CODEX `lib/tools.mjs:30-41` makes for one read-only turn with servers configured (expected two) and without (expected one). Record the count; A1 permits it.
   - Process table during a turn: `ps -axo pid,ppid,pgid,lstart,command | grep '[c]odex'`; confirm the `-o <answer>` operand is visible.
   - Cancel: start a long prompt in the background, `kill -TERM -- -<pgid>`, record exit code and time; check for orphans after 5 s.
3. **S1.2 agy probes.** Build the stdin message exactly as GEMINI `lib/agy.mjs` writes it (read `buildLaunchDescription` and the stdin write in `runAgy`); use `--settings <tmp>/settings.json` whose `permissions.deny` array is the A2 read-only list.
   - `agy --version`; `agy models > docs/spike/agy-models.txt`.
   - Minimal read-only turn with `--model gemini-4-argon --effort low --sandbox --disable-slash-commands --print-timeout 120s`; record event names, `result` fields (`conversation_id`, `status`, `denied_actions`, `finished_reason`, `structured_output`).
   - Resume with `--conversation <id>`.
   - Effort matrix, four cases, record status and text: `--model gemini-3.8-flash-low --effort high` (expect "invalid model selection"); `--model gemini-3.8-flash-high --effort high` (expect success); `--model gemini-3.8-flash --effort high` (success); `--model gemini-3.8-flash --effort xhigh` and `--effort max` (expect error).
   - Web tool name and decision rule: a read-only turn asking the model to search the web for a fixed string and to name the tool it used; record the tool step name from the stream. If a tool step appears, add `<name>(*)` to the deny list and repeat. If, and only if, the repeat is blocked (shown by `denied_actions` or a failed tool step), read-only turns deny `<name>(*)` by default and omit it under `--web`; otherwise Gemini `--web` exits 2. Log the outcome in `docs/decisions.md`.
   - Denial signature: a read-only turn asking the model to create a file; confirm no file appears and record the exact tool-step error shape (gemini-plugin-cc observed a failed tool step with `denied_actions` left empty). This shape becomes the adapter's `denied` signal.
   - `--json-schema <path>` with the shared schema on a tiny review prompt; record where `structured_output` appears.
   - Process table during a turn: confirm `--settings <path>` is visible in argv and list agy's child processes (language server) with their ppid and pgid.
   - Cancel as in S1.1; record whether the language-server child dies with the group and whether it is reparented to pid 1 when agy alone is killed.
   - `--print-timeout 5s` on a long prompt: record exit code (expected 0) and `finished_reason: "print_timeout"`.
   - Settings merging (A5.1): read `~/.gemini/antigravity-cli/settings.json`; with a global `deny` entry present and a session `--settings` file carrying a different `deny` array, confirm the global entry no longer applies (the session array replaces it); confirm a merged file that repeats the global entry restores it. Record the result; S5.2 depends on it.
4. **S1.3 Grok probes.**
   - `grok --version`; `grok models > docs/spike/grok-models.txt`; `grok --help > docs/spike/grok-help.txt`.
   - Read-only turn: prompt file plus the explore recipe from GROK `lib/recipes.mjs:3-41` (`--agent explore --always-approve --no-subagents --disable-web-search --disallowed-tools <HOSTILE> --deny MCPTool(*)`), `--output-format streaming-json --model grok-4.7 --effort low --no-auto-update --session-id <uuid>`; record event names, the advertised tool catalogue, the session confirmation event and the `end_turn` stop reason.
   - Resume with `-r <session>`.
   - Effort: `--effort xhigh` (success) and `--effort max` (expect "unknown effort level"); record text.
   - `--json-schema '<inline json>'` on a review prompt; record where the structured output appears.
   - Process table: confirm `--prompt-file <path>` is visible.
   - Cancel as in S1.1.
5. **S1.4 Fakes.** Write `tests/fixtures/fake-codex.mjs`, `fake-agy.mjs`, `fake-grok.mjs`. Each fake validates the complete launch contract before emitting anything: argv (including sandbox, recipe, model, effort flags), environment (the four A5.1 guard variables, Grok `compatEnv` variables), stdin bytes, and the prompt, settings or schema file it is pointed at; an unexpected invocation exits 99 with the mismatch on stderr. Each fake also answers its version, login and model-listing commands from the captured files in `docs/spike/`. The scenario is chosen by `COUNCIL_FAKE_SCENARIO`: `ok`, `resume`, `denied`, `effort-error`, `review-findings`, `review-malformed`, `slow`, `hold-pipes`. Captured streams are stored with provenance (which probe produced them); `review-malformed` and `hold-pipes` are labelled synthetic mutations. `tests/fakes.test.mjs` spawns every fake in every scenario and asserts exit codes, held-pipe timing and event shapes against the recorded spike streams.
6. **S1.5 Static catalog and tiers.** `plugins/council/tiers.json` exactly from the A2 table, `{codex: {consult: {model, effort}, exec: …, deep: …}, grok: …, gemini: …}`. `plugins/council/models.json` lists every captured model id with its own effort list, plus aliases and the Gemini family rule:
   ```json
   {
     "codex":  { "models": {"gpt-6.1-sol": ["low","medium","high","xhigh","max","ultra"], "gpt-6-luna": ["low","medium","high","xhigh","max"], "…": []},
                 "aliases": {"sol":"gpt-6.1-sol","terra":"gpt-6.1-terra","luna":"gpt-6-luna","astra":"gpt-6-astra"}, "sharedEnum": ["low","medium","high","xhigh","max"], "passThrough": ["ultra"] },
     "gemini": { "families": {"gemini-4-argon": ["low","medium","high"], "gemini-3.8-flash": ["low","medium","high"]},
                 "aliases": {"argon":"gemini-4-argon","flash":"gemini-3.8-flash"}, "suffixed": true, "route": ["gemini-"] },
     "grok":   { "models": {"grok-4.7": ["low","medium","high","xhigh"], "grok-4.7-build-fast": ["low","medium","high","xhigh"], "grok-4.6": ["low","medium","high","xhigh"], "grok-4.5": ["low","medium","high","xhigh"]},
                 "aliases": {"4.7":"grok-4.7","4.6":"grok-4.6","build-fast":"grok-4.7-build-fast"} }
   }
   ```
   The recorded facts from S1.1–S1.3 win over this draft.
7. **S1.6 `core/catalog.mjs` and `core/tiers.mjs`.** Written directly under `plugins/council/scripts/lib/core/`. Functions: `parseModelListing(provider, rawText)` parsing the three recorded listing formats; for Gemini it indexes both each suffixed id (`gemini-4-argon-high` → `["high"]`) and its family (`gemini-4-argon` → `["low","medium","high"]`). `loadCatalog(home, provider)` merges `models.json` with `<home>/catalog/<provider>.json` when present. `resolveModel(provider, input, catalog) → {id, verified, alias}`. `resolveEffort(provider, id, requested, catalog) → {effort, requested, clamped}` implementing A3.3 with identical rules for static and refreshed catalogs: downward clamp against the model's own list; Gemini suffix parsed without rewriting the id, conflict → `UsageError`; codex `ultra` passes through only when the model's list has it, otherwise `UsageError`; unknown model → pass through, `verified: false`, no clamp. `refreshCatalog(home, provider, probe)` writes `<home>/catalog/<provider>.json` as `{updatedAt, models}`. `resolveTier(provider, tier, overrides, catalog)`. `tests/core-catalog.test.mjs` (named `catalog.test.mjs` until S2.8; it tests core modules, so it counts toward `--ratio`) uses the recorded listings and a stub probe, covering at least: `gemini --effort xhigh` → high clamped; `gemini-4-argon-high --effort medium` → UsageError; `gemini-4-argon-high` alone → id unchanged, effort high; `gemini-4-argon` verified against the listing; `grok --effort max` → xhigh clamped; `grok --effort low` → low; `codex --effort ultra` on `gpt-6-luna` → UsageError with the static catalog alone; `codex --effort ultra` on `gpt-6.1-sol` → pass-through; unknown id → `verified: false`; refresh honours `COUNCIL_HOME`.

Verification:

```bash
npm test
```

passes, including `schema.test.mjs`, `fakes.test.mjs` and `core-catalog.test.mjs`.

Gate: three spike records complete with every heading filled; `docs/decisions.md` has the Gemini `--web` decision, the agy denial signature, the Codex MCP invocation count and any A2 corrections; fakes cover the eight scenarios and their probe commands; commit `S1: spike and catalog`.

## S2. Core port

Preconditions: S1.

Module mapping (source → `plugins/council/scripts/lib/core/`), with the change each needs:

| Source | Core module | Change |
|---|---|---|
| GROK `lib/args.mjs` (`parseArgv`, `splitLeading`) | `args.mjs` | `SPEC.value` gains `to`, `commit`; `SPEC.bool` gains `uncommitted`, `adversarial`, `refresh`, `web`; verbs list from A3.2; `splitLeading` kept so slash commands parse leading options out of the heredoc text |
| GROK `grok.mjs:46-105` (`readStdin`, `readText`, `splitReply`), `grok.mjs:308-317` (control-verb stdin tokens) | `stdin.mjs` | unchanged 10 s deadline; literal mode only when argv had `--` |
| GROK `lib/jobs.mjs` + CODEX `lib/jobs.mjs:56,109-124` | `jobs.mjs` | root `COUNCIL_HOME` → `~/.council`; 16-character ids on both routes (`randomBytes` for fresh jobs, hash of the A7.3 key sliced to 16 for request ids); job record gains `provider`; `candidates()` filters by cwd and session together (A7.2); `prune()` from CODEX (trash rename, then remove; A7.7); `claimRequest`/`markRequestPrepared`/`releaseRequest` per A7.4 with the fingerprint in the tombstone and `result expired` when the body is gone; `latestOnThread`, `blockingJob`, `onThread` take the provider |
| GROK `lib/claims.mjs` + CODEX `lib/claims.mjs` (`claimHeld`) | `claims.mjs` | paths `claims/<provider>/<threadId>`; `claimHeld(home, job)` covers owned threads and unknown claims |
| GROK `lib/jobs.mjs` beat functions, `lifecycle.mjs` `BEAT_MS` | `heartbeat.mjs` | extracted, unchanged timing |
| GROK `lib/reader.mjs` | `reader.mjs` | generic: line splitting, `maxLineBytes` from the adapter, delegates each line to `adapter.parseEvent`, latches the first fatal so a later success event cannot clear it; the Grok FORBIDDEN check moves to the grok adapter |
| GROK `lib/lifecycle.mjs` + CODEX `lib/lifecycle.mjs:25,76-78,158-164,199-264,290-295,340` + GEMINI `lib/process.mjs:154-186` | `lifecycle.mjs` | `runManagedTurn` takes the adapter; feeds `turn.stdin` or points at `turn.promptFile`; `trustsCleanExit(launcher)` replaces the constant; 12 s `PIPE_WAIT_MS`, unattributed-pipe handling and `thread locked` from CODEX; stop path snapshots owned descendants, signals the process group, escalates to SIGKILL; `cancelManaged` unchanged; thread record update after each turn |
| GROK `lib/execution.mjs` | `execution.mjs` | `ownsExecution` delegates to `adapter.ownsProcess` and exports `hasFlagOperand` over `row.argv` and `row.raw`; darwin `ps` adds `pgid=`; the empty-command-line binary list covers `codex`, `agy`, `grok`, `node` with `.exe` variants; depth guard over the four A5.1 variables, read on admission and set on every child; PowerShell strings inline |
| GROK `lib/output.mjs`, `lib/answer.mjs` | `output.mjs` | start line, footer and `--json` exactly per A3.4; 24 KiB cap |
| GROK `lib/launcher.mjs:15-30,60-63` + CODEX `lib/launcher.mjs:20-31` | `launcher.mjs` | generic resolver used by adapters: `binEnv`, PATH, Windows `.cmd` shim → JS entry or node-shebang script, vendor `.exe` lookup, `kind` enum of A5 |
| CODEX `lib/git.mjs` (`reviewTarget`) + GROK `lib/review.mjs` (collector, `-z` status, `lstat`/`readlink`, `O_NOFOLLOW` `readRegular`, `unquotePath`, `bound`, `reviewProblem`, `renderReview`) + GEMINI `lib/git.mjs:27,354-365` (`gitPaths`, `buildCollectionGuidance`) | `git.mjs`, `review.mjs` | lazy repo root; `--base` adds working tree and untracked files to `<oid>...HEAD`; `--uncommitted` with no default-branch fallback; `--commit` via `diff-tree --root`; validation before mapping; severity map and A5.2 exit rules; any copied subprocess call uses the core git runner, no import from GEMINI `process.mjs` |
| GROK `grok.mjs` (`requestKey`, `replay`, `runTurn`, thread resolution, round and settings inheritance, finished-result replay, `wait`/`cancel` dispatch) | `council.mjs` + `lifecycle.mjs` | ported as the entry's orchestration; fingerprint computed over raw inputs before resolution (A7.4) |
| S1.6 | `catalog.mjs`, `tiers.mjs` | already in place |
| GROK `lib/fs.mjs` | `fs.mjs` | unchanged |

Actions:

1. **S2.1 Null adapter and fake child.** `tests/fixtures/null-adapter.mjs` implements A5 by spawning `node tests/fixtures/fake-child.mjs`. The adapter has profiles selected by environment: id discovery `preassigned` (Grok-like, id chosen before spawn) or `discovered` (Codex/Gemini-like, id arrives in an event); input `stdin` or `prompt-file`; output `stream` or `answer-file`. The child obeys `COUNCIL_FAKE_SCENARIO`: `ok`, `slow`, `hold-pipes`, `exit-nonzero`, `huge-line`, `fragmented-frames`, `no-completion`, `fail-then-success`. The entry loads this adapter only when `COUNCIL_TEST_NULL_ADAPTER=1`. Every core test runs through `main()` with a temporary `COUNCIL_HOME`.
2. **S2.2 Port args, stdin, fs, output, launcher.** Tests: option arity; `--` literal text; `splitLeading` on heredoc text with leading flags, with a literal `--`, with multiline text and with a delimiter collision; stdin deadline (fake stdin that never closes → exit 2 after the deadline, shortened through `COUNCIL_STDIN_DEADLINE_MS`); start line and footer for every A3.4 field combination; `--json` shape; 24 KiB cap producing `full: <file>`; launcher resolution for PATH, `binEnv`, missing binary, and on `platform: "win32"` with fixture directories: `.cmd` with a `.js` entry, `.cmd` with an extensionless node-shebang script, `.cmd` without a JS entry (throws), vendor `codex.exe`.
3. **S2.3 Port jobs, claims, heartbeat.** Tests: both id routes produce 16 characters; `COUNCIL_HOME` override; claim key includes provider (a Grok and a Codex claim with the same request id coexist); two providers with the same native thread id keep separate claims, history, inheritance and cancellation; `/tmp` and `/private/tmp` map to one claim through a temporary symlink created by the test (junction on Windows); `--last` ignores another session's job and another cwd's job; a named id resolves across sessions; prune moves finished bodies past 100 through `trash/` and never a running, lost, cleanup-pending or claim-holding job; thread record survives prune; claim released when prepare throws (same id runs again); tombstone after prepare makes a replay return the first result, or `result expired` after prune, without spawning (assert the fake child's spawn counter); changed input under the same request id exits 2; two concurrent identical requests spawn one child; a replay of `reply --last --request-id <id>` after another provider's job has become the latest, or after the catalog or tiers changed, recovers the original provider and job and spawns nothing.
4. **S2.4 Port reader, execution, lifecycle.** Tests: `maxLineBytes` exceeded → turn fails closed before `parseEvent`; fragmented frames reassemble; missing completion → exit 1; a fatal latched before an apparent success stays fatal; `trustsCleanExit` false → post-exit scan runs (fake snapshot); held pipes beyond 12 s on a clean exit → `thread locked`; heartbeat before the job record; cancel with the owner live only writes the marker and the owner stops the child; cancel with the owner gone verifies identity by creation timestamp, stops, marks stopped, releases; cancel with a mismatched timestamp refuses; a group member reparented to pid 1 is found through `pgid` on darwin; depth guard refuses when any of the four A5.1 variables is set, and every spawned child carries all four; `--deadline` and `--inactivity-timeout` start cleanup and exit 1; `wait --timeout` returns 20 and the job continues; discovered-id profile: claim taken on discovery before the id is published, and a claim collision during discovery fails the turn. `platform: "win32"` tests with a fake PowerShell runner: PSModulePath injected, `ThreadCount=0` rows filtered, `=ascii`/`xhex`/`-` decoding, self-identity tick comparison, kill refused on timestamp or command-line mismatch.
5. **S2.5 Port git and review; write contract and templates.** `tests/fixtures/build-repos.mjs` builds, on demand: a root-commit repository, a shallow clone of a three-commit repository, a repository with a symlink change, an untracked symlink to a file outside the repository, and a renamed file with a space. Write `plugins/council/contract.md` from `CODEX/contract.md` with a provider-neutral outer tag, and `prompts/review.md`, `prompts/adversarial-review.md` from GEMINI's templates with placeholders for diff, focus and coverage note, plus an `interpolate()` helper that fails on an unresolved placeholder. Tests: `--commit <root>` yields a patch; `--commit` of a merge yields the first-parent diff with the label; `--commit` of the shallow clone's boundary commit, whose parent is missing, exits 2 and never a root-style patch; a bad ref → exit 2; `--base` includes working tree and untracked files, `-z` paths and symlink link text; the untracked outside symlink contributes link text and never the target's contents; `--uncommitted` excludes committed changes and never falls back to a default branch; size limit produces `omitted` and `coverage.unreviewed`; validation rejects `{verdict:"approve"}` without the schema's required fields; findings with an approval verdict → `changes`, exit 10; `needs-attention` without findings → exit 10; unrecognized output → `incomplete`; templates interpolate and reject a missing placeholder.
6. **S2.6 Entry wiring.** `council.mjs`: parse verb and options (`splitLeading` on heredoc text when argv had no `--`; control-verb stdin tokens) → when `--request-id` is given, look the request up first: an existing reservation or tombstone recovers the request's original provider binding and replays it (print or await the first result, or `result expired`) before any implicit selector (`--last`), catalog setting or adapter availability is re-evaluated; only a fresh request continues → resolve provider (`--to`, or the thread or job record on `reply`/`task --thread`; a conflicting `--to` exits 2) → compute the request fingerprint over the raw inputs → load `./lib/providers/<provider>.mjs` by `fs.existsSync` plus dynamic `import()`; an absent file exits 2 with `provider <p> not available in this build` → resolve tier, model, effort → admit (`COUNCIL_DEPTH`, claims, thread lock) → `runManagedTurn(adapter, request)` → output. `wait` loads no adapter. `cancel` and any recovery path that needs ownership inspection (owner-death cancellation, the post-exit scan of a lost job) load the recorded provider's module for `ownsProcess` only, bypassing probes and `buildTurn`, and start zero provider processes. `models` and `setup` iterate `["codex","gemini","grok"]` (or `[--to]`), load each adapter that exists and report the others as not available in this build. S3–S5 add only their provider module, tests and records; they never edit `council.mjs`.
7. **S2.7 Freeze.** Add `docs/decisions.md` entry "S2 freeze": the A5 object with its return shapes (also written as JSDoc typedefs in `core/types.mjs`), exit codes, start line and footer grammar, `--json` shape, normalized review result, state layout and the dynamic provider registry are frozen; later changes need a decisions entry and a review by one of the three models. Verify `contract.md` and both templates exist and contain no unresolved placeholder.

Verification:

```bash
npm test
node scripts/run-tests.mjs --ratio
node plugins/council/scripts/council.mjs ask --to codex -- hi </dev/null
COUNCIL_TEST_NULL_ADAPTER=1 COUNCIL_HOME="$(mktemp -d)" node plugins/council/scripts/council.mjs ask --to null -- hi </dev/null
```

The first two pass (ratio ≥ 1.5); the third exits 2 with `provider codex not available in this build`; the fourth prints the fake child's answer and a `council null ok` footer.

Gate: all four pass; commit `S2.7: freeze` closes the step.

## S3. Codex adapter

Preconditions: S2. Sources: CODEX `scripts/codex-companion.mjs` (turn construction, `SANDBOX` per verb, review routes at lines 150–154), `lib/tools.mjs` (MCP policy, `CODEX_COMPANION_MCP` → `COUNCIL_CODEX_MCP`), `lib/git.mjs` (`reviewTarget`), `lib/setup.mjs` (`extractModels`), `lib/reader.mjs:50-74` (events), `lib/answer.mjs:16` (`[P0]`/`[P1]` scan), `lib/launcher.mjs` (qualified kinds). Not ported: CODEX `lib/requests.mjs`, `jobs.mjs`, `claims.mjs`, `lifecycle.mjs`, `execution.mjs` (the core has them).

Actions:

1. **S3.1 Adapter skeleton.** `providers/codex.mjs`: `id: "codex"`, `binEnv: "COUNCIL_CODEX_BIN"`, `resolveLauncher` through the core launcher, `trustsCleanExit` true for exactly the launcher kinds CODEX qualified (read its `launcher.mjs` and `lifecycle.mjs`), `ownsProcess` via `hasFlagOperand(row, "-o", answerFile, …)`, `maxLineBytes` from the CODEX reader, `probe` running `--version`, `login status` and `debug models` (via `extractModels`).
2. **S3.2 buildTurn.** `ask` → `exec --json -o … -C cwd -s read-only`; `reply` → `exec resume <thread>` with `-c sandbox_mode=read-only`; `task` → `exec -s <rescue sandbox>` or `exec resume -c sandbox_mode=<rescue sandbox>`, the CODEX `rescue` mode; `review` → the two routes of A5.1 (flags without focus; target sentence plus focus on stdin with `-` and no flags). Contract via `-c developer_instructions=<contract text>`. Model and effort from the core resolution; `ultra` passed through. `COUNCIL_CODEX_MCP=off` adds the `tools.mjs` arguments.
3. **S3.3 parseEvent and finalizeReview.** `parseEvent`: `thread.started` → threadId; `turn.completed` → completed; `turn.failed`, `error` → fatal; `item.completed` `file_change` → edited; `item.completed` `command_execution` with non-zero exit → failedCommand. `finalizeReview` reads the answer file, scans `[P0]`/`[P1]` lines into findings; any other finding form or no recognizable completed review → `incomplete` (exit 10).
4. **S3.4 Tests against fake-codex.** Every verb; `ask → task --thread → reply → task --thread` asserting sandbox and resume arguments on every transition; both review routes with every target; review with findings → 10; review malformed → 10 with `incomplete`; `COUNCIL_CODEX_MCP=off` with the fake answering `mcp list --json`: assert the total CLI invocation count equals one model process plus the discovery calls recorded in S1.1; `ultra` on `gpt-6.1-sol` passes through and on `gpt-6-luna` exits 2; `--adversarial` and `--web` exit 2 before any spawn; ownership match and mismatch rows on `row.argv` and `row.raw`.
5. **S3.5 Live tests.** `tests/live/codex.live.test.mjs`: version, `debug models` shape, one `ask` at `--effort low`, one `reply`, one unfocused and one focused `review --uncommitted` in a fixture repo, `models --refresh --to codex`, `setup --to codex`, cancel of a slow prompt. Run once by hand; record in `docs/qualification/codex-macos.md`.
6. **S3.6 Parity record.** `docs/parity/codex.md`: every codex-plugin-cc command (`ask`, `reply`, `review`, `rescue`, `wait`, `cancel`, `setup`), flag, footer field and documented caveat (stdin deadline, held pipes, PSModulePath, MCP inheritance), each marked same / renamed (`rescue` → `task`) / intentionally different (reply always read-only, footer prefix `council codex`) / missing. Nothing may be marked missing at the gate.

Verification: `npm test`; live file run once; `node plugins/council/scripts/council.mjs ask --to codex --effort low -- Reply with pong </dev/null` prints `pong` and a footer `council codex ok · job … · gpt-6.1-sol/low · …`.

Gate: parity record with no "missing" row; branch merged into `main` with the full fake suite green after the merge.

## S4. Grok adapter

Preconditions: S2. Sources: GROK `scripts/grok.mjs:150-151` (recipe selection, `agent`), `lib/recipes.mjs:3-67`, `lib/review.mjs` (prompt and inline schema carrier), `lib/setup.mjs:4-11` (`parseModels`), `lib/reader.mjs:58-134` (FORBIDDEN check, session confirmation, edit paths, stop reason, cost, usage).

Actions:

1. **S4.1 Skeleton.** `providers/grok.mjs`: `binEnv: "COUNCIL_GROK_BIN"`, `ownsProcess` via `hasFlagOperand(row, "--prompt-file", promptFile, …)`, `trustsCleanExit: () => false` (A5.1), `maxLineBytes` from the GROK reader, `probe` running `--version` and `models` through `parseModels`.
2. **S4.2 buildTurn.** `recipe()` and `compatEnv()` ported whole; the core adds the four A5.1 guard variables to the child environment. Recipe choice: `ask` → explore; `reply` on a thread whose record says `agent: default` → RESUME_DENY recipe, else explore; `task` → write recipe; `review` → explore plus `--json-schema <inline>` and no `--rules`, the prompt file holding `prompts/review.md` or, under `--adversarial`, `prompts/adversarial-review.md` rendered over the collected diff. `--web` omits `--disable-web-search`. `--session-id <uuid>` on new threads, `-r` on `reply` and `task --thread`. `buildTurn` returns `agent` for the thread record. Model and effort from the core (`max` arrives clamped to xhigh).
3. **S4.3 parseEvent.** From the GROK reader: session confirmation on the end event (`session not confirmed` otherwise), advertised tool catalogue checked against FORBIDDEN and MCP tool calls on read-only turns (fatal, fail closed), text deltas, `tool_call`/`tool_call_update` edit paths, `end_turn` stop reason, structured output, cost, usage, `max_turns_reached`.
4. **S4.4 finalizeReview.** From GROK `review.mjs`: validate with `reviewProblem`, map into A5.2, `unreviewed` from the core collection.
5. **S4.5 Tests against fake-grok.** Every verb; `ask → task --thread → reply → task --thread` asserting recipe, `-r` and `agent` persistence on every transition; forbidden tool advertised → exit 1 before any text; `--web` flag mapping; `--adversarial` renders the adversarial template into the prompt file; `max` clamped with footer `grok-4.7/xhigh<=max`; two concurrent jobs with the same model and effort: the post-exit scan of one never matches the other's row.
6. **S4.6 Live tests.** `tests/live/grok.live.test.mjs`: version, `models`, one `ask` at `--effort low`, one `reply`, one `review --uncommitted`, `models --refresh --to grok`, `setup --to grok`, cancel. Record in `docs/qualification/grok-macos.md`.
7. **S4.7 Parity record.** `docs/parity/grok.md` over grok-build-plugin-cc's `ask`, `reply`, `review`, `rescue`, `wait`, `cancel`, `setup`, `--web`, footer fields (`edited N`, `unreviewed N`; cost moves to `--json`), caveats (`session not confirmed`, post-exit scan).

Verification and gate as in S3, footer `council grok ok · job … · grok-4.7/low · …`.

## S5. Gemini adapter

Preconditions: S2. Sources: GEMINI `scripts/gemini-companion.mjs:127-141` (`getAgyAuthStatus`), `lib/agy.mjs` (`buildLaunchDescription`, `runAgy` stdin write and terminal-result checks at 80–100 and 246–283, `READ_ONLY_SETTINGS`, `resultFailure`, `isDeniedFailure`, `describeToolStep`, `describeStepError`, `MAX_PARTIAL_BYTES`), `lib/runner.mjs` (`executeTaskRun`, `executeReviewRun`), `lib/review-output.mjs`, `lib/render.mjs`, `lib/prompts.mjs` (`loadPromptTemplate`, `interpolateTemplate`), `lib/git.mjs:354-365` (`buildCollectionGuidance`). Not ported: `hooks/`, `stop-review-gate-hook.mjs`, `prompts/stop-review-gate.md`, `lib/state.mjs`, `lib/tracked-jobs.mjs`, `lib/job-control.mjs`, `lib/workspace.mjs`, `lib/process.mjs` (core), the rest of `lib/git.mjs` (core, S2.5), verbs `result` and `status` (→ `wait`), `--plan` (→ `ask`).

Actions:

1. **S5.1 Skeleton.** `providers/gemini.mjs`: `binEnv: "COUNCIL_AGY_BIN"`, `ownsProcess` via `hasFlagOperand(row, "--settings", settingsPath, …)`, `trustsCleanExit: () => false` until S7.2 proves otherwise, `maxLineBytes` from `MAX_FRAME_BYTES`, `probe` running `--version`, `getAgyAuthStatus` and `models`. On `win32`, when `docs/qualification/windows.md` marks Gemini unsupported, `buildTurn` throws the A8 message (exit 2).
2. **S5.2 buildTurn.** Write `<job-dir>/settings.json` on every turn per A5.1: start from the user's global `permissions` lists, on read-only turns filter `allow` to `read_file(...)`/`read_url(...)` and add the A2 deny rules, on tasks keep the global lists; pass it; argv per A5.1 with `--print-timeout <deadline>s`; `--sandbox` always; `--mode accept-edits` only on tasks; stdin is the single NDJSON message with the contract text prepended; `--conversation` on `reply` and `task --thread`; `--json-schema <schemas/review-output.schema.json>` on reviews; `--web` exits 2 before any spawn (A3.3, S1.2 decision). Model and effort: suffixed id → id alone (or with an equal `--effort`); family → `--model <family> --effort <clamped>`.
3. **S5.3 parseEvent and finalizeReview.** `conversation_id` from init, step updates or result; text deltas capped by `MAX_PARTIAL_BYTES`; tool steps; the S1.2 denial signature → denied; terminal `result`: duplicate or missing, `status !== "SUCCESS"`, empty response → fatal (exit 1); `finished_reason: "print_timeout"` → incomplete (exit 1); `denied_actions` non-empty → denied (exit 10); `structured_output` → structured. `finalizeReview` through the shared validator into A5.2 with `render.mjs`'s text.
4. **S5.4 Review templates.** Wire the S2.5 templates (`review.md`, `adversarial-review.md`) with `buildCollectionGuidance`; `--adversarial` picks the adversarial template.
5. **S5.5 Tests against fake-agy.** Every verb; `ask → task --thread → reply → task --thread` asserting settings content, `--sandbox`, `--mode` and `--conversation` on every transition; merged-settings cases (a global deny entry retained in the session file, a global `allow` write rule filtered out on read-only turns, global lists intact on tasks); denial signature with the `denied_actions` key absent → 10, and with an empty `denied_actions` array → 10; `denied_actions` non-empty → 10; `--web --to gemini` → 2 before any spawn; `print_timeout` → 1; duplicate result, missing result, `status: "ERROR"`, empty response → 1; suffix conflict → 2; `xhigh` clamped to high with footer `gemini-4-argon/high<=xhigh`; two concurrent jobs with the same model and effort distinguished by their settings paths; the stop path kills a fake language-server child in the group, including one reparented to pid 1.
6. **S5.6 Live tests.** `tests/live/agy.live.test.mjs`: version, `models`, one `ask` at `--effort low`, one `reply`, one `review --uncommitted`, `models --refresh --to gemini`, `setup --to gemini`, cancel, the four effort cases from S1.2. Record in `docs/qualification/gemini-macos.md`.
7. **S5.7 Parity record.** `docs/parity/gemini.md` over gemini-plugin-cc's `review`, `adversarial-review`, `task`, `reply`, `result`, `status`, `cancel`, `setup`, `--plan`, `--timeout`, the stop-review gate (intentionally dropped), `--mode accept-edits` moved from every turn to tasks only, the merged settings file, and the exit remap (denied 20 → 10; 20 now means still running).

Verification and gate as in S3, footer `council gemini ok · job … · gemini-4-argon/low · …`.

## S6. Integration, skill, commands, documentation, measurement

Preconditions: S3, S4, S5 merged on `main`; `npm test` green after the last merge.

Actions:

1. **S6.0 Cross-provider integration tests.** `tests/integration.test.mjs` runs all three adapters against their fakes in one `COUNCIL_HOME`: (a) three concurrent background `ask` calls in one session and cwd, asserting that prune and one provider's post-exit scan never match or stop another provider's child; (b) bare `wait` lists all three jobs; (c) `reply --thread <job>` inherits and locks each provider and a conflicting `--to` exits 2; (d) `reply` after `task` is read-only for all three (`-s read-only`, RESUME_DENY, deny settings); (e) `models --refresh` and `setup` succeed across all three; (f) replay and cancellation of one provider's job leave the others untouched. This is the integration gate: nothing else in S6 starts until it passes.
2. **S6.1 Skill.** Write `SKILL.md` from the CODEX and GROK skills: both A3.1 forms, the verb list, the tier table for three providers (one line each), the A3.5 policy, the A6 fan-out recipe in three lines, the background and `--request-id` rules, the footer and exit-code line, and the discussion protocol. Keep every provider quirk out of it (quirks go to `setup` output and the README). Check `Buffer.byteLength` ≤ 3,000; the test enforces it.
3. **S6.2 Commands.** Fill `scripts/templates/command.md` so each of the 11 commands says when to run in the background; regenerate; `npm run gen:check`. `tests/commands-e2e.test.mjs` takes each command's Bash body verbatim, substitutes `$ARGUMENTS` as Claude Code does, sets `CLAUDE_PLUGIN_ROOT`, `CLAUDE_SESSION_ID`, a temporary `COUNCIL_HOME` and the fake binaries, executes it, and asserts the parsed provider and options, the exact prompt bytes received by the fake, and the exit code. Cases: leading flags, a literal `--` in the text, multiline text, a delimiter collision.
4. **S6.3 README.** Install, both call forms, verbs and flags, tiers, effort clamp rules, state root and recovery (A7 in user terms), platform table, the per-CLI-release checklist (flags, event names, effort rules, model listing format, process-table argv), the known trade-offs (`COUNCIL_CODEX_MCP` and its discovery calls, Gemini web search, Windows agy), and the parity differences from the three plugins.
5. **S6.4 CHANGELOG.** `1.0.0` entry listing what replaced what, with the intentional differences from the parity records.
6. **S6.5 Measurement.** `scripts/measure.mjs` runs `ask` once per provider against the fakes and prints per-call framing bytes (start line + footer) and the skill size. The footer is frozen (A3.4); record the measured figures in `docs/measurements/framing.md` next to the handbook's historical figure for codex-plugin-cc (128 B per ask, labelled with its version and date as recorded there), and set the target there: that figure plus the provider and model/effort fields. Record the isolation settings as installed (`compatEnv`, deny list plus `--sandbox`, MCP `inherit`).
7. **S6.6 Live all-provider check.** By hand: `node plugins/council/scripts/council.mjs models --refresh </dev/null` and `node plugins/council/scripts/council.mjs setup </dev/null` against the real CLIs; both report all three providers. Record in `docs/qualification/macos-setup.md`.
8. **S6.7 Version.** `plugin.json` and `package.json` to `1.0.0-rc.1`.

Verification: `npm test` (integration, size, drift, e2e commands); `npm run measure` prints three rows; the README's install block works from a scratch directory with `claude --plugin-dir "<absolute path>/plugins/council"` **[user]**.

Gate: all green; commit `S6.7: 1.0.0-rc.1` closes the step.

## S7. Qualification and release

Preconditions: S6.

Actions:

1. **S7.1 macOS smoke [user] for the interactive part.** `docs/qualification/matrix.md`: rows `ask`, `reply --last`, `reply --thread`, `review --uncommitted`, `review --base`, `review --commit`, `review --adversarial` (gemini, grok; codex expects exit 2), `task` **[user]**, `wait`, `cancel`, `models --refresh`, `setup`, and the three slash conveniences; columns codex, gemini, grok. Run each live cell from inside Claude Code with `--plugin-dir`, at `--effort low`; tick turn cells with the job id and non-job cells (`wait`, `cancel`, `models`, `setup`) with the saved output file. One fan-out of three `ask` calls in one response, then `reply --thread` on each.
2. **S7.2 Windows session [user].** On the Windows host, at Node 22.19.0: `npm test`; `where.exe codex grok agy` and `Get-Command` to record the launcher kind of each; run the S7.1 matrix for codex and grok once per launcher kind by forcing `COUNCIL_<P>_BIN` at the native executable and at the npm `.cmd` shim, recording the resolved kind; `cancel` on a slow job confirming the post-exit scan and `taskkill /T /F`; attempt the Gemini column. Gemini outcome: qualified (set `trustsCleanExit` true only for launcher kinds proven to leave no language-server or other child after a clean exit) or unsupported (A8: `setup` reports it, turn verbs exit 2 on `win32`). Record commands, expected and observed outcomes in `docs/qualification/windows.md`.
3. **S7.3 Release gate check (A8).** Codex and Grok green on both platforms; Gemini green on macOS; Windows Gemini qualified or reported unsupported. Any red cell blocks; fix, re-run the cell, re-tick.
4. **S7.4 Tag [user].** Versions to `1.0.0`; CHANGELOG date; commit `S7.4: 1.0.0`; `git tag v1.0.0`; push `main` and the tag.

Verification: the matrix file has no empty cell for the gated columns; the tag exists on origin.

Gate: A8 satisfied; `v1.0.0` pushed.

## S8. Migration

Preconditions: S7. Every action here is **[user]**-authorized.

Actions:

1. **S8.0 Baseline.** Save `~/.claude/plugins/installed_plugins.json` and `claude plugin list` output to `docs/qualification/migration.md` before any change.
2. **S8.1 Install.** In Claude Code: `/plugin marketplace add gphcod/codex-agy-grok-plugin-for-claude`, then `/plugin install council@gphcod-council`. Confirm `/council:setup` prints three providers.
3. **S8.2 Replay the old smoke lists.** Run each replaced plugin's documented smoke commands through `council` (the parity records say which `council` call replaces each); tick them in `docs/qualification/migration.md`.
4. **S8.3 Uninstall.** `/plugin uninstall codex@gphcod-codex`, `/plugin uninstall grok-build@gphcod-grok-build`, `/plugin uninstall gemini@gemini-plugin-cc`; remove each of their marketplaces only if no remaining installed plugin uses it.
5. **S8.4 Handbook.** Add a `council` row to `agent_plugin_design_comparison.md` in github.com/gphcod/handbook with the measured framing figures, platform evidence and the install commit, following that file's table format; open it as a pull request there.

Verification: `installed_plugins.json` and `claude plugin list` contain `council@gphcod-council`, contain none of the three replaced ids, and otherwise equal the S8.0 baseline; a Claude session answers `/council:ask --to grok hello` with a footer.

Gate: handbook pull request opened; migration record complete. Done.

---

# Part C. Review record

## Rounds 1 and 2 (design, 2026-10-31)

Round 1 sent the draft and six questions to Codex gpt-6.1-sol (xhigh), Grok 4.7 (xhigh) and Gemini 4 Argon (high); round 2 sent each the resolutions plus the live agy and Grok probes as new facts and asked only for remaining objections. All three accepted.

### Codex gpt-6.1-sol, 14 findings

| # | Sev | Finding | Resolution |
|---|---|---|---|
| F1 | MINOR | Keep `--to`; define resolution rules; replies lock the provider | `--to` required, inference dropped |
| F2 | MAJOR | Shared effort vocabulary with downward clamp; report clamp; isolate `ultra` | AGREE; `ultra` codex-only pass-through |
| F3 | MAJOR | Suffixed Gemini id is an explicit effort; conflicting flags rejected; argon/medium consult | AGREE on precedence; tiers changed to argon/high |
| F4 | BLOCKER | Parallel panel contradicts one CLI process per turn | No coordinating process in 1.0 (A6) |
| F5 | MAJOR | Panel needs member specs, manifest, per-member cancel/replay | Recorded as 1.1 requirements |
| F6 | MAJOR | Scope `--last`/wait/cancel by session; provider-namespaced threads; realpath | AGREE (A7) |
| F7 | MAJOR | Pruning vs replay: tombstones, thread metadata apart, "expired" | AGREE; tombstone after preparation |
| F8 | MAJOR | Replies must not inherit edit mode | AGREE |
| F9 | MAJOR | Grok recipes and env overrides missing | AGREE |
| F10 | MAJOR | Ownership evidence adapter-specific; trust clean exits only when qualified | AGREE |
| F11 | MAJOR | Normalize review outcomes; implement `--commit` for collected diffs | AGREE; `git diff-tree --root` after round 2 |
| F12 | MAJOR | Restore the three timing flags; print_timeout is incomplete | AGREE |
| F13 | MAJOR | `--worktree` has no lifecycle | Removed from 1.0 |
| F14 | MAJOR | Capability spike first; Windows agy must not be hand-waved | Spike is S1; Windows agy gated in A8 |

### Grok 4.7, 12 findings

| # | Sev | Finding | Resolution |
|---|---|---|---|
| F1 | MAJOR | Drop prefix inference; `--to` required | AGREE |
| F2 | BLOCKER | Reply stays read-only after task | AGREE |
| F3 | MAJOR | Forward only mapped flags; `--commit` for gemini/grok | AGREE; `--commit` implemented via `git diff-tree -p --root --no-color --no-ext-diff <oid>` |
| F4 | MAJOR | Downward clamp only, clamp in footer, `ultra` codex-only, freeze footer before measuring | AGREE |
| F5 | MAJOR | Do not rewrite agy ids; exit 2 on conflicts; verify before clamping | Verified live; clamp to high with footer note |
| F6 | MAJOR | Gemini tiers argon/high, flash/high, argon/high | AGREE |
| F7 | BLOCKER | One child per companion; fan-out is N background asks | AGREE (A6) |
| F8 | MAJOR | Per-workspace dir; provider-prefixed claims; 16-char ids; cap 100 | AGREE except directory: single root with lazy git root; tombstone after preparation |
| F9 | BLOCKER | Grok argv needs explore/RESUME_DENY, compatEnv, depth guard | AGREE |
| F10 | MAJOR | Gemini has no rules flag; templates and `--adversarial`; print_timeout → 1 | AGREE |
| F11 | MAJOR | Schema carrier differs per adapter | AGREE |
| F12 | MAJOR | Freeze exit remap and catalog location before adapters; `codex debug models` | AGREE; verified |

### Gemini 4 Argon, 8 findings

| # | Sev | Finding | Resolution |
|---|---|---|---|
| F1 | MAJOR | Keep `--to`; restore `--deadline`, add `--uncommitted`, implement `--commit`, drop `--worktree`; Gemini `--web` via deny list | AGREE; web tool name decided in S1.2 |
| F2 | MINOR | Shared vocabulary; `ultra` contradiction; compact footer clamp | AGREE; `model/high<=xhigh` |
| F3 | MAJOR | Double-suffix hazard; `setup` validates resolved ids; argon/medium consult | AGREE on suffix and setup; REJECT on medium (accepted in round 2) |
| F4 | MAJOR | One coordinating panel process; duplicate handlers; ambiguous `--last` | Fan-out by Claude in 1.0; hazards are 1.1 requirements; `--thread` after fan-out |
| F5 | BLOCKER | `cancel` must not kill a live companion; thread metadata apart; no git spawn per call; `--session` in template | AGREE in full |
| F6 | BLOCKER | agy needs job-specific argv; deny JSON malformed; no contract carrier | per-job `--settings`; JSON corrected; contract prepended |
| F7 | BLOCKER | Reply inheriting edit mode; Grok `agent` not persisted; no `env` in buildTurn | AGREE |
| F8 | MAJOR | Core baseline grok-build 1.1.5 plus codex pipe wait; PowerShell inline; per-adapter line cap | AGREE |

Where the reviewers disagreed with each other: fan-out (Codex and Gemini wanted one coordinating process, Grok N single-child calls; Grok's design for 1.0), Gemini consult tier (argon/medium vs argon/high; high), `--commit` on collected diffs (exit 2 vs implement; implemented with `git diff-tree --root`). All three accepted each decision.

## Round 3 (this procedure, 2026-10-31)

The procedural rewrite went to Codex gpt-6.1-sol (xhigh) and Gemini 4 Argon (high) with six questions: ordering, verification, porting accuracy, executability, missing steps, accidental changes to Part A. Both read every cited source module; Codex also reproduced the `exec review` flags-plus-prompt exit 2.

### Codex gpt-6.1-sol, 19 findings

| # | Sev | Finding | Resolution |
|---|---|---|---|
| F1 | BLOCKER | Schema, `tiers.json`, `contract.md`, review templates had no producing step | AGREE: S1.0 schema, S1.5 tiers, S2.5 contract and templates, S2.7 placeholder check |
| F2 | BLOCKER | Focused Codex review cannot combine target flags with a prompt | AGREE: A2 fact added, A5.1 and S3.2 give both routes, S1.1 probes both |
| F3 | MAJOR | S1 used adapters and live `setup` before S3–S5 | AGREE: S1 tests catalog against recorded listings and stub probes; `models`/`setup` wired in S2.6 on the null adapter, live per provider in S3–S5, all three in S6.6 |
| F4 | MAJOR | Generated commands put options inside a heredoc after a literal `--` | AGREE: slash-command form without `--` (A3.1), `splitLeading` kept, e2e command tests substitute `$ARGUMENTS` |
| F5 | MAJOR | Default test discovery would run paid live tests | AGREE: S0.2 exclusions, disjointness test, `--ratio` defined |
| F6 | MAJOR | GROK entry orchestration (fingerprint, replay, inheritance) not mapped | AGREE: mapping row and S2.6; fingerprint over raw inputs (A7.4) |
| F7 | MAJOR | Root, 16-char ids on both routes, provider-namespaced thread queries not covered by "add provider" | AGREE: S2.3 and A7.3 |
| F8 | MAJOR | Null adapter exercised one transport shape | AGREE: profiles for id discovery, input and output; extra child scenarios; typedefs frozen in S2.7 |
| F9 | MAJOR | Review normalization could approve on extraction alone | AGREE: validate with `reviewProblem` first; `unreviewed` from collection; Codex unmapped → incomplete (A5.2) |
| F10 | MAJOR | agy terminal-result validation and empty-`denied_actions` denial path dropped | AGREE: A5.1, S1.2 denial signature, S5.3, S5.5 |
| F11 | MAJOR | Static catalog lacked per-model effort lists | AGREE: `models.json` per model; identical rules static or refreshed (S1.5, S1.6) |
| F12 | MAJOR | Symlink handling attributed to GEMINI's `statSync` code | AGREE: GROK `review.mjs` is the source; GEMINI only `gitPaths`; outside-symlink test |
| F13 | MAJOR | `task --thread` had no resume route | AGREE: A3.2, A5.1, S3–S5 transition tests |
| F14 | MAJOR | Grok clean-exit policy and Windows cases unspecified | AGREE: `trustsCleanExit` false for Grok; S7.2 names launcher kinds, `npm test` at both Node versions, `where.exe`; symlink fixtures created by tests |
| F15 | MAJOR | Parallel adapter branches had no registration or integration contract | AGREE: dynamic provider loading (S2.6), rule 1 on branches, S6.0 integration gate |
| F16 | MAJOR | Fakes could approve wrong invocations | AGREE: fakes validate the launch contract and answer probe commands (S1.4) |
| F17 | MINOR | Several verifications not runnable literally | AGREE: rule 2 from S2 onward; absolute `--plugin-dir`; `main()` harness and `COUNCIL_TEST_NULL_ADAPTER`; `</dev/null` |
| F18 | MAJOR | `COUNCIL_CODEX_MCP=off` spawns `codex mcp list` discovery calls | CHANGE: not a stop; A1 now names these calls as the inherited codex-plugin-cc trade-off, S1.1 counts them, S3.4 asserts the budget |
| F19 | MINOR | Migration gate required the whole installation to be `council` only | AGREE: S8.0 baseline and scoped assertion |

### Gemini 4 Argon, 12 findings

| # | Sev | Finding | Resolution |
|---|---|---|---|
| F1 | BLOCKER | S1.6/S1.7 used core modules and adapters before S2–S5 | AGREE (same as Codex F3); `catalog.mjs`/`tiers.mjs` written directly in core in S1.6 |
| F2 | BLOCKER | Schema, `contract.md`, `tiers.json` never created | AGREE (Codex F1) |
| F3 | MAJOR | Three branches would conflict on `council.mjs` | AGREE: dynamic `import()` registry, branches never edit the entry |
| F4 | MAJOR | Fakes untested in S1; `--ratio` undefined; S2 verification blocks on stdin and uses an unregistered provider | AGREE: `fakes.test.mjs`, `--ratio` in S0.2, `</dev/null`, `COUNCIL_TEST_NULL_ADAPTER` |
| F5 | MINOR | Interactive verifications unmarked; S8 over-strict; rule 2 vs S0/S1 | AGREE: **[user]** marks, scoped S8 assertion, rule 2 from S2 |
| F6 | BLOCKER | GROK `prune()` keeps job bodies; 4/8-char ids; no `result expired`; `candidates()` ignores cwd with a session | AGREE: prune from CODEX, 16-char ids both routes, tombstone with fingerprint, cwd and session both (A7.2, S2.3) |
| F7 | MAJOR | Lifecycle line refs incomplete; no pgid on darwin; `ownsProcess` must read `row.raw` on macOS | AGREE: mapping rows, `hasFlagOperand`, darwin `pgid=`, group signal (A5, A7.5) |
| F8 | MAJOR | Wrong attributions: symlinks, Codex deltas, `[P0]` scan location, recipes lines, Grok `agent` source, missing GEMINI sources | AGREE: all corrected in S2 table, S3.3, S4, S5 |
| F9 | BLOCKER | Slash-command `--` bug; A5 return shapes and footer grammar unfrozen | AGREE: A3.1 two forms, A3.4 grammar, A5 shapes; CHANGE on counters: `edited N` stays in task footers and `unreviewed N` in review footers because Claude acts on them; cost and failed commands go to `--json` |
| F10 | MAJOR | Decision rules for Gemini `--web` and Windows Gemini; `cwd` in thread records; fan-out vs one-call wording | AGREE: S1.2 rule, A8 exit 2 on win32, A7.6 cwd, A3.1 wording |
| F11 | MAJOR | Missing fakes test, win32 unit tests, post-merge integration | AGREE: S1.4, S2.2/S2.4 win32 cases, S6.0 |
| F12 | BLOCKER | "Suffix stripping" wording contradicted Grok F5; Gemini families must be indexed from the suffixed listing; `--settings` wording; request-id regex | AGREE: A3.3 wording, S1.6 family indexing, A5.1 settings on every turn, A3.3 regex and 16-char derivation |

### Round 3 replies

Both reviewers received the resolutions above and the revised text.

- Gemini 4 Argon: "no objections"; confirmed all twelve resolutions, including the F9 counter decision, as consistently applied.
- Codex gpt-6.1-sol: three resolutions incomplete, each adopted verbatim afterwards. F6: a replayed `reply --last --request-id` could re-resolve the provider before the fingerprint and start a second child → S2.6 now recovers the original binding and replays before any implicit selector or catalog is re-evaluated, with the regression case in S2.3. F14: `schema.test.mjs` compared against an installed plugin cache, an undeclared machine dependency on the Windows host → S1.0 commits a reference fixture with provenance and the test reads repository files only. F17: the optional `--plugin-dir` check used `$PWD` from the scratch directory, and S6.6 lacked `</dev/null` → both corrected.

The plan was committed after these three edits; no further round was needed because each fix is the reviewer's own wording.

### Corrections carried over from the twin's review (same day)

The Codex-hosted twin plan (github.com/gphcod/claude-agy-grok-plugin-for-codex) was reviewed by the same two models, who asked that four shared contracts be corrected here too: `--no-commit-id` on the `diff-tree` collection, first-parent semantics for merge commits and exit 2 for missing shallow ancestry (A5.2); optional `beforeTurn`/`afterTurn` lifecycle hooks in the adapter interface, unused by this host's adapters in 1.0 (A5); the rule that an explicit `--tier`, `--model` or `--effort` on `reply` overrides inheritance (A3.2); and Gemini's settings file merging the user's global permission lists instead of replacing them, since agy replaces a global `deny` array with a session one (A5.1). S1.2 verifies the last point live before S5 relies on it.

### Final self-review (2026-10-31, Claude only)

A last read of both plans side by side, without the reviewers. Changes made here: A1 enumerates every permitted subprocess (the process-table query and the `setup`/`models --refresh` probes were implied, not named); the Gemini read-only deny list is the union of both donors' lists and `--mode accept-edits` moves to tasks only (A2, A5.1, S5.2, S5.5, S5.7), with S1.2 verifying live that a session `deny` array replaces the global one, which the carried-over A5.1 text relied on without a probe; every child receives the four guard variables the replaced plugins read, so an old plugin still installed during S8 cannot nest (A5.1, S2.4); `--adversarial` is defined for collected-diff reviews and exits 2 on Codex, `--web` exits 2 on Codex (A3.3, S3.4, S4.2, S4.5, S7.1); S2.5's shallow-clone case said "yields a patch" against A5.2's exit 2 and now matches; `cancel` and owner-death recovery load the recorded provider's module for `ownsProcess` only, the same correction Codex made on the twin (S2.6); `--json` gains `session` and the layout lists `types.mjs` (A3.4, A4).

### Contract check against the installed CLIs (2026-10-31)

Every flag Part A passes to a provider was checked against `--help` of codex-cli 0.163.0 (`exec`, `exec review`, `exec resume`, `debug`, `login`, `mcp list`), agy 1.4.12 and grok 1.0.70, and against the donors' argv builders, without a model call. Results: all Codex, agy and Grok flags exist with the stated arity and value forms (`-o` is `--output-last-message`, `-C` is `--cd`, `-s` is `--sandbox`, `-` reads the prompt from stdin on `exec` and `exec review`; agy `--print-timeout` takes a duration such as `120s`, `--json-schema` a string or a path, `--settings` inline JSON or a path; grok `--effort` is the alias of `--reasoning-effort`, `--session-id` is `-s`). Two corrections followed: `codex exec resume` and `codex exec review` accept neither `-C` nor `-s`, so A2, A5.1 and S3.2 now state the `cwd`-at-spawn and `-c sandbox_mode=` form the donor uses; and grok's `--no-auto-update` is hidden from `--help` but accepted (an unknown flag is rejected with "unexpected argument"), which A5.1 now says. agy accepts `--effort xhigh|max` as tokens; the rejection recorded in A2 comes from model selection, as the live probe showed.

## rc.7 service-recovery amendment (2026-11-02 Pacific)

A1 and A3.1 retain one provider CLI child per companion call. The narrow recovery exception to the one-call host rule is a Gemini read-only 503 with a plugin footer token starting `temporary 503; next: repeat once` or JSON `retry.eligible=true`. The host may submit exactly one further call per user request after at least two seconds, with the same input/model/permissions and a fresh request id; a second 503 is reported. This is not an internal relaunch or an exception for tasks, partial streams, tool activity, unknown mutations or uncertain cleanup. A3.4 adds nullable retry metadata and conditional unfinished-draft pointers. Neither a partial draft nor a service failure is a completed review or approval. The failed original request remains immutable. See the recorded decision and Windows service qualification.

## Windows request publication amendment (2026-11-02 Pacific)

A7’s logical request lifecycle and identifiers are unchanged. New request-format-2 roots remain immutable, with generation-specific binding/prepared publications and an unlink ownership gate. The physical envelope fails closed for older clients; current readers still understand completed legacy inline requests. Failed preparation only frees an owned, unprepared generation. Legacy unfinished requests require explicit reconciliation. See docs/qualification/windows-request-lock.md and the recorded review decisions.

## rc.9 review amendment (2026-11-03 Pacific)

A7.2: `reply --last` also selects the latest thread-starting job that is still open and refuses it, rather than passing over it to an older thread. A7.6: the thread record follows only a turn whose provider started; a resumed turn that never started leaves the record alone. A5.2's collector forces canonical diff headers whatever the user's Git configuration says. The reasons are in `docs/decisions.md`.
