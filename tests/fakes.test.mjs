// Spawns every fake in every scenario and checks exit codes, held-pipe timing and event shapes
// against the recorded S1 spike streams in tests/fixtures/streams.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixturesDir, repoRoot, streamsDir, SCENARIOS, GUARD_VARS } from "./fixtures/fake-common.mjs";

const node = process.execPath;
const fakes = { codex: join(fixturesDir, "fake-codex.mjs"), agy: join(fixturesDir, "fake-agy.mjs"), grok: join(fixturesDir, "fake-grok.mjs") };
const schemaPath = join(repoRoot, "plugins", "council", "schemas", "review-output.schema.json");
const SCHEMA = readFileSync(schemaPath, "utf8");
const guards = Object.fromEntries(GUARD_VARS.map((g) => [g, "1"]));
const grokEnv = { GROK_DISABLE_AUTOUPDATER: "1", GROK_CLAUDE_SKILLS_ENABLED: "0", GROK_CLAUDE_AGENTS_ENABLED: "0", GROK_CLAUDE_HOOKS_ENABLED: "0", GROK_CLAUDE_MCPS_ENABLED: "0" };
const HOSTILE = "Agent,ask_user_question,enter_plan_mode,exit_plan_mode,image_gen,image_edit,image_to_video,reference_to_video";
const UUID = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

function tmp() { return mkdtempSync(join(tmpdir(), "council-fakes-")); }

/** Recorded event shapes: for each event type, the union of key paths one level deep. */
function recordedShapes(provider) {
  const shapes = new Map();
  for (const file of readFileSync(join(streamsDir, "provenance.json"), "utf8") && Object.keys(JSON.parse(readFileSync(join(streamsDir, "provenance.json"), "utf8")).streams[provider])) {
    for (const line of readFileSync(join(streamsDir, provider, file), "utf8").split("\n").filter(Boolean)) {
      const ev = JSON.parse(line);
      const type = eventType(provider, ev);
      const keys = shapes.get(type) ?? new Set();
      for (const k of Object.keys(ev)) keys.add(k);
      if (provider === "agy" && ev.step_update) for (const k of Object.keys(ev.step_update)) keys.add(`step_update.${k}`);
      if (provider === "codex" && ev.item) for (const k of Object.keys(ev.item)) keys.add(`item.${k}`);
      shapes.set(type, keys);
    }
  }
  return shapes;
}
function eventType(provider, ev) {
  if (provider === "agy") return ev.event + (ev.step_update?.step_type ? `:${ev.step_update.step_type}` : "");
  if (provider === "codex") return ev.type + (ev.item?.type ? `:${ev.item.type}` : "");
  return ev.type;
}
function assertShapes(provider, events, { allowExtraTypes = [] } = {}) {
  const shapes = recordedShapes(provider);
  for (const ev of events) {
    const type = eventType(provider, ev);
    if (allowExtraTypes.includes(type)) continue;
    assert.ok(shapes.has(type), `${provider}: event ${type} was never recorded in a spike stream`);
    const keys = shapes.get(type);
    for (const k of Object.keys(ev)) assert.ok(keys.has(k), `${provider}: ${type} key ${k} not in recorded shape`);
    if (provider === "agy" && ev.step_update) for (const k of Object.keys(ev.step_update)) assert.ok(keys.has(`step_update.${k}`), `${provider}: ${type} step_update.${k} not recorded`);
    if (provider === "codex" && ev.item) for (const k of Object.keys(ev.item)) assert.ok(keys.has(`item.${k}`), `${provider}: ${type} item.${k} not recorded`);
  }
}

const CONTRACT = "Answer tersely.";
const PROMPT = "Reply with pong.";
/** Markers the fakes check the turn's bytes against; a test overrides them to provoke exit 99. */
const markers = (cwd, prompt = PROMPT) => ({ COUNCIL_FAKE_EXPECT_PROMPT: prompt, COUNCIL_FAKE_EXPECT_CONTRACT: CONTRACT, COUNCIL_FAKE_JOB_DIR: cwd });

function run(file, args, { env = {}, input = "", cwd = repoRoot, prompt = PROMPT, signalAfterMs = null, signal = "SIGTERM" } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(node, [file, ...args], { cwd, env: { ...process.env, ...markers(cwd, prompt), ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", exitAt = null, closeAt = null, code = null, sig = null;
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    // ChildProcess registers its own stdio 'close' listener first and may emit the child's 'close'
    // before ours runs, so record the end of stdout on 'end' and fall back to now.
    child.stdout.on("end", () => { closeAt ??= Date.now(); });
    child.stdout.on("close", () => { closeAt ??= Date.now(); });
    child.on("exit", (c, s) => { exitAt = Date.now(); code = c; sig = s; });
    child.on("close", () => {
      closeAt ??= Date.now();
      const events = stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { nonjson: l }; } });
      resolve({ code, signal: sig, stdout, stderr, events, ms: exitAt - started, holdMs: closeAt - exitAt });
    });
    if (signalAfterMs !== null) setTimeout(() => child.kill(signal), signalAfterMs);
    child.stdin.end(input);
  });
}

// --- launch builders per fake and form ----------------------------------------------------------
function codexArgs(dir, form, { effort = "low", model = "gpt-6.1-sol", target = "--uncommitted", focus = false } = {}) {
  const answer = join(dir, "answer.md");
  const dev = ["-c", `developer_instructions=${JSON.stringify(CONTRACT)}`];
  if (form === "fresh") return { args: ["exec", "--json", "-o", answer, "-C", dir, "-s", "read-only", "-m", model, "-c", `model_reasoning_effort=${effort}`, ...dev, "-"], input: PROMPT, answer };
  if (form === "resume") return { args: ["exec", "resume", UUID, "--json", "-o", answer, "-c", "sandbox_mode=read-only", "-m", model, "-c", `model_reasoning_effort=${effort}`, ...dev, "-"], input: PROMPT, answer };
  const common = ["--json", "-o", answer, "-c", "sandbox_mode=read-only", "-m", model, "-c", `review_model=${model}`, "-c", `model_reasoning_effort=${effort}`];
  if (focus) return { args: ["exec", "review", ...common, "-"], input: PROMPT, answer };
  return { args: ["exec", "review", target, ...common], input: "", answer };
}
function agyArgs(dir, form, { effort = "low", model = "gemini-4-argon", settings, mode = null, schema = false } = {}) {
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify(settings ?? { permissions: { deny: ["write_file(*)", "edit_file(*)", "command(*)", "unsandboxed(*)", "mcp(*)", "execute_url(*)"] } }));
  const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands", "--print-timeout", "540s", "--sandbox", "--settings", settingsPath, "--model", model];
  if (effort) args.push("--effort", effort);
  if (mode) args.push("--mode", mode);
  if (form === "resume") args.push("--conversation", UUID);
  if (schema) args.push("--json-schema", schemaPath);
  return { args, input: JSON.stringify({ event: "user", message: { content: `${CONTRACT}\n\n${PROMPT}` } }) + "\n", prompt: `${CONTRACT}\n\n${PROMPT}` };
}
function grokArgs(dir, form, { effort = "low", recipe = "explore", schema = false, web = false } = {}) {
  const promptFile = join(dir, "prompt.md");
  writeFileSync(promptFile, PROMPT);
  const session = form === "resume" ? ["-r", UUID] : ["--session-id", UUID];
  const common = ["--always-approve", "--no-subagents", ...(web ? [] : ["--disable-web-search"]), "--disallowed-tools"];
  const RESUME_DENY = "search_replace,write,run_terminal_cmd,search_tool,use_tool,todo_write,monitor,workflow,scheduler_create,scheduler_delete,scheduler_list,send_feedback," + HOSTILE;
  const plan = recipe === "explore" ? ["--agent", "explore", ...common, HOSTILE, "--deny", "MCPTool(*)"]
    : recipe === "resume-deny" ? [...common, RESUME_DENY, "--deny", "MCPTool(*)"]
    : [...common, HOSTILE, "--deny", "Bash(git push*)", "--deny", "Bash(rm -rf *)"];
  const tail = schema ? ["--json-schema", SCHEMA] : ["--rules", CONTRACT];
  const env = { ...guards, ...grokEnv, ...(recipe === "write" ? {} : { GROK_CLAUDE_RULES_ENABLED: "0" }), ...(web ? { COUNCIL_FAKE_WEB: "1" } : {}) };
  return { args: ["--prompt-file", promptFile, ...session, "--cwd", dir, "--output-format", "streaming-json", "--model", "grok-4.7", "--effort", effort, "--no-auto-update", ...plan, ...tail], env };
}

const formFor = (sc) => (sc === "resume" ? "resume" : sc.startsWith("review-") ? "review" : "fresh");

test("fakes answer their probe commands from docs/spike", async () => {
  const codexVersion = spawnSync(node, [fakes.codex, "--version"], { encoding: "utf8" });
  assert.equal(codexVersion.stdout.trim(), "codex-cli 0.163.0");
  assert.equal(spawnSync(node, [fakes.codex, "login", "status"], { encoding: "utf8" }).stdout.trim(), "Logged in using ChatGPT");
  const models = JSON.parse(spawnSync(node, [fakes.codex, "debug", "models"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).stdout);
  assert.ok(models.models.some((m) => m.slug === "gpt-6.1-sol"));
  const mcp = JSON.parse(spawnSync(node, [fakes.codex, "mcp", "list", "--json", "--disable", "plugins", "--disable", "apps"], { encoding: "utf8" }).stdout);
  assert.ok(mcp.every((s) => typeof s.name === "string" && typeof s.enabled === "boolean"));
  assert.equal(spawnSync(node, [fakes.agy, "--version"], { encoding: "utf8" }).stdout.trim(), "1.4.12");
  assert.match(spawnSync(node, [fakes.agy, "models"], { encoding: "utf8" }).stdout, /^gemini-4-argon-medium\tGemini 4 Argon \(Medium\)/m);
  assert.match(spawnSync(node, [fakes.grok, "--version"], { encoding: "utf8" }).stdout, /^grok 1\.0\.70/);
  assert.match(spawnSync(node, [fakes.grok, "models"], { encoding: "utf8" }).stdout, /\* grok-4\.6 \(default\)/);
  assert.match(spawnSync(node, [fakes.grok, "--help"], { encoding: "utf8" }).stdout, /--effort/);
});

for (const sc of SCENARIOS) {
  test(`fake-codex scenario ${sc}`, async () => {
    const dir = tmp();
    try {
      const { args, input, answer } = codexArgs(dir, formFor(sc));
      const env = { ...guards, COUNCIL_FAKE_SCENARIO: sc, COUNCIL_FAKE_SLOW_MS: "300", COUNCIL_FAKE_HOLD_MS: "1500" };
      const r = await run(fakes.codex, args, { env, input, cwd: dir });
      if (sc === "effort-error") {
        assert.equal(r.code, 1);
        assert.deepEqual(r.events.map((e) => e.type), ["error"]);
        return;
      }
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.events[0].type, "thread.started");
      assert.equal(r.events.at(-1).type, "turn.completed");
      assert.ok(existsSync(answer), "answer file written");
      assertShapes("codex", r.events);
      if (sc === "resume") assert.equal(r.events[0].thread_id, UUID);
      if (sc === "review-findings") assert.match(readFileSync(answer, "utf8"), /\[P1\]/);
      if (sc === "review-malformed") assert.doesNotMatch(readFileSync(answer, "utf8"), /\[P[01]\]/);
      if (sc === "denied") assert.ok(r.events.some((e) => e.item?.type === "command_execution" && e.item.exit_code === 1));
      if (sc === "slow") assert.ok(r.ms >= 300, `slow took ${r.ms} ms`);
      if (sc === "hold-pipes") assert.ok(r.holdMs >= 1200, `stdout closed ${r.holdMs} ms after exit`);
      else assert.ok(r.holdMs < 1000, `stdout closed ${r.holdMs} ms after exit`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test(`fake-agy scenario ${sc}`, async () => {
    const dir = tmp();
    try {
      const { args, input, prompt } = agyArgs(dir, formFor(sc), { schema: sc.startsWith("review-") });
      const env = { ...guards, COUNCIL_FAKE_SCENARIO: sc, COUNCIL_FAKE_SLOW_MS: "300", COUNCIL_FAKE_HOLD_MS: "1500" };
      const r = await run(fakes.agy, args, { env, input, cwd: dir, prompt });
      const result = r.events.find((e) => e.event === "result")?.result;
      assertShapes("agy", r.events);
      if (sc === "effort-error") {
        assert.equal(r.code, 1);
        assert.equal(result.status, "ERROR");
        assert.match(result.error, /invalid model selection/);
        assert.match(r.stderr, /invalid model selection/);
        return;
      }
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.events[0].event, "init");
      assert.equal(result.status, "SUCCESS");
      assert.equal(result.denied_actions, undefined, "denied_actions is absent in every recorded SUCCESS result");
      if (sc === "resume") { assert.equal(result.conversation_id, UUID); assert.equal(result.num_turns, 2); }
      if (sc === "denied") {
        const step = r.events.find((e) => e.step_update?.step_type === "tool" && e.step_update.state === "ERROR")?.step_update;
        assert.equal(step.tool_name, "write_file");
        assert.equal(step.tool_info.error.type, "TOOL_ERROR");
        assert.match(step.tool_info.error.message, /Permission denied for write_file\(.*\)\. Matches user-configured deny rule\./);
      }
      if (sc === "review-findings") { assert.equal(result.structured_output.verdict, "needs-attention"); assert.ok(result.structured_output.findings.length >= 1); }
      if (sc === "review-malformed") assert.equal(result.structured_output.summary, undefined);
      if (sc === "slow") assert.ok(r.ms >= 300);
      if (sc === "hold-pipes") assert.ok(r.holdMs >= 1200, `stdout closed ${r.holdMs} ms after exit`);
      else assert.ok(r.holdMs < 1000);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test(`fake-grok scenario ${sc}`, async () => {
    const dir = tmp();
    try {
      const { args, env: base } = grokArgs(dir, formFor(sc), { schema: sc.startsWith("review-") });
      const env = { ...base, COUNCIL_FAKE_SCENARIO: sc, COUNCIL_FAKE_SLOW_MS: "300", COUNCIL_FAKE_HOLD_MS: "1500" };
      const r = await run(fakes.grok, args, { env, cwd: dir });
      if (sc === "effort-error") {
        assert.equal(r.code, 1);
        assert.equal(r.events[0].type, "error");
        assert.match(r.events[0].message, /unknown effort level 'max'; use one of: xhigh, high, medium, low/);
        assertShapes("grok", r.events);
        return;
      }
      assert.equal(r.code, 0, r.stderr);
      assertShapes("grok", r.events, { allowExtraTypes: sc === "denied" ? ["tool_call", "tool_call_update"] : [] });
      assert.equal(r.events[0].type, "available_commands");
      assert.deepEqual(r.events[0].tools, ["read_file", "list_dir", "grep"]);
      const end = r.events.at(-1);
      assert.equal(end.type, "end");
      assert.equal(end.stopReason, "end_turn");
      assert.equal(end.sessionId, UUID);
      if (sc === "denied") assert.ok(r.events.some((e) => e.type === "tool_call" && e.toolName === "write"));
      if (sc === "review-findings") assert.equal(end.structuredOutput.verdict, "needs-attention");
      if (sc === "review-malformed") assert.equal(end.structuredOutput.findings, undefined);
      if (sc === "slow") assert.ok(r.ms >= 300);
      if (sc === "hold-pipes") assert.ok(r.holdMs >= 1200, `stdout closed ${r.holdMs} ms after exit`);
      else assert.ok(r.holdMs < 1000);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("slow scenarios stop on SIGTERM the way the probes recorded", async () => {
  const dir = tmp();
  try {
    const env = { ...guards, COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "10000" };
    const c = codexArgs(dir, "fresh");
    const codex = await run(fakes.codex, c.args, { env, input: c.input, cwd: dir, signalAfterMs: 300 });
    assert.equal(codex.code, 143, "codex probe: killed by SIGTERM (143 in the fake; the real CLI died on the signal)");
    const a = agyArgs(dir, "fresh");
    const agy = await run(fakes.agy, a.args, { env, input: a.input, cwd: dir, prompt: a.prompt, signalAfterMs: 300 });
    assert.equal(agy.code, 1);
    const result = agy.events.at(-1).result;
    assert.equal(result.status, "ERROR");
    assert.equal(result.finished_reason, "interrupted");
    const g = grokArgs(dir, "fresh");
    const grok = await run(fakes.grok, g.args, { env: { ...g.env, COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "10000" }, cwd: dir, signalAfterMs: 300 });
    assert.equal(grok.code, 143);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fakes refuse a wrong launch contract with exit 99", async () => {
  const dir = tmp();
  const other = tmp(); // a sibling job directory, not a parent of `dir`
  try {
    // missing guard variable
    const c = codexArgs(dir, "fresh");
    const { COUNCIL_DEPTH, ...partial } = guards;
    assert.equal((await run(fakes.codex, c.args, { env: partial, input: c.input, cwd: dir })).code, 99);
    // codex: fresh exec without -s; resume with -C; review combined flags and prompt (real exit 2)
    assert.equal((await run(fakes.codex, c.args.filter((x, i, a) => x !== "-s" && a[i - 1] !== "-s"), { env: guards, input: c.input, cwd: dir })).code, 99);
    const resume = codexArgs(dir, "resume");
    assert.equal((await run(fakes.codex, [...resume.args, "-C", dir], { env: guards, input: resume.input, cwd: dir })).code, 99);
    const combined = codexArgs(dir, "review");
    const r = await run(fakes.codex, [...combined.args, "-"], { env: guards, input: "focus", cwd: dir, prompt: "focus" });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /cannot be used with '\[PROMPT\]'/);
    assert.equal((await run(fakes.codex, c.args, { env: { ...guards, COUNCIL_FAKE_EXPECT_CONTRACT: "Other contract." }, input: c.input, cwd: dir })).code, 99, "developer_instructions differs from the contract");
    assert.equal((await run(fakes.codex, c.args, { env: guards, input: c.input + " extra", cwd: dir })).code, 99, "stdin differs from the prompt");
    assert.equal((await run(fakes.codex, c.args, { env: { ...guards, COUNCIL_FAKE_JOB_DIR: other }, input: c.input, cwd: dir })).code, 99, "-o outside the job dir");
    const { COUNCIL_FAKE_EXPECT_PROMPT: _p, ...noMarker } = { ...markers(dir), ...guards };
    assert.equal((await run(fakes.codex, c.args, { env: { ...noMarker, COUNCIL_FAKE_EXPECT_PROMPT: undefined }, input: c.input, cwd: dir })).code, 99, "no prompt marker at all");
    assert.equal((await run(fakes.codex, combined.args, { env: guards, input: "stray", cwd: dir })).code, 99, "unfocused review with stdin");
    const focused = codexArgs(dir, "review", { focus: true });
    assert.equal((await run(fakes.codex, focused.args, { env: guards, input: focused.input, cwd: dir })).code, 0, "focused review with the expected stdin");
    // agy: missing deny rule on a read-only turn; allow rule beyond read_file/read_url; two stdin lines; bad suffix conflict (real exit 1)
    const agyRun = (built, extra = {}) => run(fakes.agy, built.args, { env: guards, input: built.input, cwd: dir, prompt: built.prompt, ...extra });
    const weak = agyArgs(dir, "fresh", { settings: { permissions: { deny: ["write_file(*)"] } } });
    assert.equal((await agyRun(weak)).code, 99);
    const allow = agyArgs(dir, "fresh", { settings: { permissions: { deny: ["write_file(*)", "edit_file(*)", "command(*)", "unsandboxed(*)", "mcp(*)", "execute_url(*)"], allow: ["command(git status)"] } } });
    assert.equal((await agyRun(allow)).code, 99);
    const ok = agyArgs(dir, "fresh");
    assert.equal((await agyRun(ok, { input: ok.input + ok.input })).code, 99, "two NDJSON lines");
    assert.equal((await agyRun(ok, { input: ok.input + "\n" })).code, 99, "trailing blank line");
    assert.equal((await agyRun(ok, { input: ok.input.trimEnd() })).code, 99, "missing newline");
    assert.equal((await agyRun(ok, { input: JSON.stringify({ event: "user", message: { content: ok.prompt }, extra: 1 }) + "\n" })).code, 99, "unexpected key");
    assert.equal((await agyRun(ok, { prompt: "something else" })).code, 99, "content differs from the expected prompt");
    assert.equal((await agyRun(ok, { env: { ...guards, COUNCIL_FAKE_EXPECT_CONTRACT: "Other contract." } })).code, 99, "content does not start with the contract");
    assert.equal((await agyRun(ok, { env: { ...guards, COUNCIL_FAKE_JOB_DIR: other } })).code, 99, "settings file outside the job dir");
    const unsuffixed = agyArgs(dir, "fresh", { model: "gemini-4-argon", effort: null });
    assert.equal((await agyRun(unsuffixed)).code, 99, "unsuffixed family without --effort");
    const suffixedOnly = agyArgs(dir, "fresh", { model: "gemini-4-argon-high", effort: null });
    assert.equal((await agyRun(suffixedOnly)).code, 0, "suffixed id alone is fine");
    const wrongSchema = agyArgs(dir, "fresh", { schema: true });
    const otherSchema = join(dir, "other-schema.json");
    writeFileSync(otherSchema, "{}");
    const idx = wrongSchema.args.indexOf("--json-schema");
    wrongSchema.args[idx + 1] = otherSchema;
    assert.equal((await agyRun(wrongSchema)).code, 99, "schema file differs from the repository schema");
    const conflict = agyArgs(dir, "fresh", { model: "gemini-3.8-flash-low", effort: "high" });
    const cr = await agyRun(conflict);
    assert.equal(cr.code, 1);
    assert.match(cr.stderr, /conflicts with --effort=high/);
    const task = agyArgs(dir, "fresh", { settings: { permissions: { allow: ["command(git status)"] } }, mode: "accept-edits" });
    assert.equal((await agyRun(task)).code, 0, "a task keeps the global lists");
    // grok: explore recipe without --deny MCPTool(*); write recipe with rules disabled; review with --rules; missing compatEnv
    const g = grokArgs(dir, "fresh");
    assert.equal((await run(fakes.grok, g.args.filter((x, i, a) => !(x === "--deny" || a[i - 1] === "--deny")), { env: g.env, cwd: dir })).code, 99);
    const w = grokArgs(dir, "fresh", { recipe: "write" });
    assert.equal((await run(fakes.grok, w.args, { env: w.env, cwd: dir })).code, 0);
    assert.equal((await run(fakes.grok, w.args, { env: { ...w.env, GROK_CLAUDE_RULES_ENABLED: "0" }, cwd: dir })).code, 99);
    const rv = grokArgs(dir, "fresh", { schema: true });
    assert.equal((await run(fakes.grok, [...rv.args, "--rules", "x"], { env: rv.env, cwd: dir })).code, 99);
    const { GROK_CLAUDE_MCPS_ENABLED, ...noMcp } = g.env;
    assert.equal((await run(fakes.grok, g.args, { env: noMcp, cwd: dir })).code, 99);
    const rd = grokArgs(dir, "resume", { recipe: "resume-deny" });
    assert.equal((await run(fakes.grok, rd.args, { env: { ...rd.env, COUNCIL_FAKE_SCENARIO: "resume" }, cwd: dir })).code, 0);
    const web = grokArgs(dir, "fresh", { web: true });
    assert.equal((await run(fakes.grok, web.args, { env: web.env, cwd: dir })).code, 0, "--web omits --disable-web-search");
    assert.equal((await run(fakes.grok, g.args, { env: { ...g.env, COUNCIL_FAKE_WEB: "1" }, cwd: dir })).code, 99, "--disable-web-search present on a --web turn");
    assert.equal((await run(fakes.grok, web.args, { env: g.env, cwd: dir })).code, 99, "--disable-web-search missing without --web");
    assert.equal((await run(fakes.grok, g.args, { env: g.env, cwd: dir, prompt: "a different prompt" })).code, 99, "prompt file content differs");
    assert.equal((await run(fakes.grok, g.args, { env: g.env, cwd: dir, input: "stray stdin" })).code, 99, "stdin must be empty");
    assert.equal((await run(fakes.grok, g.args, { env: { ...g.env, COUNCIL_FAKE_EXPECT_CONTRACT: "Other contract." }, cwd: dir })).code, 99, "--rules differs from the contract");
    assert.equal((await run(fakes.grok, g.args, { env: { ...g.env, COUNCIL_FAKE_JOB_DIR: other }, cwd: dir })).code, 99, "prompt file outside the job dir");
    const emptySchema = grokArgs(dir, "fresh", { schema: true });
    emptySchema.args[emptySchema.args.indexOf("--json-schema") + 1] = "{}";
    assert.equal((await run(fakes.grok, emptySchema.args, { env: emptySchema.env, cwd: dir })).code, 99, "inline schema differs from the repository schema");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
});
