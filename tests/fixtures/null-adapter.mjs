// Null adapter (S2.1): the A5 interface over tests/fixtures/fake-child.mjs. Profiles come from the
// environment so one core test suite covers every transport shape of the three real adapters:
//   COUNCIL_NULL_ID     preassigned (Grok-like, id chosen before spawn) | discovered (Codex/Gemini-like)
//   COUNCIL_NULL_INPUT  stdin | prompt-file
//   COUNCIL_NULL_OUTPUT stream | answer-file
//   COUNCIL_NULL_TRUST  1 → trustsCleanExit returns true (default false: post-exit scan after every exit)
// Every switch is read from the environment the core passes (A5, S2.8), never from process.env.
// The entry loads this adapter only when COUNCIL_TEST_NULL_ADAPTER=1.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeStructuredReview, renderReview } from "../../plugins/council/scripts/lib/core/review.mjs";
import { UsageError } from "../../plugins/council/scripts/lib/core/args.mjs";
import { hasFlagOperand } from "../../plugins/council/scripts/lib/core/execution.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const FAKE_CHILD = join(here, "fake-child.mjs");
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function profile(env = {}) {
  return {
    id: env.COUNCIL_NULL_ID === "discovered" ? "discovered" : "preassigned",
    input: env.COUNCIL_NULL_INPUT === "prompt-file" ? "prompt-file" : "stdin",
    output: env.COUNCIL_NULL_OUTPUT === "answer-file" ? "answer-file" : "stream",
    trust: env.COUNCIL_NULL_TRUST === "1",
  };
}

const adapter = {
  id: "null",
  binEnv: "COUNCIL_NULL_BIN",
  resolveLauncher(env = {}) {
    const entry = env.COUNCIL_NULL_BIN || FAKE_CHILD;
    if (!existsSync(entry)) return null; // like a real adapter whose binary is missing
    // The trust decision is a property of the launcher, as it is for a qualified real launcher kind.
    return { command: process.execPath, args: [entry], path: entry, kind: "node-script", trusted: profile(env).trust };
  },
  trustsCleanExit(launcher) { return launcher?.trusted === true; },
  ownsProcess(row, job, platform) { return hasFlagOperand(row, "--job", job.id, job, platform, ["fake-child.mjs"]); },
  maxLineBytes: 64 * 1024,
  probe(launcher, env = {}) {
    // COUNCIL_NULL_PROBE_NOTE: the provider-specific setup lines a real probe may add (notes, warnings).
    const extra = env.COUNCIL_NULL_PROBE_NOTE ? { notes: [env.COUNCIL_NULL_PROBE_NOTE, ""], warnings: ["null probe warning", 7] } : {};
    // Test seam: report which guard variables the probe received (A5.1: every provider child gets all four).
    if (env.COUNCIL_NULL_PROBE_GUARDS) extra.notes = [`guards ${["COUNCIL_DEPTH", "CODEX_COMPANION_DEPTH", "GROK_BUILD_DEPTH", "CLAUDE_PLUGIN_CODEX_DEPTH"].filter((g) => env[g] === "1").join(",")}`];
    return { version: "null 0.0.0", loggedIn: true, models: [{ id: "null-model", efforts: EFFORTS }, { id: "null-fast", efforts: ["low", "medium"] }], ...extra };
  },
  catalog: { models: { "null-model": EFFORTS, "null-fast": ["low", "medium"] }, aliases: { fast: "null-fast" }, sharedEnum: EFFORTS, passThrough: [] },
  tiers: { consult: { model: "null-model", effort: "high" }, exec: { model: "null-fast", effort: "medium" }, deep: { model: "null-model", effort: "xhigh" } },
  /** Test seam (not A5): COUNCIL_NULL_CONSULT=<model>/<effort> changes the consult tier between a call and its replay. */
  tiersFor(env = {}) {
    const [model, effort] = (env.COUNCIL_NULL_CONSULT ?? "null-model/high").split("/");
    return { ...this.tiers, consult: { model, effort } };
  },
  /** Optional A5 hook: an adapter refuses a flag it has no tested mapping for (exit 2 before any job). */
  checkRequest(request, env = {}) {
    if (request.web && env.COUNCIL_NULL_NO_WEB === "1") throw new UsageError("--web has no tested mapping for null");
    if (request.adversarial && env.COUNCIL_NULL_NO_ADVERSARIAL === "1") throw new UsageError("--adversarial has no tested mapping for null");
  },

  /** A5 buildTurn: request carries env and launcher; → {args, env, stdin | promptFile, answerFile, readOnly, agent?, contractCarrier, threadId?}. */
  buildTurn(request) {
    const p = profile(request.env ?? {});
    const dir = request.jobDir;
    const resumed = request.thread?.threadId ?? null;
    const threadId = p.id === "preassigned" ? (resumed ?? randomUUID()) : resumed;
    const args = ["--job", request.jobId, "--model", request.model, "--effort", request.effort];
    if (threadId && (p.id === "preassigned" || resumed)) args.push("--thread", threadId);
    if (request.readOnly === false) args.push("--write");
    if (request.verb === "review") args.push("--review");
    if (request.web) args.push("--web");
    const text = request.verb === "review" ? request.reviewPrompt : `${request.contract}\n\n${request.text}`;
    const turn = { args, env: {}, answerFile: null, readOnly: request.readOnly !== false, contractCarrier: "prompt-prefix", threadId: p.id === "preassigned" ? threadId : null };
    if (p.input === "prompt-file") { turn.promptFile = join(dir, "prompt.md"); turn.promptText = text; args.push("--prompt-file", turn.promptFile); }
    else turn.stdin = text;
    if (p.output === "answer-file") { turn.answerFile = join(dir, "answer.md"); args.push("--answer-file", turn.answerFile); }
    return turn;
  },

  /** A5 parseEvent over the fake child's protocol. */
  parseEvent(line, state) {
    let ev;
    try { ev = JSON.parse(line); } catch { return null; }
    if (typeof ev?.type !== "string") return null;
    switch (ev.type) {
      case "started": return typeof ev.thread === "string" ? { threadId: ev.thread } : null;
      case "text": return typeof ev.data === "string" ? { textDelta: ev.data } : null;
      case "progress": return { toolStep: ev.step ?? "progress" };
      case "done": return { completed: true, ...(ev.structured !== undefined ? { structured: ev.structured } : {}), ...(ev.usage ? { usage: ev.usage } : {}) };
      case "error": return { fatal: ev.message ?? "fake child error" };
      case "denied": return { denied: ev.message ?? "denied" };
      default: return null;
    }
  },

  /** Collected-diff route: the core collects and renders the template; the child answers in the schema. */
  reviewPlan(gitInfo, request) {
    return { native: false, template: request.adversarial ? "adversarial-review" : "review", schemaCarrier: "none" };
  },

  /** The collected-diff mapping the gemini and grok adapters share: schema output through the core normalizer. */
  finalizeReview({ structured, unreviewed }) {
    const { result, summary, nextSteps } = normalizeStructuredReview(structured, { unreviewed });
    return { ...result, summary, nextSteps, renderedText: renderReview(result, { summary, nextSteps }) };
  },
};

export default adapter;
