// Ported unchanged from grok-build-plugin-cc 1.1.5 lib/fs.mjs (commit 9c66028).
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BUSY = ["EPERM", "EBUSY", "EACCES"];

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

/** The real path of `p` (8.3 short names and junctions resolved), or its absolute form. */
export function canonical(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}
