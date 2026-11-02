# Windows check (2026-11-01)

Windows 11 Enterprise 10.0.26200, Node 22.19.0, Git for Windows, PowerShell 5.1. agy 1.4.12, grok 1.0.70, codex-cli 0.166.0.

## Tests

`npm test`: all tests pass or are skipped for the platform reasons below.

## Real CLIs, from the installed plugin's scripts

`setup`, `ask` on codex, gemini and grok; `review` on grok.

## agy read-only and cancel (S7.2's Gemini attempt)

The global `toolPermission` here is `always-proceed`, so the turn's own settings file is what restricts a read-only turn.

- A read-only turn asked to create a file, edit a file and run `whoami`: all three denied by the deny rules (exit 10, footer names the denial), and no file changed.
- `task` created the file it was asked to, `edited 1`.
- `cancel` on a streaming turn: 3 s, `cancelled`, no `agy.exe` left; ownership by the `--settings` operand works on the Windows command line.
- `reply` resumes the conversation; `review` returns structured output.

## Windows behaviour worth knowing

- libuv puts non-detached children in a kill-on-close job object, so a hard-killed companion takes its provider child with it. Only a detached process outlives it. `cancel` still confirms cleanup and releases the claim.
- Tests for what Windows lacks are skipped by platform: file names with a tab, newline or quote; FIFOs; `chmod` removing read access; POSIX signals, process groups and exec bits; symlinks without Developer Mode.

## Inside a Claude Code chat

New headless sessions at 1.0.0-rc.4 (2026-11-02), which have no Bash tool under `CLAUDE_CODE_USE_POWERSHELL_TOOL=1`: `/council:ask` and the skill wrote the text to a file and ran `--input-file` through PowerShell, with quotes, `$HOME` and non-ASCII intact. `/council:setup`, `models`, `codex`, `grok`, `review` and `wait` ran there at 1.0.0-rc.2.

## Not checked

The npm grok shim, and `allowed-tools` under default permissions (this machine runs `bypassPermissions`).
