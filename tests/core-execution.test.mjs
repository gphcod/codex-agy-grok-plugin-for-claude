// S2.4: execution.mjs — depth guard, flag operands, ownership, process groups, Windows query decoding,
// identity checks and the stop primitives, all against fake snapshots and a fake PowerShell runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "../plugins/council/scripts/lib/core/args.mjs";
import {
  BARE_BINARIES, GUARD_VARS, MODULES, WINDOWS_KILL, WINDOWS_LIST, assertNotNested, childEnv, companionState, decodeText, executionController, hasFlagOperand,
  isProcessGroupAlive, nestedBy, ownedExecution, ownsExecution, parseWindowsCommandLine, processSnapshot, recordRecoveryEvidence, recoveryEvidence, sameIdentity,
  selfIdentity, stopIdentity, stopProcessGroup,
} from "../plugins/council/scripts/lib/core/execution.mjs";
import nullAdapter from "./fixtures/null-adapter.mjs";

const JOB = "abcdefghij123456";

test("depth guard: any of the four A5.1 variables refuses admission; every child carries all four", () => {
  assert.deepEqual(GUARD_VARS, ["COUNCIL_DEPTH", "CODEX_COMPANION_DEPTH", "GROK_BUILD_DEPTH", "CLAUDE_PLUGIN_CODEX_DEPTH"]);
  assert.equal(nestedBy({}), null);
  assert.equal(nestedBy({ COUNCIL_DEPTH: "" }), null, "an empty value is not set");
  for (const name of GUARD_VARS) {
    assert.equal(nestedBy({ PATH: "/bin", [name]: "1" }), name);
    assert.throws(() => assertNotNested({ [name]: "1" }), (e) => e instanceof UsageError && e.message.includes(name) && /refusing a nested call/.test(e.message));
  }
  assert.doesNotThrow(() => assertNotNested({ PATH: "/bin" }));
  const env = childEnv({ PATH: "/bin", COUNCIL_DEPTH: "" }, { EXTRA: "x" });
  assert.equal(env.PATH, "/bin"); assert.equal(env.EXTRA, "x");
  for (const name of GUARD_VARS) assert.equal(env[name], "1");
});

test("hasFlagOperand over argv rows and over raw macOS rows", () => {
  const argvRow = { argv: ["node", "fake-child.mjs", "--job", JOB, "--model", "m"] };
  assert.equal(hasFlagOperand(argvRow, "--job", JOB), true);
  assert.equal(hasFlagOperand(argvRow, "--job", "other"), false);
  assert.equal(hasFlagOperand(argvRow, "--model", JOB), false);
  assert.equal(hasFlagOperand({ argv: ["a", "--settings", "C:\\Jobs\\X\\settings.json"] }, "--settings", "c:/jobs/x/settings.json", null, "win32"), true, "case- and slash-insensitive on win32");
  assert.equal(hasFlagOperand({ argv: ["a", "--settings", "C:\\Jobs\\X\\settings.json"] }, "--settings", "c:/jobs/x/settings.json", null, "linux"), false);
  assert.equal(hasFlagOperand(argvRow, "--job", ""), false);
  // raw rows with a recorded argv: the raw line must end with the recorded args and start with the recorded launcher
  const job = { argv: ["/usr/local/bin/node", "/x/fake-child.mjs", "--job", JOB, "--model", "m"], childArgs: ["--job", JOB, "--model", "m"] };
  assert.equal(hasFlagOperand({ raw: `/usr/local/bin/node /x/fake-child.mjs --job ${JOB} --model m` }, "--job", JOB, job, "darwin"), true);
  assert.equal(hasFlagOperand({ raw: `node /x/fake-child.mjs --job ${JOB} --model m` }, "--job", JOB, job, "darwin"), false, "a node script needs the complete recorded launcher prefix; only a bare native binary qualifies on its own");
  assert.equal(hasFlagOperand({ raw: `/other/node /x/fake-child.mjs --job ${JOB} --model m` }, "--job", JOB, job, "darwin"), false, "a different launcher does not");
  assert.equal(hasFlagOperand({ raw: `/usr/local/bin/node /x/fake-child.mjs --job ${JOB} --model m extra` }, "--job", JOB, job, "darwin"), false, "suffix must be the whole recorded args");
  assert.equal(hasFlagOperand({ raw: `/usr/local/bin/node /x/fake-child.mjs --job ${JOB} --model m` }, "--job", "other", job, "darwin"), false);
  const native = { argv: ["/opt/homebrew/bin/codex", "exec", "--json", "-o", "/j/answer.md", "-"], childArgs: ["exec", "--json", "-o", "/j/answer.md", "-"] };
  assert.equal(hasFlagOperand({ raw: "codex exec --json -o /j/answer.md -" }, "-o", "/j/answer.md", native, "darwin"), true);
  assert.equal(hasFlagOperand({ raw: "/opt/homebrew/bin/codex exec --json -o /j/answer.md -" }, "-o", "/j/answer.md", native, "darwin"), true);
  assert.equal(hasFlagOperand({ raw: "/evil/codex exec --json -o /j/answer.md -" }, "-o", "/j/answer.md", native, "darwin"), true, "any path ending in the provider binary qualifies, as in grok-build lib/execution.mjs:239; the operand itself is the job-specific evidence");
  assert.equal(hasFlagOperand({ raw: "/evil/wrapper exec --json -o /j/answer.md -" }, "-o", "/j/answer.md", native, "darwin"), false, "an unrelated program does not");
  // raw rows without a recorded argv: whole-token pair
  assert.equal(hasFlagOperand({ raw: `grok --prompt-file /p/prompt.md --model x` }, "--prompt-file", "/p/prompt.md"), true);
  assert.equal(hasFlagOperand({ raw: `grok --prompt-file /p/prompt.md` }, "--prompt-file", "/p/prompt.md"), true);
  assert.equal(hasFlagOperand({ raw: `grok --prompt-file /p/prompt.md.bak` }, "--prompt-file", "/p/prompt.md"), false);
  assert.equal(hasFlagOperand({}, "--x", "y"), false);
});

test("ownsExecution delegates to the adapter; ownedExecution finds owned rows, descendants and group members", () => {
  const job = { id: JOB, pid: 500, companionPid: 100, argv: ["node", "fake-child.mjs", "--job", JOB], execution: [], leader: { pid: 500, stamp: "20" } };
  assert.equal(ownsExecution({ argv: ["node", "fake-child.mjs", "--job", JOB] }, job, "linux", nullAdapter), true);
  assert.equal(ownsExecution({ argv: ["node", "x", "--job", "other"] }, job, "linux", nullAdapter), false);
  assert.equal(ownsExecution({ argv: ["node", "fake-child.mjs", "--job", JOB] }, job, "linux", null), false, "no adapter, no evidence");
  const rows = [
    { pid: 100, ppid: 1, stamp: "10", raw: "node council.mjs", argv: ["node", "council.mjs"], name: "node" },
    { pid: 500, ppid: 100, group: 500, stamp: "20", raw: `node fake-child.mjs --job ${JOB}`, argv: ["node", "fake-child.mjs", "--job", JOB], name: "node" },
    { pid: 501, ppid: 500, group: 500, stamp: "21", raw: "sleep 100", argv: ["sleep", "100"], name: "sleep" },
    { pid: 502, ppid: 1, group: 500, stamp: "22", raw: "helper reparented", argv: ["helper", "reparented"], name: "helper" },
    { pid: 503, ppid: 1, group: 503, stamp: "5", raw: "unrelated", argv: ["unrelated"], name: "unrelated" },
    { pid: 504, ppid: 500, group: 500, stamp: "1", raw: "older than parent", argv: ["x"], name: "x" },
  ];
  const found = ownedExecution(job, { state: "ok", rows }, "darwin", [], nullAdapter);
  assert.equal(found.state, "unknown", "504 cannot be verified (S2.10)");
  assert.deepEqual(found.rows.map((r) => r.pid).sort(), [500, 501, 502].sort(), "child, its descendant and the reparented group member (A7.5)");
  assert.deepEqual(found.unverified.map((r) => r.pid), [504], "a group member older than the leader is never adopted, only reported");
  // S2.8 F1: after pid/pgid reuse the recorded leader is someone else's process; its group is never adopted
  const reused = [
    { pid: 500, ppid: 1, group: 500, stamp: "90", raw: "/bin/sleep 600", argv: ["/bin/sleep", "600"], name: "sleep" },
    { pid: 505, ppid: 1, group: 500, stamp: "91", raw: "/bin/sleep 601", argv: ["/bin/sleep", "601"], name: "sleep" },
  ];
  assert.deepEqual(ownedExecution(job, { state: "ok", rows: reused }, "darwin", [], nullAdapter), { state: "gone", rows: [] }, "a stale recorded identity adopts nothing");
  const stillOurs = ownedExecution({ ...job, argv: [], leader: { pid: 500, stamp: "90" } }, { state: "ok", rows: reused }, "darwin", [], nullAdapter);
  assert.deepEqual(stillOurs.rows.map((r) => r.pid).sort(), [500, 505], "with the live leader's creation time matching the record, its whole group is ours");
  // S2.8 F1 clarification: macOS lstart stamps are parsed to epoch seconds
  const lj = { id: JOB, pid: 700, companionPid: 100, argv: [], execution: [], leader: { pid: 700, stamp: "Sat Oct 31 12:00:00 2026" } };
  const member = { pid: 701, ppid: 1, group: 700, stamp: "Sat Oct 31 12:00:05 2026", raw: "language-server", argv: null, name: "language-server" };
  // S2.9: once the leader is gone, only a member whose identity was persisted while the job ran is ours
  assert.deepEqual(ownedExecution({ ...lj, execution: [{ pid: 701, stamp: member.stamp }] }, { state: "ok", rows: [member] }, "darwin", [], nullAdapter).rows.map((r) => r.pid), [701], "a recorded descendant reparented after the leader exited is owned");
  const lost = ownedExecution(lj, { state: "ok", rows: [member] }, "darwin", [], nullAdapter);
  assert.deepEqual([lost.state, lost.rows, lost.unverified.map((r) => r.pid)], ["unknown", [], [701]], "an unrecorded member is reported unverified, never adopted");
  const newLeader = { pid: 700, ppid: 1, group: 700, stamp: "Sat Oct 31 13:00:00 2026", raw: "/bin/sleep 600", argv: null, name: "sleep" };
  assert.deepEqual(ownedExecution(lj, { state: "ok", rows: [newLeader, { ...member, stamp: "Sat Oct 31 13:00:01 2026" }] }, "darwin", [], nullAdapter).rows, [], "a live leader with the same pid and a newer creation time: a reused group");
  assert.deepEqual(ownedExecution(lj, { state: "ok", rows: [{ ...member, stamp: "Sat Oct 31 11:59:59 2026" }] }, "darwin", [], nullAdapter).rows, [], "a member born before the recorded leader start is not ours");
  const noLeader = ownedExecution({ ...lj, leader: null }, { state: "ok", rows: [member] }, "darwin", [], nullAdapter);
  assert.deepEqual([noLeader.state, noLeader.rows, noLeader.unverified.map((r) => r.pid)], ["unknown", [], [701]], "no recorded leader: no adoption, and the member is unverified, never gone");
  const evidence = ownedExecution(job, { state: "ok", rows: [{ pid: 506, ppid: 1, group: 500, stamp: "1", raw: `helper --job ${JOB}`, argv: ["helper", "--job", JOB], name: "helper" }] }, "darwin", [], nullAdapter);
  assert.deepEqual(evidence.rows.map((r) => r.pid), [506], "a member with job-specific evidence is ours without its leader");
  const linux = ownedExecution(job, { state: "ok", rows: rows.map((r) => ({ ...r, group: undefined })) }, "linux", [], nullAdapter);
  assert.deepEqual(linux.rows.map((r) => r.pid).sort(), [500, 501], "without group data the reparented member is lost and the older-stamped child is not adopted");
  assert.deepEqual(ownedExecution(job, { state: "ok", rows: [rows[0], rows[4]] }, "linux", [], nullAdapter), { state: "gone", rows: [] });
  assert.equal(ownedExecution(job, { state: "unknown", rows: [], error: "boom" }, "linux", [], nullAdapter).error, "boom");
  // known identities from the job record or recovery evidence are owned even without argv evidence
  const known = ownedExecution({ ...job, execution: [{ pid: 777, stamp: "7" }] }, { state: "ok", rows: [{ pid: 777, ppid: 1, stamp: "7", raw: "anything", argv: ["anything"], name: "anything" }] }, "linux", [], nullAdapter);
  assert.equal(known.state, "owned");
  // an empty command line on a provider binary makes the snapshot unknown, not clean
  for (const name of ["codex", "agy", "grok", "node", "codex.exe", "agy.exe", "grok.exe", "node.exe"]) assert.ok(BARE_BINARIES.includes(name));
  const bare = ownedExecution(job, { state: "ok", rows: [{ pid: 900, ppid: 1, stamp: "9", raw: null, argv: null, name: "agy" }] }, "linux", [], nullAdapter);
  assert.equal(bare.state, "unknown");
  const inaccessible = ownedExecution(job, { state: "ok", rows: [{ pid: 500, ppid: 100, stamp: "20", raw: null, argv: null, name: "node", inaccessible: true }] }, "win32", [], nullAdapter);
  assert.equal(inaccessible.state, "unknown", "the launched pid inaccessible is unknown");
  const exiting = ownedExecution({ ...job, execution: [{ pid: 500, stamp: "20" }] }, { state: "ok", rows: [{ pid: 500, ppid: 100, stamp: "20", raw: "", argv: [], name: "helper", exiting: true }] }, "linux", [], nullAdapter);
  assert.equal(exiting.state, "owned", "an exiting owned process with an empty command line is still owned, not unknown");
  const exitingBare = ownedExecution({ ...job, execution: [{ pid: 500, stamp: "20" }] }, { state: "ok", rows: [{ pid: 500, ppid: 100, stamp: "20", raw: "", argv: [], name: "node", exiting: true }] }, "linux", [], nullAdapter);
  assert.equal(exitingBare.state, "unknown", "but a provider binary with no command line is unknown, as in the donor");
});

test("sameIdentity, companionState (POSIX stamps and Windows ticks), selfIdentity", () => {
  assert.equal(sameIdentity({ pid: 1, stamp: "a" }, { pid: 1, stamp: "a" }), true);
  assert.equal(sameIdentity({ pid: 1, stamp: "a", boot: "x" }, { pid: 1, stamp: "a" }), false);
  assert.equal(sameIdentity({ pid: 1, stamp: "" }, { pid: 1, stamp: "" }), false);
  const job = { companionPid: 42, companionIdentity: { pid: 42, stamp: "Sat Oct 31 12:00:00 2026" } };
  assert.equal(companionState(job, { state: "unknown", rows: [] }), "unknown");
  assert.equal(companionState(job, { state: "ok", rows: [] }), "gone");
  assert.equal(companionState(job, { state: "ok", rows: [{ pid: 42, stamp: "Sat Oct 31 12:00:00 2026" }] }), "live");
  assert.equal(companionState(job, { state: "ok", rows: [{ pid: 42, stamp: "Sun Nov 1 12:00:00 2026" }] }), "gone", "a reused pid with another birth stamp is gone");
  assert.equal(companionState({ companionPid: 42 }, { state: "ok", rows: [{ pid: 42, stamp: "x" }] }), "unknown", "an old record without identity proves nothing");
  // Windows: Node start time against the CIM creation ticks (100 ns since year 1)
  const startedMs = Date.UTC(2026, 9, 31, 12, 0, 0);
  const ticks = (BigInt(startedMs) * 10000n + 621355968000000000n).toString();
  const win = { companionPid: 7, companionIdentity: { pid: 7, startedMs } };
  assert.equal(companionState(win, { state: "ok", rows: [{ pid: 7, stamp: ticks }] }), "live");
  assert.equal(companionState(win, { state: "ok", rows: [{ pid: 7, stamp: (BigInt(ticks) + 40000n * 1000n).toString() }] }), "live", "4 s of skew is tolerated");
  assert.equal(companionState(win, { state: "ok", rows: [{ pid: 7, stamp: (BigInt(ticks) + 60000n * 1000n).toString() }] }), "gone", "6 s is a different process");
  assert.equal(companionState(win, { state: "ok", rows: [{ pid: 7, stamp: "0" }] }), "unknown");
  const self = selfIdentity("win32");
  assert.equal(self.pid, process.pid);
  assert.ok(Math.abs(self.startedMs - (Date.now() - process.uptime() * 1000)) < 2000);
});

test("Windows snapshot through a fake PowerShell runner: PSModulePath, ThreadCount filter, text decoding", () => {
  const calls = [];
  const powershell = (script, env) => {
    calls.push({ script, env });
    const rows = [
      "100\t1\t638600000000000000\t=node council.mjs\t=node.exe\t3",
      `200\t100\t638600000000001000\t=node fake-child.mjs --job ${JOB}\t=node.exe\t2`,
      "300\t1\t638600000000002000\t=exited but listed\t=codex.exe\t0",
      "400\t1\t638600000000003000\t-\t=grok.exe\t1",
      `500\t1\t638600000000004000\tx${Buffer.from("héllo wörld", "utf16le").swap16().toString("hex")}\tx${Buffer.from("agy.exe", "utf16le").swap16().toString("hex")}\t1`,
    ];
    return { status: 0, stdout: `ok\n${rows.join("\n")}\ncomplete\n`, stderr: "" };
  };
  const snap = processSnapshot({ platform: "win32", powershell });
  assert.equal(snap.state, "ok");
  assert.ok(calls[0].script.startsWith(MODULES), "PSModulePath injected inline");
  assert.equal(calls[0].env.CC_QUERY_PID, "");
  assert.deepEqual(snap.rows.map((r) => r.pid), [100, 200, 400, 500], "ThreadCount=0 filtered");
  assert.deepEqual(snap.rows[1].argv, ["node", "fake-child.mjs", "--job", JOB]);
  assert.equal(snap.rows[2].inaccessible, true); assert.equal(snap.rows[2].raw, null); assert.equal(snap.rows[2].name, "grok.exe");
  assert.equal(snap.rows[3].raw, "héllo wörld"); assert.equal(snap.rows[3].name, "agy.exe");
  assert.equal(decodeText("=plain"), "plain");
  assert.equal(decodeText("=tab\there"), null, "control characters are not printable ASCII");
  assert.equal(decodeText("x0041"), "A");
  assert.equal(decodeText("xZZ"), null);
  assert.equal(decodeText("?x"), null);
  processSnapshot({ platform: "win32", powershell, pid: 42 });
  assert.equal(calls[1].env.CC_QUERY_PID, "42");
  // malformed or failed queries are unknown with a cause, never an empty table
  assert.equal(processSnapshot({ platform: "win32", powershell: () => ({ status: 0, stdout: "ok\nbad row\ncomplete", stderr: "" }) }).state, "unknown");
  assert.equal(processSnapshot({ platform: "win32", powershell: () => ({ status: 0, stdout: "ok\n100\t1\t5\t=x\t=y\t1\n", stderr: "" }) }).state, "unknown", "missing 'complete'");
  const failed = processSnapshot({ platform: "win32", powershell: () => ({ status: 1, stdout: "", stderr: "Get-CimInstance : boom\nAt line:1 char:1" }) });
  assert.equal(failed.state, "unknown"); assert.equal(failed.error, "process query failed: Get-CimInstance : boom");
  const timedOut = processSnapshot({ platform: "win32", powershell: () => ({ error: { code: "ETIMEDOUT" } }), timeout: 5000 });
  assert.equal(timedOut.error, "process query timed out after 5 s");
  assert.ok(WINDOWS_LIST.includes("ThreadCount") && WINDOWS_KILL.includes("taskkill /T /F"));
});

test("darwin snapshot parses pid, ppid, pgid, uid, stat, lstart and args", () => {
  const uid = process.getuid();
  const run = () => ({ status: 0, stdout: [
    `  100     1   100 ${uid} Ss   Sat Oct 31 12:00:00 2026 /sbin/launchd`,
    `  500   100   500 ${uid} S+   Sat Oct 31 12:26:47 2026 codex exec --json -o /j/answer.md -`,
    `  501   500   500 ${uid} Z    Sat Oct 31 12:26:48 2026 (zombie)`,
    `  600     1   600 0 S    Sat Oct 31 12:26:49 2026 root process`,
  ].join("\n") + "\n" });
  const snap = processSnapshot({ platform: "darwin", run });
  assert.equal(snap.state, "ok");
  assert.deepEqual(snap.rows.map((r) => r.pid), [100, 500], "zombies and other users' processes are skipped");
  assert.deepEqual(snap.rows[1], { pid: 500, ppid: 100, group: 500, stamp: "Sat Oct 31 12:26:47 2026", raw: "codex exec --json -o /j/answer.md -", argv: null, name: "codex" });
  assert.equal(processSnapshot({ platform: "darwin", run: () => ({ status: 0, stdout: "garbage line\n" }) }).state, "unknown");
  assert.equal(processSnapshot({ platform: "darwin", run: () => ({ status: 1, stdout: "", stderr: "ps: boom" }) }).error, "process query failed: ps: boom");
  assert.equal(processSnapshot({ platform: "darwin", run: () => ({ status: 1, stdout: "" }), pid: 999999 }).state, "ok", "a scoped query for a dead pid is an empty ok table");
  assert.equal(processSnapshot({ platform: "freebsd" }).state, "unknown");
});

test("parseWindowsCommandLine follows CommandLineToArgvW", () => {
  assert.deepEqual(parseWindowsCommandLine('"C:\\Program Files\\node.exe" "C:\\x\\codex.js" exec --json -o "C:\\j o b\\answer.md" -'), ["C:\\Program Files\\node.exe", "C:\\x\\codex.js", "exec", "--json", "-o", "C:\\j o b\\answer.md", "-"]);
  // two quotes inside a quoted run give one literal quote and end the run (grok-build lib/execution.mjs:69-70)
  assert.deepEqual(parseWindowsCommandLine('a.exe "quoted ""inner"" text" tail'), ["a.exe", 'quoted "inner', "text tail"]);
  assert.deepEqual(parseWindowsCommandLine('a.exe \\\\"x'), ["a.exe", '\\"x'.slice(0, 1) + "x"]);
  assert.deepEqual(parseWindowsCommandLine('  a.exe   b\tc  '), ["a.exe", "b", "c"]);
  assert.deepEqual(parseWindowsCommandLine('a.exe back\\slash'), ["a.exe", "back\\slash"]);
  assert.deepEqual(parseWindowsCommandLine('"unterminated'), ["unterminated"]);
});

test("stopIdentity: kill only when the identity matches; mismatched timestamp or command line refuses", () => {
  const killed = [];
  const kill = (pid, sig) => { killed.push([pid, sig]); };
  const row = { pid: 777, stamp: "Sat Oct 31 12:00:00 2026", raw: "node fake-child.mjs --job x" };
  const snapshotWith = (current) => () => ({ state: "ok", rows: current ? [current] : [] });
  assert.equal(stopIdentity(row, { platform: "darwin", snapshot: snapshotWith(row), kill }), "sent");
  assert.deepEqual(killed, [[777, "SIGKILL"]]);
  assert.equal(stopIdentity(row, { platform: "darwin", snapshot: snapshotWith(row), kill, signal: "SIGTERM" }), "sent");
  assert.deepEqual(killed.at(-1), [777, "SIGTERM"]);
  killed.length = 0;
  assert.equal(stopIdentity(row, { platform: "darwin", snapshot: snapshotWith({ ...row, stamp: "Sun Nov 1 00:00:00 2026" }), kill }), "mismatch", "another process reusing the pid");
  assert.equal(stopIdentity(row, { platform: "darwin", snapshot: snapshotWith({ ...row, raw: "something else" }), kill }), "unknown", "same second, different command line");
  assert.equal(stopIdentity(row, { platform: "darwin", snapshot: snapshotWith(null), kill }), "gone");
  assert.equal(stopIdentity(row, { platform: "darwin", snapshot: () => ({ state: "unknown", rows: [] }), kill }), "unknown");
  assert.deepEqual(killed, [], "nothing was signalled on mismatch, unknown or gone");
  assert.equal(stopIdentity({ pid: process.pid, stamp: "x" }, { platform: "linux", snapshot: snapshotWith({ pid: process.pid, stamp: "x" }), kill }), "unknown", "never itself");
  const esrch = () => { const e = new Error("gone"); e.code = "ESRCH"; throw e; };
  assert.equal(stopIdentity(row, { platform: "linux", snapshot: snapshotWith(row), kill: esrch }), "gone");
  // win32: the inline script's verdict is trusted word for word
  const ps = (result) => () => ({ status: 0, stdout: `${result}\n` });
  assert.equal(stopIdentity(row, { platform: "win32", powershell: ps("mismatch") }), "mismatch");
  assert.equal(stopIdentity(row, { platform: "win32", powershell: ps("sent") }), "sent");
  assert.equal(stopIdentity(row, { platform: "win32", powershell: ps("gone") }), "gone");
  assert.equal(stopIdentity(row, { platform: "win32", powershell: ps("weird") }), "unknown");
  assert.equal(stopIdentity(row, { platform: "win32", powershell: () => ({ status: 1, stdout: "sent" }) }), "unknown");
  let seenEnv = null;
  stopIdentity(row, { platform: "win32", powershell: (script, env) => { seenEnv = env; assert.ok(script.startsWith(MODULES)); return { status: 0, stdout: "gone" }; } });
  assert.deepEqual(seenEnv, { CC_KILL_PID: "777", CC_KILL_STAMP: row.stamp, CC_KILL_RAW: row.raw });
});

test("stopProcessGroup: SIGTERM to the group, escalation to SIGKILL after the grace; Windows and bad pids do nothing", async () => {
  const sent = [];
  let alive = 3;
  const kill = (pid, sig) => {
    if (sig === 0) { if (alive > 0) { alive -= 1; return; } const e = new Error("gone"); e.code = "ESRCH"; throw e; }
    sent.push([pid, sig]);
  };
  const r = await stopProcessGroup(500, { platform: "linux", graceMs: 50, kill, sleep: async () => {} });
  assert.deepEqual(r, { attempted: true, delivered: true, escalated: false });
  assert.deepEqual(sent, [[-500, "SIGTERM"]]);
  const stubborn = await stopProcessGroup(500, { platform: "linux", graceMs: 20, kill: (pid, sig) => { if (sig !== 0) sent.push([pid, sig]); }, sleep: async () => {} });
  assert.deepEqual(stubborn, { attempted: true, delivered: true, escalated: true });
  assert.deepEqual(sent.slice(1), [[-500, "SIGTERM"], [-500, "SIGKILL"]]);
  assert.deepEqual(await stopProcessGroup(500, { platform: "win32" }), { attempted: false, delivered: false, escalated: false });
  assert.deepEqual(await stopProcessGroup(0, { platform: "linux" }), { attempted: false, delivered: false, escalated: false });
  // group signal fails → pid fallback
  const fallback = [];
  const partial = (pid, sig) => { if (sig === 0) { const e = new Error("x"); e.code = "ESRCH"; throw e; } if (pid < 0) throw new Error("no group"); fallback.push([pid, sig]); };
  assert.equal((await stopProcessGroup(600, { platform: "linux", graceMs: 10, kill: partial, sleep: async () => {} })).delivered, true);
  assert.deepEqual(fallback, [[600, "SIGTERM"]]);
  assert.equal(isProcessGroupAlive(600, { kill: () => { const e = new Error("perm"); e.code = "EPERM"; throw e; } }), true, "EPERM means alive");
});

test("recovery evidence round-trips and rejects another owner's record", () => {
  const dir = mkdtempSync(join(tmpdir(), "council-evidence-"));
  try {
    const job = { dir, ownerToken: "a".repeat(32) };
    assert.deepEqual(recoveryEvidence(job), []);
    recordRecoveryEvidence(job, []);
    assert.deepEqual(recoveryEvidence(job), []);
    recordRecoveryEvidence(job, [{ pid: 1, stamp: "x" }]);
    recordRecoveryEvidence(job, [{ pid: 2, stamp: "y" }]);
    assert.deepEqual(recoveryEvidence(job).map((r) => r.pid).sort(), [1, 2]);
    assert.throws(() => recoveryEvidence({ dir, ownerToken: "b".repeat(32) }), /unreadable cleanup evidence/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("executionController wires platform, adapter, snapshot and stop options", async () => {
  const snapshots = [];
  const control = executionController({ platform: "linux", adapter: nullAdapter, snapshot: (o) => { snapshots.push(o); return { state: "ok", rows: [] }; }, kill: () => {} });
  assert.equal(control.platform, "linux");
  assert.deepEqual(control.snapshot(123).rows, []);
  assert.equal(snapshots[0].timeout, 123);
  const dir = mkdtempSync(join(tmpdir(), "council-ctl-"));
  try {
    assert.deepEqual(control.inspect({ id: JOB, dir, execution: [], argv: [] }, { state: "ok", rows: [{ pid: 9, ppid: 1, stamp: "1", raw: `node x --job ${JOB}`, argv: ["node", "x", "--job", JOB], name: "node" }] }).rows.map((r) => r.pid), [9]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(control.stop({ pid: 9, stamp: "1", raw: "x" }), "gone");
  assert.deepEqual(await control.stopGroup(0), { attempted: false, delivered: false, escalated: false });
});
