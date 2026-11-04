// 1.0.0-rc.11: on Windows a provider can end with its lost companion and leave a command whose parents are gone. A
// heartbeat's recorded identity lets cancel stop it; one no heartbeat saw stays unseen, and cancel says so. A recorded
// helper still exiting after a clean exit gets a bounded wait before it counts as a survivor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nullAdapter from "./fixtures/null-adapter.mjs";
import { GUARD_VARS } from "./fixtures/fake-common.mjs";
import { claimThread } from "../plugins/council/scripts/lib/core/claims.mjs";
import { executionController } from "../plugins/council/scripts/lib/core/execution.mjs";
import { canonical } from "../plugins/council/scripts/lib/core/fs.mjs";
import { createJob, homeDir, loadJob } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { cancelJob, cancelManaged, runManagedTurn } from "../plugins/council/scripts/lib/core/lifecycle.mjs";
import { MESSAGES } from "../plugins/council/scripts/lib/core/output.mjs";

const ENTRY = new URL("../plugins/council/scripts/council.mjs", import.meta.url);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 40000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) { const v = check(); if (v) return v; } throw new Error("timed out waiting for the condition"); };
const helper = { pid: 999991, ppid: 999990, stamp: "1", raw: "helper.exe", name: "helper.exe", argv: ["helper.exe"] };
const owned = (rows) => ({ state: rows.length ? "owned" : "gone", rows });

function setup() {
  const root = mkdtempSync(join(tmpdir(), "council-unrec-"));
  const home = homeDir({ COUNCIL_HOME: join(root, "home") });
  const cwd = canonical((mkdirSync(join(root, "work")), join(root, "work")));
  const env = { ...process.env, COUNCIL_HOME: join(root, "home"), COUNCIL_TEST_NULL_ADAPTER: "1", COUNCIL_TEST_ABSENT_PROVIDERS: "codex,gemini,grok", CLAUDE_CODE_SESSION_ID: "", COUNCIL_STDIN_DEADLINE_MS: "300" };
  for (const g of GUARD_VARS) delete env[g];
  delete env.COUNCIL_FAKE_SCENARIO;
  return { root, home, cwd, env, ctx: { home, env, cwd, session: "s" }, done: () => rmSync(root, { recursive: true, force: true }) };
}
const request = (s) => ({ verb: "ask", provider: "null", cwd: s.cwd, session: "s", tier: "consult", model: "null-model", effort: "high", modelVerified: true, thread: null, readOnly: true, text: "hi", contract: "<c/>", rounds: 9, round: 1 });
const run = (s, hooks) => { const r = request(s); return runManagedTurn(s.ctx, nullAdapter, r, () => r, { deadlineMs: 20000, inactivityMs: 20000 }, { drainMs: 150, shutdownMs: 5000, retryMs: 300, graceMs: 100, pipeWaitMs: 300, beatMs: 60000, ...hooks }); };
const faked = (inspect, stop = () => "gone") => ({ ...executionController({ adapter: nullAdapter, platform: "linux" }), platform: "linux", identify: () => null, snapshot: () => ({ state: "ok", rows: [] }), inspect, stop });

test("a recorded helper that exits by itself after a clean exit neither fails the turn nor gets signalled", async () => {
  const s = setup();
  try {
    let scans = 0;
    const stopped = [];
    const control = faked(() => { scans += 1; return owned(scans <= 2 ? [helper] : []); }, (row) => { stopped.push(row.pid); return "sent"; });
    const { job } = await run(s, { control, unverifiedWaitMs: 3000 });
    assert.equal(scans, 3);
    assert.deepEqual(stopped, []);
    assert.deepEqual([job.code, job.outcome, job.error ?? null], [0, "ok", null]);
  } finally { s.done(); }
});

test("a recorded process that outlasts the wait is stopped and fails the turn", async () => {
  const s = setup();
  try {
    let live = true, scans = 0;
    const stopped = [];
    const control = faked(() => { scans += 1; return owned(live ? [helper] : []); }, (row) => { stopped.push(row.pid); live = false; return "sent"; });
    const { job } = await run(s, { control, unverifiedWaitMs: 250 });
    assert.ok(scans > 2, "it looked again before calling it a survivor");
    assert.deepEqual(stopped, [helper.pid]);
    assert.deepEqual([job.code, job.outcome, job.error, job.cleanupPending], [1, "failed", "owned execution survived the launcher", false]);
  } finally { s.done(); }
});

const wrapper = { pid: 999981, ppid: 999980, stamp: "10", raw: "wrapper.exe", name: "wrapper.exe", argv: ["wrapper.exe"] };
const command = { pid: 999982, ppid: 999981, stamp: "20", raw: "node.exe -e sleep", name: "node.exe", argv: ["node.exe", "-e", "sleep"] };
/** The first scan finds the wrapper and its command; `next` is every later snapshot, until the command is stopped. */
const wrapperExits = (next, stopped) => {
  let scans = 0, live = true;
  const real = executionController({ adapter: { ...nullAdapter, ownsProcess: (row) => row.pid === wrapper.pid }, platform: "win32", snapshot: () => { scans += 1; return !live ? { state: "ok", rows: [] } : scans === 1 ? { state: "ok", rows: [wrapper, command] } : next; } });
  return { ...real, stop: (row) => { stopped.push(row.pid); live = false; return "sent"; } };
};

test("a command known only through a wrapper that exits during the wait is still stopped and fails the turn", async () => {
  const s = setup();
  try {
    const stopped = [];
    const { job } = await run(s, { control: wrapperExits({ state: "ok", rows: [command] }, stopped), unverifiedWaitMs: 300 });
    assert.deepEqual(stopped, [command.pid]);
    assert.deepEqual([job.code, job.error, job.cleanupPending], [1, "owned execution survived the launcher", false]);
    assert.ok(job.execution.some((r) => r.pid === command.pid));
  } finally { s.done(); }
});

test("a failed query during the wait keeps what the first scan proved and leaves cleanup pending", async () => {
  const s = setup();
  try {
    const stopped = [];
    const { job } = await run(s, { control: wrapperExits({ state: "unknown", rows: [] }, stopped), unverifiedWaitMs: 300 });
    assert.deepEqual(stopped, [], "nothing is signalled on a query that says nothing");
    assert.deepEqual([job.code, job.cleanupPending], [1, true]);
    assert.deepEqual(job.execution.map((r) => r.pid).sort(), [wrapper.pid, command.pid]);
  } finally { s.done(); }
});

const lostJob = (s, over = {}) => {
  const job = createJob(s.home, { provider: "null", verb: "task", status: "running", admitted: true, cwd: s.cwd, session: "s", companionPid: 999999, companionIdentity: { pid: 999999, stamp: "x" }, threadId: "t-lost", threadIds: ["t-lost"], requestedThreadId: "t-lost", spawnAttempted: true, execution: [], pid: 999998, argv: ["node", "x"], spawnedAt: new Date().toISOString(), ...over });
  claimThread(s.home, "null", "t-lost", job);
  return job;
};
const sink = () => { let text = ""; const out = (x) => { text += x; }; out.text = () => text; return out; };

test("an orphan no heartbeat recorded is never signalled, and only the recovering cancel warns about it", async () => {
  const s = setup();
  try {
    const orphan = { pid: 999997, ppid: 999996, stamp: "5", raw: "node.exe -e sleep", argv: ["node.exe", "-e", "sleep"], name: "node.exe" };
    const kills = [];
    const control = executionController({ adapter: nullAdapter, platform: "linux", snapshot: () => ({ state: "ok", rows: [orphan] }), kill: (...a) => kills.push(a) });
    const job = lostJob(s);
    const first = await cancelManaged(s.ctx, loadJob(s.home, job.id), { timeoutMs: 2000, control });
    assert.deepEqual([first.status, first.code, first.warning], ["cancelled", 0, MESSAGES.unrecorded]);
    assert.deepEqual(kills, []);
    assert.doesNotMatch(loadJob(s.home, job.id).error ?? "", /may still be running/, "cleanup is not owed");
    const second = await cancelManaged(s.ctx, loadJob(s.home, job.id), { timeoutMs: 2000, control });
    assert.deepEqual([second.status, second.code, second.warning], ["cancelled", 0, undefined], "a repeat looked at no process table");
  } finally { s.done(); }
});

test("cancel prints the warning in text and JSON, and a lost job that never spawned gets none", async () => {
  const controlFor = async () => executionController({ adapter: nullAdapter, platform: "linux", snapshot: () => ({ state: "ok", rows: [] }) });
  for (const [json, over, expected] of [[false, {}, true], [true, {}, true], [false, { spawnAttempted: false }, false], [true, { spawnAttempted: false }, false]]) {
    const s = setup();
    try {
      const job = lostJob(s, over);
      const out = sink();
      assert.equal(await cancelJob(s.ctx, { json }, [job.id], out, { controlFor }), 0);
      if (json) assert.equal(JSON.parse(out.text()).warning, expected ? MESSAGES.unrecorded : undefined);
      else assert.equal(out.text().includes(MESSAGES.unrecorded), expected);
    } finally { s.done(); }
  }
});

test("end to end: the companion and the provider die, the recorded command runs on, and cancel stops it and warns", async () => {
  const s = setup();
  const pidFile = join(s.root, "grandchild.pid");
  const script = join(s.root, "provider.mjs");
  writeFileSync(script, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const i = process.argv.indexOf("--thread");
process.stdout.write(JSON.stringify({ type: "started", thread: process.argv[i + 1] }) + "\\n");
const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore", detached: true, windowsHide: true });
g.unref();
writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
setInterval(() => {}, 1000);
`);
  const env = { ...s.env, COUNCIL_NULL_BIN: script };
  const companion = spawn(process.execPath, [ENTRY.pathname.replace(/^\/([A-Za-z]:)/, "$1"), "ask", "--to", "null", "--session", "s", "--", "q"], { cwd: s.cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const closed = new Promise((resolve) => companion.on("close", resolve));
  let err = "";
  companion.stderr.on("data", (c) => { err += c; });
  companion.stdout.on("data", () => {});
  let grandchild = null;
  try {
    const id = (await until(() => /job=([a-z0-9]{16})/.exec(err)))[1];
    grandchild = Number(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8")));
    await until(() => (loadJob(s.home, id)?.execution ?? []).some((r) => r.pid === grandchild));
    const provider = loadJob(s.home, id).pid;
    companion.kill("SIGKILL");
    await closed;
    if (alive(provider)) process.kill(provider, "SIGKILL");
    assert.ok(alive(grandchild), "the command outlives both");
    const out = sink();
    const controlFor = async () => executionController({ adapter: nullAdapter });
    assert.equal(await cancelJob({ ...s.ctx, env }, { json: true, timeout: "30" }, [id], out, { controlFor }), 0);
    const data = JSON.parse(out.text());
    assert.deepEqual([data.status, data.cleanupPending, data.warning], ["cancelled", false, MESSAGES.unrecorded]);
    await until(() => !alive(grandchild), 10000);
  } finally {
    if (grandchild && alive(grandchild)) process.kill(grandchild, "SIGKILL");
    if (companion.exitCode === null) companion.kill("SIGKILL");
    s.done();
  }
});
