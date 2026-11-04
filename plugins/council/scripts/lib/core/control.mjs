// Control and owner-death recovery, separated from turn execution. Public lifecycle exports stay compatible.
import fs from "node:fs";
import path from "node:path";
import { claimHeld, releaseClaims } from "./claims.mjs";
import {
  EXPIRED, candidates, cleanupNeeded, findJob, lastEvent, loadJob, loadRequest, loadTombstone,
  markDefaultAgent, markStopped, neverPrepared, requestReserved, resultRecord, stateOf,
} from "./jobs.mjs";
import { companionState, executionController, recordRecoveryEvidence } from "./execution.mjs";
import { MESSAGES, elapsed, elapsedOf, readAnswer, renderResult, resultJson, startLine } from "./output.mjs";
import { UsageError, seconds } from "./args.mjs";
import { DEADLINE_S } from "./lifecycle-config.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const label = (job) => job.done && job.outcome !== "cancelled" ? "finished" : "cancelled";
const UNSURE_MS = 1000;
export function jobView(home, job) {
  return { ...job, cleanupPending: cleanupNeeded(job), claimHeld: claimHeld(home, job) };
}

/** Explicit recovery. No metadata writes, no age-based reclamation, and no kill of a companion. */
export async function cancelManaged(ctx, job, { timeoutMs = 30000, control = executionController(), io = fs } = {}) {
  const view = () => jobView(ctx.home, loadJob(ctx.home, job.id) ?? job);
  if (job.done && !cleanupNeeded(job) && !claimHeld(ctx.home, job)) return { status: label(job), code: 0, job };
  io.writeFileSync(path.join(job.dir, "cancel"), "");
  const end = Date.now() + timeoutMs;
  let unsureSince = 0;
  for (;;) {
    job = loadJob(ctx.home, job.id);
    if (!job) return { status: "unknown", code: 1, error: "job record cannot be read" };
    // A concurrent recovery that already confirmed the stop is seen here too.
    if ((job.done || job.stopped) && !cleanupNeeded(job) && !claimHeld(ctx.home, job)) return { status: label(job), code: 0, job: view() };
    // Each query gets its full budget: one cut short by the cancel deadline would read as unknown identity.
    let snapshot, unsure = null;
    try { snapshot = control.snapshot(); }
    catch (e) { snapshot = { state: "unknown", rows: [], error: `process query failed: ${e.message}` }; }
    // The query can outlast the owner (most of a second on Windows): a job it finished meanwhile is not a recovery.
    job = loadJob(ctx.home, job.id) ?? job;
    if ((job.done || job.stopped) && !cleanupNeeded(job) && !claimHeld(ctx.home, job)) return { status: label(job), code: 0, job: view() };
    const owner = companionState(job, snapshot);
    if (owner === "gone") {
      let found;
      try { found = control.inspect(job, snapshot); }
      catch (e) { return { status: "unknown", code: 1, job: view(), error: e.message }; }
      if (found.state === "unknown") unsure = `${found.error ? `${found.error}; ` : ""}execution ownership/cleanup cannot be confirmed; claim and cancellation request retained`;
      else if (found.state === "gone") {
        // Identified execution is stopped, but an unidentified holder of the turn's pipes may not be.
        if (job.unattributedPipes) return { status: "unknown", code: 1, job: view(), error: "execution ownership/cleanup cannot be confirmed; claim and cancellation request retained" };
        // A lost turn may have moved its session to Grok's default agent and never saved that. Set before the
        // job stops blocking its thread, so every later selection reads it. A spawn that may not have run counts:
        // that recipe is valid on a session that never used the agent; explore on one that did is proven only for Grok 1.0.70.
        if (job.threadId && job.spawnAttempted && job.turn?.agent === "default") {
          try { markDefaultAgent(ctx.home, job.provider, job.threadId); }
          catch (e) { return { status: "unknown", code: 1, job: view(), error: `cannot save the thread's agent: ${e.message}; claim and cancellation request retained` }; }
        }
        markStopped(job);
        releaseClaims(ctx.home, job);
        const current = view();
        return { status: current.claimHeld ? "unknown" : label(job), code: current.claimHeld ? 1 : 0, job: current, ...(job.spawnAttempted && !current.claimHeld ? { warning: MESSAGES.unrecorded } : {}) };
      } else {
        try { recordRecoveryEvidence(job, found.rows); }
        catch (e) { return { status: "unknown", code: 1, job: view(), error: `cannot save cleanup evidence: ${e.message}` }; }
        // Identity is verified per row (creation timestamp and command line) before any signal.
        for (const row of found.rows) {
          if (Date.now() >= end) break;
          try { control.stop(row); } catch { /* Must be confirmed by a later snapshot. */ }
        }
      }
    } else if (owner === "unknown") {
      // A failed query says so: it is not evidence about the companion either way.
      unsure = `${snapshot.error ?? "original companion identity cannot be confirmed"}; no claim released`;
    }
    // owner === "live": only the marker is written; the owner stops its child and finalizes.
    // Uncertainty is reported only once it outlasts a short look-again window; claims stay held meanwhile.
    if (!unsure) unsureSince = 0;
    else if (Date.now() - (unsureSince ||= Date.now()) >= UNSURE_MS || Date.now() >= end) return { status: "unknown", code: 1, job: view(), error: unsure };
    if (Date.now() >= end) return { status: "not-stopped", code: 1, job: view(), error: "shutdown not confirmed; claim and cancellation request retained; run cancel again" };
    await sleep(100);
  }
}

// --- entry orchestration ported from grok-build-plugin-cc grok.mjs -------------------------------------

/** Prints a finished (or recovered) job's result; the stored answer file stays authoritative. */
export function finishedResult(ctx, o, job, out) {
  let record = resultRecord(job), answer = "";
  try { const parsed = readAnswer(path.join(job.dir, "answer.md")); answer = parsed.answer; record = { ...record, answerClipped: parsed.answerClipped }; }
  catch (e) {
    if (record.code === 0 || record.code === 10) record = { ...record, code: 1, outcome: "failed", error: `stored answer unreadable: ${e.message}` };
  }
  record = jobView(ctx.home, record);
  out(o.json ? `${JSON.stringify(resultJson(record, answer))}\n` : renderResult(record, answer));
  return record.code;
}

/** `wait [job] [--timeout <s>]`: list this session's jobs in this cwd, or await one; 20 while it runs. */
export async function waitFor(ctx, o, refs, out, { provider = null, sleepMs = 100 } = {}) {
  if (refs.length > 1) throw new UsageError("wait accepts one job or thread");
  const [ref] = refs;
  const timeout = seconds(o.timeout, 90, "timeout") * 1000;
  if (!ref) {
    const rows = candidates(ctx.home, ctx).slice(0, 10).map((j) => ({ job: j.id, provider: j.provider,
      state: stateOf(j) === "done" && j.outcome === "attention" ? "needs attention" : stateOf(j), thread: j.threadId ?? null,
      elapsedMs: elapsedOf(j), lastEvent: lastEvent(j), cleanupPending: cleanupNeeded(j) && stateOf(j) !== "running" || claimHeld(ctx.home, j) && j.done }));
    out(o.json ? `${JSON.stringify(rows)}\n` : rows.length ? rows.map((r) => `${r.job} · ${r.provider} · ${r.state} · ${r.thread ?? "-"} · ${elapsed(r.elapsedMs)} · ${r.lastEvent ?? "-"}${r.cleanupPending ? " · cleanup pending" : ""}`).join("\n") + "\n" : "no council jobs in this workspace/session\n");
    return 0;
  }
  const found = findJob(ctx.home, ref, provider);
  if (!found) throw new UsageError(`no job${provider ? " or thread" : ""} ${ref}`);
  for (const end = Date.now() + timeout; ; await sleep(sleepMs)) {
    const job = loadJob(ctx.home, found.id);
    if (!job) throw new Error("job record became unreadable");
    if (stateOf(job) !== "running") return finishedResult(ctx, o, job, out);
    if (Date.now() >= end) {
      const data = { provider: job.provider, job: job.id, status: "running", exit: 20, thread: job.threadId ?? job.requestedThreadId ?? null, elapsedMs: elapsedOf(job), lastEvent: lastEvent(job) };
      out(o.json ? `${JSON.stringify(data)}\n` : `still running · ${job.provider} · job ${job.id} · ${elapsed(data.elapsedMs)} · last event: ${data.lastEvent ?? "none yet"}\n`);
      return 20;
    }
  }
}

/** `cancel [job]`: stop a job and confirm its cleanup; `controlFor(job)` builds the controller with the job's provider module. */
export async function cancelJob(ctx, o, refs, out, { controlFor, provider = null, io = fs } = {}) {
  if (refs.length > 1) throw new UsageError("cancel accepts one job or thread");
  const [ref] = refs;
  // It returns as soon as cleanup is confirmed; Windows needs a few seconds of process queries for that.
  const timeoutMs = seconds(o.timeout, 30, "timeout") * 1000;
  const job = ref ? findJob(ctx.home, ref, provider) : candidates(ctx.home, ctx).find((j) => cleanupNeeded(j) || claimHeld(ctx.home, j));
  if (ref && !job) throw new UsageError(`no job ${ref}; an unidentified claim requires quiescent manual recovery`);
  if (!job) { out(o.json ? '{"status":"none","exit":0}\n' : "no running council job to cancel\n"); return 0; }
  const control = await controlFor(job);
  const result = await cancelManaged(ctx, job, { timeoutMs, control, io });
  const pending = result.code !== 0;
  const data = { provider: job.provider, job: job.id, status: result.status, exit: result.code, thread: result.job?.threadId ?? null, cleanupPending: pending, error: result.error ?? null, ...(result.warning ? { warning: result.warning } : {}) };
  out(o.json ? `${JSON.stringify(data)}\n` : `${result.status} · ${job.provider} · job ${job.id}${result.error ? ` · ${result.error}` : ""}${!pending && result.job?.threadId ? " · the thread stays resumable" : ""}${result.warning ? ` · ${result.warning}` : ""}\n`);
  return result.code;
}

/**
 * A7.4 replay of a request id whose claim already exists. A tombstone binds the id to its job and
 * provider: the first result is printed or awaited, or `result expired` when the body is gone. A
 * reservation without a tombstone belongs to a call still preparing: wait for its job, abandon it
 * only when that call is proven gone, and never start a CLI. Changed input under the id exits 2.
 */
export async function replayRequest(ctx, o, claimed, fingerprint, out, { control = executionController(), sleepMs = 50 } = {}) {
  const name = `request id ${o["request-id"]}`;
  const { id } = claimed;
  const end = Date.now() + seconds(o.deadline, DEADLINE_S, "deadline") * 1000;
  const unreadableBy = Date.now() + 5000; // A claim always holds its reservation; give a locked read time.
  let tombstone = claimed.tombstone ?? loadTombstone(ctx.home, id);
  let checkedAt = 0;
  while (!tombstone) {
    if (!requestReserved(ctx.home, id)) throw new UsageError(MESSAGES.requestFreed(name));
    const reservation = loadRequest(ctx.home, id);
    if (reservation && reservation.fingerprint && reservation.fingerprint !== fingerprint) throw new UsageError(`${name} was already used with different input; use a new request id`);
    if (!reservation && Date.now() >= unreadableBy) throw new UsageError(MESSAGES.requestMissing(name, id));
    if (reservation && Date.now() - checkedAt >= 1000) {
      checkedAt = Date.now();
      let snapshot;
      try { snapshot = control.snapshot(undefined, reservation.companionPid); } catch { snapshot = { state: "unknown", rows: [] }; }
      // Only a call known to be gone is abandoned; an unknown answer keeps waiting.
      if (companionState(reservation, snapshot) === "gone" && !(tombstone = loadTombstone(ctx.home, id))) {
        if (!neverPrepared(ctx.home, id, reservation)) throw new UsageError(MESSAGES.requestMissing(name, id));
        throw new UsageError(MESSAGES.requestNeverRan(name, id));
      }
    }
    tombstone ??= loadTombstone(ctx.home, id);
    if (tombstone) break;
    if (Date.now() >= end) {
      const data = { job: id, status: "preparing", exit: 20, thread: null, elapsedMs: reservation?.reservedAt ? Date.now() - Date.parse(reservation.reservedAt) : null, lastEvent: null };
      out(o.json ? `${JSON.stringify(data)}\n` : `still preparing · job ${id} · the first call with this request id has not recorded its job yet; retry with the same request id to keep waiting\n`);
      return 20;
    }
    await sleep(sleepMs);
  }
  if (tombstone.fingerprint !== fingerprint) throw new UsageError(`${name} was already used with different input; use a new request id`);
  // The tombstone precedes the job record by a moment; a pruned body never comes back.
  let job = loadJob(ctx.home, id);
  for (const until = Date.now() + 5000; !job && Date.now() < until && requestReserved(ctx.home, id); await sleep(sleepMs)) job = loadJob(ctx.home, id);
  if (!job) {
    const data = { provider: tombstone.provider, job: id, status: "expired", exit: 1, thread: null, error: EXPIRED };
    out(o.json ? `${JSON.stringify(data)}\n` : `${EXPIRED} · ${tombstone.provider} · job ${id} · its body was pruned; nothing was started again\n`);
    return 1;
  }
  if (!o.json) out(`${startLine(job)} replay=${o["request-id"]}\n`, "stderr");
  return waitFor(ctx, { ...o, timeout: Math.max(0.001, (end - Date.now()) / 1000) }, [id], out, { sleepMs: Math.max(sleepMs, 20) });
}
