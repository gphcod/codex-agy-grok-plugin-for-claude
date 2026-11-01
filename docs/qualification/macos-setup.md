# macOS live all-provider check (S6.6)

Run once by hand on 2026-11-01 at 14:12 UTC. Host: macOS (Darwin 27.0.0), Node 22.19.0, branch `s6` at the S6.5 commit (`eea7ced`), from the repository root. `COUNCIL_HOME` was a scratch directory, so the user's `~/.council` was not touched. The real CLIs were the first on `PATH`:

- `codex-cli 0.163.0` at `/opt/homebrew/bin/codex`
- agy `1.4.12` at `/Users/cia/.local/bin/agy`
- `grok 1.0.70` at `/Users/cia/.grok/bin/grok`

No `COUNCIL_*` or guard variable was set. Only the two commands below ran: no model turn, and no other live call. Both report all three providers.

## `node plugins/council/scripts/council.mjs models --refresh </dev/null`

Exit 0, 4.0 s wall clock, stderr empty. The refresh ran each provider's probe once: `codex --version`, `codex login status` and `codex debug models`; `agy --version` and `agy models`; `grok --version` and `grok models`. It wrote `catalog/{codex,gemini,grok}.json` under the scratch home.

```text
codex (refreshed, refreshed 2026-11-01T14:12:30.151Z)
  gpt-6.1-sol: low, medium, high, xhigh, max, ultra
  gpt-6-astra: low, medium, high, xhigh, max, ultra
  gpt-6-chat-thinking: low, medium, high, xhigh, max
  gpt-6.1-terra: low, medium, high, xhigh, max, ultra
  gpt-6-sol: low, medium, high, xhigh, max, ultra
  gpt-reserve: low, medium, high, xhigh, max
  gpt-6-luna: low, medium, high, xhigh, max
  gpt-5.6-sol: low, medium, high, xhigh, max, ultra
  gpt-5.6-terra: low, medium, high, xhigh, max, ultra
  gpt-5.6-luna: low, medium, high, xhigh, max
  codex-auto-review: low, medium, high, xhigh, max
  tiers: consult gpt-6.1-sol/high · exec gpt-6-luna/max · deep gpt-6.1-sol/xhigh
gemini (refreshed, refreshed 2026-11-01T14:12:32.550Z)
  gemini-4-argon: low, medium, high
  gemini-3.8-flash: low, medium, high
  gemini-4-argon-medium: medium
  gemini-4-argon-high: high
  gemini-4-argon-low: low
  gemini-3.8-flash-high: high
  gemini-3.8-flash-medium: medium
  gemini-3.8-flash-low: low
  tiers: consult gemini-4-argon/high · exec gemini-3.8-flash/high · deep gemini-4-argon/high
grok (refreshed, refreshed 2026-11-01T14:12:33.493Z)
  grok-4.7: low, medium, high, xhigh
  grok-4.7-build-fast: low, medium, high, xhigh
  grok-4.6: low, medium, high, xhigh
  grok-4.5: low, medium, high, xhigh
  tiers: consult grok-4.7/high · exec grok-4.7-build-fast/xhigh · deep grok-4.7/xhigh
```

## `node plugins/council/scripts/council.mjs setup </dev/null`

Exit 0, 2.5 s wall clock, stderr empty. All three providers are ready. Each catalog row reads the refreshed listing written by the previous command.

```text
codex: ready · /opt/homebrew/bin/codex (native) · codex-cli 0.163.0 · logged in
  catalog: refreshed (2026-11-01T14:12:30.151Z)
  tiers: consult gpt-6.1-sol/high · exec gpt-6-luna/max · deep gpt-6.1-sol/xhigh
  note: mcp: inherit (default): ask, reply and review keep your MCP servers, plugins and apps; COUNCIL_CODEX_MCP=off would drop them there: measured 19-29% fewer input tokens on a fresh ask, for one or two `codex mcp list` runs before each such call (about 155-195 ms with native codex.exe on Windows, 300 ms with npm's codex.js; about 90-100 ms on macOS)
gemini: ready · /Users/cia/.local/bin/agy (native) · 1.4.12 · logged in
  catalog: refreshed (2026-11-01T14:12:32.550Z)
  tiers: consult gemini-4-argon/high · exec gemini-3.8-flash/high · deep gemini-4-argon/high
  note: web search stays available on read-only turns: agy's search_web tool ignores a search_web(*) deny rule (S1.2), so --web --to gemini exits 2 rather than pretending to switch it
grok: ready · /Users/cia/.grok/bin/grok (native) · grok 1.0.70 (f50904eaee6c) [stable] · logged in
  catalog: refreshed (2026-11-01T14:12:33.493Z)
  tiers: consult grok-4.7/high · exec grok-4.7-build-fast/xhigh · deep grok-4.7/xhigh
  note: every turn ends with a process scan for anything still carrying the job's --prompt-file (no launcher kind is trusted to leave nothing behind)
  note: read-only turns run the explore agent (RESUME_DENY after a task), deny MCP tools and fail closed if a writing tool is advertised; web search is off unless --web
  note: reviews run at the repository root (grok sessions refuse --add-dir) and answer in the inline review schema
  warning: 2 grok executables on PATH; the first one runs
```

## Findings

| Provider | Setup line |
|---|---|
| codex | `codex: ready · /opt/homebrew/bin/codex (native) · codex-cli 0.163.0 · logged in`. MCP note: `inherit` (default). The listing has 11 models, the same ids as `docs/spike/codex-models.json`, with `ultra` on the sol, terra and astra families. |
| gemini | `gemini: ready · /Users/cia/.local/bin/agy (native) · 1.4.12 · logged in`. Web-search note. No tier warning: every resolved suffixed tier id is listed. Both families are listed with low, medium and high. |
| grok | `grok: ready · /Users/cia/.grok/bin/grok (native) · grok 1.0.70 (f50904eaee6c) [stable] · logged in`. Three notes, plus `warning: 2 grok executables on PATH; the first one runs`, the same as S4.6 (`~/.grok/bin/grok` and `~/.local/bin/grok`). Four models with low to xhigh. |

The resolved tiers equal `tiers.json` for all three providers. The live listings match the S1 captures in `docs/spike/`.

The `models` header reads `codex (refreshed, refreshed <time>)`. This is a cosmetic repetition in the core's `runModels`: the catalog source is `refreshed`, and the timestamp is printed with the same word. It is recorded here and was not changed in S6, which may change core code only for a defect that S6.0 exposes.
