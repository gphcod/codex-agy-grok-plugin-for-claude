// S2.7 (ratio): claims.mjs failure handling with an injected file-system, and the Linux /proc snapshot
// of execution.mjs over a fabricated /proc tree.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusyError, claimHeld, claimPath, claimThread, claimedProviders, inspectClaim, ownedThreads, releaseClaims, releaseThread } from "../plugins/council/scripts/lib/core/claims.mjs";
import { ownedExecution, processSnapshot } from "../plugins/council/scripts/lib/core/execution.mjs";
import nullAdapter from "./fixtures/null-adapter.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "council-claims-"));
const job = (id, token) => ({ id, ownerToken: token, provider: "codex", threadIds: [] });
const T1 = "a".repeat(32), T2 = "b".repeat(32);

test("a failed owner publication leaves an unknown claim marked claimLeft, never a free one", () => {
  const home = tmp();
  try {
    const io = Object.create(fs);
    io.writeFileSync = () => { throw Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" }); };
    const j = job("job1", T1);
    assert.throws(() => claimThread(home, "codex", "t1", j, io), (e) => e.claimLeft === true && /ENOSPC/.test(e.message));
    assert.equal(inspectClaim(home, "codex", "t1").state, "unknown", "an empty claim directory is occupied");
    assert.equal(claimHeld(home, { ...j, threadIds: ["t1"] }), true);
    assert.throws(() => claimThread(home, "codex", "t1", job("job2", T2)), (e) => e instanceof BusyError && e.job === null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("inspectClaim: extra files, a malformed owner record and an unreadable claim are unknown", () => {
  const home = tmp();
  try {
    const j = job("job1", T1);
    claimThread(home, "codex", "t1", j);
    const dir = claimPath(home, "codex", "t1");
    writeFileSync(join(dir, "stray"), "");
    assert.equal(inspectClaim(home, "codex", "t1").state, "unknown", "two entries");
    rmSync(join(dir, "stray"));
    writeFileSync(join(dir, `owner-${T1}`), "NOT A JOB ID\n");
    assert.equal(inspectClaim(home, "codex", "t1").state, "unknown");
    writeFileSync(join(dir, `owner-${T1}`), "job1\n");
    assert.deepEqual(inspectClaim(home, "codex", "t1"), { state: "owned", dir, job: "job1", token: T1 });
    const io = Object.create(fs);
    io.readdirSync = () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
    assert.equal(inspectClaim(home, "codex", "t1", io).state, "unknown");
    assert.equal(inspectClaim(home, "codex", "never").state, "absent");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("releaseThread: only the owner unlinks; a replacement owner's directory survives; unexpected errors surface", () => {
  const home = tmp();
  try {
    const a = job("joba", T1), b = job("jobb", T2);
    claimThread(home, "codex", "t1", a);
    assert.equal(releaseThread(home, "codex", "t1", b), false, "not the owner");
    assert.equal(inspectClaim(home, "codex", "t1").job, "joba");
    // A file another process held open at the unlink keeps the directory "not empty" for a moment.
    let tries = 0;
    const io = Object.create(fs);
    io.rmdirSync = (dir) => { if (tries++ < 2) throw Object.assign(new Error("ENOTEMPTY"), { code: "ENOTEMPTY" }); return fs.rmdirSync(dir); };
    assert.equal(releaseThread(home, "codex", "t1", a, io), true);
    assert.equal(inspectClaim(home, "codex", "t1").state, "absent", "the retry removed it");
    claimThread(home, "codex", "t2", a);
    const broken = Object.create(fs);
    broken.unlinkSync = () => { throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); };
    assert.throws(() => releaseThread(home, "codex", "t2", a, broken), /EPERM/);
    const rmdirBroken = Object.create(fs);
    rmdirBroken.rmdirSync = () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); };
    assert.throws(() => releaseThread(home, "codex", "t2", a, rmdirBroken), /EIO/);
    assert.equal(inspectClaim(home, "codex", "t2").job, "joba", "the owner came back");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("an rmdir that keeps failing gives the claim back, so recovery can release it and the thread is usable again", () => {
  const home = tmp();
  try {
    const a = { ...job("joba", T1), threadIds: ["t1"] }, b = job("jobb", T2);
    claimThread(home, "codex", "t1", a);
    const stuck = Object.create(fs);
    stuck.rmdirSync = () => { throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" }); };
    // Delete-pending on Windows: the same name cannot be created again for a moment.
    let refused = 0;
    stuck.writeFileSync = (...args) => { if (refused++ < 2) throw Object.assign(new Error("EACCES: delete pending"), { code: "EACCES" }); return fs.writeFileSync(...args); };
    assert.throws(() => releaseClaims(home, a, stuck), /EBUSY/);
    assert.deepEqual([inspectClaim(home, "codex", "t1").state, inspectClaim(home, "codex", "t1").job], ["owned", "joba"]);
    assert.equal(claimHeld(home, a), true);
    assert.throws(() => claimThread(home, "codex", "t1", b), (e) => e instanceof BusyError && e.job === "joba", "still busy, and with a job that names what to cancel");
    releaseClaims(home, a);
    assert.equal(inspectClaim(home, "codex", "t1").state, "absent");
    assert.equal(claimHeld(home, a), false);
    claimThread(home, "codex", "t1", b);
    assert.equal(inspectClaim(home, "codex", "t1").job, "jobb");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("ownedThreads and releaseClaims stay inside the job's provider; claimedProviders lists the namespaces", () => {
  const home = tmp();
  try {
    const codexJob = job("jobc", T1);
    const grokJob = { ...job("jobg", T1), provider: "grok" }; // same token, other provider
    claimThread(home, "codex", "x1", codexJob);
    claimThread(home, "codex", "x2", codexJob);
    claimThread(home, "grok", "x1", grokJob);
    assert.deepEqual(ownedThreads(home, codexJob).sort(), ["x1", "x2"]);
    assert.deepEqual(ownedThreads(home, grokJob), ["x1"]);
    releaseClaims(home, codexJob);
    assert.deepEqual(ownedThreads(home, codexJob), []);
    assert.equal(inspectClaim(home, "grok", "x1").state, "owned", "another provider's claim is untouched");
    assert.deepEqual(claimedProviders(home).sort(), ["codex", "grok"]);
    assert.deepEqual(claimedProviders(join(home, "nowhere")), []);
    assert.deepEqual(ownedThreads(home, { id: "x", ownerToken: T1 }), [], "a job without a provider owns nothing");
    assert.throws(() => claimPath(home, "../evil", "t"), /invalid provider/);
    mkdirSync(join(home, "claims", "codex", "bad name!"), { recursive: true });
    assert.deepEqual(ownedThreads(home, codexJob), [], "names that are not thread ids are ignored");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

/** A fabricated /proc entry: stat fields after the comm are state, ppid, pgrp, …, flags at 6, starttime at 19. */
function procEntry(proc, pid, { ppid, pgrp = pid, state = "S", flags = 0, start = 1000 + pid, argv }) {
  const fields = [state, ppid, pgrp, 0, 0, 0, flags, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, start, 0, 0];
  mkdirSync(join(proc, String(pid)), { recursive: true });
  writeFileSync(join(proc, String(pid), "stat"), `${pid} (${argv[0]}) ${fields.join(" ")}\n`);
  writeFileSync(join(proc, String(pid), "cmdline"), argv.join("\0") + "\0");
}

test("Linux snapshot from /proc: argv, group, boot id, zombies skipped, exiting flag, scoped query", () => {
  process.getuid ??= () => 0; // Windows has none; the /proc reader compares with it, and a stat there reports uid 0.
  const proc = tmp();
  try {
    mkdirSync(join(proc, "sys", "kernel", "random"), { recursive: true });
    writeFileSync(join(proc, "sys", "kernel", "random", "boot_id"), "boot-123\n");
    procEntry(proc, 100, { ppid: 1, argv: ["node", "council.mjs"] });
    procEntry(proc, 200, { ppid: 100, argv: ["node", "fake-child.mjs", "--job", "j-1"] });
    procEntry(proc, 201, { ppid: 200, pgrp: 200, argv: ["sleep", "100"] });
    procEntry(proc, 202, { ppid: 200, pgrp: 200, state: "Z", argv: ["defunct"] });
    procEntry(proc, 203, { ppid: 1, pgrp: 200, flags: 4, argv: ["exiting helper"] });
    writeFileSync(join(proc, "not-a-pid"), "");
    const snap = processSnapshot({ platform: "linux", proc });
    assert.equal(snap.state, "ok");
    assert.deepEqual(snap.rows.map((r) => r.pid).sort(), [100, 200, 201, 203]);
    const child = snap.rows.find((r) => r.pid === 200);
    assert.deepEqual([child.ppid, child.group, child.stamp, child.boot, child.name, child.raw], [100, 200, "1200", "boot-123", "node", "node fake-child.mjs --job j-1"]);
    assert.deepEqual(child.argv, ["node", "fake-child.mjs", "--job", "j-1"]);
    assert.equal(snap.rows.find((r) => r.pid === 203).exiting, true);
    const one = processSnapshot({ platform: "linux", proc, pid: 201 });
    assert.deepEqual(one.rows.map((r) => r.pid), [201]);
    assert.deepEqual(processSnapshot({ platform: "linux", proc, pid: 999 }).rows, [], "a vanished pid is an empty scoped table");
    const owned = ownedExecution({ id: "j-1", pid: 200, companionPid: 100, argv: [], execution: [], leader: { pid: 200, stamp: "1200", boot: "boot-123" } }, snap, "linux", [], { ownsProcess: (row) => row.argv?.includes("j-1") });
    assert.deepEqual(owned.rows.map((r) => r.pid).sort(), [200, 201, 203], "the reparented member of the child's process group is found too (A7.5)");
    assert.equal(processSnapshot({ platform: "linux", proc: join(proc, "missing") }).state, "unknown", "no boot id: unknown, never empty");
    assert.equal(nullAdapter.ownsProcess(child, { id: "j-1" }), true);
  } finally { rmSync(proc, { recursive: true, force: true }); }
});
