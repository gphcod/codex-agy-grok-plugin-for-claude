// S3.1–S3.3: the codex adapter's parts in isolation — launcher and clean-exit trust, ownership rows,
// probe against fake-codex, buildTurn shapes for every verb, the MCP policy, checkRequest, parseEvent
// over the recorded S1.1 streams, and finalizeReview over the recorded review answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import adapter, { LINE_CAP, MCP_TRADE_OFF, NO_FINDINGS, REVIEW_FALLBACK, SANDBOX, parseNativeReview, sandboxDenied, toolPolicy, waitsForCodex } from "../plugins/council/scripts/lib/providers/codex.mjs";
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
  assert.deepEqual(SANDBOX, { ask: "danger-full-access", reply: "danger-full-access", review: "danger-full-access", task: "danger-full-access" });
});

test("resolveLauncher: COUNCIL_CODEX_BIN, PATH, missing binary; the platform rides on the launcher", () => {
  const dir = tmp();
  try {
    const viaEnv = adapter.resolveLauncher({ COUNCIL_CODEX_BIN: FAKE }, "darwin");
    assert.deepEqual([viaEnv.command, viaEnv.args, viaEnv.kind, viaEnv.platform], [process.execPath, [FAKE], "node-script", "darwin"]);
    const bin = join(dir, "codex");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n"); chmodSync(bin, 0o755);
    if (process.platform !== "win32") { // A POSIX PATH splits on the colon of a Windows drive.
      const onPath = adapter.resolveLauncher({ PATH: dir }, "linux");
      assert.deepEqual([onPath.command, onPath.args, onPath.kind, onPath.platform], [bin, [], "native", "linux"]);
    }
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
  const childArgs = ["exec", "--json", "-o", answer, "-C", "/w", "-s", "danger-full-access", "-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=low", "-"];
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

// --- S3.2 buildTurn -------------------------------------------------------------------------------------

test("buildTurn ask: fresh exec with -C and -s read-only, contract as a JSON string literal, prompt on stdin", () => {
  const dir = tmp();
  try {
    const before = { ...process.env };
    const t = adapter.buildTurn(request(dir));
    const answer = join(dir, "answer.md");
    assert.deepEqual(t.args, ["exec", "--json", "-o", answer, "-C", dir, "-s", "danger-full-access", "-m", "gpt-6.1-sol", "-c", "approval_policy=never", "-c", "model_reasoning_effort=high",
      "-c", `developer_instructions=${JSON.stringify(CONTRACT)}`, "-"]);
    assert.deepEqual([t.stdin, t.answerFile, t.readOnly, t.contractCarrier, t.threadId], ["Reply with pong", answer, true, "developer_instructions", null]);
    assert.deepEqual(t.env, {});
    assert.deepEqual({ ...process.env }, before, "the adapter never touches process.env");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("buildTurn: reply resumes read-only; task is workspace-write fresh or resumed; reply after a task is read-only again", () => {
  const dir = tmp();
  try {
    const answer = join(dir, "answer.md");
    const thread = { threadId: "01a1936d-c678-73b2-b282-4b3c3d2ed281" };
    const tail = (model = "gpt-6.1-sol", effort = "high") => ["-m", model, "-c", "approval_policy=never", "-c", `model_reasoning_effort=${effort}`, "-c", `developer_instructions=${JSON.stringify(CONTRACT)}`, "-"];
    const reply = adapter.buildTurn(request(dir, { verb: "reply", thread }));
    assert.deepEqual(reply.args, ["exec", "resume", thread.threadId, "--json", "-o", answer, "-c", "sandbox_mode=danger-full-access", ...tail()]);
    assert.equal(reply.readOnly, true);
    const task = adapter.buildTurn(request(dir, { verb: "task", readOnly: false, model: "gpt-6-luna", effort: "max" }));
    assert.deepEqual(task.args, ["exec", "--json", "-o", answer, "-C", dir, "-s", "danger-full-access", ...tail("gpt-6-luna", "max")]);
    assert.equal(task.readOnly, false);
    const taskThread = adapter.buildTurn(request(dir, { verb: "task", readOnly: false, thread, model: "gpt-6-luna", effort: "max" }));
    assert.deepEqual(taskThread.args, ["exec", "resume", thread.threadId, "--json", "-o", answer, "-c", "sandbox_mode=danger-full-access", ...tail("gpt-6-luna", "max")]);
    const after = adapter.buildTurn(request(dir, { verb: "reply", thread: { ...thread, readOnly: false, lastVerb: "task" } }));
    assert.ok(after.args.includes("sandbox_mode=danger-full-access") && after.args.includes("approval_policy=never"));
    for (const t of [reply, taskThread, after]) assert.ok(!t.args.includes("-C") && !t.args.includes("-s"), "resume accepts neither -C nor -s");
    const ultra = adapter.buildTurn(request(dir, { effort: "ultra" }));
    assert.ok(ultra.args.includes("model_reasoning_effort=ultra"), "ultra passes through");
    const noEffort = adapter.buildTurn(request(dir, { effort: null, model: "some-new-model" }));
    assert.ok(!noEffort.args.some((a) => a.startsWith("model_reasoning_effort=")), "no effort token when none resolved");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("buildTurn review: unfocused passes the target flags and no stdin; focused passes the sentence plus focus on stdin with `-` and no flags", () => {
  const dir = tmp();
  try {
    const answer = join(dir, "answer.md");
    const target = { flags: ["--base", "refs/heads/main"], sentence: "Review the changes on this branch against \"main\"; run `git diff abc...HEAD`." };
    const plain = adapter.reviewPlan({ target }, { text: "" });
    assert.deepEqual(plain, { native: true, flags: ["--base", "refs/heads/main"], stdin: null });
    assert.deepEqual(adapter.reviewPlan({ target }, { text: "  \n" }).stdin, null, "whitespace is no focus");
    const focusedPlan = adapter.reviewPlan({ target }, { text: "loop bounds only" });
    assert.equal(focusedPlan.stdin, `${target.sentence}\n\nloop bounds only`);
    const common = ["--json", "-o", answer, "-c", "sandbox_mode=danger-full-access", "-m", "gpt-6.1-sol", "-c", "review_model=gpt-6.1-sol", "-c", "approval_policy=never", "-c", "model_reasoning_effort=high"];
    const unfocused = adapter.buildTurn(request(dir, { verb: "review", reviewNative: { flags: plain.flags, stdin: plain.stdin }, reviewTarget: target }));
    assert.deepEqual(unfocused.args, ["exec", "review", "--base", "refs/heads/main", ...common]);
    assert.equal("stdin" in unfocused, false, "no stdin: the CLI rejects flags plus a prompt");
    assert.deepEqual([unfocused.readOnly, unfocused.contractCarrier], [true, "none"]);
    const focused = adapter.buildTurn(request(dir, { verb: "review", reviewNative: { flags: focusedPlan.flags, stdin: focusedPlan.stdin }, reviewTarget: target }));
    assert.deepEqual(focused.args, ["exec", "review", ...common, "-"]);
    assert.equal(focused.stdin, focusedPlan.stdin);
    for (const flags of [["--uncommitted"], ["--commit", "abc123"]]) {
      assert.deepEqual(adapter.buildTurn(request(dir, { verb: "review", reviewNative: { flags, stdin: null } })).args.slice(0, 2 + flags.length), ["exec", "review", ...flags]);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("buildTurn with COUNCIL_CODEX_MCP=off: ask, reply and review drop plugins, apps and servers; task keeps them", () => {
  const dir = tmp();
  try {
    const log = join(dir, "codex.log");
    writeFileSync(log, "");
    const env = { COUNCIL_CODEX_MCP: "off", COUNCIL_FAKE_CODEX_LOG: log };
    const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const servers = 'mcp_servers={"node_repl"={enabled=false},"openaiDeveloperDocs"={enabled=false},"tradier"={enabled=false},"tradier_sandbox"={enabled=false}}';
    const ask = adapter.buildTurn(request(dir, { env }));
    assert.deepEqual(ask.args.slice(11, 20), ["approval_policy=never", "-c", "model_reasoning_effort=high", "--disable", "plugins", "--disable", "apps", "-c", servers]);
    assert.equal(calls().length, 2, "two discovery calls with servers configured (S1.1)");
    assert.deepEqual(calls().map((c) => c.argv.slice(0, 3)), [["mcp", "list", "--json"], ["mcp", "list", "--json"]]);
    assert.ok(calls().every((c) => c.guards.length === 6), "discovery calls carry the guard variables");
    writeFileSync(log, "");
    adapter.buildTurn(request(dir, { verb: "task", readOnly: false, env }));
    assert.equal(calls().length, 0, "task keeps the user's tools: no discovery");
    adapter.buildTurn(request(dir, { verb: "review", env, reviewNative: { flags: ["--uncommitted"], stdin: null } }));
    adapter.buildTurn(request(dir, { verb: "reply", thread: { threadId: "t-1" }, env }));
    assert.equal(calls().length, 4);
    writeFileSync(log, "");
    const bare = adapter.buildTurn(request(dir, { env: { ...env, COUNCIL_FAKE_MCP_SERVERS: "none" } }));
    assert.deepEqual(bare.args.slice(bare.args.indexOf("--disable"), bare.args.indexOf("--disable") + 4), ["--disable", "plugins", "--disable", "apps"]);
    assert.ok(!bare.args.some((a) => a.startsWith("mcp_servers=")));
    assert.equal(calls().length, 1, "one discovery call without enabled servers");
    writeFileSync(log, "");
    assert.ok(!adapter.buildTurn(request(dir, { env: { COUNCIL_FAKE_CODEX_LOG: log } })).args.includes("--disable"));
    assert.equal(calls().length, 0, "inherit (default) makes no discovery call");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("toolPolicy failures: listing fails, unreadable, a server stays enabled, bad policy", () => {
  const launcher = { command: "codex", args: [] };
  const ok = (stdout) => ({ status: 0, stdout, stderr: "" });
  const off = { COUNCIL_CODEX_MCP: "off" };
  assert.throws(() => toolPolicy({ verb: "ask", launcher, env: off, run: () => ({ status: 1, stdout: "", stderr: "unknown subcommand\n" }) }), /needs `codex mcp list --json`, which failed: unknown subcommand/);
  assert.throws(() => toolPolicy({ verb: "ask", launcher, env: off, run: () => ok("[{\"name\":1}]") }), /cannot read `codex mcp list --json` from this Codex version/);
  assert.throws(() => toolPolicy({ verb: "ask", launcher, env: off, run: () => ok("nope") }), /cannot read/);
  assert.throws(() => toolPolicy({ verb: "ask", launcher, env: off, run: () => ok('[{"name":"stubborn","enabled":true}]') }), /could not disable MCP server stubborn; nothing was started/);
  assert.throws(() => toolPolicy({ verb: "ask", launcher, env: { COUNCIL_CODEX_MCP: "maybe" } }), UsageError);
  assert.deepEqual(toolPolicy({ verb: "ask", launcher, env: off, run: () => ok('[{"name":"x","enabled":false}]') }), ["--disable", "plugins", "--disable", "apps"]);
  assert.deepEqual(toolPolicy({ verb: "ask", launcher, env: {} }), []);
});

test("checkRequest: --adversarial and --web exit 2, a bad COUNCIL_CODEX_MCP exits 2, everything else passes", () => {
  assert.throws(() => adapter.checkRequest({ verb: "review", adversarial: true }, {}), (e) => e instanceof UsageError && /no --adversarial/.test(e.message));
  assert.throws(() => adapter.checkRequest({ verb: "ask", web: true }, {}), (e) => e instanceof UsageError && /--web has no tested mapping for codex/.test(e.message));
  assert.throws(() => adapter.checkRequest({ verb: "ask" }, { COUNCIL_CODEX_MCP: "none" }), /COUNCIL_CODEX_MCP must be inherit or off/);
  for (const env of [{}, { COUNCIL_CODEX_MCP: "off" }, { COUNCIL_CODEX_MCP: "inherit" }]) assert.doesNotThrow(() => adapter.checkRequest({ verb: "ask", web: false, adversarial: false }, env));
});

// --- S3.3 parseEvent and finalizeReview ----------------------------------------------------------------------

test("parseEvent over the recorded minimal, resume and review streams", () => {
  const parse = (name) => stream(name).split("\n").filter(Boolean).map((l) => adapter.parseEvent(l, {}));
  const minimal = parse("minimal.jsonl");
  assert.deepEqual(minimal, [{ threadId: "01a1936d-c678-73b2-b282-4b3c3d2ed281" }, null, { toolStep: "agent_message" },
    { completed: true, usage: { input_tokens: 16062, cached_input_tokens: 13184, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } }]);
  assert.ok(parse("resume.jsonl").some((e) => e?.threadId), "resume repeats thread.started");
  const review = parse("review-unfocused.jsonl");
  assert.ok(review.every((e) => !e?.denied), "the recorded git cache warnings (exit 0) are no denial");
  assert.ok(review.filter((e) => e?.toolStep?.startsWith("command: ")).length >= 1, "command steps are reported as progress");
  assert.equal(review.at(-1).completed, true);
});

test("parseEvent: failure, error, file_change, failed command, junk", () => {
  const p = (obj) => adapter.parseEvent(typeof obj === "string" ? obj : JSON.stringify(obj), {});
  assert.deepEqual(p({ type: "turn.failed", error: { message: '{"error":{"message":"quota exceeded"}}' } }), { fatal: "quota exceeded" });
  assert.deepEqual(p({ type: "turn.failed" }), { fatal: "turn failed" });
  assert.deepEqual(p({ type: "error", message: "Reconnecting... 1/5" }), { error: "Reconnecting... 1/5" }, "not latched: Codex may still complete");
  assert.deepEqual(p({ type: "error" }), { error: "codex reported an error" });
  assert.deepEqual(p({ type: "thread.started", thread_id: 7 }), { fatal: "invalid thread.started id" });
  assert.deepEqual(p({ type: "item.completed", item: { type: "file_change", status: "completed", changes: [{ path: "/w/a.js" }, { path: "b.js" }, {}] } }), { edited: ["/w/a.js", "b.js"], toolStep: "file_change" });
  assert.deepEqual(p({ type: "item.completed", item: { type: "file_change", status: "completed", changes: "x" } }), { fatal: "invalid file_change changes" });
  assert.deepEqual(p({ type: "item.completed", item: { type: "file_change", status: "failed", changes: [{ path: "a" }] } }), { toolStep: "file_change" }, "a failed patch edits nothing");
  assert.deepEqual(p({ type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc 'npm test'", exit_code: 2 } }), { failedCommand: { cmd: "npm test", exit: 2 }, toolStep: "command_execution" });
  assert.deepEqual(p({ type: "item.completed", item: { type: "command_execution", command: "ls", exit_code: 0 } }), { toolStep: "command_execution" });
  assert.deepEqual(p({ type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc 'printf hello > x.txt'", aggregated_output: "zsh: operation not permitted: x.txt\n", exit_code: 1, status: "failed" } }),
    { failedCommand: { cmd: "printf hello > x.txt", exit: 1 }, denied: "sandbox denied: printf hello > x.txt (exit 1)", deniedAction: "printf hello > x.txt (sandbox, exit 1)", toolStep: "command_execution" }, "macOS seatbelt refusal");
  for (const output of ["touch: a: Read-only file system", "bash: b: Permission denied", "landlock: restricted", "seccomp filter", "Command denied by sandbox: rm", "failed to write file c"]) {
    assert.ok(p({ type: "item.completed", item: { type: "command_execution", command: "x", aggregated_output: output, exit_code: 1 } }).denied, output);
  }
  assert.equal(p({ type: "item.completed", item: { type: "command_execution", command: "npm test", aggregated_output: "1 failing test\n", exit_code: 1 } }).denied, undefined, "an ordinary failure is not a denial");
  assert.equal(p({ type: "item.completed", item: { type: "command_execution", command: "git status", aggregated_output: "git: warning: couldn't create cache file (errno=Operation not permitted)\n", exit_code: 0 } }).denied, undefined, "keywords at exit 0 are not a denial (S1.1 git warning)");
  assert.equal(sandboxDenied(null), false);
  assert.deepEqual(p({ type: "item.completed", item: { type: "command_execution", command: "ls", exit_code: null } }), { toolStep: "command_execution" });
  assert.deepEqual(p({ type: "item.started", item: { type: "command_execution", command: "bash -lc \"git status\"" } }), { toolStep: "command: git status" });
  assert.deepEqual(p({ type: "item.started", item: { type: "reasoning" } }), { toolStep: "reasoning" });
  for (const junk of ["not json", "{}", '{"type":5}', '{"type":"turn.started"}', '{"type":"item.completed"}']) assert.equal(p(junk), null, junk);
});

test("finalizeReview: the recorded [P1] answer → one MAJOR finding with file, line and body; exit 10", () => {
  const text = stream("review-unfocused.answer.md");
  const r = adapter.finalizeReview({ answerText: text, answerFile: null, structured: null, unreviewed: [] });
  assert.equal(r.verdict, "changes");
  assert.equal(r.incomplete, null);
  assert.deepEqual(r.findings.map((f) => [f.severity, f.file, f.line, f.title]), [["MAJOR", "<scratch>/codex/review-repo/calc.js", 3, "Stop iteration before the array length"]]);
  assert.match(r.findings[0].text, /^The inclusive bound reads `items\[items.length\]`/);
  assert.match(r.summary, /^The changed loop bound introduces an out-of-bounds read/);
  assert.match(r.renderedText, /^Verdict: changes requested\. The changed loop bound/);
  assert.match(r.renderedText, /\nF1 MAJOR <scratch>\/codex\/review-repo\/calc.js:3: Stop iteration before the array length\n/);
  const turn = finalizeReviewTurn({ adapter, answerText: text });
  assert.equal(turn.exit, 10);
  assert.equal(turn.result.verdict, "changes");
  assert.equal(finalizeReviewTurn({ adapter, answerText: stream("review-focused.answer.md") }).result.findings.length, 1);
});

test("finalizeReview: P0 → BLOCKER, ranges, several findings, a finding past 24 KiB", () => {
  const text = ["Two problems.", "", "Full review comments:", "",
    "- [P0] Data loss on save — /repo/src/save.js:10-14", "  Truncates before writing.", "  Second line.",
    "- [P1] Off by one — /repo/src/loop.js:7", "  Inclusive bound."].join("\n");
  const r = adapter.finalizeReview({ answerText: text });
  assert.equal(r.verdict, "changes");
  assert.deepEqual(r.findings, [
    { severity: "BLOCKER", file: "/repo/src/save.js", line: 10, lineEnd: 14, title: "Data loss on save", text: "Truncates before writing.\nSecond line." },
    { severity: "MAJOR", file: "/repo/src/loop.js", line: 7, title: "Off by one", text: "Inclusive bound." },
  ]);
  const late = adapter.finalizeReview({ answerText: `${"x".repeat(30 * 1024)}\n\nReview comment:\n\n- [P1] Late finding — /r/a.js:1-1\n  body` });
  assert.deepEqual(late.findings.map((f) => f.title), ["Late finding"], "the whole answer is scanned, not the 24 KiB preview");
});

test("finalizeReview: well-formed [P2] and [P3] findings are MINOR (milestone 3 ruling)", () => {
  const r = adapter.finalizeReview({ answerText: "Small things.\n\nFull review comments:\n\n- [P2] Naming — /r/a.js:4-4\n  minor\n- [P3] Nit — /r/b.js:1-2\n  tiny\n- [P1] Real bug — /r/c.js:9\n  body" });
  assert.equal(r.verdict, "changes");
  assert.equal(r.incomplete, null);
  assert.deepEqual(r.findings.map((f) => [f.severity, f.file, f.line, f.lineEnd ?? null, f.title]), [
    ["MINOR", "/r/a.js", 4, null, "Naming"], ["MINOR", "/r/b.js", 1, 2, "Nit"], ["MAJOR", "/r/c.js", 9, null, "Real bug"],
  ]);
  const minorOnly = finalizeReviewTurn({ adapter, answerText: "Review comment:\n\n- [P3] Nit — /r/b.js:1-1\n  tiny" });
  assert.deepEqual([minorOnly.result.verdict, minorOnly.exit], ["changes", 10], "a MINOR finding still needs attention (A5.2)");
  assert.match(minorOnly.renderedText, /\nF1 MINOR \/r\/b\.js:1: Nit\n/);
});

test("a finding's indented body may mention a priority; an indented bullet that fails the form stays unrecognized", () => {
  const body = "Review comment:\n\n- [P1] Guard against null — /r/parse.js:42-45\n  Without it `table[P0]` throws, so this is [P1] rather than [P2].\n  Restore the early return.\n- [P2] Second — /r/b.js:7\n  Fine.";
  const r = adapter.finalizeReview({ answerText: body });
  assert.deepEqual([r.verdict, r.incomplete], ["changes", null]);
  assert.deepEqual(r.findings.map((f) => f.title), ["Guard against null", "Second"]);
  assert.equal(r.findings[0].text, "Without it `table[P0]` throws, so this is [P1] rather than [P2].\nRestore the early return.");
  assert.equal(finalizeReviewTurn({ adapter, answerText: body }).exit, 10);
  const nested = adapter.finalizeReview({ answerText: "Review comment:\n\n- [P1] Real — /r/a.js:4\n  body\n  - [P2] no location" });
  assert.equal(nested.verdict, "incomplete");
  assert.match(nested.incomplete, /1 finding line/);
  // Prose after a finding, not indented, is outside it.
  assert.equal(adapter.finalizeReview({ answerText: "Review comment:\n\n- [P1] Real — /r/a.js:4\n  body\n\nThis [P1] is the only one." }).verdict, "incomplete");
});

test("finalizeReview → incomplete (exit 10): unparseable lines, empty, fallback text, prose without findings", () => {
  const cases = [
    ["Review comment:\n\n- [P4] Unknown priority — /r/a.js:4-4\n  minor", /1 finding line\(s\) not in Codex's `- \[P0-3\] <title> — <path>:<line>` form/],
    ["Review comment:\n\n- [P1] Real bug — /r/a.js:4-4\n  body\n- [P2] no location", /1 finding line/],
    ["- [P1] no location given", /not in Codex's/],
    ["Something [P1] mentioned inline", /not in Codex's/],
    ["", /no review text/],
    ["   \n", /no review text/],
    [REVIEW_FALLBACK, /reviewer failed to output a response/],
    ["Looks fine to me, nothing to flag.", /^codex reported no findings; its output cannot prove a clean review$/],
    ["No findings. The change is correct.", /^codex reported no findings; its output cannot prove a clean review$/],
  ];
  for (const [text, reason] of cases) {
    const r = adapter.finalizeReview({ answerText: text });
    assert.equal(r.verdict, "incomplete", text);
    assert.match(r.incomplete, reason, text);
    const turn = finalizeReviewTurn({ adapter, answerText: text });
    assert.equal(turn.exit, 10, text);
    assert.equal(turn.result.verdict, "incomplete");
    if (text.trim()) assert.ok(turn.renderedText.includes(`Codex review output:\n\n${text.trimEnd()}`), "Codex's own text is kept after the verdict");
  }
  assert.equal(NO_FINDINGS, "codex reported no findings; its output cannot prove a clean review");
  assert.match(finalizeReviewTurn({ adapter, answerText: "All good." }).renderedText, /^Verdict: incomplete \(codex reported no findings; its output cannot prove a clean review\)\./);
  const mixed = adapter.finalizeReview({ answerText: cases[1][0] });
  assert.deepEqual(mixed.findings.map((f) => f.title), ["Real bug"], "recognized findings stay reported");
  assert.deepEqual(parseNativeReview("- [P1] Bad range — /r/a.js:9-3").findings, [], "an inverted range is not a location");
});
