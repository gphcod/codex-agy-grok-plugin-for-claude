// C1b (S7.1 fixes): a call without a usable --session falls back to the host's CLAUDE_CODE_SESSION_ID,
// so `--last`, bare `wait` and bare `cancel` can find its job; provider children never carry that id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionOf } from "../plugins/council/scripts/council.mjs";
import { childEnv } from "../plugins/council/scripts/lib/core/execution.mjs";
import { SESSION, footer, harness, markers } from "./fixtures/three-providers.mjs";

const HOST = "0d2254b0-9c48-4cc9-8a11-1234567890ab";
const OTHER = "11111111-2222-4333-8444-555555555555";

test("sessionOf: --session wins; absent, empty or literal falls back; only a UUID-like value counts", () => {
  const env = { CLAUDE_CODE_SESSION_ID: HOST };
  assert.equal(sessionOf({ session: "mine" }, env), "mine");
  for (const options of [{}, { session: "" }, { session: "${CLAUDE_SESSION_ID}" }]) assert.equal(sessionOf(options, env), HOST, JSON.stringify(options));
  assert.equal(sessionOf({ session: HOST.toUpperCase() }, {}), HOST.toUpperCase());
  for (const value of [undefined, "", "${CLAUDE_CODE_SESSION_ID}", "not-a-uuid", `${HOST}\n`, `x${HOST}`]) {
    assert.equal(sessionOf({}, { CLAUDE_CODE_SESSION_ID: value }), null, JSON.stringify(value));
  }
});

test("childEnv never passes the host's session id on", () => {
  const env = childEnv({ PATH: "/bin", CLAUDE_CODE_SESSION_ID: HOST }, { EXTRA: "1" });
  assert.equal("CLAUDE_CODE_SESSION_ID" in env, false);
  assert.deepEqual([env.PATH, env.EXTRA, env.COUNCIL_DEPTH], ["/bin", "1", "1"]);
});

test("a call without --session is scoped to the host's session: reply --last, bare wait and bare cancel find it", async () => {
  const h = harness();
  const host = { CLAUDE_CODE_SESSION_ID: HOST };
  try {
    const text = "no session flag";
    const ask = await h.run(["ask", "--to", "codex", "--", text], { ...markers("codex", text), ...host });
    assert.equal(ask.code, 0, ask.err + ask.out);
    assert.equal(h.job(ask.job).session, HOST);
    assert.equal(h.invocations().at(-1).hostSession, null, "the provider child does not carry the id");

    const listed = await h.run(["wait", "--json"], host);
    assert.ok(JSON.parse(listed.out).some((j) => j.job === ask.job), listed.out);
    const elsewhere = await h.run(["wait", "--json"], { CLAUDE_CODE_SESSION_ID: OTHER });
    assert.ok(!elsewhere.out.includes(ask.job), "another session does not see it");

    const replyText = "and again";
    const reply = await h.run(["reply", "--last", "--", replyText], { ...markers("codex", replyText), ...host, COUNCIL_FAKE_SCENARIO: "resume" });
    assert.equal(reply.code, 0, reply.err + reply.out);
    assert.match(footer(reply.out), /round 2\/9/);

    const slowText = "a slow one";
    const slow = h.run(["ask", "--to", "codex", "--", slowText], { ...markers("codex", slowText), ...host, COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "30000" });
    const known = new Set([ask.job, reply.job]);
    for (const end = Date.now() + 10000; !h.jobIds().some((id) => !known.has(id) && h.job(id)?.pid);) {
      assert.ok(Date.now() < end, "the slow job started");
      await new Promise((r) => setTimeout(r, 20));
    }
    const notMine = await h.run(["cancel"], { CLAUDE_CODE_SESSION_ID: OTHER });
    assert.match(notMine.out, /no running council job/);
    const cancelled = await h.run(["cancel"], host);
    assert.equal(cancelled.code, 0, cancelled.err + cancelled.out);
    assert.match(cancelled.out, /^(cancelled|finished) · codex · job /);
    assert.equal((await slow).code, 1);
  } finally { h.done(); }
});

test("a literal or empty --session falls back too; an explicit one keeps its own scope; no value at all is no session", async () => {
  const h = harness();
  try {
    const call = (flags, text, env) => h.run(["ask", "--to", "grok", ...flags, "--", text], { ...markers("grok", text), ...env });
    const host = { CLAUDE_CODE_SESSION_ID: HOST };
    assert.equal(h.job((await call(["--session", "${CLAUDE_SESSION_ID}"], "literal", host)).job).session, HOST);
    assert.equal(h.job((await call(["--session", ""], "empty", host)).job).session, HOST);
    assert.equal(h.job((await call(["--session", SESSION], "explicit", host)).job).session, SESSION);
    assert.equal(h.job((await call([], "bad value", { CLAUDE_CODE_SESSION_ID: "not-a-uuid" })).job).session, null);
    assert.equal(h.job((await call([], "no value", {})).job).session, null);
  } finally { h.done(); }
});
