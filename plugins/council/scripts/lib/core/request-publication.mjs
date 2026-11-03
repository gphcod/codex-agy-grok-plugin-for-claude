// Immutable request-stage publications avoid replacing a Windows file held open by a reader.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { sleepSync } from "./fs.mjs";

const BUSY = ["EPERM", "EBUSY", "EACCES"];
const TOKEN = /^[a-f0-9]{32}$/;
const STAGES = ["binding", "prepared"];
const KEYS = { binding: ["provider", "job", "boundAt"], prepared: ["state", "preparedAt"] };
const object = value => value && typeof value === "object" && !Array.isArray(value);
const bound = record => Boolean(typeof record?.provider === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(record.provider) && /^[a-z0-9]{1,16}$/.test(record.job ?? ""));
/** Old clients see an unsupported tombstone, never an apparently abandoned/unbound request. */
export function reservationRecord(record) {
  if (!TOKEN.test(record.recordToken ?? "")) throw new Error("request reservation needs a generation token");
  return { requestFormat: 2, recordToken: record.recordToken, fingerprint: record.fingerprint,
    state: "tombstone", provider: "publication-v2", job: "unsupported", data: record };
}
function reservationData(record) {
  if (record.requestFormat === undefined) return record;
  if (record.requestFormat !== 2 || !object(record.data) || record.data.recordToken !== record.recordToken
    || record.data.fingerprint !== record.fingerprint) throw new Error("unsupported or damaged request format; leave it intact");
  return record.data;
}
export function publicationToken(record) {
  if (record.recordToken === undefined) return createHash("sha256").update(JSON.stringify(record)).digest("hex").slice(0, 32);
  if (!TOKEN.test(record.recordToken)) throw new Error("invalid request publication token; leave the record intact");
  return record.recordToken;
}
export const publicationFile = (file, token, stage) => {
  if (!TOKEN.test(token) || ![...STAGES, "owner"].includes(stage)) throw new Error("invalid request publication path");
  return `${file}.${token}.${stage}.json`;
};
/** The generation's unique hard link is the unlink gate for concurrent pre-provider cleanup. */
export function linkReservation(temp, file, record, io = fs) {
  const owner = publicationFile(file, publicationToken(record), "owner");
  io.linkSync(temp, owner);
  try { io.linkSync(temp, file); }
  catch (error) { try { io.rmSync(owner, { force: true }); } catch {} throw error; }
}
/** POSIX persists the linked name as well as the flushed file. Windows cannot fsync a directory this way. */
export function syncPublicationDirectory(file, io = fs, platform = process.platform) {
  if (platform === "win32") return;
  const fd = io.openSync(path.dirname(file), "r");
  try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
}
function read(file, io) {
  let text;
  for (const end = Date.now() + 2000; ; sleepSync(20)) {
    try { text = io.readFileSync(file, "utf8"); break; }
    catch (error) {
      if (error.code === "ENOENT") return null;
      if (!BUSY.includes(error.code) || Date.now() >= end) throw error;
    }
  }
  try { const record = JSON.parse(text); if (object(record)) return record; } catch {}
  throw new Error(`unreadable request publication (${file}); leave it intact`);
}
function patchOf(envelope, token, stage) {
  const data = envelope?.data;
  if (envelope?.recordToken !== token || !object(data) || Object.keys(data).some(key => !KEYS[stage].includes(key))
    || (stage === "binding" && (typeof data.provider !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(data.provider) || !/^[a-z0-9]{1,16}$/.test(data.job ?? "")))
    || (stage === "prepared" && (data.state !== "tombstone" || typeof data.preparedAt !== "string"))) {
    throw new Error("invalid request publication; leave the record intact");
  }
  return data;
}
/** Legacy inline records still read; new stages never change the reservation's original bytes. */
export function readPublications(file, record, stages = STAGES, io = fs) {
  if (!record) return null;
  const recordToken = publicationToken(record);
  const result = { ...reservationData(record), recordToken }, patches = {};
  // Observe the terminal stage first: progress between reads cannot produce prepared without its binding.
  for (const stage of [...stages].reverse()) {
    const envelope = read(publicationFile(file, recordToken, stage), io);
    if (envelope) patches[stage] = patchOf(envelope, recordToken, stage);
  }
  for (const stage of stages) Object.assign(result, patches[stage]);
  if ((result.provider != null || result.job != null) && !bound(result)) throw new Error("invalid request provider binding; leave it intact");
  if (result.state === "tombstone" && !bound(result)) {
    throw new Error("prepared request has no provider binding; leave it intact");
  }
  return result;
}
/** A complete private file is linked exclusively to a generation-specific, immutable stage name. */
export function publishRequest(file, record, stage, data, io = fs) {
  if (!STAGES.includes(stage)) throw new Error("invalid request publication stage");
  const recordToken = publicationToken(record);
  if (stage === "prepared" && !bound(reservationData(record))) throw new Error("cannot prepare a request without its provider binding");
  const root = read(file, io);
  if (!root || publicationToken(root) !== recordToken) throw new Error("request reservation changed before publication; nothing started");
  const envelope = { recordToken, data };
  patchOf(envelope, recordToken, stage);
  const target = publicationFile(file, recordToken, stage);
  const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    io.writeFileSync(temp, `${JSON.stringify(envelope)}\n`, { flag: "wx", encoding: "utf8", flush: true });
    try {
      for (const end = Date.now() + 2000; ; sleepSync(20)) {
        try { io.linkSync(temp, target); break; }
        catch (error) { if (!BUSY.includes(error.code) || Date.now() >= end) throw error; }
      }
    }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const prior = patchOf(read(target, io), recordToken, stage);
      if (Object.entries(data).some(([key, value]) => !["boundAt", "preparedAt"].includes(key) && prior[key] !== value)) {
        throw new Error("request publication already names different work; leave it intact");
      }
    }
    syncPublicationDirectory(target, io);
    const latest = read(file, io);
    if (!latest || publicationToken(latest) !== recordToken) throw new Error("request reservation changed during publication; leave it intact");
    if (stage === "prepared" && root.requestFormat === 2 && !io.existsSync(publicationFile(file, recordToken, "owner"))) {
      throw new Error("request cleanup began during preparation; no provider may start");
    }
  } finally {
    try { io.rmSync(temp, { force: true }); } catch { /* A published stage stands; a leftover private name is harmless. */ }
  }
}
/** Called only after the root reservation was removed. A new owner's generation is never removed. */
export function cleanupPublications(file, record, io = fs) {
  if (!record) return;
  const token = publicationToken(record);
  for (const stage of [...STAGES].reverse()) {
    try { io.rmSync(publicationFile(file, token, stage), { force: true }); } catch { /* Unreferenced old generation. */ }
  }
}
/** Only the successful owner-marker unlinker may remove the common root; a loser never deletes a later owner. */
export function releaseReservation(file, expectedToken = null, io = fs) {
  const raw = read(file, io);
  if (!raw) return false;
  const record = readPublications(file, raw, undefined, io), token = publicationToken(record);
  if (expectedToken && token !== expectedToken) throw new Error("request reservation changed; leave it intact");
  if (record.state === "tombstone") return false;
  if (raw.requestFormat !== 2) throw new Error("legacy request cleanup needs explicit reconciliation; leave it intact");
  const owner = publicationFile(file, token, "owner");
  const locked = action => {
    for (const end = Date.now() + 2000; ; sleepSync(20)) {
      try { return action(); } catch (error) { if (!BUSY.includes(error.code) || Date.now() >= end) throw error; }
    }
  };
  try { locked(() => io.unlinkSync(owner)); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error("request cleanup is already in progress or incomplete; leave it intact");
    throw error;
  }
  try {
    const current = read(file, io);
    if (!current || publicationToken(current) !== token) throw new Error("request reservation changed during cleanup; leave it intact");
    // Paired with the publisher's marker check: either side sees preparation or cleanup before work can start.
    if (readPublications(file, current, undefined, io).state === "tombstone") {
      locked(() => io.linkSync(file, owner));
      return false;
    }
    locked(() => io.unlinkSync(file));
  }
  catch (error) {
    // As with thread claims, failed removal restores the ownership marker when the original root is still present.
    try { const current = read(file, io); if (current && publicationToken(current) === token) locked(() => io.linkSync(file, owner)); } catch {}
    throw error;
  }
  cleanupPublications(file, record, io);
  return true;
}
