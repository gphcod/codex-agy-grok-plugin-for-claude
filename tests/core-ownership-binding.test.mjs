// S2.9: process-group ownership after the leader is gone (persisted descendant identities only) and
// the provider-neutral request binding (one exclusive reservation per session + cwd + request id).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import nullAdapter from "./fixtures/null-adapter.mjs";
import { GUARD_VARS } from "./fixtures/fake-common.mjs";
import { main } from "../plugins/council/scripts/council.mjs";
import { claimThread, inspectClaim } from "../plugins/council/scripts/lib/core/claims.mjs";
import { executionController, ownedExecution } from "../plugins/council/scripts/lib/core/execution.mjs";
import { claimScope, createJob, homeDir, loadJob, loadScope, scopeFile } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { cancelManaged, runManagedTurn } from "../plugins/council/scripts/lib/core/lifecycle.mjs";
import { canonical } from "../plugins/council/scripts/lib/core/fs.mjs";

const posix = process.platform !== "win32";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function setup() {
  const root = mkdtempSync(join(tmpdir(), "council-s29-"));
  const home = homeDir({ COUNCIL_HOME: join(root, "home") });
  const cwd = join(root, "work");
  mkdirSync(cwd);
  const log = join(root, "spawns.log");
  writeFileSync(log, "");
  const env = { ...process.env, COUNCIL_FAKE_SPAWN_LOG: log, COUNCIL_TEST_NULL_ADAPTER: "1", COUNCIL_HOME: join(root, "home"), COUNCIL_STDIN_DEADLINE_MS: "300" };
  for (const g of GUARD_VARS) delete env[g];
  delete env.COUNCIL_FAKE_SCENARIO;
  const spawns = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const call = async (argv, { hooks = {}, extra = {} } = {}) => {
    let out = "", err = "";
    const stdin = new PassThrough(); stdin.end("");
    const code = await main(argv, { ...env, ...extra }, { stdout: { write: (x) => { out += x; } }, stderr: { write: (x) => { err += x; } }, stdin, cwd }, hooks);
    return { code, out, err };
  };
  return { root, home, cwd, env, spawns, call, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("Codex's counterexample: a replacement leader that exits after spawning 701 leaves 701 unadopted and unverified", async () => {
  const s = setup();
  try {
    // recorded leader 700 started at t=100; a later process reused pid 700 as a group leader, spawned 701 and exited
    const job = createJob(s.home, { provider: "null", verb: "ask", status: "running", cwd: s.cwd, session: null, threadId: "t-x", threadIds: ["t-x"], admitted: true, companionPid: 999999, companionIdentity: { pid: 999999, stamp: "x" }, execution: [], pid: 700, leader: { pid: 700, stamp: "100" }, spawnedAt: new Date().toISOString() });
    claimThread(s.home, "null", "t-x", job);
    const stranger = { pid: 701, ppid: 1, group: 700, stamp: "150", raw: "/bin/sleep 600", argv: ["/bin/sleep", "600"], name: "sleep" };
    const found = ownedExecution(job, { state: "ok", rows: [stranger] }, "linux", [], nullAdapter);
    assert.equal(found.state, "unknown");
    assert.deepEqual(found.rows, [], "not adopted");
    assert.deepEqual(found.unverified.map((r) => r.pid), [701]);
    const kills = [];
    const control = executionController({ platform: "linux", adapter: nullAdapter, snapshot: () => ({ state: "ok", rows: [stranger] }), kill: (...a) => kills.push(a) });
    const r = await cancelManaged({ home: s.home }, job, { timeoutMs: 1500, control });
    assert.equal(r.status, "unknown");
    assert.match(r.error, /^unverified: 1 process\(es\) in the job's process group \(701\) match no identity recorded while it ran; not signalled/);
    assert.deepEqual(kills, [], "never signalled");
    assert.equal(inspectClaim(s.home, "null", "t-x").state, "owned", "the claim is retained");
  } finally { s.done(); }
});

const GRANDPARENT = (holdMs) => `import { spawn } from "node:child_process";
const i = process.argv.indexOf("--thread");
// a grandchild in this process's group, with no job evidence on its command line
const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" });
process.stdout.write(JSON.stringify({ type: "started", thread: process.argv[i + 1] }) + "\\n");
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: "text", data: "grandchild " + g.pid }) + "\\n" + JSON.stringify({ type: "done" }) + "\\n", () => process.exit(0));
}, ${holdMs});`;

async function turnWithGrandchild(s, beatMs) {
  writeFileSync(join(s.root, "gp.mjs"), GRANDPARENT(700));
  const env = { ...s.env, COUNCIL_NULL_BIN: join(s.root, "gp.mjs") };
  const req = { verb: "ask", provider: "null", cwd: s.cwd, session: "s", tier: "consult", model: "null-model", effort: "high", modelVerified: true, thread: null, readOnly: true, text: "hi", contract: "<c/>", rounds: 9, round: 1 };
  const result = await runManagedTurn({ home: s.home, env, cwd: s.cwd, session: "s" }, nullAdapter, req, () => req, { deadlineMs: 20000, inactivityMs: 20000 }, { drainMs: 150, shutdownMs: 4000, retryMs: 300, graceMs: 100, pipeWaitMs: 300, beatMs });
  const grandchild = Number(/grandchild (\d+)/.exec(result.answer)[1]);
  return { ...result, grandchild };
}

test("a real descendant recorded at a heartbeat and reparented after the leader exits is adopted and stopped", { skip: !posix }, async () => {
  const s = setup();
  try {
    const { job, grandchild } = await turnWithGrandchild(s, 100);
    try {
      assert.ok(loadJob(s.home, job.id).execution.some((r) => r.pid === grandchild), "recorded at a heartbeat while the leader ran");
      assert.equal(job.code, 1);
      assert.equal(job.error, "owned execution survived the launcher");
      assert.equal(job.cleanupPending, false);
      for (const end = Date.now() + 3000; alive(grandchild) && Date.now() < end;) await sleep(20);
      assert.equal(alive(grandchild), false, "stopped by its verified identity");
    } finally { if (alive(grandchild)) process.kill(grandchild, "SIGKILL"); }
  } finally { s.done(); }
});

test("a descendant spawned after the last snapshot is never adopted and is reported unverified", { skip: !posix }, async () => {
  const s = setup();
  try {
    const { job, grandchild } = await turnWithGrandchild(s, 60000);
    try {
      assert.ok(!(loadJob(s.home, job.id).execution ?? []).some((r) => r.pid === grandchild), "no heartbeat recorded it");
      assert.equal(job.code, 1);
      assert.equal(job.cleanupPending, true, "cleanup cannot be confirmed");
      assert.match(job.error, new RegExp(`unverified: 1 process\\(es\\) in the job's process group \\(${grandchild}\\)`));
      assert.equal(alive(grandchild), true, "never signalled");
    } finally { if (alive(grandchild)) process.kill(grandchild, "SIGKILL"); }
  } finally { s.done(); }
});

test("request binding: two identical calls whose --last would resolve to different providers start one job", async () => {
  const s = setup();
  try {
    const a = await s.call(["ask", "--to", "null", "--", "thread A"]);
    assert.equal(a.code, 0, a.err);
    let open;
    const gate = new Promise((r) => { open = r; });
    const argv = ["reply", "--last", "--request-id", "dup", "--", "follow"];
    // the first caller reserves the id, then is held before it resolves --last (Codex's delayed import)
    const first = s.call(argv, { hooks: { beforeResolve: () => gate } });
    for (const end = Date.now() + 3000; !existsSync(scopeFile(canonical(s.home), null, canonical(s.cwd), "dup")); await sleep(10)) assert.ok(Date.now() < end);
    const b = await s.call(["ask", "--to", "null2", "--", "thread B"]);
    assert.equal(b.code, 0, b.err);
    const second = s.call(argv); // would resolve --last to null2 without the binding
    await sleep(200);
    open();
    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1.code, 0, r1.err);
    assert.equal(r2.code, 0, r2.err);
    assert.equal(s.spawns().filter((x) => x.prompt.endsWith("\n\nfollow")).length, 1, "one spawn for the request id");
    const job = /job ([a-z0-9]{16})/.exec(r1.out)[1];
    assert.equal(/job ([a-z0-9]{16})/.exec(r2.out)[1], job, "the second caller replays the first's job");
  } finally { s.done(); }
});

test("request binding: a different fingerprint exits 2, a released binding is claimed again, a gone caller is reported", async () => {
  const s = setup();
  try {
    const home = canonical(s.home), cwd = canonical(s.cwd);
    const held = claimScope(home, { session: null, cwd, requestId: "held" }, { fingerprint: "other", companionPid: process.pid, companionIdentity: executionController().self() });
    assert.equal(held.fresh, true);
    const r = await s.call(["ask", "--to", "null", "--request-id", "held", "--", "x"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /request id held was already used with different input/);
    const gone = claimScope(home, { session: null, cwd, requestId: "gone" }, { fingerprint: "will-match-nothing", companionPid: 999999, companionIdentity: { pid: 999999, stamp: "x" } });
    writeFileSync(gone.file, JSON.stringify({ ...loadScope(gone.file), fingerprint: undefined }));
    const g = await s.call(["ask", "--to", "null", "--request-id", "gone", "--", "x"]);
    assert.equal(g.code, 2);
    assert.match(g.err, /request id gone: its first call ended before it chose a provider; nothing ran, so a new request id is safe/);
    // a call that fails before its tombstone releases the binding, so the same id runs again
    const bad = await s.call(["ask", "--to", "null", "--request-id", "again", "--model", "fast", "--effort", "bogus", "--", "x"]);
    assert.equal(bad.code, 2);
    assert.equal(existsSync(scopeFile(home, null, cwd, "again")), false, "released");
    const unknownProvider = await s.call(["ask", "--to", "codex", "--request-id", "again2", "--", "x"]);
    assert.equal(unknownProvider.code, 2);
    assert.equal(existsSync(scopeFile(home, null, cwd, "again2")), false, "released when the provider module is missing too");
    const ok = await s.call(["ask", "--to", "null", "--request-id", "again2", "--", "x"]);
    assert.equal(ok.code, 0, ok.err);
    const record = loadScope(scopeFile(home, null, cwd, "again2"));
    assert.equal(record.provider, "null");
    assert.match(record.job, /^[0-9a-f]{16}$/);
  } finally { s.done(); }
});
