// 1.0.0-rc.5 (docs/decisions.md): a leading short flag starts no turn; a job that cannot be read is
// never skipped over; a published result stands when its claim release fails; a turn can name where it
// runs; a changed binary is never approved. Null adapter, fake child.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import nullAdapter from "./fixtures/null-adapter.mjs";
import { GUARD_VARS } from "./fixtures/fake-common.mjs";
import { git } from "./fixtures/build-repos.mjs";
import { inspectClaim } from "../plugins/council/scripts/lib/core/claims.mjs";
import { canonical, readRecord } from "../plugins/council/scripts/lib/core/fs.mjs";
import { blockingJob, candidates, homeDir, listJobs, loadJob, prune } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { spawnChild } from "../plugins/council/scripts/lib/core/launcher.mjs";
import { cancelManaged, runManagedTurn } from "../plugins/council/scripts/lib/core/lifecycle.mjs";
import { main } from "../plugins/council/scripts/council.mjs";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "council-rc5-"));
  const home = homeDir({ COUNCIL_HOME: join(root, "home") });
  const cwd = join(root, "work");
  mkdirSync(cwd);
  const env = { ...process.env, COUNCIL_HOME: home, COUNCIL_TEST_NULL_ADAPTER: "1", COUNCIL_STDIN_DEADLINE_MS: "300" };
  for (const g of GUARD_VARS) delete env[g];
  for (const k of ["COUNCIL_FAKE_SCENARIO", "COUNCIL_FAKE_ANSWER", "COUNCIL_FAKE_REVIEW", "COUNCIL_NULL_ID", "COUNCIL_NULL_INPUT", "COUNCIL_NULL_OUTPUT", "COUNCIL_NULL_TRUST", "CLAUDE_CODE_SESSION_ID"]) delete env[k];
  const call = async (argv, stdin = "") => {
    let out = "", err = "";
    const stream = new PassThrough(); stream.end(stdin);
    const code = await main(argv, env, { stdout: { write: (s) => { out += s; return true; } }, stderr: { write: (s) => { err += s; return true; } }, stdin: stream, cwd });
    return { code, out, err };
  };
  return { root, home, cwd, env, call, ctx: { home, env, cwd: canonical(cwd), session: "s" }, done: () => rmSync(root, { recursive: true, force: true }) };
}
const SESSION = ["--session", "s"];
const lastLine = (text) => text.trim().split("\n").at(-1);
const jobIds = (home) => { try { return readdirSync(join(home, "jobs")).filter((n) => /^[a-z0-9]{16}$/.test(n)); } catch { return []; } };
const lockedError = (file, code = "EBUSY") => Object.assign(new Error(`${code}: resource busy or locked, open '${file}'`), { code });
/** Fails reads of one file as a Windows lock does, `times` times or until restored. */
function lockFile(t, file, times = Infinity, code = "EBUSY") {
  const real = fs.readFileSync;
  let left = times;
  return t.mock.method(fs, "readFileSync", function (path, ...rest) {
    if (String(path) === file && left-- > 0) throw lockedError(file, code);
    return real.call(this, path, ...rest);
  });
}

test("a leading short flag exits 2 and starts nothing, on argv and in the text; after -- it is text", async () => {
  const s = setup();
  try {
    for (const [argv, stdin, flag] of [[["ask", "--to", "null", "-v"], "", "-v"], [["ask"], "--to null -m other explain this", "-m"], [["reply", "abc", "-v"], "", "-v"], [["task", "--to", "null", "-v"], "", "-v"]]) {
      const r = await s.call([...argv, ...SESSION], stdin);
      assert.equal(r.code, 2, `${argv}: ${r.out}${r.err}`);
      assert.match(r.err, new RegExp(`Unknown option ${flag}\\. Put -- before the text if it starts with a dash\\.`));
    }
    assert.deepEqual(jobIds(s.home), [], "no job was recorded");
    assert.equal((await s.call(["ask", "--to", "null", ...SESSION, "--", "-v"])).code, 0);
    assert.equal(jobIds(s.home).length, 1);
    const bullets = await s.call(["ask", "--to", "null", ...SESSION], "- first item\n- second item");
    assert.equal(bullets.code, 0, bullets.err);
  } finally { s.done(); }
});

test("readRecord: a brief lock is waited out; missing and damaged are null; a lasting lock or another read failure throws", (t) => {
  const s = setup();
  try {
    const file = join(s.root, "record.json");
    assert.equal(readRecord(file), null, "missing");
    writeFileSync(file, "{ torn");
    assert.equal(readRecord(file), null, "damaged: no retry repairs it");
    writeFileSync(file, '{"a":1}');
    const brief = lockFile(t, file, 3);
    assert.deepEqual(readRecord(file), { a: 1 });
    brief.mock.restore();
    const lasting = lockFile(t, file);
    assert.throws(() => readRecord(file), { code: "EBUSY" });
    lasting.mock.restore();
    const io = lockFile(t, file, Infinity, "EIO");
    assert.throws(() => readRecord(file), { code: "EIO" });
    io.mock.restore();
  } finally { s.done(); }
});

test("a locked newest job stops --last, bare wait and bare cancel instead of selecting an older job; once readable it is selected", async (t) => {
  const s = setup();
  try {
    assert.equal((await s.call(["ask", "--to", "null", ...SESSION, "--", "one"])).code, 0);
    assert.equal((await s.call(["ask", "--to", "null", ...SESSION, "--", "two"])).code, 0);
    const [newest, older] = listJobs(s.home);
    assert.notEqual(newest.threadId, older.threadId);
    const lock = lockFile(t, join(newest.dir, "meta.json"));
    for (const [argv, stdin] of [[["reply", "--last", ...SESSION, "--", "three"]], [["wait", ...SESSION]], [["cancel", ...SESSION]]]) {
      const r = await s.call(argv, stdin);
      assert.equal(r.code, 1, `${argv[0]}: ${r.out}${r.err}`);
      assert.match(r.err, new RegExp(`retry: job ${newest.id} cannot be read right now \\(EBUSY\\), so nothing was selected or started`));
    }
    assert.throws(() => candidates(s.home, s.ctx), /retry: job/);
    assert.throws(() => blockingJob(s.home, "null", older.threadId), /retry: job/, "a lost job it cannot read may be on this thread");
    lock.mock.restore();
    assert.equal(listJobs(s.home).length, 2, "the refused reply recorded no job");
    const reply = await s.call(["reply", "--last", ...SESSION, "--", "three"]);
    assert.equal(reply.code, 0, reply.out + reply.err);
    assert.equal(listJobs(s.home)[0].threadId, newest.threadId);
  } finally { s.done(); }
});

test("a job directory that cannot be listed is not a missing job", (t) => {
  const s = setup();
  try {
    const dir = join(s.home, "jobs", "abc");
    mkdirSync(dir, { recursive: true });
    const real = fs.readdirSync;
    const locked = t.mock.method(fs, "readdirSync", function (path, ...rest) {
      if (String(path) === dir) throw lockedError(dir, "EPERM");
      return real.call(this, path, ...rest);
    });
    assert.throws(() => loadJob(s.home, "abc"), /retry: job abc cannot be read right now \(EPERM\)/);
    locked.mock.restore();
    assert.equal(loadJob(s.home, "abc"), null, "a directory with no record yet is no job");
    assert.equal(loadJob(s.home, "absent"), null);
  } finally { s.done(); }
});

test("a locked job fails neither pruning nor a fresh ask, but a reply on a thread it may block is refused before any spawn", async (t) => {
  const s = setup();
  try {
    assert.equal((await s.call(["ask", "--to", "null", ...SESSION, "--", "one"])).code, 0);
    const [locked] = listJobs(s.home);
    const lock = lockFile(t, join(locked.dir, "meta.json"));
    prune(s.home);
    // Both ways a fresh thread id reaches the check: chosen before the spawn, and discovered while the provider answers.
    for (const id of ["preassigned", "discovered"]) {
      s.env.COUNCIL_NULL_ID = id;
      const fresh = await s.call(["ask", "--to", "null", ...SESSION, "--", `fresh ${id}`]);
      assert.equal(fresh.code, 0, `${id}: ${fresh.out}${fresh.err}`);
    }
    delete s.env.COUNCIL_NULL_ID;
    // Named by its own id, the job is unreadable at once; named by its thread, the turn reaches the blocking check under its claim.
    const byJob = await s.call(["reply", locked.id, ...SESSION, "--", "three"]);
    assert.equal(byJob.code, 1, byJob.out + byJob.err);
    assert.match(byJob.err, /retry: job/);
    const byThread = await s.call(["reply", "--thread", locked.threadId, ...SESSION, "--", "three"]);
    assert.equal(byThread.code, 1, byThread.out + byThread.err);
    assert.match(lastLine(byThread.out), new RegExp(`error: retry: job ${locked.id} cannot be read right now`));
    lock.mock.restore();
    const refused = listJobs(s.home)[0];
    assert.deepEqual([refused.verb, refused.code, refused.spawnAttempted ?? false], ["reply", 1, false], "refused before any spawn");
    assert.equal(inspectClaim(s.home, "null", locked.threadId).state, "absent", "the claim went with the refused turn");
    assert.equal(loadJob(s.home, locked.id).id, locked.id, "pruning left it in place");
  } finally { s.done(); }
});

test("a claim release that fails after the result is published leaves the result as saved: the same output as a replay, and cancel releases the claim", async (t) => {
  const s = setup();
  try {
    const claims = join(s.home, "claims");
    const real = fs.unlinkSync;
    const denied = t.mock.method(fs, "unlinkSync", function (file, ...rest) {
      if (String(file).startsWith(claims)) throw lockedError(file, "EPERM");
      return real.call(this, file, ...rest);
    });
    const first = await s.call(["ask", "--to", "null", ...SESSION, "--", "hello"]);
    denied.mock.restore();
    assert.equal(first.code, 0, first.out + first.err);
    assert.match(lastLine(first.out), /^council null ok · .* · cleanup pending; next: cancel [a-z0-9]{16}; do not resume$/);
    assert.doesNotMatch(first.out, /finalization failed/);
    const id = /job ([a-z0-9]{16})/.exec(lastLine(first.out))[1];
    const job = loadJob(s.home, id);
    assert.deepEqual([job.code, job.outcome, job.done, job.error], [0, "ok", true, null]);
    const replay = await s.call(["wait", id]);
    assert.equal(replay.code, 0);
    assert.equal(lastLine(replay.out), lastLine(first.out));
    assert.equal(inspectClaim(s.home, "null", job.threadId).state, "owned");
    const gone = { snapshot: () => ({ state: "ok", rows: [] }), inspect: () => ({ state: "gone", rows: [] }), stop: () => "gone" };
    const cancelled = await cancelManaged(s.ctx, job, { control: gone });
    assert.deepEqual([cancelled.status, cancelled.code], ["finished", 0]);
    assert.equal(inspectClaim(s.home, "null", job.threadId).state, "absent");
    const after = await s.call(["reply", id, ...SESSION, "--", "more"]);
    assert.equal(after.code, 0, after.out + after.err);
  } finally { s.done(); }
});

test("a turn can name where it runs: the child starts there, and the job keeps the caller's directory", async () => {
  const s = setup();
  try {
    const elsewhere = join(s.root, "repo-root");
    mkdirSync(elsewhere);
    const adapter = Object.assign(Object.create(Object.getPrototypeOf(nullAdapter)), nullAdapter, { buildTurn(request) { return { ...nullAdapter.buildTurn(request), cwd: elsewhere }; } });
    const request = { verb: "ask", provider: "null", cwd: s.ctx.cwd, session: "s", tier: "consult", model: "null-model", effort: "high", requestedEffort: "high", modelVerified: true, thread: null, readOnly: true, text: "hello", contract: "<c/>", rounds: 9, round: 1 };
    let spawnedAt = null;
    const { job } = await runManagedTurn(s.ctx, adapter, request, () => request, { deadlineMs: 15000, inactivityMs: 15000 }, { spawn: (launcher, args, options) => { spawnedAt = options.cwd; return spawnChild(launcher, args, options); } });
    assert.equal(job.code, 0, job.error);
    assert.equal(spawnedAt, elsewhere);
    assert.equal(job.cwd, s.ctx.cwd);
  } finally { s.done(); }
});

test("a changed tracked binary is never approved: exit 10, listed as not reviewed", async () => {
  const s = setup();
  try {
    git(s.cwd, ["init", "-q"]);
    writeFileSync(join(s.cwd, "image.bin"), Buffer.from([0, 1, 2]));
    git(s.cwd, ["add", "-A"]);
    git(s.cwd, ["commit", "-q", "-m", "base"]);
    writeFileSync(join(s.cwd, "image.bin"), Buffer.from([0, 9, 9, 9]));
    const r = await s.call(["review", "--to", "null", "--uncommitted", ...SESSION]);
    assert.equal(r.code, 10, r.out + r.err);
    assert.match(r.out, /Not reviewed \(outside this review; never approved\):\n- image\.bin \(binary\)\n/);
    assert.match(lastLine(r.out), /^council null needs attention · .* · unreviewed 1/);
  } finally { s.done(); }
});
