// S2.4: reader.mjs — line framing, maxLineBytes before parseEvent, the latched fatal, thread claims.
import { test } from "node:test";
import assert from "node:assert/strict";
import nullAdapter from "./fixtures/null-adapter.mjs";
import { LINE_CAP, createReader } from "../plugins/council/scripts/lib/core/reader.mjs";

const ev = (o) => JSON.stringify(o) + "\n";

test("defaults and construction", () => {
  assert.equal(LINE_CAP, 1024 * 1024);
  assert.throws(() => createReader({}), /needs an adapter with parseEvent/);
  const r = createReader({ adapter: nullAdapter });
  assert.equal(r.state.threadId, null);
  assert.equal(r.state.completed, false);
  assert.equal(r.broken, false);
});

test("maxLineBytes exceeded fails closed before parseEvent sees the line", () => {
  let parsed = 0;
  const adapter = { maxLineBytes: 100, parseEvent(line, state) { parsed += 1; return nullAdapter.parseEvent(line, state); } };
  const failures = [];
  const r = createReader({ adapter, onFailure: (m) => failures.push(m) });
  r.feed(ev({ type: "started", thread: "t1" }));
  assert.equal(parsed, 1);
  r.feed(ev({ type: "text", data: "x".repeat(200) }));
  assert.equal(parsed, 1, "the oversized line never reached parseEvent");
  assert.match(r.state.failed, /JSONL line over 100 bytes/);
  assert.deepEqual(failures, [r.state.failed]);
  assert.equal(r.broken, true);
  r.feed(ev({ type: "done" }));
  assert.equal(parsed, 1, "nothing is parsed after the failure");
  assert.equal(r.state.completed, false);
  // a long line arriving in pieces is still measured as one line
  const r2 = createReader({ adapter });
  for (let i = 0; i < 30; i++) r2.feed("x".repeat(10));
  assert.match(r2.state.failed, /over 100 bytes/);
});

test("fragmented frames reassemble; a trailing partial line is flushed by end()", () => {
  const texts = [];
  const r = createReader({ adapter: nullAdapter, onText: (t) => texts.push(t) });
  const stream = ev({ type: "started", thread: "t-9" }) + ev({ type: "text", data: "pong " }) + ev({ type: "text", data: "again" }) + JSON.stringify({ type: "done", usage: { input: 1 } });
  let fed = 0;
  for (let i = 0; i < stream.length; i += 5) fed += r.feed(Buffer.from(stream.slice(i, i + 5)));
  assert.equal(fed, 3, "three complete lines counted while feeding");
  assert.equal(r.state.completed, false, "the last line has no newline yet");
  r.end();
  assert.equal(r.state.completed, true);
  assert.equal(r.state.threadId, "t-9");
  assert.deepEqual(texts, ["pong ", "again"]);
  assert.deepEqual(r.state.usage, { input: 1 });
  assert.equal(r.state.lastEvent, "done");
  assert.equal(r.state.events, 4);
  // multi-byte characters split across chunks survive the decoder
  const r3 = createReader({ adapter: nullAdapter, onText: (t) => texts.push(t) });
  const line = Buffer.from(ev({ type: "text", data: "héllo wörld" }));
  r3.feed(line.subarray(0, 12)); r3.feed(line.subarray(12));
  assert.equal(texts.at(-1), "héllo wörld");
});

test("the first fatal latches: a later success event cannot clear it", () => {
  const r = createReader({ adapter: nullAdapter });
  r.feed(ev({ type: "started", thread: "t" }));
  r.feed(ev({ type: "error", message: "simulated fatal" }));
  r.feed(ev({ type: "text", data: "pong" }));
  r.feed(ev({ type: "done" }));
  r.end();
  assert.equal(r.state.failed, "simulated fatal");
  assert.equal(r.state.completed, false);
  assert.equal(r.state.hasText, false);
});

test("non-JSON and unknown lines are ignored, not fatal", () => {
  const r = createReader({ adapter: nullAdapter });
  assert.equal(r.feed("plain diagnostics\n"), 0);
  assert.equal(r.feed(ev({ type: "mystery" })), 0);
  assert.equal(r.feed(ev({ type: "done" })), 1);
  assert.equal(r.state.failed, null);
  assert.equal(r.state.completed, true);
});

test("thread ids: claimed through onThread before publication; invalid or changing ids fail", () => {
  const order = [];
  const r = createReader({ adapter: nullAdapter, onThread: (id) => { order.push(`claim:${id}`); assert.equal(r.state.threadId, null, "not yet published"); } });
  r.feed(ev({ type: "started", thread: "abc-123" }));
  order.push(`state:${r.state.threadId}`);
  assert.deepEqual(order, ["claim:abc-123", "state:abc-123"]);
  r.feed(ev({ type: "started", thread: "ABC-123" }));
  assert.equal(r.state.failed, null, "the same id again (case-insensitive) is fine");
  r.feed(ev({ type: "started", thread: "other" }));
  assert.match(r.state.failed, /thread id changed during the turn/);
  const bad = createReader({ adapter: nullAdapter });
  bad.feed(ev({ type: "started", thread: "../x" }));
  assert.match(bad.state.failed, /invalid thread id/);
  const throwing = createReader({ adapter: nullAdapter, onThread: () => { throw new Error("thread busy as job x"); } });
  throwing.feed(ev({ type: "started", thread: "t" }));
  assert.equal(throwing.state.failed, "thread busy as job x");
  assert.equal(throwing.state.threadId, null, "a failed claim never publishes the id");
});

test("denied, incomplete, structured, edited, failedCommand, cost and usage are merged into state", () => {
  const adapter = { maxLineBytes: 4096, parseEvent(line) { return JSON.parse(line); } };
  const r = createReader({ adapter, cwd: "/repo" });
  r.feed(ev({ denied: "write refused" }));
  r.feed(ev({ denied: "second denial" }));
  r.feed(ev({ incomplete: "print timeout" }));
  r.feed(ev({ structured: { verdict: "approve" } }));
  r.feed(ev({ edited: ["/repo/a.js", "b.js", "/elsewhere/c.js"] }));
  r.feed(ev({ edited: "/repo/sub/d.js" }));
  r.feed(ev({ failedCommand: { cmd: "npm test", exit: 1 } }));
  r.feed(ev({ costUsd: 0.01 }));
  r.feed(ev({ costUsd: 0.02, usage: { in: 1 } }));
  r.feed(ev({ toolStep: "read_file" }));
  r.feed(ev({ error: "soft error" }));
  r.feed(ev({ completed: true }));
  assert.equal(r.state.denied, "write refused", "first denial kept");
  assert.equal(r.state.incomplete, "print timeout");
  assert.deepEqual(r.state.structured, { verdict: "approve" });
  assert.deepEqual([...r.state.edited], ["a.js", "b.js", "/elsewhere/c.js", "sub/d.js"]);
  assert.deepEqual(r.state.failedCommands, [{ cmd: "npm test", exit: 1 }]);
  assert.equal(r.state.failedCommandCount, 1);
  assert.ok(Math.abs(r.state.costUsd - 0.03) < 1e-9);
  assert.deepEqual(r.state.usage, { in: 1 });
  assert.equal(r.state.lastTool, "read_file");
  assert.equal(r.state.error, "soft error");
  assert.equal(r.state.completed, true);
  assert.equal(r.state.failed, null);
  const boolean = createReader({ adapter });
  boolean.feed(ev({ denied: true, incomplete: true, fatal: false }));
  assert.equal(boolean.state.denied, "the provider denied an action");
  assert.equal(boolean.state.incomplete, "the turn ended incomplete");
  assert.equal(boolean.state.failed, null, "fatal:false is not fatal");
  const fatalTrue = createReader({ adapter });
  fatalTrue.feed(ev({ fatal: true }));
  assert.equal(fatalTrue.state.failed, "provider reported a fatal error");
});

test("onEvent receives the parsed shape and the raw object; a throwing parseEvent is a failure", () => {
  const seen = [];
  const r = createReader({ adapter: nullAdapter, onEvent: (e, raw) => seen.push([e, raw]) });
  r.feed(ev({ type: "text", data: "hi" }));
  assert.deepEqual(seen, [[{ textDelta: "hi" }, { type: "text", data: "hi" }]]);
  const throwing = createReader({ adapter: { parseEvent() { throw new Error("parser bug"); } } });
  throwing.feed("{}\n");
  assert.equal(throwing.state.failed, "parser bug");
});
