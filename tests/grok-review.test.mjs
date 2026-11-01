// S4.4: grok reviewPlan and finalizeReview — collected-diff templates; schema validation (reviewProblem)
// before mapping into A5.2; unreviewed from the core collection; malformed output never approves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import grok from "../plugins/council/scripts/lib/providers/grok.mjs";
import { finalizeReviewTurn } from "../plugins/council/scripts/lib/core/review.mjs";

const recorded = readFileSync(new URL("./fixtures/streams/grok/json-schema.jsonl", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "end").structuredOutput;
const finding = (over = {}) => ({ severity: "medium", title: "T", body: "B", file: "a.js", line_start: 2, line_end: 4, confidence: 0.5, recommendation: "R", ...over });

test("reviewPlan: collected diff, review or adversarial template, inline schema carrier", () => {
  const git = { root: "/r", target: {}, collect: () => { throw new Error("the core collects"); } };
  assert.deepEqual(grok.reviewPlan(git, { adversarial: false }), { native: false, template: "review", schemaCarrier: "inline --json-schema" });
  assert.equal(grok.reviewPlan(git, { adversarial: true }).template, "adversarial-review");
});

test("the recorded structured review maps into A5.2 with BLOCKER for high", () => {
  const r = grok.finalizeReview({ answerText: "", answerFile: null, structured: recorded, unreviewed: [] });
  assert.equal(r.verdict, "changes");
  assert.equal(r.findings[0].severity, "BLOCKER");
  assert.equal(r.findings[0].file, "calc.js");
  assert.equal(r.findings[0].line, 3);
  assert.equal(r.incomplete, null);
  assert.match(r.renderedText, /^Verdict: changes requested\. The loop bound changed/);
  assert.match(r.renderedText, /\nF1 BLOCKER calc\.js:3: Off-by-one/);
});

test("severity map, line ranges, approval with findings becomes changes, clean approval", () => {
  const out = { verdict: "approve", summary: "S", next_steps: ["n"], findings: [finding({ severity: "critical" }), finding({ severity: "medium", line_end: 2 }), finding({ severity: "low", recommendation: " " })] };
  const r = grok.finalizeReview({ structured: out, unreviewed: [] });
  assert.equal(r.verdict, "changes", "an approval that carries findings");
  assert.deepEqual(r.findings.map((f) => f.severity), ["BLOCKER", "MAJOR", "MINOR"]);
  assert.equal(r.findings[0].lineEnd, 4);
  assert.equal(r.findings[1].lineEnd, undefined);
  assert.equal(r.findings[2].recommendation, undefined);
  const clean = grok.finalizeReview({ structured: { verdict: "approve", summary: "fine", findings: [], next_steps: [] }, unreviewed: [] });
  assert.deepEqual([clean.verdict, clean.findings.length, clean.incomplete], ["approve", 0, null]);
});

test("malformed or missing output is incomplete, never an approval (reviewProblem first)", () => {
  for (const [structured, reason] of [
    [null, /missing structured review output/],
    [{ verdict: "needs-attention", summary: "", next_steps: ["fix it"] }, /summary is empty/],
    [{ verdict: "lgtm", summary: "s", findings: [], next_steps: [] }, /verdict must be approve or needs-attention/],
    [{ verdict: "approve", summary: "s", next_steps: [] }, /findings must be an array/],
    [{ verdict: "approve", summary: "s", findings: [finding({ file: "" })], next_steps: [] }, /needs title, body and file/],
    [{ verdict: "approve", summary: "s", findings: [finding({ line_end: 1 })], next_steps: [] }, /invalid line range/],
    [{ verdict: "approve", summary: "s", findings: [finding({ confidence: 2 })], next_steps: [] }, /confidence/],
  ]) {
    const r = grok.finalizeReview({ structured, unreviewed: [] });
    assert.equal(r.verdict, "incomplete");
    assert.match(r.incomplete, reason);
  }
});

test("through the core: unreviewed comes from the collection and forces exit 10", () => {
  const clean = { verdict: "approve", summary: "fine", findings: [], next_steps: [] };
  const full = finalizeReviewTurn({ adapter: grok, structured: clean, unreviewed: [], reviewed: ["a.js"] });
  assert.equal(full.exit, 0);
  assert.deepEqual(full.result.coverage, { reviewed: ["a.js"], unreviewed: [] });
  const partial = finalizeReviewTurn({ adapter: grok, structured: clean, unreviewed: ["big.bin (over the inline cap)"], reviewed: ["a.js"] });
  assert.equal(partial.exit, 10);
  assert.deepEqual(partial.result.coverage.unreviewed, ["big.bin (over the inline cap)"]);
  assert.match(partial.renderedText, /Not reviewed \(outside this review; never approved\):\n- big\.bin/);
  const bad = finalizeReviewTurn({ adapter: grok, structured: { verdict: "approve" }, unreviewed: [] });
  assert.deepEqual([bad.exit, bad.result.verdict], [10, "incomplete"]);
});
