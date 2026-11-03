// S2.5: review.mjs — schema validation, A5.2 normalization and exit rules, rendering, templates,
// contract.md, and a review turn end to end through the lifecycle with the null adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_ROOT } from "../plugins/council/scripts/lib/core/catalog.mjs";
import {
  PLACEHOLDERS, SEVERITY_TAG, TEMPLATES, finalizeReviewTurn, incompleteResult, interpolate, loadTemplate, normalizeStructuredReview, placeholders, renderReview,
  renderReviewPrompt, resultProblem, reviewExit, reviewProblem,
} from "../plugins/council/scripts/lib/core/review.mjs";

const finding = (over = {}) => ({ severity: "high", title: "Off-by-one", body: "Reads past the end.", file: "calc.js", line_start: 3, line_end: 3, confidence: 0.9, recommendation: "Use <.", ...over });
const valid = (over = {}) => ({ verdict: "needs-attention", summary: "One defect.", findings: [finding()], next_steps: ["fix it"], ...over });
const approve = (over = {}) => ({ verdict: "approve", summary: "Looks right.", findings: [], next_steps: [], ...over });

test("reviewProblem validates every field of the shared schema", () => {
  assert.equal(reviewProblem(valid()), null);
  assert.equal(reviewProblem(approve()), null);
  assert.equal(reviewProblem(null), "missing structured review output");
  assert.equal(reviewProblem([]), "missing structured review output");
  assert.equal(reviewProblem("text"), "missing structured review output");
  assert.equal(reviewProblem({ verdict: "approve" }), "review summary is empty", "an approval without the required fields is rejected");
  assert.equal(reviewProblem(valid({ verdict: "ship-it" })), "review verdict must be approve or needs-attention");
  assert.equal(reviewProblem(valid({ summary: "  " })), "review summary is empty");
  assert.equal(reviewProblem(valid({ findings: "none" })), "review findings must be an array");
  assert.equal(reviewProblem(valid({ findings: [null] })), "review finding 1 is not an object");
  assert.equal(reviewProblem(valid({ findings: [finding({ severity: "blocker" })] })), "review finding 1 has an unknown severity");
  assert.equal(reviewProblem(valid({ findings: [finding({ file: "" })] })), "review finding 1 needs title, body and file");
  assert.equal(reviewProblem(valid({ findings: [finding({ title: undefined })] })), "review finding 1 needs title, body and file");
  assert.equal(reviewProblem(valid({ findings: [finding({ line_start: 0 })] })), "review finding 1 has an invalid line range");
  assert.equal(reviewProblem(valid({ findings: [finding({ line_start: 5, line_end: 4 })] })), "review finding 1 has an invalid line range");
  assert.equal(reviewProblem(valid({ findings: [finding({ line_start: 1.5 })] })), "review finding 1 has an invalid line range");
  assert.equal(reviewProblem(valid({ findings: [finding({ confidence: 1.2 })] })), "review finding 1 confidence must be 0 to 1");
  assert.equal(reviewProblem(valid({ findings: [finding({ confidence: "high" })] })), "review finding 1 confidence must be 0 to 1");
  assert.equal(reviewProblem(valid({ findings: [finding({ recommendation: null })] })), "review finding 1 needs a recommendation");
  assert.equal(reviewProblem(valid({ findings: [finding(), finding({ severity: "x" })] })), "review finding 2 has an unknown severity");
  assert.equal(reviewProblem(valid({ next_steps: [""] })), "review next_steps must be non-empty strings");
  assert.equal(reviewProblem(valid({ next_steps: undefined })), "review next_steps must be non-empty strings");
});

test("normalizeStructuredReview: validation before mapping, severity tags, verdicts", () => {
  assert.deepEqual(SEVERITY_TAG, { critical: "BLOCKER", high: "BLOCKER", medium: "MAJOR", low: "MINOR" });
  const sev = ["critical", "high", "medium", "low"].map((s) => normalizeStructuredReview(valid({ findings: [finding({ severity: s })] })).result.findings[0].severity);
  assert.deepEqual(sev, ["BLOCKER", "BLOCKER", "MAJOR", "MINOR"]);
  const n = normalizeStructuredReview(valid({ findings: [finding({ line_start: 3, line_end: 7, recommendation: "  " })] }), { reviewed: ["calc.js"], unreviewed: ["big.bin"] });
  assert.deepEqual(n.result, {
    verdict: "changes",
    findings: [{ severity: "BLOCKER", file: "calc.js", line: 3, lineEnd: 7, title: "Off-by-one", text: "Reads past the end.", confidence: 0.9 }],
    coverage: { reviewed: ["calc.js"], unreviewed: ["big.bin"] }, incomplete: null,
  });
  assert.equal(n.summary, "One defect.");
  assert.deepEqual(n.nextSteps, ["fix it"]);
  assert.equal(normalizeStructuredReview(approve()).result.verdict, "approve");
  assert.equal(normalizeStructuredReview(approve({ findings: [finding({ severity: "low" })] })).result.verdict, "changes", "findings with an approval verdict → changes");
  assert.equal(normalizeStructuredReview(valid({ findings: [] })).result.verdict, "changes", "needs-attention without findings → changes");
  const bad = normalizeStructuredReview({ verdict: "approve" }, { unreviewed: ["x"] });
  assert.deepEqual(bad.result, { verdict: "incomplete", findings: [], coverage: { reviewed: [], unreviewed: ["x"] }, incomplete: "review summary is empty" });
  assert.equal(normalizeStructuredReview(undefined).result.incomplete, "missing structured review output");
});

test("reviewExit implements the A5.2 exit rules", () => {
  const ok = { verdict: "approve", findings: [], coverage: { reviewed: ["a"], unreviewed: [] }, incomplete: null };
  assert.equal(reviewExit(ok), 0);
  assert.equal(reviewExit({ ...ok, findings: [{ severity: "MINOR", file: "a", title: "t", text: "" }] }), 10, "findings exist");
  assert.equal(reviewExit({ ...ok, coverage: { reviewed: [], unreviewed: ["big"] } }), 10, "coverage incomplete");
  assert.equal(reviewExit({ ...ok, verdict: "changes" }), 10, "needs-attention without findings");
  assert.equal(reviewExit(incompleteResult("malformed")), 10, "malformed output never approves");
  assert.equal(reviewExit({ ...ok, incomplete: "x" }), 10);
});

test("resultProblem checks an adapter's mapped result", () => {
  const ok = { verdict: "approve", findings: [], coverage: { reviewed: [], unreviewed: [] }, incomplete: null };
  assert.equal(resultProblem(ok), null);
  assert.equal(resultProblem(null), "the adapter returned no review result");
  assert.match(resultProblem({ ...ok, verdict: "lgtm" }), /unknown review verdict "lgtm"/);
  assert.equal(resultProblem({ ...ok, findings: {} }), "review findings must be an array");
  assert.equal(resultProblem({ ...ok, findings: [{ severity: "high", file: "a", title: "t", text: "x" }] }), "review finding 1 is malformed", "native severities must be mapped to tags");
  assert.equal(resultProblem({ ...ok, findings: [{ severity: "MAJOR", file: "a", title: "t", text: "x", line: 0 }] }), "review finding 1 has an invalid line");
  assert.equal(resultProblem({ ...ok, findings: [{ severity: "MAJOR", file: "a", title: "t", text: "x", line: null }] }), null, "a finding may have no line");
  assert.equal(resultProblem({ ...ok, verdict: "incomplete" }), "an incomplete review needs its reason");
});

test("renderReview: verdict line, F-numbered tagged findings with file:line, fixes, next steps and coverage", () => {
  const { result, summary, nextSteps } = normalizeStructuredReview(valid({ findings: [finding(), finding({ severity: "medium", title: "Naming", body: "Unclear.", file: "b.js", line_start: 10, line_end: 12, recommendation: "" })] }), { unreviewed: ["big.bin (over the inline cap)"] });
  const text = renderReview(result, { summary, nextSteps });
  assert.equal(text, [
    "Verdict: changes requested. One defect.", "",
    "F1 BLOCKER calc.js:3: Off-by-one", "Reads past the end.", "Fix: Use <.", "",
    "F2 MAJOR b.js:10-12: Naming", "Unclear.", "",
    "Next steps:", "- fix it", "",
    "Not reviewed (outside this review; never approved):", "- big.bin (over the inline cap)", "",
  ].join("\n"));
  assert.equal(renderReview(normalizeStructuredReview(approve()).result, { summary: "Looks right." }), "Verdict: approve. Looks right.\n");
  assert.equal(renderReview(incompleteResult("missing structured review output")), "Verdict: incomplete (missing structured review output).\n");
  assert.equal(renderReview({ verdict: "changes", findings: [{ severity: "MINOR", file: "x.md", line: null, title: "t", text: "" }], coverage: { reviewed: [], unreviewed: [] }, incomplete: null }), "Verdict: changes requested.\n\nF1 MINOR x.md: t\n");
});

test("finalizeReviewTurn: the core owns coverage and the exit; adapter failures are incomplete", () => {
  const mapping = { finalizeReview: ({ structured, unreviewed }) => { const n = normalizeStructuredReview(structured, { unreviewed }); return { ...n.result, summary: n.summary, nextSteps: n.nextSteps }; } };
  const ok = finalizeReviewTurn({ adapter: mapping, structured: approve(), unreviewed: [], reviewed: ["a.js"] });
  assert.equal(ok.exit, 0);
  assert.equal(ok.result.verdict, "approve");
  assert.deepEqual(ok.result.coverage, { reviewed: ["a.js"], unreviewed: [] });
  assert.match(ok.renderedText, /^Verdict: approve\. Looks right\.\n$/);
  const findings = finalizeReviewTurn({ adapter: mapping, structured: valid(), unreviewed: [] });
  assert.equal(findings.exit, 10);
  assert.equal(findings.result.findings.length, 1);
  const partial = finalizeReviewTurn({ adapter: mapping, structured: approve(), unreviewed: ["huge.txt (over the inline cap)"] });
  assert.equal(partial.exit, 10, "a partial review never reads as approval");
  assert.deepEqual(partial.result.coverage.unreviewed, ["huge.txt (over the inline cap)"]);
  const malformed = finalizeReviewTurn({ adapter: mapping, structured: { verdict: "approve" } });
  assert.equal(malformed.exit, 10);
  assert.equal(malformed.result.verdict, "incomplete");
  // the adapter cannot shrink the core's unreviewed list
  const liar = { finalizeReview: () => ({ verdict: "approve", findings: [], coverage: { reviewed: ["all"], unreviewed: [] }, incomplete: null }) };
  const lied = finalizeReviewTurn({ adapter: liar, unreviewed: ["secret.bin (untracked, binary)"] });
  assert.deepEqual(lied.result.coverage.unreviewed, ["secret.bin (untracked, binary)"]);
  assert.equal(lied.exit, 10);
  const throwing = finalizeReviewTurn({ adapter: { finalizeReview: () => { throw new Error("parse failure"); } } });
  assert.equal(throwing.result.verdict, "incomplete");
  assert.equal(throwing.result.incomplete, "the adapter could not read the review: parse failure");
  assert.equal(throwing.exit, 10);
  const shapeless = finalizeReviewTurn({ adapter: { finalizeReview: () => ({ verdict: "approve", findings: [{ severity: "critical" }] }) } });
  assert.equal(shapeless.result.verdict, "incomplete");
  assert.match(shapeless.result.incomplete, /review finding 1 is malformed/);
  const incompleteTurn = finalizeReviewTurn({ adapter: mapping, structured: approve(), incomplete: "print timeout" });
  assert.equal(incompleteTurn.result.verdict, "incomplete");
  assert.equal(incompleteTurn.result.incomplete, "print timeout");
  const own = finalizeReviewTurn({ adapter: { finalizeReview: () => ({ verdict: "changes", findings: [{ severity: "BLOCKER", file: "a", line: 1, title: "t", text: "x" }], coverage: { reviewed: [], unreviewed: [] }, incomplete: null, renderedText: "[P1] native text\n" }) } });
  assert.equal(own.renderedText, "[P1] native text\n", "an adapter's own rendering is kept when its result is valid");
});

test("templates: both exist, use only the known placeholders, interpolate fully, and reject a missing value", () => {
  assert.deepEqual(TEMPLATES, ["review", "adversarial-review"]);
  for (const name of TEMPLATES) {
    const t = loadTemplate(name);
    assert.ok(t.length > 500);
    assert.deepEqual(placeholders(t).sort(), [...PLACEHOLDERS].sort(), `${name} uses exactly the known placeholders`);
    assert.doesNotMatch(t, /Gemini|Grok|Codex|read_file/, `${name} is provider-neutral`);
    const vars = Object.fromEntries(PLACEHOLDERS.map((k) => [k, `<${k}>`]));
    const out = interpolate(t, vars);
    assert.deepEqual(placeholders(out), [], "no placeholder left");
    for (const k of PLACEHOLDERS) assert.ok(out.includes(`<${k}>`));
    const { REVIEW_INPUT, ...missing } = vars;
    assert.throws(() => interpolate(t, missing), /unresolved template placeholder \{\{REVIEW_INPUT\}\}/);
    assert.throws(() => interpolate(t, { ...vars, USER_FOCUS: null }), /\{\{USER_FOCUS\}\}/);
  }
  assert.match(loadTemplate("adversarial-review"), /break confidence in the change/);
  assert.throws(() => loadTemplate("stop-review-gate"), /unknown review template/);
  assert.equal(interpolate("plain text", {}), "plain text");
  assert.equal(interpolate("{{A}} and {{A}}", { A: "x" }), "x and x");
  assert.equal(interpolate("{{A}}", { A: 0 }), "0");
  assert.equal(interpolate("{{A}}", { A: "{{B}}" }), "{{B}}", "inserted text is never scanned again");
});

test("renderReviewPrompt fills target, focus, guidance, coverage note and the diff", () => {
  const collection = { label: "working tree (staged, unstaged and untracked)", diff: "diff --git a/x b/x\n+{{NOT_A_PLACEHOLDER}}\n\n", omitted: [], reviewed: ["x"] };
  const p = renderReviewPrompt({ template: "review", focus: "  loops  ", collection });
  assert.match(p, /Target: working tree \(staged, unstaged and untracked\)/);
  assert.match(p, /User focus: loops\n/);
  assert.match(p, /Use the repository context below as primary evidence\./);
  assert.match(p, /<coverage>\nEvery changed file is included below\.\n<\/coverage>/);
  assert.match(p, /<repository_context>\ndiff --git a\/x b\/x\n\+\{\{NOT_A_PLACEHOLDER\}\}\n<\/repository_context>/);
  const partial = renderReviewPrompt({ template: "adversarial-review", focus: "", targetLabel: "commit abc", collection: { ...collection, omitted: ["big.bin (over the inline cap)"] } });
  assert.match(partial, /Target: commit abc/);
  assert.match(partial, /User focus: none given/);
  assert.match(partial, /These changes are not shown and are outside this review; do not approve them:\n- big.bin \(over the inline cap\)/);
  assert.match(partial, /1 changed file\(s\) are not included below/);
  assert.match(partial, /adversarial software review/);
});

test("contract.md: provider-neutral outer tag, the discussion protocol, no placeholder", () => {
  const contract = readFileSync(join(PLUGIN_ROOT, "contract.md"), "utf8");
  assert.match(contract, /^<council_contract version="1">\n/);
  assert.match(contract, /<\/council_contract>\n$/);
  assert.match(contract, /F1, F2 findings, BLOCKER\/MAJOR\/MINOR, file:line/);
  assert.match(contract, /AGREE, CHANGE: <text>, REJECT: <evidence>/);
  assert.match(contract, /`Open questions:`/);
  assert.doesNotMatch(contract, /codex_companion|\{\{/);
  assert.ok(existsSync(join(PLUGIN_ROOT, "prompts", "review.md")));
  assert.ok(existsSync(join(PLUGIN_ROOT, "prompts", "adversarial-review.md")));
});
