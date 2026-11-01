// S5: Gemini adapter against tests/fixtures/fake-agy.mjs (PLAN.md S5.1-S5.5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import gemini, { BINARIES, MAX_FRAME_BYTES, WINDOWS_UNSUPPORTED, checkGeminiRequest, globalSettingsPath, modelArgs, printTimeout, probeAgy, readGlobalPolicy, sessionSettings, settingsPathOf } from "../plugins/council/scripts/lib/providers/gemini.mjs";
import { UsageError } from "../plugins/council/scripts/lib/core/args.mjs";
import { PLUGIN_ROOT } from "../plugins/council/scripts/lib/core/catalog.mjs";
import { fixturesDir, GUARD_VARS } from "./fixtures/fake-common.mjs";
import { main } from "../plugins/council/scripts/council.mjs";

const FAKE_AGY = join(fixturesDir, "fake-agy.mjs");
const CONTRACT = readFileSync(join(PLUGIN_ROOT, "contract.md"), "utf8").replace(/\r\n?/g, "\n").trim();
const SCHEMA_PATH = join(PLUGIN_ROOT, "schemas", "review-output.schema.json");
const READ_ONLY_DENY = ["write_file(*)", "edit_file(*)", "command(*)", "unsandboxed(*)", "mcp(*)", "execute_url(*)"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function fakeLauncher() {
  return { command: process.execPath, args: [FAKE_AGY], path: FAKE_AGY, kind: "node-script" };
}

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "council-gemini-"));
  const done = () => rmSync(dir, { recursive: true, force: true });
  let out;
  try { out = fn(dir); } catch (error) { done(); throw error; }
  if (out && typeof out.then === "function") return out.finally(done);
  done();
  return out;
}

/**
 * A sandbox: COUNCIL_HOME, a scratch HOME holding the user's global agy settings (`global`), a
 * workspace, the fake agy, and main() in-process. `call(argv, {text, scenario, extra, hooks})`
 * passes the fake's content markers for the turn's text.
 */
function sandbox({ global = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "council-gemini-"));
  const home = join(root, "council");
  const userHome = join(root, "home");
  const cwd = join(root, "work");
  mkdirSync(cwd);
  mkdirSync(join(userHome, ".gemini", "antigravity-cli"), { recursive: true });
  if (global !== null) writeFileSync(join(userHome, ".gemini", "antigravity-cli", "settings.json"), typeof global === "string" ? global : JSON.stringify(global));
  const env = { ...process.env, COUNCIL_HOME: home, HOME: userHome, COUNCIL_AGY_BIN: FAKE_AGY, COUNCIL_STDIN_DEADLINE_MS: "300", COUNCIL_FAKE_JOB_DIR: join(home, "jobs"), COUNCIL_FAKE_EXPECT_CONTRACT: CONTRACT };
  for (const g of GUARD_VARS) delete env[g];
  for (const k of Object.keys(env)) if (k.startsWith("COUNCIL_FAKE_") && !["COUNCIL_FAKE_JOB_DIR", "COUNCIL_FAKE_EXPECT_CONTRACT"].includes(k)) delete env[k];
  const call = async (argv, { text = "", prompt, scenario = "ok", extra = {}, hooks = {} } = {}) => {
    let out = "", err = "";
    const stdin = new PassThrough(); stdin.end("");
    const marker = prompt !== undefined ? prompt : { COUNCIL_FAKE_EXPECT_PROMPT: `${CONTRACT}\n\n${text}` };
    const callEnv = { ...env, COUNCIL_FAKE_SCENARIO: scenario, ...(typeof marker === "string" ? { COUNCIL_FAKE_EXPECT_PROMPT_CONTAINS: marker } : marker), ...extra };
    if (callEnv.COUNCIL_FAKE_EXPECT_CONTRACT === null) delete callEnv.COUNCIL_FAKE_EXPECT_CONTRACT;
    const code = await main([...argv, "--json", ...(text ? ["--", text] : [])], callEnv, { stdout: { write: (x) => { out += x; } }, stderr: { write: (x) => { err += x; } }, stdin, cwd }, hooks);
    let json = null;
    try { json = JSON.parse(out.trim().split("\n").at(-1)); } catch { /* not JSON */ }
    return { code, out, err, json };
  };
  const job = (id) => JSON.parse(readFileSync(join(home, "jobs", id, "meta.json"), "utf8"));
  const settings = (id) => JSON.parse(readFileSync(join(home, "jobs", id, "settings.json"), "utf8"));
  return { root, home, userHome, cwd, env, call, job, settings, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("A5 shape: id, binEnv, trust, line cap, catalog", () => {
  assert.equal(gemini.id, "gemini");
  assert.equal(gemini.binEnv, "COUNCIL_AGY_BIN");
  assert.equal(gemini.maxLineBytes, MAX_FRAME_BYTES);
  assert.equal(MAX_FRAME_BYTES, 32 * 1024 * 1024);
  for (const kind of ["native", "node-script", "shim-native", "shim-node"]) assert.equal(gemini.trustsCleanExit({ kind }), false, `${kind}: post-exit scan after every exit`);
  assert.deepEqual(Object.keys(gemini.catalog.families), ["gemini-4-argon", "gemini-3.8-flash"]);
  assert.equal(gemini.catalog.suffixed, true);
  for (const fn of ["resolveLauncher", "ownsProcess", "probe", "checkRequest", "buildTurn", "parseEvent", "reviewPlan", "finalizeReview"]) assert.equal(typeof gemini[fn], "function", fn);
});

test("resolveLauncher: COUNCIL_AGY_BIN, PATH, missing", () => withTmp((dir) => {
  assert.deepEqual(gemini.resolveLauncher({ COUNCIL_AGY_BIN: FAKE_AGY, PATH: "" }, "darwin"), { command: process.execPath, args: [FAKE_AGY], path: FAKE_AGY, kind: "node-script" });
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "agy"), "#!/bin/sh\n");
  chmodSync(join(bin, "agy"), 0o755);
  assert.deepEqual(gemini.resolveLauncher({ PATH: bin }, "darwin"), { command: join(bin, "agy"), args: [], path: join(bin, "agy"), kind: "native" });
  assert.equal(gemini.resolveLauncher({ PATH: join(dir, "none") }, "darwin"), null);
}));

test("ownsProcess matches the job's --settings operand on argv and on macOS ps text", () => {
  const settings = "/h/jobs/abcdefabcdefabcd/settings.json";
  const childArgs = ["--input-format", "stream-json", "--settings", settings, "--model", "gemini-4-argon", "--effort", "low"];
  const job = { id: "abcdefabcdefabcd", dir: "/h/jobs/abcdefabcdefabcd", turn: { settingsPath: settings }, childArgs, argv: ["/usr/local/bin/agy", ...childArgs] };
  assert.equal(settingsPathOf(job), settings);
  assert.equal(settingsPathOf({ dir: "/h/jobs/x" }), join("/h/jobs/x", "settings.json"), "derived from the job directory when no turn was recorded");
  assert.equal(settingsPathOf({}), null);
  assert.equal(gemini.ownsProcess({ argv: ["agy", ...childArgs] }, job, "linux"), true);
  assert.equal(gemini.ownsProcess({ argv: ["agy", "--settings", "/h/jobs/other/settings.json"] }, job, "linux"), false, "another job's settings file");
  assert.equal(gemini.ownsProcess({ raw: `/usr/local/bin/agy ${childArgs.join(" ")}` }, job, "darwin"), true);
  assert.equal(gemini.ownsProcess({ raw: `/opt/elsewhere/agy ${childArgs.join(" ")}` }, job, "darwin"), true, "any program named agy carrying the whole recorded argv (bins)");
  assert.equal(gemini.ownsProcess({ raw: `/opt/elsewhere/notagy ${childArgs.join(" ")}` }, job, "darwin"), false);
  assert.equal(gemini.ownsProcess({ raw: `/usr/local/bin/agy ${childArgs.join(" ")} extra` }, job, "darwin"), false, "suffix must be the recorded args");
  assert.equal(gemini.ownsProcess({ argv: ["agy", ...childArgs] }, {}, "linux"), false, "no evidence, no match");
  assert.deepEqual(BINARIES, ["agy", "agy.exe"]);
});

test("probe: version, login through agy models, gemini rows only", () => {
  const probe = gemini.probe(fakeLauncher(), {});
  assert.equal(probe.version, "1.4.12");
  assert.equal(probe.loggedIn, true);
  const ids = probe.models.map((m) => m.id).sort();
  assert.deepEqual(ids, ["gemini-3.8-flash-high", "gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-4-argon-high", "gemini-4-argon-low", "gemini-4-argon-medium"]);
  assert.deepEqual(probe.models.find((m) => m.id === "gemini-4-argon-high").efforts, ["high"]);
});

test("probe: a failed listing throws with the reason instead of writing an empty catalog", () => {
  const run = (launcher, args) => args[0] === "--version" ? { status: 0, stdout: "1.4.12\n", stderr: "" } : { status: 1, stdout: "", stderr: "not authenticated\n" };
  assert.throws(() => probeAgy({}, {}, "darwin", run), /agy 1\.4\.12: not logged in or listing failed \(not authenticated\); run agy once/);
  const spawnFail = () => ({ error: new Error("spawn agy ENOENT") });
  assert.throws(() => probeAgy({}, {}, "darwin", spawnFail), /agy --version failed: spawn agy ENOENT/);
  const versionFail = () => ({ status: 3, stdout: "", stderr: "boom" });
  assert.throws(() => probeAgy({}, {}, "darwin", versionFail), /agy --version exited 3: boom/);
  assert.throws(() => probeAgy({}, {}, "win32", run), (e) => e instanceof UsageError && e.message === WINDOWS_UNSUPPORTED, "setup reports Gemini unsupported on Windows (A8)");
});

test("checkRequest: win32 refuses every turn verb with the A8 message; --web exits 2", () => {
  for (const verb of ["ask", "reply", "review", "task"]) {
    assert.throws(() => checkGeminiRequest({ verb, web: false }, {}, "win32"), (e) => e instanceof UsageError && e.message === WINDOWS_UNSUPPORTED, verb);
    assert.doesNotThrow(() => checkGeminiRequest({ verb, web: false }, {}, "darwin"), verb);
    assert.doesNotThrow(() => checkGeminiRequest({ verb, web: false }, {}, "linux"), verb);
  }
  assert.throws(() => checkGeminiRequest({ verb: "ask", web: true }, {}, "darwin"), (e) => e instanceof UsageError && /--web has no tested mapping for gemini/.test(e.message));
  assert.doesNotThrow(() => gemini.checkRequest({ verb: "ask", web: false }, {}));
});

test("reviewPlan: collected diff, plain or adversarial template, schema via --json-schema", () => {
  assert.deepEqual(gemini.reviewPlan({}, { adversarial: false }), { native: false, template: "review", schemaCarrier: "--json-schema" });
  assert.equal(gemini.reviewPlan({}, { adversarial: true }).template, "adversarial-review");
});

// --- S5.2 buildTurn ------------------------------------------------------------------------------------

const GLOBAL = { permissions: { allow: ["command(which)", "command(git status)", "read_file(/etc/hosts)", "read_url(https://x.test/*)", "write_file(/tmp/*)"], ask: ["command(npm *)"], deny: ["read_file(/secret/*)"] }, toolPermission: "strict", apiKey: "never-copied" };

function turnFixture(dir, { global = GLOBAL, ...over } = {}) {
  const userHome = join(dir, "home");
  mkdirSync(join(userHome, ".gemini", "antigravity-cli"), { recursive: true });
  if (global !== null) writeFileSync(join(userHome, ".gemini", "antigravity-cli", "settings.json"), typeof global === "string" ? global : JSON.stringify(global));
  const jobDir = join(dir, "job");
  mkdirSync(jobDir, { recursive: true });
  const request = { verb: "ask", provider: "gemini", cwd: dir, model: "gemini-4-argon", effort: "low", readOnly: true, text: "hello", contract: "<c/>", deadline: 1800, thread: null, reviewPrompt: null, jobId: "j", jobDir, env: { HOME: userHome }, ...over };
  return { request, jobDir, userHome, settings: () => JSON.parse(readFileSync(join(jobDir, "settings.json"), "utf8")) };
}

test("buildTurn ask: argv, stdin message with the contract, read-only merged settings", () => withTmp((dir) => {
  const f = turnFixture(dir);
  const turn = gemini.buildTurn(f.request);
  const settingsPath = join(f.jobDir, "settings.json");
  assert.deepEqual(turn.args, ["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands", "--print-timeout", "1800s", "--sandbox", "--settings", settingsPath, "--model", "gemini-4-argon", "--effort", "low"]);
  assert.equal(turn.stdin, JSON.stringify({ event: "user", message: { content: "<c/>\n\nhello" } }) + "\n");
  assert.equal(turn.settingsPath, settingsPath);
  assert.deepEqual([turn.answerFile, turn.readOnly, turn.contractCarrier, turn.threadId], [null, true, "stdin-prefix", null]);
  assert.deepEqual(f.settings(), {
    permissions: {
      allow: ["read_file(/etc/hosts)", "read_url(https://x.test/*)"],
      ask: ["command(npm *)"],
      deny: ["read_file(/secret/*)", "write_file(*)", "edit_file(*)", "command(*)", "unsandboxed(*)", "mcp(*)", "execute_url(*)"],
    },
    toolPermission: "strict",
  }, "global deny retained, write/command allow rules filtered out, credentials never copied");
}));

test("buildTurn task: global lists intact, --mode accept-edits; --conversation on task --thread and reply", () => withTmp((dir) => {
  const f = turnFixture(dir, { verb: "task", readOnly: false });
  const turn = gemini.buildTurn(f.request);
  assert.deepEqual(turn.args.slice(-2), ["--mode", "accept-edits"]);
  assert.equal(turn.readOnly, false);
  assert.deepEqual(f.settings(), { permissions: GLOBAL.permissions, toolPermission: "strict" });
  const thread = { threadId: "0aefb9db-c350-4a61-bc6e-b242fc5946bb" };
  const resumed = gemini.buildTurn({ ...f.request, verb: "task", readOnly: false, thread });
  assert.deepEqual(resumed.args.slice(-4), ["--mode", "accept-edits", "--conversation", thread.threadId]);
  const reply = gemini.buildTurn({ ...f.request, verb: "reply", readOnly: true, thread });
  assert.ok(!reply.args.includes("--mode"), "reply is read-only, also after a task");
  assert.deepEqual(reply.args.slice(-2), ["--conversation", thread.threadId]);
  assert.ok(f.settings().permissions.deny.includes("command(*)"));
}));

test("buildTurn review: rendered prompt alone, --json-schema with the repository schema", () => withTmp((dir) => {
  const f = turnFixture(dir, { verb: "review", reviewPrompt: "REVIEW PROMPT", text: "" });
  const turn = gemini.buildTurn(f.request);
  const i = turn.args.indexOf("--json-schema");
  assert.equal(turn.args[i + 1], join(PLUGIN_ROOT, "schemas", "review-output.schema.json"));
  assert.equal(JSON.parse(turn.stdin).message.content, "REVIEW PROMPT");
  assert.equal(turn.contractCarrier, "none");
  assert.ok(!turn.args.includes("--mode"));
}));

test("model arguments: a suffixed id alone, a family with its clamped effort, an unknown id unchanged", () => {
  const cat = gemini.catalog;
  assert.deepEqual(modelArgs("gemini-4-argon-high", "high", cat), ["--model", "gemini-4-argon-high"]);
  assert.deepEqual(modelArgs("gemini-3.8-flash", "medium", cat), ["--model", "gemini-3.8-flash", "--effort", "medium"]);
  assert.deepEqual(modelArgs("gemini-9-future", "high", cat), ["--model", "gemini-9-future", "--effort", "high"]);
  assert.deepEqual(modelArgs("gemini-4-argon-xhigh", "xhigh", cat), ["--model", "gemini-4-argon-xhigh"], "an unlisted suffix is still a suffix");
  assert.deepEqual(modelArgs("gemini-9-future", null, cat), ["--model", "gemini-9-future"]);
  assert.equal(printTimeout(540), "540s");
  assert.equal(printTimeout(2.5), "2.5s");
  assert.equal(printTimeout(1e21), "1000000000000000000000s");
});

test("global settings: absent file, HOME from the call's env, invalid content refused", () => withTmp((dir) => {
  assert.equal(globalSettingsPath({ HOME: "/u" }), join("/u", ".gemini", "antigravity-cli", "settings.json"));
  assert.equal(globalSettingsPath({ USERPROFILE: "C:/u" }), join("C:/u", ".gemini", "antigravity-cli", "settings.json"));
  const absent = turnFixture(join(dir, "a"), { global: null });
  gemini.buildTurn(absent.request);
  assert.deepEqual(absent.settings(), { permissions: { allow: [], ask: [], deny: READ_ONLY_DENY } });
  const loose = sessionSettings({ permissions: { allow: ["x"], ask: [], deny: ["d", "d"] }, toolPermission: "default" }, false);
  assert.deepEqual(loose, { permissions: { allow: ["x"], ask: [], deny: ["d"] } }, "only strict is carried over");
  for (const [name, global, re] of [
    ["json", "{nope", /is not valid JSON; no turn submitted/],
    ["array", "[]", /must contain a JSON object/],
    ["perm", JSON.stringify({ permissions: [] }), /permissions must be an object/],
    ["list", JSON.stringify({ permissions: { deny: "write_file(*)" } }), /permissions\.deny must be a string array/],
    ["item", JSON.stringify({ permissions: { allow: [1] } }), /permissions\.allow must be a string array/],
  ]) {
    const f = turnFixture(join(dir, name), { global });
    assert.throws(() => gemini.buildTurn(f.request), re, name);
    assert.ok(!existsSync(join(f.jobDir, "settings.json")), `${name}: no settings file written`);
  }
  const big = turnFixture(join(dir, "big"), { global: JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024) }) });
  assert.throws(() => gemini.buildTurn(big.request), /exceeds 2 MiB/);
  assert.deepEqual(readGlobalPolicy({ HOME: join(dir, "nowhere") }), { permissions: { allow: [], ask: [], deny: [] }, toolPermission: null });
}));
