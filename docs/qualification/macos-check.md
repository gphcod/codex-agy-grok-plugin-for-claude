# macOS check (2026-11-01)

Mac mini "jef", macOS Darwin 25.6.0 (Apple Silicon), Node 24.21.0. codex-cli 0.163.0 with MCP servers configured, agy 1.4.12 freshly installed with default settings, grok 1.0.70, Claude Code 2.1.305.

## Tests

`npm test` passes; skips are only what this file system refuses (raw-byte file names) or Windows-only cases.
`npm run test:live` passes against the real CLIs.

## Real CLIs, from the installed plugin's scripts

For each provider: `ask`, `reply --last`, `review --uncommitted` (a planted bug; file names with a space and a tab), a read-only turn asked to write (nothing written), `task` (fix applied, `edited 1`), `cancel` of a streaming turn, a hard-killed companion recovered by `cancel`, bare `wait`, `models`, `setup`. The working directory was reached through the `/tmp` symlink on purpose.

## In-chat route

`claude -p` with `--plugin-dir`: `/council:codex`, `/council:gemini`, `/council:ask --to grok`, `/council:setup` and a natural-language request naming council.

## What this check found

- `cleanup pending` on a finished turn: 6 of 12 repeated Codex asks failed with their answer intact, because Codex's MCP servers were still exiting; 12 of 12 pass after the fix.
- A fresh agy denied every read and edit in a folder reached through a symlink, because agy trusts `PWD` for its workspace root.

## Not checked

Claude Code 2.1.314, the version council is qualified against: this Mac has 2.1.305, and `setup` warns about it.
