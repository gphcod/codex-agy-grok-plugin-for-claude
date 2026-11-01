// S2.4: lifecycle.mjs — runManagedTurn over the null adapter and the fake child, cancelManaged,
// waitFor and the fatal/completion/cleanup rules. The entry-level paths (main()) follow in S2.6.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nullAdapter from "./fixtures/null-adapter.mjs";
import { GUARD_VARS } from "./fixtures/fake-common.mjs";
import { claimThread, inspectClaim } from "../plugins/council/scripts/lib/core/claims.mjs";
import { executionController } from "../plugins/council/scripts/lib/core/execution.mjs";
import { createJob, homeDir, loadJob, loadThread, saveJob, stateOf } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { PIPE_WAIT_MS, cancelManaged, runManagedTurn, waitFor } from "../plugins/council/scripts/lib/core/lifecycle.mjs";
import { footer } from "../plugins/council/scripts/lib/core/output.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "council-lc-"));
const FAST = { drainMs: 150, shutdownMs: 4000, retryMs: 300, graceMs: 150, pipeWaitMs: 500 };

function setup(profile = {}, env = {}) {
  const root = tmp();
  const home = homeDir({ COUNCIL_HOME: join(root, "home") });
  const cwd = join(root, "work");
  mkdirSync(cwd);
  writeFileSync(join(root, "spawns.log"), "");
  const baseEnv = { ...process.env, COUNCIL_FAKE_SPAWN_LOG: join(root, "spawns.log"), COUNCIL_NULL_ID: "preassigned", COUNCIL_NULL_INPUT: "stdin", COUNCIL_NULL_OUTPUT: "stream", ...env };
  for (const g of GUARD_VARS) delete baseEnv[g];
  for (const [k, v] of Object.entries(profile)) baseEnv[`COUNCIL_NULL_${k.toUpperCase()}`] = v;
  // the adapter reads its profile from the environment the core passes it (ctx.env), never process.env
  const restore = () => rmSync(root, { recursive: true, force: true });
  const ctx = { home, env: baseEnv, cwd, session: "sess-1" };
  const spawns = () => readFileSync(join(root, "spawns.log"), "utf8").split("\n").filter(Boolean).length;
  return { root, home, cwd, ctx, spawns, restore };
}
function request(ctx, over = {}) {
  return { verb: "ask", provider: "null", cwd: ctx.cwd, session: ctx.session, tier: "consult", model: "null-model", effort: "high", requestedEffort: "high", modelVerified: true, thread: null, readOnly: true, text: "hello", contract: "<contract/>", web: false, rounds: 9, round: 1, ...over };
}
async function run(ctx, over = {}, options = {}, hooks = {}, env = {}) {
  const req = request(ctx, over);
  const ctxWithEnv = { ...ctx, env: { ...ctx.env, ...env } };
  return runManagedTurn(ctxWithEnv, nullAdapter, req, () => req, { deadlineMs: 20000, inactivityMs: 20000, ...options }, { ...FAST, ...hooks });
}

test("ok turn in every transport profile: footer, answer, thread record, claim released, guards set on the child", async () => {
  for (const profile of [{ id: "preassigned", input: "stdin", output: "stream" }, { id: "discovered", input: "prompt-file", output: "answer-file" }, { id: "discovered", input: "stdin", output: "stream" }, { id: "preassigned", input: "prompt-file", output: "answer-file" }]) {
    const s = setup(profile);
    try {
      const announced = [];
      const { job, answer } = await run(s.ctx, {}, {}, { announce: (j) => announced.push(j.id) });
      assert.equal(job.code, 0, `${JSON.stringify(profile)}: ${job.error}`);
      assert.equal(job.outcome, "ok");
      assert.equal(answer, `pong for job ${job.id}`);
      assert.match(job.threadId, /^[0-9a-z-]+$/);
      assert.equal(job.provider, "null");
      assert.equal(job.admitted, true);
      assert.equal(job.cleanupPending, false);
      assert.equal(job.claimHeld, false, "claim released after a confirmed clean exit");
      assert.equal(inspectClaim(s.home, "null", job.threadId).state, "absent");
      assert.deepEqual(announced, [job.id], "announced once");
      assert.equal(footer(job, false).startsWith(`council null ok · job ${job.id} · null-model/high · `), true);
      assert.match(footer(job, false), / · round 1\/9 · next: reply /);
      const thread = loadThread(s.home, "null", job.threadId);
      assert.equal(thread.model, "null-model"); assert.equal(thread.round, 1); assert.equal(thread.lastJob, job.id);
      assert.equal(s.spawns(), 1);
      assert.ok(existsSync(join(job.dir, "events.jsonl")));
      assert.equal(readFileSync(join(job.dir, "answer.md"), "utf8"), `pong for job ${job.id}`);
      if (profile.input === "prompt-file") assert.equal(readFileSync(join(job.dir, "prompt.md"), "utf8"), "<contract/>\n\nhello");
    } finally { s.restore(); }
  }
});

test("heartbeat and job record exist before the claim; the record is admitted only after prepare", async () => {
  const s = setup();
  try {
    let seen = null;
    await run(s.ctx, {}, {}, { beforeClaim: (job) => { seen = { beat: existsSync(join(job.dir, "beat")), meta: existsSync(join(job.dir, "meta.json")), admitted: loadJob(s.home, job.id).admitted }; } });
    assert.deepEqual(seen, { beat: true, meta: true, admitted: false });
  } finally { s.restore(); }
});

test("maxLineBytes exceeded fails closed: exit 1, no answer accepted", async () => {
  const s = setup();
  try {
    const { job } = await run(s.ctx, {}, {}, {}, { COUNCIL_FAKE_SCENARIO: "huge-line" });
    assert.equal(job.code, 1);
    assert.match(job.error, /JSONL line over 65536 bytes/);
    assert.equal(job.outcome, "failed");
  } finally { s.restore(); }
});

test("fragmented frames reassemble into one answer", async () => {
  const s = setup();
  try {
    const { job, answer } = await run(s.ctx, {}, {}, {}, { COUNCIL_FAKE_SCENARIO: "fragmented-frames" });
    assert.equal(job.code, 0, job.error);
    assert.equal(answer, `pong for job ${job.id}`);
  } finally { s.restore(); }
});

test("missing completion → exit 1; a non-zero exit → exit 1 with the stderr tail", async () => {
  const s = setup();
  try {
    const none = await run(s.ctx, {}, {}, {}, { COUNCIL_FAKE_SCENARIO: "no-completion" });
    assert.equal(none.job.code, 1);
    assert.match(none.job.error, /null ended without finishing the turn/);
    const nonzero = await run(s.ctx, {}, {}, {}, { COUNCIL_FAKE_SCENARIO: "exit-nonzero" });
    assert.equal(nonzero.job.code, 1);
    assert.match(nonzero.job.error, /simulated crash|ended without finishing/);
  } finally { s.restore(); }
});

test("a fatal latched before an apparent success stays fatal", async () => {
  const s = setup();
  try {
    const { job } = await run(s.ctx, {}, {}, {}, { COUNCIL_FAKE_SCENARIO: "fail-then-success" });
    assert.equal(job.code, 1);
    assert.equal(job.error, "simulated fatal before a later success");
  } finally { s.restore(); }
});

test("trustsCleanExit false → the post-exit scan runs; true → no scan after a clean exit", async () => {
  for (const trust of ["0", "1"]) {
    const s = setup({ trust });
    try {
      let scans = 0;
      const real = executionController({ adapter: nullAdapter });
      const control = { ...real, snapshot: (...a) => { scans += 1; return real.snapshot(...a); } };
      const { job } = await run(s.ctx, {}, {}, { control });
      assert.equal(job.code, 0, job.error);
      if (trust === "0") assert.ok(scans >= 1, "scanned after exit");
      else assert.equal(scans, 0, "a qualified launcher's clean exit is trusted");
    } finally { s.restore(); }
  }
});

test("held pipes beyond the pipe wait on a clean exit → thread locked, cleanup pending, claim kept", async () => {
  const s = setup();
  try {
    assert.equal(PIPE_WAIT_MS, 12000);
    const { job } = await run(s.ctx, {}, {}, { pipeWaitMs: 400 }, { COUNCIL_FAKE_SCENARIO: "hold-pipes", COUNCIL_FAKE_HOLD_MS: "2500" });
    assert.equal(job.code, 1);
    assert.equal(job.unattributedPipes, true);
    assert.equal(job.identifiedStopped, true);
    assert.equal(job.answerComplete, true, "the answer itself was whole");
    assert.equal(job.cleanupPending, true);
    assert.match(job.error, /cleanup pending: null or a descendant may still be running/);
    assert.match(footer(job, false), /answer complete; thread locked: an unidentified process kept the provider's output open; next: a new ask; job /);
    assert.equal(job.claimHeld, true, "the thread stays claimed");
    // and when the holder lets go within the wait, the turn is clean
    const quick = await run(s.ctx, {}, {}, { pipeWaitMs: 3000 }, { COUNCIL_FAKE_SCENARIO: "hold-pipes", COUNCIL_FAKE_HOLD_MS: "400" });
    assert.equal(quick.job.code, 0, quick.job.error);
    assert.equal(quick.job.unattributedPipes, undefined);
  } finally { s.restore(); }
});

test("--deadline and --inactivity-timeout start cleanup and exit 1; the child is gone afterwards", async () => {
  const s = setup();
  try {
    const started = Date.now();
    const deadline = await run(s.ctx, {}, { deadlineMs: 400 }, {}, { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "20000" });
    assert.equal(deadline.job.code, 1);
    assert.equal(deadline.job.error, "wall-clock deadline passed");
    assert.equal(deadline.job.cleanupPending, false, "cleanup confirmed by the post-stop scan");
    assert.ok(Date.now() - started < 15000);
    const inactivity = await run(s.ctx, {}, { inactivityMs: 400 }, {}, { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "20000" });
    assert.equal(inactivity.job.code, 1);
    assert.match(inactivity.job.error, /printed nothing before the inactivity deadline/);
  } finally { s.restore(); }
});

test("cancel with the owner live only writes the marker; the owner stops its child and finalizes as cancelled", async () => {
  const s = setup();
  try {
    let jobId = null;
    const turn = run(s.ctx, {}, {}, { announce: (j) => { jobId = j.id; } }, { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "20000" });
    for (const until = Date.now() + 5000; !jobId || !loadJob(s.home, jobId)?.pid;) { assert.ok(Date.now() < until, "the slow turn never recorded its pid"); await new Promise((r) => setTimeout(r, 20)); }
    const stops = [];
    const real = executionController({ adapter: nullAdapter });
    const control = { ...real, stop: (...a) => { stops.push(a); return real.stop(...a); } };
    const result = await cancelManaged(s.ctx, loadJob(s.home, jobId), { timeoutMs: 10000, control });
    const { job } = await turn;
    assert.equal(result.status, "cancelled");
    assert.equal(result.code, 0);
    assert.deepEqual(stops, [], "cancel never signalled anything while the owner was live");
    assert.equal(job.outcome, "cancelled");
    assert.equal(job.code, 1);
    assert.equal(job.cleanupPending, false);
    assert.equal(stateOf(loadJob(s.home, jobId)), "cancelled");
    assert.match(footer(job, false), /^council null cancelled · /);
  } finally { s.restore(); }
});

test("cancel with the owner gone: identity verified before any signal, then stopped, marked and released", async () => {
  const s = setup();
  try {
    // a job whose companion is dead, with a live-looking child row carrying the --job operand
    const job = createJob(s.home, { provider: "null", verb: "ask", status: "running", cwd: s.cwd, session: "sess-1", threadId: "t-dead", requestedThreadId: "t-dead", threadIds: ["t-dead"], admitted: true, companionPid: 999999, companionIdentity: { pid: 999999, stamp: "Sat Oct 31 00:00:00 2026" }, execution: [], pid: 4242, argv: ["node", "fake-child.mjs", "--job", "x"], spawnedAt: new Date().toISOString() });
    claimThread(s.home, "null", "t-dead", job);
    const childRow = { pid: 4242, ppid: 999999, stamp: "Sat Oct 31 00:00:01 2026", raw: `node fake-child.mjs --job ${job.id}`, argv: ["node", "fake-child.mjs", "--job", job.id], name: "node" };
    let present = true;
    const stops = [];
    const control = executionController({ platform: "linux", adapter: nullAdapter, snapshot: () => ({ state: "ok", rows: present ? [childRow] : [] }), kill: (pid, sig) => { stops.push([pid, sig]); present = false; } });
    const result = await cancelManaged(s.ctx, job, { timeoutMs: 5000, control });
    assert.equal(result.status, "cancelled");
    assert.equal(result.code, 0);
    assert.deepEqual(stops, [[4242, "SIGKILL"]], "the identified child was stopped once");
    const after = loadJob(s.home, job.id);
    assert.equal(after.stopped, true);
    assert.equal(after.cancelRequested, true);
    assert.equal(stateOf(after), "cancelled");
    assert.equal(inspectClaim(s.home, "null", "t-dead").state, "absent", "claim released");
    assert.ok(existsSync(join(job.dir, "cleanup-evidence")), "recovery evidence recorded before the stop");
  } finally { s.restore(); }
});

test("cancel refuses to stop a pid whose timestamp changed, and reports an unknown snapshot", async () => {
  const s = setup();
  try {
    const job = createJob(s.home, { provider: "null", verb: "ask", status: "running", cwd: s.cwd, session: "sess-1", threadId: "t-m", requestedThreadId: "t-m", threadIds: ["t-m"], admitted: true, companionPid: 999998, companionIdentity: { pid: 999998, stamp: "x" }, execution: [{ pid: 5151, stamp: "old-stamp" }], pid: 5151, argv: ["node", "x"], spawnedAt: new Date().toISOString() });
    claimThread(s.home, "null", "t-m", job);
    // the only row with that pid has a different birth stamp: ownedExecution does not match it, nothing is stopped
    const kills = [];
    const rows = [{ pid: 5151, ppid: 1, stamp: "new-stamp", raw: "unrelated process", argv: ["unrelated"], name: "unrelated" }];
    const control = executionController({ platform: "linux", adapter: nullAdapter, snapshot: () => ({ state: "ok", rows }), kill: (...a) => kills.push(a) });
    const result = await cancelManaged(s.ctx, job, { timeoutMs: 3000, control });
    assert.equal(result.status, "cancelled", "nothing owned is left, so the job is marked stopped");
    assert.deepEqual(kills, [], "the reused pid was never signalled");
    // a snapshot that cannot be read keeps the claim and reports unknown
    const job2 = createJob(s.home, { provider: "null", verb: "ask", status: "running", cwd: s.cwd, session: "sess-1", threadId: "t-u", requestedThreadId: "t-u", threadIds: ["t-u"], admitted: true, companionPid: 999997, companionIdentity: { pid: 999997, stamp: "x" }, execution: [], pid: 6161, argv: ["node", "x"], spawnedAt: new Date().toISOString() });
    claimThread(s.home, "null", "t-u", job2);
    const unknown = executionController({ platform: "linux", adapter: nullAdapter, snapshot: () => ({ state: "unknown", rows: [], error: "process query failed: boom" }) });
    const r2 = await cancelManaged(s.ctx, job2, { timeoutMs: 2500, control: unknown });
    assert.equal(r2.status, "unknown"); assert.equal(r2.code, 1);
    assert.match(r2.error, /process query failed: boom; no claim released/);
    assert.equal(inspectClaim(s.home, "null", "t-u").state, "owned");
    // a finished job with nothing pending is reported as finished without any marker
    const done = createJob(s.home, { provider: "null", verb: "ask", status: "done", outcome: "ok", cwd: s.cwd, session: "sess-1", threadId: "t-d", threadIds: [], admitted: true, companionPid: 1, execution: [], spawnedAt: new Date().toISOString() });
    done.cleanupPending = false; saveJob(done); writeFileSync(join(done.dir, "done"), "");
    const r3 = await cancelManaged(s.ctx, loadJob(s.home, done.id), { timeoutMs: 1000, control: unknown });
    assert.equal(r3.status, "finished"); assert.equal(r3.code, 0);
    assert.equal(existsSync(join(done.dir, "cancel")), false);
  } finally { s.restore(); }
});

test("wait --timeout returns 20 while the job runs and prints the result once it ends", async () => {
  const s = setup();
  try {
    let jobId = null;
    const turn = run(s.ctx, {}, {}, { announce: (j) => { jobId = j.id; } }, { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "900" });
    for (const until = Date.now() + 5000; !jobId;) { assert.ok(Date.now() < until, "the slow turn was never announced"); await new Promise((r) => setTimeout(r, 10)); }
    const out = [];
    const code = await waitFor(s.ctx, { timeout: "0.2" }, [jobId], (s2) => out.push(s2), { sleepMs: 20 });
    assert.equal(code, 20);
    assert.match(out[0], new RegExp(`^still running · null · job ${jobId} · \\d+s · last event: `));
    const jsonOut = [];
    assert.equal(await waitFor(s.ctx, { timeout: "0.1", json: true }, [jobId], (s2) => jsonOut.push(s2), { sleepMs: 20 }), 20);
    assert.equal(JSON.parse(jsonOut[0]).exit, 20);
    const { job } = await turn;
    assert.equal(job.code, 0, job.error);
    const final = [];
    assert.equal(await waitFor(s.ctx, { timeout: "5" }, [jobId], (s2) => final.push(s2)), 0);
    assert.match(final[0], new RegExp(`pong for job ${jobId}\ncouncil null ok · job ${jobId}`));
    // bare wait lists this session's jobs in this cwd
    const list = [];
    assert.equal(await waitFor(s.ctx, {}, [], (s2) => list.push(s2)), 0);
    assert.match(list[0], new RegExp(`^${jobId} · null · done · `));
    assert.equal(await waitFor({ ...s.ctx, session: "other" }, {}, [], (s2) => list.push(s2)), 0);
    assert.equal(list[1], "no council jobs in this workspace/session\n");
    await assert.rejects(() => waitFor(s.ctx, {}, ["nope"], () => {}), /no job nope/);
    await assert.rejects(() => waitFor(s.ctx, {}, ["a", "b"], () => {}), /wait accepts one job/);
  } finally { s.restore(); }
});

test("discovered-id profile: the claim is taken on discovery before the id is published; a collision fails the turn", async () => {
  const s = setup({ id: "discovered" });
  try {
    const order = [];
    const { job } = await run(s.ctx, {}, {}, { announce: (j) => order.push(`announce:${j.threadId}:${inspectClaim(s.home, "null", j.threadId).state}`) }, { COUNCIL_FAKE_THREAD: "disc-77" });
    assert.equal(job.code, 0, job.error);
    assert.equal(job.threadId, "disc-77");
    assert.deepEqual(order, ["announce:disc-77:owned"], "announced once the id was claimed");
    // another job already holds that thread
    const holder = createJob(s.home, { provider: "null", verb: "ask", status: "running", cwd: s.cwd, session: "sess-1", threadId: "disc-78", threadIds: ["disc-78"], admitted: true, companionPid: 1, execution: [], spawnedAt: new Date().toISOString() });
    claimThread(s.home, "null", "disc-78", holder);
    const collision = await run(s.ctx, {}, {}, {}, { COUNCIL_FAKE_THREAD: "disc-78" });
    assert.equal(collision.job.code, 1);
    assert.match(collision.job.error, new RegExp(`thread disc-78 is busy as job ${holder.id}`));
    assert.equal(collision.job.threadId, null, "the colliding id was never published");
    assert.equal(inspectClaim(s.home, "null", "disc-78").job, holder.id, "the holder keeps its claim");
    // a resumed discovered thread: --thread is passed and the child must echo it
    const resumed = await run(s.ctx, { verb: "reply", thread: { threadId: "disc-77" }, round: 2 }, {}, {}, {});
    assert.equal(resumed.job.code, 0, resumed.job.error);
    assert.equal(resumed.job.threadId, "disc-77");
    assert.match(footer(resumed.job, false), / · round 2\/9 · /);
    assert.equal(loadThread(s.home, "null", "disc-77").round, 2);
  } finally { s.restore(); }
});

test("preassigned profile: a busy thread is refused before any spawn; cancel before spawn is cancelled with no child", async () => {
  const s = setup();
  try {
    const holder = createJob(s.home, { provider: "null", verb: "ask", status: "running", cwd: s.cwd, session: "sess-1", threadId: "pre-1", threadIds: ["pre-1"], admitted: true, companionPid: 1, execution: [], spawnedAt: new Date().toISOString() });
    claimThread(s.home, "null", "pre-1", holder);
    const busy = await run(s.ctx, { verb: "reply", thread: { threadId: "pre-1" } });
    assert.equal(busy.job.code, 1);
    assert.match(busy.job.error, /thread pre-1 is busy as job/);
    assert.equal(busy.job.admitted, false, "a rejected attempt is never inherited history");
    assert.equal(s.spawns(), 0, "nothing spawned");
    const cancelled = await run(s.ctx, {}, {}, { beforeSpawn: (job) => writeFileSync(join(job.dir, "cancel"), "") });
    assert.equal(cancelled.job.outcome, "cancelled");
    assert.equal(cancelled.job.code, 1);
    assert.equal(s.spawns(), 0);
    assert.equal(cancelled.job.claimHeld, false);
  } finally { s.restore(); }
});

test("review turns: structured output decides the exit; denied and unverified models show in the result", async () => {
  const s = setup();
  try {
    const review = (kind) => run(s.ctx, { verb: "review", target: "--uncommitted", reviewPrompt: "review this", unreviewed: [] }, {}, {}, { COUNCIL_FAKE_REVIEW: kind });
    const approve = await review("approve");
    assert.equal(approve.job.code, 0, approve.job.error); assert.equal(approve.job.verdict, "approve");
    assert.doesNotMatch(footer(approve.job, false), /round|next: reply/);
    const findings = await review("findings");
    assert.equal(findings.job.code, 10); assert.equal(findings.job.outcome, "attention"); assert.equal(findings.job.review.findings.length, 1);
    const none = await review("none");
    assert.equal(none.job.code, 10); assert.equal(none.job.verdict, "incomplete");
    const unreviewed = await run(s.ctx, { verb: "review", target: "--base main", reviewPrompt: "r", unreviewed: ["big.bin"] }, {}, {}, { COUNCIL_FAKE_REVIEW: "approve" });
    assert.equal(unreviewed.job.code, 10, "incomplete coverage never approves");
    assert.match(footer(unreviewed.job, false), / · unreviewed 1/);
    const unverified = await run(s.ctx, { model: "null-mystery", modelVerified: false, requestedEffort: "max", effort: "high" });
    assert.equal(unverified.job.code, 0, unverified.job.error);
    assert.match(footer(unverified.job, false), / · null-mystery\/high<=max · .* · model unverified/);
  } finally { s.restore(); }
});

test("a lost job's heartbeat is not refreshed by a reader; stateOf reads lost after the stale window", async () => {
  const s = setup();
  try {
    const { job } = await run(s.ctx);
    const old = new Date(Date.now() - 60000);
    utimesSync(join(job.dir, "beat"), old, old);
    assert.equal(stateOf(loadJob(s.home, job.id)), "done", "a finished job's state never depends on its beat");
    const running = createJob(s.home, { provider: "null", verb: "ask", status: "running", cwd: s.cwd, session: "sess-1", threadIds: [], admitted: true, companionPid: 1, execution: [], spawnedAt: new Date().toISOString() });
    utimesSync(join(running.dir, "beat"), old, old);
    assert.equal(stateOf(loadJob(s.home, running.id)), "lost");
    const out = [];
    assert.equal(await waitFor(s.ctx, { timeout: "1" }, [running.id], (x) => out.push(x)), 1);
    assert.match(out[0], /companion lost; run cancel before resuming/);
  } finally { s.restore(); }
});
