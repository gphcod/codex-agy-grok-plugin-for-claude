// 1.0.0-rc.9 (docs/decisions.md): `reply --last` never replaces a job still open with an older thread;
// a caller that closed stderr cannot kill a companion before it finalizes; a thread record that cannot
// be read is never replaced by its job's fields; review coverage names files whatever the user's diff
// configuration says; pruning never fails a new turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GIT_ENV, git, isolateGit } from "./fixtures/build-repos.mjs";
import { GUARD_VARS } from "./fixtures/fake-common.mjs";
import { ENTRY, markers } from "./fixtures/three-providers.mjs";
import { resolveTarget } from "../plugins/council/scripts/council.mjs";
import { canonical } from "../plugins/council/scripts/lib/core/fs.mjs";
import { collectReview, reviewTarget } from "../plugins/council/scripts/lib/core/git.mjs";
import { createJob, homeDir, loadJob, loadThread, markDone, markStopped, prune, saveJob, saveThread, threadFile } from "../plugins/council/scripts/lib/core/jobs.mjs";

isolateGit();

const OLD_THREAD = "11111111-1111-4111-8111-111111111111", NEW_THREAD = "22222222-2222-4222-8222-222222222222";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "council-rc9-"));
  const home = homeDir({ COUNCIL_HOME: join(root, "home") });
  const cwd = join(root, "work");
  mkdirSync(cwd);
  return { root, home, cwd: canonical(cwd), ctx: { env: {}, home, cwd: canonical(cwd), session: "s" }, done: () => rmSync(root, { recursive: true, force: true }) };
}
/** A job record as lifecycle leaves it; `at` orders it, newest first. */
const jobFields = (s, at, over = {}) => ({
  provider: "grok", verb: "ask", status: "running", tier: "consult", model: "grok-4.7", effort: "low", cwd: s.cwd, session: "s", threadId: null, threadIds: [], admitted: true,
  companionPid: process.pid, execution: [], spawnedAt: new Date(at).toISOString(), admittedAt: new Date(at).toISOString(), round: 1, rounds: 9, ...over,
});
/** An older finished thread with its record: what `--last` would wrongly take. */
function olderThread(s, record = {}) {
  const job = createJob(s.home, jobFields(s, Date.now() - 60000, { threadId: OLD_THREAD }));
  Object.assign(job, { outcome: "ok", status: "done", code: 0 });
  saveJob(job); markDone(job);
  saveThread(s.home, { provider: "grok", threadId: OLD_THREAD, cwd: s.cwd, model: "grok-4.7", effort: "low", tier: "consult", round: 1, rounds: 9, lastJob: job.id, readOnly: true, ...record });
  return job;
}

test("reply --last refuses while the newest thread-starting job is open, instead of taking an older thread", () => {
  const s = setup();
  try {
    olderThread(s);
    // Grok names its session only on `end`, so a running ask has no thread id yet.
    const running = createJob(s.home, jobFields(s, Date.now(), { requestedThreadId: NEW_THREAD, threadIds: [NEW_THREAD] }));
    assert.throws(() => resolveTarget(s.ctx, "reply", { last: true }), new RegExp(`job ${running.id}: native thread not confirmed yet; wait or cancel ${running.id}`));
    // It stays refused when lost, and when its call has not been admitted yet.
    Object.assign(running, { admitted: false }); saveJob(running);
    assert.throws(() => resolveTarget(s.ctx, "reply", { last: true }), /native thread not confirmed yet/);
    // Once recovered, nothing it started is left to continue: the older thread is the latest again.
    markStopped(running);
    assert.equal(resolveTarget(s.ctx, "reply", { last: true }).thread.threadId, OLD_THREAD);
  } finally { s.done(); }
});

test("reply --last still skips a finished job that never admitted or started a thread, and a review", () => {
  const s = setup();
  try {
    olderThread(s);
    for (const [at, over] of [[-3000, { admitted: false }], [-2000, {}], [-1000, { verb: "review" }]]) {
      const job = createJob(s.home, jobFields(s, Date.now() + at, over));
      Object.assign(job, { outcome: "failed", status: "failed", code: 1 });
      saveJob(job); markDone(job);
    }
    assert.equal(resolveTarget(s.ctx, "reply", { last: true }).thread.threadId, OLD_THREAD);
    // An open review is no thread to continue either.
    createJob(s.home, jobFields(s, Date.now(), { verb: "review" }));
    assert.equal(resolveTarget(s.ctx, "reply", { last: true }).thread.threadId, OLD_THREAD);
  } finally { s.done(); }
});

test("a caller that closed stderr does not kill the companion: the turn finishes and is finalized", async () => {
  const s = setup();
  try {
    const text = "Reply with pong";
    const env = { ...process.env, ...GIT_ENV, ...markers("grok", text), COUNCIL_HOME: s.home, COUNCIL_FAKE_JOB_DIR: join(s.home, "jobs"), COUNCIL_FAKE_SCENARIO: "ok",
      COUNCIL_GROK_BIN: fileURLToPath(new URL("./fixtures/fake-grok.mjs", import.meta.url)), COUNCIL_STDIN_DEADLINE_MS: "300" };
    delete env.CLAUDE_CODE_SESSION_ID;
    for (const guard of GUARD_VARS) delete env[guard];
    const child = spawn(process.execPath, [ENTRY, "ask", "--to", "grok", "--effort", "low", "--", text], { cwd: s.cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stderr.destroy(); // Before the companion's first write: its start line.
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0, out);
    const jobs = readdirSync(join(s.home, "jobs"));
    assert.equal(jobs.length, 1);
    assert.ok(existsSync(join(s.home, "jobs", jobs[0], "done")), "the job was finalized");
    assert.match(out, /council grok ok/);
  } finally { s.done(); }
});

test("a thread record that stays locked stops the call: its refusal is never replaced by the job's fields", (t) => {
  const s = setup();
  try {
    const job = olderThread(s, { resumable: false, unconfirmed: "session not confirmed: start a new ask" });
    assert.throws(() => resolveTarget(s.ctx, "reply", { thread: job.id }), /session not confirmed/, "the guard, while the record reads");
    const file = threadFile(s.home, "grok", OLD_THREAD), real = fs.readFileSync;
    t.mock.method(fs, "readFileSync", function (target, ...rest) {
      if (String(target) === file) throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${file}'`), { code: "EBUSY" });
      return real.call(this, target, ...rest);
    });
    assert.throws(() => resolveTarget(s.ctx, "reply", { thread: job.id }), new RegExp(`^Error: retry: thread ${OLD_THREAD} cannot be read right now \\(EBUSY\\), so nothing was selected or started$`));
    assert.throws(() => loadThread(s.home, "grok", OLD_THREAD), /retry: thread/);
  } finally { s.done(); }
});

test("a thread id that cannot be a native id reads nothing outside threads/", () => {
  const s = setup();
  try {
    mkdirSync(join(s.home, "threads"));
    writeFileSync(join(s.home, "outside.json"), '{"provider":"grok"}\n');
    assert.equal(loadThread(s.home, "x/../..", "outside"), null, "the provider is not the id");
    for (const ref of ["../outside", "a/../../outside", "..\\outside", "", null, undefined]) assert.equal(loadThread(s.home, "grok", ref), null, String(ref));
    assert.throws(() => resolveTarget(s.ctx, "reply", { thread: "../outside" }), /no job or thread \.\.\/outside/);
  } finally { s.done(); }
});

/** A repository with one changed tracked file and a large one, under the given local diff configuration. */
function configuredRepo(s, config) {
  const dir = join(s.root, "repo");
  mkdirSync(dir);
  git(dir, ["init", "-q"]);
  for (const name of ["small.txt", "large.txt"]) writeFileSync(join(dir, name), "one\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  for (const [key, value] of config) git(dir, ["config", key, value]);
  writeFileSync(join(dir, "small.txt"), "one\ntwo\n");
  writeFileSync(join(dir, "large.txt"), `one\n${"x".repeat(2000)}\n`);
  return dir;
}

for (const config of [[["diff.noprefix", "true"]], [["diff.mnemonicPrefix", "true"]]]) {
  test(`review coverage names every file under ${config[0][0]}: uncommitted, commit, base, merge`, () => {
    const s = setup();
    try {
      const dir = configuredRepo(s, config);
      const named = (target, options) => collectReview(reviewTarget(dir, target), options);
      const uncommitted = named({ uncommitted: true });
      assert.deepEqual([...uncommitted.reviewed].sort(), ["large.txt", "small.txt"]);
      // The one a reviewer is told to read by path keeps its name.
      assert.deepEqual(named({ uncommitted: true }, { cap: 500 }).omitted, ["large.txt (over the inline cap)"]);
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "change"]);
      assert.deepEqual([...named({ commit: "HEAD" }).reviewed].sort(), ["large.txt", "small.txt"]);
      assert.deepEqual([...named({ base: "HEAD~1" }).reviewed].sort(), ["large.txt", "small.txt"]);
    } finally { s.done(); }
  });
}

test("review coverage lists a changed submodule under diff.submodule=log", () => {
  const s = setup();
  try {
    const inner = join(s.root, "inner");
    mkdirSync(inner);
    git(inner, ["init", "-q"]);
    writeFileSync(join(inner, "f.txt"), "one\n");
    git(inner, ["add", "-A"]);
    git(inner, ["commit", "-qm", "inner"]);
    const dir = join(s.root, "outer");
    mkdirSync(dir);
    git(dir, ["init", "-q"]);
    writeFileSync(join(dir, "other.txt"), "one\n");
    git(dir, ["add", "-A"]);
    git(dir, ["-c", "protocol.file.allow=always", "submodule", "--quiet", "add", inner, "sub"]);
    git(dir, ["commit", "-qm", "base"]);
    writeFileSync(join(dir, "sub", "f.txt"), "two\n");
    git(join(dir, "sub"), ["commit", "-qam", "moved"]);
    writeFileSync(join(dir, "other.txt"), "two\n");
    git(dir, ["config", "diff.submodule", "log"]);
    const c = collectReview(reviewTarget(dir, { uncommitted: true }));
    assert.deepEqual([...c.reviewed].sort(), ["other.txt", "sub"]);
    assert.match(c.diff, /^diff --git a\/sub b\/sub$/m);
    assert.deepEqual(c.omitted, []);
  } finally { s.done(); }
});

test("a finished job whose claims cannot be read is kept, and pruning does not fail the turn", () => {
  const s = setup();
  try {
    const job = createJob(s.home, jobFields(s, Date.now() - 1000, { threadId: OLD_THREAD }));
    Object.assign(job, { outcome: "ok", status: "done", code: 0 });
    saveJob(job); markDone(job);
    mkdirSync(join(s.home, "claims"), { recursive: true });
    writeFileSync(join(s.home, "claims", "grok"), ""); // Listing it as a directory fails with something other than ENOENT.
    assert.doesNotThrow(() => prune(s.home, 0));
    assert.ok(loadJob(s.home, job.id), "a claim it may hold keeps the job");
  } finally { s.done(); }
});
