// S4.6: live contract tests against the real `grok` CLI (excluded from `npm test`; run with
// `node --test tests/live/grok.live.test.mjs`). Costs money: every turn runs at --effort low with a
// short prompt in a throwaway scratch repository and a temporary COUNCIL_HOME. Results are recorded in
// docs/qualification/grok-macos.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GUARD_VARS } from "../../plugins/council/scripts/lib/core/execution.mjs";
import { commitAll, initRepo, isolateGit } from "../fixtures/build-repos.mjs";

isolateGit();
const COUNCIL = fileURLToPath(new URL("../../plugins/council/scripts/council.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "council-grok-live-"));
const home = join(root, "home");
const repo = initRepo(join(root, "repo"));
writeFileSync(join(repo, "calc.js"), "export function sum(items) {\n  let total = 0;\n  for (let i = 0; i < items.length; i++) total += items[i];\n  return total;\n}\n");
commitAll(repo, "init");
const env = { ...process.env, COUNCIL_HOME: home };
for (const k of [...GUARD_VARS, "COUNCIL_GROK_BIN", "COUNCIL_TEST_NULL_ADAPTER"]) delete env[k];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];

function council(args, { input = "" } = {}) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [COUNCIL, ...args], { cwd: repo, env, input, encoding: "utf8", timeout: 300000 });
  log.push({ args: args.join(" "), code: r.status, ms: Date.now() - started, footer: r.stdout.trim().split("\n").at(-1) });
  return { code: r.status, out: r.stdout, err: r.stderr, job: /job[= ]([a-z0-9]{16})/.exec(r.stderr + r.stdout)?.[1] };
}
const footer = (out) => out.trim().split("\n").at(-1);

test.after(() => {
  const text = `# live log\n${log.map((l) => `# ${l.code} ${l.ms}ms council ${l.args}\n#   ${l.footer}`).join("\n")}\n`;
  process.stdout.write(text);
  if (process.env.COUNCIL_LIVE_LOG) writeFileSync(process.env.COUNCIL_LIVE_LOG, text);
  rmSync(root, { recursive: true, force: true });
});

test("grok --version and grok models", () => {
  const v = spawnSync("grok", ["--version"], { encoding: "utf8" });
  assert.equal(v.status, 0);
  assert.match(v.stdout, /^grok \d+\.\d+\.\d+/);
  const m = spawnSync("grok", ["models"], { encoding: "utf8", timeout: 30000 });
  assert.equal(m.status, 0);
  assert.match(m.stdout, /logged in/i);
  assert.match(m.stdout, /grok-4\.7/);
});

let askJob = null;
test("ask --effort low prints pong and the grok-4.7/low footer", () => {
  const r = council(["ask", "--to", "grok", "--model", "grok-4.7", "--effort", "low", "--session", "live", "--", "Reply with the single word pong."]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /pong/i);
  assert.match(footer(r.out), /^council grok ok · job [a-z0-9]{16} · grok-4\.7\/low · \d+s · round 1\/9 · next: reply [a-z0-9]{16}$/);
  askJob = r.job;
});

test("reply on the same session", () => {
  assert.ok(askJob, "needs the ask");
  const r = council(["reply", "--thread", askJob, "--effort", "low", "--", "Reply with the single word again."]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /again/i);
  assert.match(footer(r.out), /^council grok ok · .* · round 2\/9 · next: reply /);
});

test("review --uncommitted on a one-line bug", () => {
  writeFileSync(join(repo, "calc.js"), readFileSync(join(repo, "calc.js"), "utf8").replace("i < items.length", "i <= items.length"));
  const r = council(["review", "--to", "grok", "--uncommitted", "--effort", "low"]);
  assert.ok([0, 10].includes(r.code), r.out + r.err);
  assert.match(r.out, /^Verdict: (approve|changes requested|incomplete)/);
  assert.match(footer(r.out), /^council grok (ok|needs attention) · job [a-z0-9]{16} · grok-4\.7\/low · /);
});

test("models --refresh --to grok and setup --to grok", () => {
  const m = council(["models", "--to", "grok", "--refresh"]);
  assert.equal(m.code, 0, m.out + m.err);
  assert.match(m.out, /^grok \(refreshed/m);
  assert.match(m.out, /grok-4\.7: low, medium, high, xhigh/);
  const s = council(["setup", "--to", "grok"]);
  assert.equal(s.code, 0, s.out + s.err);
  assert.match(s.out, /^grok: ready · .* \(native\) · grok \d/m);
});

test("cancel stops a running turn", async () => {
  const started = Date.now();
  const child = spawn(process.execPath, [COUNCIL, "ask", "--to", "grok", "--effort", "low", "--session", "live", "--", "Write the numbers from 1 to 3000 in words, one per line."], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  const exited = new Promise((r) => child.on("close", (code) => r(code)));
  let job = null;
  for (let i = 0; i < 200 && !job; i++) {
    await sleep(100);
    try { job = readdirSync(join(home, "jobs")).find((id) => { try { const m = JSON.parse(readFileSync(join(home, "jobs", id, "meta.json"), "utf8")); return m.pid && !m.done && m.verb === "ask" && Date.parse(m.spawnedAt) >= started - 1000; } catch { return false; } }); } catch { /* not yet */ }
  }
  assert.ok(job, "the turn started");
  await sleep(2000);
  const c = council(["cancel", job]);
  assert.equal(c.code, 0, c.out + c.err);
  const code = await exited;
  assert.equal(code, 1);
  assert.match(footer(out), /^council grok cancelled · /);
  log.push({ args: `(cancelled ask ${job})`, code, ms: Date.now() - started, footer: footer(out) });
});
