// S2.2: args.mjs (parseArgv, splitLeading, seconds, roundCount, verb lists).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTROL_VERBS, PROVIDERS, SPEC, TURN_VERBS, UsageError, VERBS, parseArgv, roundCount, seconds, splitLeading } from "../plugins/council/scripts/lib/core/args.mjs";

const usage = (fn, re) => assert.throws(fn, (e) => e instanceof UsageError && (!re || re.test(e.message)));

test("verb lists and option spec follow A3.2 and the S2 mapping table", () => {
  assert.deepEqual(TURN_VERBS, ["ask", "reply", "review", "task"]);
  assert.deepEqual(CONTROL_VERBS, ["wait", "cancel", "models", "setup"]);
  assert.deepEqual(VERBS, [...TURN_VERBS, ...CONTROL_VERBS]);
  assert.deepEqual(PROVIDERS, ["codex", "gemini", "grok"]);
  for (const v of ["to", "commit", "session", "tier", "model", "effort", "thread", "base", "timeout", "inactivity-timeout", "deadline", "rounds", "request-id"]) assert.ok(SPEC.value.includes(v), v);
  for (const b of ["last", "json", "web", "uncommitted", "adversarial", "refresh"]) assert.ok(SPEC.bool.includes(b), b);
});

test("parseArgv: option arity", () => {
  const r = parseArgv(["--to", "codex", "--effort", "low", "--json", "--web", "hello", "world"]);
  assert.deepEqual(r.options, { to: "codex", effort: "low", json: true, web: true });
  assert.deepEqual(r.positionals, ["hello", "world"]);
  assert.equal(r.literal, false);
  assert.deepEqual(parseArgv(["--effort=high", "--json=false"]).options, { effort: "high", json: false });
  assert.deepEqual(parseArgv(["--last", "--uncommitted", "--adversarial", "--refresh"]).options, { last: true, uncommitted: true, adversarial: true, refresh: true });
  usage(() => parseArgv(["--to"]), /Missing value for --to/);
  usage(() => parseArgv(["--effort"]), /Missing value/);
  usage(() => parseArgv(["--bogus", "x"]), /Unknown option --bogus/);
  assert.deepEqual(parseArgv(["-x", "text"]).positionals, ["-x", "text"], "single-dash tokens are text, as in the donor");
  // a value option consumes the next token even when it looks like a flag
  assert.deepEqual(parseArgv(["--model", "--json"]).options, { model: "--json" });
});

test("parseArgv: -- makes the rest literal text", () => {
  const r = parseArgv(["--to", "grok", "--", "--not-an-option", "text", "--json"]);
  assert.deepEqual(r.options, { to: "grok" });
  assert.deepEqual(r.positionals, ["--not-an-option", "text", "--json"]);
  assert.equal(r.literal, true);
  const empty = parseArgv(["--"]);
  assert.deepEqual(empty.positionals, []);
  assert.equal(empty.literal, true);
});

test("splitLeading: heredoc text with leading flags", () => {
  const r = splitLeading("--to codex --tier deep What is the plan?\nSecond line.");
  assert.deepEqual(r.options, { to: "codex", tier: "deep" });
  assert.equal(r.text, "What is the plan?\nSecond line.");
  assert.equal(r.literal, false);
  const inline = splitLeading("--effort=low --json Question");
  assert.deepEqual(inline.options, { effort: "low", json: true });
  assert.equal(inline.text, "Question");
});

test("splitLeading: text with no leading option is returned untouched", () => {
  const raw = "  Just a question with --flags later --json\nand more";
  const r = splitLeading(raw);
  assert.deepEqual(r.options, {});
  assert.equal(r.text, raw);
  assert.equal(splitLeading("").text, "");
  assert.equal(splitLeading("   \n").text, "   \n");
});

test("splitLeading: a literal -- stops parsing and strips one line break", () => {
  const r = splitLeading("--to grok --\n--effort is not an option here\nmore");
  assert.deepEqual(r.options, { to: "grok" });
  assert.equal(r.text, "--effort is not an option here\nmore");
  assert.equal(r.literal, true);
  const same = splitLeading("-- --bogus text");
  assert.deepEqual(same.options, {});
  assert.equal(same.text, "--bogus text");
  assert.equal(same.literal, true);
});

test("splitLeading: multiline text and delimiter collision keep bytes intact", () => {
  const body = "Line one\nCOUNCIL_EOF appears in the text\n\ttabbed\n\nEnd";
  const r = splitLeading(`--to gemini ${body}`);
  assert.deepEqual(r.options, { to: "gemini" });
  assert.equal(r.text, body);
  const noFlags = splitLeading(body);
  assert.equal(noFlags.text, body, "no leading option: byte-for-byte");
  // options only, no text
  const only = splitLeading("--to codex --last");
  assert.deepEqual(only.options, { to: "codex", last: true });
  assert.equal(only.text, "");
  usage(() => splitLeading("--to"), /Missing value/);
  usage(() => splitLeading("--nope x"), /Unknown option/);
});

test("seconds and roundCount validate their inputs", () => {
  assert.equal(seconds(undefined, 90, "timeout"), 90);
  assert.equal(seconds("5", 90, "timeout"), 5);
  assert.equal(seconds("0.5", 90, "timeout"), 0.5);
  usage(() => seconds("0", 90, "timeout"), /--timeout needs a finite positive number/);
  usage(() => seconds("abc", 90, "timeout"));
  usage(() => seconds("99999999", 90, "deadline"), /within the timer range/);
  assert.equal(roundCount("3", "--rounds"), 3);
  usage(() => roundCount("0", "--rounds"), /positive integer/);
  usage(() => roundCount("2.5", "--rounds"));
});
