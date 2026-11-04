// S4.3: grok parseEvent through the core reader — catalogue guard (fail closed before any text),
// MCP and forbidden calls, edit paths, text separation, session confirmation, stop reason, cost,
// usage, structured output, max_turns_reached; replayed recorded streams.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import grok, { FORBIDDEN } from "../plugins/council/scripts/lib/providers/grok.mjs";
import { createReader } from "../plugins/council/scripts/lib/core/reader.mjs";

const SID = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const READ = { readOnly: true, forbidden: FORBIDDEN, threadId: SID };
const WRITE = { readOnly: false, forbidden: [], threadId: SID };
const line = (o) => JSON.stringify(o) + "\n";
const catalogue = (tools = ["read_file", "list_dir", "grep"]) => ({ type: "available_commands", tools, commands: ["compact"] });
const end = (extra = {}) => ({ type: "end", stopReason: "end_turn", sessionId: SID, usage: { total_tokens: 7 }, total_cost_usd: 0.01125, ...extra });

function read(events, turn = READ, cwd = "/w") {
  const text = [], threads = [];
  const r = createReader({ adapter: grok, cwd, turn, onText: (t) => text.push(t), onThread: (id) => threads.push(id) });
  for (const e of events) r.feed(typeof e === "string" ? e : line(e));
  r.end();
  return { state: r.state, text: text.join(""), threads };
}
const stream = (name) => readFileSync(new URL(`./fixtures/streams/grok/${name}`, import.meta.url), "utf8").replaceAll("6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f", SID);

test("explicit failed-tool denial survives a normal end_turn", () => {
  const { state } = read([{ type: "tool_call", toolName: "write", toolCallId: "denied" },
    { type: "tool_call_update", toolCallId: "denied", status: "failed",
      content: [{ type: "text", text: "write is not available to this agent" }] }, end()]);
  assert.equal(state.completed, true);
  assert.equal(state.failed, null);
  assert.match(state.denied, /not available/);
  assert.equal(state.deniedAction, "write");
});

test("the recorded minimal and resume streams finish ok, confirm the session, carry cost and usage", () => {
  for (const name of ["minimal.jsonl", "resume.jsonl", "effort-xhigh.jsonl"]) {
    const raw = stream(name);
    const sid = JSON.parse(raw.trim().split("\n").at(-1)).sessionId;
    const { state, text, threads } = read([raw], { ...READ, threadId: sid });
    assert.equal(state.failed, null, `${name}: ${state.failed}`);
    assert.equal(state.completed, true);
    assert.deepEqual(threads, [sid]);
    assert.match(text, /pong/i);
    assert.equal(typeof state.costUsd, "number");
    assert.ok(state.usage.total_tokens > 0);
  }
});

test("the recorded json-schema stream yields the structured review", () => {
  const raw = stream("json-schema.jsonl");
  const sid = JSON.parse(raw.trim().split("\n").at(-1)).sessionId;
  const { state } = read([raw], { ...READ, threadId: sid });
  assert.equal(state.completed, true);
  assert.ok(["approve", "needs-attention"].includes(state.structured.verdict));
});

test("the recorded effort-max stream: the error message, no completion", () => {
  const { state } = read([stream("effort-max.jsonl")]);
  assert.equal(state.completed, false);
  assert.match(state.error, /unknown effort level 'max'/);
});

test("all native tools may be advertised on advice turns", () => {
  for (const tool of ["write", "search_replace", "run_terminal_command", "spawn_subagent", "search_tool", "use_tool"]) {
    const { state, text } = read([catalogue(["read_file", tool]), { type: "text", data: "answer" }, end()]);
    assert.equal(state.failed, null);
    assert.equal(text, "answer");
    assert.equal(state.completed, true);
  }
});

test("read-only: the guard tolerates repeated catalogues, fails a later malformed one", () => {
  const ok = read([catalogue(), catalogue(), { type: "text", data: "pong" }, catalogue(), end()]);
  assert.equal(ok.state.failed, null);
  assert.equal(ok.text, "pong");
  assert.match(read([catalogue(), { type: "available_commands", tools: "read_file" }]).state.failed, /malformed tool catalogue$/);
  assert.match(read([catalogue([""])]).state.failed, /malformed tool catalogue entry/);
  assert.equal(read([{ type: "available_commands", commands: ["x"] }, catalogue(), end()]).state.failed, null, "an event without tools leaves validation pending");
});

test("native tools and completion do not require a prior catalogue", () => {
  assert.equal(read([{ type: "tool_call", toolCallId: "1", toolName: "read_file" }]).state.failed, null);
  assert.equal(read([{ type: "text", data: "hi" }, end()]).state.failed, null);
});

test("MCP and built-in calls are recorded without plugin denial", () => {
  for (const toolName of ["write", "github__read_issue", "grep"]) {
    const { state } = read([catalogue(), { type: "tool_call", toolCallId: "1", toolName }, { type: "tool_call_update", toolCallId: "1", status: "completed" }, end()]);
    assert.equal(state.failed, null);
    assert.equal(state.lastTool, toolName);
  }
});

test("a task turn: write tools allowed, completed edits recorded relative to cwd from every path carrier", () => {
  const events = [
    catalogue(["read_file", "write", "search_replace", "run_terminal_command"]),
    { type: "text", data: "Editing." },
    { type: "tool_call", toolCallId: "a", toolName: "write", rawInput: { file_path: "/w/src/a.js" } },
    { type: "tool_call_update", toolCallId: "a", status: "completed" },
    { type: "tool_call", toolCallId: "b", toolName: "search_replace", rawInput: {} },
    { type: "tool_call_update", toolCallId: "b", status: null, locations: [{ path: "/w/src/b.js" }] },
    { type: "tool_call_update", toolCallId: "b", status: "completed" },
    { type: "tool_call", toolCallId: "c", toolName: "search_replace", input: {} },
    { type: "tool_call_update", toolCallId: "c", status: "completed", rawOutput: { EditsApplied: { absolute_path: "/w/c.js" } } },
    { type: "tool_call", toolCallId: "d", toolName: "search_replace" },
    { type: "tool_call_update", toolCallId: "d", status: "in_progress", content: [{ type: "diff", path: "/w/d.js" }] },
    { type: "tool_call_update", toolCallId: "d", status: "failed" },
    { type: "tool_call", toolCallId: "e", toolName: "run_terminal_command", rawInput: { command: "ls" } },
    { type: "tool_call_update", toolCallId: "e", status: "completed" },
    { type: "text", data: "Done." },
    end(),
  ];
  const { state, text } = read(events, WRITE);
  assert.equal(state.failed, null);
  assert.deepEqual([...state.edited].sort(), ["c.js", "src/a.js", "src/b.js"], "a failed edit and a terminal command are not edits");
  assert.equal(text, "Editing.\n\nDone.", "text before and after a tool call are separate messages");
});

test("session confirmation on the end event (review Q4)", () => {
  // missing id: the answer stands, completed, no thread confirmed, the core's unconfirmed hint
  for (const missing of [undefined, null, ""]) {
    const r = read([catalogue(), { type: "text", data: "pong" }, end({ sessionId: missing })]);
    assert.equal(r.state.failed, null);
    assert.deepEqual([r.state.completed, r.text, r.threads.length, r.state.unconfirmed], [true, "pong", 0, "session not confirmed: start a new ask"]);
    assert.equal(r.state.costUsd, 0.01125, "cost and usage are kept");
  }
  // another or a malformed id: fatal
  assert.match(read([catalogue(), end({ sessionId: "11111111-2222-4333-8444-555555555555" })]).state.failed, /answered on session "11111111-2222-4333-8444-555555555555", expected 6f1c/);
  assert.match(read([catalogue(), end({ sessionId: 7 })]).state.failed, /answered on session 7/);
  const ok = read([catalogue(), end({ sessionId: SID.toUpperCase() })]);
  assert.deepEqual([ok.state.failed, ok.state.unconfirmed], [null, null], "case-insensitive");
  const snake = read([catalogue(), { type: "end", stop_reason: "end_turn", session_id: SID, structured_output: { verdict: "approve" } }]);
  assert.equal(snake.state.completed, true);
  assert.deepEqual(snake.state.structured, { verdict: "approve" });
  // a missing id keeps the structured review too
  const review = read([catalogue(), end({ sessionId: undefined, structuredOutput: { verdict: "approve" } })]);
  assert.deepEqual(review.state.structured, { verdict: "approve" });
  // without an end event the turn never completes, and no session is confirmed
  const cut = read([catalogue(), { type: "text", data: "partial" }]);
  assert.deepEqual([cut.state.completed, cut.threads.length], [false, 0]);
});

test("Grok's own cancelled stop is a denial (S4.9): completed, confirmed, denied; the refusal is the answer when no text came", () => {
  const refusal = "Grok cancelled the turn (a tool needed permission headless Grok cannot ask for)";
  const cancelled = read([catalogue(), { type: "text", data: "half" }, end({ stopReason: "cancelled" })]);
  assert.deepEqual([cancelled.state.failed, cancelled.state.incomplete, cancelled.state.completed], [null, null, true]);
  assert.equal(cancelled.text, "half", "text already sent stays the answer");
  assert.deepEqual(cancelled.threads, [SID], "the session is still confirmed");
  assert.equal(cancelled.state.denied, refusal);
  const silent = read([catalogue(), end({ stopReason: "cancelled", structuredOutput: { verdict: "approve" } })]);
  assert.deepEqual([silent.state.failed, silent.state.incomplete, silent.state.denied], [null, null, refusal]);
  assert.equal(silent.text, refusal, "no text: the refusal sentence is the answer, so the empty-answer rule cannot fail it");
  assert.deepEqual(silent.state.structured, { verdict: "approve" });
});

test("stop reasons other than end_turn, cancelled and max_turns_reached keep the answer and are incomplete; error events are kept", () => {
  assert.equal(read([catalogue(), end({ stopReason: "max_tokens" })]).state.incomplete, 'incomplete: Grok stopped with reason "max_tokens"');
  assert.match(read([catalogue(), end({ stopReason: undefined })]).state.incomplete, /Grok stopped with reason null/);
  const turns = read([catalogue(), { type: "text", data: "partial" }, { type: "max_turns_reached" }, end({ structuredOutput: { verdict: "approve" } })]);
  assert.deepEqual([turns.state.failed, turns.text, turns.state.completed], [null, "partial", true]);
  assert.equal(turns.state.incomplete, "incomplete: Grok stopped: max turns reached");
  assert.deepEqual(turns.state.structured, { verdict: "approve" }, "structured output is not discarded");
  const err = read([{ type: "error", message: "x".repeat(3000) }]);
  assert.equal(err.state.error.length, 2000);
  assert.equal(read([{ type: "error" }]).state.error, "Grok reported an error");
});

test("a fatal latches: a later normal end never clears it", () => {
  const { state } = read([{ type: "available_commands", tools: "malformed" }, catalogue(), end()]);
  assert.match(state.failed, /malformed tool catalogue/);
  assert.equal(state.completed, false);
});

test("unseeded parsing accepts native tools", () => {
  assert.equal(read([catalogue(["write"])], null).state.failed, null);
});

test("non-JSON and untyped lines carry nothing; thought and usage count as activity", () => {
  assert.equal(grok.parseEvent("not json", {}), null);
  assert.equal(grok.parseEvent("{}", {}), null);
  assert.deepEqual(grok.parseEvent(line({ type: "thought", data: "hm" }), { turn: READ }), {});
  assert.deepEqual(grok.parseEvent(line({ type: "usage", usage: {} }), { turn: READ }), {});
  assert.deepEqual(grok.parseEvent(line({ type: "text", data: "" }), { turn: READ }), {});
});

test("two turns read concurrently keep separate bookkeeping", () => {
  const a = createReader({ adapter: grok, cwd: "/w", turn: READ });
  const b = createReader({ adapter: grok, cwd: "/w", turn: WRITE });
  a.feed(line(catalogue()));
  b.feed(line(catalogue(["write"])));
  b.feed(line({ type: "tool_call", toolCallId: "1", toolName: "write", rawInput: { file_path: "/w/x" } }));
  a.feed(line(end()));
  b.feed(line({ type: "tool_call_update", toolCallId: "1", status: "completed" }));
  b.feed(line(end()));
  assert.equal(a.state.failed, null);
  assert.equal(b.state.failed, null);
  assert.deepEqual([...a.state.edited], []);
  assert.deepEqual([...b.state.edited], ["x"]);
});
