// S2.7 (ratio): behaviours behind the core branches no other test reached (found with an lcov
// branch report): A7.8 blocking by a cleanup-pending job, cancellation racing the spawn, launch
// storage failure, a completed turn with a non-zero exit, cancel and replay races, /proc and
// PowerShell failure modes, file-system helpers, and catalog corner cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nullAdapter from "./fixtures/null-adapter.mjs";
import { GUARD_VARS } from "./fixtures/fake-common.mjs";
import { canonical, readJson, writeFileAtomic } from "../plugins/council/scripts/lib/core/fs.mjs";
import { claimHeld, claimThread, claimedProviders } from "../plugins/council/scripts/lib/core/claims.mjs";
import { loadCatalog, resolveEffort } from "../plugins/council/scripts/lib/core/catalog.mjs";
import { companionState, currentIdentity, executionController, ownedExecution, processSnapshot, recoveryEvidence } from "../plugins/council/scripts/lib/core/execution.mjs";
import {
  claimRequest, createJob, homeDir, loadJob, loadThread, markDone, markRequestPrepared, neverPrepared, saveJob,
} from "../plugins/council/scripts/lib/core/jobs.mjs";
import { cancelJob, cancelManaged, replayRequest, runManagedTurn, waitFor } from "../plugins/council/scripts/lib/core/lifecycle.mjs";
import { bound } from "../plugins/council/scripts/lib/core/git.mjs";
import { resultJson } from "../plugins/council/scripts/lib/core/output.mjs";
import { spawnChild } from "../plugins/council/scripts/lib/core/launcher.mjs";

const FAST = { drainMs: 150, shutdownMs: 3000, retryMs: 300, graceMs: 100, pipeWaitMs: 400 };
function setup(childScript = null) {
  const root = mkdtempSync(join(tmpdir(), "council-br-"));
  const home = homeDir({ COUNCIL_HOME: join(root, "home") });
  const cwd = join(root, "work");
  mkdirSync(cwd);
  const env = { ...process.env };
  for (const g of GUARD_VARS) delete env[g];
  delete env.COUNCIL_FAKE_SCENARIO;
  if (childScript) { writeFileSync(join(root, "child.mjs"), childScript); env.COUNCIL_NULL_BIN = join(root, "child.mjs"); }
  return { root, home, cwd, ctx: { home, env, cwd, session: "s" }, done: () => rmSync(root, { recursive: true, force: true }) };
}
const request = (s, over = {}) => ({ verb: "ask", provider: "null", cwd: s.cwd, session: "s", tier: "consult", model: "null-model", effort: "high", modelVerified: true, thread: null, readOnly: true, text: "hello", contract: "<c/>", ...over });
const run = (s, { over = {}, hooks = {}, options = {} } = {}) => { const r = request(s, over); return runManagedTurn(s.ctx, nullAdapter, r, () => r, { deadlineMs: 15000, inactivityMs: 15000, ...options }, { ...FAST, ...hooks }); };

test("A7.8: a cleanup-pending job blocks its thread even after its claim was released", async () => {
  const s = setup();
  try {
    const stale = createJob(s.home, { provider: "null", verb: "ask", status: "failed", outcome: "failed", code: 1, cwd: s.cwd, session: "s", threadId: "t-blocked", threadIds: ["t-blocked"], admitted: true, cleanupPending: true, companionPid: 1, execution: [], spawnedAt: new Date(Date.now() - 1000).toISOString() });
    markDone(stale);
    const { job } = await run(s, { over: { verb: "reply", thread: { threadId: "t-blocked" }, round: 2 } });
    assert.equal(job.code, 1);
    assert.equal(job.error, `thread t-blocked requires cleanup of job ${stale.id}; run cancel ${stale.id}`);
    assert.equal(job.claimHeld, false, "the turn released the claim it took before refusing");
  } finally { s.done(); }
});

test("a cancellation that lands while spawning is honoured at once", async () => {
  const s = setup();
  try {
    // the cancel marker appears after the last pre-spawn check and before the record of the pid
    const { job } = await run(s, { hooks: { spawn: (launcher, args, opts) => { writeFileSync(join(s.home, "jobs", args[1], "cancel"), ""); return spawnChild(launcher, args, opts); } } });
    assert.equal(job.outcome, "cancelled");
    assert.equal(job.code, 1);
    assert.equal(job.cleanupPending, false);
  } finally { s.done(); }
});

test("launch storage failure after the spawn stops the child and fails the turn", async () => {
  const s = setup();
  try {
    let saves = 0;
    const { job } = await run(s, { hooks: { saveJob: (j) => { if (j.pid && ++saves === 1) throw new Error("meta.json is read-only"); return saveJob(j); } } });
    assert.equal(job.code, 1);
    assert.match(job.error, /^launch storage failed: meta.json is read-only/);
  } finally { s.done(); }
});

test("a completed turn whose child exits non-zero fails with the exit code", async () => {
  const s = setup(`const i = process.argv.indexOf("--thread");
process.stdout.write(JSON.stringify({ type: "started", thread: process.argv[i + 1] }) + "\\n" + JSON.stringify({ type: "text", data: "ok" }) + "\\n" + JSON.stringify({ type: "done" }) + "\\n", () => process.exit(7));`);
  try {
    const { job, answer } = await run(s);
    assert.equal(job.code, 1);
    assert.equal(job.error, "null exited with code 7");
    assert.equal(answer, "ok", "the partial answer is kept for the record");
  } finally { s.done(); }
});

test("cancelManaged: a record that disappears mid-cancel, and a snapshot that throws", async () => {
  const s = setup();
  try {
    const job = createJob(s.home, { provider: "null", verb: "ask", status: "running", cwd: s.cwd, session: "s", threadIds: [], admitted: true, companionPid: 999999, companionIdentity: { pid: 999999, stamp: "x" }, execution: [], spawnedAt: new Date().toISOString() });
    const vanishing = { snapshot: () => { rmSync(job.dir, { recursive: true, force: true }); return { state: "ok", rows: [{ pid: 999999, stamp: "x" }] }; }, inspect: () => ({ state: "gone", rows: [] }), stop: () => "gone" };
    const r1 = await cancelManaged(s.ctx, job, { timeoutMs: 1000, control: vanishing });
    assert.deepEqual([r1.status, r1.code, r1.error], ["unknown", 1, "job record cannot be read"]);
    const job2 = createJob(s.home, { provider: "null", verb: "ask", status: "running", cwd: s.cwd, session: "s", threadIds: [], admitted: true, companionPid: 999999, companionIdentity: { pid: 999999, stamp: "x" }, execution: [], spawnedAt: new Date().toISOString() });
    const throwing = { snapshot: () => { throw new Error("ps crashed"); }, inspect: () => ({ state: "gone", rows: [] }), stop: () => "gone" };
    const r2 = await cancelManaged(s.ctx, job2, { timeoutMs: 1500, control: throwing });
    assert.equal(r2.status, "unknown");
    assert.equal(r2.error, "process query failed: ps crashed; no claim released");
    assert.ok(existsSync(join(job2.dir, "cancel")), "the request stays recorded for the owner");
  } finally { s.done(); }
});

test("waitFor and cancelJob: a record that becomes unreadable, a thread ref with --to, and the text output", async () => {
  const s = setup();
  try {
    const job = createJob(s.home, { provider: "null", verb: "ask", status: "running", cwd: s.cwd, session: "s", threadId: "tw", threadIds: [], admitted: true, companionPid: process.pid, execution: [], spawnedAt: new Date().toISOString() });
    setTimeout(() => rmSync(job.dir, { recursive: true, force: true }), 100);
    await assert.rejects(waitFor(s.ctx, { timeout: "5" }, [job.id], () => {}, { sleepMs: 20 }), /job record became unreadable/);
    const done = createJob(s.home, { provider: "null", verb: "ask", status: "done", outcome: "ok", code: 0, cwd: s.cwd, session: "s", threadId: "tdone", threadIds: [], admitted: true, cleanupPending: false, companionPid: 1, execution: [], spawnedAt: new Date().toISOString() });
    markDone(done);
    const lines = [];
    const code = await cancelJob(s.ctx, {}, ["tdone"], (x) => lines.push(x), { provider: "null", controlFor: async () => executionController({ adapter: nullAdapter }) });
    assert.equal(code, 0);
    assert.equal(lines[0], `finished · null · job ${done.id} · the thread stays resumable\n`);
  } finally { s.done(); }
});

test("replayRequest: a tombstone whose job record appears a moment later is awaited", async () => {
  const s = setup();
  try {
    const c = claimRequest(s.home, "null", "late", { session: "s", cwd: s.cwd }, { fingerprint: "fp" });
    markRequestPrepared(s.home, c.id, { provider: "null", requestId: "late", fingerprint: "fp", session: "s", cwd: s.cwd, verb: "ask" });
    assert.equal(neverPrepared(s.home, c.id, { claim: c.claim }), false, "a tombstone means preparation finished");
    setTimeout(() => {
      const job = createJob(s.home, { provider: "null", verb: "ask", status: "done", outcome: "ok", code: 0, cwd: s.cwd, session: "s", threadId: "tl", threadIds: [], admitted: true, cleanupPending: false, companionPid: 1, execution: [], spawnedAt: new Date().toISOString() }, c.id);
      writeFileSync(join(job.dir, "answer.md"), "arrived\n");
      markDone(job);
    }, 150);
    const out = [];
    const code = await replayRequest(s.ctx, { "request-id": "late", json: true }, { id: c.id, tombstone: null }, "fp", (x) => out.push(x), { control: { snapshot: () => ({ state: "ok", rows: [] }) }, sleepMs: 20 });
    assert.equal(code, 0);
    assert.equal(JSON.parse(out.at(-1)).answer, "arrived\n");
    assert.equal(neverPrepared(s.home, "nosuchjob1234567", { claim: "x" }), false);
  } finally { s.done(); }
});

test("/proc failure modes: an unreadable entry makes the snapshot unknown; a vanished one is skipped", () => {
  const proc = mkdtempSync(join(tmpdir(), "council-proc2-"));
  try {
    mkdirSync(join(proc, "sys", "kernel", "random"), { recursive: true });
    writeFileSync(join(proc, "sys", "kernel", "random", "boot_id"), "b\n");
    mkdirSync(join(proc, "300"));
    assert.deepEqual(processSnapshot({ platform: "linux", proc }).rows, [], "an entry whose files are gone (ENOENT) is skipped");
    writeFileSync(join(proc, "300", "stat"), "300 (x) S 1 300 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 9 0 0\n");
    writeFileSync(join(proc, "300", "cmdline"), "x\0");
    chmodSync(join(proc, "300", "cmdline"), 0o000);
    if (process.getuid?.() !== 0) assert.equal(processSnapshot({ platform: "linux", proc }).state, "unknown", "EACCES is unknown, never an empty table");
    chmodSync(join(proc, "300", "cmdline"), 0o600);
    assert.equal(processSnapshot({ platform: "linux", proc, timeout: -1 }).state, "unknown", "the query deadline bounds a large table");
    assert.equal(currentIdentity(424242, { platform: "linux", proc }), null);
  } finally { rmSync(proc, { recursive: true, force: true }); }
});

test("PowerShell and identity corner cases", () => {
  const failed = processSnapshot({ platform: "win32", powershell: () => ({ error: new Error("spawn powershell.exe ENOENT") }) });
  assert.equal(failed.error, "process query failed: spawn powershell.exe ENOENT");
  const silent = processSnapshot({ platform: "win32", powershell: () => ({ status: 3, stderr: "" }) });
  assert.equal(silent.error, "process query failed: exit code 3");
  assert.equal(companionState({ companionPid: 5, companionIdentity: { pid: 5, startedMs: 1 } }, { state: "ok", rows: [{ pid: 5 }] }), "unknown", "a Windows row without a stamp");
  const zeroStamp = ownedExecution({ id: "j", execution: [{ pid: 9, stamp: "0" }] }, { state: "ok", rows: [{ pid: 9, ppid: 1, stamp: "0", raw: "x", argv: ["x"], name: "x" }] }, "win32", [], null);
  assert.equal(zeroStamp.state, "unknown", "an owned process without a creation time cannot be identified");
  const dir = mkdtempSync(join(tmpdir(), "council-ev-"));
  try {
    mkdirSync(join(dir, "cleanup-evidence"));
    writeFileSync(join(dir, "cleanup-evidence", "notes.txt"), "ignored");
    assert.deepEqual(recoveryEvidence({ dir, ownerToken: null }), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("file-system helpers: an atomic write that cannot land leaves no temp file; unreadable JSON is null; canonical falls back", () => {
  const dir = mkdtempSync(join(tmpdir(), "council-fs-"));
  try {
    mkdirSync(join(dir, "target"));
    writeFileSync(join(dir, "target", "inside"), "x");
    assert.throws(() => writeFileAtomic(join(dir, "target"), "data"), /EISDIR|ENOTEMPTY|EPERM|EEXIST/);
    assert.deepEqual(readdirSync(dir), ["target"], "the temporary file was removed");
    writeFileAtomic(join(dir, "ok.json"), '{"a":1}');
    assert.deepEqual(readJson(join(dir, "ok.json")), { a: 1 });
    assert.equal(readJson(join(dir, "target")), null, "a directory is not JSON (retried, then null)");
    writeFileSync(join(dir, "bad.json"), "{");
    assert.equal(readJson(join(dir, "bad.json")), null);
    assert.equal(readJson(join(dir, "missing.json")), null);
    assert.equal(canonical(join(dir, "does", "not", "exist")), join(dir, "does", "not", "exist"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("state and catalog corner cases", () => {
  const root = mkdtempSync(join(tmpdir(), "council-corner-"));
  try {
    const home = homeDir({ COUNCIL_HOME: join(root, "home") });
    assert.equal(loadJob(home, undefined), null);
    assert.equal(loadThread(home, "null", null), null);
    const job = { id: "j", ownerToken: "c".repeat(32), provider: "codex", threadIds: ["bad id!", "fine"] };
    assert.equal(claimHeld(home, job), false, "an invalid recorded id is ignored, a free one is free");
    claimThread(home, "codex", "fine", job);
    assert.equal(claimHeld(home, job), true);
    writeFileSync(join(home, "claims-file"), "");
    assert.throws(() => claimedProviders(join(home, "claims-file")), /ENOTDIR/);
    const cat = loadCatalog(null, "codex");
    assert.deepEqual(resolveEffort("codex", "gpt-6.1-sol", null, cat), { effort: null, requested: null, clamped: false, suffixed: false }, "no request, no effort");
    const odd = { models: { m: ["medium", "high"] }, families: {}, aliases: {}, passThrough: [] };
    assert.deepEqual(resolveEffort("x", "m", "low", odd), { effort: "medium", requested: "low", clamped: true, suffixed: false }, "below every offered effort: the lowest offered");
    assert.deepEqual(loadCatalog(null, "null", { staticEntry: {} }).models, {}, "an empty entry is an empty catalog");
    const r = bound(root, "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b", [], 1000);
    assert.ok(r.diff.endsWith("+b\n"), "a final diff without a newline gets one");
    const j = resultJson({ provider: "null", id: "i", dir: "/d", verb: "task", outcome: "ok", code: 0, failedCommands: ["make test", { cmd: "npm test", exit: 2 }], spawnedAt: "x" }, "");
    assert.deepEqual(j.failedCommands, ["make test", { cmd: "npm test", exit: 2 }]);
    assert.equal(j.requestedEffort, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
