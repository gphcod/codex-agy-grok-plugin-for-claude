// core (milestone 3 confirmation, Codex): (1) an incomplete review keeps exit 1 but stores and prints
// what it produced — the structured result rendered as an incomplete review as far as it validates,
// else the partial text — and grants no coverage; (2) a thread that became not resumable between
// resolution and the thread claim is refused under the claim with exit 2 and its hint, before any spawn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import nullAdapter from "./fixtures/null-adapter.mjs";
import { GUARD_VARS } from "./fixtures/fake-common.mjs";
import { homeDir, loadJob, loadThread, saveThread } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { runManagedTurn } from "../plugins/council/scripts/lib/core/lifecycle.mjs";
import { inspectClaim } from "../plugins/council/scripts/lib/core/claims.mjs";
import { canonical } from "../plugins/council/scripts/lib/core/fs.mjs";
import { main } from "../plugins/council/scripts/council.mjs";

const FAST = { drainMs: 150, shutdownMs: 4000, retryMs: 300, graceMs: 150, pipeWaitMs: 500 };
function setup(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "council-incr-"));
  const home = homeDir({ COUNCIL_HOME: join(root, "home") });
  const cwd = join(root, "work");
  mkdirSync(cwd);
  const log = join(root, "spawns.log");
  writeFileSync(log, "");
  const env = { ...process.env, COUNCIL_FAKE_SPAWN_LOG: log, COUNCIL_NULL_ID: "preassigned", COUNCIL_NULL_INPUT: "stdin", COUNCIL_NULL_OUTPUT: "stream", ...extra };
  for (const g of GUARD_VARS) delete env[g];
  for (const k of ["COUNCIL_FAKE_SCENARIO", "COUNCIL_FAKE_ANSWER", "COUNCIL_FAKE_REVIEW"]) if (!(k in extra)) delete env[k];
  const spawns = () => readFileSync(log, "utf8").split("\n").filter(Boolean).length;
  return { root, home, cwd, env, spawns, ctx: { home, env, cwd, session: "s" }, done: () => rmSync(root, { recursive: true, force: true }) };
}
// The null adapter, except that every completed turn is incomplete (like agy's print_timeout or grok's max-turns stop).
const incomplete = Object.create(Object.getPrototypeOf(nullAdapter), Object.getOwnPropertyDescriptors(nullAdapter));
incomplete.parseEvent = (line, state) => {
  const ev = nullAdapter.parseEvent(line, state);
  return ev?.completed ? { ...ev, incomplete: "incomplete: stopped early" } : ev;
};
const reviewRequest = (s) => ({
  verb: "review", provider: "null", cwd: s.cwd, session: "s", tier: "consult", model: "null-model", effort: "high", requestedEffort: "high", modelVerified: true,
  thread: null, readOnly: true, text: "", contract: "<c/>", web: false, rounds: 9, round: null, target: "working tree", reviewPrompt: "REVIEW", reviewed: ["calc.js", "b.js"], unreviewed: ["big.bin (over the inline cap)"],
});
const run = (s, adapter = incomplete) => { const req = reviewRequest(s); return runManagedTurn(s.ctx, adapter, req, () => req, { deadlineMs: 20000, inactivityMs: 20000 }, FAST); };

test("incomplete review with valid structured output: exit 1, the review rendered as incomplete, no coverage", async () => {
  const s = setup({ COUNCIL_FAKE_REVIEW: "findings", COUNCIL_FAKE_ANSWER: "{\"verdict\":" });
  try {
    const { job, answer } = await run(s);
    assert.equal(job.code, 1);
    assert.equal(job.error, "incomplete: stopped early");
    assert.match(answer, /^Verdict: incomplete \(incomplete: stopped early\)\. One defect\.\n/);
    assert.match(answer, /\nF1 BLOCKER calc\.js:3: Off-by-one\n/);
    assert.match(answer, /Not reviewed \(outside this review; never approved\):\n- calc\.js\n- b\.js\n- big\.bin/);
    assert.equal(readFileSync(join(job.dir, "answer.md"), "utf8"), answer, "persisted");
    assert.equal(job.verdict, "incomplete");
    assert.deepEqual(job.review.coverage, { reviewed: [], unreviewed: ["calc.js", "b.js", "big.bin (over the inline cap)"] });
    assert.equal(job.review.findings.length, 1);
    assert.equal(loadJob(s.home, job.id).review.verdict, "incomplete");
  } finally { s.done(); }
});

test("incomplete review whose structured output does not validate keeps the partial text", async () => {
  const s = setup({ COUNCIL_FAKE_REVIEW: "malformed", COUNCIL_FAKE_ANSWER: "partial review text" });
  try {
    const { job, answer } = await run(s);
    assert.equal(job.code, 1);
    assert.equal(answer, "partial review text");
    assert.equal(job.verdict, "incomplete");
    assert.deepEqual(job.review.coverage.reviewed, []);
  } finally { s.done(); }
});

test("incomplete review with neither: the incomplete verdict is the answer", async () => {
  const s = setup({ COUNCIL_FAKE_REVIEW: "none" });
  try {
    const { job, answer } = await run(s);
    assert.equal(job.code, 1);
    assert.match(answer, /^Verdict: incomplete \(missing structured review output\)\./);
  } finally { s.done(); }
});

test("a finished review still renders its result over the streamed text", async () => {
  const s = setup({ COUNCIL_FAKE_REVIEW: "approve", COUNCIL_FAKE_ANSWER: "raw streamed text" });
  try {
    const { job, answer } = await run(s, nullAdapter);
    assert.equal(job.code, 10, "the omitted file still needs attention");
    assert.match(answer, /^Verdict: approve\. Looks correct\.\n/);
    assert.deepEqual(job.review.coverage.reviewed, ["calc.js", "b.js"]);
  } finally { s.done(); }
});

test("a thread marked not resumable between resolution and the claim: exit 2 with its hint, nothing spawned, claim released", async () => {
  const s = setup({ COUNCIL_TEST_NULL_ADAPTER: "1", COUNCIL_HOME: "", COUNCIL_STDIN_DEADLINE_MS: "300" });
  try {
    const env = { ...s.env, COUNCIL_HOME: s.home };
    const call = async (argv, hooks = {}) => {
      let out = "", err = "";
      const stdin = new PassThrough(); stdin.end("");
      const code = await main(argv, env, { stdout: { write: (x) => { out += x; return true; } }, stderr: { write: (x) => { err += x; return true; } }, stdin, cwd: s.cwd }, hooks);
      return { code, out, err };
    };
    const ask = await call(["ask", "--to", "null", "--session", "s", "--", "hi"]);
    assert.equal(ask.code, 0, ask.out + ask.err);
    const job = /job ([a-z0-9]{16})/.exec(ask.out)[1];
    const threadId = loadJob(canonical(s.home), job).threadId;
    const before = s.spawns();
    const hint = "session not confirmed: start a new ask";
    // In-memory race: the reply resolved a resumable thread; another turn marks it not resumable before the claim.
    const r = await call(["reply", "--thread", job, "--session", "s", "--", "again"], {
      beforeClaim: () => { const t = loadThread(canonical(s.home), "null", threadId); saveThread(canonical(s.home), { ...t, resumable: false, unconfirmed: hint }); },
    });
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.out, new RegExp(`error: null thread ${threadId}: ${hint}`));
    assert.equal(s.spawns(), before, "nothing spawned");
    assert.equal(inspectClaim(canonical(s.home), "null", threadId).state, "absent", "claim released");
    const after = await call(["reply", "--thread", job, "--session", "s", "--", "again"]);
    assert.equal(after.code, 2);
    assert.match(after.err, new RegExp(`${hint}\\n$`), "the next call is refused before admission");
  } finally { s.done(); }
});
