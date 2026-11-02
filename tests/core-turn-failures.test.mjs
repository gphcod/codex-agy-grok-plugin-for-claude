// S2.7 (ratio): runManagedTurn's failure and outcome paths — spawn, storage and finalization
// failures, answer checks, denied and incomplete events, thread mismatches, the post-exit scan finding
// survivors or failing, and the stop path when ownership cannot be queried. Null adapter, fake child.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nullAdapter from "./fixtures/null-adapter.mjs";
import { GUARD_VARS } from "./fixtures/fake-common.mjs";
import { inspectClaim } from "../plugins/council/scripts/lib/core/claims.mjs";
import { executionController } from "../plugins/council/scripts/lib/core/execution.mjs";
import { homeDir, loadJob, loadThread } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { runManagedTurn } from "../plugins/council/scripts/lib/core/lifecycle.mjs";
import { footer } from "../plugins/council/scripts/lib/core/output.mjs";

const FAST = { drainMs: 150, shutdownMs: process.platform === "win32" ? 20000 : 3000, retryMs: 300, graceMs: 100, pipeWaitMs: 400 };

function setup() {
  const root = mkdtempSync(join(tmpdir(), "council-fail-"));
  const home = homeDir({ COUNCIL_HOME: join(root, "home") });
  const cwd = join(root, "work");
  mkdirSync(cwd);
  const env = { ...process.env };
  for (const g of GUARD_VARS) delete env[g];
  for (const k of ["COUNCIL_FAKE_SCENARIO", "COUNCIL_FAKE_ANSWER", "COUNCIL_NULL_ID", "COUNCIL_NULL_INPUT", "COUNCIL_NULL_OUTPUT", "COUNCIL_NULL_TRUST"]) delete env[k];
  return { root, home, cwd, ctx: { home, env, cwd, session: "s" }, done: () => rmSync(root, { recursive: true, force: true }) };
}
/** The one job directory a test's turn has created. */
const loadJobDir = (s) => {
  const root = join(s.home, "jobs");
  return join(root, fs.readdirSync(root).at(-1));
};
const request = (s, over = {}) => ({ verb: "ask", provider: "null", cwd: s.cwd, session: "s", tier: "consult", model: "null-model", effort: "high", requestedEffort: "high", modelVerified: true, thread: null, readOnly: true, text: "hello", contract: "<c/>", rounds: 9, round: 1, ...over });
async function run(s, { adapter = nullAdapter, over = {}, env = {}, hooks = {}, options = {}, prepare = null } = {}) {
  const req = request(s, over);
  return runManagedTurn({ ...s.ctx, env: { ...s.ctx.env, ...env } }, adapter, req, prepare ?? (() => req), { deadlineMs: 15000, inactivityMs: 15000, ...options }, { ...FAST, ...hooks });
}
/** The null adapter with one method replaced. */
const variant = (over) => Object.assign(Object.create(Object.getPrototypeOf(nullAdapter)), nullAdapter, over);

test("a spawn that throws: could not start, nothing to clean up, the claim released", async () => {
  const s = setup();
  try {
    const { job } = await run(s, { hooks: { spawn: () => { throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }); } } });
    assert.equal(job.code, 1);
    assert.equal(job.error, "could not start null: spawn ENOENT");
    assert.equal(job.cleanupPending, false);
    assert.equal(job.claimHeld, false);
    assert.equal(inspectClaim(s.home, "null", job.requestedThreadId).state, "absent");
  } finally { s.done(); }
});

test("a missing launcher and an adapter without launch arguments fail before any spawn", async () => {
  const s = setup();
  try {
    const missing = await run(s, { adapter: variant({ resolveLauncher: () => null }) });
    assert.equal(missing.job.code, 1);
    assert.equal(missing.job.error, "null not found; run setup, or set COUNCIL_NULL_BIN");
    assert.equal(missing.job.admitted, false, "nothing was admitted");
    const noArgs = await run(s, { adapter: variant({ buildTurn: () => ({ env: {} }) }) });
    assert.equal(noArgs.job.code, 1);
    assert.equal(noArgs.job.error, "null adapter returned no launch arguments");
  } finally { s.done(); }
});

test("the thread may not change between the first preparation and the one after the claim", async () => {
  const s = setup();
  try {
    // runManagedTurn prepares once more after the claim; this time the resolution names another thread.
    const req = request(s, { verb: "reply", thread: { threadId: "t-original" }, round: 2 });
    const { job } = await run(s, { prepare: () => ({ ...req, thread: { threadId: "t-other" } }), over: req });
    assert.equal(job.code, 1);
    assert.equal(job.error, "the thread changed during admission");
    assert.equal(inspectClaim(s.home, "null", "t-original").state, "absent", "the claim taken on admission is released");
  } finally { s.done(); }
});

test("event storage failure stops the turn and fails it", async () => {
  const s = setup();
  try {
    const io = Object.create(fs);
    io.appendFileSync = (file, data) => { if (String(file).endsWith("events.jsonl")) throw new Error("disk full"); return fs.appendFileSync(file, data); };
    const { job } = await run(s, { hooks: { io } });
    assert.equal(job.code, 1);
    assert.match(job.error, /^event storage failed: disk full/);
  } finally { s.done(); }
});

test("answer storage failure on a streamed answer fails the turn", async () => {
  const s = setup();
  try {
    const io = Object.create(fs);
    io.appendFileSync = (file, data) => { if (String(file).endsWith("answer.md")) throw new Error("read-only file system"); return fs.appendFileSync(file, data); };
    const { job } = await run(s, { hooks: { io } });
    assert.equal(job.code, 1);
    assert.match(job.error, /^answer storage failed: read-only file system/);
  } finally { s.done(); }
});

test("finalization failure keeps the claim and reports cleanup pending", async () => {
  const s = setup();
  try {
    const { job } = await run(s, { hooks: { beforeFinalize: () => { throw new Error("cannot write meta.json"); } } });
    assert.equal(job.code, 1);
    assert.equal(job.outcome, "failed");
    assert.equal(job.cleanupPending, true);
    assert.equal(job.error, "finalization failed: cannot write meta.json");
    assert.equal(inspectClaim(s.home, "null", job.threadId).state, "owned", "never released after a failed finalization");
    assert.match(footer(job, false), /cleanup pending; next: cancel /);
  } finally { s.done(); }
});

test("answers: none, blank, and open questions", async () => {
  const s = setup();
  try {
    const none = await run(s, { env: { COUNCIL_FAKE_ANSWER: "" } });
    assert.equal(none.job.code, 1);
    assert.equal(none.job.error, "null wrote no answer", "a stream profile with no text writes no answer file");
    {
      const af = { COUNCIL_NULL_OUTPUT: "answer-file" };
      const blank = await run(s, { env: { ...af, COUNCIL_FAKE_ANSWER: "   \n" } });
      assert.equal(blank.job.code, 1);
      assert.equal(blank.job.error, "null returned no answer");
      const questions = await run(s, { env: { ...af, COUNCIL_FAKE_ANSWER: "Outcome: partly done.\nVerification: not run\nOpen questions: should the cache be per user?\nNext: none\n" } });
      assert.equal(questions.job.code, 10, "open questions need Claude's attention");
      assert.equal(questions.job.outcome, "attention");
      assert.match(questions.answer, /should the cache be per user/);
      assert.equal(questions.job.attention, "open questions in the answer", "X1: the footer names the reason");
      assert.match(footer(questions.job, false), / · attention: open questions in the answer/);
      const answered = await run(s, { env: { ...af, COUNCIL_FAKE_ANSWER: "Outcome: done.\nOpen questions: none\nNext: none\n" } });
      assert.equal(answered.job.code, 0);
    }
  } finally { s.done(); }
});

test("a denied action is exit 10 with the answer kept; an incomplete turn is exit 1", async () => {
  const s = setup();
  try {
    const denying = variant({ parseEvent: (line, state) => (JSON.parse(line).type === "progress" ? { denied: "write_file refused by deny rule" } : nullAdapter.parseEvent(line, state)) });
    const denied = await run(s, { adapter: denying, env: { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "50" } });
    assert.equal(denied.job.code, 10);
    assert.equal(denied.job.denied, "write_file refused by deny rule");
    assert.match(denied.answer, /^pong for job /);
    const timingOut = variant({ parseEvent: (line, state) => { const ev = nullAdapter.parseEvent(line, state); return ev?.completed ? { ...ev, incomplete: "print timeout after 5s" } : ev; } });
    const incomplete = await run(s, { adapter: timingOut });
    assert.equal(incomplete.job.code, 1, "a print timeout is exit 1, never 20");
    assert.equal(incomplete.job.error, "print timeout after 5s");
    const review = await run(s, { adapter: timingOut, over: { verb: "review", reviewPrompt: "r", target: "--uncommitted" }, env: { COUNCIL_FAKE_REVIEW: "approve" } });
    assert.equal(review.job.code, 1, "also on a review");
  } finally { s.done(); }
});

test("a child that answers on another thread than the preassigned one fails the turn", async () => {
  const s = setup();
  try {
    const liar = variant({ parseEvent: (line, state) => { const ev = nullAdapter.parseEvent(line, state); return ev?.threadId ? { threadId: "someone-elses-thread" } : ev; } });
    const { job } = await run(s, { adapter: liar });
    assert.equal(job.code, 1);
    assert.match(job.error, /null answered on thread someone-elses-thread, expected [0-9a-f-]{36}/);
    assert.equal(job.threadId, null);
    assert.equal(loadThread(s.home, "null", "someone-elses-thread"), null, "no thread record for a thread the turn never owned");
  } finally { s.done(); }
});

test("the post-exit scan: a survivor is stopped and the turn fails clean; an unknown scan keeps cleanup pending", async () => {
  const s = setup();
  try {
    const real = executionController({ adapter: nullAdapter });
    let alive = true;
    const survivor = { pid: 999001, ppid: 1, stamp: "1", raw: "orphan --job x", argv: ["orphan", "--job", "x"], name: "orphan" };
    const stops = [];
    const control = {
      ...real,
      snapshot: () => ({ state: "ok", rows: alive ? [survivor] : [] }),
      inspect: (job, snap) => ({ state: snap.rows.length ? "owned" : "gone", rows: snap.rows }),
      stop: (row) => { stops.push(row.pid); alive = false; return "sent"; },
    };
    const { job } = await run(s, { hooks: { control } });
    assert.equal(job.code, 1);
    assert.equal(job.error, "owned execution survived the launcher");
    assert.deepEqual(stops, [999001]);
    assert.equal(job.cleanupPending, false, "the survivor was stopped and the rescan confirmed it");
    assert.deepEqual(loadJob(s.home, job.id).execution.map((r) => r.pid), [999001], "recorded before it was stopped");
    const unknown = { ...real, snapshot: () => ({ state: "unknown", rows: [], error: "process query failed: ps exited 1" }), inspect: (job, snap) => ({ state: "unknown", rows: [], error: snap.error }) };
    const u = await run(s, { hooks: { control: unknown } });
    assert.equal(u.job.code, 1);
    assert.equal(u.job.cleanupPending, true);
    assert.equal(u.job.error, "cleanup pending: null or a descendant may still be running; process query failed: ps exited 1");
    assert.equal(u.job.claimHeld, true);
  } finally { s.done(); }
});

test("a stop whose ownership query throws records the failure instead of signalling an unverified pid", async () => {
  const s = setup();
  try {
    const real = executionController({ adapter: nullAdapter });
    let queries = 0;
    const control = { ...real, snapshot: (...a) => { queries += 1; if (queries === 1) throw new Error("ps unavailable"); return real.snapshot(...a); }, stopGroup: async () => ({ attempted: false }) };
    const { job } = await run(s, { hooks: { control }, env: { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "600" }, options: { deadlineMs: 150 } });
    assert.equal(job.code, 1);
    assert.match(job.error, /wall-clock deadline passed|storage\/process query: ps unavailable/);
    assert.ok(queries >= 2, "a later scan still ran");
  } finally { s.done(); }
});

test("the answer-file profile ignores text deltas as the answer; prompt-file input is written before the spawn", async () => {
  const s = setup();
  try {
    let before = null;
    const { job, answer } = await run(s, { env: { COUNCIL_NULL_OUTPUT: "answer-file", COUNCIL_NULL_INPUT: "prompt-file" }, hooks: { beforeSpawn: (j) => { before = readFileSync(join(j.dir, "prompt.md"), "utf8"); } } });
    assert.equal(job.code, 0, job.error);
    assert.equal(before, "<c/>\n\nhello");
    assert.equal(answer, `pong for job ${job.id}`);
    assert.equal(job.turn.promptFile, join(job.dir, "prompt.md"));
    assert.equal(job.turn.answerFile, join(job.dir, "answer.md"));
    assert.deepEqual(job.childArgs.slice(0, 2), ["--job", job.id], "the ownership operand is recorded");
    assert.equal(job.launcher.kind, "node-script");
    assert.ok(existsSync(join(job.dir, "events.jsonl")));
  } finally { s.done(); }
});

test("a resumed turn inherits nothing from a rejected attempt and records rounds on the thread", async () => {
  const s = setup();
  try {
    const first = await run(s);
    const tid = first.job.threadId;
    const second = await run(s, { over: { verb: "reply", thread: { threadId: tid }, round: 2, effort: "low", requestedEffort: "low" } });
    assert.equal(second.job.code, 0, second.job.error);
    const record = loadThread(s.home, "null", tid);
    assert.deepEqual([record.round, record.effort, record.lastJob, record.lastVerb, record.readOnly], [2, "low", second.job.id, "reply", true]);
    const task = await run(s, { over: { verb: "task", readOnly: false, thread: { threadId: tid }, round: 3 } });
    assert.equal(task.job.code, 0, task.job.error);
    assert.equal(loadThread(s.home, "null", tid).readOnly, false);
    assert.equal(task.job.readOnly, false);
    writeFileSync(join(s.root, "marker"), "");
  } finally { s.done(); }
});

test("A5 beforeTurn/afterTurn: once each around the spawn; afterTurn only after verified cleanup; a beforeTurn throw starts nothing", async () => {
  const s = setup();
  try {
    const calls = [];
    const hooked = variant({ beforeTurn: (ctx) => calls.push(["before", ctx.job.id, Boolean(ctx.turn?.args)]), afterTurn: (ctx, outcome) => calls.push(["after", ctx.job.id, outcome.code]) });
    const ok = await run(s, { adapter: hooked });
    assert.deepEqual(calls, [["before", ok.job.id, true], ["after", ok.job.id, 0]]);
    calls.length = 0;
    const failed = await run(s, { adapter: hooked, env: { COUNCIL_FAKE_SCENARIO: "exit-nonzero" } });
    assert.deepEqual(calls.map((c) => c[0]), ["before", "after"], "also after a failure whose cleanup was confirmed");
    assert.equal(calls[1][2], 1);
    calls.length = 0;
    const unknown = { ...executionController({ adapter: nullAdapter }), snapshot: () => ({ state: "unknown", rows: [], error: "no ps" }), inspect: () => ({ state: "unknown", rows: [], error: "no ps" }) };
    await run(s, { adapter: hooked, hooks: { control: unknown } });
    assert.deepEqual(calls.map((c) => c[0]), ["before"], "no afterTurn while cleanup is pending");
    const refusing = variant({ beforeTurn: () => { throw new Error("adapter refused to start"); } });
    const refused = await run(s, { adapter: refusing });
    assert.equal(refused.job.code, 1);
    assert.equal(refused.job.error, "adapter refused to start");
    assert.equal(refused.job.spawnAttempted, undefined, "nothing was spawned");
    const afterFails = variant({ beforeTurn: () => {}, afterTurn: () => { throw new Error("cleanup hook failed"); } });
    const af = await run(s, { adapter: afterFails });
    assert.equal(af.job.code, 0, "the result stands");
    assert.equal(loadJob(s.home, af.job.id).afterTurnError, "cleanup hook failed");
  } finally { s.done(); }
});

test("a cancel that arrives during a task's before-snapshot starts no provider (S7.1 R1)", async () => {
  const s = setup();
  try {
    let spawns = 0, snapshots = 0;
    const { job } = await run(s, {
      over: { verb: "task", readOnly: false },
      hooks: {
        spawn: () => { spawns += 1; throw new Error("no spawn expected"); },
        worktreeSnapshot: () => { snapshots += 1; writeFileSync(join(loadJobDir(s), "cancel"), ""); return { root: s.cwd, head: null, states: new Map() }; },
      },
    });
    assert.equal(snapshots, 1);
    assert.equal(spawns, 0, "zero spawn attempts");
    assert.equal(job.spawnAttempted, undefined);
    assert.equal(job.outcome, "cancelled");
    assert.equal(job.code, 1);
    assert.deepEqual(job.edited, [], "nothing ran, so nothing is compared");
  } finally { s.done(); }
});

