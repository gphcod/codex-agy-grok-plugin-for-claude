#!/usr/bin/env node
// Fake `agy` 1.4.12. Validates the A5.1 launch contract, then replays streams shaped like the
// S1.2 captures in tests/fixtures/streams/agy (provenance.json names the probe for each).
// Scenarios: ok, resume, denied (S1.2 denied-write), effort-error (S1.2 effort matrix),
// review-findings (S1.2 json-schema), review-malformed (synthetic), slow, hold-pipes.
// Adapter-test seams (S5.5), all synthetic and agy-specific:
//   COUNCIL_FAKE_AGY_LOG=<file>      one JSON line per accepted turn: argv, settings, stdin content, pid
//   COUNCIL_FAKE_AGY_RESULT=<kind>   terminal-result variants on the ok scenario: print-timeout,
//                                    duplicate, missing, error, empty, denied-actions,
//                                    denied-actions-empty (signature plus an empty array),
//                                    denied-empty-response (signature, empty response),
//                                    deltas-only (deltas streamed, empty response)
//   COUNCIL_FAKE_AGY_CHILD=group|orphan  start a language-server-like child in agy's process group
//                                    and write its pid to COUNCIL_FAKE_AGY_CHILD_PIDFILE; `orphan`
//                                    waits COUNCIL_FAKE_AGY_HOLD_MS, answers and exits, leaving the
//                                    child reparented to pid 1 (no capture: S1.2 saw no child)
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  deepEqual, emit, expectContract, expectInJobDir, expectPrompt, fail, holdPipes, parseArgs, printAndExit, readRepoSchema, readSpike, readStdin, readStreamFixture, requireGuards, scenario, sleep, slowMs, uuid,
} from "./fake-common.mjs";

const argv = process.argv.slice(2);
const EFFORTS = ["low", "medium", "high"];
// A2 read-only deny list (union of gemini-plugin-cc and gemini-plugin-for-codex).
const READ_ONLY_DENY = ["write_file(*)", "edit_file(*)", "unsandboxed(*)", "mcp(*)", "execute_url(*)"];
const TOOLS = readStreamFixture("agy", "minimal.jsonl")[0].init.tools;

// --- probe commands (no guard required) ---------------------------------------------------------
if (argv[0] === "--version") await printAndExit("1.4.12\n");
if (argv[0] === "models") { process.stderr.write("Fetching available models...\n"); await printAndExit(readSpike("agy-models.txt")); }

// --- model-bearing turn -------------------------------------------------------------------------
requireGuards();
const sc = scenario();
const args = parseArgs(argv, {
  valueFlags: ["--input-format", "--output-format", "--print-timeout", "--settings", "--model", "--effort", "--conversation", "--json-schema", "--mode"],
  boolFlags: ["--disable-slash-commands", "--sandbox", "--dangerously-skip-permissions"],
});
if (args.positionals.length) fail(`unexpected positional ${args.positionals.join(" ")}`);
if (args.one("--input-format") !== "stream-json") fail("--input-format stream-json missing");
if (args.one("--output-format") !== "stream-json") fail("--output-format stream-json missing");
if (!args.has("--disable-slash-commands")) fail("--disable-slash-commands missing");
if (args.has("--sandbox") || !args.has("--dangerously-skip-permissions")) fail("full native access required");
if (!/^\d+(\.\d+)?s$/.test(args.one("--print-timeout") ?? "")) fail("--print-timeout <seconds>s missing");
const settingsPath = args.one("--settings");
if (!settingsPath || !existsSync(settingsPath)) fail("--settings <file> missing or absent");
expectInJobDir(settingsPath, "settings file");
let settings;
try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { fail("--settings file is not JSON"); }
if (!settings || typeof settings.permissions !== "object") fail("settings lack a permissions object");
const mode = args.one("--mode");
if (mode !== undefined && mode !== "accept-edits") fail(`--mode ${mode} is not accept-edits`);
const readOnly = mode === undefined;
const model = args.one("--model");
if (!model) fail("--model missing");
const suffix = /-(low|medium|high)$/.exec(model)?.[1] ?? null;
const effort = args.one("--effort");
if (!suffix && effort === undefined) fail("an unsuffixed family needs --effort");
const schemaPath = args.one("--json-schema");
if (schemaPath !== undefined) {
  if (!existsSync(schemaPath)) fail("--json-schema path does not exist");
  let schema; try { schema = JSON.parse(readFileSync(schemaPath, "utf8")); } catch { fail("--json-schema file is not JSON"); }
  if (!deepEqual(schema, readRepoSchema())) fail("--json-schema file differs from plugins/council/schemas/review-output.schema.json");
}
const raw = readStdin();
const newline = raw.indexOf("\n");
if (newline < 0 || newline !== raw.length - 1) fail("stdin must be exactly one NDJSON line ending in a single newline");
let message;
try { message = JSON.parse(raw.slice(0, newline)); } catch { fail("stdin line is not JSON"); }
if (message?.event !== "user" || typeof message?.message?.content !== "string" || !message.message.content.trim()) fail("stdin must be {event:'user', message:{content}}");
if (Object.keys(message).length !== 2 || Object.keys(message.message).length !== 1) fail("stdin message carries unexpected keys");
if (process.env.COUNCIL_FAKE_EXPECT_CONTRACT !== undefined && !message.message.content.startsWith(process.env.COUNCIL_FAKE_EXPECT_CONTRACT)) fail("content does not start with the contract");
expectPrompt(message.message.content, "stdin content");
const conversation = args.one("--conversation");
if (sc === "resume" && !conversation) fail("scenario resume requires --conversation");
if (sc === "ok" && conversation) fail("scenario ok requires a fresh conversation");
if (sc.startsWith("review-") && schemaPath === undefined) fail(`scenario ${sc} requires --json-schema`);

// Real CLI behaviour (not a contract violation): model selection errors exit 1 with an ERROR result.
function selectionError(text) {
  emit({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: text, duration_seconds: 0, num_turns: 0, usage: zeroUsage(), finished_reason: "error" } });
  process.stderr.write(`error: ${text}\n`);
  process.exit(1);
}
const zeroUsage = () => ({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 });
if (suffix && effort !== undefined && effort !== suffix) selectionError(`invalid model selection (--model "${model}" --effort "${effort}"): --model ${model} conflicts with --effort=${effort}`);
if (effort !== undefined && !EFFORTS.includes(effort)) selectionError(`invalid model selection (--model "${model}" --effort "${effort}"): ${model} has no "${effort}" effort (available: low, medium, high)`);
if (sc === "effort-error") selectionError(`invalid model selection (--model "${model}" --effort "xhigh"): ${model} has no "xhigh" effort (available: low, medium, high)`);

if (process.env.COUNCIL_FAKE_AGY_LOG) appendFileSync(process.env.COUNCIL_FAKE_AGY_LOG, JSON.stringify({ argv, settings, content: message.message.content, pid: process.pid, cwd: process.cwd() }) + "\n");
const childMode = process.env.COUNCIL_FAKE_AGY_CHILD;
if (childMode === "group" || childMode === "orphan") {
  const ls = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "language-server"], { stdio: "ignore" });
  if (process.env.COUNCIL_FAKE_AGY_CHILD_PIDFILE) writeFileSync(process.env.COUNCIL_FAKE_AGY_CHILD_PIDFILE, String(ls.pid));
  if (childMode === "orphan") { ls.unref(); await sleep(Number(process.env.COUNCIL_FAKE_AGY_HOLD_MS ?? 500)); }
}

const cid = conversation ?? uuid();
const usage = { input_tokens: 7684, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 7689 };
const step = (step_index, state, step_type, extra = {}) => emit({ event: "step_update", step_update: { conversation_id: cid, step_index, state, step_type, ...extra } });
const result = (extra) => emit({ event: "result", result: { conversation_id: cid, status: "SUCCESS", response: "", duration_seconds: 3.08, num_turns: conversation ? 2 : 1, usage, ...extra } });

emit({ event: "init", conversation_id: cid, init: { model, cwd: process.cwd(), tools: TOOLS, permission_mode: readOnly ? "default" : "accept-edits" } });
step(0, "DONE", "user_input");

if (sc === "slow") {
  process.on("SIGTERM", () => {
    emit({ event: "result", result: { conversation_id: cid, status: "ERROR", response: "", error: "interrupted", duration_seconds: 0, num_turns: 1, usage: zeroUsage(), finished_reason: "interrupted" } });
    process.stderr.write("error: interrupted\n");
    process.exit(1);
  });
  await sleep(slowMs());
  step(1, "ACTIVE", "agent_response", { text_delta: "pong" });
  step(1, "DONE", "agent_response", { text_delta: "\n", duration_seconds: slowMs() / 1000, usage });
  result({ response: "pong\n" });
  process.exit(0);
}
if (sc === "denied") {
  const path = `${process.cwd()}/probe-denied.txt`;
  step(1, "DONE", "agent_response", { text_delta: "" });
  step(2, "ACTIVE", "tool", { tool_name: "write_file", tool_info: { name: "write_file", parameters: { Path: path } } });
  step(2, "ERROR", "tool", { tool_name: "write_file", duration_seconds: 1.31, tool_info: { name: "write_file", parameters: { Path: path }, error: { type: "TOOL_ERROR", message: `permission check failed for write_file "${path}": Permission denied for write_file(${path}). Matches user-configured deny rule.` } } });
  const text = "The attempt to create probe-denied.txt failed because it was blocked by a user-configured permission deny rule.";
  step(3, "ACTIVE", "agent_response", { text_delta: text });
  step(3, "DONE", "agent_response", { text_delta: "\n", duration_seconds: 2.1, usage });
  result({ response: text + "\n" });
  process.exit(0);
}
if (sc === "review-findings" || sc === "review-malformed") {
  const recorded = readStreamFixture("agy", "json-schema.jsonl").find((e) => e.event === "result").result;
  let structured = recorded.structured_output;
  if (sc === "review-malformed") {
    // Synthetic mutation: approval verdict without the required summary, and a finding lacking its file.
    structured = { verdict: "approve", findings: [{ severity: "low", title: "x", body: "y" }], next_steps: [] };
  }
  step(1, "DONE", "agent_response", { text_delta: JSON.stringify(structured) });
  step(2, "DONE", "finish", { duration_seconds: 0.06 });
  result({ response: JSON.stringify(structured) + "\n", structured_output: structured, json_schema: JSON.parse(readFileSync(schemaPath, "utf8")) });
  process.exit(0);
}
const text = conversation ? "pong" : "pong";
const variant = process.env.COUNCIL_FAKE_AGY_RESULT;
const denialStep = () => {
  const path = `${process.cwd()}/probe-denied.txt`;
  step(2, "ERROR", "tool", { tool_name: "write_file", duration_seconds: 1.31, tool_info: { name: "write_file", parameters: { Path: path }, error: { type: "TOOL_ERROR", message: `permission check failed for write_file "${path}": Permission denied for write_file(${path}). Matches user-configured deny rule.` } } });
};
if (variant === "denied-actions-empty" || variant === "denied-empty-response") denialStep();
if (variant !== "denied-empty-response" && variant !== "empty") {
  step(1, "ACTIVE", "agent_response", { text_delta: text });
  step(1, "DONE", "agent_response", { text_delta: "\n", duration_seconds: 3.06, usage });
}
if (sc === "hold-pipes") holdPipes();
if (variant === "missing") process.exit(0);
if (variant === "print-timeout") { process.stderr.write("[agy] print timeout after 5s with turn in progress; returning partial output\n"); result({ response: text, finished_reason: "print_timeout", usage: zeroUsage() }); process.exit(0); }
if (variant === "error") { result({ status: "ERROR", response: "", error: "backend unavailable", finished_reason: "error" }); process.stderr.write("error: backend unavailable\n"); process.exit(1); }
if (variant === "empty" || variant === "denied-empty-response" || variant === "deltas-only") { result({ response: "" }); process.exit(0); }
if (variant === "denied-actions") { result({ response: text + "\n", denied_actions: [{ tool: "write_file", path: `${process.cwd()}/x` }] }); process.exit(0); }
if (variant === "denied-actions-empty") { result({ response: text + "\n", denied_actions: [] }); process.exit(0); }
result({ response: text + "\n" });
if (variant === "duplicate") result({ response: text + "\n" });
process.exit(0);
