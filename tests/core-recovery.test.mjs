// S2.7 (ratio): recovery paths of lifecycle.mjs — replayRequest while the first call is preparing or
// gone, fingerprint mismatches on reservations and tombstones, finishedResult on lost and unreadable
// jobs, cancelJob selection and output, and cancelManaged when shutdown cannot be confirmed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "../plugins/council/scripts/lib/core/args.mjs";
import { claimThread, inspectClaim } from "../plugins/council/scripts/lib/core/claims.mjs";
import { executionController } from "../plugins/council/scripts/lib/core/execution.mjs";
import { claimRequest, createJob, homeDir, loadJob, markDone, markRequestPrepared, saveJob } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { cancelJob, cancelManaged, finishedResult, replayRequest, waitFor } from "../plugins/council/scripts/lib/core/lifecycle.mjs";
import nullAdapter from "./fixtures/null-adapter.mjs";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "council-rec-"));
  const home = homeDir({ COUNCIL_HOME: join(root, "home") });
  const cwd = join(root, "work");
  mkdirSync(cwd);
  return { root, home, cwd, ctx: { home, env: process.env, cwd, session: "s" }, done: () => rmSync(root, { recursive: true, force: true }) };
}
const sink = () => { const lines = []; const out = (s, stream = "stdout") => lines.push([stream, s]); out.text = () => lines.filter(([s]) => s === "stdout").map(([, t]) => t).join(""); out.err = () => lines.filter(([s]) => s === "stderr").map(([, t]) => t).join(""); return out; };
const usage = (p, re) => assert.rejects(p, (e) => e instanceof UsageError && (!re || re.test(e.message)));
const liveControl = (rows) => ({ snapshot: () => ({ state: "ok", rows }), self: () => null });
const finished = (s, over = {}) => {
  const job = createJob(s.home, { provider: "null", verb: "ask", status: "done", outcome: "ok", code: 0, cwd: s.cwd, session: "s", threadId: "t-1", threadIds: [], admitted: true, companionPid: 1, execution: [], model: "null-model", effort: "high", round: 1, rounds: 9, spawnedAt: "2026-10-31T10:00:00.000Z", endedAt: "2026-10-31T10:00:03.000Z", cleanupPending: false, ...over }, over.id);
  writeFileSync(join(job.dir, "answer.md"), "stored answer\n");
  markDone(job);
  return job;
};

test("replayRequest: a reservation whose companion is alive and still preparing reports `still preparing` (20) at the deadline", async () => {
  const s = setup();
  try {
    const me = { pid: 4242, stamp: "Sat Oct 31 10:00:00 2026" };
    const claimed = claimRequest(s.home, "null", "prep", { session: "s", cwd: s.cwd }, { fingerprint: "fp", companionPid: me.pid, companionIdentity: me });
    const loser = claimRequest(s.home, "null", "prep", { session: "s", cwd: s.cwd });
    assert.equal(loser.fresh, false);
    const out = sink();
    const code = await replayRequest(s.ctx, { "request-id": "prep", deadline: "0.3" }, loser, "fp", out, { control: liveControl([me]), sleepMs: 20 });
    assert.equal(code, 20);
    assert.match(out.text(), new RegExp(`^still preparing · job ${claimed.id} · the first call with this request id has not recorded its job yet`));
    const json = sink();
    await replayRequest(s.ctx, { "request-id": "prep", deadline: "0.1", json: true }, loser, "fp", json, { control: liveControl([me]), sleepMs: 20 });
    assert.equal(JSON.parse(json.text()).status, "preparing");
  } finally { s.done(); }
});

test("replayRequest: a first call proven gone before preparing frees nothing silently and says a new id is safe", async () => {
  const s = setup();
  try {
    const claimed = claimRequest(s.home, "null", "gone", { session: "s", cwd: s.cwd }, { fingerprint: "fp", companionPid: 999999, companionIdentity: { pid: 999999, stamp: "x" } });
    const view = claimRequest(s.home, "null", "gone", { session: "s", cwd: s.cwd });
    await usage(replayRequest(s.ctx, { "request-id": "gone" }, view, "fp", sink(), { control: liveControl([]), sleepMs: 10 }),
      new RegExp(`request id gone names job ${claimed.id}, whose call ended before the provider started; nothing ran, so a new request id is safe`));
  } finally { s.done(); }
});

test("replayRequest: a released claim, a reservation with other input, and a tombstone with other input", async () => {
  const s = setup();
  try {
    const claimed = claimRequest(s.home, "null", "r", { session: "s", cwd: s.cwd }, { fingerprint: "fp-1" });
    const view = claimRequest(s.home, "null", "r", { session: "s", cwd: s.cwd });
    await usage(replayRequest(s.ctx, { "request-id": "r" }, view, "fp-2", sink(), { control: liveControl([]) }), /was already used with different input/);
    rmSync(join(s.home, "jobs", claimed.id), { recursive: true });
    await usage(replayRequest(s.ctx, { "request-id": "r" }, view, "fp-1", sink(), { control: liveControl([]) }), /its first call failed before the provider started and freed the id; retry with the same id to run it/);
    const fresh = claimRequest(s.home, "null", "t", { session: "s", cwd: s.cwd }, { fingerprint: "fp-1" });
    markRequestPrepared(s.home, fresh.id, { provider: "null", requestId: "t", fingerprint: "fp-1", session: "s", cwd: s.cwd, verb: "ask" });
    const again = claimRequest(s.home, "null", "t", { session: "s", cwd: s.cwd });
    assert.equal(again.tombstone.fingerprint, "fp-1");
    await usage(replayRequest(s.ctx, { "request-id": "t" }, again, "fp-other", sink(), { control: liveControl([]) }), /request id t was already used with different input/);
  } finally { s.done(); }
});

test("replayRequest: a tombstone whose job is still running is awaited and printed with a replay start line", async () => {
  const s = setup();
  try {
    const c = claimRequest(s.home, "null", "w", { session: "s", cwd: s.cwd }, { fingerprint: "fp" });
    markRequestPrepared(s.home, c.id, { provider: "null", requestId: "w", fingerprint: "fp", session: "s", cwd: s.cwd, verb: "ask" });
    const job = createJob(s.home, { provider: "null", verb: "ask", status: "running", cwd: s.cwd, session: "s", threadId: "t-w", threadIds: [], admitted: true, companionPid: process.pid, execution: [], model: "m", effort: "low", round: 1, rounds: 9, spawnedAt: new Date().toISOString() }, c.id);
    setTimeout(() => {
      Object.assign(job, { status: "done", outcome: "ok", code: 0, endedAt: new Date().toISOString(), cleanupPending: false });
      writeFileSync(join(job.dir, "answer.md"), "late answer\n");
      saveJob(job); markDone(job);
    }, 250);
    const out = sink();
    const code = await replayRequest(s.ctx, { "request-id": "w" }, claimRequest(s.home, "null", "w", { session: "s", cwd: s.cwd }), "fp", out, { control: liveControl([]), sleepMs: 20 });
    assert.equal(code, 0);
    assert.match(out.err(), new RegExp(`^\\[council\\] provider=null job=${c.id} thread=t-w replay=w\\n$`));
    assert.match(out.text(), /^late answer\ncouncil null ok · job /);
  } finally { s.done(); }
});

test("finishedResult: a stored answer that cannot be read turns ok into failed; a lost job reads as recovered failure", async () => {
  const s = setup();
  try {
    const ok = finished(s);
    unlinkSync(join(ok.dir, "answer.md"));
    const out = sink();
    assert.equal(finishedResult(s.ctx, {}, loadJob(s.home, ok.id), out), 1);
    assert.match(out.text(), /^council null failed · .* · error: stored answer unreadable: ENOENT/m);
    const lost = createJob(s.home, { provider: "null", verb: "ask", status: "running", cwd: s.cwd, session: "s", threadId: "t-l", threadIds: [], admitted: true, companionPid: 1, execution: [], model: "m", effort: "low", spawnedAt: new Date().toISOString() });
    const old = new Date(Date.now() - 120000);
    utimesSync(join(lost.dir, "beat"), old, old);
    const json = sink();
    assert.equal(finishedResult(s.ctx, { json: true }, loadJob(s.home, lost.id), json), 1);
    const j = JSON.parse(json.text());
    assert.equal(j.error, "companion lost; run cancel before resuming");
    assert.equal(j.cleanupPending, true);
    assert.equal(j.status, "failed");
  } finally { s.done(); }
});

test("waitFor: a thread id resolves with its provider, not without; --json listing", async () => {
  const s = setup();
  try {
    const job = finished(s, { threadId: "native-thread-1" });
    const viaThread = sink();
    assert.equal(await waitFor(s.ctx, {}, ["native-thread-1"], viaThread, { provider: "null" }), 0);
    assert.match(viaThread.text(), /^stored answer\n/);
    await usage(waitFor(s.ctx, {}, ["native-thread-1"], sink()), /no job native-thread-1/);
    const list = sink();
    assert.equal(await waitFor(s.ctx, { json: true }, [], list), 0);
    const [row] = JSON.parse(list.text());
    assert.deepEqual([row.job, row.provider, row.state, row.thread], [job.id, "null", "done", "native-thread-1"]);
    await usage(waitFor(s.ctx, { timeout: "0" }, [job.id], sink()), /--timeout needs a finite positive number/);
  } finally { s.done(); }
});

test("cancelJob: bare cancel picks this session's job that needs cleanup; output names provider and status; controlFor gets the job", async () => {
  const s = setup();
  try {
    finished(s);
    const pending = createJob(s.home, { provider: "null", verb: "ask", status: "running", cwd: s.cwd, session: "s", threadId: "t-p", requestedThreadId: "t-p", threadIds: ["t-p"], admitted: true, companionPid: 999999, companionIdentity: { pid: 999999, stamp: "x" }, execution: [], pid: 31337, argv: ["node", "x"], spawnedAt: new Date().toISOString() });
    claimThread(s.home, "null", "t-p", pending);
    const seen = [];
    const out = sink();
    const code = await cancelJob(s.ctx, { json: true }, [], out, { controlFor: async (job) => { seen.push(job.id); return executionController({ platform: "linux", adapter: nullAdapter, snapshot: () => ({ state: "ok", rows: [] }) }); } });
    assert.equal(code, 0);
    assert.deepEqual(seen, [pending.id], "the job needing cleanup, not the finished one");
    assert.deepEqual(JSON.parse(out.text()), { provider: "null", job: pending.id, status: "cancelled", exit: 0, thread: "t-p", cleanupPending: false, error: null });
    assert.equal(inspectClaim(s.home, "null", "t-p").state, "absent");
    const none = sink();
    assert.equal(await cancelJob({ ...s.ctx, session: "other" }, { json: true }, [], none, { controlFor: async () => { throw new Error("not called"); } }), 0);
    assert.equal(none.text(), '{"status":"none","exit":0}\n');
    await usage(cancelJob(s.ctx, {}, ["a", "b"], sink(), { controlFor: async () => null }), /cancel accepts one job or thread/);
    await usage(cancelJob(s.ctx, {}, ["zzzzzzzzzzzzzzzz"], sink(), { controlFor: async () => null }), /no job zzzzzzzzzzzzzzzz; an unidentified claim requires quiescent manual recovery/);
  } finally { s.done(); }
});

test("cancelManaged: owned rows that never die end in not-stopped; unattributed pipes are never confirmed", async () => {
  const s = setup();
  try {
    const job = createJob(s.home, { provider: "null", verb: "ask", status: "running", cwd: s.cwd, session: "s", threadId: "t-n", threadIds: ["t-n"], admitted: true, companionPid: 999999, companionIdentity: { pid: 999999, stamp: "x" }, execution: [], pid: 5555, argv: ["node", "x"], spawnedAt: new Date().toISOString() });
    claimThread(s.home, "null", "t-n", job);
    const row = { pid: 5555, ppid: 1, stamp: "s", raw: `node x --job ${job.id}`, argv: ["node", "x", "--job", job.id], name: "node" };
    const immortal = executionController({ platform: "linux", adapter: nullAdapter, snapshot: () => ({ state: "ok", rows: [row] }), kill: () => {} });
    const r = await cancelManaged(s.ctx, job, { timeoutMs: 400, control: immortal });
    assert.equal(r.status, "not-stopped");
    assert.equal(r.code, 1);
    assert.match(r.error, /shutdown not confirmed; claim and cancellation request retained; run cancel again/);
    assert.equal(inspectClaim(s.home, "null", "t-n").state, "owned");
    const piped = createJob(s.home, { provider: "null", verb: "ask", status: "failed", outcome: "failed", code: 1, cwd: s.cwd, session: "s", threadId: "t-q", threadIds: ["t-q"], admitted: true, companionPid: 999999, companionIdentity: { pid: 999999, stamp: "x" }, execution: [], unattributedPipes: true, cleanupPending: true, spawnedAt: new Date().toISOString() });
    claimThread(s.home, "null", "t-q", piped);
    markDone(piped);
    const clean = executionController({ platform: "linux", adapter: nullAdapter, snapshot: () => ({ state: "ok", rows: [] }) });
    const p = await cancelManaged(s.ctx, loadJob(s.home, piped.id), { timeoutMs: 500, control: clean });
    assert.equal(p.status, "unknown");
    assert.match(p.error, /execution ownership\/cleanup cannot be confirmed/);
    assert.equal(inspectClaim(s.home, "null", "t-q").state, "owned", "the thread stays locked");
    const ambiguous = executionController({ platform: "linux", adapter: nullAdapter, snapshot: () => ({ state: "ok", rows: [{ pid: 7, ppid: 1, stamp: "s", raw: null, argv: null, name: "node" }] }) });
    const job3 = createJob(s.home, { provider: "null", verb: "ask", status: "running", cwd: s.cwd, session: "s", threadId: "t-r", threadIds: ["t-r"], admitted: true, companionPid: 999999, companionIdentity: { pid: 999999, stamp: "x" }, execution: [], spawnedAt: new Date().toISOString() });
    const a = await cancelManaged(s.ctx, job3, { timeoutMs: 1500, control: ambiguous });
    assert.equal(a.status, "unknown", "an unreadable provider binary row keeps the claim after the look-again window");
  } finally { s.done(); }
});
