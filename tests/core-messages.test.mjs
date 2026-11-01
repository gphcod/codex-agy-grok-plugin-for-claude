// X3 (S7.1 fixes): the footer clips `error:` and `attention:` at 200 B. Every message that can exceed
// that, built here with the longest ids the code accepts, keeps what to do; with real id lengths the
// whole message fits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MESSAGES, deniedReason, oneLine } from "../plugins/council/scripts/lib/core/output.mjs";
import { UNCONFIRMED, PERMISSION_STOP } from "../plugins/council/scripts/lib/providers/grok.mjs";
import { NO_FINDINGS } from "../plugins/council/scripts/lib/providers/codex.mjs";

const bytes = (s) => Buffer.byteLength(s, "utf8");
const THREAD_MAX = "t".repeat(128), REQUEST_MAX = `request id ${"r".repeat(128)}`, JOB = "j".repeat(16);
const THREAD = "019f2c3e-7a1b-7c3d-9e8f-0123456789ab", REQUEST = "request id k7Qm2xP9";

/** [name, builder with (thread | request name, job), what must survive clipping]. */
const CASES = [
  ["threadBusy", (t, _r, j) => MESSAGES.threadBusy(t, j), `wait or cancel ${JOB}`],
  ["threadBusyUnidentified", (t) => MESSAGES.threadBusyUnidentified(t), "quiesce this state root"],
  ["threadLocked", (t, _r, j) => MESSAGES.threadLocked(t, j), "continue with a new ask"],
  ["threadCleanup", (t, _r, j) => MESSAGES.threadCleanup(t, j), `run cancel ${JOB}`],
  ["cleanupPending", () => MESSAGES.cleanupPending("gemini", "x".repeat(600)), "cleanup pending: gemini or a descendant may still be running"],
  ["requestGone", (_t, r) => MESSAGES.requestGone(r), "a new request id is safe"],
  ["requestUnchosen", (_t, r) => MESSAGES.requestUnchosen(r), "retry with the same request id to keep waiting"],
  ["requestFreed", (_t, r) => MESSAGES.requestFreed(r), "retry with the same id to run it"],
  ["requestNeverRan", (_t, r, j) => MESSAGES.requestNeverRan(r, j), "a new request id is safe"],
  ["requestMissing", (_t, r, j) => MESSAGES.requestMissing(r, j), "use a new request id"],
];

test("every message is covered, and its action survives the footer's clip at the longest ids", () => {
  assert.deepEqual(CASES.map(([name]) => name).sort(), Object.keys(MESSAGES).sort(), "a new message needs a case here");
  for (const [name, build, action] of CASES) {
    const clipped = oneLine(build(THREAD_MAX, REQUEST_MAX, JOB));
    assert.ok(bytes(clipped) <= 200, name);
    assert.ok(clipped.includes(action), `${name} lost "${action}": ${clipped}`);
  }
});

test("with real id lengths every message fits whole, except a cleanup reason of any length", () => {
  for (const [name, build] of CASES) {
    if (name === "cleanupPending") continue;
    const message = build(THREAD, REQUEST, JOB);
    assert.ok(bytes(message) <= 200, `${name} is ${bytes(message)} B: ${message}`);
  }
  assert.ok(bytes(MESSAGES.cleanupPending("gemini", "wall-clock deadline passed")) <= 200);
});

test("constant messages and the reasons built from them fit", () => {
  for (const message of [UNCONFIRMED, PERMISSION_STOP, NO_FINDINGS, "open questions in the answer",
    "agy hit its print timeout before the turn finished; the response is partial. Retry with a larger --deadline or a narrower request"]) assert.ok(bytes(message) <= 200, message);
  assert.match(deniedReason("x".repeat(600), 5), / \(\+4 more\)$/, "the count survives");
});
