// S2.6: the entry, through main() with a temporary COUNCIL_HOME and the null adapter. Also the
// main()-level cases deferred from S2.3 and S2.4: tombstone replay without a spawn, concurrent
// identical requests, `reply --last --request-id` recovery, changed input → 2, `wait --timeout` → 20,
// deadline and inactivity through argv, and the depth guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { BINARIES, adapterFile, fingerprint, main, providerNames } from "../plugins/council/scripts/council.mjs";
import { GUARD_VARS } from "../plugins/council/scripts/lib/core/execution.mjs";
import { loadJob, loadThread, requestJobId, requestReserved } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { canonical } from "../plugins/council/scripts/lib/core/fs.mjs";
import { commitAll, git, initRepo, isolateGit } from "./fixtures/build-repos.mjs";

isolateGit();
/** Providers whose module is not in this build; the S3–S5 branches each add one (registry by existsSync). */
const UNBUILT = ["codex", "gemini", "grok"].filter((p) => !existsSync(adapterFile(p, {})));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const FAKE_BINS = { COUNCIL_CODEX_BIN: fixture("fake-codex.mjs"), COUNCIL_AGY_BIN: fixture("fake-agy.mjs"), COUNCIL_GROK_BIN: fixture("fake-grok.mjs") };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function harness() {
  const root = mkdtempSync(join(tmpdir(), "council-entry-"));
  const home = join(root, "home");
  const cwd = join(root, "work");
  mkdirSync(cwd);
  const log = join(root, "spawns.log");
  writeFileSync(log, "");
  // A provider module that exists in this build (S3–S5) is probed through its fake, never the real CLI.
  const base = { ...process.env, CLAUDE_CODE_SESSION_ID: "", COUNCIL_TEST_NULL_ADAPTER: "1", COUNCIL_HOME: home, COUNCIL_FAKE_SPAWN_LOG: log, COUNCIL_STDIN_DEADLINE_MS: "300", ...FAKE_BINS };
  for (const g of GUARD_VARS) delete base[g];
  for (const k of ["COUNCIL_FAKE_SCENARIO", "COUNCIL_NULL_ID", "COUNCIL_NULL_INPUT", "COUNCIL_NULL_OUTPUT", "COUNCIL_NULL_CONSULT", "COUNCIL_NULL_NO_WEB"]) delete base[k];
  /** Runs main() in-process; resolves {code, out, err}. `stdin`: a string (ended) or a stream. */
  const call = async (argv, { stdin = "", env = {}, at = cwd, hooks = {} } = {}) => {
    let out = "", err = "";
    const stream = typeof stdin === "string" ? Object.assign(new PassThrough(), {}) : stdin;
    if (typeof stdin === "string") stream.end(stdin);
    const code = await main(argv, { ...base, ...env }, { stdout: { write: (s) => { out += s; return true; } }, stderr: { write: (s) => { err += s; return true; } }, stdin: stream, cwd: at }, hooks);
    return { code, out, err };
  };
  /** Starts main() without awaiting it; `.err()` reads its stderr so far. */
  const start = (argv, opts = {}) => {
    let err = "";
    const stream = new PassThrough(); stream.end(opts.stdin ?? "");
    let out = "";
    const promise = main(argv, { ...base, ...(opts.env ?? {}) }, { stdout: { write: (s) => { out += s; return true; } }, stderr: { write: (s) => { err += s; return true; } }, stdin: stream, cwd: opts.at ?? cwd });
    return { promise: promise.then((code) => ({ code, out, err })), err: () => err };
  };
  const spawns = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const jobs = () => { try { return readdirSync(join(home, "jobs")).filter((n) => /^[a-z0-9]{16}$/.test(n)); } catch { return []; } };
  const jobOf = (text) => /job[= ]([a-z0-9]{16})/.exec(text)?.[1];
  return { root, home, cwd, base, call, start, spawns, jobs, jobOf, done: () => rmSync(root, { recursive: true, force: true }) };
}
const CONTRACT = readFileSync(new URL("../plugins/council/contract.md", import.meta.url), "utf8").trim();
const footerRe = (status = "ok") => new RegExp(`^council null ${status} · job [a-z0-9]{16} · `, "m");

test("ask --to null -- hi: start line on stderr, answer and footer on stdout, exit 0", async () => {
  const h = harness();
  try {
    const r = await h.call(["ask", "--to", "null", "--session", "s1", "--", "hi"]);
    assert.equal(r.code, 0, r.err);
    const job = h.jobOf(r.err);
    assert.match(r.err, new RegExp(`^\\[council\\] provider=null job=${job}\\n$`));
    assert.equal(r.out, `pong for job ${job}\n${r.out.split("\n")[1]}\n`);
    assert.match(r.out, new RegExp(`^council null ok · job ${job} · null-model/high · \\d+s · round 1/9$`, "m"));
    const [spawn] = h.spawns();
    assert.equal(spawn.prompt, `${CONTRACT}\n\nInstructions for this turn (advice, read-only): inspect and answer; do not edit files or perform external writes.\n\nhi`, "contract prepended, text after --");
    assert.deepEqual(spawn.guards, GUARD_VARS, "the child carries all four guard variables");
    assert.equal(spawn.cwd, canonical(h.cwd));
    const record = loadJob(canonical(h.home), job);
    assert.equal(record.session, "s1");
    assert.equal(record.provider, "null");
  } finally { h.done(); }
});

test("--json: no start line; the A3.4 object carries provider, session and the rest", async () => {
  const h = harness();
  try {
    const r = await h.call(["ask", "--to", "null", "--session", "s1", "--json", "--effort", "low", "--", "hi"]);
    assert.equal(r.code, 0);
    assert.equal(r.err, "");
    const j = JSON.parse(r.out);
    assert.equal(j.provider, "null"); assert.equal(j.session, "s1"); assert.equal(j.effort, "low"); assert.equal(j.requestedEffort, "low");
    assert.equal(j.tier, "consult"); assert.equal(j.round, 1); assert.equal(j.rounds, 9); assert.equal(j.exit, 0); assert.equal(j.modelVerified, true);
    assert.match(j.answerFile, /answer\.md$/); assert.equal(j.answer, `pong for job ${j.job}`);
    const bad = await h.call(["ask", "--json", "--", "x"]);
    assert.equal(bad.code, 2);
    assert.deepEqual(JSON.parse(bad.out), { status: "failed", exit: 2, error: "ask needs --to codex|gemini|grok" });
  } finally { h.done(); }
});

test("provider selection: --to is required, checked, and a provider outside this build exits 2 before any job", async () => {
  const h = harness();
  try {
    for (const [argv, re] of [
      [["ask", "--", "x"], /ask needs --to codex\|gemini\|grok/],
      [["review"], /review needs --to/],
      [["task", "--", "x"], /task needs --to/],
      [["ask", "--to", "bard", "--", "x"], /--to must be one of codex, gemini, grok/],
      ...UNBUILT.map((p) => [["ask", "--to", p, "--", "x"], new RegExp(`provider ${p} not available in this build`)]),
      [["ask", "--to", "null", "--thread", "abc", "--", "x"], /ask starts a new thread; continue one with reply --thread/],
      [["ask", "--to", "null", "--last", "--", "x"], /--last applies to reply/],
      [["ask", "--to", "null", "--commit", "HEAD", "--", "x"], /--commit applies to review/],
      [["reply", "--to", "null", "--uncommitted", "--last", "--", "x"], /--uncommitted applies to review/],
      [["ask", "--to", "null", "--refresh", "--", "x"], /--refresh applies to models/],
      [["ask", "--to", "null", "--tier", "turbo", "--", "x"], /--tier must be one of consult, exec, deep/],
      [["ask", "--to", "null", "--rounds", "0", "--", "x"], /--rounds needs a positive integer/],
      [["ask", "--to", "null", "--deadline", "-1", "--", "x"], /--deadline needs a finite positive number/],
      [["ask", "--to", "null", "--effort", "ultra", "--", "x"], /--effort must be one of low, medium, high, xhigh, max/],
      [["ask", "--to", "null", "--request-id", "bad id", "--", "x"], /--request-id needs 1 to 128/],
      [["ask", "--to", "null"], /stdin stayed open|ask needs text/],
      [["frobnicate"], /^council: usage: council <ask\|reply\|review\|task\|wait\|cancel\|models\|setup>/],
      [[], /usage: council/],
    ]) {
      const r = await h.call(argv);
      assert.equal(r.code, 2, `${argv.join(" ")}: ${r.err}`);
      assert.match(r.err, re, argv.join(" "));
    }
    assert.deepEqual(h.jobs(), [], "no job record for any refused call");
    assert.equal(h.spawns().length, 0);
    const plain = await h.call(["ask", "--to", "null", "--", "x"], { env: { COUNCIL_TEST_NULL_ADAPTER: "" } });
    assert.equal(plain.code, 2);
    assert.match(plain.err, /--to must be one of codex, gemini, grok/, "the null adapter exists only in test mode");
    assert.deepEqual(providerNames({}), ["codex", "gemini", "grok"]);
    assert.deepEqual(providerNames({ COUNCIL_TEST_NULL_ADAPTER: "1" }), ["codex", "gemini", "grok", "null", "null2"]);
  } finally { h.done(); }
});

test("slash-command form: leading options parsed out of the heredoc text; a literal -- keeps the rest", async () => {
  const h = harness();
  try {
    const r = await h.call(["ask", "--session", "s1"], { stdin: "--to null --effort low What about --flags inside?\nSecond line.\n" });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, / · null-model\/low · /);
    assert.equal(h.spawns()[0].prompt, `${CONTRACT}\n\nInstructions for this turn (advice, read-only): inspect and answer; do not edit files or perform external writes.\n\nWhat about --flags inside?\nSecond line.`);
    const lit = await h.call(["ask", "--session", "s1"], { stdin: "--to null --\n--effort max is text here\nCOUNCIL_EOF too\n" });
    assert.equal(lit.code, 0, lit.err);
    assert.match(lit.out, / · null-model\/high · /, "--effort after -- was not parsed");
    assert.equal(h.spawns()[1].prompt, `${CONTRACT}\n\nInstructions for this turn (advice, read-only): inspect and answer; do not edit files or perform external writes.\n\n--effort max is text here\nCOUNCIL_EOF too`);
    const both = await h.call(["ask", "--to", "null", "args"], { stdin: "and stdin" });
    assert.equal(both.code, 2);
    assert.match(both.err, /stdin or as arguments, not both/);
    const open = new PassThrough();
    const silent = await h.call(["ask", "--to", "null"], { stdin: open });
    assert.equal(silent.code, 2);
    assert.match(silent.err, /stdin stayed open for 0.3 s with no input/);
    const partial = new PassThrough(); partial.write("--to null half");
    const stuck = await h.call(["ask"], { stdin: partial });
    assert.equal(stuck.code, 2);
    assert.match(stuck.err, /stdin sent nothing for 0.3 s before its end/);
  } finally { h.done(); }
});

test("model, effort and tier resolution through the catalog: aliases, clamps, unverified ids, tiers", async () => {
  const h = harness();
  try {
    const clamp = await h.call(["ask", "--to", "null", "--model", "fast", "--effort", "xhigh", "--", "x"]);
    assert.equal(clamp.code, 0, clamp.err);
    assert.match(clamp.out, / · null-fast\/medium<=xhigh · /, "alias resolved, effort clamped down, clamp shown");
    const unknown = await h.call(["ask", "--to", "null", "--model", "null-mystery", "--effort", "max", "--", "x"]);
    assert.equal(unknown.code, 0, unknown.err);
    assert.match(unknown.out, / · null-mystery\/max · .* · model unverified(?: · |\n|$)/);
    const deep = await h.call(["ask", "--to", "null", "--tier", "deep", "--json", "--", "x"]);
    assert.deepEqual([JSON.parse(deep.out).model, JSON.parse(deep.out).effort, JSON.parse(deep.out).tier], ["null-model", "xhigh", "deep"]);
    const task = await h.call(["task", "--to", "null", "--json", "--", "edit it"]);
    const tj = JSON.parse(task.out);
    assert.deepEqual([tj.tier, tj.model, tj.effort, tj.round], ["exec", "null-fast", "medium", 1], "task defaults to the exec tier");
    assert.ok(h.spawns().at(-1).argv.includes("--write"), "task is the only edit mode");
    assert.deepEqual(tj.edited, []);
  } finally { h.done(); }
});

test("--input-file stands in for stdin on argv only: read with its flags, no part of the request, refused inside the input", async () => {
  const h = harness();
  try {
    const file = join(h.root, "input.txt");
    writeFileSync(file, "\uFEFF--to null --request-id same1 hello from a file\n");
    const first = await h.call(["ask", "--session", "s1", `--input-file=${file}`], { stdin: "ignored" });
    assert.equal(first.code, 0, first.err + first.out);
    assert.match(first.out, /fake|hello|pong/i);
    const other = join(h.root, "other.txt");
    writeFileSync(other, "--to null --request-id same1 hello from a file\n");
    const replay = await h.call(["ask", "--session", "s1", "--input-file", other]);
    assert.equal(replay.out, first.out, "another file with the same text is the same request");
    writeFileSync(file, `--to null --input-file ${other} hi`);
    assert.equal((await h.call(["ask", "--session", "s1", "--input-file", file])).code, 2, "inside the input");
    assert.equal((await h.call(["cancel", "--session", "s1"], { stdin: `--input-file ${other}` })).code, 2, "inside a control verb's input");
    assert.equal((await h.call(["ask", "--session", "s1", "--input-file", join(h.root, "missing.txt")])).code, 2);
  } finally { h.done(); }
});

test("reply: by first word, --thread and --last; rounds count, inheritance, explicit overrides persist", async () => {
  const h = harness();
  try {
    const ask = await h.call(["ask", "--to", "null", "--session", "s1", "--effort", "low", "--", "first"]);
    const askJob = h.jobOf(ask.err);
    const thread = JSON.parse((await h.call(["wait", /job[= ]([a-z0-9]{16})/.exec(ask.err)[1], "--json"])).out).thread;
    const r1 = await h.call(["reply", "--session", "s1", "--", `${askJob} second`]);
    assert.equal(r1.code, 0, r1.err);
    assert.match(r1.out, / · null-model\/low · \d+s · round 2\/9(?: · |\n|$)/, "model and effort inherited from the thread");
    assert.equal(h.spawns().at(-1).prompt, `${CONTRACT}\n\nInstructions for this turn (advice, read-only): inspect and answer; do not edit files or perform external writes.\n\nsecond`);
    assert.ok(h.spawns().at(-1).argv.includes(thread), "the native thread is resumed");
    const r2 = await h.call(["reply", "--session", "s1", "--last", "--effort", "medium", "--", "third"]);
    assert.match(r2.out, / · null-model\/medium · \d+s · round 3\/9(?: · |\n|$)/, "explicit effort wins for this turn");
    const r3 = await h.call(["reply", "--session", "s1", "--thread", thread, "--", "fourth"]);
    assert.match(r3.out, / · null-model\/medium · \d+s · round 4\/9(?: · |\n|$)/, "and is persisted on the thread");
    const r4 = await h.call(["reply", "--session", "s1", "--last", "--tier", "consult", "--", "fifth"]);
    assert.match(r4.out, / · null-model\/high · \d+s · round 5\/9(?: · |\n|$)/, "--tier consult can lower or raise a thread's effort deliberately");
    const record = loadThread(canonical(h.home), "null", thread);
    assert.equal(record.round, 5); assert.equal(record.effort, "high"); assert.equal(record.tier, "consult");
    const rounds = await h.call(["reply", "--session", "s1", "--last", "--rounds", "3", "--", "sixth"]);
    assert.match(rounds.out, / · round 6\/3(?: · |\n|$)/);
    const after = await h.call(["reply", "--session", "s1", "--last", "--", "seventh"]);
    assert.match(after.out, / · round 7\/3(?: · |\n|$)/, "a budget set with --rounds is inherited");
    const conflict = await h.call(["reply", "--session", "s1", "--last", "--to", "codex", "--", "x"]);
    assert.equal(conflict.code, 2);
    assert.match(conflict.err, new RegExp(`thread ${thread} belongs to null; --to codex conflicts`));
    const noText = await h.call(["reply", "--session", "s1", "--last"], { stdin: "" });
    assert.equal(noText.code, 2);
    assert.match(noText.err, /reply needs text/);
  } finally { h.done(); }
});

test("reply --last is scoped to this session and this workspace; named jobs resolve across sessions; threads never move workspaces", async () => {
  const h = harness();
  try {
    const ask = await h.call(["ask", "--to", "null", "--session", "s1", "--", "first"]);
    const job = h.jobOf(ask.err);
    const other = await h.call(["reply", "--session", "s2", "--last", "--", "x"]);
    assert.equal(other.code, 2);
    assert.match(other.err, /no earlier thread in this session and workspace/);
    const none = await h.call(["reply", "--last", "--", "x"]);
    assert.equal(none.code, 2, "no session is its own scope");
    mkdirSync(join(h.root, "elsewhere"));
    const elsewhere = await h.call(["reply", "--session", "s1", "--last", "--", "x"], { at: join(h.root, "elsewhere") });
    assert.equal(elsewhere.code, 2);
    const named = await h.call(["reply", "--session", "s2", "--thread", job, "--", "x"]);
    assert.equal(named.code, 0, named.err);
    const moved = await h.call(["reply", "--session", "s1", "--thread", job, "--", "x"], { at: join(h.root, "elsewhere") });
    assert.equal(moved.code, 2);
    assert.match(moved.err, /belongs to workspace .*; a thread is never adopted across workspaces/);
    const missing = await h.call(["reply", "--thread", "nosuchthread", "--", "x"]);
    assert.equal(missing.code, 2);
    assert.match(missing.err, /no job or thread nosuchthread/);
  } finally { h.done(); }
});

test("task then reply: reply stays read-only after a task; task --thread resumes with edits", async () => {
  const h = harness();
  try {
    const ask = await h.call(["ask", "--to", "null", "--session", "s1", "--", "plan"]);
    const job = h.jobOf(ask.err);
    const task = await h.call(["task", "--session", "s1", "--thread", job, "--", "do it"]);
    assert.equal(task.code, 0, task.err);
    assert.match(task.out, / · round 2\/9 · edited 0(?: · |\n|$)/);
    assert.ok(h.spawns().at(-1).argv.includes("--write"));
    const reply = await h.call(["reply", "--session", "s1", "--last", "--", "check"]);
    assert.equal(reply.code, 0, reply.err);
    assert.ok(!h.spawns().at(-1).argv.includes("--write"), "reply after a task is read-only");
    assert.match(reply.out, / · round 3\/9(?: · |\n|$)/);
    const task2 = await h.call(["task", "--session", "s1", "--thread", h.jobOf(reply.err), "--to", "null", "--", "again"]);
    assert.match(task2.out, / · round 4\/9 · edited 0(?: · |\n|$)/);
    const lastTask = await h.call(["task", "--session", "s1", "--last", "--", "x"]);
    assert.equal(lastTask.code, 2);
  } finally { h.done(); }
});

test("request id: a tombstone replays the first result without spawning; changed input exits 2; an expired body is reported", async () => {
  const h = harness();
  try {
    const first = await h.call(["ask", "--to", "null", "--session", "s1", "--request-id", "req-1", "--", "hello"]);
    assert.equal(first.code, 0, first.err);
    const job = h.jobOf(first.err);
    assert.equal(job, requestJobId("null", "s1", canonical(h.cwd), "req-1"), "the job id is the A7.3 claim key");
    assert.equal(h.spawns().length, 1);
    const again = await h.call(["ask", "--to", "null", "--session", "s1", "--request-id", "req-1", "--", "hello"]);
    assert.equal(again.code, 0);
    assert.equal(h.spawns().length, 1, "no second child");
    assert.equal(again.out, first.out.replace(/ · \d+s · /, again.out.match(/ · \d+s · /)[0]), "the first result, printed again");
    assert.match(again.err, new RegExp(`job=${job} .*replay=req-1`));
    const json = await h.call(["ask", "--to", "null", "--session", "s1", "--request-id", "req-1", "--json", "--", "hello"]);
    assert.equal(JSON.parse(json.out).job, job, "--json does not change the request");
    const changed = await h.call(["ask", "--to", "null", "--session", "s1", "--request-id", "req-1", "--", "different"]);
    assert.equal(changed.code, 2);
    assert.match(changed.err, /request id req-1 was already used with different input; use a new request id/);
    const changedFlag = await h.call(["ask", "--to", "null", "--session", "s1", "--request-id", "req-1", "--effort", "low", "--", "hello"]);
    assert.equal(changedFlag.code, 2);
    const otherSession = await h.call(["ask", "--to", "null", "--session", "s2", "--request-id", "req-1", "--", "hello"]);
    assert.equal(otherSession.code, 0, "the claim key includes the session");
    assert.equal(h.spawns().length, 2);
    rmSync(join(h.home, "jobs", job), { recursive: true, force: true });
    const expired = await h.call(["ask", "--to", "null", "--session", "s1", "--request-id", "req-1", "--", "hello"]);
    assert.equal(expired.code, 1);
    assert.match(expired.out, new RegExp(`^result expired · null · job ${job} · its body was pruned; nothing was started again`));
    assert.equal(h.spawns().length, 2, "never a second CLI");
    const expiredJson = await h.call(["ask", "--to", "null", "--session", "s1", "--request-id", "req-1", "--json", "--", "hello"]);
    assert.deepEqual(JSON.parse(expiredJson.out), { provider: "null", job, status: "expired", exit: 1, thread: null, error: "result expired" });
  } finally { h.done(); }
});

test("request id: two concurrent identical requests spawn one child and print the same job", async () => {
  const h = harness();
  try {
    const argv = ["ask", "--to", "null", "--session", "s1", "--request-id", "twin", "--", "hello"];
    const env = { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "600" };
    const [a, b] = await Promise.all([h.call(argv, { env }), h.call(argv, { env })]);
    assert.equal(a.code, 0, a.err); assert.equal(b.code, 0, b.err);
    assert.equal(h.spawns().length, 1);
    assert.equal(h.jobOf(a.out), h.jobOf(b.out));
    assert.match(a.out + b.out, /pong for job/);
  } finally { h.done(); }
});

test("request id: a claim released when preparation fails, so the same id may run again", async () => {
  const h = harness();
  try {
    const id = requestJobId("null", "s1", canonical(h.cwd), "prep");
    const fail = await h.call(["ask", "--to", "null", "--session", "s1", "--request-id", "prep", "--model", "fast", "--effort", "bogus", "--", "x"]);
    assert.equal(fail.code, 2);
    assert.equal(requestReserved(canonical(h.home), id), false, "released");
    const web = await h.call(["ask", "--to", "null", "--session", "s1", "--request-id", "prep", "--web", "--", "x"], { env: { COUNCIL_NULL_NO_WEB: "1" } });
    assert.equal(web.code, 2);
    assert.match(web.err, /--web has no tested mapping for null/, "an adapter's checkRequest refuses before any job");
    assert.equal(requestReserved(canonical(h.home), id), false);
    assert.deepEqual(h.jobs(), []);
    const ok = await h.call(["ask", "--to", "null", "--session", "s1", "--request-id", "prep", "--web", "--", "x"]);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(h.jobOf(ok.err), id);
  } finally { h.done(); }
});

test("request id: reply --last replay recovers the original provider and job after another provider's job became the latest, or the tiers and catalog changed", async () => {
  const h = harness();
  try {
    const a = await h.call(["ask", "--to", "null", "--session", "s1", "--", "thread A"]);
    const threadA = JSON.parse((await h.call(["wait", /job[= ]([a-z0-9]{16})/.exec(a.err)[1], "--json"])).out).thread;
    const r = await h.call(["reply", "--session", "s1", "--last", "--request-id", "r-last", "--", "follow-up"]);
    assert.equal(r.code, 0, r.err);
    const replyJob = h.jobOf(r.err);
    assert.match(r.err, new RegExp(`provider=null job=${replyJob}`));
    const b = await h.call(["ask", "--to", "null2", "--session", "s1", "--", "thread B on another provider"]);
    assert.match(b.err, /provider=null2 /);
    mkdirSync(join(h.home, "catalog"), { recursive: true });
    writeFileSync(join(h.home, "catalog", "null.json"), JSON.stringify({ updatedAt: "2026-11-01T00:00:00Z", models: { "null-model": [] } }));
    const spawned = h.spawns().length;
    const replay = await h.call(["reply", "--session", "s1", "--last", "--request-id", "r-last", "--", "follow-up"], { env: { COUNCIL_NULL_CONSULT: "null-fast/low" } });
    assert.equal(replay.code, 0, replay.err);
    assert.equal(h.jobOf(replay.out), replyJob, "the original null job, not one on null2's thread");
    assert.match(replay.out, /^council null ok · .* · null-model\/high · /m, "the original provider and resolution, not the changed tiers or catalog");
    assert.equal(h.spawns().length, spawned, "nothing spawned");
    // S2.8 F3: changed input under the same id never claims a second job under the newly latest provider
    const changed = await h.call(["reply", "--session", "s1", "--last", "--request-id", "r-last", "--", "different follow-up"]);
    assert.equal(changed.code, 2);
    assert.match(changed.err, /request id r-last was already used with different input; use a new request id/);
    assert.equal(h.spawns().length, spawned, "no second child");
    const otherProvider = await h.call(["ask", "--to", "null2", "--session", "s1", "--request-id", "r-last", "--", "follow-up"]);
    assert.equal(otherProvider.code, 2, "the id is bound to null for this session and workspace");
    assert.equal(h.jobs().filter((j) => j === replyJob).length, 1);
  } finally { h.done(); }
});

test("wait: --timeout returns 20 while the job runs and the job continues; bare wait lists this session's jobs", async () => {
  const h = harness();
  try {
    const run = h.start(["ask", "--to", "null", "--session", "s1", "--", "slow one"], { env: { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "1200" } });
    let job;
    for (const until = Date.now() + 5000; !(job = h.jobOf(run.err())); await sleep(20)) assert.ok(Date.now() < until, "never announced");
    const waiting = await h.call(["wait", job, "--timeout", "0.2"]);
    assert.equal(waiting.code, 20);
    assert.match(waiting.out, new RegExp(`^still running · null · job ${job} · \\d+s · last event: `));
    const stdinArgs = await h.call(["wait", "--json"], { stdin: `${job} --timeout 0.1\n` });
    assert.equal(stdinArgs.code, 20, "control arguments on stdin");
    assert.equal(JSON.parse(stdinArgs.out).status, "running");
    const finished = await run.promise;
    assert.equal(finished.code, 0, finished.err);
    const done = await h.call(["wait", job]);
    assert.equal(done.code, 0);
    assert.match(done.out, new RegExp(`^pong for job ${job}\\ncouncil null ok · job ${job}`));
    const list = await h.call(["wait", "--session", "s1"]);
    assert.match(list.out, new RegExp(`^${job} · null · done · `));
    const empty = await h.call(["wait", "--session", "nobody"]);
    assert.equal(empty.out, "no council jobs in this workspace/session\n");
    const missing = await h.call(["wait", "nosuchjob"]);
    assert.equal(missing.code, 2);
    const both = await h.call(["wait", "a"], { stdin: "b" });
    assert.equal(both.code, 2);
    assert.match(both.err, /on stdin or argv, not both/);
  } finally { h.done(); }
});

test("--deadline and --inactivity-timeout through argv stop the child and exit 1", async () => {
  const h = harness();
  try {
    const env = { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "30000" };
    const deadline = await h.call(["ask", "--to", "null", "--deadline", "0.5", "--", "x"], { env });
    assert.equal(deadline.code, 1);
    assert.match(deadline.out, new RegExp(`${footerRe("failed").source}.* · error: wall-clock deadline passed · next: reply [a-z0-9]{16}$`, "m"), "the thread stays resumable after a confirmed stop (codex-plugin-cc footer)");
    const idle = await h.call(["ask", "--to", "null", "--inactivity-timeout", "0.5", "--", "x"], { env });
    assert.equal(idle.code, 1);
    assert.match(idle.out, /error: null printed nothing before the inactivity deadline/);
    const crash = await h.call(["ask", "--to", "null", "--", "x"], { env: { COUNCIL_FAKE_SCENARIO: "exit-nonzero" } });
    assert.equal(crash.code, 1);
    assert.match(crash.out, footerRe("failed"));
    const latched = await h.call(["ask", "--to", "null", "--", "x"], { env: { COUNCIL_FAKE_SCENARIO: "fail-then-success" } });
    assert.equal(latched.code, 1);
    assert.match(latched.out, /error: simulated fatal before a later success/);
  } finally { h.done(); }
});

test("depth guard: any of the four variables refuses the call before anything runs, also under --json", async () => {
  const h = harness();
  try {
    for (const name of GUARD_VARS) {
      const r = await h.call(["ask", "--to", "null", "--", "x"], { env: { [name]: "1" } });
      assert.equal(r.code, 2, name);
      assert.match(r.err, new RegExp(`refusing a nested call: .*\\(${name} is set\\)`));
      const w = await h.call(["wait"], { env: { [name]: "1" } });
      assert.equal(w.code, 2, `${name} also refuses control verbs`);
    }
    const json = await h.call(["ask", "--to", "null", "--json", "--", "x"], { env: { COUNCIL_DEPTH: "1" } });
    assert.equal(JSON.parse(json.out).exit, 2);
    assert.deepEqual(h.jobs(), []);
    assert.equal(h.spawns().length, 0);
  } finally { h.done(); }
});

test("cancel: a running job through the entry (owner live), a finished job, and nothing to cancel", async () => {
  const h = harness();
  try {
    const nothing = await h.call(["cancel", "--session", "s1"]);
    assert.equal(nothing.code, 0);
    assert.equal(nothing.out, "no running council job to cancel\n");
    const run = h.start(["ask", "--to", "null", "--session", "s1", "--", "slow"], { env: { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "30000" } });
    let job;
    for (const until = Date.now() + 5000; !(job = h.jobOf(run.err())); await sleep(20)) assert.ok(Date.now() < until);
    for (const until = Date.now() + 5000; !loadJob(canonical(h.home), job)?.pid; await sleep(20)) assert.ok(Date.now() < until);
    const cancel = await h.call(["cancel", job, "--timeout", "10"]);
    assert.equal(cancel.code, 0, cancel.out + cancel.err);
    assert.match(cancel.out, new RegExp(`^cancelled · null · job ${job}`));
    const finished = await run.promise;
    assert.equal(finished.code, 1);
    assert.match(finished.out, footerRe("cancelled"));
    const again = await h.call(["cancel", job]);
    assert.equal(again.code, 0);
    assert.match(again.out, /^cancelled · null · job /, "a finalized cancellation reports cancelled");
    const ok = await h.call(["ask", "--to", "null", "--session", "s1", "--", "quick"]);
    const done = await h.call(["cancel", h.jobOf(ok.err), "--json"]);
    assert.equal(JSON.parse(done.out).status, "finished");
    const missing = await h.call(["cancel", "nosuchjob"]);
    assert.equal(missing.code, 2);
  } finally { h.done(); }
});

test("a busy thread exits 1 without a second child on it", async () => {
  const h = harness();
  try {
    const ask = await h.call(["ask", "--to", "null", "--session", "s1", "--", "start"]);
    const job = h.jobOf(ask.err);
    const slow = h.start(["reply", "--session", "s1", "--thread", job, "--", "long"], { env: { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "1500" } });
    for (const until = Date.now() + 5000; !h.jobOf(slow.err()); await sleep(20)) assert.ok(Date.now() < until);
    const busy = await h.call(["reply", "--session", "s1", "--thread", job, "--", "meanwhile"]);
    assert.equal(busy.code, 1);
    assert.match(busy.out, /error: thread [0-9a-f-]{36} is busy as job [a-z0-9]{16}; wait or cancel/);
    // Counted once the slow reply has finished: its child logs itself only after reading stdin,
    // which can trail the job id under load.
    assert.equal((await slow.promise).code, 0);
    assert.equal(h.spawns().length, 2, "ask and the slow reply only");
  } finally { h.done(); }
});

test("review through the entry: target, collected prompt, exit 0/10, unreviewed coverage, adversarial template, refusals", async () => {
  const h = harness();
  try {
    const repo = initRepo(join(h.root, "repo"));
    writeFileSync(join(repo, "calc.js"), "export const sum = (a) => a.reduce((x, y) => x + y, 0);\n");
    commitAll(repo, "calc");
    writeFileSync(join(repo, "calc.js"), "export const sum = (a) => a.reduce((x, y) => x + y, 1);\n");
    const approve = await h.call(["review", "--to", "null", "--uncommitted"], { at: repo, env: { COUNCIL_FAKE_REVIEW: "approve" } });
    assert.equal(approve.code, 0, approve.err);
    assert.match(approve.err, /target=working tree \(staged, unstaged and untracked\)/);
    assert.match(approve.out, /^Verdict: approve\. Looks correct\.\ncouncil null ok · job [a-z0-9]{16} · null-model\/high · \d+s$/m, "no round, no next: reply on a review");
    const prompt = h.spawns().at(-1).prompt;
    assert.match(prompt, /You are performing a structured code review/);
    assert.match(prompt, /User focus: none given/);
    assert.match(prompt, /^\+export const sum = \(a\) => a\.reduce\(\(x, y\) => x \+ y, 1\);$/m);
    assert.ok(!prompt.includes(CONTRACT), "reviews carry the template, not the discussion contract");
    const findings = await h.call(["review", "--to", "null", "--adversarial", "--", "focus on the seed"], { at: repo, env: { COUNCIL_FAKE_REVIEW: "findings" } });
    assert.equal(findings.code, 10, findings.err);
    assert.match(findings.out, /^F1 BLOCKER calc\.js:3: Off-by-one$/m);
    assert.match(findings.out, footerRe("needs attention"));
    assert.match(h.spawns().at(-1).prompt, /adversarial software review/);
    assert.match(h.spawns().at(-1).prompt, /User focus: focus on the seed/);
    const malformed = await h.call(["review", "--to", "null", "--json"], { at: repo, env: { COUNCIL_FAKE_REVIEW: "malformed" } });
    const mj = JSON.parse(malformed.out);
    assert.equal(mj.exit, 10); assert.equal(mj.verdict, "incomplete"); assert.equal(mj.round, null);
    assert.deepEqual(mj.coverage, { reviewed: ["calc.js"], unreviewed: [] });
    const attention = await h.call(["review", "--to", "null"], { at: repo, env: { COUNCIL_FAKE_REVIEW: "approve-with-findings" } });
    assert.equal(attention.code, 10, "findings with an approval verdict → changes, exit 10");
    writeFileSync(join(repo, "huge.log.txt"), "z".repeat(300 * 1024));
    const partial = await h.call(["review", "--to", "null"], { at: repo, env: { COUNCIL_FAKE_REVIEW: "approve" } });
    assert.equal(partial.code, 10, "an approval over incomplete coverage is exit 10");
    assert.match(partial.out, / · unreviewed 1$/m);
    assert.match(partial.out, /- huge\.log\.txt \(over the inline cap\)/);
    rmSync(join(repo, "huge.log.txt"));
    git(repo, ["checkout", "--", "calc.js"]);
    const nothing = await h.call(["review", "--to", "null", "--uncommitted"], { at: repo });
    assert.equal(nothing.code, 2);
    assert.match(nothing.err, /nothing to review: no changes in the working tree/);
    const bad = await h.call(["review", "--to", "null", "--commit", "nope"], { at: repo });
    assert.equal(bad.code, 2);
    assert.match(bad.err, /invalid --commit ref "nope"/);
    const two = await h.call(["review", "--to", "null", "--commit", "HEAD", "--uncommitted"], { at: repo });
    assert.equal(two.code, 2);
    const outside = await h.call(["review", "--to", "null"]);
    assert.equal(outside.code, 2);
    assert.match(outside.err, /review must run inside a Git repository/);
    const commit = await h.call(["review", "--to", "null", "--commit", "HEAD"], { at: repo, env: { COUNCIL_FAKE_REVIEW: "approve" } });
    assert.equal(commit.code, 0, commit.err);
    assert.match(commit.err, /target=commit [0-9a-f]{12} \(root commit\)/);
    const replyToReview = await h.call(["reply", "--thread", h.jobOf(commit.err), "--", "x"], { at: repo });
    assert.equal(replyToReview.code, 2);
    assert.match(replyToReview.err, /is a review; reviews start no thread/);
  } finally { h.done(); }
});

test("models and setup: unavailable providers reported, null probed and refreshed", async () => {
  const h = harness();
  try {
    const models = await h.call(["models"]);
    assert.equal(models.code, 0);
    for (const p of UNBUILT) assert.match(models.out, new RegExp(`^${p}: provider ${p} not available in this build$`, "m"));
    assert.match(models.out, /^null \(static\)\n  null-model: low, medium, high, xhigh, max\n  null-fast: low, medium\n  tiers: consult null-model\/high · exec null-fast\/medium · deep null-model\/xhigh$/m);
    const refresh = await h.call(["models", "--to", "null", "--refresh", "--json"]);
    const [row] = JSON.parse(refresh.out);
    assert.equal(row.source, "refreshed");
    assert.ok(existsSync(join(h.home, "catalog", "null.json")));
    for (const p of UNBUILT) assert.equal((await h.call(["models", "--to", p])).out, `${p}: provider ${p} not available in this build\n`);
    const bad = await h.call(["models", "--to", "bard"]);
    assert.equal(bad.code, 2);
    const setup = await h.call(["setup", "--json"]);
    assert.equal(setup.code, 0);
    const rows = JSON.parse(setup.out);
    assert.deepEqual(rows.map((r) => [r.provider, r.available]), [...["codex", "gemini", "grok"].map((p) => [p, !UNBUILT.includes(p)]), ["null", true], ["null2", true]]);
    for (const r of rows.filter((x) => x.available)) assert.equal(r.ready, true, `${r.provider} probed through its fake: ${r.warnings}`);
    const nul = rows.find((r) => r.provider === "null");
    assert.deepEqual([nul.ready, nul.version, nul.loggedIn, nul.launcher.kind], [true, "null 0.0.0", true, "node-script"]);
    assert.deepEqual(nul.tiers, { consult: "null-model/high", exec: "null-fast/medium", deep: "null-model/xhigh" });
    const text = await h.call(["setup"]);
    for (const p of UNBUILT) assert.match(text.out, new RegExp(`^${p}: provider ${p} not available in this build · ${BINARIES[p]} -> `, "m"));
    assert.equal((await h.call(["setup", "extra"])).code, 2);
    const broken = await h.call(["setup", "--to", "null"], { env: { COUNCIL_NULL_BIN: join(h.root, "missing.mjs") } });
    assert.equal(broken.code, 1, "an available provider that cannot be probed is not ready");
    assert.match(broken.out, /warning: /);
  } finally { h.done(); }
});

test("fingerprint covers verb, inputs and text, never output or scope options", () => {
  const base = fingerprint("ask", { to: "null", effort: "low" }, "hi");
  assert.equal(fingerprint("ask", { effort: "low", to: "null" }, "hi"), base, "option order does not matter");
  assert.equal(fingerprint("ask", { to: "null", effort: "low", json: true, session: "s", "request-id": "r", timeout: "5" }, "hi"), base);
  assert.notEqual(fingerprint("ask", { to: "null", effort: "high" }, "hi"), base);
  assert.notEqual(fingerprint("ask", { to: "null", effort: "low" }, "hi!"), base);
  assert.notEqual(fingerprint("task", { to: "null", effort: "low" }, "hi"), base);
  assert.notEqual(fingerprint("ask", { to: "null", effort: "low", web: true }, "hi"), base);
});
