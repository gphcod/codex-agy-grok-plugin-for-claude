// S2.2: output.mjs (A3.4 start line, footer, --json object, 24 KiB cap, readAnswer).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANSWER_CAP, capAnswer, effortToken, elapsed, footer, readAnswer, recoveryHint, renderResult, resultJson, startLine, utf8Prefix } from "../plugins/council/scripts/lib/core/output.mjs";

const ID = "abcdefghij123456";
const base = (over = {}) => ({
  provider: "codex", id: ID, dir: "/tmp/jobs/" + ID, verb: "ask", outcome: "ok", code: 0, model: "gpt-6.1-sol", effort: "high", requestedEffort: "high",
  modelVerified: true, tier: "consult", round: 1, rounds: 9, threadId: "th-1", admitted: true, session: "sess-1",
  spawnedAt: "2026-10-31T10:00:00.000Z", endedAt: "2026-10-31T10:00:12.000Z", ...over,
});

test("utf8Prefix, capAnswer and elapsed", () => {
  assert.equal(utf8Prefix("héllo", 2), "h");
  assert.equal(utf8Prefix("héllo", 3), "hé");
  assert.equal(utf8Prefix("abc", 10), "abc");
  const big = "x".repeat(ANSWER_CAP + 10);
  assert.deepEqual(capAnswer(big), { text: "x".repeat(ANSWER_CAP), clipped: true });
  assert.deepEqual(capAnswer("short"), { text: "short", clipped: false });
  assert.equal(elapsed(12000), "12s");
  assert.equal(elapsed(75000), "1m15s");
  assert.equal(elapsed(3725000), "1h02m");
  assert.equal(elapsed(-5), "0s");
});

test("start line per A3.4", () => {
  assert.equal(startLine(base()), `[council] provider=codex job=${ID} thread=th-1`);
  assert.equal(startLine(base({ threadId: null, requestedThreadId: null })), `[council] provider=codex job=${ID} thread=?`);
  assert.equal(startLine(base({ threadId: null, requestedThreadId: "req-7" })), `[council] provider=codex job=${ID} thread=req-7`);
  assert.equal(startLine(base({ verb: "review", target: "--uncommitted" })), `[council] provider=codex job=${ID} thread=th-1 target=--uncommitted`);
  assert.equal(startLine(base({ provider: "grok", target: "branch  against\nmain" })), `[council] provider=grok job=${ID} thread=th-1 target=branch against main`);
});

test("footer: mandatory fields and the effort clamp token", () => {
  assert.equal(footer(base(), false), `council codex ok · job ${ID} · gpt-6.1-sol/high · 12s · round 1/9 · next: reply ${ID}`);
  assert.equal(effortToken({ model: "gemini-4-argon", effort: "high", requestedEffort: "xhigh" }), "gemini-4-argon/high<=xhigh");
  assert.equal(effortToken({ model: "grok-4.7", effort: "xhigh", requestedEffort: "xhigh" }), "grok-4.7/xhigh");
  assert.equal(effortToken({ model: "m", effort: "low" }), "m/low");
  const clamped = footer(base({ provider: "gemini", model: "gemini-4-argon", effort: "high", requestedEffort: "xhigh" }), false);
  assert.match(clamped, /^council gemini ok · job [a-z0-9]{16} · gemini-4-argon\/high<=xhigh · 12s · round 1\/9/);
});

test("footer: every outcome label", () => {
  assert.match(footer(base({ outcome: "attention", code: 10 }), false), /^council codex needs attention · /);
  assert.match(footer(base({ outcome: "failed", code: 1, error: "boom" }), false), /^council codex failed · .* · error: boom/);
  assert.match(footer(base({ outcome: "cancelled", code: 1 }), false), /^council codex cancelled · /);
});

test("footer: round only on threaded verbs, edited only on task, unreviewed only on review", () => {
  assert.match(footer(base({ verb: "ask", round: 1, rounds: 9 }), false), / · round 1\/9/);
  assert.match(footer(base({ verb: "reply", round: 3, rounds: 9 }), false), / · round 3\/9/);
  assert.match(footer(base({ verb: "task", round: 1, rounds: 9, edited: ["a.js", "b.js"] }), false), / · round 1\/9 · edited 2/);
  assert.doesNotMatch(footer(base({ verb: "ask", edited: ["a.js"] }), false), /edited/);
  const review = footer(base({ verb: "review", round: 1, rounds: 9, unreviewed: ["big.bin (over the inline cap)"], threadId: "th-1" }), false);
  assert.doesNotMatch(review, /round/);
  assert.match(review, / · unreviewed 1/);
  assert.doesNotMatch(review, /next: reply/, "a review has no follow-up thread");
  assert.doesNotMatch(footer(base({ verb: "review", unreviewed: [] }), false), /unreviewed/);
  assert.doesNotMatch(footer(base({ verb: "ask", unreviewed: ["x"] }), false), /unreviewed/);
});

test("footer: model unverified, full file, error and recovery hints", () => {
  assert.match(footer(base({ modelVerified: false }), false), / · model unverified · /);
  assert.match(footer(base(), true), new RegExp(` · full: [\\\\/]tmp[\\\\/]jobs[\\\\/]${ID}[\\\\/]answer.md`));
  assert.match(footer(base({ answerClipped: true }), false), / · full: /);
  assert.match(footer(base({ error: "multi\nline   error" }), false), / · error: multi line error/);
  assert.match(footer(base({ cleanupPending: true, stopped: false }), false), new RegExp(` · cleanup pending; next: cancel ${ID}; do not resume$`));
  assert.match(footer(base({ claimHeld: true }), false), /cleanup pending; next: cancel/);
  assert.match(footer(base({ unattributedPipes: true }), false), new RegExp(`thread locked: an unidentified process kept the provider's output open; next: cancel ${ID} to stop what it can identify, then a new ask$`));
  assert.match(footer(base({ unattributedPipes: true, identifiedStopped: true, answerComplete: true }), false), new RegExp(`answer complete; thread locked: .* next: a new ask; job ${ID}$`));
  assert.equal(recoveryHint(base({ threadId: null })), null);
  assert.equal(recoveryHint(base({ admitted: false })), null);
  // order of optional fields: round, edited, unreviewed, unverified, full, error, hint
  const all = footer(base({ verb: "task", edited: ["x"], modelVerified: false, answerClipped: true, error: "e", cleanupPending: true }), false);
  assert.equal(all, `council codex ok · job ${ID} · gpt-6.1-sol/high · 12s · round 1/9 · edited 1 · model unverified · full: ${join("/tmp", "jobs", ID, "answer.md")} · error: e · cleanup pending; next: cancel ${ID}; do not resume`);
});

test("renderResult: body then footer; the cap adds full: <file>", () => {
  const out = renderResult(base(), "The answer.\n\n");
  assert.equal(out, `The answer.\ncouncil codex ok · job ${ID} · gpt-6.1-sol/high · 12s · round 1/9 · next: reply ${ID}\n`);
  const capped = renderResult(base(), "y".repeat(ANSWER_CAP + 1));
  assert.ok(capped.startsWith("y".repeat(ANSWER_CAP) + "\n"));
  assert.match(capped, / · full: [\\/]tmp[\\/]jobs[\\/][a-z0-9]{16}[\\/]answer\.md/);
  assert.equal(renderResult(base(), ""), `council codex ok · job ${ID} · gpt-6.1-sol/high · 12s · round 1/9 · next: reply ${ID}\n`);
});

test("--json carries every A3.4 field", () => {
  const j = resultJson(base({ verb: "review", unreviewed: ["big.bin"], review: { verdict: "changes", findings: [{ severity: "BLOCKER", file: "a.js", line: 3, title: "t", text: "x" }], coverage: { reviewed: ["a.js"], unreviewed: ["big.bin"] } }, costUsd: 0.01, failedCommands: [{ cmd: "npm test", exit: 1 }], edited: [] }), "answer text");
  for (const k of ["provider", "job", "thread", "session", "model", "modelVerified", "effort", "requestedEffort", "tier", "round", "rounds", "verdict", "findings", "coverage", "edited", "failedCommands", "costUsd", "exit", "answerFile"]) assert.ok(k in j, k);
  assert.equal(j.provider, "codex"); assert.equal(j.job, ID); assert.equal(j.thread, "th-1"); assert.equal(j.session, "sess-1");
  assert.equal(j.verdict, "changes"); assert.equal(j.findings.length, 1); assert.deepEqual(j.coverage.unreviewed, ["big.bin"]);
  assert.equal(j.round, null, "no round on a review");
  assert.deepEqual(j.failedCommands, [{ cmd: "npm test", exit: 1 }]);
  assert.equal(j.costUsd, 0.01); assert.equal(j.exit, 0); assert.equal(j.answerFile, join("/tmp", "jobs", ID, "answer.md"));
  assert.equal(j.answer, "answer text"); assert.equal(j.clipped, false); assert.equal(j.status, "ok");
  const ask = resultJson(base(), "x".repeat(ANSWER_CAP + 5));
  assert.equal(ask.round, 1); assert.equal(ask.rounds, 9); assert.equal(ask.clipped, true); assert.equal(ask.answer.length, ANSWER_CAP);
  assert.equal(ask.verdict, null); assert.deepEqual(ask.findings, []); assert.deepEqual(ask.coverage, { reviewed: [], unreviewed: [] });
  const unverified = resultJson(base({ modelVerified: false, requestedEffort: "xhigh", effort: "high" }), "");
  assert.equal(unverified.modelVerified, false); assert.equal(unverified.requestedEffort, "xhigh"); assert.equal(unverified.effort, "high");
  const failed = resultJson(base({ outcome: "failed", code: 1, error: "e", cleanupPending: true }), "");
  assert.equal(failed.exit, 1); assert.equal(failed.error, "e"); assert.equal(failed.cleanupPending, true);
});

test("readAnswer: cap, nonempty and the open-questions scan", () => {
  const dir = mkdtempSync(join(tmpdir(), "council-answer-"));
  try {
    const f = join(dir, "answer.md");
    writeFileSync(f, "pong\n");
    assert.deepEqual(readAnswer(f), { answer: "pong\n", answerClipped: false, nonempty: true, questions: false });
    writeFileSync(f, "   \n");
    assert.equal(readAnswer(f).nonempty, false);
    writeFileSync(f, "Outcome: done\n\nOpen questions: none\nNext: nothing\n");
    assert.equal(readAnswer(f).questions, false);
    writeFileSync(f, "Outcome: done\n\n**Open questions:** should we cache?\nNext: nothing\n");
    assert.equal(readAnswer(f).questions, true);
    writeFileSync(f, "Open questions:\n- is this right?\nVerification: not run\n");
    assert.equal(readAnswer(f).questions, true);
    writeFileSync(f, "z".repeat(ANSWER_CAP + 100));
    const big = readAnswer(f);
    assert.equal(big.answerClipped, true);
    assert.equal(Buffer.byteLength(big.answer), ANSWER_CAP);
    writeFileSync(f, "é".repeat(ANSWER_CAP));
    assert.equal(readAnswer(f).answer.length <= ANSWER_CAP, true);
    writeFileSync(f, "a".repeat(1024 * 1024 + 1));
    assert.throws(() => readAnswer(f), /answer line exceeds 1 MiB/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
