// S2.2: stdin.mjs (idle deadline, readText, control args, splitReply).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { UsageError } from "../plugins/council/scripts/lib/core/args.mjs";
import { readControlArgs, readStdin, readText, splitReply, stdinIdleMs, stdinText } from "../plugins/council/scripts/lib/core/stdin.mjs";

const usage = (fn, re) => assert.rejects(fn, (e) => e instanceof UsageError && (!re || re.test(e.message)));
function ended(text) { const s = new PassThrough(); s.end(text); return s; }
function open(text) { const s = new PassThrough(); if (text) s.write(text); return s; }

test("stdinIdleMs: 10 s default, shortened through COUNCIL_STDIN_DEADLINE_MS", () => {
  assert.equal(stdinIdleMs({}), 10000);
  assert.equal(stdinIdleMs({ COUNCIL_STDIN_DEADLINE_MS: "150" }), 150);
  assert.equal(stdinIdleMs({ COUNCIL_STDIN_DEADLINE_MS: "abc" }), 10000);
  assert.equal(stdinIdleMs({ COUNCIL_STDIN_DEADLINE_MS: "0" }), 10000);
});

test("readStdin: ended input, TTY, open-and-silent (null) and open-after-bytes (usage error)", async () => {
  assert.equal(await readStdin(ended("hello\n"), 100), "hello\n");
  assert.equal(await readStdin({ isTTY: true }, 100), "");
  const started = Date.now();
  assert.equal(await readStdin(open(), 120), null);
  assert.ok(Date.now() - started >= 100, "waited for the idle deadline");
  await usage(() => readStdin(open("partial"), 120), /stdin sent nothing for 0.12 s before its end/);
});

test("stdinText: an open silent pipe is no input with arguments, refused without", async () => {
  assert.equal(await stdinText(["arg"], { stream: open(), idleMs: 60 }), "");
  await usage(() => stdinText([], { stream: open(), idleMs: 60 }), /stdin stayed open for 0.06 s with no input/);
  assert.equal(await stdinText([], { stream: ended("x"), idleMs: 60 }), "x");
});

test("readText: stdin heredoc parses leading options unless argv had --", async () => {
  const r1 = await readText({ to: "codex" }, [], false, { stream: ended("--tier deep What now?\n"), idleMs: 100 });
  assert.deepEqual(r1, { options: { to: "codex", tier: "deep" }, text: "What now?", literal: false });
  const r2 = await readText({}, [], true, { stream: ended("--tier deep literal text\n"), idleMs: 100 });
  assert.deepEqual(r2, { options: {}, text: "--tier deep literal text", literal: true });
  const r3 = await readText({ to: "grok" }, ["hello", "--world"], true, { stream: open(), idleMs: 60 });
  assert.deepEqual(r3, { options: { to: "grok" }, text: "hello --world", literal: true });
  await usage(() => readText({}, ["arg"], true, { stream: ended("also stdin"), idleMs: 60 }), /stdin or as arguments, not both/);
  const crlf = await readText({}, [], false, { stream: ended("text\r\n"), idleMs: 100 });
  assert.equal(crlf.text, "text");
  const literalInText = await readText({}, [], false, { stream: ended("--to codex -- --effort stays\n"), idleMs: 100 });
  assert.deepEqual(literalInText, { options: { to: "codex" }, text: "--effort stays", literal: true });
});

test("readControlArgs: scalar options and ids on stdin or argv, never both", async () => {
  const r1 = await readControlArgs({ json: true }, [], { stream: ended("abc123 --timeout 5\n"), idleMs: 100 });
  assert.deepEqual(r1, { options: { json: true, timeout: "5" }, positionals: ["abc123"] });
  const r2 = await readControlArgs({}, ["job1"], { stream: open(), idleMs: 60 });
  assert.deepEqual(r2, { options: {}, positionals: ["job1"] });
  await usage(() => readControlArgs({}, ["job1"], { stream: ended("job2"), idleMs: 60 }), /on stdin or argv, not both/);
  const r3 = await readControlArgs({}, [], { stream: ended("   \n"), idleMs: 100 });
  assert.deepEqual(r3, { options: {}, positionals: [] });
  await usage(() => readControlArgs({}, [], { stream: ended("--bogus"), idleMs: 100 }), /Unknown option/);
});

test("splitReply: the first word names the thread unless --thread or --last does", () => {
  assert.deepEqual(splitReply("reply", {}, "k3f9abcd12345678 more text", false), { o: { thread: "k3f9abcd12345678" }, text: "more text" });
  assert.deepEqual(splitReply("reply", {}, "k3f9 --effort low more", false), { o: { effort: "low", thread: "k3f9" }, text: "more" });
  assert.deepEqual(splitReply("reply", {}, "k3f9 --effort low more", true), { o: { thread: "k3f9" }, text: "--effort low more" });
  assert.deepEqual(splitReply("reply", { last: true }, "text", false), { o: { last: true }, text: "text" });
  assert.deepEqual(splitReply("reply", { thread: "t" }, "text", false), { o: { thread: "t" }, text: "text" });
  assert.deepEqual(splitReply("ask", {}, "first second", false), { o: {}, text: "first second" });
  assert.throws(() => splitReply("reply", {}, "   ", false), (e) => e instanceof UsageError && /needs a job or thread id/.test(e.message));
});
