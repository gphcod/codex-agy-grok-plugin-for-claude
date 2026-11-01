// Ported from grok-build-plugin-cc 1.1.5 lib/claims.mjs with codex-plugin-cc 2.3.2 lib/claims.mjs
// claimHeld. Change (PLAN.md S2 table, A7.3): claim paths are `claims/<provider>/<threadId>`, so two
// providers reporting the same native thread id never share a claim.
import fs from "node:fs";
import path from "node:path";
import { PROVIDERS } from "./catalog.mjs";
import { MESSAGES } from "./output.mjs";

// Native thread ids are UUIDs or similar tokens the CLIs return; never a path.
export const THREAD = /^[a-zA-Z0-9_-]{1,128}$/;
const TOKEN = /^[a-f0-9]{32}$/;
const JOB_ID = /^[a-z0-9]{1,16}$/;
export class BusyError extends Error {
  constructor(message, job = null) { super(message); this.name = "BusyError"; this.job = job; }
}

const providerDir = (home, provider) => {
  if (typeof provider !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(provider)) throw new Error("invalid provider for a thread claim");
  return path.join(home, "claims", provider);
};

export function claimPath(home, provider, thread) {
  if (!THREAD.test(thread ?? "")) throw new Error(`invalid ${provider} thread id`);
  return path.join(providerDir(home, provider), thread.toLowerCase());
}

function ownerName(job) {
  if (!TOKEN.test(job.ownerToken ?? "")) {
    throw new Error("job has no valid claim owner token; reconcile the old job first");
  }
  return `owner-${job.ownerToken}`;
}

/** Inspect a claim without changing it. Empty/unreadable claims are occupied, never stale. */
export function inspectClaim(home, provider, thread, io = fs) {
  const dir = claimPath(home, provider, thread);
  try {
    const names = io.readdirSync(dir);
    if (names.length !== 1 || !/^owner-[a-f0-9]{32}$/.test(names[0])) {
      return { state: "unknown", dir };
    }
    const job = io.readFileSync(path.join(dir, names[0]), "utf8").trim();
    return JOB_ID.test(job)
      ? { state: "owned", dir, job, token: names[0].slice(6) }
      : { state: "unknown", dir };
  } catch (error) {
    return { state: error.code === "ENOENT" && !io.existsSync(dir) ? "absent" : "unknown", dir };
  }
}

/** Nonblocking admission. Save the initialized job before calling; spawn only after success. */
export function claimThread(home, provider, thread, job, io = fs) {
  const dir = claimPath(home, provider, thread);
  const owner = ownerName(job);
  io.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    io.mkdirSync(dir);
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
    const found = inspectClaim(home, provider, thread, io);
    if (found.state === "owned" && found.token === job.ownerToken && found.job === job.id) {
      return; // the same turn can receive its requested id again
    }
    throw new BusyError(found.job ? MESSAGES.threadBusy(thread, found.job) : MESSAGES.threadBusyUnidentified(thread), found.job ?? null);
  }
  // A failed publication intentionally leaves an empty/unreadable claim. Never reclaim by age.
  try {
    io.writeFileSync(path.join(dir, owner), `${job.id}\n`, { flag: "wx" });
  } catch (error) {
    error.claimLeft = true; // codex-plugin-cc: the caller records the id so the unknown claim is explained.
    throw error;
  }
}

/**
 * Only the successful unlinker may try rmdir, exactly once. A delayed second releaser must not
 * remove a replacement owner's directory. No recursive deletion and no retry after ENOENT.
 */
export function releaseThread(home, provider, thread, job, io = fs) {
  const dir = claimPath(home, provider, thread);
  try {
    io.unlinkSync(path.join(dir, ownerName(job)));
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  try {
    io.rmdirSync(dir);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST") {
      throw error;
    }
  }
  return true;
}

/** Also finds a claim published just before its owner crashed during a metadata write. Scoped to the job's provider. */
export function ownedThreads(home, job, io = fs) {
  if (!job.ownerToken || !job.provider) {
    return [];
  }
  const owner = ownerName(job);
  const dir = providerDir(home, job.provider);
  let names;
  try {
    names = io.readdirSync(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return names.filter((thread) => {
    if (!THREAD.test(thread)) return false;
    try {
      return io.statSync(path.join(dir, thread, owner)).isFile();
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  });
}

/** A job still holds a thread when it owns a claim or one of its threads has an unidentifiable claim. */
export function claimHeld(home, job, io = fs) {
  if (ownedThreads(home, job, io).length) return true;
  // An empty claim after a failed release/publication is unknown, not free.
  return (job.threadIds ?? []).some((id) => job.provider && THREAD.test(id) && inspectClaim(home, job.provider, id, io).state === "unknown");
}

export function releaseClaims(home, job, io = fs) {
  for (const thread of ownedThreads(home, job, io)) {
    releaseThread(home, job.provider, thread, job, io);
  }
}

/** Every provider directory that exists under claims/, for diagnostics. */
export function claimedProviders(home, io = fs) {
  try { return io.readdirSync(path.join(home, "claims")).filter((n) => PROVIDERS.includes(n) || n === "null"); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
