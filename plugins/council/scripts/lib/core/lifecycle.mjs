// Ported from grok-build-plugin-cc 1.1.5 lib/lifecycle.mjs (baseline), codex-plugin-cc 2.3.2
// lib/lifecycle.mjs (PIPE_WAIT_MS, unattributed pipes and `thread locked`, trusted clean exits,
// cancelManaged with the look-again window) and gemini-plugin-cc lib/process.mjs:154-186 (group stop
// with escalation). Changes (PLAN.md S2 table): runManagedTurn takes the adapter and feeds
// turn.stdin or points at turn.promptFile; adapter.trustsCleanExit(launcher) replaces the constant;
// the stop path snapshots owned descendants, signals the process group, then escalates to SIGKILL;
// the thread record is updated after each turn. The entry's orchestration from grok.mjs (replay,
// wait, cancel, finished-result replay) lives here too.
import fs from "node:fs";
import path from "node:path";
import { BusyError, claimHeld, claimThread, releaseClaims } from "./claims.mjs";
import {
  EXPIRED, blockingJob, candidates, cleanupNeeded, createJob, findJob, lastEvent, loadJob, loadRequest, loadTombstone, markDone, markStopped,
  neverPrepared, requestReserved, resultRecord, saveJob, saveThread, stateOf,
} from "./jobs.mjs";
import { QUERY_MS, childEnv, companionState, executionController, recordRecoveryEvidence } from "./execution.mjs";
import { spawnChild } from "./launcher.mjs";
import { createReader } from "./reader.mjs";
import { MESSAGES, attentionReason, elapsed, elapsedOf, readAnswer, renderResult, resultJson, startLine } from "./output.mjs";
import { refreshBeat, BEAT_MS } from "./heartbeat.mjs";
import { UsageError, seconds } from "./args.mjs";
import { finalizeReviewTurn } from "./review.mjs";
import { unionEdited, worktreeChanges, worktreeSnapshot } from "./git.mjs";

/** Production defaults; tests inject shorter ones through hooks. */
export const SHUTDOWN_MS = 60000;
export const RETRY_MS = 10000;
export const DRAIN_MS = 1500;
/**
 * How long after a clean exit the child's pipes may stay open, held by nothing the turn owns, before
 * the turn ends "cleanup pending" with the thread locked (codex-plugin-cc lib/lifecycle.mjs:18-25).
 */
export const PIPE_WAIT_MS = 12000;
// A process caught mid-exit, or a pid reused during a query, reads as unknown for a moment.
const UNSURE_MS = 1000;
export const DEFAULT_ROUNDS = 9;
export const INACTIVITY_S = 1200;
export const DEADLINE_S = 14400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const running = (child) => child && child.exitCode === null && child.signalCode === null;
const remaining = (end) => Math.max(1, Math.min(QUERY_MS, end - Date.now()));
// A companion that finalized the cancellation itself reports it as cancelled, not finished.
const label = (job) => job.done && job.outcome !== "cancelled" ? "finished" : "cancelled";
const unique = (rows) => [...new Map(rows.map((r) => [`${r.pid}:${r.stamp}:${r.boot ?? ""}`, r])).values()];
// A failed kill cannot hold the caller's pipes forever.
const release = (child) => {
  if (!child) return;
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
  child.unref();
};

export { claimHeld };
export function jobView(home, job) {
  return { ...job, cleanupPending: cleanupNeeded(job), claimHeld: claimHeld(home, job) };
}

/** The serializable part of an adapter turn that the job record keeps for ownership and recovery. */
function turnRecord(turn) {
  return { args: turn.args, promptFile: turn.promptFile ?? null, answerFile: turn.answerFile ?? null, readOnly: turn.readOnly !== false, agent: turn.agent ?? null, contractCarrier: turn.contractCarrier ?? null, settingsPath: turn.settingsPath ?? null };
}

/**
 * One writer owns the job from admission through finalization. `initial` is the request prepared
 * before admission; `prepare(jobId)` resolves it again after the thread claim. Hooks are explicit
 * test seams.
 */
export async function runManagedTurn(ctx, adapter, initial, prepare, options = {}, hooks = {}) {
  const control = hooks.control ?? executionController({ adapter });
  const io = hooks.io ?? fs;
  const save = hooks.saveJob ?? saveJob;
  const finishMarker = hooks.markDone ?? markDone;
  const provider = adapter.id;
  const resumed = initial.thread?.threadId ?? null;
  const job = createJob(ctx.home, {
    provider, verb: initial.verb, status: "running", tier: initial.tier, model: initial.model, effort: initial.effort,
    requestedEffort: initial.requestedEffort ?? initial.effort, modelVerified: initial.modelVerified !== false,
    readOnly: initial.readOnly !== false, web: Boolean(initial.web), cwd: initial.cwd, session: ctx.session ?? null,
    threadId: null, requestedThreadId: resumed, threadIds: [], admitted: false, cleanupPending: false,
    companionPid: process.pid, companionIdentity: control.self(), execution: [], pid: null,
    spawnedAt: new Date().toISOString(), round: initial.round ?? 0, rounds: initial.rounds ?? DEFAULT_ROUNDS, roundsSet: Boolean(initial.roundsSet),
    requestId: options.requestId ?? null, fingerprint: options.fingerprint ?? null,
  }, options.jobId);
  const cancelFile = path.join(job.dir, "cancel");
  const cancelled = () => io.existsSync(cancelFile);
  const beat = () => refreshBeat(job, io);
  const guarded = {
    inspect: (...args) => control.inspect(...args),
    snapshot: (...args) => { beat(); return control.snapshot(...args); },
    stop: (...args) => { beat(); return control.stop(...args); },
    stopGroup: (...args) => { beat(); return control.stopGroup(...args); },
  };
  let request = initial, turn = null, child = null, reason = null, persistenceFailed = false, spawnError = null;
  let refused = false, drainExpired = false, pipesClosed = false, exhausted = false, announced = false, answer = "", queryError = null;
  let answerFile = path.join(job.dir, "answer.md");
  const announce = () => {
    if (!announced && !options.json) { announced = true; hooks.announce?.(job); }
  };
  const claim = (id) => {
    if (!id) return;
    try { claimThread(ctx.home, provider, id, job, hooks.claimIo); }
    catch (error) {
      // A claim left unpublished reads as unknown: recorded here, it keeps this job, which explains it.
      if (error.claimLeft) { job.threadIds = [...new Set([...job.threadIds, id])]; try { save(job); } catch { /* Finalization saves again. */ } }
      // Neither wait nor cancel frees a thread whose output an unidentified process held.
      const holder = error instanceof BusyError && error.job ? loadJob(ctx.home, error.job) : null;
      if (holder?.done && holder.unattributedPipes && !holder.stopped) {
        error.message = MESSAGES.threadLocked(id, error.job);
      }
      throw error;
    }
    job.threadIds = [...new Set([...job.threadIds, id])];
    save(job);
    // A7.8: a lost or cleanup-pending job blocks its thread until cancel confirms, even without a claim.
    const old = blockingJob(ctx.home, provider, id, job.id);
    if (old) throw new BusyError(MESSAGES.threadCleanup(id, old.id), old.id);
  };
  let reader = null, edits = null;
  let cleanupConfirmed = true; // No spawn yet.
  let streamFailure = null;
  let stop = (why) => { reason ??= why; };

  try {
    await hooks.beforeClaim?.(job);
    claim(resumed);
    // Re-read history after admission so a turn that finished meanwhile is inherited.
    request = prepare(job.id);
    if ((request.thread?.threadId ?? null) !== resumed) throw new Error("the thread changed during admission");
    // Rechecked under the claim: another turn may have finished meanwhile and left the thread not resumable.
    if (request.thread && request.thread.resumable === false) throw new UsageError(`${provider} thread ${resumed}: ${request.thread.unconfirmed ?? "not resumable"}`);
    const launcher = adapter.resolveLauncher(ctx.env, process.platform);
    if (!launcher) throw new Error(`${provider} not found; run setup, or set ${adapter.binEnv}`);
    // A5 (S2.8): the adapter reads the caller's environment and the resolved launcher from here, never process.env.
    turn = adapter.buildTurn({ ...request, jobId: job.id, jobDir: job.dir, provider, env: ctx.env, launcher });
    if (!turn || !Array.isArray(turn.args)) throw new Error(`${provider} adapter returned no launch arguments`);
    if (turn.answerFile) answerFile = turn.answerFile;
    // A preassigned id (Grok-like) is claimed before the spawn; a discovered one on its first event.
    if (turn.threadId && !resumed) claim(turn.threadId);
    Object.assign(job, {
      tier: request.tier, model: request.model, effort: request.effort, requestedEffort: request.requestedEffort ?? request.effort,
      modelVerified: request.modelVerified !== false, readOnly: turn.readOnly !== false, web: Boolean(request.web), cwd: request.cwd,
      threadId: resumed ?? null, requestedThreadId: resumed ?? turn.threadId ?? null, target: request.target ?? null, unreviewed: request.unreviewed ?? [],
      admitted: true, admittedAt: new Date().toISOString(), round: request.round ?? job.round, rounds: request.rounds ?? job.rounds, roundsSet: Boolean(request.roundsSet),
      launcher: { kind: launcher.kind, path: launcher.path }, childArgs: turn.args, argv: [launcher.command, ...launcher.args, ...turn.args], turn: turnRecord(turn),
    });
    if (turn.promptFile) io.writeFileSync(turn.promptFile, turn.promptText ?? request.text ?? "");
    save(job);
    await hooks.beforeSpawn?.(job);
    if (!cancelled() && adapter.beforeTurn) {
      // A5: once, after admission and before the spawn; a throw fails the turn with nothing started.
      adapter.beforeTurn({ job, request, turn, home: ctx.home, env: ctx.env });
    }
    if (cancelled()) {
      reason = "cancelled";
    } else {
      // X2: a task's edits are also counted from the working tree, so one made through a shell shows.
      if (request.verb === "task") { beat(); edits = worktreeSnapshot(request.cwd); beat(); }
      cleanupConfirmed = false;
      job.spawnAttempted = true;
      save(job); // Persist the exact operands before any executable can start.
      const startedAt = Date.now();
      let stoppedAt = 0, killedAt = 0, escalateAt = 0, lastEventAt = startedAt, beatAt = startedAt, exitedAt = 0;
      const shutdownMs = hooks.shutdownMs ?? SHUTDOWN_MS;
      const retryMs = hooks.retryMs ?? RETRY_MS;
      const drainMs = hooks.drainMs ?? DRAIN_MS;
      const pipeWaitMs = hooks.pipeWaitMs ?? PIPE_WAIT_MS;
      const graceMs = hooks.graceMs ?? 1500;
      const beatMs = hooks.beatMs ?? BEAT_MS;
      // A7.5 (S2.9): at every heartbeat the identities (pid + creation time) of the owned descendants
      // are persisted, so a member found later through the process group after the leader is gone
      // can be recognised by identity instead of by group alone. A failed query changes nothing here.
      const recordDescendants = () => {
        try {
          const found = guarded.inspect(job, guarded.snapshot(QUERY_MS));
          const before = job.execution.length;
          job.execution = unique([...job.execution, ...found.rows]);
          if (job.execution.length !== before) save(job);
        } catch { /* the next heartbeat or the stop snapshot records them */ }
      };
      const deadlineMs = options.deadlineMs ?? DEADLINE_S * 1000;
      const inactivityMs = options.inactivityMs ?? INACTIVITY_S * 1000;
      // Snapshot the owned descendants (durable first), then signal: the group with SIGTERM on the
      // first pass, each identified row with SIGKILL once the grace passed or on a retry.
      const stopOwned = (escalate) => {
        let found;
        const end = stoppedAt + shutdownMs;
        try {
          found = guarded.inspect(job, guarded.snapshot(remaining(end)));
          job.execution = unique([...job.execution, ...found.rows]);
          save(job); // Capture descendants before their parent can disappear.
        } catch (error) {
          persistenceFailed = true;
          reason ??= `storage/process query: ${error.message}`;
          return; // Do not orphan descendants by killing their parent before ownership is durable.
        }
        // POSIX first pass: SIGTERM to the group, escalation later through identity-checked stops.
        // Windows has no group signal: the identity-checked `taskkill /T /F` runs at once, as the donors did.
        if (!escalate && (control.platform ?? process.platform) !== "win32") {
          if (job.pid && running(child)) guarded.stopGroup(job.pid).catch(() => {});
          return;
        }
        for (const row of found?.rows ?? []) {
          if (Date.now() - stoppedAt >= shutdownMs) break;
          try { guarded.stop(row, remaining(end), "SIGKILL"); } catch { /* Unknown: rescan before release. */ }
        }
        // If ownership could not be queried, do not fall back to an unverified numeric pid.
      };
      stop = (why) => {
        reason ??= why;
        if (stoppedAt) return;
        stoppedAt = killedAt = Date.now();
        escalateAt = stoppedAt + graceMs;
        stopOwned(false);
      };
      const onText = (text) => {
        if (persistenceFailed || turn.answerFile) return; // An answer-file adapter's deltas are progress, not the answer.
        try { io.appendFileSync(answerFile, text); }
        catch (error) { persistenceFailed = true; stop(`answer storage failed: ${error.message}`); }
      };
      reader = createReader({
        adapter, cwd: job.cwd, turn, maxLineBytes: adapter.maxLineBytes,
        onThread(id) {
          // A resumed or preassigned thread must come back unchanged before anything is published (grok-build reader.mjs:115).
          const expected = resumed ?? turn.threadId ?? null;
          if (!expected) claim(id);
          else if (id.toLowerCase() !== expected.toLowerCase()) throw new Error(`${provider} answered on thread ${id}, expected ${expected}`);
          job.threadId = id; save(job); announce();
        },
        // Review text is stored too: a finished review replaces it with the rendered result, an incomplete one keeps it.
        onText,
        onFailure(message) { streamFailure = message; stop(message); },
      });
      await new Promise((resolve) => {
        let settled = false, exitTimer = null, timer = null;
        const handlers = new Map();
        const finish = () => {
          if (settled) return;
          settled = true; clearInterval(timer); clearTimeout(exitTimer);
          for (const [signal, fn] of handlers) process.off(signal, fn);
          resolve();
        };
        try {
          child = (hooks.spawn ?? spawnChild)(launcher, turn.args, { cwd: request.cwd, env: childEnv(ctx.env, turn.env ?? {}) });
        } catch (error) { spawnError = error; cleanupConfirmed = true; finish(); return; }
        child.on("error", (error) => { spawnError = error; finish(); });
        child.on("exit", () => {
          exitedAt = Date.now();
          clearInterval(timer);
          // Do not truncate terminal bytes queued after exit, or wait forever for inherited pipes.
          exitTimer = setTimeout(() => { drainExpired = true; finish(); }, drainMs);
        });
        child.on("close", () => { pipesClosed = true; finish(); });
        for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
          const fn = () => stop("interrupted"); handlers.set(signal, fn); process.on(signal, fn);
        }
        child.stdin.on("error", () => {});
        child.stdout.on("data", (chunk) => {
          if (!persistenceFailed) {
            try { io.appendFileSync(path.join(job.dir, "events.jsonl"), chunk); }
            catch (error) { persistenceFailed = true; stop(`event storage failed: ${error.message}`); }
          }
          if (reader.feed(chunk)) lastEventAt = Date.now();
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => { job.stderrTail = ((job.stderrTail ?? "") + chunk).slice(-4096); });
        timer = setInterval(() => {
          const now = Date.now();
          if (now - beatAt >= beatMs) {
            if (beat()) { beatAt = now; if (!reason) recordDescendants(); }
            else { persistenceFailed = true; stop("heartbeat storage failed"); }
          }
          if (reason) {
            if (now - stoppedAt >= shutdownMs) { exhausted = true; finish(); }
            else if (escalateAt && now >= escalateAt) { escalateAt = 0; killedAt = now; stopOwned(true); }
            else if (now - killedAt >= retryMs) { killedAt = now; stopOwned(true); }
          } else if (cancelled()) stop("cancelled");
          else if (now - startedAt >= deadlineMs) stop("wall-clock deadline passed");
          else if (now - lastEventAt >= inactivityMs) stop(`${provider} printed nothing before the inactivity deadline`);
        }, Math.max(20, Math.min(250, Math.min(deadlineMs, inactivityMs) / 10)));
        job.pid = child.pid ?? null;
        job.pgid = child.pid ?? null; // Spawned detached: the child leads its own group.
        // A7.5 (S2.8): record the leader's creation time, so a reused group is never adopted later.
        if (job.pid && (control.platform ?? process.platform) !== "win32") {
          try { job.leader = control.identify?.(job.pid) ?? null; } catch { job.leader = null; }
        }
        try {
          save(job); // Recovery finds this child by its exact operands; no per-turn process query.
          if (cancelled()) stop("cancelled"); // Covers the cancellation-before/while-spawning race.
          else if (turn.threadId || resumed) announce();
          if (turn.stdin !== undefined && turn.stdin !== null) child.stdin.end(turn.stdin); else child.stdin.end();
        } catch (error) { persistenceFailed = true; stop(`launch storage failed: ${error.message}`); }
      });
      reader.end();
      if (!drainExpired) release(child);
      else {
        // Output after the drain is not part of the turn, but the pipes stay open and read: their
        // closure is the only evidence that whatever held them has stopped.
        child.stdin.destroy();
        for (const stream of [child.stdout, child.stderr]) { stream.removeAllListeners("data"); stream.resume(); }
      }
      // Closed pipes prove only that the launcher ended: a backend it started with other output can
      // still hold the job's operands. A scan follows every exit unless the adapter qualified this
      // launcher kind as one whose clean exit ends everything (A5 trustsCleanExit).
      if (!cleanupConfirmed && !reason && !drainExpired && !running(child) && child?.exitCode === 0 && adapter.trustsCleanExit(launcher) === true) cleanupConfirmed = true;
      // Finds execution the turn owns that outlived the launcher, and stops it.
      const scanOwned = async () => {
        let found = guarded.inspect(job, guarded.snapshot());
        const stopped = found.rows.length > 0;
        if (stopped) {
          reason ??= "owned execution survived the launcher";
          const end = Date.now() + (exhausted ? 0 : Math.min(shutdownMs, QUERY_MS));
          do {
            job.execution = unique([...job.execution, ...found.rows]);
            save(job);
            for (const row of found.rows) {
              if (Date.now() >= end) break;
              try { guarded.stop(row, remaining(end), "SIGKILL"); } catch { /* Keep cleanup pending. */ }
            }
            await sleep(50);
            found = guarded.inspect(job, guarded.snapshot(remaining(end)));
          } while (found.state === "owned" && Date.now() < end);
        }
        return { found, stopped };
      };
      if (!cleanupConfirmed) {
        let { found, stopped } = await scanOwned();
        cleanupConfirmed = found.state === "gone" && !running(child);
        if (drainExpired) {
          // Stopping an identified process proves nothing about an unidentified one holding the pipes:
          // only their closure does. A stopped holder's pipes close as it exits.
          for (const end = Date.now() + (stopped ? drainMs : 0); !pipesClosed && Date.now() < end;) await sleep(20);
          // After a clean exit that left nothing owned, wait a bounded time for whatever holds the pipes
          // to let go. Only their closure and a fresh scan finish the turn clean; nothing is killed.
          if (!pipesClosed && cleanupConfirmed && !stopped && !reason && child.exitCode === 0) {
            cleanupConfirmed = false; // Until the pipes close and a fresh scan agrees, even if this throws.
            job.unattributedPipes = true;
            save(job); // A companion lost while waiting leaves the claim to recovery, which keeps it.
            for (const end = exitedAt + pipeWaitMs; !pipesClosed && Date.now() < end;) {
              await sleep(50);
              if (Date.now() - beatAt >= BEAT_MS && beat()) beatAt = Date.now();
            }
            if (pipesClosed) {
              delete job.unattributedPipes;
              ({ found, stopped } = await scanOwned());
              cleanupConfirmed = found.state === "gone" && !running(child);
            }
          }
          if (!pipesClosed) {
            // cancel can never confirm this cleanup; it can still stop processes it identifies.
            Object.assign(job, { unattributedPipes: true, identifiedStopped: found.state === "gone" });
            cleanupConfirmed = false;
          }
        }
        queryError = found.error ?? null; // A failed process query, not a surviving process.
      }
      release(child);
    }
  } catch (error) {
    if (child && running(child)) {
      stop(error.message);
      cleanupConfirmed = false;
    }
    release(child);
    reason ??= error.message;
    if (error instanceof BusyError || error instanceof UsageError) job.admitted = job.admitted && Boolean(turn);
    // Invalid input found only under the claim (a thread no longer resumable) exits 2, as it would have before admission.
    if (error instanceof UsageError && !child) refused = true;
    if (!turn) job.admitted = false;
  }

  const seen = reader?.state;
  let parsed = null;
  const isReview = request.verb === "review";
  const parseAnswer = () => { parsed = readAnswer(answerFile); answer = parsed.answer; };
  // A review's raw text is never preview-scanned before its structured result is finalized: valid
  // structured output can be one minified JSON line over the answer-line limit. It is only a fallback.
  if (!isReview) {
    try { parseAnswer(); }
    catch (error) { if (error.code !== "ENOENT") reason ??= `answer storage failed: ${error.message}`; }
  }
  let outcome = "failed", error = reason;
  if (reason === "cancelled") outcome = "cancelled";
  else if (!error && persistenceFailed) error = "job storage failed";
  else if (!error && spawnError) error = `could not start ${provider}: ${spawnError.message}`;
  else if (!error && (streamFailure || seen?.failed)) error = streamFailure ?? seen.failed;
  else if (!error && !seen?.completed) error = seen?.error ?? (job.stderrTail?.trim().split(/\r?\n/).at(-1) || `${provider} ended without finishing the turn`);
  else if (!error && child?.exitCode !== 0) error = seen?.error ?? `${provider} exited with code ${child?.exitCode}`;
  else if (!error && seen?.incomplete) {
    error = seen.incomplete; // A5.1/A3.3: an incomplete turn (print timeout) is exit 1, never 20, on every verb.
    if (isReview) {
      // Exit 1 stands, but what the review produced is kept: the structured result rendered as an
      // incomplete review as far as it validates, else the partial text. It grants no coverage.
      let fullText = "";
      try { fullText = io.readFileSync(answerFile, "utf8"); } catch { /* no partial text */ }
      const review = finalizeReviewTurn({ adapter, answerText: fullText, answerFile, structured: seen?.structured ?? null, unreviewed: [...(request.reviewed ?? []), ...(job.unreviewed ?? [])], reviewed: [], incomplete: seen.incomplete, noCoverage: true });
      job.review = review.result;
      job.verdict = review.result.verdict;
      let partial = false;
      if (!review.valid) { try { parseAnswer(); partial = parsed.nonempty; } catch { parsed = null; } }
      if (!partial) {
        try { io.writeFileSync(answerFile, review.renderedText); parseAnswer(); }
        catch (failure) { error = `${error}; answer storage failed: ${failure.message}`; }
      }
    }
  }
  else if (!error && isReview) {
    // The adapter reads the whole answer, never the 24 KiB preview; the cap applies only when printing.
    let fullText = "";
    try { fullText = io.readFileSync(answerFile, "utf8"); } catch (failure) { if (failure.code !== "ENOENT") error ??= `answer storage failed: ${failure.message}`; }
    const review = finalizeReviewTurn({ adapter, answerText: fullText, answerFile, structured: seen?.structured ?? null, unreviewed: job.unreviewed ?? [], reviewed: request.reviewed ?? [] });
    job.review = review.result;
    job.verdict = review.result?.verdict ?? null;
    if (review.renderedText !== undefined && review.renderedText !== null) {
      try { io.writeFileSync(answerFile, review.renderedText); parseAnswer(); }
      catch (failure) { error = `answer storage failed: ${failure.message}`; }
    }
    // A denied action needs attention on a review as on every other verb, whatever the verdict.
    if (!error) outcome = review.exit === 10 || seen?.denied ? "attention" : "ok";
  }
  else if (!error && !parsed) error = `${provider} wrote no answer`;
  else if (!error && !parsed.nonempty) error = `${provider} returned no answer`;
  else if (!error) outcome = seen?.denied ? "attention" : parsed.questions ? "attention" : "ok";
  // A review that failed before finalization shows whatever text it streamed, best effort.
  if (isReview && !parsed) { try { parseAnswer(); } catch { parsed = null; answer = ""; } }
  if (!cleanupConfirmed) {
    // Unconfirmed cleanup fails the turn whatever it produced; the footer still says if the answer was whole.
    if (job.unattributedPipes) job.answerComplete = ["ok", "attention"].includes(outcome);
    outcome = "failed";
    error = MESSAGES.cleanupPending(provider, [reason, queryError].filter(Boolean).join("; "));
  }
  let edited = [...(seen?.edited ?? [])];
  if (edits) { beat(); edited = unionEdited(request.cwd, edited, worktreeChanges(request.cwd, edits)); }
  Object.assign(job, {
    status: ["ok", "attention"].includes(outcome) ? "done" : outcome, outcome, code: outcome === "ok" ? 0 : outcome === "attention" ? 10 : refused && outcome === "failed" && cleanupConfirmed ? 2 : 1,
    error, cleanupPending: !cleanupConfirmed, endedAt: new Date().toISOString(),
    // X1: the reason a turn needs attention, shown in the footer as `attention: <reason>`.
    attention: outcome === "attention" ? attentionReason({ isReview, review: job.review, denied: seen?.denied, deniedAction: seen?.deniedAction, deniedCount: seen?.deniedCount, questions: parsed?.questions }) : null,
    edited, failedCommands: seen?.failedCommands ?? [], failedCommandCount: seen?.failedCommandCount ?? 0,
    unconfirmed: isReview ? null : seen?.unconfirmed ?? null, denied: seen?.denied ?? null, costUsd: seen?.costUsd ?? null, usage: seen?.usage ?? null, answerClipped: parsed?.answerClipped ?? false,
  });
  delete job.stderrTail;
  try {
    beat();
    await hooks.beforeFinalize?.(job);
    // A7.6: the thread record follows every threaded turn that confirmed its thread. It is written
    // while the claim is still held and before completion is published, so a failed write never
    // leaves a published result whose thread metadata is stale.
    if (job.threadId && !isReview && job.admitted) {
      (hooks.saveThread ?? saveThread)(ctx.home, { provider, threadId: job.threadId, cwd: job.cwd, model: job.model, effort: job.effort, tier: job.tier, round: job.round, rounds: job.rounds, roundsSet: job.roundsSet, web: job.web, agent: turn?.agent ?? null, lastJob: job.id, lastVerb: job.verb, readOnly: job.readOnly, ...(job.unconfirmed ? { resumable: false, unconfirmed: job.unconfirmed } : {}) });
    }
    save(job); finishMarker(job); // No other process writes these result artifacts.
    if (cleanupConfirmed) releaseClaims(ctx.home, job);
  } catch (failure) {
    // Retain the claim if durable finalization or release could not be completed.
    job.code = 1; job.outcome = "failed"; job.cleanupPending = true; job.attention = null;
    job.error = `finalization failed: ${failure.message}`;
  }
  // A5: afterTurn runs once, after finalization, and only once cleanup is verified (also on failure or cancel).
  // The two hooks are independent: afterTurn needs only a built turn, not a beforeTurn.
  if (turn && adapter.afterTurn && cleanupConfirmed) {
    try { adapter.afterTurn({ job, request, turn, home: ctx.home, env: ctx.env }, { outcome: job.outcome, code: job.code, error: job.error }); }
    catch (failure) { job.afterTurnError = failure.message; try { save(job); } catch { /* the result stands */ } }
  }
  announce();
  return { job: jobView(ctx.home, job), answer };
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
    const owner = companionState(job, snapshot);
    if (owner === "gone") {
      let found;
      try { found = control.inspect(job, snapshot); }
      catch (e) { return { status: "unknown", code: 1, job: view(), error: e.message }; }
      if (found.state === "unknown") unsure = `${found.error ? `${found.error}; ` : ""}execution ownership/cleanup cannot be confirmed; claim and cancellation request retained`;
      else if (found.state === "gone") {
        // Identified execution is stopped, but an unidentified holder of the turn's pipes may not be.
        if (job.unattributedPipes) return { status: "unknown", code: 1, job: view(), error: "execution ownership/cleanup cannot be confirmed; claim and cancellation request retained" };
        markStopped(job);
        releaseClaims(ctx.home, job);
        const current = view();
        return { status: current.claimHeld ? "unknown" : label(job), code: current.claimHeld ? 1 : 0, job: current };
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
  const data = { provider: job.provider, job: job.id, status: result.status, exit: result.code, thread: result.job?.threadId ?? null, cleanupPending: pending, error: result.error ?? null };
  out(o.json ? `${JSON.stringify(data)}\n` : `${result.status} · ${job.provider} · job ${job.id}${result.error ? ` · ${result.error}` : ""}${!pending && result.job?.threadId ? " · the thread stays resumable" : ""}\n`);
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
      try { snapshot = control.snapshot(); } catch { snapshot = { state: "unknown", rows: [] }; }
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
