# council: one Claude Code plugin for Codex, Gemini (agy) and Grok

Status: final plan, 2026-10-31. Reviewed before finalization by Codex gpt-6.1-sol (xhigh), Grok 4.7 (xhigh) and Gemini 4 Argon (high), two rounds each; all three accepted the final resolutions. Findings and resolutions are in section 13.

## 1. Goal

Replace the three installed plugins, codex-plugin-cc 2.3.2, gemini-plugin-cc 2.1.0 and grok-build-plugin-cc 1.1.5, with one plugin, `council`, that lets Claude:

- ask any of the three models a quick question,
- hold a multi-round discussion with one of them (delta replies, stable finding IDs),
- request a code review of local changes, including an adversarial review,
- assign a coding task that edits the working tree, only when the user authorizes it,
- fan one brief out to several models at once and compare their answers,
- choose the provider, the exact model and the thinking effort per call, or fall back to named tiers.

The plugin keeps the design the handbook comparison ranks first (codex-plugin-cc): one companion process and one child CLI process per Claude turn, one Bash call, background task plus notification instead of polling, one model-visible skill under 3,000 B, user-only slash commands generated from a template, a 24 KiB answer cap, `--request-id` replays, exit codes 0/10/20/1/2.

Non-goals for 1.0: no MCP server, daemon or hooks (the Gemini stop-review gate may return as opt-in later), no coordinating multi-child "panel" process (see section 6), no `--worktree`, no model-quality ranking, no Linux qualification before macOS and Windows pass.

## 2. Facts the design rests on (checked 2026-10-31 on this Mac)

| Provider | CLI | Version | Headless form | Resume | Model flag | Effort flag | Read-only enforcement |
|---|---|---|---|---|---|---|---|
| Codex | `codex` | 0.163.0 | `codex exec --json -o <file> … -` (prompt on stdin) | `codex exec resume <thread>` | `-m <model>` | `-c model_reasoning_effort=<e>` | `-s read-only` / `-c sandbox_mode=read-only`; `exec review` for native reviews |
| Gemini | `agy` (Antigravity CLI) | 1.4.12 | `--input-format stream-json --output-format stream-json`, one NDJSON message on stdin | `--conversation <id>` | `--model <id>` | `--effort low\|medium\|high` | `--settings <job-dir>/settings.json` holding `{"permissions":{"deny":["write_file(*)","edit_file(*)","command(*)","mcp(*)"]}}`, plus `--sandbox` |
| Grok | `grok` | 1.0.70 | `--prompt-file <f> --output-format streaming-json` | `-r <session>`; `--session-id <uuid>` for a new one | `--model <id>` | `--effort <e>` (alias of `--reasoning-effort`) | `--agent explore`, `--deny` rules, `--disallowed-tools`, `--no-subagents`, `--disable-web-search` |

Model listings, all headless:

- `codex debug models` (JSON): `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-6-astra`, `gpt-5.6-{sol,terra,luna}`, each with `supported_reasoning_levels`. All accept low…max; the sol/terra/astra families also accept `ultra`.
- `agy models`: `gemini-4-argon-{low,medium,high}`, `gemini-3.8-flash-{low,medium,high}`, plus Claude and GPT-OSS entries that council does not route to.
- `grok models`: `grok-4.7`, `grok-4.7-build-fast`, `grok-4.6` (default), `grok-4.5`.

Effort behaviour, probed live:

| Provider | Accepts | On an unsupported value |
|---|---|---|
| Codex | low, medium, high, xhigh, max; `ultra` on listed families | not probed; catalog says which |
| Grok | low, medium, high, xhigh | `max` → error "unknown effort level" |
| Gemini | low, medium, high, or an effort-suffixed model id | xhigh/max → error "invalid model selection"; a suffixed id with a different `--effort` → the same error |

No CLI clamps; council must.

Tiers (per provider, in `tiers.json`): codex consult `gpt-6.1-sol/high`, exec `gpt-6-luna/max`, deep `gpt-6.1-sol/xhigh`; grok consult `grok-4.7/high`, exec `grok-4.7-build-fast/xhigh`, deep `grok-4.7/xhigh`; gemini consult `gemini-4-argon/high`, exec `gemini-3.8-flash/high`, deep `gemini-4-argon/high` (Gemini has no effort above high, so consult and deep coincide; the skill says so). Family and effort are stored separately.

## 3. Call surface

Claude sees one skill, `council`. Every call is one Bash call; long or expensive calls run as a Claude background task:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council.mjs" <verb> --to <provider> --session "${CLAUDE_SESSION_ID}" [flags] -- <<'COUNCIL_EOF'
<text>
COUNCIL_EOF
```

Verbs (same meaning for every provider):

| Verb | What it does | Mode |
|---|---|---|
| `ask --to <p>` | New thread, one answer | read-only |
| `reply --thread <job\|thread> \| --last` | Delta on an existing thread. Provider inherited from the thread and locked; model and effort inherited unless given explicitly within that provider | always read-only, even after a task |
| `review --to <p> [--base <ref> \| --commit <sha>] [--adversarial] [focus]` | Review of uncommitted changes, of the branch against a base, or of one commit; structured findings; exit 10 when findings exist | read-only |
| `task --to <p> [--thread <id>]` | Delegated work that may edit the working tree. Never started by Claude on its own; a later edit on the same thread is another `task --thread`, not a `reply` | edit |
| `wait [job] [--timeout <s>]` | List this session's jobs or await one; replays a finished result; returns 20 without stopping anything | — |
| `cancel [job]` | Stop a job (process group) and confirm cleanup | — |
| `models [--to <p>] [--refresh]` | Print the catalog: static aliases plus the last CLI listing; `--refresh` re-runs `codex debug models`, `agy models`, `grok models` | — |
| `setup [--to <p>]` | Binary, login, version, models, Windows launcher kind, and the measured trade-offs (Codex MCP inheritance) | — |

Flags:

- `--to <codex|gemini|grok>`: required on `ask`, `review`, `task`. No inference from the model name: agy lists `gpt-oss-*` ids, and aliases such as `sol` or `4.7` have no prefix, so an inference rule would hold only sometimes.
- `--model <id|alias>`: an exact CLI id, or an alias resolved inside that provider's catalog (`sol`, `terra`, `luna`, `astra`, `argon`, `flash`, `4.7`, `4.6`, `build-fast`). An unknown id passes through to the CLI unchanged, so a new model works on release day; the footer then says `model unverified`.
- `--effort low|medium|high|xhigh|max`: one vocabulary for all providers. Council clamps downward only, against the catalog: the greatest offered effort at or below the request, or the lowest offered if the request is below all of them. A clamp is reported inside the footer's model/effort token, `gemini-4-argon/high<=xhigh`, and as `effort`/`requestedEffort` in `--json`. `ultra` is a codex-only pass-through token outside the shared enum. For Gemini an effort-suffixed model id is an explicit effort; a conflicting `--effort` exits 2.
- `--tier consult|exec|deep`: provider-specific defaults from `tiers.json`; explicit `--model`/`--effort` win. Default `consult`.
- `--thread`, `--last`, `--base`, `--commit`, `--uncommitted`, `--adversarial`, `--rounds`, `--request-id`, `--json`, `--session`.
- Timing, three distinct flags as in the Codex and Grok companions: `--deadline <s>` (execution deadline; starts cleanup), `--inactivity-timeout <s>` (no output for that long; starts cleanup), and `wait --timeout <s>` (returns 20, stops nothing). agy's own `--print-timeout` is set from the deadline, and a `print_timeout` result is exit 1 (incomplete), never 20.
- `--web`: web search, off by default. Grok maps it to `--disable-web-search`'s absence. For Gemini the phase-1 spike establishes agy's web tool name; if one exists (expected `search_web(*)`), read-only turns deny it unless `--web`, otherwise Gemini `--web` exits 2. Any flag an adapter has no tested mapping for exits 2 instead of being dropped.

Slash commands (user-only, `disable-model-invocation: true`, generated from one template with a drift test): `/council:ask`, `/council:reply`, `/council:review`, `/council:task`, `/council:wait`, `/council:cancel`, `/council:models`, `/council:setup`, plus three conveniences, `/council:codex`, `/council:gemini`, `/council:grok`, equal to `/council:ask --to <p>`.

Output contract (unchanged from the three plugins): a one-line start line on stderr, the answer, then one footer line, for example `council codex ok · job ost9jq0a4lp8b8tq · gpt-6.1-sol/high · 41s · round 2/9`, with `<=xhigh` on the effort token when a clamp happened and `full: <file>` when the 24 KiB cap cut the answer. Job ids are 16 characters. Exit 0 done, 10 needs attention (review findings, denied action, incomplete or malformed review output), 20 still running, 1 failed/cancelled/busy, 2 invalid input. The skill tells Claude to act on or summarize the answer, never to repeat it. The footer is frozen before the framing target (section 10) is set.

Skill policy, carried over: when the user did not name a model, Claude uses `ask`/`reply`/`review` only, passes `--tier consult` explicitly, asks once before higher effort (not for Gemini, which has none above high), and never starts `task` on its own. When the user named a model or family, Claude picks the tier by complexity. Discussion protocol: F1/F2 findings tagged BLOCKER/MAJOR/MINOR with file:line; replies carry only `AGREE`, `CHANGE: …`, `REJECT: …` and new facts; 9-reply budget per thread shown in the footer; unresolved REJECT reported as disagreement, never consensus.

## 4. Repository layout

```
.claude-plugin/marketplace.json          marketplace "gphcod-council", plugin ./plugins/council
plugins/council/
  .claude-plugin/plugin.json             name "council"
  skills/council/SKILL.md                the only model-visible file; ≤ 3,000 B, enforced by test
  commands/*.md                          11 generated files; npm test fails on drift
  contract.md                            one contract for all providers (the F1/F2 protocol)
  tiers.json                             { codex: {consult,exec,deep}, gemini: {…}, grok: {…} }
  models.json                            static part of the catalog: aliases, effort ranges, prefixes
  prompts/review.md adversarial-review.md ported review templates (Gemini and Grok collected-diff reviews)
  schemas/review-output.schema.json      shared review schema
  scripts/council.mjs                    entry: parse verb, admit, pick adapter, run turn, print
  scripts/lib/core/                      provider-neutral
    args.mjs stdin.mjs                   arity-based options, `--` literal text, 10 s stdin deadline
    jobs.mjs claims.mjs heartbeat.mjs    job store, request claims and tombstones, thread records, liveness
    reader.mjs                           stream reader with a per-adapter maxLineBytes cap applied before parseEvent
    lifecycle.mjs                        start → run → post-exit check → finalize; cancel; cleanup pending
    execution.mjs                        process identity, post-exit scan, kill tree, depth guard; PowerShell query/kill as inline strings (no .ps1 on disk, so execution policy cannot block them), PSModulePath set explicitly
    output.mjs                           start line, 24 KiB cap, footer, --json
    git.mjs                              repo root once per process; diff collection for --base and --commit
    tiers.mjs catalog.mjs                tier resolution, alias → id, effort clamp, refreshed listings
    review.mjs                           normalized review result (section 5)
  scripts/lib/providers/
    codex.mjs gemini.mjs grok.mjs        adapters (section 5)
tests/
  fixtures/fake-codex.mjs fake-agy.mjs fake-grok.mjs
  fixtures/repos/                        incl. a root-commit repository for --commit
  *.test.mjs                             unit + every generated command form against the fakes
  live/*.live.test.mjs                   per-CLI contract tests, run by hand after each CLI upgrade
scripts/gen-commands.mjs scripts/measure.mjs
```

No runtime dependencies. Node `>=18.20.8 <19 || >=22.19.0` (Node 20 excluded, as the handbook records). Refreshed model listings are data and live under the state root (section 7), never inside the installed plugin directory. The core is ported from grok-build-plugin-cc 1.1.5 (the newer shared core: PSModulePath, zero-thread handle filter, printable-ASCII fast path, claim before prepare with release on failure, heartbeat before the job record) plus codex-plugin-cc's 12 s held-pipe wait and `trustsCleanExit`.

## 5. Provider adapter interface

Each adapter exports the same object:

```js
export default {
  id: "codex",
  binEnv: "COUNCIL_CODEX_BIN",
  resolveLauncher(env, platform),          // {command, args, path, kind} | null; never via cmd.exe
  trustsCleanExit(launcher),               // true only for provider/launcher pairs qualified on Windows
  ownsProcess(row, job, platform),         // job-specific match in a process table (section 5.1)
  maxLineBytes,                            // stream cap enforced by the core reader before parseEvent
  probe(launcher),                         // {version, loggedIn, models[]} for setup / models --refresh
  catalog: { aliases, efforts, families },
  buildTurn(request),                      // {args, env, stdin | promptFile, answerFile, readOnly, contractCarrier}
  parseEvent(line, state),                 // {threadId?, textDelta?, toolStep?, result?, denied?, incomplete?}
  reviewPlan(gitInfo, request),            // native (codex) or collected diff + template + schema (gemini, grok)
  finalizeReview(raw),                     // → normalized review result
};
```

### 5.1 Per provider

- **codex** (adapter from codex-companion.mjs): `exec --json -o <answer> -C <cwd> -s <sandbox> -m <model> -c model_reasoning_effort=<e> -c developer_instructions=<contract> -`; resume via `exec resume <thread>`; review via `exec review --json -c sandbox_mode=read-only -m <model> -c review_model=<model>` with `--base`/`--commit` target flags, or a focus sentence on stdin when focus text is present. MCP inheritance stays default `inherit` with `COUNCIL_CODEX_MCP=off` opt-in, as gate D1 decided; `setup` states the measured trade-off. Ownership evidence: the exact answer-file operand. Thread id from the first `thread.started` event. Review output is scanned for `[P0]`/`[P1]` findings and mapped onto the normalized result.
- **gemini** (port of agy.mjs/runner.mjs): one NDJSON `user` message on stdin with the contract prepended to the text (agy has no rules flag); `--disable-slash-commands --mode accept-edits --print-timeout <deadline>`; `--conversation <id>` on reply; deny list plus `--sandbox` when read-only, `--sandbox` alone on tasks. Model/effort: unsuffixed family → `--model <family> --effort <low|medium|high>` after the downward clamp; suffixed id → the id alone, or with `--effort` only when equal. Reviews fill `prompts/review.md` or `prompts/adversarial-review.md` and pass `--json-schema <path>`. `setup` validates the tiers' resolved suffixed ids (`gemini-4-argon-high`) against `agy models`. `print_timeout` → exit 1; `denied_actions` non-empty → exit 10, but an empty list is not proof of read-only compliance (deny rules fail the tool step instead). Ownership: agy carries no job path in argv by itself, so the adapter passes `--settings <job-dir>/settings.json` (agy accepts a file path) on every turn, which makes argv job-specific, and records the child's identity at spawn; the language-server child agy starts is part of the tree to stop. Web search per section 3.
- **grok** (port of grok.mjs/recipes.mjs): `--prompt-file <f> --output-format streaming-json --model <m> --effort <e> --no-auto-update --always-approve --no-subagents --disallowed-tools <hostile list>`, `--disable-web-search` unless `--web`, `--rules <contract>` except on reviews, `--json-schema <inline document>` on reviews, `--session-id <uuid>` on a new thread and `-r <id>` on reply. Recipes ported whole: `--agent explore` on a fresh read-only session; the default agent with the RESUME_DENY denylist on a read-only turn after an edit turn; `--deny MCPTool(*)` on read-only turns; `--deny "Bash(git push*)"` and `--deny "Bash(rm -rf *)"` on tasks; `compatEnv()` turning skills, agents, hooks, MCP and rules off in the child environment. The stream reader fails a read-only turn closed when Grok advertises a write, shell or subagent tool (MCP names may be advertised; invocation is denied, as installed). The thread record persists `agent`, so a reply after an edit turn picks the RESUME_DENY recipe. Ownership: the prompt-file operand. Post-exit scan after every exit (about 0.57 s on Windows).

Common to all three: a depth variable set on every child, and a refusal to start when it is already set (no nested council). Each adapter's `--json-schema` carrier is its own (Grok inline, Gemini a path, Codex none); no shared helper decides the shape.

### 5.2 Normalized review result

`{ verdict: approve|changes|incomplete, findings: [{severity, file, line, title, text}], coverage: {reviewed, unreviewed}, incomplete: reason|null }`. Severity maps critical/high → BLOCKER, medium → MAJOR, low → MINOR, Codex `[P0]` → BLOCKER and `[P1]` → MAJOR. Exit 10 when findings exist, when coverage is incomplete, or when the output is malformed or missing; malformed output never becomes an approval.

Diff collection (Gemini and Grok): `--base <ref>` collects `ref...HEAD` plus the working tree as today, with `-z` paths and symlink link text; `--commit <sha>` resolves `<sha>^{commit}` (exit 2 on failure) and collects `git diff-tree -p --root --no-color --no-ext-diff <oid>`, so a root commit and a shallow clone both yield a patch; both paths share the size, symlink and path handling. Codex passes `--base`/`--commit` to `exec review` natively.

## 6. Fan-out (several models on one brief)

1.0 has no coordinating process. To consult several models, Claude issues one background `ask` per provider in a single response, each with its own `--request-id`, the same brief and that provider's `consult` tier unless the user chose otherwise, then summarizes the answers side by side and reports disagreements as disagreements. Follow-ups after a fan-out use `reply --thread <job>`, never `--last`, since the members finish within moments of each other. The skill carries this recipe in three lines. Reasons: the ported lifecycle (heartbeat, claim, `trustsCleanExit`, post-exit scan, process-group cancel) is single-child; one process for N members would make exit 10 ambiguous between "findings" and "a member failed"; and the shared state already gives one job list, cancel and replay.

A coordinating `panel` verb is a 1.1 candidate only with: repeatable member specifications (provider, model, effort), a parent job that owns the request id, `wait`, `cancel` and the digest, with every child identity persisted before any spawn, replay from that manifest without relaunch, parent cancel covering every unfinished child while member cancel spares siblings, signal handling and pruning hoisted out of the per-member turns (today's lifecycle installs process-wide handlers and prunes per turn, so N turns in one process collide), per-member outcomes, and a deterministic digest with no extra synthesis call. Cross-critique rounds are also 1.1.

## 7. State and recovery

- State root: a single `~/.council/` with `jobs/`, `claims/`, `threads/`, `catalog/`, as codex-plugin-cc and grok-build-plugin-cc keep one home. Each record carries the realpath of its cwd and the Claude session; the git root is resolved lazily, only for reviews, so `ask`, `reply`, `wait` and `cancel` start no git process.
- Every generated invocation passes `--session "${CLAUDE_SESSION_ID}"`. `--last`, bare `wait` and bare `cancel` are scoped to session and cwd; a named job id is found across sessions, so `cancel <job>` can clear another session's stuck thread, as today.
- Claim key = provider + session + realpath(cwd) + request id, so `/tmp` and `/private/tmp` are one place and a Grok id can never collide with a Codex claim. Thread locks live under `claims/<provider>/<threadId>`; a native thread is never adopted across workspaces.
- Request lifecycle: claim → prepare → tombstone → run. The claim is taken before preparation (reviews run git before the job exists); a claim that fails before preparation completes is released, so the same `--request-id` can run again. The tombstone, written only after preparation succeeds, is immutable: a replay of that id prints or awaits the first result, and when the job body has been pruned returns `result expired` without starting a CLI.
- Thread records (`threads/<provider>-<threadId>.json`) persist provider, native thread id, model, effort, tier, round counter, rounds budget and, for Grok, `agent`, apart from job bodies, so `reply --thread` works after the job body is pruned.
- Pruning removes finished job bodies past 100, never a running, lost, cleanup-pending or claim-holding job, and never a thread record.
- Cancel follows the codex/grok `cancelManaged` protocol: while the owner companion is live, `cancel` only writes the marker the owner consumes and the owner stops its child (process group SIGTERM then SIGKILL, taskkill /T /F on Windows) and finalizes the record; only when the owner is gone does `cancel` itself stop the child through a creation-timestamp-verified identity, mark the job stopped and release its claims. `cancel` never signals a live companion or an unverified pid.
- A lost or cleanup-pending job blocks its thread until `cancel` confirms; `thread locked` after 12 s of held pipes on a clean exit, after which the next step is a new `ask`.
- Request IDs: `--request-id <8 chars>` on every review, task, deep, xhigh, max and ultra call; a repeat never starts a second CLI.

## 8. Platform policy

macOS and Windows are qualified before release; Linux checks are optional and never block (handbook rule). Windows: never launch through cmd.exe (npm shims resolve to their JS entry), process identity by the adapter's ownership evidence, no process query after a clean exit only for provider/launcher pairs the adapter lists as qualified, PowerShell scan otherwise, PowerShell module path set explicitly.

Release gate for 1.0: Codex and Grok qualified on macOS and Windows; Gemini qualified on macOS; on Windows the agy path is either qualified or `setup` reports Gemini unsupported there. gemini-plugin-cc 2.1.0 has never run on Windows (handbook platform table), so retiring it loses no Windows parity.

## 9. Testing

- Fakes for all three CLIs reproducing the event shapes the adapters rely on, ported from the three repositories, plus the error shapes probed today (agy invalid model selection, Grok unknown effort level).
- Every generated slash command's Bash form runs end to end against the fakes, exit codes included.
- `npm test` fails when a command file drifts from the template or the skill exceeds 3,000 B.
- Live contract tests per CLI (`npm run test:live`), run by hand after each CLI upgrade; the README lists what each CLI release must be re-checked for (flags, event names, effort rules, model listing format).
- Fixtures: a root-commit repository and a shallow clone for `--commit`; a Grok session that edited and then receives a read-only reply; two concurrent agy jobs with the same model and effort, to prove the post-exit scan of one never touches the other.
- Target test-source ratio ≥ 1.5×.

## 10. Measurement

`npm run measure` prints per-call framing bytes with the fakes. The footer (section 3) is frozen first; the target is then set from the measured codex-plugin-cc figure (128 B per ask) plus the provider and model/effort fields, and recorded in `docs/measurements/`. Isolation of the plugin AI stays as installed: Grok with skills, agents, hooks and MCP off; Gemini with the deny list and `--sandbox`; Codex MCP `inherit` by default with the measured `off` trade-off stated by `setup`.

## 11. Phases and acceptance

| # | Phase | Done when |
|---|---|---|
| 0 | Scaffold: marketplace, plugin.json, skill stub, command generator, test runner, this plan | `claude --plugin-dir` loads the plugin; `npm test` runs |
| 1 | Capability spike and catalog: for each CLI, startup, terminal events, resume, permission controls, cancel, model listing and effort rules, process-table identity, agy's web tool name, Windows launcher feasibility; `catalog.mjs`, `tiers.mjs`, `models`, `setup` | A one-page record per CLI; the fakes reproduce what the spike saw; `council models` and `council setup` work for all three |
| 2 | Core port from grok-build-plugin-cc 1.1.5 plus codex-plugin-cc's held-pipe wait (args, stdin, jobs, claims, tombstones, thread records, heartbeat, lifecycle, execution, reader, output, git) made provider-neutral; exit-code and review normalization frozen | Core tests pass with a null adapter |
| 3 | Codex adapter: `ask`, `reply`, `review`, `task`, `wait`, `cancel` end to end | Fake and live Codex tests pass; parity checklist vs codex-plugin-cc 2.3.2 |
| 4 | Grok adapter: recipes, compatEnv, review collector, post-exit scan | Parity checklist vs grok-build-plugin-cc 1.1.5 |
| 5 | Gemini adapter: agy runner, deny list, templates and schema reviews, `--adversarial` | Parity checklist vs gemini-plugin-cc 2.1.0 minus the stop gate (Gemini denied → 10; 20 only means still running) |
| 6 | Skill ≤ 3,000 B incl. the fan-out recipe, 11 generated commands, README, CHANGELOG, measurements | Drift and size tests pass; framing measured and recorded |
| 7 | Qualification: macOS live smoke of every command for every provider; Windows session for Codex and Grok (both launchers), agy attempted | Records under `docs/measurements/`; tag `v1.0.0` |
| 8 | Migration: install `council`, run the three plugins' smoke lists through it, uninstall codex, gemini and grok-build | Only `council` installed; handbook comparison gains a council row |

Parity checklist = every verb, flag, footer field and documented caveat of the replaced plugin (stdin deadline, held pipes, PSModulePath, symlink review text, one git start per task), with the exit-code remap and the always-read-only reply recorded as intentional differences.

## 12. Risks

- Catalog drift: `models --refresh` keeps listings current, but a provider can change effort rules between releases; the live tests are the guard, and the README's per-release checklist names what to re-run.
- One skill under 3,000 B for three providers: quirks go into `setup` output and the README, never the skill.
- Windows agy path unqualified; handled by the release gate in section 8.
- Three codebases collapse into one, so a regression in one adapter blocks releases of the others; per-adapter live tests and parity checklists are the guard.
- Clamping changes what the user asked for; it is always visible in the footer and JSON.

## 13. Review record

Round 1 sent the draft and six questions to all three models at once; round 2 sent each model the resolutions (AGREE/CHANGE/REJECT per finding) plus the live agy and Grok probes as new facts, and asked only for remaining objections.

### Codex gpt-6.1-sol (xhigh), 14 findings

| # | Sev | Finding | Resolution |
|---|---|---|---|
| F1 | MINOR | Keep `--to`; define resolution rules; replies lock the provider | CHANGE: `--to` required, inference dropped (Grok F1) |
| F2 | MAJOR | Shared effort vocabulary with downward clamp; report clamp; drop or isolate `ultra` | AGREE; `ultra` codex-only pass-through |
| F3 | MAJOR | Suffixed Gemini id is an explicit effort; conflicting flags rejected; keep argon/medium consult | AGREE on precedence (probe confirmed agy errors); CHANGE tiers to argon/high consult |
| F4 | BLOCKER | Parallel panel contradicts "one CLI process per turn" | CHANGE: no coordinating process in 1.0; Claude fans out N background asks (section 6) |
| F5 | MAJOR | Panel needs member specs, manifest, per-member cancel/replay | AGREE as 1.1 requirements (section 6) |
| F6 | MAJOR | Shared storage fine; scope `--last`/wait/cancel by session; provider-namespaced threads; realpath hashing | AGREE; single state root with session + cwd scoping (Gemini F5) |
| F7 | MAJOR | Pruning vs replay: tombstones, thread metadata apart, "expired" response, never prune live jobs | AGREE; tombstone written after preparation (Grok F8) |
| F8 | MAJOR | Replies must not inherit edit mode | AGREE |
| F9 | MAJOR | Grok recipes (`--agent explore`, RESUME_DENY, compatEnv) and env overrides missing | AGREE |
| F10 | MAJOR | Ownership evidence is adapter-specific; trust clean exits only for qualified pairs | AGREE (section 5.1, 8) |
| F11 | MAJOR | Normalize review outcomes; implement `--commit` for collected diffs | AGREE; round 2 REJECT of `git diff <sha>^ <sha>` for root commits → `git diff-tree --root` adopted |
| F12 | MAJOR | Restore `--deadline` vs `--inactivity-timeout` vs wait `--timeout`; print_timeout is incomplete | AGREE |
| F13 | MAJOR | `--worktree` has no lifecycle | AGREE: removed from 1.0 |
| F14 | MAJOR | Capability spike first; Windows agy must not be hand-waved | AGREE on the spike (phase 1); CHANGE on Windows agy: gate in section 8, since gemini-plugin-cc never ran on Windows |

Round 2: no objections beyond F11's root-commit case.

### Grok 4.7 (xhigh), 12 findings

| # | Sev | Finding | Resolution |
|---|---|---|---|
| F1 | MAJOR | Drop prefix inference; `--to` required; aliases per provider | AGREE |
| F2 | BLOCKER | Reply stays read-only after task | AGREE |
| F3 | MAJOR | Forward only mapped flags: `--web` gemini → exit 2; drop `--worktree`; `--commit` not implemented for gemini/grok; no shared panel `--model` | AGREE except `--commit`: CHANGE to implement via collected diff; round 2 REJECT of `diff <sha>^` → `git diff-tree -p --root --no-color --no-ext-diff <oid>` after `^{commit}` resolution, adopted |
| F4 | MAJOR | Downward clamp only, clamp as footer field, `ultra` codex-only, freeze footer before measuring | AGREE |
| F5 | MAJOR | Do not rewrite agy ids; exit 2 on conflicting suffix/effort; do not clamp until verified | CHANGE: verified today, agy rejects xhigh/max and conflicts, so clamp to high with footer note; conflict → exit 2 |
| F6 | MAJOR | Gemini tiers consult argon/high, exec flash/high, deep argon/high | AGREE |
| F7 | BLOCKER | One child per companion; fan-out is N background asks; cross-critique 1.1 | AGREE (section 6) |
| F8 | MAJOR | Per-workspace dir with session filter; provider-prefixed claims; 16-char ids; cap 100; never prune live jobs | AGREE except the directory: a single root with lazy git root, so no git spawn per call (Gemini F5); round 2 REJECT of claim-time tombstones → tombstone after preparation, adopted |
| F9 | BLOCKER | Grok argv cannot finish a read-only turn without `--agent explore`/RESUME_DENY; port compatEnv and depth guard | AGREE |
| F10 | MAJOR | Gemini has no rules flag (prepend contract); reviews need templates and `--adversarial`; print_timeout exits 0 and must map to 1 | AGREE |
| F11 | MAJOR | Schema carrier differs per adapter | AGREE |
| F12 | MAJOR | Freeze exit-code remap (gemini denied → 10) and catalog location before adapters; `codex debug models` exists; phase gates consistent | AGREE; `codex debug models` verified and used by `models --refresh` |

### Gemini 4 Argon (high), 8 findings

| # | Sev | Finding | Resolution |
|---|---|---|---|
| F1 | MAJOR | Keep `--to`; alias-before-prefix order; no shared panel `--model`; restore `--deadline`, add `--uncommitted`, implement `--commit`, drop `--worktree`; Gemini `--web` via the deny list | AGREE; inference dropped outright; Gemini `--web` mapped through the deny list once the phase-1 spike confirms agy's web tool name, else exit 2 |
| F2 | MINOR | Shared vocabulary fails less than pass-through; `ultra` contradiction; compact footer clamp `model/high<=xhigh` | AGREE; compact form adopted; `ultra` codex-only pass-through |
| F3 | MAJOR | Double-suffix hazard (`gemini-4-argon-high-medium`); `setup` must validate resolved ids; keep consult argon/medium | AGREE on suffix handling and setup; REJECT on consult medium (consult stays argon/high so Gemini is not the only medium vote in a fan-out); accepted in round 2 |
| F4 | MAJOR | One coordinating panel process; parent job; duplicate signal handlers and concurrent prune hazards; ambiguous `--last` | CHANGE: fan-out by Claude in 1.0 (section 6); the hazards become the 1.1 `panel` requirements; `--thread` after a fan-out |
| F5 | BLOCKER | `cancel` must not kill a live companion; thread metadata apart from job bodies; workspace hash forces a git spawn per call; `--session` missing from the template | AGREE in full: cancelManaged protocol, thread records, single state root with lazy git root, `--session` in the template |
| F6 | BLOCKER | agy has no job-specific argv for ownership; deny JSON in section 2 malformed; no Gemini contract carrier | AGREE: per-job `--settings <job-dir>/settings.json`, identity recorded at spawn, JSON corrected, contract prepended to the prompt |
| F7 | BLOCKER | Reply inheriting edit mode; Grok `agent` not persisted; no `env` in buildTurn | AGREE |
| F8 | MAJOR | Core baseline should be grok-build 1.1.5 plus codex's pipe wait; PowerShell inline, no .ps1; per-adapter line cap; catalog and agy pin earlier | AGREE |

Round 2: no objections.

### Where the reviewers disagreed with each other

- Fan-out: Codex and Gemini preferred one coordinating process; Grok preferred N single-child calls. Decision: Grok's for 1.0, with the coordinating design recorded as 1.1 requirements; all three accepted.
- Gemini consult tier: Gemini and Codex preferred argon/medium, Grok argon/high. Decision: high; all three accepted.
- `--commit` on collected-diff reviews: Grok first proposed exit 2, Codex and Gemini implementation. Decision: implement with `git diff-tree --root`; all three accepted.
