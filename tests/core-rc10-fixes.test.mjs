// 1.0.0-rc.10 (docs/decisions.md): a thread with no record resumes only from a job whose provider started, and
// recovery of a lost turn marks a session that ran Grok's default agent, so a later read-only reply does not ask it
// to go back to explore. Recovery never writes the thread record, so concurrent cancels cannot regress it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENTRY, SESSION, harness, markers } from "./fixtures/three-providers.mjs";
import { resolveTarget } from "../plugins/council/scripts/council.mjs";
import { claimHeld, claimThread } from "../plugins/council/scripts/lib/core/claims.mjs";
import { canonical } from "../plugins/council/scripts/lib/core/fs.mjs";
import { createJob, homeDir, loadJob, loadThread, markDefaultAgent, markDone, markStopped, saveJob, saveThread, startedOnThread, threadFile } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { cancelManaged } from "../plugins/council/scripts/lib/core/lifecycle.mjs";
import { RESUME_DENY } from "../plugins/council/scripts/lib/providers/grok.mjs";

const THREAD = "44444444-4444-4444-8444-444444444444";
const NO_HISTORY = /has no started history or record; start a new ask/;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "council-rc10-"));
  const home = homeDir({ COUNCIL_HOME: join(root, "home") });
  const cwd = canonical((mkdirSync(join(root, "work")), join(root, "work")));
  return { root, home, cwd, ctx: { env: {}, home, cwd, session: "s" }, done: () => rmSync(root, { recursive: true, force: true }) };
}
let clock = Date.now() - 600000;
/** A job as lifecycle leaves it; each new one is newer than the last. */
function job(s, over = {}, finished = true) {
  const at = new Date(clock += 1000).toISOString();
  const made = createJob(s.home, { provider: "grok", verb: "reply", status: "running", tier: "consult", model: "one-shot-model", effort: "low", cwd: s.cwd, session: "s", threadId: THREAD, requestedThreadId: THREAD, threadIds: [THREAD], admitted: true,
    companionPid: 999999, companionIdentity: { pid: 999999, stamp: "x" }, execution: [], spawnedAt: at, admittedAt: at, round: 5, rounds: 9, roundsSet: false, readOnly: true, web: false, ...over });
  if (finished) { Object.assign(made, { outcome: "failed", status: "failed", code: 1 }); saveJob(made); markDone(made); }
  return made;
}
const record = (s, over = {}) => saveThread(s.home, { provider: "grok", threadId: THREAD, cwd: s.cwd, model: "kept-model", effort: "high", tier: "consult", round: 2, rounds: 9, agent: "explore", readOnly: true, lastJob: "earlier", ...over });
const reply = (s, o) => resolveTarget(s.ctx, "reply", o).thread;
const gone = { snapshot: () => ({ state: "ok", rows: [] }), inspect: () => ({ state: "gone", rows: [] }) };
const cancel = (s, j, control = gone) => cancelManaged(s.ctx, loadJob(s.home, j.id), { timeoutMs: 2000, control });
const marker = (s, id = THREAD) => threadFile(s.home, "grok", id).replace(/\.json$/, ".default-agent");
const lostTask = (s, over = {}) => job(s, { verb: "task", readOnly: false, spawnAttempted: true, pid: 4242, turn: { agent: "default" }, ...over }, false);

test("with no thread record, a job whose provider never started does not speak for the thread", () => {
  const s = setup();
  try {
    // The Codex-hosted audit's case: a one-shot model and round from a turn that never ran.
    const unstarted = job(s);
    assert.throws(() => reply(s, { thread: unstarted.id }), NO_HISTORY);
    assert.throws(() => reply(s, { last: true }), NO_HISTORY);
    assert.throws(() => reply(s, { thread: THREAD }), /no job or thread/, "by native id it refuses earlier, as before");
    assert.equal(startedOnThread(s.home, "grok", THREAD), null);
  } finally { s.done(); }
});

test("with no thread record, the newest started job speaks for it, whichever job was named", () => {
  const s = setup();
  try {
    const started = job(s, { pid: 4242, model: "started-model", round: 3, web: true, readOnly: false, turn: { agent: "default" }, roundsSet: true, rounds: 4 });
    const failedSpawn = job(s, { spawnAttempted: true }); // Finalized with no pid: proven not started.
    const rejected = job(s, { pid: 4243, admitted: false, model: "rejected-model" });
    for (const named of [started.id, failedSpawn.id]) {
      const t = reply(s, { thread: named });
      assert.deepEqual([t.model, t.round, t.web, t.agent, t.readOnly, t.rounds, t.roundsSet, t.cwd], ["started-model", 3, true, "default", false, 4, true, s.cwd], named);
    }
    assert.equal(reply(s, { last: true }).model, "started-model");
    assert.throws(() => reply(s, { thread: rejected.id }), /was not admitted/);
  } finally { s.done(); }
});

test("with no thread record, a job that may have started refuses rather than resuming from an older one", () => {
  const s = setup();
  try {
    job(s, { pid: 4242, model: "older-model" });
    const uncertain = job(s, { spawnAttempted: true }, false);
    markStopped(uncertain); // Recovered by cancel after a crash inside the spawn window.
    assert.equal(startedOnThread(s.home, "grok", THREAD), null);
    assert.throws(() => reply(s, { thread: uncertain.id }), NO_HISTORY);
  } finally { s.done(); }
});

test("with no thread record, an older started job's unconfirmed session stays refused", () => {
  const s = setup();
  try {
    job(s, { pid: 4242, unconfirmed: "session not confirmed: start a new ask" });
    const named = job(s);
    assert.throws(() => reply(s, { thread: named.id }), /session not confirmed: start a new ask/);
  } finally { s.done(); }
});

test("an existing thread record still wins over any job", () => {
  const s = setup();
  try {
    record(s);
    const unstarted = job(s);
    const t = reply(s, { thread: unstarted.id });
    assert.deepEqual([t.model, t.round, t.agent], ["kept-model", 2, "explore"]);
  } finally { s.done(); }
});

test("recovery marks a lost started task; every selector then reads the default agent and no other record field moves", async () => {
  const s = setup();
  try {
    record(s);
    const before = readFileSync(threadFile(s.home, "grok", THREAD), "utf8");
    const lost = lostTask(s);
    claimThread(s.home, "grok", THREAD, lost);
    const result = await cancel(s, lost);
    assert.equal(result.code, 0, result.error);
    assert.ok(existsSync(marker(s)));
    assert.ok(loadJob(s.home, lost.id).stopped);
    assert.equal(claimHeld(s.home, lost), false);
    assert.equal(readFileSync(threadFile(s.home, "grok", THREAD), "utf8"), before, "recovery never writes the record");
    for (const o of [{ thread: lost.id }, { thread: THREAD }, { last: true }]) {
      const t = reply(s, o);
      assert.deepEqual([t.agent, t.model, t.round], ["default", "kept-model", 2], JSON.stringify(o));
    }
  } finally { s.done(); }
});

test("recovery marks a job that may have started, and not one that never started or ran explore", async () => {
  for (const [over, marked] of [[{ pid: null }, true], [{ spawnAttempted: false, pid: null }, false], [{ turn: { agent: "explore" } }, false], [{ turn: { agent: null } }, false], [{ threadId: null }, false]]) {
    const s = setup();
    try {
      record(s);
      const lost = lostTask(s, over);
      const result = await cancel(s, lost);
      assert.equal(result.code, 0, result.error);
      assert.equal(existsSync(marker(s)), marked, JSON.stringify(over));
    } finally { s.done(); }
  }
});

test("recovery of a first turn, with no threads directory yet, still finishes and marks", async () => {
  const s = setup();
  try {
    assert.equal(existsSync(join(s.home, "threads")), false);
    const lost = lostTask(s);
    const result = await cancel(s, lost);
    assert.equal(result.code, 0, result.error);
    assert.ok(loadJob(s.home, lost.id).stopped);
    assert.ok(existsSync(marker(s)));
  } finally { s.done(); }
});

test("a marker that already exists succeeds, and an uppercase native id reads through the same record", async () => {
  const s = setup();
  try {
    markDefaultAgent(s.home, "grok", "TID-1");
    assert.doesNotThrow(() => markDefaultAgent(s.home, "grok", "TID-1"));
    saveThread(s.home, { provider: "grok", threadId: "tid-1", cwd: s.cwd, agent: "explore" });
    assert.equal(loadThread(s.home, "grok", "tid-1").agent, "default");
    assert.equal(loadThread(s.home, "grok", "TID-1").agent, "default");
  } finally { s.done(); }
});

for (const [name, method] of [["writing the marker", "writeFileSync"], ["creating its directory", "mkdirSync"]]) {
  test(`a failure ${name} keeps the claim and writes no stopped; cancel then retries it`, async (t) => {
    const s = setup();
    try {
      record(s);
      const lost = lostTask(s);
      claimThread(s.home, "grok", THREAD, lost);
      const real = fs[method];
      const matches = (target) => method === "writeFileSync" ? String(target) === marker(s) : String(target) === join(s.home, "threads");
      const mocked = t.mock.method(fs, method, function (target, ...rest) {
        if (matches(target)) throw Object.assign(new Error("EACCES: denied"), { code: "EACCES" });
        return real.call(this, target, ...rest);
      });
      const failed = await cancel(s, lost);
      assert.deepEqual([failed.status, failed.code], ["unknown", 1]);
      assert.match(failed.error, /cannot save the thread's agent: EACCES: denied; claim and cancellation request retained/);
      assert.equal(loadJob(s.home, lost.id).stopped, false);
      assert.equal(claimHeld(s.home, lost), true);
      mocked.mock.restore();
      const retried = await cancel(s, lost);
      assert.equal(retried.code, 0, retried.error);
      assert.ok(loadJob(s.home, lost.id).stopped);
      assert.equal(reply(s, { thread: lost.id }).agent, "default");
    } finally { s.done(); }
  });
}

for (const code of ["EBUSY", "EPERM", "EACCES"]) {
  test(`a marker lookup failing with ${code} refuses; it never reads as explore`, (t) => {
    const s = setup();
    try {
      record(s);
      markDefaultAgent(s.home, "grok", THREAD);
      const real = fs.statSync;
      const mocked = t.mock.method(fs, "statSync", function (target, ...rest) {
        if (String(target) === marker(s)) throw Object.assign(new Error(`${code}: locked`), { code });
        return real.call(this, target, ...rest);
      });
      assert.throws(() => reply(s, { thread: THREAD }), new RegExp(`retry: thread ${THREAD} cannot be read right now \\(${code}\\)`));
      mocked.mock.restore();
      assert.equal(reply(s, { thread: THREAD }).agent, "default");
    } finally { s.done(); }
  });
}

test("a delayed second canceller cannot regress the record, whichever job it holds", async () => {
  for (const agent of ["default", "explore"]) {
    const s = setup();
    try {
      record(s);
      const lost = lostTask(s, { turn: { agent } });
      let finalized = "";
      // Past its early checks, this canceller waits while another recovers the job and a later turn finalizes.
      const delayed = { ...gone, inspect: () => {
        markStopped(loadJob(s.home, lost.id));
        saveThread(s.home, { provider: "grok", threadId: THREAD, cwd: s.cwd, model: "newer-model", round: 7, rounds: 9, agent: "default", lastJob: "later" });
        finalized = readFileSync(threadFile(s.home, "grok", THREAD), "utf8");
        return gone.inspect();
      } };
      const result = await cancel(s, lost, delayed);
      assert.equal(result.code, 0, result.error);
      assert.equal(readFileSync(threadFile(s.home, "grok", THREAD), "utf8"), finalized, agent);
      const t = reply(s, { thread: THREAD });
      assert.deepEqual([t.model, t.round, t.lastJob, t.agent], ["newer-model", 7, "later", "default"], agent);
      assert.equal(existsSync(marker(s)), agent === "default");
    } finally { s.done(); }
  }
});

test("a turn that finishes writes no marker, and a healthy reply's record stays what finalization saved", () => {
  const s = setup();
  try {
    record(s, { agent: "default", readOnly: false });
    assert.equal(existsSync(marker(s)), false);
    assert.equal(reply(s, { thread: THREAD }).agent, "default");
    assert.equal(existsSync(marker(s)), false, "reading never writes");
  } finally { s.done(); }
});

test("end to end: kill the companion during task --thread, cancel, and a read-only reply keeps the session on the default agent", async () => {
  const h = harness();
  try {
    const first = await h.turn("grok", ["ask", "--to", "grok", "--effort", "low"], "start the thread");
    assert.equal(first.code, 0, first.err + first.out);
    const thread = h.job(first.job).threadId;
    assert.ok(thread);
    const text = "make the edit";
    const companion = spawn(process.execPath, [ENTRY, "task", "--thread", first.job, "--effort", "low", "--session", SESSION, "--", text], {
      cwd: h.repo, env: { ...h.base, ...markers("grok", text), COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "120000" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    const closed = new Promise((resolve) => companion.on("close", resolve));
    let err = "";
    const id = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no start line: ${err}`)), 60000);
      companion.stderr.on("data", (chunk) => {
        err += chunk;
        const m = /job=([a-z0-9]{16})/.exec(err);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
    });
    assert.ok(h.job(id).pid, "the start line follows the durable pid");
    companion.kill("SIGKILL");
    await closed;

    const stale = JSON.parse(readFileSync(threadFile(canonical(h.home), "grok", thread), "utf8"));
    assert.equal(stale.agent, "explore", "the lost task never saved its agent");
    const blocked = await h.turn("grok", ["reply", "--thread", id, "--effort", "low"], "too early", { COUNCIL_FAKE_SCENARIO: "resume" });
    assert.notEqual(blocked.code, 0, "the lost job blocks its thread until cancel");

    const cancelled = await h.run(["cancel", id, "--session", SESSION]);
    assert.equal(cancelled.code, 0, cancelled.err + cancelled.out);

    const next = await h.turn("grok", ["reply", "--thread", id, "--effort", "low"], "read it back", { COUNCIL_FAKE_SCENARIO: "resume" });
    assert.equal(next.code, 0, next.err + next.out);
    const { argv } = h.invocations().at(-1);
    assert.equal(argv.includes("--agent"), false, "explore is not requested of a session that ran the default agent");
    assert.equal(argv[argv.indexOf("--disallowed-tools") + 1], RESUME_DENY.join(","));
    assert.equal(argv[argv.indexOf("-r") + 1], thread);
  } finally { h.done(); }
});
