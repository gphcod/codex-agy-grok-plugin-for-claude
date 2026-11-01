// S5: Gemini adapter against tests/fixtures/fake-agy.mjs (PLAN.md S5.1-S5.5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import gemini, { BINARIES, MAX_FRAME_BYTES, WINDOWS_UNSUPPORTED, checkGeminiRequest, probeAgy, settingsPathOf } from "../plugins/council/scripts/lib/providers/gemini.mjs";
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
