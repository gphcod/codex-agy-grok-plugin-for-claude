// S4.5: the grok adapter end to end through main() against tests/fixtures/fake-grok.mjs, which checks
// the whole A5.1 launch contract (recipe, compatEnv, guard variables, prompt file, contract, schema,
// web) before answering. No test starts the real grok: COUNCIL_GROK_BIN always names the fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { main } from "../plugins/council/scripts/council.mjs";
import { GUARD_VARS, executionController } from "../plugins/council/scripts/lib/core/execution.mjs";
import { loadJob, loadThread } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { canonical } from "../plugins/council/scripts/lib/core/fs.mjs";
import grok, { HOSTILE, RESUME_DENY, oneLineContract } from "../plugins/council/scripts/lib/providers/grok.mjs";
import { commitAll, git, initRepo, isolateGit } from "./fixtures/build-repos.mjs";

isolateGit();
const FAKE = fileURLToPath(new URL("./fixtures/fake-grok.mjs", import.meta.url));
const CONTRACT = oneLineContract(readFileSync(new URL("../plugins/council/contract.md", import.meta.url), "utf8").replace(/\r\n?/g, "\n").trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flag = (args, name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const all = (args, name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));

function harness() {
  const root = mkdtempSync(join(tmpdir(), "council-grok-"));
  const home = join(root, "home");
  const cwd = join(root, "work");
  mkdirSync(cwd);
  const base = { ...process.env, COUNCIL_HOME: home, COUNCIL_GROK_BIN: FAKE, COUNCIL_STDIN_DEADLINE_MS: "300", COUNCIL_FAKE_EXPECT_CONTRACT: CONTRACT, COUNCIL_FAKE_JOB_DIR: join(home, "jobs") };
  for (const k of [...GUARD_VARS, "COUNCIL_TEST_NULL_ADAPTER", "COUNCIL_FAKE_SCENARIO", "COUNCIL_FAKE_WEB", "COUNCIL_FAKE_EXPECT_PROMPT", "COUNCIL_FAKE_EXPECT_PROMPT_CONTAINS", "GROK_CLAUDE_RULES_ENABLED"]) delete base[k];
  for (const k of Object.keys(base)) if (k.startsWith("COUNCIL_FAKE_GROK_")) delete base[k];
  const call = async (argv, { env = {}, at = cwd, text } = {}) => {
    let out = "", err = "";
    const stdin = new PassThrough(); stdin.end("");
    const full = text === undefined ? argv : [...argv, "--", text];
    const promptEnv = text === undefined ? {} : { COUNCIL_FAKE_EXPECT_PROMPT: text };
    const code = await main(full, { ...base, ...promptEnv, ...env }, { stdout: { write: (s) => { out += s; return true; } }, stderr: { write: (s) => { err += s; return true; } }, stdin, cwd: at });
    return { code, out, err, job: /job[= ]([a-z0-9]{16})/.exec(err + out)?.[1] };
  };
  const job = (id) => loadJob(canonical(home), id);
  return { root, home, cwd, base, call, job, done: () => rmSync(root, { recursive: true, force: true }) };
}
const footer = (out) => out.trim().split("\n").at(-1);

test("ask: pong, footer grok-4.7/low, explore recipe, fresh session confirmed, thread record with agent explore", async () => {
  const h = harness();
  try {
    const r = await h.call(["ask", "--to", "grok", "--effort", "low", "--session", "s1"], { text: "Reply with pong" });
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.err, new RegExp(`^\\[council\\] provider=grok job=${r.job} thread=[0-9a-f-]{36}\\n$`));
    assert.match(r.out, /^pong\n/);
    assert.match(footer(r.out), new RegExp(`^council grok ok · job ${r.job} · grok-4\\.7/low · \\d+s · round 1/9 · next: reply ${r.job}$`));
    const job = h.job(r.job);
    assert.equal(flag(job.childArgs, "--agent"), "explore");
    assert.equal(flag(job.childArgs, "--session-id"), job.threadId);
    assert.equal(job.costUsd, 0.01125);
    assert.equal(job.turn.promptFile, join(job.dir, "prompt.md"));
    assert.equal(readFileSync(job.turn.promptFile, "utf8"), "Reply with pong");
    const thread = loadThread(canonical(h.home), "grok", job.threadId);
    assert.deepEqual([thread.agent, thread.readOnly, thread.model, thread.effort], ["explore", true, "grok-4.7", "low"]);
  } finally { h.done(); }
});

test("ask → task --thread → reply → task --thread: recipe, -r and agent on every transition", async () => {
  const h = harness();
  try {
    const ask = await h.call(["ask", "--to", "grok", "--effort", "low"], { text: "plan it" });
    assert.equal(ask.code, 0, ask.out);
    const sid = h.job(ask.job).threadId;
    const resume = { env: { COUNCIL_FAKE_SCENARIO: "resume" } };

    const task1 = await h.call(["task", "--thread", ask.job, "--effort", "low"], { text: "do it", ...resume, env: { ...resume.env, COUNCIL_FAKE_GROK_EDIT: join(canonical(h.cwd), "src", "a.js") } });
    assert.equal(task1.code, 0, task1.out);
    let a = h.job(task1.job).childArgs;
    assert.equal(flag(a, "-r"), sid);
    assert.equal(a.includes("--agent"), false);
    assert.deepEqual(all(a, "--deny"), ["Bash(git push*)", "Bash(rm -rf *)"]);
    assert.equal(flag(a, "--disallowed-tools"), HOSTILE.join(","));
    assert.match(footer(task1.out), / · round 2\/9 · edited 1 · next: reply /);
    assert.deepEqual(h.job(task1.job).edited, ["src/a.js"]);
    assert.equal(loadThread(canonical(h.home), "grok", sid).agent, "default");

    const reply = await h.call(["reply", "--thread", task1.job, "--effort", "low"], { text: "why?", ...resume });
    assert.equal(reply.code, 0, reply.out);
    a = h.job(reply.job).childArgs;
    assert.equal(flag(a, "-r"), sid);
    assert.equal(a.includes("--agent"), false, "a default-agent session cannot switch back to explore");
    assert.equal(flag(a, "--disallowed-tools"), RESUME_DENY.join(","));
    assert.deepEqual(all(a, "--deny"), ["MCPTool(*)"]);
    assert.equal(h.job(reply.job).readOnly, true);
    assert.match(reply.out, /^pong again\n/);
    assert.match(footer(reply.out), / · round 3\/9 · next: reply /);
    assert.equal(loadThread(canonical(h.home), "grok", sid).agent, "default");

    const task2 = await h.call(["task", "--thread", reply.job, "--effort", "low"], { text: "again", ...resume });
    assert.equal(task2.code, 0, task2.out);
    a = h.job(task2.job).childArgs;
    assert.equal(flag(a, "-r"), sid);
    assert.deepEqual(all(a, "--deny"), ["Bash(git push*)", "Bash(rm -rf *)"]);
    assert.match(footer(task2.out), / · round 4\/9 · edited 0 · /);
    const thread = loadThread(canonical(h.home), "grok", sid);
    assert.deepEqual([thread.agent, thread.readOnly, thread.round], ["default", false, 4]);

    const reply2 = await h.call(["reply", "--thread", sid, "--effort", "low"], { text: "and?", ...resume });
    assert.equal(reply2.code, 0, reply2.out);
    assert.equal(flag(h.job(reply2.job).childArgs, "--disallowed-tools"), RESUME_DENY.join(","), "reply after a task is read-only with RESUME_DENY");
  } finally { h.done(); }
});

test("reply on an explore thread stays explore", async () => {
  const h = harness();
  try {
    const ask = await h.call(["ask", "--to", "grok", "--effort", "low"], { text: "q" });
    const reply = await h.call(["reply", "--last", "--effort", "low"], { text: "more", env: { COUNCIL_FAKE_SCENARIO: "resume" } });
    assert.equal(reply.code, 0, reply.out);
    const a = h.job(reply.job).childArgs;
    assert.equal(flag(a, "--agent"), "explore");
    assert.equal(flag(a, "-r"), h.job(ask.job).threadId);
  } finally { h.done(); }
});

test("a forbidden tool advertised on a read-only turn: exit 1 before any text", async () => {
  const h = harness();
  try {
    const r = await h.call(["ask", "--to", "grok", "--effort", "low"], { text: "q", env: { COUNCIL_FAKE_GROK_ADVERTISE: "write" } });
    assert.equal(r.code, 1);
    assert.match(footer(r.out), /^council grok failed · .* · error: read-only tool guard failed: write/);
    assert.equal(r.out.trim().split("\n").length, 1, "no answer text, only the footer");
    const job = h.job(r.job);
    assert.equal(existsSync(join(job.dir, "answer.md")) ? readFileSync(join(job.dir, "answer.md"), "utf8") : "", "");
    assert.equal(loadThread(canonical(h.home), "grok", job.requestedThreadId), null, "no thread record for an unconfirmed session");
  } finally { h.done(); }
});

test("a forbidden tool call on a read-only turn (denied scenario): exit 1", async () => {
  const h = harness();
  try {
    const r = await h.call(["ask", "--to", "grok", "--effort", "low"], { text: "write a file", env: { COUNCIL_FAKE_SCENARIO: "denied" } });
    assert.equal(r.code, 1);
    assert.match(footer(r.out), /error: read-only tool guard failed: Grok called write/);
  } finally { h.done(); }
});

test("a task may advertise and use writing tools", async () => {
  const h = harness();
  try {
    const r = await h.call(["task", "--to", "grok", "--effort", "low"], { text: "edit", env: { COUNCIL_FAKE_GROK_EDIT: join(h.cwd, "b.js") } });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^Editing\.\n\npong\n/);
    assert.match(footer(r.out), /^council grok ok · .* · grok-4\.7-build-fast\/low · \d+s · round 1\/9 · edited 1 · next: reply /, "task defaults to the exec tier");
    assert.equal(h.job(r.job).readOnly, false);
  } finally { h.done(); }
});

test("--web omits --disable-web-search; reply inherits web from the thread; review refuses --web", async () => {
  const h = harness();
  try {
    const plain = await h.call(["ask", "--to", "grok", "--effort", "low"], { text: "q" });
    assert.ok(h.job(plain.job).childArgs.includes("--disable-web-search"));
    const web = await h.call(["ask", "--to", "grok", "--effort", "low", "--web"], { text: "q", env: { COUNCIL_FAKE_WEB: "1" } });
    assert.equal(web.code, 0, web.out);
    assert.ok(!h.job(web.job).childArgs.includes("--disable-web-search"));
    const reply = await h.call(["reply", "--thread", web.job, "--effort", "low"], { text: "q2", env: { COUNCIL_FAKE_WEB: "1", COUNCIL_FAKE_SCENARIO: "resume" } });
    assert.equal(reply.code, 0, reply.out);
    assert.ok(!h.job(reply.job).childArgs.includes("--disable-web-search"), "web inherited");
    assert.equal((await h.call(["review", "--to", "grok", "--web"])).code, 2);
  } finally { h.done(); }
});

test("--effort max clamps to xhigh: footer grok-4.7/xhigh<=max", async () => {
  const h = harness();
  try {
    const r = await h.call(["ask", "--to", "grok", "--model", "4.7", "--effort", "max"], { text: "q" });
    assert.equal(r.code, 0, r.out);
    assert.match(footer(r.out), /^council grok ok · job [a-z0-9]{16} · grok-4\.7\/xhigh<=max · /);
    assert.equal(flag(h.job(r.job).childArgs, "--effort"), "xhigh");
    const json = await h.call(["ask", "--to", "grok", "--effort", "max", "--json"], { text: "q" });
    const o = JSON.parse(json.out);
    assert.deepEqual([o.effort, o.requestedEffort, o.model, o.costUsd], ["xhigh", "max", "grok-4.7", 0.01125]);
  } finally { h.done(); }
});

test("a CLI error event (effort-error scenario) fails with its message", async () => {
  const h = harness();
  try {
    const r = await h.call(["ask", "--to", "grok", "--effort", "low"], { text: "q", env: { COUNCIL_FAKE_SCENARIO: "effort-error" } });
    assert.equal(r.code, 1);
    assert.match(footer(r.out), /error: --effort\/--reasoning-effort: unknown effort level 'max'/);
  } finally { h.done(); }
});

// --- reviews -----------------------------------------------------------------------------------------------

function repo(h) {
  const dir = initRepo(join(h.root, "repo"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "calc.js"), "export function sum(items) {\n  let total = 0;\n  for (let i = 0; i < items.length; i++) total += items[i];\n  return total;\n}\n");
  writeFileSync(join(dir, "sub", "keep.txt"), "x\n");
  commitAll(dir, "init");
  writeFileSync(join(dir, "calc.js"), "export function sum(items) {\n  let total = 0;\n  for (let i = 0; i <= items.length; i++) total += items[i];\n  return total;\n}\n");
  return dir;
}

test("review --uncommitted with findings: exit 10, BLOCKER finding, schema inline, no --rules, explore", async () => {
  const h = harness();
  try {
    const dir = repo(h);
    const r = await h.call(["review", "--to", "grok", "--uncommitted", "--effort", "low"], { at: dir, env: { COUNCIL_FAKE_SCENARIO: "review-findings", COUNCIL_FAKE_EXPECT_PROMPT_CONTAINS: "i <= items.length" } });
    assert.equal(r.code, 10, r.out);
    assert.match(r.err, /target=working tree \(staged, unstaged and untracked\)/);
    assert.match(r.out, /^Verdict: changes requested\./);
    assert.match(r.out, /\nF1 BLOCKER calc\.js:3: /);
    assert.match(footer(r.out), /^council grok needs attention · job [a-z0-9]{16} · grok-4\.7\/low · \d+s$/, "no round, no next: reply on a review");
    const job = h.job(r.job);
    assert.ok(job.childArgs.includes("--json-schema"));
    assert.equal(job.childArgs.includes("--rules"), false);
    assert.equal(flag(job.childArgs, "--agent"), "explore");
    assert.equal(job.verdict, "changes");
    const prompt = readFileSync(job.turn.promptFile, "utf8");
    assert.match(prompt, /Target: working tree/);
    assert.doesNotMatch(prompt, /adversarial software review/);
  } finally { h.done(); }
});

test("review --adversarial renders the adversarial template into the prompt file", async () => {
  const h = harness();
  try {
    const dir = repo(h);
    const r = await h.call(["review", "--to", "grok", "--uncommitted", "--adversarial", "--effort", "low", "--", "look at bounds"], { at: dir, env: { COUNCIL_FAKE_SCENARIO: "review-findings", COUNCIL_FAKE_EXPECT_PROMPT_CONTAINS: "You are performing an adversarial software review." } });
    assert.equal(r.code, 10, r.out);
    const prompt = readFileSync(h.job(r.job).turn.promptFile, "utf8");
    assert.match(prompt, /User focus: look at bounds/);
    assert.match(prompt, /i <= items\.length/);
  } finally { h.done(); }
});

test("review from a subdirectory runs grok at the repository root", async () => {
  const h = harness();
  try {
    const dir = repo(h);
    const r = await h.call(["review", "--to", "grok", "--uncommitted", "--effort", "low"], { at: join(dir, "sub"), env: { COUNCIL_FAKE_SCENARIO: "review-findings", COUNCIL_FAKE_EXPECT_PROMPT_CONTAINS: "calc.js", COUNCIL_FAKE_GROK_CWD: dir } });
    assert.equal(r.code, 10, r.out);
    assert.equal(canonical(flag(h.job(r.job).childArgs, "--cwd")), canonical(dir));
  } finally { h.done(); }
});

test("review with malformed structured output: exit 10, incomplete, never an approval", async () => {
  const h = harness();
  try {
    const dir = repo(h);
    const r = await h.call(["review", "--to", "grok", "--uncommitted", "--effort", "low"], { at: dir, env: { COUNCIL_FAKE_SCENARIO: "review-malformed", COUNCIL_FAKE_EXPECT_PROMPT_CONTAINS: "calc.js" } });
    assert.equal(r.code, 10, r.out);
    assert.match(r.out, /^Verdict: incomplete \(review summary is empty\)\./);
    assert.equal(h.job(r.job).verdict, "incomplete");
  } finally { h.done(); }
});

test("review of a clean tree with nothing to review exits 2 before any spawn", async () => {
  const h = harness();
  try {
    const dir = initRepo(join(h.root, "clean"));
    writeFileSync(join(dir, "a"), "a\n");
    commitAll(dir, "a");
    const r = await h.call(["review", "--to", "grok", "--uncommitted"], { at: dir });
    assert.equal(r.code, 2);
    assert.match(r.err, /nothing to review/);
  } finally { h.done(); }
});

// --- concurrency, ownership and cancel ----------------------------------------------------------------------

test("two concurrent jobs with the same model and effort: neither's post-exit scan matches the other's row", async () => {
  const h = harness();
  try {
    const env = { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "1500" };
    const first = h.call(["ask", "--to", "grok", "--effort", "low"], { text: "one", env });
    const second = h.call(["ask", "--to", "grok", "--effort", "low"], { text: "two", env: { ...env, COUNCIL_FAKE_SLOW_MS: "3000" } });
    // While both run: each job owns exactly its own row.
    let jobs = [];
    for (let i = 0; i < 100 && jobs.length < 2; i++) {
      await sleep(50);
      try { jobs = (await import("node:fs")).readdirSync(join(h.home, "jobs")).map((id) => h.job(id)).filter((j) => j?.pid); } catch { jobs = []; }
    }
    assert.equal(jobs.length, 2);
    const snap = executionController().snapshot();
    assert.equal(snap.state, "ok");
    const rowOf = (j) => snap.rows.find((r) => r.pid === j.pid);
    const [a, b] = jobs;
    assert.ok(rowOf(a) && rowOf(b), "both fakes are in the process table");
    assert.equal(flag(a.childArgs, "--model"), flag(b.childArgs, "--model"));
    assert.equal(grok.ownsProcess(rowOf(a), a, process.platform), true);
    assert.equal(grok.ownsProcess(rowOf(b), b, process.platform), true);
    assert.equal(grok.ownsProcess(rowOf(b), a, process.platform), false);
    assert.equal(grok.ownsProcess(rowOf(a), b, process.platform), false);
    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1.code, 0, r1.out);
    assert.equal(r2.code, 0, r2.out, "the first job's post-exit scan left the second alone");
    assert.match(r1.out, /^pong \(slow\)\n/);
    assert.match(r2.out, /^pong \(slow\)\n/);
  } finally { h.done(); }
});

test("cancel stops a running grok turn and confirms cleanup", async () => {
  const h = harness();
  try {
    const running = h.call(["ask", "--to", "grok", "--effort", "low", "--session", "s"], { text: "slow", env: { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "20000" } });
    let id = null;
    for (let i = 0; i < 100 && !id; i++) {
      await sleep(50);
      try { id = (await import("node:fs")).readdirSync(join(h.home, "jobs")).find((j) => h.job(j)?.pid); } catch { /* not yet */ }
    }
    assert.ok(id);
    const c = await h.call(["cancel", id]);
    assert.equal(c.code, 0, c.out + c.err);
    const r = await running;
    assert.equal(r.code, 1);
    assert.match(footer(r.out), /^council grok cancelled · /);
    assert.equal(h.job(id).cleanupPending, false);
  } finally { h.done(); }
});

// --- setup and models -----------------------------------------------------------------------------------------

test("setup --to grok and models --refresh --to grok through the fake", async () => {
  const h = harness();
  try {
    const s = await h.call(["setup", "--to", "grok"]);
    assert.equal(s.code, 0, s.out + s.err);
    assert.match(s.out, new RegExp(`^grok: ready · ${FAKE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(node-script\\) · grok 1\\.0\\.70 \\(f50904eaee6c\\) \\[stable\\] · logged in$`, "m"));
    assert.match(s.out, /^ {2}tiers: consult grok-4\.7\/high · exec grok-4\.7-build-fast\/xhigh · deep grok-4\.7\/xhigh$/m);
    assert.match(s.out, /^ {2}note: every turn ends with a process scan/m);
    assert.doesNotMatch(s.out, /warning:/);
    const m = await h.call(["models", "--to", "grok", "--refresh"]);
    assert.equal(m.code, 0, m.out + m.err);
    assert.match(m.out, /^grok \(refreshed \d{4}-\d\d-\d\dT[0-9:.]+Z\)$/m);
    assert.match(m.out, /^ {2}grok-4\.7: low, medium, high, xhigh$/m);
    const cached = JSON.parse(readFileSync(join(h.home, "catalog", "grok.json"), "utf8"));
    assert.deepEqual(Object.keys(cached.models), ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"]);
    const missing = await h.call(["setup", "--to", "grok"], { env: { COUNCIL_GROK_BIN: join(h.root, "nope") } });
    assert.equal(missing.code, 1);
    assert.match(missing.out, /warning: grok not found; set COUNCIL_GROK_BIN/);
  } finally { h.done(); }
});

// --- session confirmation and stop reasons (S4.8, milestone 3 review Q4) ---------------------------------------

const HINT = "session not confirmed: start a new ask";

test("fresh ask whose end names no session: answer kept, exit 0, hint; reply on it exits 2 with the hint", async () => {
  const h = harness();
  try {
    const r = await h.call(["ask", "--to", "grok", "--effort", "low"], { text: "q", env: { COUNCIL_FAKE_GROK_END: "no-session" } });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^pong\n/);
    assert.match(footer(r.out), new RegExp(`^council grok ok · job ${r.job} · grok-4\\.7/low · \\d+s · round 1/9 · ${HINT}$`));
    const job = h.job(r.job);
    assert.equal(job.threadId, null);
    assert.equal(loadThread(canonical(h.home), "grok", job.requestedThreadId), null);
    const reply = await h.call(["reply", "--thread", r.job], { text: "again", env: { COUNCIL_FAKE_SCENARIO: "resume" } });
    assert.equal(reply.code, 2);
    assert.equal(reply.err, `council: job ${r.job}: ${HINT}\n`);
    const task = await h.call(["task", "--thread", r.job], { text: "do", env: { COUNCIL_FAKE_SCENARIO: "resume" } });
    assert.equal(task.code, 2);
    assert.match(task.err, new RegExp(`${HINT}\\n$`));
  } finally { h.done(); }
});

test("resumed reply whose end names no session: exit 0 with the hint; the thread is no longer resumable", async () => {
  const h = harness();
  try {
    const ask = await h.call(["ask", "--to", "grok", "--effort", "low"], { text: "q" });
    const sid = h.job(ask.job).threadId;
    const reply = await h.call(["reply", "--thread", ask.job, "--effort", "low"], { text: "q2", env: { COUNCIL_FAKE_SCENARIO: "resume", COUNCIL_FAKE_GROK_END: "no-session" } });
    assert.equal(reply.code, 0, reply.out);
    assert.match(reply.out, /^pong again\n/);
    assert.match(footer(reply.out), new RegExp(` · round 2/9 · ${HINT}$`));
    const record = loadThread(canonical(h.home), "grok", sid);
    assert.deepEqual([record.resumable, record.unconfirmed], [false, HINT]);
    for (const argv of [["reply", "--thread", ask.job], ["reply", "--thread", sid], ["reply", "--last"], ["task", "--thread", sid]]) {
      const r = await h.call(argv, { text: "more", env: { COUNCIL_FAKE_SCENARIO: "resume" } });
      assert.equal(r.code, 2, argv.join(" "));
      assert.match(r.err, new RegExp(`${HINT}\\n$`), argv.join(" "));
    }
  } finally { h.done(); }
});

test("an end event naming another session fails (exit 1) and confirms nothing", async () => {
  const h = harness();
  try {
    const r = await h.call(["ask", "--to", "grok", "--effort", "low"], { text: "q", env: { COUNCIL_FAKE_GROK_END: "other-session" } });
    assert.equal(r.code, 1);
    assert.match(footer(r.out), /error: Grok answered on session "00000000-0000-4000-8000-000000000000", expected [0-9a-f-]{36}$/);
    assert.equal(h.job(r.job).threadId, null);
  } finally { h.done(); }
});

test("Grok's own cancelled stop is a denial: answer kept, exit 10, thread confirmed and resumable (S4.9)", async () => {
  const h = harness();
  try {
    const r = await h.call(["ask", "--to", "grok", "--effort", "low"], { text: "push it", env: { COUNCIL_FAKE_GROK_END: "cancelled" } });
    assert.equal(r.code, 10, r.out + r.err);
    assert.match(r.out, /^pong\n/);
    assert.match(footer(r.out), new RegExp(`^council grok needs attention · job ${r.job} · grok-4\\.7/low · \\d+s · round 1/9 · next: reply ${r.job}$`));
    const job = h.job(r.job);
    assert.equal(job.denied, "Grok cancelled the turn (a tool needed permission headless Grok cannot ask for)");
    assert.equal(job.threadId, job.requestedThreadId, "the session was confirmed");
    const reply = await h.call(["reply", "--thread", r.job, "--effort", "low"], { text: "why?", env: { COUNCIL_FAKE_SCENARIO: "resume" } });
    assert.equal(reply.code, 0, reply.out + reply.err);
  } finally { h.done(); }
});

test("a max-turns stop keeps the answer and exits 1 with incomplete: <reason>", async () => {
  const h = harness();
  try {
    const r = await h.call(["ask", "--to", "grok", "--effort", "low"], { text: "q", env: { COUNCIL_FAKE_GROK_END: "max-turns" } });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /^pong\n/, "the answer is printed");
    assert.match(footer(r.out), /^council grok failed · .* · error: incomplete: Grok stopped: max turns reached · next: reply [a-z0-9]{16}$/);
    const job = h.job(r.job);
    assert.equal(job.threadId, job.requestedThreadId, "the session was confirmed");
    assert.equal(loadThread(canonical(h.home), "grok", job.threadId).resumable, undefined);
  } finally { h.done(); }
});

test("a review stopped by max turns keeps its structured review: exit 1, rendered incomplete, no coverage", async () => {
  const h = harness();
  try {
    const dir = repo(h);
    const r = await h.call(["review", "--to", "grok", "--uncommitted", "--effort", "low", "--json"], { at: dir, env: { COUNCIL_FAKE_SCENARIO: "review-findings", COUNCIL_FAKE_EXPECT_PROMPT_CONTAINS: "calc.js", COUNCIL_FAKE_GROK_END: "max-turns" } });
    assert.equal(r.code, 1, r.out);
    const o = JSON.parse(r.out);
    assert.equal(o.error, "incomplete: Grok stopped: max turns reached");
    assert.match(o.answer, /^Verdict: incomplete \(incomplete: Grok stopped: max turns reached\)\. The loop bound changed/);
    assert.match(o.answer, /\nF1 BLOCKER calc\.js:3: /);
    assert.equal(o.verdict, "incomplete");
    assert.deepEqual(o.coverage.reviewed, []);
    assert.ok(o.coverage.unreviewed.includes("calc.js"));
    assert.equal(o.findings.length, 1);
  } finally { h.done(); }
});
