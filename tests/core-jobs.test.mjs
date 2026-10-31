// S2.3: jobs.mjs, claims.mjs, heartbeat.mjs at the function level. The request-id replay paths that
// run through main() (tombstone replay without a spawn, concurrent identical requests, reply --last
// recovery) are in core-entry.test.mjs once S2.6 wires the entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "../plugins/council/scripts/lib/core/args.mjs";
import { canonical } from "../plugins/council/scripts/lib/core/fs.mjs";
import { BusyError, claimHeld, claimPath, claimThread, inspectClaim, ownedThreads, releaseClaims, releaseThread } from "../plugins/council/scripts/lib/core/claims.mjs";
import { BEAT_MS, BEAT_STALE_MS, beatMs, refreshBeat, startBeat, touchBeat } from "../plugins/council/scripts/lib/core/heartbeat.mjs";
import {
  EXPIRED, KEEP_FINISHED, REQUEST_ID, blockingJob, candidates, claimRequest, cleanupNeeded, createJob, describeEvent, findJob, homeDir, lastEvent, latestOnThread,
  listJobs, loadJob, loadRequest, loadThread, loadTombstone, markDone, markRequestPrepared, markStopped, neverPrepared, onThread, prune, releaseRequest,
  requestJobId, requestReserved, resultRecord, saveJob, saveThread, stateOf, threadFile,
} from "../plugins/council/scripts/lib/core/jobs.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "council-jobs-"));
const home = () => homeDir({ COUNCIL_HOME: tmp() });
const fields = (over = {}) => ({ provider: "codex", verb: "ask", status: "running", cwd: "/w", session: "s1", threadId: null, requestedThreadId: null, threadIds: [], admitted: false, spawnedAt: new Date().toISOString(), ...over });

test("homeDir: COUNCIL_HOME override, created and canonical", () => {
  const dir = tmp();
  const h = homeDir({ COUNCIL_HOME: join(dir, "nested", "root") });
  assert.equal(h, realpathSync(join(dir, "nested", "root")));
  assert.ok(existsSync(h));
  const def = homeDir({ HOME: dir });
  assert.match(def, /\.council$/);
});

test("both id routes produce 16 characters", () => {
  const h = home();
  const job = createJob(h, fields());
  assert.match(job.id, /^[a-z0-9]{16}$/);
  const id = requestJobId("grok", "s1", "/w", "req-1");
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(requestJobId("grok", "s1", "/w", "req-1"), id, "deterministic");
  assert.notEqual(requestJobId("codex", "s1", "/w", "req-1"), id, "provider is part of the key");
  assert.notEqual(requestJobId("grok", "s2", "/w", "req-1"), id, "session is part of the key");
  assert.notEqual(requestJobId("grok", "s1", "/x", "req-1"), id, "cwd is part of the key");
  assert.notEqual(requestJobId("grok", null, "/w", "req-1"), id);
  assert.ok(REQUEST_ID.test("a"), "one character");
  assert.ok(REQUEST_ID.test("x".repeat(128)));
  assert.ok(!REQUEST_ID.test("x".repeat(129)));
  assert.ok(!REQUEST_ID.test("-leading"));
  assert.ok(!REQUEST_ID.test("has space"));
  assert.throws(() => createJob(h, { verb: "ask" }), /needs its provider/);
});

test("heartbeat before the job record; beat helpers", () => {
  const h = home();
  const job = createJob(h, fields());
  assert.ok(beatMs(job.dir) > 0, "beat exists after createJob");
  const loaded = loadJob(h, job.id);
  assert.equal(stateOf(loaded), "running");
  const old = new Date(Date.now() - BEAT_STALE_MS - 1000);
  utimesSync(join(job.dir, "beat"), old, old);
  assert.equal(stateOf(loadJob(h, job.id)), "lost");
  touchBeat(job);
  assert.equal(stateOf(loadJob(h, job.id)), "running");
  assert.equal(refreshBeat({ dir: join(h, "nowhere") }), false, "a failed refresh is swallowed");
  rmSync(join(job.dir, "beat"));
  assert.equal(beatMs(job.dir), 0);
  touchBeat(job);
  assert.ok(beatMs(job.dir) > 0, "touchBeat recreates a missing beat");
  let now = 0;
  const failures = [];
  const beater = startBeat(job, { intervalMs: BEAT_MS, now: () => now, onFailure: (e) => failures.push(e) });
  now = BEAT_MS - 1; beater.tick(); assert.equal(beater.lastBeatAt, 0, "no refresh before the interval");
  now = BEAT_MS; beater.tick(); assert.equal(beater.lastBeatAt, BEAT_MS);
  let clock = 0;
  const broken = startBeat({ dir: join(h, "missing-dir") }, { intervalMs: 1, now: () => (clock += 5), onFailure: (e) => failures.push(e) });
  broken.tick(); broken.tick();
  assert.equal(failures.length, 1, "storage failure reported once");
});

test("claims are provider-namespaced; a Grok and a Codex claim on the same thread id coexist", () => {
  const h = home();
  const codex = createJob(h, fields({ provider: "codex" }));
  const grok = createJob(h, fields({ provider: "grok" }));
  assert.equal(claimPath(h, "codex", "ABC-1"), join(h, "claims", "codex", "abc-1"), "lowercased, under the provider");
  claimThread(h, "codex", "shared-thread", codex);
  claimThread(h, "grok", "shared-thread", grok);
  assert.equal(inspectClaim(h, "codex", "shared-thread").job, codex.id);
  assert.equal(inspectClaim(h, "grok", "shared-thread").job, grok.id);
  assert.deepEqual(ownedThreads(h, codex), ["shared-thread"]);
  assert.deepEqual(ownedThreads(h, grok), ["shared-thread"]);
  // a second codex job on the same thread is busy, with the holder's id
  const other = createJob(h, fields({ provider: "codex" }));
  assert.throws(() => claimThread(h, "codex", "shared-thread", other), (e) => e instanceof BusyError && e.job === codex.id && /wait or cancel/.test(e.message));
  // the same job may re-claim its own thread
  claimThread(h, "codex", "shared-thread", codex);
  assert.equal(claimHeld(h, codex), true);
  releaseClaims(h, codex);
  assert.equal(claimHeld(h, codex), false);
  assert.equal(inspectClaim(h, "codex", "shared-thread").state, "absent");
  assert.equal(inspectClaim(h, "grok", "shared-thread").state, "owned", "releasing codex leaves grok's claim");
  assert.equal(releaseThread(h, "codex", "shared-thread", codex), false, "a second release is a no-op");
  // an unidentifiable claim is unknown, never free, and counts as held for a job that names the thread
  mkdirSync(join(h, "claims", "codex", "orphan"));
  assert.equal(inspectClaim(h, "codex", "orphan").state, "unknown");
  assert.equal(claimHeld(h, { ...other, threadIds: ["orphan"] }), true);
  assert.throws(() => claimThread(h, "codex", "orphan", other), (e) => e instanceof BusyError && /unidentified claim/.test(e.message));
  assert.throws(() => claimThread(h, "codex", "../escape", other), /invalid codex thread id/);
  assert.throws(() => claimThread(h, "codex", "t", { id: "x", ownerToken: "short" }), /no valid claim owner token/);
  assert.deepEqual(ownedThreads(h, { id: "x" }), [], "no token, no owned threads");
});

test("two providers with the same native thread id keep separate history, inheritance and blocking", () => {
  const h = home();
  const codex = createJob(h, fields({ provider: "codex", threadId: "tid-1", admitted: true, model: "gpt-6.1-sol" }));
  const grok = createJob(h, fields({ provider: "grok", threadId: "tid-1", admitted: true, model: "grok-4.7" }));
  assert.equal(onThread(codex, "codex", "TID-1"), true);
  assert.equal(onThread(codex, "grok", "tid-1"), false, "provider must match");
  assert.equal(latestOnThread(h, "codex", "tid-1").id, codex.id);
  assert.equal(latestOnThread(h, "grok", "tid-1").id, grok.id);
  assert.equal(latestOnThread(h, "gemini", "tid-1"), null);
  assert.equal(blockingJob(h, "codex", "tid-1").id, codex.id, "an unfinished job blocks its own provider's thread");
  markDone(codex); saveJob({ ...codex, cleanupPending: false });
  assert.equal(blockingJob(h, "codex", "tid-1"), null);
  assert.equal(blockingJob(h, "grok", "tid-1").id, grok.id);
  const rejected = createJob(h, fields({ provider: "codex", threadId: "tid-1", admitted: false }));
  assert.equal(latestOnThread(h, "codex", "tid-1").id, codex.id, "an unadmitted attempt never becomes history");
  assert.equal(latestOnThread(h, "codex", "tid-1", codex.id), null, "excludeId");
  assert.equal(findJob(h, rejected.id).id, rejected.id, "a named id resolves regardless of provider");
  assert.equal(findJob(h, "tid-1", "grok").id, grok.id);
  assert.equal(findJob(h, "tid-1"), null, "a bare thread id needs its provider");
  // thread records are provider-namespaced files
  saveThread(h, { provider: "codex", threadId: "tid-1", cwd: "/w", model: "gpt-6.1-sol", effort: "high", tier: "consult", round: 1, rounds: 9 });
  saveThread(h, { provider: "grok", threadId: "TID-1", cwd: "/w", model: "grok-4.7", effort: "low", tier: "consult", round: 1, rounds: 9, agent: "explore" });
  assert.equal(loadThread(h, "codex", "tid-1").model, "gpt-6.1-sol");
  assert.equal(loadThread(h, "grok", "tid-1").agent, "explore");
  assert.equal(threadFile(h, "grok", "TID-1"), join(h, "threads", "grok-tid-1.json"));
  const merged = saveThread(h, { provider: "grok", threadId: "tid-1", round: 2 });
  assert.equal(merged.model, "grok-4.7", "saveThread merges");
  assert.equal(merged.round, 2);
  assert.equal(loadThread(h, "gemini", "tid-1"), null);
  assert.throws(() => saveThread(h, { provider: "grok" }), /needs provider and threadId/);
});

test("/tmp and /private/tmp map to one claim through a symlinked workspace", () => {
  const root = tmp();
  const real = join(root, "real");
  mkdirSync(real);
  const link = join(root, "link");
  symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
  assert.equal(canonical(link), realpathSync(real));
  const h = homeDir({ COUNCIL_HOME: join(root, "home") });
  const viaLink = requestJobId("codex", "s", canonical(link), "r1");
  const viaReal = requestJobId("codex", "s", canonical(real), "r1");
  assert.equal(viaLink, viaReal, "the same request id through both spellings claims one job");
  const first = claimRequest(h, "codex", "r1", { session: "s", cwd: canonical(link) });
  const second = claimRequest(h, "codex", "r1", { session: "s", cwd: canonical(real) });
  assert.equal(first.fresh, true);
  assert.equal(second.fresh, false);
  assert.equal(second.id, first.id);
  // the candidate filter sees one cwd for both
  const job = createJob(h, fields({ cwd: canonical(link), session: "s" }));
  assert.equal(candidates(h, { cwd: canonical(real), session: "s" })[0]?.id, job.id);
});

test("candidates: same cwd and same session, both required; a named id resolves across sessions", () => {
  const h = home();
  const mine = createJob(h, fields({ cwd: "/w", session: "s1" }));
  const otherSession = createJob(h, fields({ cwd: "/w", session: "s2" }));
  const otherCwd = createJob(h, fields({ cwd: "/elsewhere", session: "s1" }));
  const noSession = createJob(h, fields({ cwd: "/w", session: null }));
  assert.deepEqual(candidates(h, { cwd: "/w", session: "s1" }).map((j) => j.id), [mine.id]);
  assert.deepEqual(candidates(h, { cwd: "/w", session: null }).map((j) => j.id), [noSession.id]);
  assert.deepEqual(candidates(h, { cwd: "/w", session: undefined }).map((j) => j.id), [noSession.id]);
  assert.deepEqual(candidates(h, { cwd: "/elsewhere", session: "s1" }).map((j) => j.id), [otherCwd.id]);
  assert.equal(findJob(h, otherSession.id).session, "s2");
  assert.equal(loadJob(h, "../../etc"), null);
  assert.equal(loadJob(h, "nope"), null);
});

test("prune: finished bodies past the keep count move through trash/; running, lost, cleanup-pending and claim-holding jobs stay; thread records survive", () => {
  const h = home();
  const made = [];
  for (let i = 0; i < 6; i++) {
    const job = createJob(h, fields({ spawnedAt: new Date(Date.now() - (100 - i) * 1000).toISOString(), admittedAt: new Date(Date.now() - (100 - i) * 1000).toISOString() }));
    Object.assign(job, { status: "done", outcome: "ok", code: 0, cleanupPending: false, admitted: true });
    saveJob(job); markDone(job);
    made.push(job);
  }
  const running = createJob(h, fields({ admitted: true }));
  const lost = createJob(h, fields({ admitted: true }));
  const old = new Date(Date.now() - BEAT_STALE_MS * 2);
  utimesSync(join(lost.dir, "beat"), old, old);
  const pending = createJob(h, fields({ admitted: true }));
  Object.assign(pending, { status: "failed", outcome: "failed", code: 1, cleanupPending: true }); saveJob(pending); markDone(pending);
  const holder = createJob(h, fields({ admitted: true, threadId: "held", threadIds: ["held"] }));
  claimThread(h, "codex", "held", holder);
  Object.assign(holder, { status: "done", outcome: "ok", code: 0, cleanupPending: false }); saveJob(holder); markDone(holder);
  const stopped = createJob(h, fields({ admitted: true }));
  markStopped(stopped);
  saveThread(h, { provider: "codex", threadId: "held", cwd: "/w" });
  assert.equal(stateOf(loadJob(h, running.id)), "running");
  assert.equal(stateOf(loadJob(h, lost.id)), "lost");
  assert.equal(stateOf(loadJob(h, stopped.id)), "failed");
  assert.equal(cleanupNeeded(loadJob(h, pending.id)), true);
  // keep the newest 3 finished: holder and stopped are newer than the six old ones
  prune(h, 3);
  const left = new Set(listJobs(h).map((j) => j.id));
  for (const j of [running, lost, pending, holder, stopped]) assert.ok(left.has(j.id), `${j.id} kept`);
  const oldLeft = made.filter((j) => left.has(j.id));
  assert.equal(oldLeft.length, 1, "the newest of the six old finished jobs survives with holder and stopped as the keep-3");
  assert.equal(oldLeft[0].id, made[5].id);
  assert.deepEqual(readdirSync(join(h, "trash")), [], "trash emptied");
  assert.ok(existsSync(threadFile(h, "codex", "held")), "thread record survives prune");
  assert.equal(KEEP_FINISHED, 100);
  // default keep: creating jobs prunes nothing below 100
  prune(h);
  assert.equal(listJobs(h).length, 1 + 5);
});

test("request lifecycle: claim → prepare (tombstone) → replay/expired; release only before the tombstone", () => {
  const h = home();
  const scope = { session: "s1", cwd: "/w" };
  const first = claimRequest(h, "grok", "req-A", scope, { companionPid: 1, companionIdentity: null });
  assert.equal(first.fresh, true);
  assert.match(first.id, /^[0-9a-f]{16}$/);
  assert.ok(requestReserved(h, first.id));
  const reservation = loadRequest(h, first.id);
  assert.equal(reservation.provider, "grok"); assert.equal(reservation.requestId, "req-A"); assert.equal(reservation.claim, first.claim);
  assert.equal(neverPrepared(h, first.id, reservation), true);
  // a concurrent identical claim loses and sees the reservation, no tombstone yet
  const loser = claimRequest(h, "grok", "req-A", scope);
  assert.equal(loser.fresh, false); assert.equal(loser.id, first.id); assert.equal(loser.tombstone, null); assert.equal(loser.reservation.claim, first.claim);
  // a different provider with the same request id is a different job (claim key includes the provider)
  const codex = claimRequest(h, "codex", "req-A", scope);
  assert.equal(codex.fresh, true); assert.notEqual(codex.id, first.id);
  // release before prepare: the same id runs again
  releaseRequest(h, codex.id);
  assert.equal(requestReserved(h, codex.id), false);
  assert.equal(claimRequest(h, "codex", "req-A", scope).fresh, true);
  // prepare writes the immutable tombstone; the job record follows
  const tomb = markRequestPrepared(h, first.id, { provider: "grok", requestId: "req-A", fingerprint: "fp-1", verb: "ask", ...scope });
  assert.equal(tomb.fingerprint, "fp-1");
  assert.deepEqual(loadTombstone(h, first.id), tomb);
  assert.throws(() => markRequestPrepared(h, first.id, { provider: "grok", requestId: "req-A", fingerprint: "fp-2", verb: "ask", ...scope }), /EEXIST/);
  assert.equal(loadTombstone(h, first.id).fingerprint, "fp-1", "immutable");
  assert.equal(neverPrepared(h, first.id, reservation), false);
  assert.throws(() => releaseRequest(h, first.id), /was prepared; its claim cannot be released/);
  const job = createJob(h, fields({ provider: "grok", requestId: "req-A", fingerprint: "fp-1" }), first.id);
  assert.equal(job.id, first.id);
  // a later claim with the same id finds the tombstone first
  const replay = claimRequest(h, "grok", "req-A", scope);
  assert.equal(replay.fresh, false); assert.equal(replay.tombstone.fingerprint, "fp-1");
  // with the job body pruned, the tombstone remains: result expired, never a second run
  rmSync(job.dir, { recursive: true, force: true });
  const expired = claimRequest(h, "grok", "req-A", scope);
  assert.equal(expired.fresh, false); assert.equal(expired.tombstone.job, first.id); assert.equal(loadJob(h, first.id), null);
  assert.equal(EXPIRED, "result expired");
  assert.throws(() => claimRequest(h, "grok", "bad id", scope), (e) => e instanceof UsageError && /--request-id needs/.test(e.message));
});

test("resultRecord, describeEvent and lastEvent", () => {
  const h = home();
  const job = createJob(h, fields({ admitted: true }));
  assert.equal(resultRecord(loadJob(h, job.id)).error, "companion lost; run cancel before resuming");
  markStopped(job);
  writeFileSync(join(job.dir, "cancel"), "");
  const stopped = loadJob(h, job.id);
  assert.equal(resultRecord(stopped).outcome, "cancelled");
  assert.equal(stateOf(stopped), "cancelled");
  assert.equal(describeEvent({ type: "item.completed", item: { type: "agent_message" } }), "item.completed:agent_message");
  assert.equal(describeEvent({ event: "step_update", step_update: { step_type: "tool" } }), "step_update:tool");
  assert.equal(describeEvent({ type: "end" }), "end");
  assert.equal(describeEvent({ event: "result" }), "result");
  assert.equal(describeEvent({ foo: 1 }), null);
  assert.equal(lastEvent(job), null);
  writeFileSync(join(job.dir, "events.jsonl"), 'garbage\n{"type":"started"}\n{"event":"step_update","step_update":{"step_type":"agent_response"}}\n{"type":"partial');
  assert.equal(lastEvent(job), "step_update:agent_response");
});
