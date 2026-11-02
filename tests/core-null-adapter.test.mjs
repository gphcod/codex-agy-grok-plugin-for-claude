// S2.1: the null adapter's transport profiles and the fake child's scenarios, spawned directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import adapter, { FAKE_CHILD, profile } from "./fixtures/null-adapter.mjs";
import { GUARD_VARS } from "./fixtures/fake-common.mjs";

const guards = Object.fromEntries(GUARD_VARS.map((g) => [g, "1"]));
const tmp = () => mkdtempSync(join(tmpdir(), "council-null-"));

function runChild(args, { env = {}, input = "", cwd, signalAfterMs = null } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [FAKE_CHILD, ...args], { cwd, env: { ...process.env, ...guards, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", exitAt = 0, endAt = 0, code = null, signal = null;
    child.stdout.on("data", (d) => { stdout += d; });
    child.stdout.on("end", () => { endAt ||= Date.now(); });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("exit", (c, s) => { exitAt = Date.now(); code = c; signal = s; });
    child.on("close", () => {
      endAt ||= Date.now();
      const lines = stdout.split("\n").filter(Boolean);
      resolve({ code, signal, stdout, stderr, lines, ms: exitAt - started, holdMs: endAt - exitAt });
    });
    if (signalAfterMs !== null) setTimeout(() => child.kill("SIGTERM"), signalAfterMs);
    child.stdin.end(input);
  });
}

function request(dir, overrides = {}) {
  return { verb: "ask", provider: "null", jobId: "abcdefghij123456", jobDir: dir, model: "null-model", effort: "high", readOnly: true, text: "hello", contract: "<contract/>", thread: null, ...overrides };
}

test("profile defaults and overrides", () => {
  assert.deepEqual(profile({}), { id: "preassigned", input: "stdin", output: "stream", trust: false });
  assert.deepEqual(profile({ COUNCIL_NULL_ID: "discovered", COUNCIL_NULL_INPUT: "prompt-file", COUNCIL_NULL_OUTPUT: "answer-file", COUNCIL_NULL_TRUST: "1" }), { id: "discovered", input: "prompt-file", output: "answer-file", trust: true });
});

test("buildTurn shapes per profile, read from the env the core passes", () => {
  const dir = tmp();
  try {
    const before = { ...process.env };
    const t1 = adapter.buildTurn(request(dir, { env: { COUNCIL_NULL_ID: "preassigned", COUNCIL_NULL_INPUT: "stdin", COUNCIL_NULL_OUTPUT: "stream" } }));
    assert.ok(t1.args.includes("--thread"), "preassigned passes --thread");
    assert.match(t1.threadId, /^[0-9a-f-]{36}$/);
    assert.equal(t1.stdin, "<contract/>\n\nhello");
    assert.equal(t1.answerFile, null);
    assert.equal(t1.readOnly, true);
    const env2 = { COUNCIL_NULL_ID: "discovered", COUNCIL_NULL_INPUT: "prompt-file", COUNCIL_NULL_OUTPUT: "answer-file" };
    const t2 = adapter.buildTurn(request(dir, { env: env2 }));
    assert.ok(!t2.args.includes("--thread"), "discovered passes no --thread on a fresh turn");
    assert.equal(t2.threadId, null);
    assert.equal(t2.promptFile, join(dir, "prompt.md"));
    assert.equal(t2.answerFile, join(dir, "answer.md"));
    assert.equal(t2.stdin, undefined);
    const t3 = adapter.buildTurn(request(dir, { env: env2, verb: "reply", thread: { threadId: "t-123" } }));
    assert.ok(t3.args.includes("--thread") && t3.args.includes("t-123"), "a resumed discovered thread passes its id");
    const t4 = adapter.buildTurn(request(dir, { verb: "task", readOnly: false, web: true }));
    assert.ok(t4.args.includes("--write"));
    assert.ok(t4.args.includes("--web"));
    assert.equal(t4.readOnly, false);
    const t5 = adapter.buildTurn(request(dir, { env: env2, verb: "review", reviewPrompt: "REVIEW PROMPT" }));
    assert.ok(t5.args.includes("--review"));
    assert.equal(t5.promptText, "REVIEW PROMPT");
    assert.deepEqual({ ...process.env }, before, "the adapter never touches process.env");
    const trusted = adapter.resolveLauncher({ COUNCIL_NULL_TRUST: "1" });
    assert.equal(adapter.trustsCleanExit(trusted), true);
    assert.equal(adapter.trustsCleanExit(adapter.resolveLauncher({})), false);
    assert.throws(() => adapter.checkRequest({ web: true }, { COUNCIL_NULL_NO_WEB: "1" }), /--web has no tested mapping/);
    assert.doesNotThrow(() => adapter.checkRequest({ web: true }, {}));
    assert.deepEqual(adapter.tiersFor({ COUNCIL_NULL_CONSULT: "null-fast/low" }).consult, { model: "null-fast", effort: "low" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("parseEvent maps the protocol to A5 shapes", () => {
  assert.deepEqual(adapter.parseEvent('{"type":"started","thread":"t1"}', {}), { threadId: "t1" });
  assert.deepEqual(adapter.parseEvent('{"type":"text","data":"hi"}', {}), { textDelta: "hi" });
  assert.deepEqual(adapter.parseEvent('{"type":"done","usage":{"input":1}}', {}), { completed: true, usage: { input: 1 } });
  assert.deepEqual(adapter.parseEvent('{"type":"done","structured":{"verdict":"approve"}}', {}), { completed: true, structured: { verdict: "approve" } });
  assert.deepEqual(adapter.parseEvent('{"type":"error","message":"boom"}', {}), { fatal: "boom" });
  assert.deepEqual(adapter.parseEvent('{"type":"progress","step":"x"}', {}), { toolStep: "x" });
  assert.equal(adapter.parseEvent("not json", {}), null);
  assert.equal(adapter.parseEvent('{"type":"unknown"}', {}), null);
});

test("ownsProcess matches the --job operand on argv rows and raw rows", () => {
  const job = { id: "abcdefghij123456" };
  assert.equal(adapter.ownsProcess({ argv: ["node", "fake-child.mjs", "--job", job.id] }, job), true);
  assert.equal(adapter.ownsProcess({ argv: ["node", "fake-child.mjs", "--job", "other"] }, job), false);
  assert.equal(adapter.ownsProcess({ raw: `node fake-child.mjs --job ${job.id} --model x` }, job), true);
  assert.equal(adapter.ownsProcess({ raw: "node fake-child.mjs --job other" }, job), false);
});

test("probe, catalog and tiers are self-consistent", () => {
  const probe = adapter.probe();
  assert.equal(probe.loggedIn, true);
  assert.deepEqual(probe.models.map((m) => m.id), Object.keys(adapter.catalog.models));
  for (const t of Object.values(adapter.tiers)) assert.ok(adapter.catalog.models[t.model].includes(t.effort));
});

test("fake child: ok in every profile, with the spawn log", async () => {
  const dir = tmp();
  try {
    const log = join(dir, "spawns.log");
    const base = ["--job", "j1", "--model", "null-model", "--effort", "low"];
    const r1 = await runChild([...base, "--thread", "t-1"], { input: "hello", cwd: dir, env: { COUNCIL_FAKE_SPAWN_LOG: log, COUNCIL_NULL_ID: "preassigned" } });
    assert.equal(r1.code, 0, r1.stderr);
    assert.deepEqual(r1.lines.map((l) => JSON.parse(l).type), ["started", "text", "done"]);
    assert.equal(JSON.parse(r1.lines[0]).thread, "t-1");
    writeFileSync(join(dir, "prompt.md"), "hello from file");
    const r2 = await runChild([...base, "--prompt-file", join(dir, "prompt.md"), "--answer-file", join(dir, "answer.md")], { cwd: dir, env: { COUNCIL_FAKE_SPAWN_LOG: log, COUNCIL_NULL_ID: "discovered", COUNCIL_FAKE_THREAD: "disc-1" } });
    assert.equal(r2.code, 0, r2.stderr);
    assert.deepEqual(r2.lines.map((l) => JSON.parse(l).type), ["started", "done"]);
    assert.equal(JSON.parse(r2.lines[0]).thread, "disc-1");
    assert.equal(readFileSync(join(dir, "answer.md"), "utf8"), "pong for job j1");
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2, "two spawns logged");
    const r3 = await runChild([...base, "--thread", "t-1"], { input: "hello", cwd: dir, env: { COUNCIL_NULL_ID: "discovered", COUNCIL_FAKE_FRESH: "1" } });
    assert.equal(r3.code, 99, "discovered profile refuses --thread on a fresh turn");
    const r4 = await runChild(base, { input: "", cwd: dir });
    assert.equal(r4.code, 99, "empty prompt refused");
    const { COUNCIL_DEPTH, ...partial } = guards;
    const r5 = await new Promise((resolve) => {
      const child = spawn(process.execPath, [FAKE_CHILD, ...base, "--thread", "t"], { cwd: dir, env: { ...process.env, ...partial, COUNCIL_DEPTH: "" }, stdio: ["pipe", "pipe", "pipe"] });
      child.on("close", (code) => resolve(code)); child.stdin.end("hi");
    });
    assert.equal(r5, 99, "missing guard variable refused");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fake child: every other scenario behaves as documented", async () => {
  const dir = tmp();
  try {
    const base = ["--job", "j2", "--model", "null-model", "--effort", "low", "--thread", "t-2"];
    const run = (scenario, extra = {}, more = {}) => runChild(base, { input: "hello", cwd: dir, env: { COUNCIL_FAKE_SCENARIO: scenario, ...extra }, ...more });
    const slow = await run("slow", { COUNCIL_FAKE_SLOW_MS: "250" });
    assert.equal(slow.code, 0); assert.ok(slow.ms >= 250);
    assert.deepEqual(slow.lines.map((l) => JSON.parse(l).type), ["started", "progress", "text", "done"]);
    const killed = await run("slow", { COUNCIL_FAKE_SLOW_MS: "5000" }, { signalAfterMs: 200 });
    assert.equal(killed.code, process.platform === "win32" ? null : 143, "Windows ends the process without running a handler");
    const hold = await run("hold-pipes", { COUNCIL_FAKE_HOLD_MS: "1200" });
    assert.equal(hold.code, 0); assert.ok(hold.holdMs >= 900, `stdout stayed open ${hold.holdMs} ms after exit`);
    const nonzero = await run("exit-nonzero");
    assert.equal(nonzero.code, 3); assert.match(nonzero.stderr, /simulated crash/);
    assert.ok(!nonzero.lines.some((l) => JSON.parse(l).type === "done"));
    const huge = await run("huge-line", { COUNCIL_FAKE_HUGE_BYTES: String(80 * 1024) });
    assert.equal(huge.code, 0);
    assert.ok(huge.lines.some((l) => l.length > adapter.maxLineBytes), "one line exceeds the adapter's maxLineBytes");
    assert.equal(JSON.parse(huge.lines.at(-1)).type, "done", "the whole stream drained before exit");
    const frag = await run("fragmented-frames");
    assert.equal(frag.code, 0);
    assert.deepEqual(frag.lines.map((l) => JSON.parse(l).type), ["started", "text", "text", "done"]);
    const none = await run("no-completion");
    assert.equal(none.code, 0);
    assert.deepEqual(none.lines.map((l) => JSON.parse(l).type), ["started", "text"]);
    const fts = await run("fail-then-success");
    assert.equal(fts.code, 0);
    assert.deepEqual(fts.lines.map((l) => JSON.parse(l).type), ["started", "error", "text", "done"]);
    const review = await runChild([...base, "--review"], { input: "review this", cwd: dir, env: { COUNCIL_FAKE_REVIEW: "findings" } });
    const done = JSON.parse(review.lines.at(-1));
    assert.equal(done.structured.verdict, "needs-attention"); assert.equal(done.structured.findings.length, 1);
    const malformed = await runChild([...base, "--review"], { input: "review this", cwd: dir, env: { COUNCIL_FAKE_REVIEW: "malformed" } });
    assert.deepEqual(JSON.parse(malformed.lines.at(-1)).structured, { verdict: "approve" });
    assert.equal(existsSync(join(dir, "answer.md")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
