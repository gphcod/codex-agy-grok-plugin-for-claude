// S3.5: the codex adapter against the real `codex` CLI (costs quota; run by hand with `npm run test:live`,
// never by `npm test`). Every model call runs at --effort low in a throwaway Git repository with a
// temporary COUNCIL_HOME. Results are recorded in docs/qualification/codex-macos.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GUARD_VARS } from "../../plugins/council/scripts/lib/core/execution.mjs";
import { canonical } from "../../plugins/council/scripts/lib/core/fs.mjs";
import { commitAll, initRepo, isolateGit } from "../fixtures/build-repos.mjs";

isolateGit();
const COUNCIL = fileURLToPath(new URL("../../plugins/council/scripts/council.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "council-codex-live-"));
const repo = initRepo(join(root, "repo"));
writeFileSync(join(repo, "calc.js"), "export function sum(items) {\n  let s = 0;\n  for (let i = 0; i < items.length; i++) s += items[i];\n  return s;\n}\n");
commitAll(repo, "main");
const env = { ...process.env, COUNCIL_HOME: join(root, "home") };
for (const k of [...GUARD_VARS, "COUNCIL_CODEX_BIN", "COUNCIL_CODEX_MCP", "COUNCIL_TEST_NULL_ADAPTER"]) delete env[k];
const log = [];
const record = (name, r) => { log.push({ name, code: r.code, out: r.out.slice(-600), err: r.err.slice(-300) }); return r; };

function council(args, text = null, { timeoutMs = 300000 } = {}) {
  const r = spawnSync(process.execPath, [COUNCIL, ...args, ...(text === null ? [] : ["--", text])], { cwd: repo, env, input: "", encoding: "utf8", timeout: timeoutMs });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}
const jobOf = (s) => /job[= ]([a-z0-9]{16})/.exec(s)?.[1];

test.after(() => {
  writeFileSync(join(tmpdir(), "council-codex-live-results.json"), JSON.stringify(log, null, 2));
  rmSync(root, { recursive: true, force: true });
});

test("codex --version and debug models shape", () => {
  const v = spawnSync("codex", ["--version"], { encoding: "utf8" });
  assert.equal(v.status, 0);
  assert.match(v.stdout, /^codex-cli \d+\.\d+\.\d+/);
  const m = spawnSync("codex", ["debug", "models"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(m.status, 0);
  const listing = JSON.parse(m.stdout);
  assert.ok(Array.isArray(listing.models) && listing.models.length > 0);
  for (const model of listing.models) {
    assert.equal(typeof model.slug, "string");
    assert.ok(Array.isArray(model.supported_reasoning_levels));
  }
  log.push({ name: "version", out: v.stdout.trim(), models: listing.models.map((x) => x.slug) });
});

let askJob = null;
test("ask at --effort low, then reply on its thread", () => {
  const ask = record("ask", council(["ask", "--to", "codex", "--effort", "low"], "Reply with the single word pong."));
  assert.equal(ask.code, 0, ask.err + ask.out);
  assert.match(ask.out, /pong/i);
  assert.match(ask.out, /^council codex ok · job [a-z0-9]{16} · gpt-6\.1-sol\/low · .* · round 1\/9 · next: reply /m);
  askJob = jobOf(ask.err);
  const reply = record("reply", council(["reply", "--thread", askJob], "Now reply with the single word ping."));
  assert.equal(reply.code, 0, reply.err + reply.out);
  assert.match(reply.out, /ping/i);
  assert.match(reply.out, / · gpt-6\.1-sol\/low · .* · round 2\/9 · /);
});

test("review --uncommitted, unfocused and focused, on an off-by-one change", () => {
  writeFileSync(join(repo, "calc.js"), readFileSync(join(repo, "calc.js"), "utf8").replace("i < items.length", "i <= items.length"));
  for (const [name, text] of [["review-unfocused", null], ["review-focused", "Focus on loop bounds only."]]) {
    const r = record(name, council(["review", "--to", "codex", "--uncommitted", "--effort", "low", "--json"], text));
    assert.equal(r.code, 10, `${name}: ${r.err}${r.out}`);
    const j = JSON.parse(r.out);
    assert.ok(["changes", "incomplete"].includes(j.verdict), j.verdict);
    log.at(-1).verdict = j.verdict;
    log.at(-1).findings = j.findings.map((f) => `${f.severity} ${f.file}:${f.line} ${f.title}`);
  }
});

test("models --refresh --to codex and setup --to codex", () => {
  const models = record("models-refresh", council(["models", "--to", "codex", "--refresh"]));
  assert.equal(models.code, 0, models.out);
  assert.match(models.out, /^codex \(refreshed /);
  const setup = record("setup", council(["setup", "--to", "codex"]));
  assert.equal(setup.code, 0, setup.out);
  assert.match(setup.out, /^codex: ready · .* · codex-cli [\d.]+ · logged in\n/);
  assert.match(setup.out, /note: mcp: inherit \(default\)/);
});

test("cancel of a slow prompt stops the CLI and confirms cleanup", async () => {
  const child = spawn(process.execPath, [COUNCIL, "ask", "--to", "codex", "--effort", "low", "--", "Count slowly from 1 to 400, one number per line, explaining each."], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  for (const end = Date.now() + 60000; !jobOf(err); await new Promise((r) => setTimeout(r, 100))) assert.ok(Date.now() < end, "no start line");
  await new Promise((r) => setTimeout(r, 2000));
  const started = Date.now();
  const cancel = record("cancel", council(["cancel", jobOf(err)]));
  const code = await exited;
  log.at(-1).ms = Date.now() - started;
  log.at(-1).askExit = code;
  log.at(-1).askOut = out.slice(-300);
  assert.equal(cancel.code, 0, cancel.out + cancel.err);
  assert.equal(code, 1);
  assert.match(out, /^council codex cancelled · /m);
  const ps = spawnSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" }).stdout;
  assert.ok(!ps.includes(join(canonical(env.COUNCIL_HOME), "jobs", jobOf(err))), "no process keeps the job's -o operand");
});
