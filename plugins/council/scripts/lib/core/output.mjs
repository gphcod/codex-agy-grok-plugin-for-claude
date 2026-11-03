// Ported from grok-build-plugin-cc 1.1.5 lib/output.mjs and lib/answer.mjs (commit 9c66028), with
// the start line, footer and --json object of PLAN.md A3.4 and the 24 KiB answer cap.
import fs from "node:fs";
import { serviceRetry, serviceRetryHint } from "./gemini-service.mjs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export const ANSWER_CAP = 24 * 1024;
const LABELS = { ok: "ok", attention: "needs attention", failed: "failed", cancelled: "cancelled" };
/** A3.2: verbs that print `round N/M`; `review` never does. */
const THREADED = new Set(["ask", "reply", "task"]);

/** UTF-8 prefix without an incomplete code point or removal of a genuine replacement character. */
export function utf8Prefix(text, cap) {
  const bytes = Buffer.from(String(text), "utf8");
  if (bytes.length <= cap) return String(text);
  let end = cap;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}
/**
 * One line of at most `max` bytes, safe inside a footer: provider text in `error:` or `attention:` can
 * carry no control character or escape sequence introducer, and no ` · ` that would fake a footer token.
 */
const freeDot = (text) => text.replace(/(^| )·(?= |$)/g, "$1-");
// Clipping can leave a new trailing ` ·`, so the check runs again on the clipped value.
export const oneLine = (text, max = 200) => freeDot(utf8Prefix(freeDot(String(text).replace(/[\x00-\x08\x0e-\x1f\x7f-\x9f]/g, "").replace(/\s+/g, " ").trim()), max));
/** X1: the footer's `attention: <reason>`, one line, at most this many bytes, cause first. */
export const ATTENTION_MAX = 200;
export const QUESTIONS_REASON = "open questions in the answer";
/** `denied <action>[ (+N more)]`: the action is clipped so the count survives. */
export function deniedReason(action, count = 1) {
  const more = count > 1 ? ` (+${count - 1} more)` : "";
  return `denied ${oneLine(action || "an action", ATTENTION_MAX - Buffer.byteLength(`denied ${more}`))}${more}`;
}
/**
 * Why a turn needs attention (exit 10), or null. Reviews: a denied action, which can be what left a
 * review incomplete, else an incomplete or malformed review (its findings already show as findings).
 * Other verbs: a denied action, else open questions in the answer.
 */
export function attentionReason({ isReview, review = null, denied = null, deniedAction = null, deniedCount = 0, questions = false }) {
  const deny = denied ? deniedReason(deniedAction ?? denied, Math.max(1, deniedCount)) : null;
  if (isReview) return deny ?? (review?.incomplete ? oneLine(review.incomplete, ATTENTION_MAX) : null);
  return deny ?? (questions ? QUESTIONS_REASON : null);
}
/**
 * X3: the footer clips `error:` at 200 B, so a message that can exceed it says what to do first and
 * why after. Each is listed with its action in tests/core-messages.test.mjs.
 */
export const MESSAGES = {
  threadBusy: (thread, job) => `thread ${thread} is busy as job ${job}; wait or cancel ${job}`,
  threadBusyUnidentified: (thread) => `quiesce this state root before manual recovery: thread ${thread} is busy with an unidentified claim`,
  threadLocked: (thread, job) => `continue with a new ask: thread ${thread} is busy as job ${job}, whose output an unidentified process kept open, so it stays locked`,
  threadCleanup: (thread, job) => `run cancel ${job}: thread ${thread} requires cleanup of that job`,
  cleanupPending: (provider, why) => `cleanup pending: ${provider} or a descendant may still be running; ${why || "execution ended"}`,
  requestGone: (name) => `a new request id is safe: the first call of ${name} ended before it chose a provider; nothing ran`,
  requestUnchosen: (name) => `retry with the same request id to keep waiting: the first call of ${name} has not chosen its provider yet`,
  requestFreed: (name) => `retry with the same id to run it: the first call of ${name} failed before the provider started and freed the id`,
  requestNeverRan: (name, job) => `a new request id is safe: ${name} names job ${job}, whose call ended before the provider started; nothing ran`,
  requestMissing: (name, job) => `use a new request id: ${name} names job ${job}, whose records were deleted or cannot be read; nothing was started again, and whether the provider ran for it is unknown`,
  jobUnreadable: (job, why) => `retry: job ${job} cannot be read right now (${why}), so nothing was selected or started`,
};
export const pendingCleanup = (job) => Boolean((job.cleanupPending && !job.stopped) || job.claimHeld);

export function elapsed(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}h${pad(m)}m` : m ? `${m}m${pad(s)}s` : `${s}s`;
}
export const elapsedOf = (job) => (job.endedAt ? Date.parse(job.endedAt) : Date.now()) - (Date.parse(job.spawnedAt) || 0);
export function capAnswer(text) {
  return { text: utf8Prefix(text, ANSWER_CAP), clipped: Buffer.byteLength(text, "utf8") > ANSWER_CAP };
}
export const answerPath = (job) => path.join(job.dir, "answer.md");

/** A3.4 start line (stderr, suppressed under --json). */
export const startLine = (job) => `[council] provider=${job.provider} job=${job.id}${job.target ? ` target=${oneLine(job.target)}` : ""}`;

/** `<model>/<effort>[<=requested]`: the clamp token of A3.3. */
export function effortToken(job) {
  const effort = oneLine(job.effort ?? "?");
  const requested = job.requestedEffort && job.requestedEffort !== job.effort ? `<=${oneLine(job.requestedEffort)}` : "";
  return `${oneLine(job.model ?? "?")}/${effort}${requested}`;
}

/** The recovery hint that closes a footer, or null. From codex-plugin-cc lib/output.mjs:49-54. */
export function recoveryHint(job) {
  if (job.unattributedPipes && !job.stopped) {
    return `${job.answerComplete ? "answer complete; " : ""}thread locked: an unidentified process kept the provider's output open; next: ${
      job.identifiedStopped ? `a new ask; job ${job.id}` : `cancel ${job.id} to stop what it can identify, then a new ask`}`;
  }
  if (pendingCleanup(job)) return `cleanup pending; next: cancel ${job.id}; do not resume`;
  // The provider finished without confirming its thread (grok `end` without a session id): not resumable.
  const retry = serviceRetryHint(job, pendingCleanup(job));
  if (job.unconfirmed && job.verb !== "review") return retry ? `thread not confirmed; ${retry}` : oneLine(job.unconfirmed);
  if (retry) return retry;
  if (job.outcome !== "ok" && job.threadId && job.admitted !== false && job.verb !== "review") return `next: reply ${job.id}`;
  return null;
}

/**
 * A3.4 footer, one line on stdout:
 * council <provider> <ok|needs attention|failed|cancelled> · job <16 chars> · <model>/<effort>[<=requested] · <duration>
 * [ · round N/M][ · edited N][ · unreviewed N][ · model unverified][ · full: <file>][ · error: <msg> | · attention: <reason>][ · <recovery hint>]
 * `attention:` only on a turn that needs attention for a reason the footer would not otherwise show
 * (never with `error:`, which only a failed or cancelled turn carries).
 */
export function footer(job, clipped) {
  const parts = [`council ${job.provider} ${LABELS[job.outcome] ?? job.outcome}`, `job ${job.id}`, effortToken(job), elapsed(elapsedOf(job))];
  if (THREADED.has(job.verb) && job.round != null && job.rounds != null) parts.push(`round ${job.round}/${job.rounds}`);
  if (job.verb === "task") parts.push(`edited ${(job.edited ?? []).length}`);
  if (job.verb === "review" && (job.unreviewed ?? []).length) parts.push(`unreviewed ${job.unreviewed.length}`);
  if (job.modelVerified === false) parts.push("model unverified");
  if (clipped || job.answerClipped) parts.push(`full: ${answerPath(job)}`);
  if (job.partialFile) parts.push(`partial draft: ${oneLine(job.partialFile, 2000)}`);
  if (job.partialError) parts.push(`draft not saved: ${oneLine(job.partialError)}`);
  if (job.error) parts.push(`error: ${oneLine(job.error)}`);
  else if (job.attention) parts.push(`attention: ${oneLine(job.attention, ATTENTION_MAX)}`);
  const hint = recoveryHint(job);
  if (hint) parts.push(hint);
  return parts.join(" · ");
}

export function renderResult(job, answer) {
  const { text, clipped } = capAnswer(answer);
  const body = text.trimEnd();
  return `${body ? `${body}\n` : ""}${footer(job, clipped)}\n`;
}

/** A3.4 --json object. */
export function resultJson(job, answer) {
  const { text, clipped } = capAnswer(answer);
  const review = job.review ?? null;
  return {
    provider: job.provider, job: job.id, thread: job.threadId ?? null, session: job.session ?? null,
    model: job.model ?? null, modelVerified: job.modelVerified !== false, effort: job.effort ?? null, requestedEffort: job.requestedEffort ?? job.effort ?? null,
    tier: job.tier ?? null, round: THREADED.has(job.verb) ? job.round ?? null : null, rounds: THREADED.has(job.verb) ? job.rounds ?? null : null,
    verdict: review?.verdict ?? job.verdict ?? null, findings: review?.findings ?? [], coverage: review?.coverage ?? { reviewed: [], unreviewed: (job.unreviewed ?? []).map((u) => oneLine(u)) },
    edited: (job.edited ?? []).slice(0, 100).map((p) => oneLine(p)), failedCommands: (job.failedCommands ?? []).slice(0, 20).map((f) => (typeof f === "string" ? oneLine(f, 120) : { cmd: oneLine(f.cmd ?? "", 120), exit: f.exit ?? null })),
    costUsd: job.costUsd ?? null, usage: job.usage ?? null, exit: job.code, answerFile: answerPath(job),
    retry: serviceRetry(job, pendingCleanup(job)),
    ...(job.partial ? { partial: true, partialFile: job.partialFile ?? null, ...(job.partialError ? { partialError: oneLine(job.partialError, 2000) } : {}) } : {}),
    verb: job.verb, status: job.outcome, elapsedMs: elapsedOf(job), error: job.error ? oneLine(job.error, 2000) : null,
    attention: !job.error && job.attention ? oneLine(job.attention, ATTENTION_MAX) : null,
    cleanupPending: pendingCleanup(job), answer: text, clipped: clipped || Boolean(job.answerClipped),
  };
}

/** Scan the complete answer without retaining it in memory. Its file remains authoritative. */
export function readAnswer(file) {
  const fd = fs.openSync(file, "r");
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.alloc(64 * 1024);
  let preview = "", line = "", lineBytes = 0, total = 0;
  let nonempty = false, active = false, body = "", questions = false;
  const label = /^[\s>*_#-]*open questions\b[\s*_]*:/i;
  const next = /^[\s>*_#-]*(next|verification|outcome|summary|changes)\b[\s*_]*:/i;
  const finishSection = () => { questions ||= active && !["", "none", "na", "no"].includes(body); active = false; body = ""; };
  const acceptLine = (text) => {
    if (label.test(text)) { finishSection(); active = true; text = text.replace(label, ""); }
    else if (active && next.test(text)) finishSection();
    if (active) body = (body + text.replace(/[\s*_.`\-/]/g, "").toLowerCase()).slice(0, 32);
  };
  const accept = (text) => {
    nonempty ||= Boolean(text.trim());
    if (Buffer.byteLength(preview) <= ANSWER_CAP) preview += text.slice(0, ANSWER_CAP + 4);
    let at = 0;
    for (;;) {
      const end = text.indexOf("\n", at);
      const part = text.slice(at, end < 0 ? text.length : end);
      lineBytes += Buffer.byteLength(part);
      if (lineBytes > 1024 * 1024) throw new Error("answer line exceeds 1 MiB; full answer retained");
      line += part;
      if (end < 0) break;
      acceptLine(line); line = ""; lineBytes = 0; at = end + 1;
    }
  };
  try {
    for (;;) {
      const size = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!size) break;
      total += size; accept(decoder.write(buffer.subarray(0, size)));
    }
    accept(decoder.end()); acceptLine(line); finishSection();
    return { answer: capAnswer(preview).text, answerClipped: total > ANSWER_CAP, nonempty, questions };
  } finally { fs.closeSync(fd); }
}
