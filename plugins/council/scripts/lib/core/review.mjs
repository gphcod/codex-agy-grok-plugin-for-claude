// Review validation, normalization and prompt rendering. Ported from grok-build-plugin-cc 1.1.5
// lib/review.mjs (reviewProblem, renderReview) and gemini-plugin-cc 2.1.0 lib/prompts.mjs
// (loadPromptTemplate, interpolateTemplate). Changes (PLAN.md A5.2): the native output is validated
// before mapping; severities map critical/high → BLOCKER, medium → MAJOR, low → MINOR; a native
// needs-attention verdict is `changes`; coverage.unreviewed comes from the core's collection, never
// from the model; malformed or missing output is `incomplete` and never an approval; interpolate()
// refuses a template placeholder it has no value for.
import fs from "node:fs";
import path from "node:path";
import { PLUGIN_ROOT } from "./catalog.mjs";
import { buildCollectionGuidance } from "./git.mjs";

export const SEVERITIES = ["critical", "high", "medium", "low"];
export const SEVERITY_TAG = { critical: "BLOCKER", high: "BLOCKER", medium: "MAJOR", low: "MINOR" };
export const TAGS = ["BLOCKER", "MAJOR", "MINOR"];
export const VERDICTS = ["approve", "changes", "incomplete"];
export const TEMPLATES = ["review", "adversarial-review"];
/** Every placeholder a review template may use; interpolate() needs a value for each one it contains. */
export const PLACEHOLDERS = ["TARGET_LABEL", "USER_FOCUS", "REVIEW_COLLECTION_GUIDANCE", "COVERAGE_NOTE", "REVIEW_INPUT"];

const nonempty = (v) => typeof v === "string" && v.trim() !== "";
const position = (v) => Number.isInteger(v) && v >= 1;

/** Validates structured output against the shared review schema; returns the first problem or null. */
export function reviewProblem(out) {
  if (!out || typeof out !== "object" || Array.isArray(out)) return "missing structured review output";
  if (!["approve", "needs-attention"].includes(out.verdict)) return "review verdict must be approve or needs-attention";
  if (!nonempty(out.summary)) return "review summary is empty";
  if (!Array.isArray(out.findings)) return "review findings must be an array";
  for (const [i, f] of out.findings.entries()) {
    const at = `review finding ${i + 1}`;
    if (!f || typeof f !== "object") return `${at} is not an object`;
    if (!SEVERITIES.includes(f.severity)) return `${at} has an unknown severity`;
    if (![f.title, f.body, f.file].every(nonempty)) return `${at} needs title, body and file`;
    if (!position(f.line_start) || !position(f.line_end) || f.line_end < f.line_start) return `${at} has an invalid line range`;
    if (typeof f.confidence !== "number" || f.confidence < 0 || f.confidence > 1) return `${at} confidence must be 0 to 1`;
    if (typeof f.recommendation !== "string") return `${at} needs a recommendation`;
  }
  if (!Array.isArray(out.next_steps) || !out.next_steps.every(nonempty)) return "review next_steps must be non-empty strings";
  return null;
}

const coverageOf = (reviewed, unreviewed) => ({ reviewed: [...(reviewed ?? [])], unreviewed: [...(unreviewed ?? [])] });
export function incompleteResult(reason, { reviewed = [], unreviewed = [] } = {}) {
  return { verdict: "incomplete", findings: [], coverage: coverageOf(reviewed, unreviewed), incomplete: reason };
}

/**
 * Schema-shaped output (gemini, grok) → the A5.2 result. Validation comes first: anything malformed
 * is `incomplete`. An approval that carries findings is `changes`.
 */
export function normalizeStructuredReview(structured, { reviewed = [], unreviewed = [] } = {}) {
  const problem = reviewProblem(structured);
  if (problem) return { result: incompleteResult(problem, { reviewed, unreviewed }), summary: null, nextSteps: [] };
  const findings = structured.findings.map((f) => ({
    severity: SEVERITY_TAG[f.severity], file: f.file, line: f.line_start, ...(f.line_end > f.line_start ? { lineEnd: f.line_end } : {}),
    title: f.title.trim(), text: f.body.trim(), ...(f.recommendation.trim() ? { recommendation: f.recommendation.trim() } : {}), confidence: f.confidence,
  }));
  const verdict = structured.verdict === "needs-attention" || findings.length ? "changes" : "approve";
  return { result: { verdict, findings, coverage: coverageOf(reviewed, unreviewed), incomplete: null }, summary: structured.summary.trim(), nextSteps: structured.next_steps.map((s) => s.trim()) };
}

/** Checks the shape an adapter's finalizeReview returned; returns the first problem or null. */
export function resultProblem(result) {
  if (!result || typeof result !== "object") return "the adapter returned no review result";
  if (!VERDICTS.includes(result.verdict)) return `unknown review verdict ${JSON.stringify(result.verdict)}`;
  if (!Array.isArray(result.findings)) return "review findings must be an array";
  for (const [i, f] of result.findings.entries()) {
    if (!f || !TAGS.includes(f.severity) || !nonempty(f.file) || !nonempty(f.title) || typeof f.text !== "string") return `review finding ${i + 1} is malformed`;
    if (f.line !== null && f.line !== undefined && !position(f.line)) return `review finding ${i + 1} has an invalid line`;
  }
  if (result.verdict === "incomplete" && !nonempty(result.incomplete)) return "an incomplete review needs its reason";
  return null;
}

/** A5.2 exit rule: 10 when findings exist, coverage is incomplete, the output is incomplete, or the verdict is not a clean approval. */
export function reviewExit(result) {
  if (result.verdict !== "approve" || result.findings.length || result.coverage.unreviewed.length || result.incomplete) return 10;
  return 0;
}

/** Text Claude reads: verdict line, F-numbered findings tagged BLOCKER/MAJOR/MINOR with file:line, coverage. */
export function renderReview(result, { summary = null, nextSteps = [] } = {}) {
  const head = result.verdict === "approve" ? "approve" : result.verdict === "changes" ? "changes requested" : `incomplete (${result.incomplete})`;
  const lines = [`Verdict: ${head}.${summary ? ` ${summary}` : ""}`];
  result.findings.forEach((f, i) => {
    const where = f.line ? `${f.file}:${f.line}${f.lineEnd ? `-${f.lineEnd}` : ""}` : f.file;
    lines.push("", `F${i + 1} ${f.severity} ${where}: ${f.title}`);
    if (f.text) lines.push(f.text);
    if (f.recommendation) lines.push(`Fix: ${f.recommendation}`);
  });
  if (nextSteps.length) lines.push("", "Next steps:", ...nextSteps.map((s) => `- ${s}`));
  if (result.coverage.unreviewed.length) lines.push("", "Not reviewed (outside this review; never approved):", ...result.coverage.unreviewed.map((u) => `- ${u}`));
  return `${lines.join("\n")}\n`;
}

/**
 * The review end of a turn: the adapter's finalizeReview maps its native output; the core overrides
 * coverage.unreviewed with its own omissions (and coverage.reviewed with its collected list when it has one), validates the result, and decides the exit. An adapter
 * failure, a malformed result or an incomplete turn is `incomplete` (exit 10), never an approval.
 * → {result, exit, renderedText}
 */
export function finalizeReviewTurn({ adapter, answerText = "", answerFile = null, structured = null, unreviewed = [], reviewed = [], incomplete = null }) {
  let mapped, problem = null;
  // `answerText` is the whole stored answer (never the 24 KiB preview); `answerFile` is where it lives.
  try { mapped = adapter.finalizeReview({ answerText, answerFile, structured, unreviewed: [...unreviewed] }); }
  catch (error) { problem = `the adapter could not read the review: ${error.message}`; }
  let result = mapped && { verdict: mapped.verdict, findings: mapped.findings, coverage: coverageOf(reviewed.length ? reviewed : mapped.coverage?.reviewed ?? [], unreviewed), incomplete: mapped.incomplete ?? null };
  problem ??= resultProblem(result);
  if (problem) result = incompleteResult(problem, { reviewed, unreviewed });
  if (incomplete && result.verdict !== "incomplete") result = { ...result, verdict: "incomplete", incomplete: typeof incomplete === "string" ? incomplete : "the turn ended incomplete" };
  const renderedText = problem || typeof mapped?.renderedText !== "string" ? renderReview(result, { summary: mapped?.summary ?? null, nextSteps: mapped?.nextSteps ?? [] }) : mapped.renderedText;
  return { result, exit: reviewExit(result), renderedText };
}

// --- templates (gemini-plugin-cc lib/prompts.mjs) -------------------------------------------------------

export function loadTemplate(name, pluginRoot = PLUGIN_ROOT) {
  if (!TEMPLATES.includes(name)) throw new Error(`unknown review template ${name}`);
  return fs.readFileSync(path.join(pluginRoot, "prompts", `${name}.md`), "utf8");
}
/** Placeholders a template contains, in order of first appearance. */
export function placeholders(template) {
  return [...new Set([...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]))];
}
/**
 * Fills {{NAME}} placeholders in one pass (inserted values are never scanned again, so a diff that
 * contains `{{X}}` is safe). A placeholder without a value is an error, never an empty string.
 */
export function interpolate(template, variables) {
  const missing = placeholders(template).filter((k) => !Object.hasOwn(variables, k) || variables[k] === undefined || variables[k] === null);
  if (missing.length) throw new Error(`unresolved template placeholder ${missing.map((k) => `{{${k}}}`).join(", ")}`);
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => String(variables[key]));
}

/** The collected-diff review prompt (gemini, grok): template, target, focus, guidance, coverage note and diff. */
export function renderReviewPrompt({ template = "review", targetLabel, focus = "", collection, pluginRoot = PLUGIN_ROOT }) {
  const omitted = collection.omitted ?? [];
  return interpolate(loadTemplate(template, pluginRoot), {
    TARGET_LABEL: targetLabel ?? collection.label,
    USER_FOCUS: focus.trim() || "none given",
    REVIEW_COLLECTION_GUIDANCE: buildCollectionGuidance(collection),
    COVERAGE_NOTE: omitted.length ? `These changes are not shown and are outside this review; do not approve them:\n${omitted.map((o) => `- ${o}`).join("\n")}` : "Every changed file is included below.",
    REVIEW_INPUT: collection.diff.trimEnd(),
  });
}
