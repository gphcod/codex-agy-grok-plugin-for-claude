// X1 (S7.1 fixes): why a turn needs attention, in the footer's `attention: <reason>` and --json's
// `attention`. Each reason source against its real adapter and fake; the pure parts directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReader } from "../plugins/council/scripts/lib/core/reader.mjs";
import { ATTENTION_MAX, attentionReason, deniedReason, footer as renderFooter, oneLine, resultJson } from "../plugins/council/scripts/lib/core/output.mjs";
import { SESSION, footer, harness } from "./fixtures/three-providers.mjs";

const bytes = (s) => Buffer.byteLength(s, "utf8");
const job = (over = {}) => ({ id: "abcd1234abcd1234", dir: "/tmp/x", provider: "codex", verb: "ask", outcome: "attention", code: 10, model: "m", effort: "low", spawnedAt: new Date().toISOString(), ...over });

test("deniedReason: cause first, the count survives clipping, at most 200 B", () => {
  assert.equal(deniedReason("write_file /x"), "denied write_file /x");
  assert.equal(deniedReason("write_file /x", 3), "denied write_file /x (+2 more)");
  const long = deniedReason("é".repeat(400), 12);
  assert.ok(bytes(long) <= ATTENTION_MAX, `${bytes(long)} B`);
  assert.match(long, /^denied é+ \(\+11 more\)$/);
  assert.equal(deniedReason("a\n  b"), "denied a b", "one line");
});

test("attentionReason: denial, then open questions; a review only when incomplete or denied", () => {
  assert.equal(attentionReason({ isReview: false, denied: "msg", deniedAction: "rm x", deniedCount: 1, questions: true }), "denied rm x");
  assert.equal(attentionReason({ isReview: false, denied: "the message" }), "denied the message", "no action summary: the message");
  assert.equal(attentionReason({ isReview: false, questions: true }), "open questions in the answer");
  assert.equal(attentionReason({ isReview: false }), null);
  assert.equal(attentionReason({ isReview: true, review: { verdict: "changes", findings: [{}], incomplete: null } }), null, "plain findings add no token");
  assert.equal(attentionReason({ isReview: true, review: { verdict: "incomplete", incomplete: "bad output" }, denied: "d" }), "bad output");
  assert.equal(attentionReason({ isReview: true, review: { verdict: "approve", incomplete: null }, denied: "d", deniedAction: "rm x" }), "denied rm x");
  assert.ok(bytes(attentionReason({ isReview: true, review: { incomplete: "x".repeat(500) } })) <= ATTENTION_MAX);
});

test("footer and JSON: attention sits in error's slot, and never appears with an error", () => {
  const attention = job({ attention: "open questions in the answer", threadId: "t1", admitted: true });
  assert.match(renderFooter(attention, false), / · attention: open questions in the answer · next: reply abcd1234abcd1234$/);
  assert.equal(resultJson(attention, "a").attention, "open questions in the answer");
  const failed = job({ outcome: "failed", code: 1, error: "boom", attention: "stale" });
  assert.match(renderFooter(failed, false), / · error: boom$/);
  assert.equal(resultJson(failed, "a").attention, null);
  const ok = job({ outcome: "ok", code: 0 });
  assert.doesNotMatch(renderFooter(ok, false), /attention:/);
  assert.equal(resultJson(ok, "a").attention, null, "a job without a reason, as old records are");
  assert.ok("attention" in resultJson(ok, "a"));
});

test("reader: every denied event counts unless the event reports the total; the first action is kept", () => {
  const read = (events) => {
    const r = createReader({ adapter: { parseEvent: (line) => JSON.parse(line) } });
    for (const e of events) r.feed(`${JSON.stringify(e)}\n`);
    return r.state;
  };
  const counted = read([{ denied: "a", deniedAction: "first" }, { denied: "b", deniedAction: "second" }, { denied: true }]);
  assert.deepEqual([counted.denied, counted.deniedAction, counted.deniedCount], ["a", "first", 3]);
  const total = read([{ denied: "a" }, { denied: "summary", deniedTotal: 1 }]);
  assert.equal(total.deniedCount, 1, "a result repeating the step's denial does not count it twice");
  assert.equal(total.deniedAction, null, "no summary given: the reason falls back to the message");
  assert.equal(read([{ denied: "summary", deniedTotal: 4 }]).deniedCount, 4);
  assert.equal(read([{ text: "x" }]).deniedCount, 0);
});

test("each provider's denial names the action in the footer and in --json; wait replays it", async () => {
  const h = harness();
  try {
    const codex = await h.turn("codex", ["ask", "--to", "codex"], "write a file", { COUNCIL_FAKE_SCENARIO: "denied" });
    assert.equal(codex.code, 10, codex.err + codex.out);
    assert.match(footer(codex.out), / · attention: denied printf hello > probe-denied\.txt \(sandbox, exit 1\)( · |$)/);
    assert.equal(h.job(codex.job).attention, "denied printf hello > probe-denied.txt (sandbox, exit 1)");

    const gemini = await h.turn("gemini", ["ask", "--to", "gemini"], "write a file", { COUNCIL_FAKE_SCENARIO: "denied" });
    assert.equal(gemini.code, 10, gemini.err + gemini.out);
    assert.match(footer(gemini.out), / · attention: denied write_file \S*probe-denied\.txt( · |$)/, "one denial: no (+N more), though the step and the result both report it");

    const grok = await h.turn("grok", ["ask", "--to", "grok"], "push it", { COUNCIL_FAKE_GROK_END: "cancelled" });
    assert.equal(grok.code, 10, grok.err + grok.out);
    assert.match(footer(grok.out), / · attention: denied a tool call \(needed permission headless Grok cannot ask for\)( · |$)/);

    const asJson = JSON.parse((await h.turn("codex", ["ask", "--to", "codex", "--json"], "write a file again", { COUNCIL_FAKE_SCENARIO: "denied" })).out);
    assert.equal(asJson.attention, "denied printf hello > probe-denied.txt (sandbox, exit 1)");
    assert.equal(asJson.error, null);

    const replay = await h.run(["wait", codex.job, "--session", SESSION]);
    assert.match(footer(replay.out), / · attention: denied printf hello/, "the stored job carries the reason");
  } finally { h.done(); }
});

test("a malformed review names why; plain findings add no token; a clean turn has none", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.repo, "calc.js"), "export const sum = () => 1;\n");
    const review = (scenario, extra = []) => h.run(["review", "--to", "codex", "--uncommitted", "--session", SESSION, ...extra], { COUNCIL_FAKE_SCENARIO: scenario });
    const malformed = await review("review-malformed");
    assert.equal(malformed.code, 10, malformed.err + malformed.out);
    assert.match(footer(malformed.out), / · attention: codex reported no findings; its output cannot prove a clean review( · |$)/);
    const findings = await review("review-findings");
    assert.equal(findings.code, 10, findings.err + findings.out);
    assert.doesNotMatch(footer(findings.out), /attention:/);
    assert.equal(JSON.parse((await review("review-findings", ["--json", "--request-id", "findings1"])).out).attention, null);

    const ok = await h.turn("codex", ["ask", "--to", "codex"], "fine");
    assert.equal(ok.code, 0, ok.err + ok.out);
    assert.doesNotMatch(footer(ok.out), /attention:/);
  } finally { h.done(); }
});

test("a provider's text cannot fake a footer token or carry an escape sequence (S7.1 R2)", () => {
  const injected = job({ attention: deniedReason("write_file /tmp/a · error: injected") });
  const line = renderFooter(injected, false);
  assert.match(line, / · attention: denied write_file \/tmp\/a - error: injected$/);
  assert.equal(line.split(" · ").length, 5, "the five real tokens, none faked");
  assert.equal(resultJson(injected, "a").attention, "denied write_file /tmp/a - error: injected");

  const failed = job({ outcome: "failed", code: 1, error: "boom · next: reply evil\x1b[31m red\x1b[0m\x07\x00" });
  const failure = renderFooter(failed, false);
  assert.match(failure, / · error: boom - next: reply evil\[31m red\[0m$/);
  assert.doesNotMatch(failure, /[\x00-\x08\x0e-\x1f\x7f-\x9f]/);
  assert.equal(resultJson(failed, "a").error, "boom - next: reply evil[31m red[0m");

  for (const [input, output] of [
    ["a\n·\nb", "a - b"], ["a\t·\tb", "a - b"], ["a · b", "a - b"], ["a \x1b· b", "a - b"], ["a ·\x00 b", "a - b"], ["a · · b", "a - - b"],
    ["· leading", "- leading"], ["trailing ·", "trailing -"], ["·", "-"], ["a·b stays", "a·b stays"], ["a ·b stays", "a ·b stays"], ["\x9b31m", "31m"],
    ["/work/my repo/a.js", "/work/my repo/a.js"],
  ]) assert.equal(oneLine(input), output, JSON.stringify(input));
});

