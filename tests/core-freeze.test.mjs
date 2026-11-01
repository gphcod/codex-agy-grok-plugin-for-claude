// S2.7: what the freeze covers stays as frozen — the A5 adapter shape the core relies on (checked
// against the null adapter, which every core test runs through), exit codes, the state layout a turn
// leaves behind, the provider registry, and contract.md plus both templates free of unresolved
// placeholders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { EXIT } from "../plugins/council/scripts/lib/core/types.mjs";
import { PLUGIN_ROOT } from "../plugins/council/scripts/lib/core/catalog.mjs";
import { PLACEHOLDERS, TEMPLATES, interpolate, loadTemplate, placeholders } from "../plugins/council/scripts/lib/core/review.mjs";
import { adapterFile, main } from "../plugins/council/scripts/council.mjs";
import { GUARD_VARS } from "../plugins/council/scripts/lib/core/execution.mjs";
import nullAdapter from "./fixtures/null-adapter.mjs";

test("exit codes are the A3.4 set", () => {
  assert.deepEqual({ ...EXIT }, { OK: 0, ATTENTION: 10, RUNNING: 20, FAILED: 1, USAGE: 2 });
  assert.ok(Object.isFrozen(EXIT));
});

test("the null adapter implements every A5 member with the frozen shapes", () => {
  for (const [key, type] of Object.entries({ id: "string", binEnv: "string", resolveLauncher: "function", trustsCleanExit: "function", ownsProcess: "function", maxLineBytes: "number", probe: "function", catalog: "object", buildTurn: "function", parseEvent: "function", reviewPlan: "function", finalizeReview: "function" })) {
    assert.equal(typeof nullAdapter[key], type, key);
  }
  const launcher = nullAdapter.resolveLauncher(process.env, process.platform);
  for (const key of ["args", "command", "kind", "path"]) assert.ok(key in launcher, key);
  assert.equal(typeof nullAdapter.trustsCleanExit(launcher), "boolean");
  const probe = nullAdapter.probe(launcher);
  assert.deepEqual(Object.keys(probe).sort(), ["loggedIn", "models", "version"]);
  const dir = mkdtempSync(join(tmpdir(), "council-freeze-"));
  try {
    const turn = nullAdapter.buildTurn({ verb: "ask", jobId: "abcdefghij123456", jobDir: dir, model: "null-model", effort: "high", text: "t", contract: "c", thread: null, readOnly: true });
    for (const key of ["args", "env", "answerFile", "readOnly", "contractCarrier"]) assert.ok(key in turn, key);
    assert.ok("stdin" in turn || "promptFile" in turn, "stdin or promptFile");
    const plan = nullAdapter.reviewPlan({ root: dir, target: null, collect: () => ({}) }, { adversarial: true });
    assert.deepEqual(plan, { native: false, template: "adversarial-review", schemaCarrier: "none" }, "the core collects the diff; the plan names the template");
    const result = nullAdapter.finalizeReview({ answerText: "", structured: null, unreviewed: [] });
    assert.deepEqual(["coverage", "findings", "incomplete", "verdict"].every((k) => k in result), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the provider registry: lib/providers/<id>.mjs by existsSync; none of the three exists before S3–S5", () => {
  for (const p of ["codex", "gemini", "grok"]) {
    assert.equal(adapterFile(p, {}), join(PLUGIN_ROOT, "scripts", "lib", "providers", `${p}.mjs`));
  }
  assert.equal(adapterFile("null", {}), null, "the null adapter only in test mode");
  assert.ok(existsSync(adapterFile("null", { COUNCIL_TEST_NULL_ADAPTER: "1" })));
});

test("state layout after one turn: jobs/<16 chars>/{meta.json,beat,done,answer.md,events.jsonl}, claims/, threads/<provider>-<id>.json", async () => {
  const root = mkdtempSync(join(tmpdir(), "council-layout-"));
  try {
    const env = { ...process.env, COUNCIL_TEST_NULL_ADAPTER: "1", COUNCIL_HOME: join(root, "home") };
    for (const g of GUARD_VARS) delete env[g];
    mkdirSync(join(root, "work"));
    const stdin = new PassThrough(); stdin.end("");
    let out = "";
    const code = await main(["ask", "--to", "null", "--request-id", "layout", "--", "hi"], env, { stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} }, stdin, cwd: join(root, "work") });
    assert.equal(code, 0, out);
    const home = join(root, "home");
    assert.deepEqual(readdirSync(home).sort(), ["claims", "jobs", "threads"]);
    const [job] = readdirSync(join(home, "jobs"));
    assert.match(job, /^[0-9a-f]{16}$/);
    assert.deepEqual(readdirSync(join(home, "jobs", job)).sort(), ["answer.md", "beat", "done", "events.jsonl", "meta.json", "request.json"]);
    assert.deepEqual(readdirSync(join(home, "claims")).sort(), ["null", "requests"]);
    assert.deepEqual(readdirSync(join(home, "claims", "null")), [], "the thread claim was released");
    assert.deepEqual(readdirSync(join(home, "claims", "requests")), [`${job}.json`], "the immutable tombstone");
    const [thread] = readdirSync(join(home, "threads"));
    assert.match(thread, /^null-[0-9a-f-]{36}\.json$/);
    const meta = JSON.parse(readFileSync(join(home, "jobs", job, "meta.json"), "utf8"));
    for (const k of ["provider", "verb", "cwd", "session", "threadId", "model", "effort", "requestedEffort", "tier", "round", "rounds", "companionPid", "companionIdentity", "childArgs", "argv", "launcher", "turn", "outcome", "code"]) assert.ok(k in meta, k);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("contract.md and both templates exist and contain no unresolved placeholder", () => {
  const contract = readFileSync(join(PLUGIN_ROOT, "contract.md"), "utf8");
  assert.deepEqual(placeholders(contract), []);
  for (const name of TEMPLATES) {
    const t = loadTemplate(name);
    assert.ok(placeholders(t).every((p) => PLACEHOLDERS.includes(p)), `${name}: only known placeholders`);
    assert.deepEqual(placeholders(interpolate(t, Object.fromEntries(PLACEHOLDERS.map((k) => [k, "v"])))), []);
  }
});
