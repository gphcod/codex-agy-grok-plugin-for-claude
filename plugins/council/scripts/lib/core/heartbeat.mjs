// Extracted from grok-build-plugin-cc 1.1.5 lib/jobs.mjs (touchBeat) and lib/lifecycle.mjs (BEAT_MS,
// the in-turn refresh), timing unchanged. A heartbeat is evidence of recent progress, not proof of
// process identity or death.
import fs from "node:fs";
import path from "node:path";

/** Refresh interval during a turn, and the age after which an unfinished job reads as lost. */
export const BEAT_MS = 10000;
export const BEAT_STALE_MS = 30000;

export const beatFile = (dir) => path.join(dir, "beat");

/** Creates or touches the heartbeat; throws when the job directory cannot be written. */
export function touchBeat(job, io = fs) {
  const file = beatFile(job.dir);
  const now = new Date();
  try {
    io.utimesSync(file, now, now);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    io.writeFileSync(file, "");
  }
}

/**
 * The refresh used around blocking process queries and before finalization: a failed refresh here
 * changes no outcome (the in-turn interval reports storage failure), so it is swallowed.
 */
export function refreshBeat(job, io = fs) {
  try { touchBeat(job, io); return true; } catch { return false; }
}

/** Heartbeat mtime in ms, or 0 when there is none. */
export function beatMs(dir, io = fs) {
  try { return io.statSync(beatFile(dir)).mtimeMs; }
  catch (error) { if (error.code === "ENOENT") return 0; throw error; }
}

/** Periodic refresher for a running turn: calls `onFailure(error)` once when storage fails. */
export function startBeat(job, { io = fs, intervalMs = BEAT_MS, onFailure = null, now = Date.now } = {}) {
  let last = now();
  let failed = false;
  const tick = () => {
    if (failed || now() - last < intervalMs) return;
    try { touchBeat(job, io); last = now(); }
    catch (error) { failed = true; onFailure?.(error); }
  };
  return { tick, get lastBeatAt() { return last; } };
}
