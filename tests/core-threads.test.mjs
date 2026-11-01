// S2.7 (ratio): thread identity across providers through the entry (A7.3), the unexpanded session
// placeholder, wait by native thread id, and a stop whose shutdown budget runs out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import nullAdapter from "./fixtures/null-adapter.mjs";
import { main } from "../plugins/council/scripts/council.mjs";
import { GUARD_VARS } from "../plugins/council/scripts/lib/core/execution.mjs";
import { canonical } from "../plugins/council/scripts/lib/core/fs.mjs";
import { homeDir, loadJob, saveThread } from "../plugins/council/scripts/lib/core/jobs.mjs";
/** Real provider modules hidden from these core tests (council.mjs adapterFile seam), so none launches a real CLI. */
const ABSENT = "codex,gemini,grok";
import { runManagedTurn } from "../plugins/council/scripts/lib/core/lifecycle.mjs";

function harness() {
  const root = mkdtempSync(join(tmpdir(), "council-threads-"));
  const cwd = join(root, "work");
  mkdirSync(cwd);
  const env = { ...process.env, COUNCIL_TEST_NULL_ADAPTER: "1", COUNCIL_TEST_ABSENT_PROVIDERS: ABSENT, COUNCIL_HOME: join(root, "home"), COUNCIL_STDIN_DEADLINE_MS: "300" };
  for (const g of GUARD_VARS) delete env[g];
  delete env.COUNCIL_FAKE_SCENARIO;
  const call = async (argv, extra = {}) => {
    let out = "", err = "";
    const stdin = new PassThrough(); stdin.end("");
    const code = await main(argv, { ...env, ...extra }, { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, stdin, cwd });
    return { code, out, err };
  };
  return { root, cwd, env, call, home: () => canonical(join(root, "home")), done: () => rmSync(root, { recursive: true, force: true }) };
}

test("a native thread id two providers share is ambiguous without --to and resolves with it", async () => {
  const h = harness();
  try {
    const ask = await h.call(["ask", "--to", "null", "--session", "s", "--", "start"]);
    const thread = /thread=([0-9a-f-]{36})/.exec(ask.err)[1];
    saveThread(h.home(), { provider: "codex", threadId: thread, cwd: canonical(h.cwd), model: "gpt-6.1-sol", effort: "high", tier: "consult", round: 1, rounds: 9 });
    const ambiguous = await h.call(["reply", "--thread", thread, "--", "next"]);
    assert.equal(ambiguous.code, 2);
    assert.match(ambiguous.err, new RegExp(`thread ${thread} exists for codex and null; pass --to`));
    const chosen = await h.call(["reply", "--thread", thread, "--to", "null", "--", "next"]);
    assert.equal(chosen.code, 0, chosen.err);
    assert.match(chosen.out, / · round 2\/9 · /);
    const codex = await h.call(["reply", "--thread", thread, "--to", "codex", "--", "next"]);
    assert.equal(codex.code, 2);
    assert.match(codex.err, /provider codex not available in this build/, "the codex binding is found, its module is not in this build");
    const wrong = await h.call(["reply", "--thread", thread, "--to", "grok", "--", "next"]);
    assert.equal(wrong.code, 2);
    assert.match(wrong.err, new RegExp(`no grok thread ${thread}`));
  } finally { h.done(); }
});

test("wait --to <provider> <native thread id> finds the thread's latest job", async () => {
  const h = harness();
  try {
    const ask = await h.call(["ask", "--to", "null", "--", "start"]);
    const thread = /thread=([0-9a-f-]{36})/.exec(ask.err)[1];
    const byThread = await h.call(["wait", thread, "--to", "null"]);
    assert.equal(byThread.code, 0);
    assert.match(byThread.out, /^pong for job /);
    const noProvider = await h.call(["wait", thread]);
    assert.equal(noProvider.code, 2, "a bare thread id needs its provider");
  } finally { h.done(); }
});

test("an unexpanded ${CLAUDE_SESSION_ID} is no session, so --last still finds the job", async () => {
  const h = harness();
  try {
    const ask = await h.call(["ask", "--to", "null", "--session", "${CLAUDE_SESSION_ID}", "--", "start"]);
    assert.equal(ask.code, 0, ask.err);
    const job = /job=([a-z0-9]{16})/.exec(ask.err)[1];
    assert.equal(loadJob(h.home(), job).session, null);
    const reply = await h.call(["reply", "--last", "--", "next"]);
    assert.equal(reply.code, 0, reply.err);
    const scoped = await h.call(["reply", "--session", "real-session", "--last", "--", "next"]);
    assert.equal(scoped.code, 2, "a real session never falls back to unscoped jobs");
  } finally { h.done(); }
});

test("a stop whose shutdown budget runs out ends with cleanup pending, never a clean result", async () => {
  const h = harness();
  try {
    const home = homeDir({ COUNCIL_HOME: join(h.root, "home2") });
    const cwd = canonical(h.cwd);
    const env = { ...h.env, COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "20000" };
    const req = { verb: "ask", provider: "null", cwd, session: "s", tier: "consult", model: "null-model", effort: "high", modelVerified: true, thread: null, readOnly: true, text: "hi", contract: "<c/>", rounds: 9, round: 1 };
    let childPid = null;
    // A controller that identifies the child but whose stops never land: the budget is the only way out.
    const control = {
      self: () => null,
      snapshot: () => ({ state: "ok", rows: [] }),
      inspect: (job) => (childPid = job.pid, { state: "owned", rows: [{ pid: job.pid, ppid: process.pid, stamp: "1", raw: `node --job ${job.id}`, argv: ["node", "--job", job.id], name: "node" }] }),
      stop: () => "unknown",
      stopGroup: async () => ({ attempted: true, delivered: false, escalated: false }),
    };
    const started = Date.now();
    const { job } = await runManagedTurn({ home, env, cwd, session: "s" }, nullAdapter, req, () => req, { deadlineMs: 200, inactivityMs: 20000 }, { drainMs: 100, shutdownMs: 700, retryMs: 200, graceMs: 100, control });
    try {
      assert.ok(Date.now() - started < 8000);
      assert.equal(job.code, 1);
      assert.equal(job.cleanupPending, true);
      assert.match(job.error, /^cleanup pending: null or a descendant may still be running; wall-clock deadline passed$/);
      assert.equal(job.claimHeld, true, "the thread stays claimed until cancel confirms");
    } finally { if (childPid) try { process.kill(childPid, "SIGKILL"); } catch { /* already gone */ } }
    writeFileSync(join(h.root, "ok"), "");
  } finally { h.done(); }
});

test("cancel of a job whose provider module is not in this build refuses to guess ownership", async () => {
  const h = harness();
  try {
    const { createJob } = await import("../plugins/council/scripts/lib/core/jobs.mjs");
    const job = createJob(h.home(), { provider: "codex", verb: "ask", status: "running", cwd: canonical(h.cwd), session: null, threadId: "t-c", threadIds: ["t-c"], admitted: true, companionPid: 999999, companionIdentity: { pid: 999999, stamp: "x" }, execution: [], spawnedAt: new Date().toISOString() });
    const r = await h.call(["cancel", job.id]);
    assert.equal(r.code, 1);
    assert.match(r.err, new RegExp(`job ${job.id} ran on codex, whose module is not in this build; its processes cannot be identified`));
    const json = await h.call(["cancel", job.id, "--json"]);
    assert.deepEqual(JSON.parse(json.out), { status: "failed", exit: 1, error: `job ${job.id} ran on codex, whose module is not in this build; its processes cannot be identified` });
    const listed = await h.call(["wait"]);
    assert.match(listed.out, new RegExp(`^${job.id} · codex · running · t-c · `), "wait loads no adapter, so it lists jobs of any provider");
    const models = await h.call(["models", "--to", "codex", "--json"]);
    assert.deepEqual(JSON.parse(models.out), [{ provider: "codex", available: false, error: "provider codex not available in this build" }]);
  } finally { h.done(); }
});
