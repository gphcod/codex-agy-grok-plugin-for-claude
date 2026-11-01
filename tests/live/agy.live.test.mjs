// S5.6: live contract tests against the real `agy` CLI (excluded from `npm test`; run with
// `node --test tests/live/agy.live.test.mjs`). Costs quota: council turns run at --effort low with a
// short prompt in a throwaway scratch repository and a temporary COUNCIL_HOME; the effort matrix
// repeats the S1.2 cases on gemini-3.8-flash. The user's real HOME is kept because agy reads its
// sign-in there; council only reads the global settings file. Recorded in
// docs/qualification/gemini-macos.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GUARD_VARS } from "../../plugins/council/scripts/lib/core/execution.mjs";
import { READ_ONLY_DENY } from "../../plugins/council/scripts/lib/providers/gemini.mjs";
import { commitAll, initRepo, isolateGit } from "../fixtures/build-repos.mjs";

isolateGit();
const COUNCIL = fileURLToPath(new URL("../../plugins/council/scripts/council.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "council-agy-live-"));
const home = join(root, "council");
const repo = initRepo(join(root, "repo"));
writeFileSync(join(repo, "calc.js"), "export function sum(items) {\n  let total = 0;\n  for (let i = 0; i < items.length; i++) total += items[i];\n  return total;\n}\n");
commitAll(repo, "init");
const env = { ...process.env, COUNCIL_HOME: home };
for (const k of [...GUARD_VARS, "COUNCIL_AGY_BIN", "COUNCIL_TEST_NULL_ADAPTER"]) delete env[k];
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
  const text = `# live log\n${log.map((l) => `# ${l.code} ${l.ms}ms ${l.args}\n#   ${l.footer}`).join("\n")}\n`;
  process.stdout.write(text);
  if (process.env.COUNCIL_LIVE_LOG) writeFileSync(process.env.COUNCIL_LIVE_LOG, text);
  rmSync(root, { recursive: true, force: true });
});

test("agy --version and agy models", () => {
  const v = spawnSync("agy", ["--version"], { encoding: "utf8" });
  assert.equal(v.status, 0);
  assert.match(v.stdout, /^\d+\.\d+\.\d+/);
  const m = spawnSync("agy", ["models"], { encoding: "utf8", timeout: 30000 });
  assert.equal(m.status, 0, m.stderr);
  assert.match(m.stdout, /^gemini-4-argon-(low|medium|high)\t/m);
  assert.match(m.stdout, /^gemini-3\.8-flash-(low|medium|high)\t/m);
});

let askJob = null;
test("ask --effort low prints pong and the gemini-4-argon/low footer", () => {
  const r = council(["ask", "--to", "gemini", "--effort", "low", "--session", "live", "--", "Reply with the single word pong."]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /pong/i);
  assert.match(footer(r.out), /^council gemini ok · job [a-z0-9]{16} · gemini-4-argon\/low · \d+s · round 1\/9 · next: reply [a-z0-9]{16}$/);
  const settings = JSON.parse(readFileSync(join(home, "jobs", r.job, "settings.json"), "utf8"));
  for (const rule of READ_ONLY_DENY) assert.ok(settings.permissions.deny.includes(rule), rule);
  askJob = r.job;
});

test("reply on the same conversation", () => {
  assert.ok(askJob, "needs the ask");
  const r = council(["reply", "--thread", askJob, "--effort", "low", "--", "Reply with the single word again."]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /again/i);
  assert.match(footer(r.out), /^council gemini ok · .*gemini-4-argon\/low · .* · round 2\/9 · next: reply /);
});

test("review --uncommitted on a one-line bug", () => {
  writeFileSync(join(repo, "calc.js"), readFileSync(join(repo, "calc.js"), "utf8").replace("i < items.length", "i <= items.length"));
  const r = council(["review", "--to", "gemini", "--uncommitted", "--effort", "low"]);
  assert.ok([0, 10].includes(r.code), r.out + r.err);
  assert.match(r.out, /^Verdict: (approve|changes requested|incomplete)/);
  assert.match(footer(r.out), /^council gemini (ok|needs attention) · job [a-z0-9]{16} · gemini-4-argon\/low · /);
});

test("models --refresh --to gemini and setup --to gemini", () => {
  const m = council(["models", "--to", "gemini", "--refresh"]);
  assert.equal(m.code, 0, m.out + m.err);
  assert.match(m.out, /^gemini \(refreshed/m);
  assert.match(m.out, /gemini-4-argon: low, medium, high/);
  const s = council(["setup", "--to", "gemini"]);
  assert.equal(s.code, 0, s.out + s.err);
  assert.match(s.out, /^gemini: ready · .* \(native\) · \d+\.\d+\.\d+ · logged in$/m);
  assert.match(s.out, /^  note: web search stays available/m);
  assert.doesNotMatch(s.out, /warning:/);
});

test("cancel stops a running turn", async () => {
  const started = Date.now();
  const child = spawn(process.execPath, [COUNCIL, "ask", "--to", "gemini", "--effort", "low", "--session", "live", "--", "Write the numbers from 1 to 3000 in words, one per line."], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
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
  assert.match(footer(out), /^council gemini cancelled · /);
  log.push({ args: `(cancelled ask ${job})`, code, ms: Date.now() - started, footer: footer(out) });
});

// S1.2 effort matrix, straight against agy (council refuses a suffix conflict and clamps xhigh/max
// itself, so these cases never reach agy through council).
function agyTurn(model, effort) {
  const dir = mkdtempSync(join(root, "effort-"));
  const settings = join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify({ permissions: { deny: READ_ONLY_DENY } }));
  const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands", "--print-timeout", "120s", "--sandbox", "--settings", settings, "--model", model, ...(effort ? ["--effort", effort] : [])];
  const started = Date.now();
  const r = spawnSync("agy", args, { cwd: repo, input: `${JSON.stringify({ event: "user", message: { content: "Reply with the single word pong." } })}\n`, encoding: "utf8", timeout: 180000 });
  const result = r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.event === "result")?.result ?? null;
  log.push({ args: `agy --model ${model} --effort ${effort}`, code: r.status, ms: Date.now() - started, footer: result ? `${result.status} ${result.error ?? result.response.trim()}` : "(no result)" });
  return { code: r.status, result };
}

test("effort matrix (S1.2): suffix conflict, suffix with equal effort, family with high, family with xhigh/max", () => {
  const conflict = agyTurn("gemini-3.8-flash-low", "high");
  assert.equal(conflict.code, 1);
  assert.match(conflict.result.error, /invalid model selection .*conflicts with --effort=high/);
  const equal = agyTurn("gemini-3.8-flash-high", "high");
  assert.equal(equal.code, 0);
  assert.equal(equal.result.status, "SUCCESS");
  const family = agyTurn("gemini-3.8-flash", "high");
  assert.equal(family.code, 0);
  assert.equal(family.result.status, "SUCCESS");
  for (const effort of ["xhigh", "max"]) {
    const r = agyTurn("gemini-3.8-flash", effort);
    assert.equal(r.code, 1, effort);
    assert.match(r.result.error, new RegExp(`has no "${effort}" effort`), effort);
  }
});
