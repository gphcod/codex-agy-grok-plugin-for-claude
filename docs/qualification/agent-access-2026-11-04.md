# Native adviser access — 1.0.3

Windows qualification on 2026-11-04. Efficiency is the highest priority; cooperating agents are assumed to act in good faith. Advice/review scope is expressed in each turn's instructions. Native tools, configured integrations, web search and automatic approvals remain available without plugin tool or directory restrictions. User settings files are not rewritten.

The twin shares the access correction with Council for Codex 1.1.9. Both live checks read the first line of `LR/demand_tool/pure_demands.py` and `7DaySchd/SWP_OP_dev/SWP_OP_YYYYMMDD/scripts/plot_lr_demand_chart.py` exactly, without permission denials or edits:

| Provider | Model / effort | Job | Result |
| --- | --- | --- | --- |
| Codex | gpt-6-luna / low | `2b0d47ccba9b847c` | Both files read, exit 0 |
| Gemini | gemini-3.8-flash / low | `2fc215ad75a038a3` | Both files read, exit 0 |

A native Grok probe resumed an existing explore session with `--agent default`, then read both files. Both adapters use that upgrade for legacy sessions. Independent source review approved the launch changes after correcting missing advice/task instructions and actual failed-tool denial reporting. Regression tests retain explicit user configuration, failed provider events, request deduplication, deadlines and owned-process cleanup.

These are Windows results. No new macOS or interactive qualification is claimed. Native OS and organization permissions are outside plugin control.

Validation: the full 562-test run had 538 passing, 23 skipped and one stale web-default expectation. The corrected Grok tests plus the new failed-tool regression passed all 39 focused checks: 540 passing tests in the final tree, with the same 23 platform/live skips. Generated commands, whitespace and line-ending checks passed.
