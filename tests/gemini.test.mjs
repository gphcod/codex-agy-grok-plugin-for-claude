// S5: Gemini adapter against tests/fixtures/fake-agy.mjs (PLAN.md S5.1-S5.5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import gemini, { WEB_NOTE, tierWarnings, BINARIES, MAX_FRAME_BYTES, WINDOWS_QUALIFIED, checkGeminiRequest, globalSettingsPath, modelArgs, printTimeout, probeAgy, readGlobalPolicy, sessionSettings, settingsPathOf, firstJsonObject, describeToolStep, describeStepError, isDenialStep, stepCounters } from "../plugins/council/scripts/lib/providers/gemini.mjs";
import { DEADLINE_S } from "../plugins/council/scripts/lib/core/lifecycle.mjs";
import { createReader } from "../plugins/council/scripts/lib/core/reader.mjs";
import { finalizeReviewTurn } from "../plugins/council/scripts/lib/core/review.mjs";
import { UsageError } from "../plugins/council/scripts/lib/core/args.mjs";
import { PLUGIN_ROOT } from "../plugins/council/scripts/lib/core/catalog.mjs";
import { fixturesDir, GUARD_VARS } from "./fixtures/fake-common.mjs";
import { main } from "../plugins/council/scripts/council.mjs";
import { git, isolateGit } from "./fixtures/build-repos.mjs";

isolateGit();

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
  const env = { ...process.env, COUNCIL_HOME: home, HOME: userHome, USERPROFILE: userHome, COUNCIL_AGY_BIN: FAKE_AGY, COUNCIL_STDIN_DEADLINE_MS: "300", COUNCIL_FAKE_JOB_DIR: join(home, "jobs"), COUNCIL_FAKE_EXPECT_CONTRACT: CONTRACT };
  for (const g of GUARD_VARS) delete env[g];
  for (const k of Object.keys(env)) if (k.startsWith("COUNCIL_FAKE_") && !["COUNCIL_FAKE_JOB_DIR", "COUNCIL_FAKE_EXPECT_CONTRACT"].includes(k)) delete env[k];
  const call = async (argv, { text = "", prompt, scenario = "ok", extra = {}, hooks = {}, json: asJson = true } = {}) => {
    let out = "", err = "";
    const stdin = new PassThrough(); stdin.end("");
    const marker = prompt !== undefined ? prompt : { COUNCIL_FAKE_EXPECT_PROMPT: `${CONTRACT}\n\n${text}` };
    const callEnv = { ...env, COUNCIL_FAKE_SCENARIO: scenario, ...(typeof marker === "string" ? { COUNCIL_FAKE_EXPECT_PROMPT_CONTAINS: marker } : marker), ...extra };
    if (callEnv.COUNCIL_FAKE_EXPECT_CONTRACT === null) delete callEnv.COUNCIL_FAKE_EXPECT_CONTRACT;
    const code = await main([...argv, ...(asJson ? ["--json"] : []), ...(text ? ["--", text] : [])], callEnv, { stdout: { write: (x) => { out += x; } }, stderr: { write: (x) => { err += x; } }, stdin, cwd }, hooks);
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
  if (process.platform !== "win32") assert.deepEqual(gemini.resolveLauncher({ PATH: bin }, "darwin"), { command: join(bin, "agy"), args: [], path: join(bin, "agy"), kind: "native" }); // A POSIX PATH splits on the colon of a Windows drive.
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
  assert.throws(() => probeAgy({}, {}, "win32", run), /not logged in or listing failed/, "Windows is qualified (A8): the probe runs there too");
});

test("checkRequest: every turn verb runs on a qualified Windows (A8); --web exits 2", () => {
  assert.equal(WINDOWS_QUALIFIED, true, "docs/qualification/windows.md records the session");
  for (const verb of ["ask", "reply", "review", "task"]) {
    assert.doesNotThrow(() => checkGeminiRequest({ verb, web: false }, {}, "win32"), verb);
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
  assert.equal(globalSettingsPath({ HOME: "/u", USERPROFILE: "/u" }), join("/u", ".gemini", "antigravity-cli", "settings.json"));
  if (process.platform === "win32") assert.equal(globalSettingsPath({ HOME: "/git-bash", USERPROFILE: "/u" }), join("/u", ".gemini", "antigravity-cli", "settings.json"), "agy.exe follows USERPROFILE");
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
  assert.deepEqual(readGlobalPolicy({ HOME: join(dir, "nowhere"), USERPROFILE: join(dir, "nowhere") }), { permissions: { allow: [], ask: [], deny: [] }, toolPermission: null });
}));

// --- S5.3 parseEvent and finalizeReview -------------------------------------------------------------------

const STREAMS = join(fixturesDir, "streams", "agy");
const captured = (name) => readFileSync(join(STREAMS, name), "utf8").split("\n").filter(Boolean);

/** Feeds lines through the core reader with the gemini adapter; returns the reader state and the answer text. */
function read(lines) {
  let answer = "";
  const reader = createReader({ adapter: gemini, onText: (t) => { answer += t; } });
  reader.feed(lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l)) + "\n").join(""));
  reader.end();
  return { state: reader.state, answer };
}
const CID = "0aefb9db-c350-4a61-bc6e-b242fc5946bb";
const ok = (extra = {}) => ({ event: "result", result: { conversation_id: CID, status: "SUCCESS", response: "pong\n", duration_seconds: 1, num_turns: 1, usage: { total_tokens: 3 }, ...extra } });
const delta = (text) => ({ event: "step_update", step_update: { conversation_id: CID, step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: text } });
const init = { event: "init", conversation_id: CID, init: { model: "gemini-4-argon", tools: [] } };

test("captured minimal and resume streams: thread id, answer, completion, usage", () => {
  for (const name of ["minimal.jsonl", "resume.jsonl", "effort-flash-plus-high.jsonl", "merge-2-session-replaces.jsonl"]) {
    const { state, answer } = read(captured(name));
    const result = captured(name).map((l) => JSON.parse(l)).find((e) => e.event === "result").result;
    assert.equal(state.failed, null, name);
    assert.equal(state.completed, true, name);
    assert.equal(state.threadId, result.conversation_id, name);
    assert.equal(answer, result.response, name);
    assert.equal(state.denied, null, name);
    assert.deepEqual(state.usage, result.usage, name);
  }
});

test("captured denial: tool-step signature with the denied_actions key absent → denied, answer kept", () => {
  const lines = captured("denied-write.jsonl");
  assert.ok(!("denied_actions" in JSON.parse(lines.at(-1)).result), "the capture has no denied_actions key");
  const { state, answer } = read(lines);
  assert.equal(state.failed, null);
  assert.equal(state.completed, true);
  assert.match(state.denied, /^agy denied write_file .*Permission denied for write_file/);
  assert.match(answer, /The attempt to create/);
  assert.match(state.lastTool, /^failed: write_file .* — permission check failed/);
});

test("denial: an empty denied_actions array is no denial by itself; a non-empty one is; denial is checked before the empty-response rule", () => {
  const signature = JSON.parse(captured("denied-write.jsonl").find((l) => l.includes('"state":"ERROR"')));
  signature.step_update.conversation_id = CID;
  assert.equal(isDenialStep(signature.step_update), true);
  const withEmpty = read([init, signature, ok({ denied_actions: [] })]);
  assert.match(withEmpty.state.denied, /^agy denied write_file/, "signature plus an empty array → denied");
  const emptyOnly = read([init, delta("pong"), ok({ denied_actions: [] })]);
  assert.equal(emptyOnly.state.denied, null, "an empty array alone is not a denial");
  assert.equal(emptyOnly.state.completed, true);
  const listed = read([init, ok({ denied_actions: [{ tool: "write_file", path: "/x" }] })]);
  assert.match(listed.state.denied, /^agy denied 1 requested action\(s\): \{"tool":"write_file","path":"\/x"\}/);
  const silent = read([init, signature, ok({ response: "" })]);
  assert.equal(silent.state.failed, null, "denied with an empty response is not fatal");
  assert.match(silent.answer, /^agy denied 1 tool call\(s\) by a deny rule: write_file/, "the answer names the denial");
  const otherError = { event: "step_update", step_update: { ...signature.step_update, tool_info: { ...signature.step_update.tool_info, error: { type: "TOOL_ERROR", message: "file not found" } } } };
  assert.equal(isDenialStep(otherError.step_update), false, "a failed tool step without the deny-rule text");
  assert.equal(read([init, otherError, ok()]).state.denied, null);
});

test("terminal validation: missing, duplicate, malformed, ERROR status, empty response, print_timeout", () => {
  const missing = read([init, delta("pong")]);
  assert.equal(missing.state.completed, false, "no result: the core fails the turn");
  assert.equal(missing.state.failed, null);
  assert.equal(read([init, ok(), ok()]).state.failed, "agy emitted duplicate terminal results for one turn");
  assert.match(read([init, { event: "result", result: { status: "SUCCESS" } }]).state.failed, /malformed result/);
  assert.match(read([init, { event: "result", result: null }]).state.failed, /malformed result/);
  assert.match(read([init, ok({ denied_actions: "x" })]).state.failed, /malformed denied_actions/);
  const effort = read(captured("effort-flash-plus-xhigh.jsonl"));
  assert.match(effort.state.failed, /^agy finished with status ERROR: invalid model selection .*has no "xhigh" effort/);
  const interrupted = read(captured("cancel-group.jsonl"));
  assert.equal(interrupted.state.failed, "agy finished with status ERROR: interrupted");
  assert.equal(read([init, ok({ response: "  \n" })]).state.failed, "agy returned an empty response; no usable result was produced");
  const timeout = read(captured("print-timeout-5s.jsonl"));
  assert.equal(timeout.state.failed, null);
  assert.equal(timeout.state.completed, true);
  assert.match(timeout.state.incomplete, /print timeout/);
  assert.equal(read(["not json"]).state.failed, "agy emitted malformed stream-json output; expected one JSON event per line");
  assert.equal(read([{ step_update: {} }]).state.failed, "agy emitted a stream event without an event name");
  assert.equal(read([init, { event: "step_update", step_update: { ...delta("x").step_update, conversation_id: "11111111-2222-4333-8444-555555555555" } }]).state.failed, `thread id changed during the turn (${CID} → 11111111-2222-4333-8444-555555555555)`);
});

test("answer: the response wins over deltas; deltas stand in for an empty response; partial cap", () => {
  const both = read([init, delta("thinking aloud "), delta("pong"), ok({ response: "pong\n" })]);
  assert.equal(both.answer, "pong\n");
  const deltasOnly = read([init, delta("po"), delta("ng"), ok({ response: "" })]);
  assert.equal(deltasOnly.state.failed, null, "S5.8: an empty response with streamed deltas is not empty");
  assert.equal(deltasOnly.state.completed, true);
  assert.equal(deltasOnly.answer, "pong");
  const timeout = captured("print-timeout-5s.jsonl");
  const recorded = timeout.map((l) => JSON.parse(l)).find((e) => e.event === "result").result;
  assert.ok(recorded.response.trim());
  const partial = read(timeout);
  assert.equal(partial.answer, recorded.response, "S5.8: the partial answer survives a print timeout");
  assert.match(partial.state.incomplete, /print timeout/);
  const timeoutDeltas = read([init, delta("1, 2, "), ok({ response: "", finished_reason: "print_timeout" })]);
  assert.equal(timeoutDeltas.answer, "1, 2, ", "deltas stand in for an empty response on a print timeout too");
  assert.equal(read([init, ok({ response: "", finished_reason: "print_timeout" })]).answer, "", "nothing to keep");
  const partialCap = { gemini: { result: false, partial: "", partialBytes: 32 * 1024 * 1024, denials: [] } };
  assert.match(gemini.parseEvent(JSON.stringify(delta("x")), partialCap).fatal, /exceeds the 32 MiB limit/);
  assert.equal(gemini.parseEvent("   ", {}), null);
  assert.equal(gemini.parseEvent(JSON.stringify({ event: "heartbeat" }), {}), null, "an unknown event without an id carries nothing");
});

test("structured output: structured_output, else the first JSON object of the answer", () => {
  const schema = read(captured("json-schema.jsonl"));
  const recorded = captured("json-schema.jsonl").map((l) => JSON.parse(l)).find((e) => e.event === "result").result.structured_output;
  assert.deepEqual(schema.state.structured, recorded);
  const scanned = read([init, ok({ response: 'Here: ```json\n{"verdict":"approve","note":"a } in a string"}\n```' })]);
  assert.deepEqual(scanned.state.structured, { verdict: "approve", note: "a } in a string" });
  assert.equal(read([init, ok()]).state.structured, null);
  assert.equal(firstJsonObject("{not json} [1] {\"a\":1}").a, 1);
  assert.equal(firstJsonObject("{ unbalanced"), null);
  assert.deepEqual(firstJsonObject('In calc.js, if (x) { the loop runs once more. {"verdict":"approve","findings":[]}'), { verdict: "approve", findings: [] }, "S5.8: an unmatched brace in prose does not end the scan");
  assert.deepEqual(firstJsonObject('{ "a": { {"b":1}'), { b: 1 });
  assert.equal(firstJsonObject(null), null);
  assert.equal(firstJsonObject('{"s":"\\"}"}').s, '"}', "escaped quotes inside strings");
});

test("captured task (2026-11-01): a completed edit_file counts as edited; the passing run_command is no failure", () => {
  const { state, answer } = read(captured("task-edit.jsonl"));
  assert.equal(state.failed, null);
  assert.equal(state.completed, true);
  assert.equal(state.denied, null);
  assert.equal(state.incomplete, null);
  assert.deepEqual([...state.edited], ["<scratch>/repo/calc.js"], "one ACTIVE and one DONE step for one file count once");
  assert.equal(state.failedCommandCount, 0);
  assert.match(answer, /^Fixed the bug in \[calc\.js\]/);
});

test("tool-step counters: write tools by any path key, failed or non-zero run_command, read-only writes reported", () => {
  const step = (tool_name, state, parameters, extra = {}) => ({ event: "step_update", step_update: { conversation_id: CID, step_index: 4, state, step_type: "tool", tool_name, tool_info: { name: tool_name, parameters, ...extra } } });
  const writes = read([init, step("write_to_file", "DONE", { TargetFile: "/r/a.js" }), step("replace_file_content", "DONE", { AbsolutePath: "/r/b.js" }), step("edit_file", "ACTIVE", { Path: "/r/c.js" }), step("view_file", "DONE", { AbsolutePath: "/r/d.js" }), ok()]);
  assert.deepEqual([...writes.state.edited].sort(), ["/r/a.js", "/r/b.js"], "ACTIVE steps and read tools are not edits");
  assert.deepEqual(stepCounters(step("edit_file", "DONE", {}).step_update), { write: "edit_file" }, "a write with no path key is not counted");
  const cmds = read([init,
    step("run_command", "DONE", { CommandLine: "npm test" }, { output: "Command exited with code 1.\n\nfail" }),
    step("run_command", "DONE", { CommandLine: "node ok.js" }, { output: "Command exited with code 0." }),
    step("run_command", "ERROR", { CommandLine: "make" }, { error: { type: "TOOL_ERROR", message: "spawn failed" } }), ok()]);
  assert.equal(cmds.state.failedCommandCount, 2);
  assert.deepEqual(cmds.state.failedCommands, [{ cmd: "npm test", exit: 1 }, { cmd: "make", exit: null }]);
  let answer = "";
  const reader = createReader({ adapter: gemini, turn: { readOnly: true }, onText: (t) => { answer += t; } });
  reader.feed([init, step("edit_file", "DONE", { Path: "/r/c.js" }), ok()].map((l) => JSON.stringify(l) + "\n").join(""));
  reader.end();
  assert.equal(reader.state.edited.size, 0, "a read-only turn counts no edit");
  assert.equal(reader.state.incomplete, "agy completed edit_file on a read-only turn");
});

test("tool steps are described with their main argument", () => {
  assert.equal(describeToolStep({ tool_name: "read_file", tool_info: { parameters: { Recursive: "no", Path: "/repo/a.mjs" } } }), "read_file /repo/a.mjs");
  assert.equal(describeToolStep({ tool_info: { name: "search_web", parameters: { query: "x" } } }), "search_web x");
  assert.equal(describeToolStep({ step_type: "tool" }), "tool");
  assert.equal(describeStepError({ tool_name: "run_command", error: "boom" }), "failed: run_command — boom");
  assert.equal(describeStepError({ tool_name: "t" }), "failed: t — no reason given");
  const { state } = read([init, { event: "step_update", step_update: { conversation_id: CID, step_index: 2, state: "DONE", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: "/r/x" } } } }, ok()]);
  assert.equal(state.lastTool, "view_file /r/x");
});

test("finalizeReview: the shared validator maps schema output into A5.2; malformed output is incomplete", () => {
  const recorded = captured("json-schema.jsonl").map((l) => JSON.parse(l)).find((e) => e.event === "result").result.structured_output;
  const review = finalizeReviewTurn({ adapter: gemini, structured: recorded, unreviewed: [] });
  assert.equal(review.result.verdict, recorded.findings.length || recorded.verdict === "needs-attention" ? "changes" : "approve");
  assert.equal(review.result.findings.length, recorded.findings.length);
  assert.match(review.renderedText, /^Verdict: /);
  const malformed = finalizeReviewTurn({ adapter: gemini, structured: { verdict: "approve", findings: [{ severity: "low", title: "x", body: "y" }], next_steps: [] }, unreviewed: [] });
  assert.equal(malformed.result.verdict, "incomplete");
  assert.equal(malformed.exit, 10);
  const none = finalizeReviewTurn({ adapter: gemini, structured: null, unreviewed: ["big.bin"] });
  assert.deepEqual([none.result.verdict, none.result.incomplete, none.result.coverage.unreviewed], ["incomplete", "missing structured review output", ["big.bin"]]);
  const clean = finalizeReviewTurn({ adapter: gemini, structured: { verdict: "approve", summary: "fine", findings: [], next_steps: [] }, unreviewed: [] });
  assert.deepEqual([clean.result.verdict, clean.exit], ["approve", 0]);
});

// --- S5.4 review templates through the entry --------------------------------------------------------------

function repo(s) {
  git(s.cwd, ["init", "-q"]);
  writeFileSync(join(s.cwd, "a.mjs"), "export const a = 1;\n");
  git(s.cwd, ["add", "-A"]);
  git(s.cwd, ["commit", "-q", "-m", "base"]);
  writeFileSync(join(s.cwd, "a.mjs"), "export const a = 2; // REVIEW-ME\n");
}
const logLines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("review --uncommitted: collected diff in the plain template, --json-schema, findings exit 10", async () => {
  const s = sandbox({ global: GLOBAL });
  try {
    repo(s);
    const log = join(s.root, "agy.log");
    const r = await s.call(["review", "--to", "gemini", "--uncommitted"], { scenario: "review-findings", prompt: "REVIEW-ME", extra: { COUNCIL_FAKE_EXPECT_CONTRACT: null, COUNCIL_FAKE_AGY_LOG: log } });
    assert.equal(r.code, 10, r.out + r.err);
    assert.equal(r.json.verdict, "changes");
    assert.ok(r.json.findings.length > 0);
    const [spawn] = logLines(log);
    assert.match(spawn.content, /^<role>\nYou are /, "the review prompt alone, no contract");
    assert.doesNotMatch(spawn.content, /adversarial software review/);
    assert.match(spawn.content, /Use the repository context below as primary evidence\./, "collection guidance");
    assert.match(spawn.content, /Target: working tree/i);
    assert.ok(spawn.argv.includes("--json-schema"));
    assert.ok(!spawn.argv.includes("--mode"), "a review is read-only");
    assert.ok(spawn.settings.permissions.deny.includes("command(*)"));
  } finally { s.done(); }
});

test("review --adversarial renders the adversarial template; malformed output → incomplete, exit 10", async () => {
  const s = sandbox();
  try {
    repo(s);
    const log = join(s.root, "agy.log");
    const r = await s.call(["review", "--to", "gemini", "--uncommitted", "--adversarial"], { text: "focus on the constant", scenario: "review-malformed", prompt: "adversarial software review", extra: { COUNCIL_FAKE_EXPECT_CONTRACT: null, COUNCIL_FAKE_AGY_LOG: log } });
    assert.equal(r.code, 10, r.out + r.err);
    assert.equal(r.json.verdict, "incomplete");
    const [spawn] = logLines(log);
    assert.match(spawn.content, /User focus: focus on the constant/);
    assert.match(spawn.content, /REVIEW-ME/);
  } finally { s.done(); }
});

// --- S5.5 every verb against fake-agy ---------------------------------------------------------------------

const args = (spawn, flag) => { const i = spawn.argv.indexOf(flag); return i < 0 ? undefined : spawn.argv[i + 1]; };

test("ask → task --thread → reply → task --thread: settings, --sandbox, --mode and --conversation on every transition", async () => {
  const s = sandbox({ global: GLOBAL });
  try {
    const log = join(s.root, "agy.log");
    const extra = { COUNCIL_FAKE_AGY_LOG: log };
    const ask = await s.call(["ask", "--to", "gemini", "--effort", "low"], { text: "first", extra });
    assert.equal(ask.code, 0, ask.out + ask.err);
    assert.equal(ask.json.answer, "pong\n");
    assert.deepEqual([ask.json.model, ask.json.effort, ask.json.round], ["gemini-4-argon", "low", 1]);
    const thread = ask.json.thread;
    const task1 = await s.call(["task", "--thread", ask.json.job], { text: "edit it", scenario: "resume", extra });
    assert.equal(task1.code, 0, task1.out + task1.err);
    const reply = await s.call(["reply", "--thread", task1.json.job], { text: "explain", scenario: "resume", extra });
    assert.equal(reply.code, 0, reply.out + reply.err);
    const task2 = await s.call(["task", "--thread", thread], { text: "again", scenario: "resume", extra });
    assert.equal(task2.code, 0, task2.out + task2.err);
    assert.deepEqual([task1.json.round, reply.json.round, task2.json.round], [2, 3, 4]);
    const spawns = logLines(log);
    assert.equal(spawns.length, 4);
    const expected = [
      { readOnly: true, conversation: undefined }, { readOnly: false, conversation: thread },
      { readOnly: true, conversation: thread }, { readOnly: false, conversation: thread },
    ];
    const readOnlySettings = { permissions: { allow: ["read_file(/etc/hosts)", "read_url(https://x.test/*)"], ask: ["command(npm *)"], deny: ["read_file(/secret/*)", ...READ_ONLY_DENY] }, toolPermission: "strict" };
    const taskSettings = { permissions: GLOBAL.permissions, toolPermission: "strict" };
    for (const [i, spawn] of spawns.entries()) {
      const want = expected[i];
      assert.ok(spawn.argv.includes("--sandbox"), `turn ${i + 1}: --sandbox always`);
      assert.equal(args(spawn, "--mode"), want.readOnly ? undefined : "accept-edits", `turn ${i + 1}: --mode only on tasks`);
      assert.equal(args(spawn, "--conversation"), want.conversation, `turn ${i + 1}: --conversation`);
      assert.deepEqual(spawn.settings, want.readOnly ? readOnlySettings : taskSettings, `turn ${i + 1}: settings`);
      assert.match(args(spawn, "--settings"), new RegExp(`[\\\\/]jobs[\\\\/][a-z0-9]{16}[\\\\/]settings\\.json$`));
      assert.equal(args(spawn, "--print-timeout"), `${DEADLINE_S}s`, "the execution deadline (A3.3)");
      assert.ok(spawn.content.startsWith(CONTRACT));
    }
    assert.equal(new Set(spawns.map((x) => args(x, "--settings"))).size, 4, "a settings file per job");
    assert.equal(args(spawns[1], "--effort"), "high", "a fresh task --thread uses the exec tier unless told otherwise");
    assert.equal(args(spawns[2], "--effort"), "high", "reply inherits the thread's model and effort");
    const list = await s.call(["wait"], {});
    assert.equal(list.code, 0);
  } finally { s.done(); }
});

test("denial exits 10: signature with the key absent, signature with an empty array, a non-empty array, an empty response", async () => {
  const s = sandbox();
  try {
    const absent = await s.call(["ask", "--to", "gemini"], { text: "create a file", scenario: "denied" });
    assert.equal(absent.code, 10, absent.out + absent.err);
    assert.match(absent.json.answer, /blocked by a user-configured permission deny rule/);
    for (const variant of ["denied-actions-empty", "denied-actions", "denied-empty-response"]) {
      const r = await s.call(["ask", "--to", "gemini"], { text: "x", extra: { COUNCIL_FAKE_AGY_RESULT: variant } });
      assert.equal(r.code, 10, `${variant}: ${r.out}${r.err}`);
      assert.equal(r.json.status, "attention", variant);
    }
    const quiet = await s.call(["ask", "--to", "gemini"], { text: "x", extra: { COUNCIL_FAKE_AGY_RESULT: "denied-empty-response" }, json: false });
    assert.match(quiet.out, /^agy denied 1 tool call\(s\) by a deny rule: write_file /m);
    assert.match(quiet.out, /^council gemini needs attention · job [a-z0-9]{16} · gemini-4-argon\/high · /m);
  } finally { s.done(); }
});

test("failures exit 1: print_timeout, duplicate, missing, ERROR status, empty response; effort error from agy", async () => {
  const s = sandbox();
  try {
    for (const [variant, re] of [
      ["print-timeout", /print timeout/], ["duplicate", /duplicate terminal results/], ["missing", /ended without finishing the turn|print timeout|turn/],
      ["error", /agy finished with status ERROR: backend unavailable/], ["empty", /agy returned an empty response/],
    ]) {
      const r = await s.call(["ask", "--to", "gemini"], { text: "x", extra: { COUNCIL_FAKE_AGY_RESULT: variant } });
      assert.equal(r.code, 1, `${variant}: ${r.out}${r.err}`);
      assert.match(r.json.error ?? "", re, variant);
    }
    const timeout = await s.call(["ask", "--to", "gemini"], { text: "x", extra: { COUNCIL_FAKE_AGY_RESULT: "print-timeout" } });
    assert.equal(timeout.code, 1);
    assert.equal(timeout.json.answer, "pong", "S5.8: the partial answer is kept on a print timeout");
    const deltasOnly = await s.call(["ask", "--to", "gemini"], { text: "x", extra: { COUNCIL_FAKE_AGY_RESULT: "deltas-only" } });
    assert.equal(deltasOnly.code, 0, deltasOnly.out + deltasOnly.err);
    assert.equal(deltasOnly.json.answer, "pong\n", "S5.8: deltas answer an empty response");
    const effort = await s.call(["ask", "--to", "gemini"], { text: "x", scenario: "effort-error" });
    assert.equal(effort.code, 1);
    assert.match(effort.json.error, /invalid model selection/);
  } finally { s.done(); }
});

test("refusals exit 2 before any spawn: --web, suffix conflict; suffixed id alone; xhigh clamped in the footer", async () => {
  const s = sandbox();
  try {
    const log = join(s.root, "agy.log");
    const extra = { COUNCIL_FAKE_AGY_LOG: log };
    const web = await s.call(["ask", "--to", "gemini", "--web"], { text: "x", extra });
    assert.equal(web.code, 2);
    assert.match(web.json.error, /--web has no tested mapping for gemini/);
    const conflict = await s.call(["ask", "--to", "gemini", "--model", "gemini-4-argon-high", "--effort", "medium"], { text: "x", extra });
    assert.equal(conflict.code, 2);
    assert.match(conflict.json.error, /already fixes the effort at high; --effort medium conflicts/);
    assert.deepEqual(logLines(log), [], "nothing spawned");
    assert.ok(!existsSync(join(s.home, "jobs")) || readdirSync(join(s.home, "jobs")).length === 0, "no job record");
    const suffixed = await s.call(["ask", "--to", "gemini", "--model", "gemini-3.8-flash-medium"], { text: "x", extra });
    assert.equal(suffixed.code, 0, suffixed.out + suffixed.err);
    assert.deepEqual(logLines(log)[0].argv.slice(logLines(log)[0].argv.indexOf("--model")), ["--model", "gemini-3.8-flash-medium"], "the id alone, no --effort");
    const clamped = await s.call(["ask", "--to", "gemini", "--effort", "xhigh"], { text: "x", extra, json: false });
    assert.equal(clamped.code, 0, clamped.out + clamped.err);
    assert.match(clamped.out, /^council gemini ok · job [a-z0-9]{16} · gemini-4-argon\/high<=xhigh · .* · round 1\/9 · next: reply [a-z0-9]{16}$/m);
    assert.match(clamped.err, /^\[council\] provider=gemini job=[a-z0-9]{16} thread=[0-9a-f-]{36}$/m);
    assert.equal(args(logLines(log)[1], "--effort"), "high");
  } finally { s.done(); }
});

test("two concurrent jobs with the same model and effort are told apart by their settings paths", async () => {
  const s = sandbox();
  try {
    const slow = { COUNCIL_FAKE_SLOW_MS: "800" };
    const [a, b] = await Promise.all([
      s.call(["ask", "--to", "gemini"], { text: "one", scenario: "slow", extra: slow }),
      s.call(["ask", "--to", "gemini"], { text: "two", scenario: "slow", extra: slow }),
    ]);
    assert.equal(a.code, 0, a.out + a.err);
    assert.equal(b.code, 0, b.out + b.err);
    const ja = s.job(a.json.job), jb = s.job(b.json.job);
    assert.deepEqual([ja.model, ja.effort], [jb.model, jb.effort]);
    assert.notEqual(ja.turn.settingsPath, jb.turn.settingsPath);
    const row = (job) => ({ argv: job.argv, raw: job.argv.join(" ") });
    for (const platform of ["linux", "darwin"]) {
      const view = (job) => (platform === "linux" ? { argv: job.argv } : { raw: row(job).raw });
      assert.equal(gemini.ownsProcess(view(ja), ja, platform), true, platform);
      assert.equal(gemini.ownsProcess(view(jb), ja, platform), false, `${platform}: the other job's row`);
      assert.equal(gemini.ownsProcess(view(ja), jb, platform), false, platform);
    }
  } finally { s.done(); }
});

test("the stop path kills a language-server child in agy's group", { skip: process.platform === "win32" }, async () => {
  const s = sandbox();
  const pidfile = join(s.root, "ls.pid");
  let ls = null;
  try {
    const r = await s.call(["ask", "--to", "gemini", "--deadline", "1"], { text: "x", scenario: "slow", extra: { COUNCIL_FAKE_AGY_CHILD: "group", COUNCIL_FAKE_AGY_CHILD_PIDFILE: pidfile, COUNCIL_FAKE_SLOW_MS: "20000" }, hooks: { graceMs: 300, retryMs: 300, drainMs: 300, pipeWaitMs: 300 } });
    ls = Number(readFileSync(pidfile, "utf8"));
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.json.error, /wall-clock deadline passed/);
    assert.equal(r.json.cleanupPending, false);
    for (const end = Date.now() + 3000; alive(ls) && Date.now() < end;) await sleep(20);
    assert.equal(alive(ls), false, "the child died with the group");
  } finally { if (ls && alive(ls)) process.kill(ls, "SIGKILL"); s.done(); }
});

test("a language-server child reparented to pid 1 after agy exits is found and stopped", { skip: process.platform === "win32" }, async () => {
  const s = sandbox();
  const pidfile = join(s.root, "ls.pid");
  let ls = null;
  try {
    const r = await s.call(["ask", "--to", "gemini"], { text: "x", extra: { COUNCIL_FAKE_AGY_CHILD: "orphan", COUNCIL_FAKE_AGY_CHILD_PIDFILE: pidfile, COUNCIL_FAKE_AGY_HOLD_MS: "700" }, hooks: { beatMs: 100, graceMs: 300, retryMs: 300, drainMs: 300, pipeWaitMs: 300, shutdownMs: 4000 } });
    ls = Number(readFileSync(pidfile, "utf8"));
    assert.ok(s.job(r.json.job).execution.some((x) => x.pid === ls), "recorded at a heartbeat while agy ran");
    assert.equal(r.code, 1, r.out + r.err);
    assert.equal(r.json.error, "owned execution survived the launcher");
    assert.equal(r.json.cleanupPending, false);
    for (const end = Date.now() + 3000; alive(ls) && Date.now() < end;) await sleep(20);
    assert.equal(alive(ls), false, "stopped by its verified identity");
  } finally { if (ls && alive(ls)) process.kill(ls, "SIGKILL"); s.done(); }
});

test("wait and cancel: a slow job is listed, cancelled and its claim released", async () => {
  const s = sandbox();
  try {
    const running = s.call(["ask", "--to", "gemini", "--session", "s1"], { text: "x", scenario: "slow", extra: { COUNCIL_FAKE_SLOW_MS: "20000" } });
    let job = null;
    for (const end = Date.now() + 5000; !job && Date.now() < end; await sleep(50)) {
      const listed = await s.call(["wait", "--session", "s1"], {});
      job = /([a-z0-9]{16})/.exec(listed.out)?.[1] ?? null;
    }
    assert.ok(job, "listed by wait");
    for (const end = Date.now() + 5000; !s.job(job).threadId && Date.now() < end;) await sleep(50);
    const cancel = await s.call(["cancel", job], {});
    assert.equal(cancel.code, 0, cancel.out + cancel.err);
    const r = await running;
    assert.equal(r.code, 1);
    assert.equal(r.json.status, "cancelled");
  } finally { s.done(); }
});

test("setup and models --refresh through the fake: ready, notes, tier ids checked against agy models", async () => {
  const s = sandbox();
  try {
    const setup = await s.call(["setup", "--to", "gemini"], {});
    assert.equal(setup.code, 0, setup.out + setup.err);
    const [row] = JSON.parse(setup.out);
    assert.deepEqual([row.ready, row.version, row.loggedIn, row.launcher.kind], [true, "1.4.12", true, "node-script"]);
    assert.deepEqual(row.notes, [WEB_NOTE]);
    assert.deepEqual(row.warnings, []);
    assert.deepEqual(row.tiers, { consult: "gemini-4-argon/high", exec: "gemini-3.8-flash/high", deep: "gemini-4-argon/high" });
    const text = await s.call(["setup", "--to", "gemini"], { json: false });
    assert.match(text.out, /^gemini: ready · .*fake-agy\.mjs \(node-script\) · 1\.4\.12 · logged in$/m);
    assert.match(text.out, /^  note: web search stays available/m);
    const refresh = await s.call(["models", "--to", "gemini", "--refresh"], {});
    assert.equal(refresh.code, 0, refresh.out + refresh.err);
    const [m] = JSON.parse(refresh.out);
    assert.equal(m.source, "refreshed");
    assert.deepEqual(m.models["gemini-4-argon"], ["low", "medium", "high"]);
    assert.deepEqual(m.models["gemini-3.8-flash-low"], ["low"]);
    assert.ok(!Object.keys(m.models).some((id) => id.startsWith("claude-")), "only routed ids");
    assert.deepEqual(tierWarnings(["gemini-4-argon-high"], { consult: { model: "gemini-4-argon", effort: "high" }, exec: { model: "gemini-3.8-flash", effort: "high" }, deep: { model: "gemini-4-argon-high", effort: "high" } }), ["tier exec resolves to gemini-3.8-flash-high, which agy models does not list"]);
  } finally { s.done(); }
});
