// Ported from grok-build-plugin-cc 1.1.5 lib/jobs.mjs with codex-plugin-cc 2.3.2 lib/jobs.mjs:56
// (16-character random ids) and :109-124 (prune through trash/). Changes (PLAN.md S2 table, A7):
// root COUNCIL_HOME → ~/.council; 16-character ids on both routes (random for fresh jobs, the hash of
// provider + session + realpath(cwd) + request id for request ids); the job record carries
// `provider`; candidates() filters by cwd and session together; claimRequest / markRequestPrepared /
// releaseRequest implement the A7.4 lifecycle with the fingerprint in an immutable tombstone under
// claims/requests/ and `result expired` when the body is gone; latestOnThread, blockingJob and
// onThread take the provider; thread records live under threads/<provider>-<threadId>.json.
import { reservationRecord, readPublications, publishRequest, cleanupPublications, syncPublicationDirectory, linkReservation, releaseReservation } from "./request-publication.mjs";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { canonical, readJson, readRecord, retryLocked, sleepSync, writeFileAtomic } from "./fs.mjs";
import { UsageError } from "./catalog.mjs";
import { THREAD, claimHeld } from "./claims.mjs";
import { BEAT_STALE_MS, beatMs, touchBeat } from "./heartbeat.mjs";
import { MESSAGES } from "./output.mjs";

export const KEEP_FINISHED = 100;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 16;
const REQUEST_FILE = "request.json";
export const JOB_ID = /^[a-z0-9]{1,16}$/;
// Caller-chosen and typed into commands, so short and shell-safe; hashed into the job id, never a path.
export const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** What a replay says when the request's job body was pruned: never a second CLI. */
export const EXPIRED = "result expired";

/**
 * One canonical local state root (A7.1). It is created before it is resolved: a root that did not
 * exist yet would otherwise keep its unresolved spelling (a symlink or junction) on first use, and
 * later calls could not match the paths that turn recorded.
 */
export function homeDir(env = process.env) {
  const root = path.resolve(env.COUNCIL_HOME || path.join(os.homedir(), ".council"));
  try { fs.mkdirSync(root, { recursive: true }); } catch { /* canonical() falls back; a later write reports the error. */ }
  return canonical(root);
}
export const jobsRoot = (home) => path.join(home, "jobs");
export const tombstoneFile = (home, id) => path.join(home, "claims", "requests", `${id}.json`);
export const threadFile = (home, provider, threadId) => path.join(home, "threads", `${provider}-${String(threadId).toLowerCase()}.json`);

/** Only the job's companion writes metadata. Marker/read-time fields never enter that record. */
export function saveJob(job) {
  const { dir, done, beatMs: beat, stopped, stoppedAt, cancelRequested, claimHeld: held, ...meta } = job;
  writeFileAtomic(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
}

export function markDone(job) {
  fs.writeFileSync(path.join(job.dir, "done"), "");
  job.done = true;
}

/** Recovery's only terminal artifact: it never rewrites a slow/dead companion's result. */
export function markStopped(job) {
  try {
    fs.writeFileSync(path.join(job.dir, "stopped"), "", { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

/** Creates a job directory, or returns false when it exists: its id is reserved from here on, before any record. */
function claimDir(home, id) {
  fs.mkdirSync(jobsRoot(home), { recursive: true });
  try {
    fs.mkdirSync(path.join(jobsRoot(home), id));
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}
export const randomId = () => Array.from(randomBytes(ID_LENGTH), (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
export function reserveJob(home) {
  for (;;) {
    // Long enough that the id of a deleted job is never issued again (codex-plugin-cc lib/jobs.mjs:56).
    const id = randomId();
    if (claimDir(home, id)) return id;
  }
}

export function createJob(home, fields, id = reserveJob(home)) {
  if (!fields.provider) throw new Error("a job record needs its provider");
  const job = { id, ownerToken: randomBytes(16).toString("hex"), ...fields, dir: path.join(jobsRoot(home), id), done: false };
  // The heartbeat before the record: a job a reader can load always has one. Without it a running
  // job reads as lost, and a retry or wait arriving between the two writes would report it so.
  touchBeat(job);
  saveJob(job);
  prune(home);
  return job;
}

/**
 * Moves a directory, retrying while Windows reports it busy. Returns false when `to` already exists
 * as another directory with content: a claim is a rename, so the loser sees the winner's directory.
 */
function moveDir(from, to) {
  for (const deadline = Date.now() + 5000; ; sleepSync(10 + Math.floor(Math.random() * 20))) {
    try {
      fs.renameSync(from, to);
      return true;
    } catch (error) {
      if (fs.existsSync(to)) return false;
      if (!["EEXIST", "ENOTEMPTY", "EPERM", "EBUSY", "EACCES"].includes(error.code) || Date.now() >= deadline) throw error;
    }
  }
}
/** Removes a claimed directory whole: renamed aside first, so no reader sees it half-removed. */
function dropDir(home, id) {
  const aside = path.join(jobsRoot(home), `.drop-${id}-${randomBytes(4).toString("hex")}`);
  if (moveDir(path.join(jobsRoot(home), id), aside)) fs.rmSync(aside, { recursive: true, force: true });
}

/** A7.3 claim key → the 16-character job id of a request. */
export function requestJobId(provider, session, cwd, requestId) {
  return createHash("sha256").update(JSON.stringify([provider, session ?? null, cwd, requestId])).digest("hex").slice(0, ID_LENGTH);
}

/**
 * A7.4 claim. The job directory appears with its reservation already inside (a renamed temporary
 * directory), so no retry ever sees a claim without the claiming call's identity. Of concurrent
 * calls with one id exactly one claims it and runs; the others find its reservation or tombstone.
 * → {id, fresh, tombstone?, reservation?}
 */
export function claimRequest(home, provider, requestId, { session, cwd }, reservation = {}) {
  if (!REQUEST_ID.test(requestId ?? "")) throw new UsageError("--request-id needs 1 to 128 letters, digits, '.', '_', ':' or '-', starting with a letter or digit");
  const id = requestJobId(provider, session, cwd, requestId);
  const tombstone = loadTombstone(home, id);
  if (tombstone) return { id, fresh: false, tombstone, reservation: loadRequest(home, id) };
  fs.mkdirSync(jobsRoot(home), { recursive: true });
  const temp = path.join(jobsRoot(home), `.claim-${process.pid}-${randomBytes(4).toString("hex")}`);
  const claim = randomBytes(8).toString("hex");
  let fresh = false;
  try {
    if (!requestReserved(home, id)) {
      fs.mkdirSync(temp);
      fs.writeFileSync(path.join(temp, REQUEST_FILE), `${JSON.stringify({ ...reservation, provider, requestId, claim, reservedAt: new Date().toISOString() })}\n`);
      fresh = moveDir(temp, path.join(jobsRoot(home), id));
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  if (fresh) return { id, fresh, claim };
  // The loser: a tombstone may have landed meanwhile.
  return { id, fresh: false, tombstone: loadTombstone(home, id), reservation: loadRequest(home, id) };
}
// --- provider-neutral request binding (A7.4, S2.9) ----------------------------------------------------

/** claims/requests/scope-<hash>.json: one per session + realpath(cwd) + request id, whatever the provider. */
export const scopeFile = (home, session, cwd, requestId) =>
  path.join(home, "claims", "requests", `scope-${createHash("sha256").update(JSON.stringify([session ?? null, cwd, requestId])).digest("hex").slice(0, ID_LENGTH)}.json`);

/**
 * Exclusive creation of the request's binding before its provider is resolved, so two identical
 * calls can never resolve `--last` differently and reserve two jobs. It stores the fingerprint now
 * and the provider and job id once resolved (bindScope). → {fresh: true, file} | {fresh: false, file, record}
 */
export function claimScope(home, { session, cwd, requestId }, record, io = fs) {
  if (!REQUEST_ID.test(requestId ?? "")) throw new UsageError("--request-id needs 1 to 128 letters, digits, '.', '_', ':' or '-', starting with a letter or digit");
  const file = scopeFile(home, session, cwd, requestId);
  io.mkdirSync(path.dirname(file), { recursive: true });
  // The binding appears complete or not at all: written to a private temporary file, then hard-linked
  // to its name (exclusive: EEXIST when another call holds it). A failed write leaves no empty binding
  // that identical retries would wait on.
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const recordToken = randomBytes(16).toString("hex");
  try {
    io.writeFileSync(temp, `${JSON.stringify(reservationRecord({ ...record, recordToken, requestId, session: session ?? null, cwd, provider: null, job: null, reservedAt: new Date().toISOString() }))}\n`, { flag: "wx", flush: true });
    try { linkReservation(temp, file, { recordToken }, io); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      return { fresh: false, file, record: loadScope(file) };
    }
    syncPublicationDirectory(file, io);
    return { fresh: true, file, recordToken };
  } finally {
    // Best effort: once the binding is linked, a failed removal of the temporary name must not turn
    // a successful claim into a thrown error that abandons the published binding.
    try { io.rmSync(temp, { force: true }); } catch {}
  }
}
/** The binding, or null while its creator is still writing it (or when it was released). */
export function loadScope(file) {
  return readPublications(file, readRecord(file), ["binding"]);
}
/** Records the resolved provider and job id in the binding. */
export function bindScope(file, provider, job, expectedToken = null) {
  const record = loadScope(file);
  if (!record) throw new Error(`request binding ${path.basename(file)} cannot be read`);
  if (expectedToken && record.recordToken !== expectedToken) throw new Error("request reservation changed; leave it intact");
  publishRequest(file, record, "binding", { provider, job, boundAt: new Date().toISOString() });
}
/** Frees a binding whose call failed before its tombstone: nothing ran, so a retry may. */
export function releaseScope(file, expectedToken = null) {
  return releaseReservation(file, expectedToken);
}

/** The reservation a request id's first call wrote with its claim, or null. */
export const loadRequest = (home, id) => readJson(path.join(jobsRoot(home), id, REQUEST_FILE));
/** Whether a request id is still claimed: a call that failed before its job record frees it. */
export const requestReserved = (home, id) => fs.existsSync(path.join(jobsRoot(home), id));
/** The immutable tombstone (A7.4), or null. */
export const loadTombstone = (home, id) => readJson(tombstoneFile(home, id));
/**
 * Writes the tombstone once preparation succeeded and before the job record is written and the CLI
 * can start. It is immutable: a second write is an error, never an overwrite.
 */
export function markRequestPrepared(home, id, { provider, requestId, fingerprint, session, cwd, verb }) {
  const file = tombstoneFile(home, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = { job: id, provider, requestId, verb, fingerprint, session: session ?? null, cwd, preparedAt: new Date().toISOString() };
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`, { flag: "wx" });
  return record;
}
/**
 * Whether a request id's directory holds exactly the reservation of the claim its record names and no
 * tombstone exists: proof that no CLI ran for it.
 */
export function neverPrepared(home, id, reservation) {
  if (loadTombstone(home, id)) return false;
  let names;
  try { names = fs.readdirSync(path.join(jobsRoot(home), id)); } catch { return false; }
  const record = loadRequest(home, id);
  return names.length === 1 && names[0] === REQUEST_FILE && typeof reservation?.claim === "string" && record?.claim === reservation.claim;
}
/** Frees a claimed id whose call failed before preparation: nothing ran, so a retry may run. */
export function releaseRequest(home, id) {
  if (loadTombstone(home, id)) throw new Error(`request job ${id} was prepared; its claim cannot be released`);
  dropDir(home, id);
}

function mtime(file) {
  try { return fs.statSync(file).mtime; }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export function loadJob(home, id) {
  if (!JOB_ID.test(id ?? "")) return null;
  const dir = path.join(jobsRoot(home), id);
  // One directory read finds every marker, before the metadata: metadata read after done was seen is
  // final. Every turn loads every job, so a finished job costs a listing and one file read.
  // A job that cannot be read now throws: dropped from a listing, an older job would be selected instead.
  let names, meta;
  try {
    names = new Set(retryLocked(() => fs.readdirSync(dir)));
    meta = readRecord(path.join(dir, "meta.json"));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw new Error(MESSAGES.jobUnreadable(id, error.code ?? error.message));
  }
  const done = names.has("done");
  const stoppedAt = names.has("stopped") ? mtime(path.join(dir, "stopped"))?.toISOString() ?? null : null;
  // Only an unfinished job's state depends on its heartbeat.
  const beat = done || stoppedAt || !names.has("beat") ? 0 : beatMs(dir);
  return meta && { ...meta, dir, done, beatMs: beat, stopped: stoppedAt !== null, stoppedAt, cancelRequested: names.has("cancel") };
}

/** Every job, newest first; a damaged record is no job. A failed directory query or a locked job is not a shorter list: it throws. */
export function listJobs(home) {
  let names;
  try { names = fs.readdirSync(jobsRoot(home)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return names.map((name) => loadJob(home, name)).filter(Boolean)
    .sort((a, b) => String(b.admittedAt ?? b.spawnedAt).localeCompare(String(a.admittedAt ?? a.spawnedAt)));
}

/**
 * A7.7, from codex-plugin-cc: finished jobs beyond the newest KEEP_FINISHED are deleted whole; a job
 * that is running, lost, needs cleanup or holds a thread claim is never deleted. One rename takes a
 * job out of jobs/, so a listing never sees part of one. Thread records are never pruned.
 */
export function prune(home, keep = KEEP_FINISHED) {
  let finished = [];
  // Pruning never fails a new turn: with a job unreadable now, a later turn prunes instead.
  try { finished = listJobs(home).filter((j) => (j.done || j.stopped) && !cleanupNeeded(j)); }
  catch { /* Next turn. */ }
  const trash = path.join(home, "trash");
  for (const job of finished.slice(keep)) {
    try {
      if (claimHeld(home, job)) continue;
      fs.mkdirSync(trash, { recursive: true });
      fs.renameSync(job.dir, path.join(trash, `${job.id}-${randomBytes(4).toString("hex")}`));
    } catch { /* Its claims could not be read, another companion took it, or the rename failed: a later turn tries again. */ }
  }
  let left;
  try { left = fs.readdirSync(trash); } catch { return; }
  for (const name of left) {
    try { fs.rmSync(path.join(trash, name), { recursive: true, force: true }); } catch { /* Next turn. */ }
  }
}

export function stateOf(job) {
  if (job.done) return job.status;
  if (job.stopped) return job.cancelRequested ? "cancelled" : "failed";
  return Date.now() - job.beatMs < BEAT_STALE_MS ? "running" : "lost";
}

/** A finalized failure can still own execution. Recovery, not age, removes that obstruction. */
export function cleanupNeeded(job) {
  return !job.stopped && (!job.done || Boolean(job.cleanupPending) || /may still be running/.test(job.error ?? ""));
}

/** A7.2: implicit selections (reply --last, bare wait, bare cancel) need the same cwd and the same session. */
export function candidates(home, { cwd, session }) {
  return listJobs(home).filter((job) => job.cwd === cwd && (job.session ?? null) === (session ?? null));
}

/** A7.3: thread identity is provider-namespaced. */
export function onThread(job, provider, ref) {
  return job.provider === provider && typeof ref === "string" && [job.threadId, job.requestedThreadId, ...(job.threadIds ?? [])]
    .some((id) => typeof id === "string" && id.toLowerCase() === ref.toLowerCase());
}

/** A rejected/unadmitted attempt must not change reply inheritance or round counts. */
export function latestOnThread(home, provider, threadId, excludeId = null) {
  return listJobs(home).find((job) => job.id !== excludeId && job.admitted !== false && onThread(job, provider, threadId)) ?? null;
}

/** A named job id resolves across sessions and providers; a thread id needs its provider. */
export function findJob(home, ref, provider = null) {
  return loadJob(home, ref) ?? (provider ? latestOnThread(home, provider, ref) : null);
}

/** Legacy unfinished records also block; new thread claims handle atomic admission. */
export function blockingJob(home, provider, threadId, excludeId = null) {
  return listJobs(home).find((job) => job.id !== excludeId && job.admitted !== false && onThread(job, provider, threadId) && cleanupNeeded(job)) ?? null;
}

/** Render recovered failure without changing the original metadata or an already-finalized result. */
export function resultRecord(job) {
  if (job.done) return job;
  return {
    ...job, outcome: job.stopped && job.cancelRequested ? "cancelled" : "failed", code: 1,
    endedAt: job.stoppedAt ?? null,
    error: job.stopped ? "recovered after the companion stopped" : "companion lost; run cancel before resuming",
    cleanupPending: !job.stopped,
  };
}

/** Generic event label for `wait`: the stream's `type` (codex, grok) or `event` (agy) discriminator. */
export function describeEvent(ev) {
  if (!ev || typeof ev !== "object") return null;
  if (typeof ev.type === "string") return ev.item?.type ? `${ev.type}:${ev.item.type}` : ev.type;
  if (typeof ev.event === "string") return ev.step_update?.step_type ? `${ev.event}:${ev.step_update.step_type}` : ev.event;
  return null;
}

/** Read only the tail; unfinished JSON and non-JSON diagnostics are ignored. */
export function lastEvent(job) {
  try {
    const fd = fs.openSync(path.join(job.dir, "events.jsonl"), "r");
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, 8192);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      for (const text of buffer.toString("utf8").split("\n").reverse()) {
        try {
          const label = describeEvent(JSON.parse(text));
          if (label) return label;
        } catch { /* A partial or diagnostic line. */ }
      }
    } finally { fs.closeSync(fd); }
  } catch { /* No event stream yet. */ }
  return null;
}

// --- thread records (A7.6) -------------------------------------------------------------------------

/** threads/<provider>-<threadId>.json: provider, native thread id, cwd, model, effort, tier, round, rounds, agent. Never pruned. */
export function loadThread(home, provider, threadId) {
  if (!threadId || !THREAD.test(threadId)) return null; // Not a native id, so never a path to read.
  // A record that cannot be read now is not a missing one: a caller's fallback to the job would lose its refusal.
  try { return readRecord(threadFile(home, provider, threadId)); }
  catch (error) { throw new Error(MESSAGES.threadUnreadable(threadId, error.code ?? error.message)); }
}

export function saveThread(home, record) {
  if (!record.provider || !record.threadId) throw new Error("a thread record needs provider and threadId");
  const file = threadFile(home, record.provider, record.threadId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = readJson(file) ?? {};
  const merged = { ...existing, ...record, updatedAt: new Date().toISOString() };
  writeFileAtomic(file, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}
