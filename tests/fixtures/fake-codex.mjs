#!/usr/bin/env node
// Fake `codex` 0.163.0. Validates the A5.1 launch contract, then replays streams shaped like the
// S1.1 captures in tests/fixtures/streams/codex (provenance.json names the probe for each).
// Scenarios: ok, resume, denied, effort-error (synthetic: the real CLI accepted every effort token
// probed, see docs/spike/codex.md), review-findings, review-malformed (synthetic), slow, hold-pipes.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  emit, fail, holdPipes, parseArgs, printAndExit, readSpike, readStdin, readStreamFixture, requireGuards, scenario, sleep, slowMs, uuid,
} from "./fake-common.mjs";

const argv = process.argv.slice(2);
const SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
// Recorded stderr of `exec review --uncommitted … -` (S1.1 review-combined probe).
const COMBINED_ERROR = readFileSync(new URL("./streams/codex/review-combined.stderr.txt", import.meta.url), "utf8");

// --- probe commands (no guard required) ---------------------------------------------------------
if (argv[0] === "--version") await printAndExit("codex-cli 0.163.0\n");
if (argv[0] === "login" && argv[1] === "status") await printAndExit("Logged in using ChatGPT\n");
if (argv[0] === "debug" && argv[1] === "models") await printAndExit(readSpike("codex-models.json"));
if (argv[0] === "mcp" && argv[1] === "list") {
  // Shape of `codex mcp list --json` on the probe machine (names only). With a `-c mcp_servers=`
  // override every server reports disabled, as CODEX lib/tools.mjs expects on its second call.
  if (!argv.includes("--json")) fail("mcp list needs --json");
  const overridden = argv.some((a) => a.startsWith("mcp_servers="));
  const names = ["node_repl", "openaiDeveloperDocs", "tradier", "tradier_sandbox"];
  await printAndExit(JSON.stringify(names.map((name) => ({ name, enabled: !overridden }))) + "\n");
}

// --- model-bearing turn -------------------------------------------------------------------------
if (argv[0] !== "exec") fail(`unknown command ${argv.join(" ")}`);
requireGuards();
const sc = scenario();
let rest = argv.slice(1);
let form = "fresh";
let thread = null;
if (rest[0] === "resume") { form = "resume"; thread = rest[1]; rest = rest.slice(2); if (!thread || thread.startsWith("-")) fail("exec resume needs a thread id"); }
else if (rest[0] === "review") { form = "review"; rest = rest.slice(1); }

const args = parseArgs(rest, {
  valueFlags: ["-o", "-C", "-s", "-m", "-c", "--base", "--commit", "--disable"],
  boolFlags: ["--json", "--uncommitted"],
  repeatable: ["-c", "--disable"],
});
if (!args.has("--json")) fail("--json missing");
const answerFile = args.one("-o");
if (!answerFile) fail("-o <answer file> missing");
if (!existsSync(dirname(answerFile))) fail(`answer directory ${dirname(answerFile)} does not exist`);
const model = args.one("-m");
if (!model) fail("-m <model> missing");
const config = new Map(args.all("-c").map((kv) => { const i = kv.indexOf("="); if (i < 0) fail(`-c ${kv} is not key=value`); return [kv.slice(0, i), kv.slice(i + 1)]; }));
const effort = config.get("model_reasoning_effort");
if (!effort) fail("-c model_reasoning_effort=<e> missing");
if (!EFFORTS.includes(effort)) fail(`effort ${effort} outside the CLI vocabulary`);
const stdinMarker = args.positionals.includes("-");
if (args.positionals.some((p) => p !== "-")) fail(`unexpected positional ${args.positionals.join(" ")}`);
const stdin = readStdin();

if (form === "fresh") {
  if (!args.has("-C")) fail("-C <cwd> missing on exec");
  if (!existsSync(args.one("-C")) || !statSync(args.one("-C")).isDirectory()) fail(`-C ${args.one("-C")} is not a directory`);
  if (!SANDBOXES.includes(args.one("-s"))) fail(`-s ${args.one("-s")} is not a sandbox mode`);
  if (config.has("sandbox_mode")) fail("fresh exec passes -s, not -c sandbox_mode");
}
if (form === "resume") {
  if (args.has("-C") || args.has("-s")) fail("exec resume accepts neither -C nor -s");
  if (!SANDBOXES.includes(config.get("sandbox_mode"))) fail("exec resume needs -c sandbox_mode=<mode>");
}
if (form !== "review") {
  const dev = config.get("developer_instructions");
  if (dev === undefined) fail("-c developer_instructions=<json string> missing");
  let parsed; try { parsed = JSON.parse(dev); } catch { fail("developer_instructions is not a JSON string literal"); }
  if (typeof parsed !== "string" || !parsed.trim()) fail("developer_instructions must be a non-empty string");
  if (!stdinMarker) fail("prompt marker `-` missing");
  if (!stdin.trim()) fail("empty prompt on stdin");
}
let target = null;
if (form === "review") {
  const targets = [args.has("--uncommitted") && "--uncommitted", args.has("--base") && "--base", args.has("--commit") && "--commit"].filter(Boolean);
  if (targets.length > 1) fail("more than one review target");
  if (config.get("sandbox_mode") !== "read-only") fail("exec review needs -c sandbox_mode=read-only");
  if (config.get("review_model") !== model) fail("-c review_model must equal -m");
  if (args.has("-C") || args.has("-s")) fail("exec review accepts neither -C nor -s");
  if (targets.length && stdinMarker) { process.stderr.write(COMBINED_ERROR); process.exit(2); } // real CLI behaviour
  if (!targets.length && !stdinMarker) fail("review needs a target flag or a prompt");
  if (stdinMarker && !stdin.trim()) fail("focused review with empty stdin");
  target = targets[0] ?? "prompt";
}
if (sc === "resume" && form !== "resume") fail("scenario resume requires `exec resume`");
if (sc === "ok" && form === "resume") fail("scenario ok requires a fresh `exec`");
if (sc.startsWith("review-") && form !== "review") fail(`scenario ${sc} requires exec review`);

const threadId = thread ?? uuid();
const usage = { input_tokens: 16062, cached_input_tokens: 13184, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 };
const finish = (text) => {
  writeFileSync(answerFile, text);
  emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } });
  emit({ type: "turn.completed", usage });
};

if (sc === "effort-error") {
  // Synthetic: codex 0.163.0 accepted `ultra` on gpt-6-luna in S1.1; this models a hypothetical rejection.
  emit({ type: "error", message: `unsupported reasoning effort ${effort} for ${model}` });
  process.exit(1);
}

emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started" });

if (sc === "slow") {
  let stopped = false;
  process.on("SIGTERM", () => { stopped = true; process.exit(143); });
  await sleep(slowMs());
  if (!stopped) finish("pong (slow)");
  process.exit(0);
}
if (sc === "denied") {
  // Sandbox refusal surfaces as a failed command_execution item; the turn still completes.
  const command = "/bin/zsh -lc 'printf hello > probe-denied.txt'";
  emit({ type: "item.started", item: { id: "item_0", type: "command_execution", command, aggregated_output: "", exit_code: null, status: "in_progress" } });
  emit({ type: "item.completed", item: { id: "item_0", type: "command_execution", command, aggregated_output: "zsh: operation not permitted: probe-denied.txt\n", exit_code: 1, status: "failed" } });
  finish("The sandbox refused the write, so no file was created.");
  process.exit(0);
}
if (sc === "review-findings") {
  for (const ev of readStreamFixture("codex", "review-unfocused.jsonl")) {
    if (ev.type === "thread.started") continue;
    if (ev.type === "turn.started") continue;
    if (ev.type === "item.completed" && ev.item?.type === "agent_message") { finish(ev.item.text); break; }
    emit(ev);
  }
  process.exit(0);
}
if (sc === "review-malformed") {
  // Synthetic mutation of review-unfocused: no [P0]/[P1] line, so the adapter must report `incomplete`.
  finish("Looks fine to me, nothing to flag.");
  process.exit(0);
}
if (sc === "hold-pipes") {
  holdPipes();
  finish("pong");
  process.exit(0);
}
// ok and resume
finish(form === "review" ? "No findings. The change is correct." : form === "resume" ? "pong again" : "pong");
process.exit(0);
