// S3.1–S3.3: the codex adapter's parts in isolation — launcher and clean-exit trust, ownership rows,
// probe against fake-codex, buildTurn shapes for every verb, the MCP policy, checkRequest, parseEvent
// over the recorded S1.1 streams, and finalizeReview over the recorded review answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import adapter, { LINE_CAP, MCP_TRADE_OFF, SANDBOX, waitsForCodex } from "../plugins/council/scripts/lib/providers/codex.mjs";
import { UsageError } from "../plugins/council/scripts/lib/core/args.mjs";
import { loadStaticCatalog } from "../plugins/council/scripts/lib/core/catalog.mjs";
import { finalizeReviewTurn } from "../plugins/council/scripts/lib/core/review.mjs";

const FAKE = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const STREAMS = new URL("./fixtures/streams/codex/", import.meta.url);
const stream = (name) => readFileSync(new URL(name, STREAMS), "utf8");
const tmp = () => mkdtempSync(join(tmpdir(), "council-codex-"));
const fakeLauncher = () => adapter.resolveLauncher({ COUNCIL_CODEX_BIN: FAKE }, process.platform);
const CONTRACT = "<council_contract>be brief</council_contract>";

function request(dir, overrides = {}) {
  return {
    verb: "ask", provider: "codex", cwd: dir, jobId: "abcdefghij123456", jobDir: dir, model: "gpt-6.1-sol", effort: "high", readOnly: true,
    text: "Reply with pong", contract: CONTRACT, thread: null, env: {}, launcher: fakeLauncher(), web: false, adversarial: false, ...overrides,
  };
}

// --- S3.1 skeleton -----------------------------------------------------------------------------------

test("skeleton: id, binEnv, line cap from codex-plugin-cc's reader, catalog from models.json", () => {
  assert.equal(adapter.id, "codex");
  assert.equal(adapter.binEnv, "COUNCIL_CODEX_BIN");
  assert.equal(adapter.maxLineBytes, 1024 * 1024);
  assert.equal(LINE_CAP, adapter.maxLineBytes);
  assert.deepEqual(adapter.catalog, loadStaticCatalog().codex);
  assert.deepEqual(SANDBOX, { ask: "read-only", reply: "read-only", review: "read-only", task: "workspace-write" });
});

test("resolveLauncher: COUNCIL_CODEX_BIN, PATH, missing binary; the platform rides on the launcher", () => {
  const dir = tmp();
  try {
    const viaEnv = adapter.resolveLauncher({ COUNCIL_CODEX_BIN: FAKE }, "darwin");
    assert.deepEqual([viaEnv.command, viaEnv.args, viaEnv.kind, viaEnv.platform], [process.execPath, [FAKE], "node-script", "darwin"]);
    const bin = join(dir, "codex");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n"); chmodSync(bin, 0o755);
    const onPath = adapter.resolveLauncher({ PATH: dir }, "linux");
    assert.deepEqual([onPath.command, onPath.args, onPath.kind, onPath.platform], [bin, [], "native", "linux"]);
    assert.equal(adapter.resolveLauncher({ PATH: join(dir, "nowhere") }, "darwin"), null);
    assert.equal(adapter.resolveLauncher({ COUNCIL_CODEX_BIN: join(dir, "missing") }, "darwin"), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("resolveLauncher on win32: npm shim → vendor codex.exe (shim-native) or codex.js (shim-node)", () => {
  const dir = tmp();
  try {
    const pkg = join(dir, "node_modules", "@openai", "codex");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "bin", "codex.js"), "#!/usr/bin/env node\n");
    const shim = join(dir, "codex.cmd");
    writeFileSync(shim, '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
    const node = adapter.resolveLauncher({ COUNCIL_CODEX_BIN: shim }, "win32", "x64");
    assert.equal(node.kind, "shim-node");
    assert.equal(node.args[0], join(pkg, "bin", "codex.js"));
    assert.equal(adapter.trustsCleanExit(node), true, "npm's codex.js exits only after Codex");
    const exe = join(pkg, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
    mkdirSync(join(exe, ".."), { recursive: true });
    writeFileSync(exe, "MZ");
    const native = adapter.resolveLauncher({ COUNCIL_CODEX_BIN: shim }, "win32", "x64");
    assert.deepEqual([native.kind, native.command, native.args], ["shim-native", exe, []]);
    assert.equal(adapter.trustsCleanExit(native), true);
    assert.equal(adapter.resolveLauncher({ COUNCIL_CODEX_BIN: shim }, "win32", "ia32").kind, "shim-node", "no vendor build for that arch");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("trustsCleanExit: only waitsForCodex launchers, only on Windows (codex-plugin-cc lifecycle.mjs:210)", () => {
  const cases = [
    [{ command: "C:\\npm\\codex.exe", args: [], kind: "native", platform: "win32" }, true],
    [{ command: "C:\\npm\\node_modules\\@openai\\codex-win32-x64\\vendor\\x\\bin\\codex.exe", args: [], kind: "shim-native", platform: "win32" }, true],
    [{ command: "node.exe", args: ["C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"], kind: "shim-node", platform: "win32" }, true],
    [{ command: "node.exe", args: ["C:\\tools\\codex-wrapper.mjs"], kind: "node-script", platform: "win32" }, false],
    [{ command: "C:\\tools\\codex-wrapper.exe", args: [], kind: "native", platform: "win32" }, false],
    [{ command: "/opt/homebrew/bin/codex", args: [], kind: "native", platform: "darwin" }, false],
    [{ command: "node", args: ["/usr/lib/node_modules/@openai/codex/bin/codex.js"], kind: "node-script", platform: "linux" }, false],
    [{ command: "C:\\npm\\codex.exe", args: [] }, false],
    [null, false],
  ];
  for (const [launcher, expected] of cases) assert.equal(adapter.trustsCleanExit(launcher), expected, JSON.stringify(launcher));
  assert.equal(waitsForCodex({ command: "node", args: ["/x/@openai/codex/bin/codex.js", "extra"] }), false);
});

test("ownsProcess: the job's exact -o operand on row.argv (Linux, Windows) and row.raw (macOS)", () => {
  const job = { id: "abcdefghij123456", dir: "/h/jobs/abcdefghij123456" };
  const answer = join(job.dir, "answer.md");
  const childArgs = ["exec", "--json", "-o", answer, "-C", "/w", "-s", "read-only", "-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=low", "-"];
  const recorded = { ...job, turn: { answerFile: answer }, childArgs, argv: ["/opt/homebrew/bin/codex", ...childArgs] };
  const other = childArgs.map((a) => (a === answer ? "/h/jobs/zzzzzzzzzz999999/answer.md" : a));
  // argv rows
  assert.equal(adapter.ownsProcess({ pid: 1, argv: ["codex", ...childArgs] }, recorded, "linux"), true);
  assert.equal(adapter.ownsProcess({ pid: 1, argv: ["codex", ...other] }, recorded, "linux"), false, "another job's answer file");
  assert.equal(adapter.ownsProcess({ pid: 1, argv: ["codex", "-o"] }, recorded, "linux"), false);
  assert.equal(adapter.ownsProcess({ pid: 1, argv: ["C:\\npm\\codex.exe", ...childArgs.map((a) => (a === answer ? answer.toUpperCase() : a))] }, recorded, "win32"), true, "Windows paths compare case-insensitively");
  assert.equal(adapter.ownsProcess({ pid: 1, argv: ["codex", ...childArgs] }, job, "linux"), true, "without a turn record the job dir names the operand");
  assert.equal(adapter.ownsProcess({ pid: 1, argv: ["codex", ...childArgs] }, { id: job.id }, "linux"), false, "nothing to match against");
  // raw rows (macOS ps)
  const raw = (program, args = childArgs) => ({ pid: 1, raw: `${program} ${args.join(" ")}`, argv: null });
  assert.equal(adapter.ownsProcess(raw("/opt/homebrew/bin/codex"), recorded, "darwin"), true);
  assert.equal(adapter.ownsProcess(raw("/usr/local/bin/codex"), recorded, "darwin"), true, "the provider binary name qualifies");
  assert.equal(adapter.ownsProcess(raw("node /usr/local/lib/node_modules/@openai/codex/bin/codex.js"), recorded, "darwin"), true, "npm's codex.js under node");
  assert.equal(adapter.ownsProcess(raw("/opt/homebrew/bin/codex", other), recorded, "darwin"), false, "another job's operand");
  assert.equal(adapter.ownsProcess(raw("/usr/bin/evil-codex-helper"), recorded, "darwin"), false, "a path substring never qualifies");
  assert.equal(adapter.ownsProcess(raw("/opt/homebrew/bin/codex", [...childArgs, "extra"]), recorded, "darwin"), false, "the recorded suffix must end the line");
});

test("probe against fake-codex: version, login, models via debug models, the MCP line setup states", () => {
  const launcher = fakeLauncher();
  const p = adapter.probe(launcher, {});
  assert.equal(p.version, "codex-cli 0.163.0");
  assert.equal(p.loggedIn, true);
  const sol = p.models.find((m) => m.id === "gpt-6.1-sol");
  assert.deepEqual(sol.efforts, ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.deepEqual(p.models.find((m) => m.id === "gpt-6-luna").efforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(p.models.length, 11);
  assert.deepEqual(p.warnings, []);
  assert.deepEqual(p.notes, [`mcp: inherit (default): ask, reply and review keep your MCP servers, plugins and apps; COUNCIL_CODEX_MCP=off would drop them there: ${MCP_TRADE_OFF}`]);
  const off = adapter.probe(launcher, { COUNCIL_CODEX_MCP: "off" });
  assert.match(off.notes[0], /^mcp: off for ask, reply and review: plugins, apps and configured servers disabled; this check ran `codex mcp list` twice in \d+ ms, and each such call repeats it$/);
  const none = adapter.probe(launcher, { COUNCIL_CODEX_MCP: "off", COUNCIL_FAKE_MCP_SERVERS: "none" });
  assert.match(none.notes[0], /plugins, apps disabled; this check ran `codex mcp list` once/);
  assert.deepEqual(adapter.probe(launcher, { COUNCIL_CODEX_MCP: "maybe" }).warnings, ["COUNCIL_CODEX_MCP must be inherit or off"]);
});

test("probe failures: --version fails → throws; login and listing failures are warnings", () => {
  const dir = tmp();
  try {
    const script = (body) => { const f = join(dir, `codex-${Math.random().toString(36).slice(2)}.mjs`); writeFileSync(f, body); return adapter.resolveLauncher({ COUNCIL_CODEX_BIN: f }, process.platform); };
    assert.throws(() => adapter.probe(script("process.stderr.write('boom\\n'); process.exit(3);"), {}), /codex --version failed: boom/);
    const partial = adapter.probe(script(`const a = process.argv.slice(2).join(" ");
if (a === "--version") { console.log("codex-cli 9.9.9"); process.exit(0); }
if (a === "login status") { console.error("Not logged in"); process.exit(1); }
if (a === "debug models") { console.log("not json"); process.exit(0); }
process.exit(5);`), {});
    assert.deepEqual([partial.version, partial.loggedIn, partial.models], ["codex-cli 9.9.9", false, null]);
    assert.deepEqual(partial.warnings, ["codex login status: Not logged in", "could not read the model catalogue (codex debug models)"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
