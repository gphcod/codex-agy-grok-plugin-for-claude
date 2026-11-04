// S4.2: grok buildTurn — A5.1 argv, recipes ported whole, compatEnv, carriers, session flags, agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import grok, { FORBIDDEN, HOSTILE, RESUME_DENY, compatEnv, inlineSchema, oneLineContract, recipe, sessionAgent } from "../plugins/council/scripts/lib/providers/grok.mjs";

const SCHEMA = JSON.parse(readFileSync(new URL("../plugins/council/schemas/review-output.schema.json", import.meta.url), "utf8"));
const CONTRACT = readFileSync(new URL("../plugins/council/contract.md", import.meta.url), "utf8").trim();
const SID = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const req = (over = {}) => ({
  verb: "ask", provider: "grok", cwd: "/w", jobId: "abcdefghij123456", jobDir: "/h/jobs/abcdefghij123456", model: "grok-4.7", effort: "low",
  readOnly: true, text: "hello", contract: CONTRACT, thread: null, web: false, adversarial: false, env: {}, launcher: null, ...over,
});
const flag = (args, name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const all = (args, name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));

test("native tools use automatic approvals; legacy explore sessions are upgraded", () => {
  assert.deepEqual(recipe("read-only"), { readOnly: true, agent: "default", forbidden: [], args: ["--always-approve"] });
  assert.deepEqual(recipe("read-only", { legacyExplore: true }).args, ["--agent", "default", "--always-approve"]);
  assert.deepEqual(recipe("write", { web: true }).args, ["--always-approve"]);
  assert.throws(() => recipe("admin"), /unknown recipe admin/);
});

test("compatEnv only prevents updater and hook recursion; integrations remain native", () => {
  const expected = { GROK_DISABLE_AUTOUPDATER: "1", GROK_CLAUDE_HOOKS_ENABLED: "0" };
  assert.deepEqual(compatEnv(true), expected);
  assert.deepEqual(compatEnv(false), expected);
});

test("sessionAgent: the record's agent, else inferred from its mode", () => {
  assert.equal(sessionAgent(null), null);
  assert.equal(sessionAgent({ agent: "default" }), "default");
  assert.equal(sessionAgent({ agent: "explore", readOnly: false }), "explore");
  assert.equal(sessionAgent({ readOnly: false }), "default");
  assert.equal(sessionAgent({ readOnly: true }), "explore");
  assert.equal(sessionAgent({}), "explore");
});

test("ask: fresh session, explore recipe, --rules contract on one line, prompt file in the job dir", () => {
  const t = grok.buildTurn(req());
  assert.match(t.threadId, UUID);
  assert.deepEqual(t.args, [
    "--prompt-file", join("/h/jobs/abcdefghij123456", "prompt.md"), "--session-id", t.threadId, "--cwd", "/w", "--output-format", "streaming-json",
    "--model", "grok-4.7", "--effort", "low", "--no-auto-update", ...recipe("read-only").args, "--rules", oneLineContract(CONTRACT),
  ]);
  assert.equal(t.promptFile, join("/h/jobs/abcdefghij123456", "prompt.md"));
  assert.equal(t.promptText, "hello", "the contract rides --rules, not the prompt");
  assert.deepEqual([t.readOnly, t.agent, t.answerFile, t.contractCarrier], [true, "default", null, "rules"]);
  assert.deepEqual(t.forbidden, FORBIDDEN);
  assert.deepEqual(t.env, compatEnv(true));
  assert.ok(!oneLineContract(CONTRACT).includes("\n"));
    assert.ok(oneLineContract(CONTRACT).startsWith('<council_contract version="1"> Claude calls you;'));
  assert.notEqual(grok.buildTurn(req()).threadId, t.threadId, "a new session id per fresh turn");
});

test("reply: -r on the thread; explore unless the thread ran the default agent, then RESUME_DENY", () => {
  const explore = grok.buildTurn(req({ verb: "reply", thread: { threadId: SID, agent: "explore" } }));
  assert.equal(flag(explore.args, "-r"), SID);
  assert.equal(explore.args.includes("--session-id"), false);
  assert.equal(explore.threadId, SID);
  assert.equal(flag(explore.args, "--agent"), "default");
  assert.equal(explore.agent, "default");
  const deny = grok.buildTurn(req({ verb: "reply", thread: { threadId: SID, agent: "default", readOnly: false } }));
  assert.equal(deny.args.includes("--agent"), false);
  assert.equal(flag(deny.args, "--disallowed-tools"), undefined);
  assert.deepEqual(all(deny.args, "--deny"), []);
  assert.deepEqual([deny.readOnly, deny.agent], [true, "default"]);
  assert.deepEqual(deny.env, compatEnv(true));
  const inferred = grok.buildTurn(req({ verb: "reply", thread: { threadId: SID, readOnly: false } }));
  assert.equal(flag(inferred.args, "--disallowed-tools"), undefined, "a thread record without agent but last run as a task");
});

test("task: write recipe on a new session and on --thread; agent default", () => {
  const fresh = grok.buildTurn(req({ verb: "task", readOnly: false }));
  assert.match(flag(fresh.args, "--session-id"), UUID);
  assert.deepEqual(all(fresh.args, "--deny"), []);
  assert.equal(flag(fresh.args, "--disallowed-tools"), undefined);
  assert.equal(fresh.args.includes("--agent"), false);
  assert.deepEqual([fresh.readOnly, fresh.agent, fresh.forbidden.length], [false, "default", 0]);
  assert.equal(fresh.env.GROK_CLAUDE_RULES_ENABLED, undefined);
  assert.equal(flag(fresh.args, "--rules"), oneLineContract(CONTRACT));
  const resumed = grok.buildTurn(req({ verb: "task", readOnly: false, thread: { threadId: SID, agent: "explore" } }));
  assert.equal(flag(resumed.args, "-r"), SID);
  assert.deepEqual(all(resumed.args, "--deny"), []);
});

test("--web omits --disable-web-search on every recipe", () => {
  for (const over of [{}, { verb: "reply", thread: { threadId: SID, agent: "default" } }, { verb: "task", readOnly: false }]) {
    assert.ok(!grok.buildTurn(req(over)).args.includes("--disable-web-search"));
    assert.ok(!grok.buildTurn(req({ ...over, web: true })).args.includes("--disable-web-search"));
  }
});

test("review: explore, inline --json-schema equal to the repository schema, no --rules, cwd at the repository root", () => {
  const t = grok.buildTurn(req({ verb: "review", cwd: "/repo/sub", text: "focus", reviewPrompt: "RENDERED REVIEW", reviewTarget: { root: "/repo" } }));
  assert.deepEqual(JSON.parse(flag(t.args, "--json-schema")), SCHEMA);
  assert.equal(flag(t.args, "--json-schema"), inlineSchema());
  assert.equal(t.args.includes("--rules"), false);
  assert.equal(flag(t.args, "--cwd"), "/repo");
  assert.equal(flag(t.args, "--agent"), undefined);
  assert.match(flag(t.args, "--session-id"), UUID, "a review is always a new session");
  assert.equal(t.promptText, "RENDERED REVIEW");
  assert.equal(t.contractCarrier, "json-schema");
  assert.equal(t.readOnly, true);
});

test("model and effort pass through as the core resolved them; argv carries no other effort", () => {
  const t = grok.buildTurn(req({ model: "grok-4.7-build-fast", effort: "xhigh", requestedEffort: "max" }));
  assert.equal(flag(t.args, "--model"), "grok-4.7-build-fast");
  assert.equal(flag(t.args, "--effort"), "xhigh");
  assert.equal(t.args.filter((a) => a === "--effort").length, 1);
});
