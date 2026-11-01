// S3.4: the codex adapter through main() against fake-codex, which validates the A5.1 launch contract
// (argv, sandbox, resume form, review routes, contract, prompt bytes, -o inside the job directory,
// the four guard variables) before answering. COUNCIL_FAKE_CODEX_LOG counts every CLI invocation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { main } from "../plugins/council/scripts/council.mjs";
import { GUARD_VARS } from "../plugins/council/scripts/lib/core/execution.mjs";
import { canonical } from "../plugins/council/scripts/lib/core/fs.mjs";
import { reviewTarget } from "../plugins/council/scripts/lib/core/git.mjs";
import { commitAll, git, initRepo, isolateGit } from "./fixtures/build-repos.mjs";

isolateGit();
const FAKE = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const CONTRACT = readFileSync(new URL("../plugins/council/contract.md", import.meta.url), "utf8").replace(/\r\n?/g, "\n").trim();

function harness() {
  const root = mkdtempSync(join(tmpdir(), "council-codex-turns-"));
  const home = join(root, "home");
  const repo = initRepo(join(root, "repo"));
  writeFileSync(join(repo, "calc.js"), "export const sum = (items) => { let s = 0; for (let i = 0; i < items.length; i++) s += items[i]; return s; };\n");
  commitAll(repo, "main");
  const cwd = canonical(repo);
  const log = join(root, "codex.log");
  writeFileSync(log, "");
  const base = {
    ...process.env, COUNCIL_HOME: home, COUNCIL_CODEX_BIN: FAKE, COUNCIL_FAKE_CODEX_LOG: log, COUNCIL_FAKE_JOB_DIR: join(home, "jobs"),
    COUNCIL_FAKE_EXPECT_CONTRACT: CONTRACT, COUNCIL_STDIN_DEADLINE_MS: "300",
  };
  for (const k of [...GUARD_VARS, "COUNCIL_FAKE_SCENARIO", "COUNCIL_CODEX_MCP", "COUNCIL_FAKE_MCP_SERVERS", "COUNCIL_FAKE_CODEX_EDIT", "COUNCIL_FAKE_EXPECT_PROMPT", "COUNCIL_FAKE_EXPECT_PROMPT_CONTAINS", "COUNCIL_TEST_NULL_ADAPTER"]) delete base[k];
  const call = async (argv, { env = {}, stdin = "" } = {}) => {
    let out = "", err = "";
    const stream = new PassThrough(); stream.end(stdin);
    const code = await main(argv, { ...base, ...env }, { stdout: { write: (s) => { out += s; return true; } }, stderr: { write: (s) => { err += s; return true; } }, stdin: stream, cwd: repo });
    return { code, out, err };
  };
  /** A turn verb with text after `--`; the fake checks the prompt bytes it receives. */
  const turn = (argv, text, env = {}) => call([...argv, "--", text], { env: { COUNCIL_FAKE_EXPECT_PROMPT: text, ...env } });
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const clearLog = () => writeFileSync(log, "");
  const jobs = () => { try { return readdirSync(join(home, "jobs")).filter((n) => /^[a-z0-9]{16}$/.test(n)); } catch { return []; } };
  const jobOf = (text) => /job[= ]([a-z0-9]{16})/.exec(text)?.[1];
  const answerOf = (job) => join(canonical(home), "jobs", job, "answer.md");
  return { root, home, repo, cwd, call, turn, calls, clearLog, jobs, jobOf, answerOf, done: () => rmSync(root, { recursive: true, force: true }) };
}
const devInstructions = `developer_instructions=${JSON.stringify(CONTRACT)}`;
const footer = (status, model, effort, rest = "") => new RegExp(`^council codex ${status} · job [a-z0-9]{16} · ${model}/${effort} · [0-9.]+m?s${rest}`, "m");

test("ask: fresh read-only exec, prompt on stdin, answer from -o, footer and start line", async () => {
  const h = harness();
  try {
    const r = await h.turn(["ask", "--to", "codex", "--effort", "low"], "Reply with pong");
    assert.equal(r.code, 0, r.err + r.out);
    const job = h.jobOf(r.err);
    assert.match(r.err, new RegExp(`^\\[council\\] provider=codex job=${job} thread=[0-9a-f-]{36}\\n$`));
    assert.match(r.out, /^pong\n/);
    assert.match(r.out, footer("ok", "gpt-6\\.1-sol", "low", ` · round 1/9 · next: reply ${job}$`));
    const [c] = h.calls();
    assert.equal(h.calls().length, 1, "one model process, nothing else");
    assert.deepEqual(c.argv, ["exec", "--json", "-o", h.answerOf(job), "-C", h.cwd, "-s", "read-only", "-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=low", "-c", devInstructions, "-"]);
    assert.equal(c.guards.length, 4, "all four guard variables reach the child");
    const json = JSON.parse((await h.turn(["ask", "--to", "codex", "--json"], "Reply with pong")).out);
    assert.deepEqual([json.provider, json.model, json.effort, json.tier, json.exit, json.answer, json.round], ["codex", "gpt-6.1-sol", "high", "consult", 0, "pong", 1]);
    assert.equal(json.thread.length, 36);
  } finally { h.done(); }
});

test("ask → task --thread → reply → task --thread: sandbox and resume arguments on every transition", async () => {
  const h = harness();
  try {
    const ask = await h.turn(["ask", "--to", "codex", "--effort", "low"], "plan it");
    assert.equal(ask.code, 0, ask.err + ask.out);
    const job = h.jobOf(ask.err);
    const thread = JSON.parse(readFileSync(join(h.home, "jobs", job, "meta.json"), "utf8")).threadId;
    const edit = { COUNCIL_FAKE_SCENARIO: "resume", COUNCIL_FAKE_CODEX_EDIT: "calc.js" };
    const task1 = await h.turn(["task", "--thread", job], "apply it", edit);
    assert.equal(task1.code, 0, task1.err + task1.out);
    assert.match(task1.out, footer("ok", "gpt-6-luna", "max", " · round 2/9 · edited 1 · next: reply "));
    const reply = await h.turn(["reply", "--thread", job], "explain it", edit);
    assert.equal(reply.code, 0, reply.err + reply.out);
    assert.match(reply.out, footer("ok", "gpt-6-luna", "max", " · round 3/9 · next: reply "), "reply inherits the thread's model and effort");
    const task2 = await h.turn(["task", "--thread", job, "--effort", "high"], "fix the rest", edit);
    assert.equal(task2.code, 0, task2.err + task2.out);
    assert.match(task2.out, footer("ok", "gpt-6-luna", "high", " · round 4/9 · edited 1 · "));
    const [a, t1, r, t2] = h.calls();
    assert.deepEqual(a.argv.slice(0, 2), ["exec", "--json"]);
    assert.deepEqual(a.argv.slice(4, 8), ["-C", h.cwd, "-s", "read-only"]);
    const resumed = (c, sandbox, effort) => {
      assert.deepEqual(c.argv.slice(0, 4), ["exec", "resume", thread, "--json"]);
      assert.deepEqual(c.argv.slice(6, 14), ["-c", `sandbox_mode=${sandbox}`, "-m", "gpt-6-luna", "-c", `model_reasoning_effort=${effort}`, "-c", devInstructions]);
      assert.ok(!c.argv.includes("-C") && !c.argv.includes("-s"));
      assert.equal(canonical(c.cwd), h.cwd, "resume runs with cwd set");
    };
    resumed(t1, "workspace-write", "max");
    resumed(r, "read-only", "max");
    resumed(t2, "workspace-write", "high");
    const record = JSON.parse(readFileSync(join(h.home, "threads", `codex-${thread}.json`), "utf8"));
    assert.deepEqual([record.round, record.lastVerb, record.readOnly, record.model], [4, "task", false, "gpt-6-luna"]);
    const fresh = await h.turn(["task", "--to", "codex"], "new work", { COUNCIL_FAKE_CODEX_EDIT: "new.txt" });
    assert.equal(fresh.code, 0, fresh.err + fresh.out);
    assert.match(fresh.out, / · round 1\/9 · edited 1 · /);
    assert.deepEqual(h.calls().at(-1).argv.slice(4, 8), ["-C", h.cwd, "-s", "workspace-write"]);
    assert.ok(existsSync(join(h.repo, "new.txt")));
  } finally { h.done(); }
});

/** Each review target in each route; expected stdin is the core's target sentence plus the focus. */
test("review, both routes, every target: flags without focus; sentence plus focus on stdin with `-` and no flags", async () => {
  const h = harness();
  try {
    const sha = git(h.repo, ["rev-parse", "HEAD"]);
    git(h.repo, ["checkout", "-q", "-b", "topic"]);
    writeFileSync(join(h.repo, "calc.js"), "export const sum = (items) => { let s = 0; for (let i = 0; i <= items.length; i++) s += items[i]; return s; };\n");
    const topic = commitAll(h.repo, "topic");
    const dirty = () => writeFileSync(join(h.repo, "extra.js"), "export const x = 1;\n");
    const clean = () => rmSync(join(h.repo, "extra.js"), { force: true });
    const env = { COUNCIL_FAKE_SCENARIO: "review-findings" };
    const cases = [
      { name: "uncommitted", flags: ["--uncommitted"], setup: dirty, expect: ["--uncommitted"], opts: { uncommitted: true } },
      { name: "base", flags: ["--base", "main"], setup: clean, expect: ["--base", "main"], opts: { base: "main" } },
      { name: "commit", flags: ["--commit", topic], setup: clean, expect: ["--commit", topic], opts: { commit: topic } },
      { name: "implicit base", flags: [], setup: clean, expect: ["--base", "refs/heads/main"], opts: {} },
    ];
    for (const c of cases) {
      c.setup();
      h.clearLog();
      const unfocused = await h.call(["review", "--to", "codex", ...c.flags], { env });
      assert.equal(unfocused.code, 10, `${c.name}: ${unfocused.err}${unfocused.out}`);
      assert.match(unfocused.err, / target=/);
      assert.match(unfocused.out, /^Verdict: changes requested\. /);
      assert.match(unfocused.out, /\nF1 MAJOR <scratch>\/codex\/review-repo\/calc\.js:3: Stop iteration before the array length\n/);
      assert.match(unfocused.out, footer("needs attention", "gpt-6\\.1-sol", "high"));
      const [u] = h.calls();
      assert.deepEqual(u.argv.slice(0, 2 + c.expect.length), ["exec", "review", ...c.expect], c.name);
      assert.notEqual(u.argv.at(-1), "-");
      assert.ok(u.argv.includes("sandbox_mode=read-only") && u.argv.includes("review_model=gpt-6.1-sol"));
      const sentence = reviewTarget(h.cwd, c.opts).sentence;
      const focus = "Focus on loop bounds only.";
      h.clearLog();
      const focused = await h.call(["review", "--to", "codex", ...c.flags, "--", focus], { env: { ...env, COUNCIL_FAKE_EXPECT_PROMPT: `${sentence}\n\n${focus}` } });
      assert.equal(focused.code, 10, `${c.name} focused: ${focused.err}${focused.out}`);
      const [f] = h.calls();
      assert.deepEqual(f.argv.slice(0, 3), ["exec", "review", "--json"], `${c.name}: no target flags with a prompt`);
      assert.equal(f.argv.at(-1), "-");
      assert.ok(!f.argv.some((a) => ["--uncommitted", "--base", "--commit"].includes(a)));
    }
    assert.equal(sha.length, 40);
  } finally { h.done(); }
});

test("review output: malformed and prose-only answers are incomplete (10); --json carries verdict and findings", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.repo, "extra.js"), "export const x = 1;\n");
    for (const scenario of ["review-malformed", "ok"]) {
      const r = await h.call(["review", "--to", "codex", "--json"], { env: { COUNCIL_FAKE_SCENARIO: scenario } });
      assert.equal(r.code, 10, scenario);
      const j = JSON.parse(r.out);
      assert.deepEqual([j.verdict, j.findings, j.exit, j.status], ["incomplete", [], 10, "attention"], scenario);
      assert.match(j.answer, /^Verdict: incomplete \(no \[P0\]\/\[P1\] finding/);
      assert.match(j.answer, /Codex review output:\n\n/);
      assert.equal(j.round, null, "a review has no round");
    }
    const findings = JSON.parse((await h.call(["review", "--to", "codex", "--json"], { env: { COUNCIL_FAKE_SCENARIO: "review-findings" } })).out);
    assert.deepEqual([findings.verdict, findings.findings.length, findings.findings[0].severity, findings.findings[0].line], ["changes", 1, "MAJOR", 3]);
    assert.equal(findings.thread.length, 36, "the review's native thread is recorded");
    const reply = await h.call(["reply", "--thread", findings.job, "--", "x"]);
    assert.equal(reply.code, 2, "a review starts no thread to reply to");
  } finally { h.done(); }
});

test("COUNCIL_CODEX_MCP=off: one model process plus the discovery calls S1.1 recorded (2 with servers, 1 without); task makes none", async () => {
  const h = harness();
  try {
    const count = async (argv, text, env) => { h.clearLog(); const r = await h.turn(argv, text, env); assert.equal(r.code, 0, r.err + r.out); return h.calls(); };
    const withServers = await count(["ask", "--to", "codex"], "hi", { COUNCIL_CODEX_MCP: "off" });
    assert.deepEqual(withServers.map((c) => c.argv[0]), ["mcp", "mcp", "exec"]);
    const exec = withServers[2].argv;
    assert.deepEqual(exec.slice(exec.indexOf("--disable"), exec.indexOf("--disable") + 6).slice(0, 5), ["--disable", "plugins", "--disable", "apps", "-c"]);
    assert.ok(exec.some((a) => a.startsWith("mcp_servers={")));
    const job = h.jobOf((await h.turn(["ask", "--to", "codex"], "start")).err);
    const without = await count(["reply", "--thread", job], "again", { COUNCIL_CODEX_MCP: "off", COUNCIL_FAKE_MCP_SERVERS: "none", COUNCIL_FAKE_SCENARIO: "resume" });
    assert.deepEqual(without.map((c) => c.argv[0]), ["mcp", "exec"]);
    assert.equal((await count(["task", "--to", "codex"], "edit", { COUNCIL_CODEX_MCP: "off" })).length, 1, "task keeps the user's tools");
    assert.equal((await count(["ask", "--to", "codex"], "hi", {})).length, 1, "inherit (default)");
    h.clearLog();
    writeFileSync(join(h.repo, "extra.js"), "x\n");
    assert.equal((await h.call(["review", "--to", "codex"], { env: { COUNCIL_CODEX_MCP: "off", COUNCIL_FAKE_SCENARIO: "review-findings" } })).code, 10);
    assert.deepEqual(h.calls().map((c) => c.argv[0]), ["mcp", "mcp", "exec"]);
    const bad = await h.turn(["ask", "--to", "codex"], "hi", { COUNCIL_CODEX_MCP: "maybe" });
    assert.equal(bad.code, 2);
    assert.match(bad.err, /COUNCIL_CODEX_MCP must be inherit or off/);
  } finally { h.done(); }
});

test("ultra passes through on gpt-6.1-sol and exits 2 on gpt-6-luna; --adversarial and --web exit 2 before any job or spawn", async () => {
  const h = harness();
  try {
    const sol = await h.turn(["ask", "--to", "codex", "--model", "sol", "--effort", "ultra"], "think hard");
    assert.equal(sol.code, 0, sol.err + sol.out);
    assert.match(sol.out, footer("ok", "gpt-6\\.1-sol", "ultra"));
    assert.ok(h.calls()[0].argv.includes("model_reasoning_effort=ultra"));
    h.clearLog();
    const before = h.jobs().length;
    const refusals = [
      [["ask", "--to", "codex", "--model", "gpt-6-luna", "--effort", "ultra", "--", "x"], /ultra/],
      [["review", "--to", "codex", "--adversarial"], /no --adversarial/],
      [["ask", "--to", "codex", "--web", "--", "x"], /--web has no tested mapping for codex/],
      [["task", "--to", "codex", "--web", "--request-id", "w1", "--", "x"], /--web has no tested mapping for codex/],
    ];
    for (const [argv, message] of refusals) {
      const r = await h.call(argv);
      assert.equal(r.code, 2, argv.join(" "));
      assert.match(r.err, message);
    }
    assert.equal(h.jobs().length, before, "no job record");
    assert.equal(h.calls().length, 0, "no CLI started");
    assert.deepEqual(readdirSync(join(h.home, "claims", "requests")).filter((n) => !n.startsWith(".")), [], "the request id was released");
  } finally { h.done(); }
});

test("failed commands, a turn error, a deadline stop: exit codes and --json fields", async () => {
  const h = harness();
  try {
    const denied = JSON.parse((await h.turn(["ask", "--to", "codex", "--json"], "write a file", { COUNCIL_FAKE_SCENARIO: "denied" })).out);
    assert.equal(denied.exit, 0);
    assert.deepEqual(denied.failedCommands, [{ cmd: "printf hello > probe-denied.txt", exit: 1 }]);
    const effort = await h.turn(["ask", "--to", "codex"], "x", { COUNCIL_FAKE_SCENARIO: "effort-error" });
    assert.equal(effort.code, 1);
    assert.match(effort.out, /^council codex failed · .* · error: unsupported reasoning effort high for gpt-6\.1-sol/m);
    const slow = await h.turn(["ask", "--to", "codex", "--deadline", "1"], "take long", { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "20000" });
    assert.equal(slow.code, 1);
    assert.match(slow.out, /error: wall-clock deadline passed/);
    assert.doesNotMatch(slow.out, /cleanup pending/, "the stop found the fake through its -o operand and confirmed cleanup");
  } finally { h.done(); }
});

test("setup and models --refresh through the fake: launcher, version, login, MCP note, refreshed catalog", async () => {
  const h = harness();
  try {
    const setup = await h.call(["setup", "--to", "codex"]);
    assert.equal(setup.code, 0, setup.out);
    assert.match(setup.out, new RegExp(`^codex: ready · ${FAKE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(node-script\\) · codex-cli 0\\.163\\.0 · logged in\\n`));
    assert.match(setup.out, /\n {2}tiers: consult gpt-6\.1-sol\/high · exec gpt-6-luna\/max · deep gpt-6\.1-sol\/xhigh\n/);
    assert.match(setup.out, /\n {2}note: mcp: inherit \(default\): .* 19-29% fewer input tokens/);
    const off = await h.call(["setup", "--to", "codex", "--json"], { env: { COUNCIL_CODEX_MCP: "off" } });
    assert.match(JSON.parse(off.out)[0].notes[0], /^mcp: off for ask, reply and review/);
    const refresh = await h.call(["models", "--to", "codex", "--refresh"]);
    assert.equal(refresh.code, 0, refresh.out);
    assert.match(refresh.out, /^codex \(refreshed, refreshed /);
    assert.match(refresh.out, /\n {2}gpt-6\.1-sol: low, medium, high, xhigh, max, ultra\n/);
    const cached = JSON.parse(readFileSync(join(h.home, "catalog", "codex.json"), "utf8"));
    assert.equal(cached.version, "codex-cli 0.163.0");
    assert.equal(Object.keys(cached.models).length, 11);
  } finally { h.done(); }
});

test("a missing codex binary fails the turn with the setup hint and starts nothing", async () => {
  const h = harness();
  try {
    mkdirSync(join(h.root, "empty"));
    const r = await h.turn(["ask", "--to", "codex"], "x", { COUNCIL_CODEX_BIN: "", PATH: join(h.root, "empty") });
    assert.equal(r.code, 1);
    assert.match(r.out, /error: codex not found; run setup, or set COUNCIL_CODEX_BIN/);
  } finally { h.done(); }
});
