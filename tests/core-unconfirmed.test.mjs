// core (S4.8, milestone 3 review Q4): a turn that finishes without the provider confirming its thread
// keeps its answer and exit code, prints the adapter's hint instead of `next: reply`, writes no
// resumable thread record, and a later reply or task --thread on it exits 2 with that hint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nullAdapter from "./fixtures/null-adapter.mjs";
import { GUARD_VARS } from "./fixtures/fake-common.mjs";
import { createReader } from "../plugins/council/scripts/lib/core/reader.mjs";
import { createJob, homeDir, loadThread, saveJob, saveThread } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { runManagedTurn } from "../plugins/council/scripts/lib/core/lifecycle.mjs";
import { footer, recoveryHint } from "../plugins/council/scripts/lib/core/output.mjs";
import { resolveTarget } from "../plugins/council/scripts/council.mjs";

const HINT = "session not confirmed: start a new ask";

test("the reader latches the first unconfirmed signal; a bare true gets a generic hint", () => {
  const adapter = { parseEvent: (line) => JSON.parse(line) };
  const r = createReader({ adapter });
  r.feed(JSON.stringify({ unconfirmed: HINT }) + "\n");
  r.feed(JSON.stringify({ unconfirmed: "later" }) + "\n");
  assert.equal(r.state.unconfirmed, HINT);
  const r2 = createReader({ adapter });
  r2.feed(JSON.stringify({ unconfirmed: true }) + "\n");
  assert.equal(r2.state.unconfirmed, "thread not confirmed: start a new ask");
  assert.equal(createReader({ adapter }).state.unconfirmed, null);
});

test("recoveryHint: the unconfirmed hint replaces next: reply, never on a review, after cleanup pending", () => {
  const base = { id: "j".repeat(16), provider: "grok", verb: "ask", outcome: "ok", model: "m", effort: "low", spawnedAt: new Date().toISOString(), endedAt: new Date().toISOString(), admitted: true };
  assert.equal(recoveryHint({ ...base, threadId: "t", unconfirmed: HINT }), HINT);
  assert.equal(recoveryHint({ ...base, threadId: "t" }), `next: reply ${base.id}`);
  assert.equal(recoveryHint({ ...base, verb: "review", unconfirmed: HINT }), null);
  assert.match(recoveryHint({ ...base, unconfirmed: HINT, cleanupPending: true }), /^cleanup pending/);
  assert.match(footer({ ...base, threadId: null, unconfirmed: HINT, round: 1, rounds: 9 }, false), new RegExp(` · round 1/9 · ${HINT}$`));
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "council-unconf-"));
  const home = homeDir({ COUNCIL_HOME: join(root, "home") });
  const cwd = join(root, "work");
  mkdirSync(cwd);
  writeFileSync(join(root, "spawns.log"), "");
  const env = { ...process.env, COUNCIL_FAKE_SPAWN_LOG: join(root, "spawns.log"), COUNCIL_NULL_ID: "preassigned", COUNCIL_NULL_INPUT: "stdin", COUNCIL_NULL_OUTPUT: "stream" };
  for (const g of GUARD_VARS) delete env[g];
  return { root, home, cwd, ctx: { home, env, cwd, session: "s" }, done: () => rmSync(root, { recursive: true, force: true }) };
}
// The null adapter, except that the child's thread is never confirmed and completion carries the hint.
const unconfirming = Object.create(Object.getPrototypeOf(nullAdapter), Object.getOwnPropertyDescriptors(nullAdapter));
unconfirming.parseEvent = (line, state) => {
  const ev = nullAdapter.parseEvent(line, state);
  if (ev?.threadId) return {};
  return ev?.completed ? { ...ev, unconfirmed: HINT } : ev;
};
const request = (s, over = {}) => ({ verb: "ask", provider: "null", cwd: s.cwd, session: "s", tier: "consult", model: "null-model", effort: "high", requestedEffort: "high", modelVerified: true, thread: null, readOnly: true, text: "hello", contract: "<c/>", web: false, rounds: 9, round: 1, ...over });
const FAST = { drainMs: 150, shutdownMs: process.platform === "win32" ? 20000 : 4000, retryMs: 300, graceMs: 150, pipeWaitMs: 500 };

test("fresh turn: answer kept, exit 0, hint in the footer, no thread record; reply on the job exits 2 with the hint", async () => {
  const s = setup();
  try {
    const req = request(s);
    const { job, answer } = await runManagedTurn(s.ctx, unconfirming, req, () => req, { deadlineMs: 20000, inactivityMs: 20000 }, FAST);
    assert.equal(job.code, 0, job.error);
    assert.equal(answer, `pong for job ${job.id}`);
    assert.equal(job.threadId, null);
    assert.equal(job.unconfirmed, HINT);
    assert.equal(job.claimHeld, false);
    assert.ok(footer(job, false).endsWith(` · ${HINT}`));
    assert.equal(loadThread(s.home, "null", job.requestedThreadId), null);
    const ctx = { ...s.ctx, env: { COUNCIL_TEST_NULL_ADAPTER: "1" } };
    assert.throws(() => resolveTarget(ctx, "reply", { thread: job.id }), (e) => e.exitCode === 2 && e.message === `job ${job.id}: ${HINT}`);
    assert.throws(() => resolveTarget(ctx, "task", { thread: job.id }), (e) => e.exitCode === 2 && e.message.endsWith(HINT));
    // --last selects the fresh unconfirmed job (the latest thread-starting turn) and refuses with its
    // hint, rather than skipping it for an older confirmed thread (milestone 4 review, Argon).
    const older = createJob(s.home, { provider: "null", verb: "ask", cwd: s.cwd, session: "s", threadId: "22222222-2222-4333-8444-555555555555", admitted: true, outcome: "ok", admittedAt: new Date(Date.now() - 60000).toISOString() });
    saveJob(older);
    saveThread(s.home, { provider: "null", threadId: older.threadId, cwd: s.cwd });
    assert.throws(() => resolveTarget(ctx, "reply", { last: true }), (e) => e.exitCode === 2 && e.message === `job ${job.id}: ${HINT}`);
  } finally { s.done(); }
});

test("resumed turn: the thread record becomes not resumable; reply on the thread or an older job exits 2", async () => {
  const s = setup();
  try {
    const threadId = "11111111-2222-4333-8444-555555555555";
    const thread = { provider: "null", threadId, cwd: s.cwd, model: "null-model", effort: "high", tier: "consult", round: 1, rounds: 9 };
    saveThread(s.home, thread);
    const req = request(s, { verb: "reply", thread, round: 2 });
    const { job } = await runManagedTurn(s.ctx, unconfirming, req, () => req, { deadlineMs: 20000, inactivityMs: 20000 }, FAST);
    assert.equal(job.code, 0, job.error);
    assert.equal(job.threadId, threadId);
    assert.ok(footer(job, false).endsWith(` · ${HINT}`), "not next: reply");
    const record = loadThread(s.home, "null", threadId);
    assert.deepEqual([record.resumable, record.unconfirmed, record.round], [false, HINT, 2]);
    // An older job record on the same thread (written afterwards, so it never blocked the turn).
    const old = createJob(s.home, { provider: "null", verb: "ask", cwd: s.cwd, session: "s", threadId, admitted: true, outcome: "ok" });
    saveJob(old);
    const ctx = { ...s.ctx, env: { COUNCIL_TEST_NULL_ADAPTER: "1" } };
    assert.throws(() => resolveTarget(ctx, "reply", { thread: threadId }), (e) => e.exitCode === 2 && e.message === `null thread ${threadId}: ${HINT}`);
    assert.throws(() => resolveTarget(ctx, "reply", { thread: old.id }), (e) => e.exitCode === 2 && e.message.endsWith(HINT), "an older job on the same thread");
    assert.throws(() => resolveTarget(ctx, "reply", { last: true }), (e) => e.exitCode === 2 && e.message.endsWith(HINT));
  } finally { s.done(); }
});

test("a thread record marked not resumable without a reason still refuses", () => {
  const s = setup();
  try {
    saveThread(s.home, { provider: "null", threadId: "t-1", cwd: s.cwd, resumable: false });
    assert.throws(() => resolveTarget({ ...s.ctx, env: { COUNCIL_TEST_NULL_ADAPTER: "1" } }, "reply", { thread: "t-1" }), /null thread t-1: not resumable/);
  } finally { s.done(); }
});
