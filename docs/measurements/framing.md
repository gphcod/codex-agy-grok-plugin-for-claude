# Framing bytes per call (S6.5)

Measured 2026-11-01 on macOS (Darwin 27.0.0), Node 22.19.0, branch `s6` at the S6.4 commit plus `scripts/measure.mjs`, with `npm run measure`. The script runs one `ask --to <p> --session <id> -- Reply with pong` per provider against the fakes in a temporary sandbox, without and with `--request-id`. The fakes are those of `tests/fixtures/three-providers.mjs`: wrapped fakes and a trap `PATH`, so no real CLI starts. Framing is everything the host reads around the answer: the start line on stderr plus the footer line on stdout, newlines included. Bytes are UTF-8; each `·` separator is 2 B.

| Provider | Start line | Footer | Framing per ask | With `--request-id` |
|---|---|---|---|---|
| codex | 90 B | 112 B | **202 B** | 202 B |
| gemini | 91 B | 116 B | **207 B** | 207 B |
| grok | 89 B | 108 B | **197 B** | 197 B |

The skill is 2,998 B, and its description is 181 B (limit 3,000 B, enforced by `tests/skill-size.test.mjs`). The eleven command files are 919–1,693 B each after S6.8 (867–1,074 B at S6.5), and are read only when the user runs one.

The lines measured (job and thread ids vary per run; their lengths do not):

```text
[council] provider=codex job=1nbqnla0uo17dx7w thread=53a30899-27ac-4919-826b-65c23dc42179
council codex ok · job 1nbqnla0uo17dx7w · gpt-6.1-sol/high · 0s · round 1/9 · next: reply 1nbqnla0uo17dx7w
```

A request id does not change the framing. Only a replay adds ` replay=<id>` to the start line. A longer duration (`12s`, `1m 5s`) adds 1–4 B.

## Historical figure and target

- **Historical figure.** codex-plugin-cc measured **128 B** of non-answer output per ask. Source: github.com/gphcod/handbook `agent_plugin_design_comparison.md` (edition 2026-10-30, commit `e9ad313`), host-context table, "Overhead the host reads per call (excluding the answer)". 2.2.2 shortened the start line and footer (185 → 128 B). Per-call output was last measured for the 2.3.0 runtime on 2026-10-16, and 2.3.1/2.3.2 keep that runtime. The same table gives grok-build-plugin-cc 1.1.5 164 B (176 B with `--request-id`).
- **Target** (PLAN.md S6.5): 128 B plus the provider and model/effort fields:

  | Provider | Provider field (`provider=<p> `) | Model/effort field (` · <model>/<effort>`) | Target | Measured | Over |
  |---|---|---|---|---|---|
  | codex | 15 B | 20 B (`gpt-6.1-sol/high`) | 163 B | 202 B | +39 B |
  | gemini | 16 B | 23 B (`gemini-4-argon/high`) | 167 B | 207 B | +40 B |
  | grok | 14 B | 17 B (`grok-4.7/high`) | 159 B | 197 B | +38 B |

**The target is not met.** Every byte of the excess comes from fields the frozen A3.4 footer grammar (S2 freeze) requires. Rendered on the same codex job, codex-plugin-cc 2.3.2's lines (`[codex] job=… thread=…`, `-- codex ok · 0s · next: reply …`) come to 123 B (73 + 50). Against them, council adds:

| Field council adds | Bytes |
|---|---|
| `provider=codex ` | 15 |
| ` · gpt-6.1-sol/high` | 20 |
| ` · job <16 chars>`: the donor named the job only in its follow-up | 24 |
| ` · round 1/9`: the donor printed a round on `reply` only | 13 |
| `council ` instead of `-- ` | 5 |
| `[council]` instead of `[codex]` | 2 |

123 + 79 = 202 B, the measured figure. Shortening the framing to the target would mean dropping the always-present job id, or the round on fresh threads, from the footer. Either is a change to the frozen grammar, which needs a decisions entry and a review (S2 freeze). This record does not make that change.

## Isolation settings as installed

- **Codex.** MCP policy `inherit` (the default). `ask`, `reply` and `review` keep the user's MCP servers, plugins and apps. `COUNCIL_CODEX_MCP=off` drops them there, at the cost of one or two `codex mcp list --json` calls per such turn (decisions S1). Read-only turns use `-s read-only`; `reply` resumes with `-c sandbox_mode=read-only`; tasks use `workspace-write`; reviews use `exec review -c sandbox_mode=read-only`.
- **Gemini (agy).** A per-job `--settings` file on every turn holds the user's global `allow`/`ask`/`deny` lists, merged. Read-only turns filter `allow` to `read_file(...)`/`read_url(...)` and add the deny list `write_file(*)`, `edit_file(*)`, `command(*)`, `unsandboxed(*)`, `mcp(*)`, `execute_url(*)`. `--sandbox` is on every turn, and `--mode accept-edits` is passed only on tasks. Web search (`search_web`) cannot be denied, so `--web` exits 2.
- **Grok.** `compatEnv`: `GROK_DISABLE_AUTOUPDATER=1`, `GROK_CLAUDE_SKILLS_ENABLED=0`, `GROK_CLAUDE_AGENTS_ENABLED=0`, `GROK_CLAUDE_HOOKS_ENABLED=0`, `GROK_CLAUDE_MCPS_ENABLED=0`, and `GROK_CLAUDE_RULES_ENABLED=0` on read-only turns (unset on tasks). Every turn passes `--no-auto-update --always-approve --no-subagents --disallowed-tools <HOSTILE>`, plus `--disable-web-search` unless `--web`. Read-only turns add `--agent explore` (or the RESUME_DENY list after a task) and `--deny MCPTool(*)`. Tasks add `--deny "Bash(git push*)" --deny "Bash(rm -rf *)"`. The reader fails a read-only turn closed when a writing tool is advertised or called.
- **All three.** Every child, and every probe, gets `COUNCIL_DEPTH`, `CODEX_COMPANION_DEPTH`, `GROK_BUILD_DEPTH` and `CLAUDE_PLUGIN_CODEX_DEPTH`.
