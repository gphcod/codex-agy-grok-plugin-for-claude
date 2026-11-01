#!/usr/bin/env node
// The null adapter's child CLI (S2.1). One JSONL protocol with three transport profiles, chosen by
// the argv the adapter builds: `--thread <id>` (preassigned id) or none (the child announces one in
// `started`); `--prompt-file <f>` or the prompt on stdin; `--answer-file <f>` or the answer as `text`
// events. `--job <id>` is always present: it is the ownership evidence the adapter looks for in the
// process table. Scenarios through COUNCIL_FAKE_SCENARIO: ok, slow, hold-pipes, exit-nonzero,
// huge-line, fragmented-frames, no-completion, fail-then-success. COUNCIL_FAKE_SPAWN_LOG appends
// one line per spawn so tests can assert how many children a request started.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { GUARD_VARS, holdPipes, readStdin, sleep, slowMs, uuid } from "./fake-common.mjs";

const argv = process.argv.slice(2);
const env = process.env;
const scenario = env.COUNCIL_FAKE_SCENARIO || "ok";
const SCENARIOS = ["ok", "slow", "hold-pipes", "exit-nonzero", "huge-line", "fragmented-frames", "no-completion", "fail-then-success"];

function fail(message) {
  process.stderr.write(`fake-child launch contract violated: ${message}\n`);
  process.exit(99);
}
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

if (argv[0] === "--version") { process.stdout.write("null 0.0.0\n", () => process.exit(0)); await new Promise(() => {}); }
if (argv[0] === "models") { process.stdout.write("null-model\n", () => process.exit(0)); await new Promise(() => {}); }

if (!SCENARIOS.includes(scenario)) fail(`unknown scenario ${scenario}`);
for (const g of GUARD_VARS) if (!env[g]) fail(`guard variable ${g} is not set on the child`);
const job = flag("--job");
if (!job) fail("--job <id> missing");
const thread = flag("--thread");
const promptFile = flag("--prompt-file");
const answerFile = flag("--answer-file");
const review = argv.includes("--review");
if (argv.includes("--thread") === false && env.COUNCIL_NULL_ID === "preassigned") fail("preassigned profile needs --thread");
// A discovered profile passes --thread only when resuming (like `codex exec resume <id>`); COUNCIL_FAKE_FRESH=1 lets a test assert a fresh turn passes none.
if (argv.includes("--thread") && env.COUNCIL_NULL_ID === "discovered" && env.COUNCIL_FAKE_FRESH === "1") fail("discovered profile passes no --thread on a fresh turn");

let prompt;
if (promptFile !== undefined) {
  if (!existsSync(promptFile)) fail(`prompt file ${promptFile} missing`);
  prompt = readFileSync(promptFile, "utf8");
  if (readStdin().length) fail("prompt-file profile receives no stdin");
} else {
  prompt = readStdin();
}
// One line per spawn, with the prompt bytes the child received, so tests can count children and check input.
if (env.COUNCIL_FAKE_SPAWN_LOG) appendFileSync(env.COUNCIL_FAKE_SPAWN_LOG, JSON.stringify({ argv, cwd: process.cwd(), prompt, guards: GUARD_VARS.filter((g) => env[g] === "1"), at: Date.now() }) + "\n");
if (!prompt.trim()) fail("empty prompt");
if (env.COUNCIL_FAKE_EXPECT_PROMPT !== undefined && prompt !== env.COUNCIL_FAKE_EXPECT_PROMPT) fail("prompt differs from COUNCIL_FAKE_EXPECT_PROMPT");

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
// Exit only once stdout has drained: a pipe holds 64 KiB and process.exit would truncate the rest.
const exit = (code) => new Promise(() => { process.stdout.write("", () => process.exit(code)); });
const threadId = thread ?? env.COUNCIL_FAKE_THREAD ?? uuid();
const answerText = env.COUNCIL_FAKE_ANSWER ?? (review ? "" : `pong for job ${job}`);
const usage = { input: 10, output: 2 };

function structuredReview() {
  const kind = env.COUNCIL_FAKE_REVIEW ?? "approve";
  const finding = { severity: "high", title: "Off-by-one", body: "The loop reads past the end.", file: "calc.js", line_start: 3, line_end: 3, confidence: 0.9, recommendation: "Use <." };
  if (kind === "approve") return { verdict: "approve", summary: "Looks correct.", findings: [], next_steps: [] };
  if (kind === "findings") return { verdict: "needs-attention", summary: "One defect.", findings: [finding], next_steps: ["fix it"] };
  if (kind === "approve-with-findings") return { verdict: "approve", summary: "Fine, but.", findings: [finding], next_steps: [] };
  if (kind === "attention-no-findings") return { verdict: "needs-attention", summary: "Something smells.", findings: [], next_steps: [] };
  if (kind === "malformed") return { verdict: "approve" };
  if (kind === "none") return undefined;
  return { verdict: "approve", summary: "Looks correct.", findings: [], next_steps: [] };
}

function deliverAnswer() {
  if (answerFile !== undefined) writeFileSync(answerFile, answerText);
  else if (answerText) emit({ type: "text", data: answerText });
}
function done(extra = {}) {
  const structured = review ? structuredReview() : undefined;
  emit({ type: "done", usage, ...(structured !== undefined ? { structured } : {}), ...extra });
}

emit({ type: "started", thread: threadId, scenario });

switch (scenario) {
  case "ok":
    deliverAnswer(); done(); await exit(0);
  case "slow": {
    process.on("SIGTERM", () => process.exit(143));
    emit({ type: "progress", step: "thinking" });
    await sleep(slowMs());
    deliverAnswer(); done(); await exit(0);
  }
  case "hold-pipes":
    deliverAnswer(); done(); holdPipes(); await exit(0);
  case "exit-nonzero":
    emit({ type: "text", data: "partial" });
    process.stderr.write("fake-child: simulated crash\n");
    await exit(3);
  case "huge-line": {
    const big = "x".repeat(Number(env.COUNCIL_FAKE_HUGE_BYTES ?? 80 * 1024));
    emit({ type: "text", data: big });
    done(); await exit(0);
  }
  case "fragmented-frames": {
    // Every event split into small chunks with pauses between them: the reader must reassemble lines.
    const lines = [JSON.stringify({ type: "text", data: "pong " }), JSON.stringify({ type: "text", data: `for job ${job}` }), JSON.stringify({ type: "done", usage })];
    if (answerFile !== undefined) writeFileSync(answerFile, `pong for job ${job}`);
    for (const line of lines) {
      const text = line + "\n";
      for (let i = 0; i < text.length; i += 7) {
        process.stdout.write(text.slice(i, i + 7));
        await sleep(2);
      }
    }
    await exit(0);
  }
  case "no-completion":
    deliverAnswer(); await exit(0);
  case "fail-then-success":
    emit({ type: "error", message: "simulated fatal before a later success" });
    deliverAnswer(); done(); await exit(0);
  default:
    fail(`unhandled scenario ${scenario}`);
}
