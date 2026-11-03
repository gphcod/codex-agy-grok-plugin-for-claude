// S6.0: the three adapters together, each against its fake, in one COUNCIL_HOME, one session and one
// workspace. Every call is a separate companion process (`node council.mjs …`), as Claude's Bash calls
// are. No test can start a real CLI (tests/fixtures/three-providers.mjs: wrapped fakes, trap PATH).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GUARD_VARS, ownedExecution, processSnapshot } from "../plugins/council/scripts/lib/core/execution.mjs";
import { createJob, listJobs, loadThread, markDone, prune, saveJob, stateOf } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { canonical } from "../plugins/council/scripts/lib/core/fs.mjs";
import codex from "../plugins/council/scripts/lib/providers/codex.mjs";
import gemini from "../plugins/council/scripts/lib/providers/gemini.mjs";
import grok, { RESUME_DENY } from "../plugins/council/scripts/lib/providers/grok.mjs";
import { PROVIDERS, SESSION, footer, harness } from "./fixtures/three-providers.mjs";

const ADAPTERS = { codex, gemini, grok };
const CONSULT = { codex: "gpt-6\\.1-sol/xhigh", gemini: "gemini-4-argon/medium", grok: "grok-4\\.7/high" };
const READ_ONLY_DENY = ["write_file(*)", "edit_file(*)", "command(*)", "unsandboxed(*)", "mcp(*)", "execute_url(*)"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const flag = (args, name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };

/** Waits until the companion recorded a running job with a child pid for each provider. */
async function runningJobs(h, providers, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    const jobs = listJobs(canonical(h.home)).filter((j) => j.session === SESSION && !j.done && j.pid && providers.includes(j.provider));
    if (providers.every((p) => jobs.some((j) => j.provider === p))) return Object.fromEntries(providers.map((p) => [p, jobs.find((j) => j.provider === p)]));
  }
  throw new Error(`jobs did not start for ${providers.join(", ")}`);
}

/** Seeds finished job bodies of another session, so prune has something to delete while the turns run. */
function seedFinished(h, n) {
  const home = canonical(h.home);
  for (let i = 0; i < n; i++) {
    const at = new Date(Date.now() - (10000 - i) * 1000).toISOString();
    const j = createJob(home, { provider: PROVIDERS[i % 3], verb: "ask", cwd: h.cwd, session: "seed", admitted: true, spawnedAt: at, admittedAt: at });
    Object.assign(j, { status: "done", outcome: "ok", code: 0, cleanupPending: false });
    saveJob(j); markDone(j);
  }
}

test("(a) three concurrent background asks: ownership is per job, prune and a post-exit scan spare the others; (b) bare wait lists all three; (c) reply inherits and locks each provider", async () => {
  const h = harness();
  try {
    seedFinished(h, 102);
    const slow = process.platform === "win32" ? { codex: "4000", gemini: "12000", grok: "12000" } : { codex: "1200", gemini: "5000", grok: "5000" }; // A Windows process query costs a second or more under load.
    const pending = Object.fromEntries(PROVIDERS.map((p) => [p, h.turn(p, ["ask", "--to", p], `brief for ${p}`, { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: slow[p] })]));
    const jobs = await runningJobs(h, PROVIDERS);
    // Ownership: each provider's evidence matches its own child and no other provider's.
    const snapshot = processSnapshot();
    assert.equal(snapshot.state, "ok");
    const pids = Object.fromEntries(PROVIDERS.map((p) => [p, jobs[p].pid]));
    for (const p of PROVIDERS) {
      const owned = ownedExecution(jobs[p], snapshot, process.platform, [], ADAPTERS[p]);
      const ownedPids = owned.rows.map((r) => r.pid);
      assert.ok(ownedPids.includes(pids[p]), `${p} owns its child`);
      for (const q of PROVIDERS.filter((x) => x !== p)) {
        assert.ok(!ownedPids.includes(pids[q]), `${p}'s evidence never matches ${q}'s child`);
        const row = snapshot.rows.find((r) => r.pid === pids[q]);
        assert.ok(row, `${q}'s child is in the snapshot`);
        assert.equal(Boolean(ADAPTERS[p].ownsProcess(row, jobs[p], process.platform)), false, `${p}.ownsProcess rejects ${q}'s child`);
      }
    }
    // Prune past the keep count while all three run: only finished bodies go.
    prune(canonical(h.home), 0);
    for (const p of PROVIDERS) assert.ok(existsSync(join(h.home, "jobs", jobs[p].id)), `prune keeps the running ${p} job`);
    assert.equal(listJobs(canonical(h.home)).filter((j) => j.session === "seed").length, 0, "every seeded finished body was pruned");
    // Codex finishes first; its post-exit scan runs while the other two children are still alive.
    const c = await pending.codex;
    assert.equal(c.code, 0, c.err + c.out);
    assert.match(footer(c.out), new RegExp(`^council codex ok · job ${jobs.codex.id} · ${CONSULT.codex} · `));
    assert.ok(alive(pids.gemini) && alive(pids.grok), "codex's post-exit scan stopped neither gemini's nor grok's child");
    for (const p of ["gemini", "grok"]) assert.equal(stateOf(h.job(jobs[p].id)), "running");
    for (const p of ["gemini", "grok"]) {
      const r = await pending[p];
      assert.equal(r.code, 0, `${p}: ${r.err}${r.out}`);
      assert.match(footer(r.out), new RegExp(`^council ${p} ok · job ${jobs[p].id} · ${CONSULT[p]} · .* · round 1/9$`));
    }
    assert.equal(h.invocations().length, 3, "three model processes, nothing else");
    for (const call of h.invocations()) assert.deepEqual(call.guards, GUARD_VARS, `${call.provider} child carries the four guard variables`);

    // (b) bare wait lists this session's three jobs, one per provider.
    const list = await h.run(["wait", "--session", SESSION]);
    assert.equal(list.code, 0, list.err);
    const rows = list.out.trim().split("\n");
    assert.equal(rows.length, 3, list.out);
    for (const p of PROVIDERS) assert.ok(rows.some((r) => r.startsWith(`${jobs[p].id} · ${p} · done · `)), `${p} row: ${list.out}`);

    // (c) reply --thread <job>: provider inherited (no --to), model and effort inherited, round 2; a conflicting --to exits 2.
    for (const p of PROVIDERS) {
      const reply = await h.turn(p, ["reply", "--thread", jobs[p].id], `follow up ${p}`, { COUNCIL_FAKE_SCENARIO: "resume" });
      assert.equal(reply.code, 0, `${p}: ${reply.err}${reply.out}`);
      assert.match(reply.err, new RegExp(`^\\[council\\] provider=${p} job=${reply.job}`));
      assert.match(footer(reply.out), new RegExp(`^council ${p} ok · job ${reply.job} · ${CONSULT[p]} · .* · round 2/9$`));
      for (const other of PROVIDERS.filter((x) => x !== p)) {
        const before = h.invocations().length;
        const conflict = await h.turn(p, ["reply", "--thread", jobs[p].id, "--to", other], "x");
        assert.equal(conflict.code, 2, conflict.err);
        assert.match(conflict.err, new RegExp(`belongs to ${p}; --to ${other} conflicts`));
        assert.equal(h.invocations().length, before, "a refused reply starts nothing");
      }
    }
  } finally { h.done(); }
});

test("(d) reply after a task is read-only on all three providers: -s read-only, RESUME_DENY, deny settings", async () => {
  const h = harness();
  try {
    for (const p of PROVIDERS) {
      const task = await h.turn(p, ["task", "--to", p], `edit for ${p}`);
      assert.equal(task.code, 0, `${p} task: ${task.err}${task.out}`);
      assert.equal(h.job(task.job).readOnly, false);
      const reply = await h.turn(p, ["reply", "--thread", task.job], `explain ${p}`, { COUNCIL_FAKE_SCENARIO: "resume" });
      assert.equal(reply.code, 0, `${p} reply: ${reply.err}${reply.out}`);
      const t = h.job(task.job), r = h.job(reply.job);
      assert.equal(r.readOnly, true, `${p} reply is read-only`);
      assert.equal(r.threadId, t.threadId, `${p} reply resumes the task's thread`);
      if (p === "codex") {
        assert.equal(flag(t.childArgs, "-s"), "workspace-write");
        assert.deepEqual(r.childArgs.slice(0, 3), ["exec", "resume", t.threadId]);
        assert.ok(r.childArgs.includes("sandbox_mode=read-only") && !r.childArgs.includes("sandbox_mode=workspace-write"));
      } else if (p === "grok") {
        assert.equal(flag(r.childArgs, "-r"), t.threadId);
        assert.equal(flag(r.childArgs, "--disallowed-tools"), RESUME_DENY.join(","));
        assert.ok(r.childArgs.includes("--deny") && flag(r.childArgs, "--deny") === "MCPTool(*)");
        assert.equal(loadThread(canonical(h.home), "grok", t.threadId).agent, "default");
      } else {
        assert.equal(flag(t.childArgs, "--mode"), "accept-edits");
        assert.equal(flag(r.childArgs, "--mode"), undefined, "no accept-edits on a reply");
        assert.equal(flag(r.childArgs, "--conversation"), t.threadId);
        const settings = JSON.parse(readFileSync(join(h.home, "jobs", reply.job, "settings.json"), "utf8"));
        for (const rule of READ_ONLY_DENY) assert.ok(settings.permissions.deny.includes(rule), `gemini reply denies ${rule}`);
      }
    }
  } finally { h.done(); }
});

test("(e) models --refresh and setup across all three; every probe child carries the four guard variables", async () => {
  const h = harness();
  try {
    const models = await h.run(["models", "--refresh"]);
    assert.equal(models.code, 0, models.err + models.out);
    for (const p of PROVIDERS) assert.match(models.out, new RegExp(`^${p} \\(refreshed [^,()]+\\)$`, "m"), models.out);
    for (const p of PROVIDERS) assert.ok(existsSync(join(h.home, "catalog", `${p}.json`)), `${p} catalog cached`);
    const setup = await h.run(["setup"]);
    assert.equal(setup.code, 0, setup.err + setup.out);
    for (const p of PROVIDERS) assert.match(setup.out, new RegExp(`^${p}: ready · ${h.root.replace(/\\/g, "\\\\")}[\\\\/]wrap-${p}\\.mjs \\(node-script\\) · .* · logged in$`, "m"), setup.out);
    assert.match(setup.out, /note: mcp: inherit \(default\)/, "codex states its MCP trade-off");
    assert.match(setup.out, /note: .*search_web/i, "gemini states the web-search trade-off");
    const probes = h.invocations();
    for (const p of PROVIDERS) assert.ok(probes.some((c) => c.provider === p), `${p} probed`);
    for (const c of probes) assert.deepEqual(c.guards, GUARD_VARS, `${c.provider} ${c.argv.join(" ")} carries the four guard variables`);
    assert.equal(h.jobIds().length, 0, "models and setup create no job");
  } finally { h.done(); }
});

test("(f) replay and cancellation of one provider's job leave the others untouched", async () => {
  const h = harness();
  try {
    const rid = { codex: "intC0001", gemini: "intG0001", grok: "intK0001" };
    const argv = (p) => ["ask", "--to", p, "--request-id", rid[p]];
    const env = { COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: process.platform === "win32" ? "15000" : "4000" }; // A Windows cancel takes seconds under load.
    const pending = Object.fromEntries(PROVIDERS.map((p) => [p, h.turn(p, argv(p), `fan-out brief`, env)]));
    const jobs = await runningJobs(h, PROVIDERS);
    const cancel = await h.run(["cancel", jobs.grok.id, "--session", SESSION]);
    assert.equal(cancel.code, 0, cancel.err + cancel.out);
    assert.match(cancel.out, new RegExp(`^cancelled · grok · job ${jobs.grok.id}`));
    assert.ok(!alive(jobs.grok.pid), "grok's child is stopped");
    assert.ok(alive(jobs.codex.pid) && alive(jobs.gemini.pid), "cancelling grok leaves codex's and gemini's children running");
    const k = await pending.grok;
    assert.equal(k.code, 1);
    assert.match(footer(k.out), new RegExp(`^council grok cancelled · job ${jobs.grok.id} · `));
    const first = {};
    for (const p of ["codex", "gemini"]) {
      first[p] = await pending[p];
      assert.equal(first[p].code, 0, `${p}: ${first[p].err}${first[p].out}`);
      assert.match(footer(first[p].out), new RegExp(`^council ${p} ok · job ${jobs[p].id} · `));
    }
    // Replays: the same request ids return the first results and start nothing.
    const spawned = h.invocations().length;
    assert.equal(spawned, 3);
    for (const p of PROVIDERS) {
      const again = await h.turn(p, argv(p), `fan-out brief`, env);
      assert.equal(again.job, jobs[p].id, `${p} replays its own job`);
      if (p === "grok") {
        assert.equal(again.code, 1, "the cancelled grok result replays as cancelled");
        assert.match(footer(again.out), / · error: cancelled/);
      } else {
        assert.equal(again.code, 0, `${p}: ${again.err}${again.out}`);
        assert.equal(again.out, first[p].out, `${p} replay prints the first result`);
      }
    }
    assert.equal(h.invocations().length, spawned, "no replay started a CLI");
    // The surviving threads stay usable after the cancel.
    for (const p of ["codex", "gemini"]) {
      const reply = await h.turn(p, ["reply", "--thread", jobs[p].id], "next", { COUNCIL_FAKE_SCENARIO: "resume" });
      assert.equal(reply.code, 0, `${p}: ${reply.err}${reply.out}`);
    }
  } finally { h.done(); }
});

test("adapter-era rules: refusals before any job, denials, the unconfirmed-session rule, incomplete reviews keep output", async () => {
  const h = harness();
  try {
    // Refusals: exit 2 before any job record, binding or spawn.
    for (const [argv, text] of [[["review", "--to", "codex", "--adversarial"], null], [["ask", "--to", "codex", "--web"], "x"], [["ask", "--to", "gemini", "--web"], "x"]]) {
      const r = await h.run([...argv, "--session", SESSION, "--request-id", "refuse01", ...(text ? ["--", text] : [])]);
      assert.equal(r.code, 2, `${argv.join(" ")}: ${r.err}`);
      assert.equal(h.jobIds().length, 0, `${argv.join(" ")} left no job`);
      assert.ok(!existsSync(join(h.home, "claims", "requests")) || readdirSync(join(h.home, "claims", "requests")).length === 0, `${argv.join(" ")} left no request binding`);
    }
    assert.equal(h.invocations().length, 0, "no refusal started a CLI");

    // Denials need attention (10) on all three: codex's sandbox refusal, gemini's deny-rule signature and
    // Grok's own `cancelled` stop (S4.9). Council's read-only tool guard is not a denial: a forbidden
    // tool call on a read-only grok turn fails closed (1).
    const codexDenied = await h.turn("codex", ["ask", "--to", "codex"], "write a file", { COUNCIL_FAKE_SCENARIO: "denied" });
    assert.equal(codexDenied.code, 10, codexDenied.err + codexDenied.out);
    assert.match(footer(codexDenied.out), /^council codex needs attention · /);
    const geminiDenied = await h.turn("gemini", ["ask", "--to", "gemini"], "write a file", { COUNCIL_FAKE_SCENARIO: "denied" });
    assert.equal(geminiDenied.code, 10, geminiDenied.err + geminiDenied.out);
    assert.match(footer(geminiDenied.out), /^council gemini needs attention · /);
    const grokDenied = await h.turn("grok", ["ask", "--to", "grok"], "push it", { COUNCIL_FAKE_GROK_END: "cancelled" });
    assert.equal(grokDenied.code, 10, grokDenied.err + grokDenied.out);
    assert.match(footer(grokDenied.out), /^council grok needs attention · /);
    const grokGuard = await h.turn("grok", ["ask", "--to", "grok"], "write a file", { COUNCIL_FAKE_SCENARIO: "denied" });
    assert.equal(grokGuard.code, 1, grokGuard.err + grokGuard.out);
    assert.match(footer(grokGuard.out), /^council grok failed · .*read-only tool guard failed/);

    // Unconfirmed session (grok): the answer and exit 0 stand, the thread is not resumable; other providers' threads are unaffected.
    const ask = await h.turn("codex", ["ask", "--to", "codex"], "codex thread");
    assert.equal(ask.code, 0, ask.err + ask.out);
    const unconfirmed = await h.turn("grok", ["ask", "--to", "grok"], "grok thread", { COUNCIL_FAKE_GROK_END: "no-session" });
    assert.equal(unconfirmed.code, 0, unconfirmed.err + unconfirmed.out);
    assert.match(footer(unconfirmed.out), / · session not confirmed: start a new ask$/);
    const refused = await h.turn("grok", ["reply", "--thread", unconfirmed.job], "more", { COUNCIL_FAKE_SCENARIO: "resume" });
    assert.equal(refused.code, 2);
    assert.match(refused.err, /session not confirmed: start a new ask/);
    const codexReply = await h.turn("codex", ["reply", "--thread", ask.job], "more", { COUNCIL_FAKE_SCENARIO: "resume" });
    assert.equal(codexReply.code, 0, codexReply.err + codexReply.out);

    // Incomplete reviews keep their output: a clean codex review is incomplete (10) with codex's text;
    // grok max-turns and an agy print timeout exit 1 with the review's findings or partial text kept.
    writeFileSync(join(h.repo, "calc.js"), "export const sum = (items) => { let s = 0; for (let i = 0; i <= items.length; i++) s += items[i]; return s; };\n");
    const clean = await h.run(["review", "--to", "codex", "--uncommitted", "--session", SESSION, "--json"], { COUNCIL_FAKE_SCENARIO: "ok" });
    assert.equal(clean.code, 10, clean.err + clean.out);
    const cj = JSON.parse(clean.out);
    assert.equal(cj.verdict, "incomplete");
    assert.match(cj.answer, /^Verdict: incomplete \(codex reported no findings; its output cannot prove a clean review\)\.[\s\S]*Codex review output:\n\n\S/);
    const grokReview = await h.run(["review", "--to", "grok", "--uncommitted", "--session", SESSION, "--json"], { COUNCIL_FAKE_SCENARIO: "review-findings", COUNCIL_FAKE_EXPECT_PROMPT_CONTAINS: "calc.js", COUNCIL_FAKE_GROK_END: "max-turns" });
    assert.equal(grokReview.code, 1, grokReview.err + grokReview.out);
    const gj = JSON.parse(grokReview.out);
    assert.equal(gj.verdict, "incomplete");
    assert.match(gj.answer, /^Verdict: incomplete \(incomplete: Grok stopped: max turns reached\)\./);
    assert.ok(gj.findings.length > 0, "the structured findings are kept");
    const agyReview = await h.run(["review", "--to", "gemini", "--uncommitted", "--session", SESSION, "--json"], { COUNCIL_FAKE_SCENARIO: "ok", COUNCIL_FAKE_EXPECT_PROMPT_CONTAINS: "calc.js", COUNCIL_FAKE_AGY_RESULT: "print-timeout" });
    assert.equal(agyReview.code, 1, agyReview.err + agyReview.out);
    const aj = JSON.parse(agyReview.out);
    assert.equal(aj.verdict, "incomplete");
    assert.match(aj.error, /print timeout/i);
    assert.match(aj.answer, /pong/, "the partial review text is kept");
  } finally { h.done(); }
});
