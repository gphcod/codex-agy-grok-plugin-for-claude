# S7.2 Windows matrix

Date 2026-11-02. Windows 11 Enterprise 10.0.26200, Node 22.19.0, Claude Code 2.1.314, codex-cli 0.166.0, agy 1.4.12, grok 1.0.70. The direct calls ran at `main` 4d7bc18 (1.0.0-rc.5); the sessions under default permissions ran the commands as changed for 1.0.0-rc.6. This is the headless route. The interactive app is not part of this record.

## Launchers

From `where.exe codex grok agy` and `Get-Command`. `setup` reported each kind below.

| Provider | Launcher | Selected by | Kind | Processes of a turn |
|---|---|---|---|---|
| codex | `D:\Apps\node-v22.19.0\codex.cmd` | `PATH` | shim-native | `codex.exe` |
| codex | the vendor `codex.exe` behind that shim | `COUNCIL_CODEX_BIN` | native | `codex.exe` |
| codex | `@openai/codex/bin/codex.js` | `COUNCIL_CODEX_BIN` | node-script | `node.exe`, `codex.exe` |
| grok | `%USERPROFILE%\.grok\bin\grok.exe` | `PATH` | native | `grok.exe` |
| grok | `grok.cmd` from `@xai-official/grok` 1.0.70 | `COUNCIL_GROK_BIN`, and first on `PATH` for `setup` | shim-node | `node.exe`, `grok.exe` |
| gemini | `%LOCALAPPDATA%\agy\bin\agy.exe` | `PATH` | native | `agy.exe` |

The npm shim was installed into a scratch prefix with `npm install -g --prefix <scratch> --ignore-scripts --omit=optional`. The package's `postinstall` would otherwise rewrite `~/.grok/bin` and `~/.grok/config.toml`. Its launcher then runs the existing `~/.grok/bin/grok.exe`. SHA-256 sums of that binary and that config were the same before and after every run.

## Matrix

Each cell: expected exit / observed exit / job id. Direct companion calls with `--session` and `--effort low`, not slash commands; those are covered under "Default permissions". Each column had its own scratch repository: a base commit on `main`, branch `feature` with two buggy commits (`stats.js`, `max.js`), one uncommitted bug (`calc.js`), and its own `COUNCIL_HOME`. Tasks ran in a separate copy.

| Row | codex `codex.cmd` (shim-native) | codex `codex.exe` (native) | grok `grok.exe` (native) | grok `grok.cmd` (shim-node) | gemini `agy.exe` (native) |
|---|---|---|---|---|---|
| `ask` | 0 / 0 / `gixqc49dg176j1x2` | 0 / 0 / `u0tgl12r97vuzroi` | 0 / 0 / `0xlcf4rx4nttxap6` | 0 / 0 / `ad7qve8cnb726zbe` | 0 / 0 / `b48mwep2e8msykky` |
| `reply --last` | 0 / 0 / `6e6ck31jvwd6fcp9` (round 2/9) | 0 / 0 / `0ygjw4scmo3cgeze` (round 2/9) | 0 / 0 / `qnr0o8kh40848hip` (round 2/9) | 0 / 0 / `1zl1lh7o04ipe93b` (round 2/9) | 0 / 0 / `lelikyoxglrmln41` (round 2/9) |
| `reply --thread` | 0 / 0 / `0mtqasxuac1o0oz6` (round 3/9) | 0 / 0 / `h802va50c71sc40u` (round 3/9) | 0 / 0 / `a5cf1knjz8v6qjld` (round 3/9) | 0 / 0 / `apxa0c0jumiyl508` (round 3/9) | 0 / 0 / `flhhueag8lbv86yq` (round 3/9) |
| `review --uncommitted` | 10 / 10 / `d6dpe4argyx6x1aq` | 10 / 10 / `pacn9o9wce0h6get` | 10 / 10 / `2fcstp5kyol8z3ei` | 10 / 10 / `e1ohuzl9x4wdm4mi` | 10 / 10 / `wx4wun9s9enzx1ix` |
| `review --base main` | 10 / 10 / `swrjut9af47n10tl` | 10 / 10 / `rhz9sy8forlpc9az` | 10 / 10 / `7n7t2xlg4gyuaonr` | 10 / 10 / `2h4z8vm5h3j9a2va` | 10 / 10 / `lkhxcbvm037zyder` |
| `review --commit` | 10 / 10 / `x2sobxmc3a27160l` | 10 / 10 / `2bhi77v76douzfxy` | 10 / 10 / `9as8qnjh4i4tlmq5` | 10 / 10 / `1l0fd9zo1tq4oois` | 10 / 10 / `ybbdyxobox380j0m` |
| `review --uncommitted --adversarial` | 2 / 2 | 2 / 2 | 10 / 10 / `svhe0if80bi69t0o` | 10 / 10 / `0wbomalyo95j6rbk` | 10 / 10 / `gld6r2ejd0kumc7d` |
| `review --base` with focus text | 10 / 10 / `6qm5bss45jurw878` | 10 / 10 / `ll2ecgoa16pnw14y` | n/a | n/a | n/a |
| `review --uncommitted` from a subdirectory | 10 / 10 / `couukng8cjw1wlwi` | 10 / 10 / `a9c6m0myxuadi0go` | 10 / 10 / `rxd0yl8y6m3k4ht2` | 10 / 10 / `q6o2ye0wyava8jpy` | 10 / 10 / `swuu3typs0j3tkqj` |
| read-only ask told to write | 0 or 1 or 10 / 0 / `v98pjafj73012pf0` (nothing written) | 0 or 1 or 10 / 0 / `dme6jw423v2rbrz7` (nothing written) | 0 or 1 or 10 / 0 / `0dhqknconov3hjdf` (nothing written) | 0 or 1 or 10 / 0 / `hcidt4gtxz83u6l7` (nothing written) | 0 or 1 or 10 / 10 / `jna32ngi065pttvx` (nothing written) |
| task (authorized, scratch tree) | 0 / 0 / `hxp2ygposwxqhngd` (`edited 1`) | 0 / 0 / `zptn9bja513omffv` (`edited 1`) | 0 / 0 / `xiy1yyhr30m77dlb` (`edited 1`) | 0 / 0 / `p0f5lyg9svpmebt7` (`edited 1`) | 0 / 0 / `ij04qg9kj6kheh3m` (`edited 1`) |
| `wait` (bare list) | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| `wait <job>` (replay) | 0 / 0 / `gixqc49dg176j1x2` | 0 / 0 / `u0tgl12r97vuzroi` | 0 / 0 / `0xlcf4rx4nttxap6` | 0 / 0 / `ad7qve8cnb726zbe` | 0 / 0 / `b48mwep2e8msykky` |
| `cancel <job>` | 0 / 0 / `2wfhm4gw3lcuuybf` (codex.exe stopped) | 0 / 0 / `pmoo9mr1cbpnk5nx` (codex.exe stopped) | 0 / 0 / `3huryg2dxz3zgio6` (grok.exe stopped) | 0 / 0 / `5kg6xvfkudql5ypy` (node.exe + grok.exe stopped) | 0 / 0 / `ipg2keop58vee4wp` (agy.exe stopped) |
| hard-killed companion, then cancel | 0 / 0 / `83zdly9f2rbwa0ao` (left: none) | 0 / 0 / `tumqgfxmgaur5mdr` (left: none) | 0 / 0 / `nxd3echa7ek02cp1` (left: none) | 0 / 0 / `hfal3mo1xqudahz2` (left: none) | 0 / 0 / `onqe73ndv4z0pkex` (left: none) |
| `models --refresh` | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| `setup` | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

`codex.js` subset (node-script): `ask` 0 / 0 / `7v9mjlkfmmy0lblh`; `cancel <job>` 0 / 0 / `sbd7vquwry04rihx`, stopping `node.exe` and `codex.exe`; hard-killed companion, then `cancel` 0 / 0 / `a3tm0ydela9qiymg`, leaving none; `setup` 0 / 0.

86 cells, 86 pass.

Every review named the planted file it was pointed at: `calc.js` for the working tree, `stats.js` for the commit, and all three for `--base`, including with focus text. The subdirectory reviews ran without a denial. `task` changed `calc.js` in every column.

For `cancel` and the hard kill, a separate query of `Win32_Process` for the job id found the listed processes running first and none afterwards. A killed companion took its provider with it, including the `node.exe` and `grok.exe` pair behind the npm shim, and `cancel` then recovered the job.

## Default permissions

`claude -p --permission-mode default --setting-sources project --plugin-dir <plugin> --model sonnet`, in a scratch repository. User settings are left out, so only the plugin's `allowed-tools` can grant a tool. Follow-ups resumed the `ask` session. "Denied first attempt" means the model's own first try, not the command's form. Each session then ran the form and reached the result below.

| Command | Bash tool (`CLAUDE_CODE_USE_POWERSHELL_TOOL=0`) | PowerShell tool (Windows PowerShell 5.1) |
|---|---|---|
| `/council:setup --to grok` | ran | ran |
| `/council:models --to grok` | ran | ran, 1 denied first attempt |
| `/council:ask --to grok --effort low …` | ran, `954740f2c23ace96` | ran, `a4138fbfa58fc34e`, 1 denied first attempt |
| `/council:reply --last …` | ran, `3c3304f9dc50c0c0` | ran, `3bcc15c8d0b41ffe` |
| `/council:wait` | ran | ran |
| `/council:codex --effort low …` | ran, `6507ce76834fdee9` | ran, `6a57c97ca9019358`, 1 denied first attempt |
| `/council:gemini --effort low …` | ran, `2301b017b23b9cc1` | ran, `d4d10f1417f07d7f`, after a first call raced its own `Write` (exit 2, no job) |
| `/council:grok --effort low …` | ran, `881e092248d9c8f4` | ran, `fe7c4f6dd820cb61`, 1 denied first attempt (`$env:TEMP` in the path) |
| `/council:ask --to grok -v` | exit 2, nothing started | exit 2, nothing started |
| `/council:review --to grok --uncommitted --effort low` (background) | ran, exit 10 reported | ran, exit 10 reported |
| `/council:task --to grok --effort low …` (background) | ran, `calc.js` fixed | ran, `calc.js` fixed; 1 denial of the model's own `Select-String` |
| `/council:cancel` | ran, nothing to cancel | ran, nothing to cancel |

Eight more PowerShell sessions on `--model opus` (`ask` three times, `codex`, `gemini` twice, `review`, `setup`) all used `Write`, then the one statement, and none put the arguments in a PowerShell call. One of them first tried to look up the temp path in PowerShell, was refused, and went on. A background `review` with nothing to review reported `exited with code 2`.

## What this found

- **The PowerShell form needed approval. Fixed in 1.0.0-rc.6.** `node "…/council.mjs" … "--input-file=<file>"; exit $LASTEXITCODE` was refused under `PowerShell(node:*)`: `This PowerShell command contains multiple operations. The following part requires approval`. The same call as one statement runs, and the tool reports the native exit code itself (`Exit code 2`, `Exit code 3`, on 5.1 and on 7). So the `exit` is gone from the commands and the skill. In an interactive session the old form would have prompted on every call.
- **Store `pwsh` fails Claude Code's parser under default permissions, with or without this plugin.** With the Microsoft Store build of `pwsh` 7.6.9 on `PATH`, every PowerShell tool call fails before it runs, even `node --version` in a session with no plugin: `pwsh exited with code 1: The command line is too long`. It is not a plain argument limit: `pwsh -EncodedCommand` with a 32,000-character argument runs from Node. The cause is not known. Both workarounds were checked: Windows PowerShell 5.1 (Store `pwsh` off `PATH`) and the Bash tool (`CLAUDE_CODE_USE_POWERSHELL_TOOL=0`, with `CLAUDE_CODE_GIT_BASH_PATH` set). Sessions under `bypassPermissions`, as on this machine, are not affected.
- **A natural-language request through the skill asks for approval under default permissions.** The skill grants no tools, unlike the slash commands, so its `node` call and a `Write` outside the workspace each need approval (`This command requires approval`). That is the intended control, not a defect.
- **Sonnet sometimes puts the arguments in the PowerShell call first.** It did so in 6 of 14 sessions, against the command's wording, as a compound call (`$f = …; [IO.File]::WriteAllText(…); node …`), as a here-string piped to `node`, or as flags on `node`'s own arguments. Default permissions refused the compound calls and here-strings, and it then used `Write`; a call carrying only flags ran, which is harmless. A stronger wording did not change the rate (3 of 8), so it was not kept. Opus did this in 0 of 8. Under `bypassPermissions` nothing would refuse those calls, so this remains a gap on models that ignore the instruction: the plugin can state the rule but cannot enforce it.
- **`setup` said Grok was not logged in once, through the shim.** It did not recur in 5 further runs. `~/.grok/auth.json` was rewritten at the same moment, so this is probably Grok printing that while it refreshed an expired token (an inference). A second `setup` is correct.

## Not checked

The interactive app under default permissions; the shim-node kind for Codex, because its shim always finds the vendor `codex.exe` here (`codex.js` ran as node-script instead); and macOS at this version.
