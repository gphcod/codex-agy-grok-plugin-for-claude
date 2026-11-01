// S2.8: regression tests for the milestone 2 review findings (F2–F14) and the twin's addendum (A3, A5).
// F1 lives in core-execution.test.mjs, F3 in core-entry.test.mjs next to the cases it corrects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import nullAdapter from "./fixtures/null-adapter.mjs";
import { GUARD_VARS } from "./fixtures/fake-common.mjs";
import { commitAll, git, initRepo, isolateGit } from "./fixtures/build-repos.mjs";
import { main } from "../plugins/council/scripts/council.mjs";
import { inspectClaim } from "../plugins/council/scripts/lib/core/claims.mjs";
import { executionController, hasFlagOperand, ownedExecution } from "../plugins/council/scripts/lib/core/execution.mjs";
import { defaultBranch, reviewTarget } from "../plugins/council/scripts/lib/core/git.mjs";
import { homeDir, loadJob, loadThread } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { runManagedTurn } from "../plugins/council/scripts/lib/core/lifecycle.mjs";

isolateGit();
const FAST = { drainMs: 150, shutdownMs: 4000, retryMs: 300, graceMs: 100, pipeWaitMs: 400 };
const variant = (over) => Object.assign(Object.create(Object.getPrototypeOf(nullAdapter)), nullAdapter, over);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const root = mkdtempSync(join(tmpdir(), "council-s28-"));
  const home = homeDir({ COUNCIL_HOME: join(root, "home") });
  const cwd = join(root, "work");
  mkdirSync(cwd);
  const log = join(root, "spawns.log");
  writeFileSync(log, "");
  const env = { ...process.env, COUNCIL_FAKE_SPAWN_LOG: log };
  for (const g of GUARD_VARS) delete env[g];
  for (const k of ["COUNCIL_FAKE_SCENARIO", "COUNCIL_FAKE_ANSWER", "COUNCIL_FAKE_REVIEW"]) delete env[k];
  const spawns = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { root, home, cwd, env, spawns, ctx: { home, env, cwd, session: "s" }, done: () => rmSync(root, { recursive: true, force: true }) };
}
const request = (s, over = {}) => ({ verb: "ask", provider: "null", cwd: s.cwd, session: "s", tier: "consult", model: "null-model", effort: "high", modelVerified: true, thread: null, readOnly: true, text: "hi", contract: "<c/>", rounds: 9, round: 1, ...over });
function run(s, { adapter = nullAdapter, over = {}, env = {}, hooks = {}, options = {} } = {}) {
  const r = request(s, over);
  return runManagedTurn({ ...s.ctx, env: { ...s.env, ...env } }, adapter, r, () => r, { deadlineMs: 15000, inactivityMs: 15000, ...options }, { ...FAST, ...hooks });
}
async function entry(s, argv, { env = {}, stdin = "" } = {}) {
  let out = "", err = "";
  const stream = new PassThrough(); stream.end(stdin);
  const code = await main(argv, { ...s.env, COUNCIL_TEST_NULL_ADAPTER: "1", COUNCIL_HOME: s.home, COUNCIL_STDIN_DEADLINE_MS: "300", ...env }, { stdout: { write: (x) => { out += x; } }, stderr: { write: (x) => { err += x; } }, stdin: stream, cwd: s.cwd });
  return { code, out, err };
}

test("F2: a resumed discovered thread that comes back as another id fails before anything is published", async () => {
  const s = setup();
  try {
    const discovered = { COUNCIL_NULL_ID: "discovered" };
    const first = await run(s, { env: { ...discovered, COUNCIL_FAKE_THREAD: "thread-a" } });
    assert.equal(first.job.threadId, "thread-a");
    const swapping = variant({ parseEvent: (line, state) => { const ev = nullAdapter.parseEvent(line, state); return ev?.threadId ? { threadId: "thread-b" } : ev; } });
    const { job } = await run(s, { adapter: swapping, env: discovered, over: { verb: "reply", thread: { threadId: "thread-a" }, round: 2 } });
    assert.equal(job.code, 1);
    assert.equal(job.error, "null answered on thread thread-b, expected thread-a");
    assert.notEqual(job.threadId, "thread-b");
    assert.equal(loadThread(s.home, "null", "thread-b"), null, "no record for the foreign thread");
    assert.equal(loadThread(s.home, "null", "thread-a").round, 2, "the resumed thread's record follows the failed turn, not thread-b");
    assert.equal(inspectClaim(s.home, "null", "thread-b").state, "absent", "never claimed");
  } finally { s.done(); }
});

test("F4: finalizeReview reads the whole answer, so a finding after 32,000 bytes counts", async () => {
  const s = setup();
  try {
    let seen = null;
    const scanning = variant({
      finalizeReview: ({ answerText, answerFile }) => {
        seen = { length: answerText.length, answerFile };
        const hit = /\[P1\] (.+) — (\S+):(\d+)/.exec(answerText);
        return { verdict: hit ? "changes" : "approve", findings: hit ? [{ severity: "MAJOR", file: hit[2], line: Number(hit[3]), title: hit[1], text: "" }] : [], coverage: { reviewed: [], unreviewed: [] }, incomplete: null };
      },
    });
    const answer = `${"x".repeat(32000)}\n[P1] Late finding — late.js:7\n`;
    const { job } = await run(s, { adapter: scanning, over: { verb: "review", reviewPrompt: "r", target: "--uncommitted", round: null }, env: { COUNCIL_NULL_OUTPUT: "answer-file", COUNCIL_FAKE_ANSWER: answer } });
    assert.equal(seen.length, answer.length, "the whole answer, not the 24 KiB preview");
    assert.equal(seen.answerFile, join(job.dir, "answer.md"));
    assert.equal(job.code, 10);
    assert.deepEqual(job.review.findings.map((f) => [f.file, f.line]), [["late.js", 7]]);
  } finally { s.done(); }
});

test("F5: a denied action on a review with a clean approval exits 10", async () => {
  const s = setup();
  try {
    const denying = variant({ parseEvent: (line, state) => (JSON.parse(line).type === "progress" ? { denied: "command(git push) refused" } : nullAdapter.parseEvent(line, state)) });
    const { job } = await run(s, { adapter: denying, over: { verb: "review", reviewPrompt: "r", target: "--uncommitted", round: null }, env: { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "30", COUNCIL_FAKE_REVIEW: "approve" } });
    assert.equal(job.verdict, "approve");
    assert.equal(job.code, 10);
    assert.equal(job.denied, "command(git push) refused");
  } finally { s.done(); }
});

test("F6: the implicit base is the default branch's own commit, never a same-named tag", () => {
  const base = mkdtempSync(join(tmpdir(), "council-s28-git-"));
  try {
    const dir = initRepo(join(base, "repo"));
    writeFileSync(join(dir, "f"), "1\n");
    const mainOid = commitAll(dir, "main");
    git(dir, ["checkout", "-q", "-b", "topic"]);
    writeFileSync(join(dir, "f"), "2\n");
    const topicOid = commitAll(dir, "topic");
    git(dir, ["tag", "main", topicOid]); // a tag named like the branch, at another commit
    assert.deepEqual(defaultBranch(dir), { ref: "main", qualified: "refs/heads/main", oid: mainOid });
    const target = reviewTarget(dir, {});
    assert.equal(target.kind, "base");
    assert.equal(target.oid, mainOid, "the branch, not the tag");
    assert.equal(target.base, mainOid);
    assert.deepEqual(target.flags, ["--base", "refs/heads/main"], "the native route gets the unambiguous ref");
    assert.match(target.label, /^branch against main \(/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("F7: on macOS a native binary carrying the job operand matches although a node launcher was recorded", () => {
  const job = { argv: ["/usr/local/bin/node", "/npm/lib/grok/bin/grok", "--prompt-file", "/jobs/p.md", "--model", "m"], childArgs: ["--prompt-file", "/jobs/p.md", "--model", "m"] };
  const row = { raw: "/vendor/grok/bin/grok --prompt-file /jobs/p.md --model m", argv: null };
  assert.equal(hasFlagOperand(row, "--prompt-file", "/jobs/p.md", job, "darwin", ["grok"]), true);
  assert.equal(hasFlagOperand(row, "--prompt-file", "/jobs/p.md", job, "darwin"), false, "without the provider binary name it is missed");
  assert.equal(hasFlagOperand({ raw: "/vendor/grok/bin/grok --prompt-file /jobs/other.md --model m" }, "--prompt-file", "/jobs/p.md", job, "darwin", ["grok"]), false);
  assert.equal(hasFlagOperand({ raw: "/usr/bin/evil --prompt-file /jobs/p.md --model m" }, "--prompt-file", "/jobs/p.md", job, "darwin", ["grok"]), false);
});

test("F8: the thread record is written before completion is published; a failed write publishes no success", async () => {
  const s = setup();
  try {
    const order = [];
    const ok = await run(s, { hooks: { saveThread: (home, rec) => { order.push(["thread", loadJob(home, rec.lastJob).done, inspectClaim(home, "null", rec.threadId).state]); } } });
    assert.equal(ok.job.code, 0);
    assert.deepEqual(order, [["thread", false, "owned"]], "written while the claim is held and before the done marker");
    const failed = await run(s, { hooks: { saveThread: () => { throw new Error("threads/ is read-only"); } } });
    assert.equal(failed.job.code, 1);
    assert.equal(failed.job.error, "finalization failed: threads/ is read-only");
    assert.equal(loadJob(s.home, failed.job.id).done, false, "no published result");
    assert.equal(inspectClaim(s.home, "null", failed.job.threadId).state, "owned", "the claim is kept for recovery");
  } finally { s.done(); }
});

test("F9: afterTurn without beforeTurn still runs once after a verified cleanup", async () => {
  const s = setup();
  try {
    const calls = [];
    const { job } = await run(s, { adapter: variant({ beforeTurn: undefined, afterTurn: (ctx, outcome) => calls.push([ctx.job.id, outcome.code, Boolean(ctx.env)]) }) });
    assert.deepEqual(calls, [[job.id, 0, true]]);
  } finally { s.done(); }
});

test("F10: reply inherits --web from the thread unless given explicitly", async () => {
  const s = setup();
  try {
    const ask = await entry(s, ["ask", "--to", "null", "--web", "--", "search"]);
    assert.equal(ask.code, 0, ask.err);
    assert.ok(s.spawns().at(-1).argv.includes("--web"));
    const thread = /thread=([0-9a-f-]{36})/.exec(ask.err)[1];
    assert.equal(loadThread(s.home, "null", thread).web, true);
    const reply = await entry(s, ["reply", "--last", "--", "more"]);
    assert.equal(reply.code, 0, reply.err);
    assert.ok(s.spawns().at(-1).argv.includes("--web"), "inherited");
    const off = await entry(s, ["reply", "--last", "--web=false", "--", "no web"]);
    assert.equal(off.code, 0, off.err);
    assert.ok(!s.spawns().at(-1).argv.includes("--web"), "an explicit value wins");
    assert.equal(loadThread(s.home, "null", thread).web, false, "and is persisted");
  } finally { s.done(); }
});

test("F11: buildTurn gets the caller's env and the resolved launcher; probe and checkRequest get env", async () => {
  const s = setup();
  try {
    let seen = null;
    const capturing = variant({ buildTurn: (request) => { seen = { env: request.env, launcher: request.launcher }; return nullAdapter.buildTurn(request); } });
    await run(s, { adapter: capturing, env: { COUNCIL_MARKER: "from-ctx" } });
    assert.equal(seen.env.COUNCIL_MARKER, "from-ctx");
    assert.equal(seen.launcher.kind, "node-script");
    assert.equal(process.env.COUNCIL_MARKER, undefined, "process.env untouched");
    const refused = await entry(s, ["ask", "--to", "null", "--web", "--", "x"], { env: { COUNCIL_NULL_NO_WEB: "1" } });
    assert.equal(refused.code, 2);
    assert.match(refused.err, /--web has no tested mapping for null/);
    const setupOut = await entry(s, ["setup", "--to", "null", "--json"], { env: { COUNCIL_NULL_CONSULT: "null-fast/low" } });
    assert.equal(JSON.parse(setupOut.out)[0].tiers.consult, "null-fast/low", "the tier seam reads the call's env");
  } finally { s.done(); }
});

test("F12: on win32 the first stop is the identity-checked taskkill at once; on POSIX the group stop never escalates", async () => {
  const s = setup();
  try {
    const real = executionController({ adapter: nullAdapter });
    const stops = [];
    let groups = 0;
    const win = { ...real, platform: "win32", stop: (row, t, sig) => { stops.push([Date.now(), sig]); return real.stop(row, t, sig); }, stopGroup: async () => { groups += 1; } };
    const started = Date.now();
    const { job } = await run(s, { hooks: { control: win, graceMs: 5000 }, options: { deadlineMs: 200 }, env: { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "30000" } });
    assert.equal(job.error, "wall-clock deadline passed");
    assert.equal(groups, 0, "no group signal on Windows");
    assert.ok(stops.length >= 1 && stops[0][1] === "SIGKILL" && stops[0][0] - started < 3000, "stopped at once, not after the 5 s grace");
    // POSIX: a stubborn group gets SIGTERM from stopGroup and nothing more
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    await sleep(300);
    const sent = [];
    const posix = executionController({ platform: "linux", kill: (pid, sig) => { if (sig !== 0) sent.push(sig); return process.kill(pid, sig); } });
    const r = await posix.stopGroup(child.pid);
    assert.deepEqual(r, { attempted: true, delivered: true, escalated: false });
    await sleep(200);
    assert.deepEqual(sent, ["SIGTERM"], "the SIGKILL escalation belongs to the identity-checked stop only");
    process.kill(child.pid, "SIGKILL");
  } finally { s.done(); }
});

test("F13: review refuses --rounds and --web; wait and cancel check --to", async () => {
  const s = setup();
  try {
    const repo = initRepo(join(s.root, "repo"));
    writeFileSync(join(repo, "a"), "1\n"); commitAll(repo, "a"); writeFileSync(join(repo, "a"), "2\n");
    for (const [flag, re] of [["--rounds", /--rounds does not apply to review/], ["--web", /--web does not apply to review/]]) {
      const argv = flag === "--rounds" ? ["review", "--to", "null", "--rounds", "3"] : ["review", "--to", "null", "--web"];
      let out = "", err = "";
      const stdin = new PassThrough(); stdin.end("");
      const code = await main(argv, { ...s.env, COUNCIL_TEST_NULL_ADAPTER: "1", COUNCIL_HOME: s.home }, { stdout: { write: (x) => { out += x; } }, stderr: { write: (x) => { err += x; } }, stdin, cwd: repo });
      assert.equal(code, 2, flag);
      assert.match(err, re);
    }
    for (const verb of ["wait", "cancel"]) {
      const r = await entry(s, [verb, "--to", "bard"]);
      assert.equal(r.code, 2, verb);
      assert.match(r.err, /--to must be one of codex, gemini, grok/);
    }
  } finally { s.done(); }
});

test("F14: a retry with longer timers replays instead of exiting 2", async () => {
  const s = setup();
  try {
    const first = await entry(s, ["ask", "--to", "null", "--request-id", "timers", "--deadline", "100", "--", "hi"]);
    assert.equal(first.code, 0, first.err);
    const retry = await entry(s, ["ask", "--to", "null", "--request-id", "timers", "--deadline", "900", "--inactivity-timeout", "50", "--", "hi"]);
    assert.equal(retry.code, 0, retry.err);
    assert.match(retry.err, /replay=timers/);
    assert.equal(s.spawns().length, 1);
  } finally { s.done(); }
});

test("A3: ownership without the provider's ownsProcess is unknown, never gone", () => {
  const rows = [{ pid: 4242, ppid: 1, stamp: "1", raw: "codex exec -o /j/answer.md", argv: ["codex", "exec", "-o", "/j/answer.md"], name: "codex" }];
  const r = ownedExecution({ id: "job1", pid: 4242, argv: ["codex", "exec", "-o", "/j/answer.md"], execution: [] }, { state: "ok", rows }, "linux", [], null);
  assert.equal(r.state, "unknown");
  assert.match(r.error, /cannot be checked without its provider module/);
});

test("A5: flags may precede the reply id, on argv and in the heredoc", async () => {
  const s = setup();
  try {
    const ask = await entry(s, ["ask", "--to", "null", "--", "start"]);
    const job = /job=([a-z0-9]{16})/.exec(ask.err)[1];
    const argvForm = await entry(s, ["reply", "--json", job, "--", "follow up"]);
    assert.equal(argvForm.code, 0, argvForm.err);
    assert.equal(JSON.parse(argvForm.out).round, 2);
    assert.match(s.spawns().at(-1).prompt, /\n\nfollow up$/);
    const heredoc = await entry(s, ["reply"], { stdin: `--json ${job} follow up again\n` });
    assert.equal(heredoc.code, 0, heredoc.err);
    assert.equal(JSON.parse(heredoc.out).round, 3);
    assert.match(s.spawns().at(-1).prompt, /\n\nfollow up again$/);
  } finally { s.done(); }
});
