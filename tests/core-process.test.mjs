// S2.7 (ratio): execution.mjs, launcher.mjs and stdin.mjs against real processes on this machine —
// a real process-table snapshot, identity-checked stops, the group stop with escalation, the
// spawned child's group and environment, and the stdin reader's edge cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { GUARD_VARS, childEnv, companionState, executionController, isProcessGroupAlive, processSnapshot, selfIdentity, stopIdentity, stopProcessGroup } from "../plugins/council/scripts/lib/core/execution.mjs";
import { runSync, spawnChild } from "../plugins/council/scripts/lib/core/launcher.mjs";
import { UsageError } from "../plugins/council/scripts/lib/core/args.mjs";
import { readStdin, readText } from "../plugins/council/scripts/lib/core/stdin.mjs";
import nullAdapter from "./fixtures/null-adapter.mjs";

const posix = process.platform !== "win32";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check, ms = 5000) { for (const end = Date.now() + ms; !check(); await sleep(20)) if (Date.now() > end) return false; return true; }

test("a real snapshot contains this process with a stable identity; companionState reads it as live", { skip: !posix }, () => {
  const snap = processSnapshot();
  assert.equal(snap.state, "ok");
  const me = snap.rows.find((r) => r.pid === process.pid);
  assert.ok(me, "this process is listed");
  assert.equal(me.ppid, process.ppid);
  assert.match(me.raw, /node/);
  const self = selfIdentity();
  assert.equal(self.pid, process.pid);
  assert.equal(self.stamp, me.stamp);
  assert.equal(companionState({ companionPid: process.pid, companionIdentity: self }, snap), "live");
  assert.equal(companionState({ companionPid: process.pid, companionIdentity: { ...self, stamp: "Thu Jan 1 00:00:00 1970" } }, snap), "gone", "a pid with another birth stamp is another process");
  const scoped = processSnapshot({ pid: process.pid });
  assert.deepEqual(scoped.rows.map((r) => r.pid), [process.pid]);
});

test("spawnChild: its own process group, the guard variables, piped stdio; ownership by operand on the real table", { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "council-proc-"));
  try {
    const script = join(dir, "child.mjs");
    writeFileSync(script, "process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => k.endsWith('_DEPTH')))) + '\\n'); setTimeout(() => {}, 30000);");
    const launcher = { command: process.execPath, args: [script], path: script, kind: "node-script" };
    const child = spawnChild(launcher, ["--job", "real-job-0000001"], { cwd: dir, env: childEnv({ PATH: process.env.PATH }) });
    let line = "";
    child.stdout.on("data", (d) => { line += d; });
    assert.ok(await until(() => line.includes("\n")));
    assert.deepEqual(Object.keys(JSON.parse(line)).sort(), [...GUARD_VARS].sort());
    const snap = processSnapshot();
    const row = snap.rows.find((r) => r.pid === child.pid);
    assert.ok(row, "the child is in the table");
    if (row.group !== undefined) assert.equal(row.group, child.pid, "detached: it leads its own group");
    const control = executionController({ adapter: nullAdapter });
    const job = { id: "real-job-0000001", pid: child.pid, companionPid: process.pid, argv: [process.execPath, script, "--job", "real-job-0000001"], childArgs: ["--job", "real-job-0000001"], execution: [], dir };
    const found = control.inspect(job, snap);
    assert.equal(found.state, "owned");
    assert.ok(found.rows.some((r) => r.pid === child.pid));
    const other = control.inspect({ ...job, id: "another-job-0001", childArgs: ["--job", "another-job-0001"], argv: [process.execPath, script, "--job", "another-job-0001"], pid: 1 }, snap);
    assert.ok(!other.rows.some((r) => r.pid === child.pid), "another job's operand never matches");
    // identity-checked stop: a stale stamp is refused, the right one is killed
    assert.equal(stopIdentity({ ...row, stamp: "Thu Jan 1 00:00:00 1970" }), "mismatch");
    assert.ok(alive(child.pid));
    assert.equal(stopIdentity(row), "sent");
    assert.ok(await until(() => !alive(child.pid)));
    assert.equal(stopIdentity(row), "gone");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stopProcessGroup: SIGTERM reaches the whole group; a child that ignores it is killed after the grace", { skip: !posix }, async () => {
  const polite = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { detached: true, stdio: "ignore" });
  const r1 = await stopProcessGroup(polite.pid, { graceMs: 2000 });
  assert.deepEqual(r1, { attempted: true, delivered: true, escalated: false });
  assert.ok(await until(() => !alive(polite.pid)));
  const stubborn = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  await sleep(300); // let it install the handler
  const r2 = await stopProcessGroup(stubborn.pid, { graceMs: 300 });
  assert.equal(r2.escalated, true, "SIGKILL after the grace");
  assert.ok(await until(() => !alive(stubborn.pid)));
  assert.equal(isProcessGroupAlive(stubborn.pid), false);
});

test("runSync: bounded probe command with captured output", () => {
  const launcher = { command: process.execPath, args: ["-e"], path: process.execPath, kind: "native" };
  const r = runSync(launcher, ["process.stdout.write('probe ok'); process.stderr.write('warn')"], { env: process.env });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "probe ok");
  assert.equal(r.stderr, "warn");
  const slow = runSync(launcher, ["setTimeout(() => {}, 5000)"], { env: process.env, timeoutMs: 200 });
  assert.equal(slow.error?.code, "ETIMEDOUT", "a probe never hangs the caller");
});

test("stdin: buffers and strings, CRLF stripping, stream errors, and an exact deadline", async () => {
  const chunks = new PassThrough();
  chunks.write(Buffer.from("héllo "));
  chunks.write("wörld\r\n");
  chunks.end();
  assert.equal(await readStdin(chunks, 200), "héllo wörld\r\n");
  const crlf = new PassThrough(); crlf.end("text\r\n");
  assert.deepEqual(await readText({}, [], false, { stream: crlf, idleMs: 200 }), { options: {}, text: "text", literal: false });
  const failing = new PassThrough();
  setTimeout(() => failing.emit("error", new Error("EPIPE")), 20);
  await assert.rejects(readStdin(failing, 1000), /EPIPE/);
  const trickle = new PassThrough();
  const started = Date.now();
  const timer = setInterval(() => trickle.write("x"), 50);
  setTimeout(() => { clearInterval(timer); trickle.end("!"); }, 400);
  const text = await readStdin(trickle, 150);
  assert.match(text, /^x{5,}!$/, "every byte re-arms the idle deadline, so a slow writer is read to its end");
  assert.ok(Date.now() - started >= 350);
});
