// Ported from grok-build-plugin-cc 1.1.5 lib/reader.mjs (commit 9c66028), made generic (PLAN.md S2
// table): line splitting, the adapter's maxLineBytes enforced before parseEvent, each line handed to
// adapter.parseEvent, the first fatal latched so a later success event cannot clear it. The Grok
// FORBIDDEN tool check moved to the grok adapter (S4.3).
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { THREAD } from "./claims.mjs";
import { describeEvent } from "./jobs.mjs";

export const LINE_CAP = 1024 * 1024;
const PATH_CAP = 10000;
const FAILED_DETAILS_CAP = 100;

/**
 * Chunk-bounded JSONL reader for one turn. `adapter.parseEvent(line, state)` returns the A5 event
 * shape ({threadId?, textDelta?, toolStep?, completed?, fatal?, denied?, incomplete?, structured?,
 * edited?, failedCommand?, costUsd?, usage?}) or null. `onThread(id)` runs before the id is
 * published so the caller can claim it; a throw there fails the turn. `turn` is the adapter's own
 * buildTurn result, exposed read-only as `state.turn`, so parseEvent can apply per-turn rules (the
 * grok adapter's read-only tool guard needs the turn's mode) without module-level state.
 */
export function createReader({ adapter, cwd = process.cwd(), turn = null, onThread, onText, onEvent, onFailure, maxLineBytes = adapter?.maxLineBytes ?? LINE_CAP } = {}) {
  if (!adapter || typeof adapter.parseEvent !== "function") throw new Error("createReader needs an adapter with parseEvent");
  const state = {
    threadId: null, completed: false, failed: null, error: null, denied: null, incomplete: null, structured: null,
    edited: new Set(), failedCommands: [], failedCommandCount: 0, costUsd: null, usage: null, lastEvent: null, lastTool: null, events: 0, hasText: false,
    unconfirmed: null, turn,
  };
  const decoder = new StringDecoder("utf8");
  let buffer = "", bytes = 0, broken = false;
  const fail = (message) => {
    if (broken) return;
    broken = true;
    state.failed = message;
    buffer = ""; bytes = 0;
    onFailure?.(message);
  };
  const relative = (p) => {
    const rel = path.relative(cwd, path.resolve(cwd, p));
    return (rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : p).replace(/\\/g, "/");
  };

  function line(text) {
    let raw = null;
    try { raw = JSON.parse(text); } catch { /* the adapter decides what a non-JSON line means */ }
    const label = describeEvent(raw);
    if (label) state.lastEvent = label;
    const ev = adapter.parseEvent(text, state);
    if (!ev || typeof ev !== "object") return false;
    state.events += 1;
    if (ev.fatal) { fail(typeof ev.fatal === "string" ? ev.fatal : "provider reported a fatal error"); return true; }
    if (ev.threadId !== undefined && ev.threadId !== null) {
      if (typeof ev.threadId !== "string" || !THREAD.test(ev.threadId)) { fail("invalid thread id in the event stream"); return true; }
      if (state.threadId && state.threadId.toLowerCase() !== ev.threadId.toLowerCase()) { fail(`thread id changed during the turn (${state.threadId} → ${ev.threadId})`); return true; }
      if (!state.threadId) {
        // The callback must establish ownership before the id is accepted or announced.
        onThread?.(ev.threadId);
        state.threadId = ev.threadId;
      }
    }
    if (typeof ev.textDelta === "string" && ev.textDelta) { state.hasText = true; onText?.(ev.textDelta); }
    if (ev.toolStep !== undefined) state.lastTool = ev.toolStep;
    if (ev.completed) state.completed = true;
    if (ev.denied) state.denied ??= typeof ev.denied === "string" ? ev.denied : "the provider denied an action";
    // The turn finished but the provider never confirmed its thread: the answer stands, the thread is not resumable.
    if (ev.unconfirmed) state.unconfirmed ??= typeof ev.unconfirmed === "string" ? ev.unconfirmed : "thread not confirmed: start a new ask";
    if (ev.incomplete) state.incomplete ??= typeof ev.incomplete === "string" ? ev.incomplete : "the turn ended incomplete";
    if (ev.structured !== undefined) state.structured = ev.structured;
    if (ev.error) state.error = String(ev.error).slice(0, 2000);
    if (ev.edited !== undefined) {
      for (const p of Array.isArray(ev.edited) ? ev.edited : [ev.edited]) {
        if (typeof p === "string") state.edited.add(relative(p));
        if (state.edited.size > PATH_CAP) { fail("too many edited paths in event stream"); return true; }
      }
    }
    if (ev.failedCommand !== undefined) {
      state.failedCommandCount += 1;
      if (state.failedCommands.length < FAILED_DETAILS_CAP) state.failedCommands.push(ev.failedCommand);
    }
    if (typeof ev.costUsd === "number") state.costUsd = (state.costUsd ?? 0) + ev.costUsd;
    if (ev.usage) state.usage = ev.usage;
    onEvent?.(ev, raw);
    return true;
  }

  function feedText(text) {
    if (broken) return 0;
    let count = 0, start = 0;
    for (;;) {
      const end = text.indexOf("\n", start);
      const part = text.slice(start, end < 0 ? text.length : end);
      const nextBytes = bytes + Buffer.byteLength(part, "utf8");
      if (nextBytes > maxLineBytes) { fail(`the provider emitted a JSONL line over ${maxLineBytes} bytes`); return count; }
      buffer += part;
      bytes = nextBytes;
      if (end < 0) return count;
      try { count += line(buffer) ? 1 : 0; }
      catch (error) { fail(error.message); return count; }
      buffer = ""; bytes = 0;
      if (broken) return count;
      start = end + 1;
    }
  }

  return {
    state,
    get broken() { return broken; },
    feed(chunk) { return feedText(Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk)); },
    end() {
      feedText(decoder.end());
      if (!broken && buffer.trim()) {
        try { line(buffer); } catch (error) { fail(error.message); }
      }
      buffer = ""; bytes = 0;
    },
  };
}
