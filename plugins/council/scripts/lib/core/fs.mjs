// Ported unchanged from grok-build-plugin-cc 1.1.5 lib/fs.mjs (commit 9c66028).
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const BUSY = ["EPERM", "EBUSY", "EACCES"];
/** How long a read or a release waits out a Windows lock before it reports one. */
export const LOCK_WAIT_MS = 2000;

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `action()`, tried again while it fails with one of `codes`, for up to LOCK_WAIT_MS. */
export function retryLocked(action, codes = BUSY) {
  for (const deadline = Date.now() + LOCK_WAIT_MS; ; sleepSync(10 + Math.floor(Math.random() * 20))) {
    try { return action(); }
    catch (error) {
      if (!codes.includes(error?.code) || Date.now() >= deadline) throw error;
    }
  }
}

/**
 * Temp file plus rename: a concurrent reader sees the old file or the new one, never half of one.
 * On Windows a rename fails while another process (a reader, often antivirus) holds the target
 * open. A loaded Windows CI runner kept that up for over a second, so the retries run for five.
 */
export function writeFileAtomic(file, content) {
  const temp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(temp, content, "utf8");
  for (const deadline = Date.now() + 5000; ; ) {
    try {
      return fs.renameSync(temp, file);
    } catch (error) {
      if (!BUSY.includes(error?.code) || Date.now() >= deadline) {
        fs.rmSync(temp, { force: true });
        throw error;
      }
      sleepSync(10 + Math.floor(Math.random() * 20));
    }
  }
}

/** Parsed JSON, or null when the file is missing or unreadable; Windows' short read locks are retried. */
export function readJson(file) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT" || attempt >= 4) {
        return null;
      }
      sleepSync(10);
    }
  }
}

/**
 * A record whose absence decides something. Null when it is missing or its JSON is damaged (writes
 * are atomic, so no retry repairs that). A lock that outlasts the wait, or any other read failure,
 * throws: a record that cannot be read now is not a record that does not exist.
 */
export function readRecord(file) {
  let text;
  try { text = retryLocked(() => fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try { return JSON.parse(text); } catch { return null; }
}

/** The real path of `p` (8.3 short names and junctions resolved), or its absolute form. */
export function canonical(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}
