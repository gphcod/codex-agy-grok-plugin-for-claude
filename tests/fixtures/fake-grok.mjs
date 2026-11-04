#!/usr/bin/env node
// Fake `grok` 1.0.70. Validates the A5.1 launch contract (recipes from grok-build-plugin-cc
// lib/recipes.mjs, compatEnv variables, prompt file, inline schema), then replays streams shaped
// like the S1.3 captures in tests/fixtures/streams/grok (provenance.json names each probe).
// Scenarios: ok, resume, denied (a forbidden tool call on a read-only turn; Grok has no denial
// event, the adapter fails closed), effort-error (S1.3 effort-max), review-findings (S1.3
// json-schema), review-malformed (synthetic), slow, hold-pipes. Grok-only knobs (synthetic):
// COUNCIL_FAKE_GROK_ADVERTISE, COUNCIL_FAKE_GROK_EDIT, COUNCIL_FAKE_GROK_CWD (expected --cwd).
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { sep } from "node:path";
import {
  deepEqual, emit, expectContract, expectInJobDir, expectPrompt, fail, holdPipes, parseArgs, printAndExit, readRepoSchema, readSpike, readStdin, readStreamFixture, requireGuards, scenario, sleep, slowMs, wantsWeb,
} from "./fake-common.mjs";

const argv = process.argv.slice(2);
const EFFORTS = ["xhigh", "high", "medium", "low"];
const HOSTILE = ["Agent", "ask_user_question", "enter_plan_mode", "exit_plan_mode", "image_gen", "image_edit", "image_to_video", "reference_to_video"];
const RESUME_DENY = ["search_replace", "write", "run_terminal_cmd", "search_tool", "use_tool", "todo_write", "monitor", "workflow", "scheduler_create", "scheduler_delete", "scheduler_list", "send_feedback", ...HOSTILE];
const COMPAT = { GROK_DISABLE_AUTOUPDATER: "1", GROK_CLAUDE_HOOKS_ENABLED: "0" };
const COMMANDS = readStreamFixture("grok", "minimal.jsonl")[0].commands;

// --- probe commands (no guard required) ---------------------------------------------------------
if (argv[0] === "--version") await printAndExit("grok 1.0.70 (f50904eaee6c) [stable]\n");
if (argv[0] === "models") await printAndExit(readSpike("grok-models.txt"));
if (argv[0] === "--help") await printAndExit(readSpike("grok-help.txt"));

// --- model-bearing turn -------------------------------------------------------------------------
requireGuards();
const sc = scenario();
const args = parseArgs(argv, {
  valueFlags: ["--prompt-file", "--session-id", "-r", "--cwd", "--output-format", "--model", "--effort", "--disallowed-tools", "--deny", "--rules", "--json-schema", "--agent"],
  boolFlags: ["--no-auto-update", "--always-approve", "--no-subagents", "--disable-web-search"],
  repeatable: ["--deny"],
});
if (args.positionals.length) fail(`unexpected positional ${args.positionals.join(" ")}`);
const promptFile = args.one("--prompt-file");
if (!promptFile || !existsSync(promptFile) || statSync(promptFile).size === 0) fail("--prompt-file missing, absent or empty");
expectInJobDir(promptFile, "prompt file");
expectPrompt(readFileSync(promptFile, "utf8"), "prompt file content");
if (readStdin().length) fail("grok receives no stdin");
if (args.has("--session-id") === args.has("-r")) fail("exactly one of --session-id and -r");
const sessionId = args.one("--session-id") ?? args.one("-r");
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) fail(`session id ${sessionId} is not a uuid`);
const samePath = (a, b) => { try { return realpathSync.native(a) === realpathSync.native(b); } catch { return false; } };
// A review may run at the repository root above the spawn cwd (grok refuses --add-dir); any other turn runs where it was spawned.
const within = (dir, inner) => { try { const d = realpathSync.native(dir), i = realpathSync.native(inner); return i === d || i.startsWith(d.endsWith(sep) ? d : `${d}${sep}`); } catch { return false; } };
if (args.has("--cwd") && !samePath(args.one("--cwd"), process.cwd()) && !(args.has("--json-schema") && within(args.one("--cwd"), process.cwd()))) fail("--cwd differs from the spawn cwd");
if (process.env.COUNCIL_FAKE_GROK_CWD && !samePath(args.one("--cwd"), process.env.COUNCIL_FAKE_GROK_CWD)) fail(`--cwd ${args.one("--cwd")} is not COUNCIL_FAKE_GROK_CWD`);
if (args.one("--output-format") !== "streaming-json") fail("--output-format streaming-json missing");
const model = args.one("--model");
if (!model) fail("--model missing");
if (!args.has("--no-auto-update")) fail("--no-auto-update missing");
if (!args.has("--always-approve")) fail("--always-approve and --no-subagents are required");
if (args.has("--disallowed-tools") || args.has("--deny")) fail("no plugin tool fence");
const recipe = "default";
const readOnly = !/Instructions for this turn \(task: edits are authorized/.test(readFileSync(promptFile, "utf8"));
for (const [k, v] of Object.entries(COMPAT)) if (process.env[k] !== v) fail(`compatEnv ${k} must be ${v}`);
let schema = null;
if (args.has("--json-schema")) {
  try { schema = JSON.parse(args.one("--json-schema")); } catch { fail("--json-schema is not inline JSON"); }
  if (!deepEqual(schema, readRepoSchema())) fail("--json-schema differs from plugins/council/schemas/review-output.schema.json");
  if (args.has("--rules")) fail("reviews carry no --rules");
} else if (!args.has("--rules") || !args.one("--rules").trim()) fail("--rules <contract> missing on a non-review turn");
else expectContract(args.one("--rules"), "--rules contract");
if (sc === "resume" && !args.has("-r")) fail("scenario resume requires -r");
if (sc === "ok" && !args.has("--session-id")) fail("scenario ok requires --session-id");
if (sc.startsWith("review-") && !schema) fail(`scenario ${sc} requires --json-schema`);

const effort = args.one("--effort");
if (!effort) fail("--effort missing");
if (!EFFORTS.includes(effort) || sc === "effort-error") {
  // Real CLI behaviour: an unknown effort is an `error` event plus stderr, exit 1.
  const bad = EFFORTS.includes(effort) ? "max" : effort;
  const message = `--effort/--reasoning-effort: unknown effort level '${bad}'; use one of: xhigh, high, medium, low`;
  emit({ type: "error", message, cwd: process.cwd() });
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

// COUNCIL_FAKE_GROK_ADVERTISE=<tool,...> adds tools to the catalogue (a misconfigured read-only agent);
// COUNCIL_FAKE_GROK_EDIT=<path> makes a write turn report an edit of that path (nothing is written).
const extra = (process.env.COUNCIL_FAKE_GROK_ADVERTISE ?? "").split(",").filter(Boolean);
const tools = [...(readOnly ? ["read_file", "list_dir", "grep"] : ["read_file", "list_dir", "grep", "write", "search_replace", "run_terminal_command"]), ...extra];
const usage = { input_tokens: 5061, output_tokens: 28, cache_read_input_tokens: 1920, cache_creation_input_tokens: 0, reasoning_tokens: 27 };
// COUNCIL_FAKE_GROK_END (synthetic): no-session (end without sessionId), other-session (another id),
// max-turns (a max_turns_reached event, then the end event), cancelled (stopReason "cancelled": Grok's
// own headless permission refusal, grok-build lifecycle.mjs:22).
const endMode = process.env.COUNCIL_FAKE_GROK_END ?? "";
const end = (extra = {}) => endMode === "no-session" ? emitEnd({ ...extra, sessionId: undefined })
  : endMode === "other-session" ? emitEnd({ ...extra, sessionId: "00000000-0000-4000-8000-000000000000" })
  : endMode === "max-turns" ? (emit({ type: "max_turns_reached" }), emitEnd({ ...extra, stopReason: "max_turns" }))
  : endMode === "cancelled" ? emitEnd({ ...extra, stopReason: "cancelled" })
  : emitEnd(extra);
const emitEnd = (extra = {}) => emit({
  type: "end", stopReason: "end_turn", sessionId, requestId: "423451da-d490-46ad-ac2e-49c7da9f4d4e", cwd: process.cwd(),
  usage: { ...usage, total_tokens: 7009 }, num_turns: 1, total_cost_usd: 0.01125, total_cost_usd_ticks: 112500000,
  modelUsage: { [model]: { inputTokens: 5061, outputTokens: 28, cacheReadInputTokens: 1920, cacheCreationInputTokens: 0, modelCalls: 1, costUSD: 0.01125 } }, ...extra,
});
const catalogue = () => emit({ type: "available_commands", tools, commands: COMMANDS });

catalogue();
if (sc === "slow") {
  process.on("SIGTERM", () => process.exit(143));
  emit({ type: "thought", data: "Working slowly." });
  await sleep(slowMs());
  emit({ type: "text", data: "pong (slow)" });
  emit({ type: "usage", usage, signature: "fake" });
  end();
  process.exit(0);
}
if (sc === "denied") {
  // A forbidden tool call on a read-only turn; the reader fails closed. The fake still ends normally.
  emit({ type: "tool_call", toolCallId: "call_1", toolName: "write", rawInput: { file_path: `${process.cwd()}/probe-denied.txt`, contents: "hello" } });
  emit({ type: "tool_call_update", toolCallId: "call_1", status: "failed", content: [{ type: "text", text: "write is not available to this agent" }] });
  emit({ type: "text", data: "I could not write the file." });
  emit({ type: "usage", usage, signature: "fake" });
  end();
  process.exit(0);
}
if (sc === "review-findings" || sc === "review-malformed") {
  const recorded = readStreamFixture("grok", "json-schema.jsonl").find((e) => e.type === "end").structuredOutput;
  // Synthetic mutation: findings missing, summary empty.
  const structured = sc === "review-findings" ? recorded : { verdict: "needs-attention", summary: "", next_steps: ["fix it"] };
  emit({ type: "thought", data: "Reviewing the diff." });
  const text = JSON.stringify(structured);
  for (let i = 0; i < text.length; i += 48) emit({ type: "text", data: text.slice(i, i + 48) });
  emit({ type: "usage", usage, signature: "fake" });
  end({ structuredOutput: structured });
  process.exit(0);
}
if (!readOnly && process.env.COUNCIL_FAKE_GROK_EDIT) {
  const file = process.env.COUNCIL_FAKE_GROK_EDIT;
  emit({ type: "text", data: "Editing." });
  emit({ type: "tool_call", toolCallId: "call_edit", toolName: "search_replace", rawInput: { file_path: file } });
  emit({ type: "tool_call_update", toolCallId: "call_edit", status: null, locations: [{ path: file }] });
  emit({ type: "tool_call_update", toolCallId: "call_edit", status: "completed", rawOutput: { EditsApplied: { absolute_path: file } } });
}
emit({ type: "text", data: args.has("-r") ? "pong again" : "pong" });
catalogue();
emit({ type: "usage", usage, signature: "fake" });
if (sc === "hold-pipes") holdPipes();
end();
process.exit(0);
