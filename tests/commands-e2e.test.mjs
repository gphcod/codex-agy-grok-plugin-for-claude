// S6.2: each generated slash command's Bash block, taken verbatim from plugins/council/commands/*.md,
// with `$ARGUMENTS` replaced by the arguments as Claude Code does, run by bash with CLAUDE_PLUGIN_ROOT,
// CLAUDE_SESSION_ID, a temporary COUNCIL_HOME and the wrapped fakes (tests/fixtures/three-providers.mjs).
// The fakes check the exact prompt bytes (COUNCIL_FAKE_EXPECT_PROMPT) and exit 99 on a mismatch.
// The skill's direct call form is run the same way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reviewTarget } from "../plugins/council/scripts/lib/core/git.mjs";
import { RID, heavyExec } from "../scripts/gen-commands.mjs";
import { PLUGIN_DIR, SESSION, footer, harness, markers } from "./fixtures/three-providers.mjs";

const block = (file) => {
  const m = /```bash\n([\s\S]*?)```/.exec(readFileSync(join(PLUGIN_DIR, file), "utf8"));
  assert.ok(m, `${file} has a bash block`);
  return m[1];
};
const freshId = () => Array.from(randomBytes(8), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
/**
 * Claude Code replaces `$ARGUMENTS` in the command text with the user's arguments, verbatim (a replacer
 * function, so `$$`, `$&` and `$'` in the arguments stay literal); Claude replaces `@RID@` with a fresh
 * request id as the command says (`rid: null` leaves the placeholder, as a careless caller would).
 */
const command = (name, args, { delimiter = null, rid = freshId() } = {}) => {
  let body = block(join("commands", `${name}.md`));
  if (delimiter) body = body.replace(/COUNCIL_EOF/g, () => delimiter);
  if (rid !== null) body = body.replace(new RegExp(RID, "g"), () => rid);
  return body.replace(/\$ARGUMENTS/g, () => args);
};
const CLAUDE = { CLAUDE_PLUGIN_ROOT: PLUGIN_DIR, CLAUDE_SESSION_ID: SESSION };
/** The PowerShell form as Claude runs it: Claude Code has already substituted the two variables in the command's text. */
const powershellForm = (name, file, rid = freshId()) => /```powershell\n(.*)\n```/.exec(readFileSync(join(PLUGIN_DIR, "commands", `${name}.md`), "utf8"))[1]
  .replaceAll("${CLAUDE_PLUGIN_ROOT}", PLUGIN_DIR).replaceAll("${CLAUDE_SESSION_ID}", SESSION).replaceAll(RID, rid).replace("<file>", file);
const POWERSHELLS = process.platform === "win32" ? ["powershell.exe", "pwsh.exe"].filter((exe) => spawnSync(exe, ["-NoProfile", "-Command", "exit 0"], { windowsHide: true }).status === 0) : [];

test("ask, codex, gemini, grok: leading flags, a literal --, text with -- inside, multiline text, a delimiter collision", async () => {
  const h = harness();
  try {
    const env = CLAUDE;
    // Leading flags are parsed out of the heredoc text; the rest is the prompt, byte for byte.
    let r = await h.sh(command("ask", "--to grok --effort low What is 2+2?"), { ...env, ...markers("grok", "What is 2+2?") });
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.err, /^\[council\] provider=grok /);
    assert.match(footer(r.out), /^council grok ok · job [a-z0-9]{16} · grok-4\.7\/low · /);
    assert.equal(h.job(r.job).session, SESSION, "the session comes from CLAUDE_SESSION_ID");
    assert.equal(readFileSync(h.job(r.job).turn.promptFile, "utf8"), "What is 2+2?");

    // A literal `--` ends the options: what follows is text even when it looks like a flag.
    r = await h.sh(command("grok", "--effort low -- --verbose is literal text"), { ...env, ...markers("grok", "--verbose is literal text") });
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(footer(r.out), /^council grok ok · .* · grok-4\.7\/low · /);
    // Text without leading options is untouched, including a ` -- ` inside it.
    r = await h.sh(command("codex", "compare a -- b --effort max"), { ...env, ...markers("codex", "compare a -- b --effort max") });
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(footer(r.out), /^council codex ok · .* · gpt-6\.1-sol\/xhigh · /, "no option was taken from inside the text");

    // Multiline text, quotes, $, backticks: the quoted heredoc passes them unexpanded.
    const multi = "First line\n\n  second line with 'quotes', \"double\", $HOME, $$, $& and $' and `ticks`\nlast";
    r = await h.sh(command("gemini", `--effort low ${multi}`), { ...env, ...markers("gemini", multi) });
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(footer(r.out), /^council gemini ok · .* · gemini-4-argon\/low · /);

    // A line equal to the delimiter: the command says to pick another delimiter in both places.
    const collide = "before\nCOUNCIL_EOF\nafter";
    r = await h.sh(command("ask", `--to codex ${collide}`, { delimiter: "COUNCIL_EOF_1" }), { ...env, ...markers("codex", collide) });
    assert.equal(r.code, 0, r.err + r.out);
    for (const name of ["ask", "codex", "gemini", "grok"]) assert.match(readFileSync(join(PLUGIN_DIR, "commands", `${name}.md`), "utf8"), /If a line of the arguments is exactly `COUNCIL_EOF`, use another delimiter/);

    // The skill's direct form (`--` on argv, text in the heredoc) runs as written.
    const direct = block(join("skills", "council", "SKILL.md")).replace("<text>", "skill form\n-- not an option");
    r = await h.sh(direct, { ...env, ...markers("codex", "skill form\n-- not an option") });
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(footer(r.out), /^council codex ok · .* · gpt-6\.1-sol\/xhigh · /);
    assert.equal(h.job(r.job).tier, "consult");
  } finally { h.done(); }
});

test("reply, review, task, wait, cancel, models, setup through their command blocks", async () => {
  const h = harness();
  try {
    const env = CLAUDE;
    const ask = await h.sh(command("codex", "--effort low first question"), { ...env, ...markers("codex", "first question") });
    assert.equal(ask.code, 0, ask.err + ask.out);
    // reply: the job id as first word, or --thread; the provider comes from the job.
    let r = await h.sh(command("reply", `${ask.job} follow up`), { ...env, ...markers("codex", "follow up"), COUNCIL_FAKE_SCENARIO: "resume" });
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(footer(r.out), /^council codex ok · .* · gpt-6\.1-sol\/low · .* · round 2\/9 · /);
    r = await h.sh(command("reply", `--thread ${ask.job} --effort medium and more`), { ...env, ...markers("codex", "and more"), COUNCIL_FAKE_SCENARIO: "resume" });
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(footer(r.out), /^council codex ok · .* · gpt-6\.1-sol\/medium · .* · round 3\/9 · /);
    r = await h.sh(command("reply", `--thread ${ask.job} --to grok x`), env);
    assert.equal(r.code, 2);
    assert.match(r.err, /belongs to codex; --to grok conflicts/);

    // review: codex focus text reaches stdin after the target sentence; gemini --adversarial renders its template.
    writeFileSync(join(h.repo, "calc.js"), "export const sum = (items) => { let s = 0; for (let i = 0; i <= items.length; i++) s += items[i]; return s; };\n");
    const sentence = reviewTarget(h.cwd, { uncommitted: true }).sentence;
    r = await h.sh(command("review", "--to codex --uncommitted Focus on loop bounds."), { ...env, COUNCIL_FAKE_SCENARIO: "review-findings", COUNCIL_FAKE_EXPECT_PROMPT: `${sentence}\n\nFocus on loop bounds.` });
    assert.equal(r.code, 10, r.err + r.out);
    assert.match(r.out, /\nF1 MAJOR /);
    assert.match(footer(r.out), /^council codex needs attention · /);
    r = await h.sh(command("review", "--to gemini --uncommitted --adversarial look at the bound"), { ...env, COUNCIL_FAKE_SCENARIO: "review-findings", COUNCIL_FAKE_EXPECT_PROMPT_CONTAINS: "User focus: look at the bound" });
    assert.equal(r.code, 10, r.err + r.out);
    assert.match(r.out, /adversarial|F1 /);
    assert.match(r.err, / target=working tree/);

    // task: the exec tier by default; grok's write recipe.
    r = await h.sh(command("task", "--to grok --effort low do the edit"), { ...env, ...markers("grok", "do the edit") });
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(footer(r.out), /^council grok ok · .* · grok-4\.7-build-fast\/low · .* · round 1\/9 · edited 0 · /);
    assert.equal(h.job(r.job).readOnly, false);

    // Control commands: their arguments arrive on stdin through the heredoc.
    r = await h.sh(command("wait", ""), env);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim().split("\n").length, 6, r.out);
    r = await h.sh(command("wait", `${ask.job} --timeout 5`), env);
    assert.equal(r.code, 0, r.err);
    assert.match(footer(r.out), new RegExp(`^council codex ok · job ${ask.job} · `));
    r = await h.sh(command("cancel", ""), env);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^no running council job to cancel$/m);
    r = await h.sh(command("models", "--to codex"), env);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^codex \(static\)/m);
    assert.doesNotMatch(r.out, /^(gemini|grok) /m);
    r = await h.sh(command("setup", "--to gemini"), env);
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /^gemini: ready · /m);
    assert.equal(h.invocations().filter((c) => c.provider === "gemini").length, 3, "the earlier review plus agy --version and agy models");
  } finally { h.done(); }
});

for (const exe of POWERSHELLS) {
  test(`${exe}: the PowerShell form: text that would end a here-string, non-ASCII and leading flags, by file; the exit code survives; empty arguments`, async () => {
    const h = harness();
    try {
      const text = 'He said "hi", $HOME and `tick\n\'@ not an end\n\u2019@ nor this; Remove-Item nothing\nna\u00efve \u6f22\u5b57 \ud83d\ude00';
      const file = join(h.root, "arguments.txt");
      writeFileSync(file, `--to grok --effort low ${text}`);
      let r = await h.ps(exe, powershellForm("ask", file), markers("grok", text));
      assert.equal(r.code, 0, r.err + r.out);
      assert.match(footer(r.out), /^council grok ok · job [a-z0-9]{16} · grok-4\.7\/low · /);
      assert.equal(readFileSync(h.job(r.job).turn.promptFile, "utf8"), text);
      assert.equal(h.job(r.job).session, SESSION);
      writeFileSync(file, "\uFEFF--to nobody hi");
      r = await h.ps(exe, powershellForm("ask", file), {});
      assert.equal(r.code, 2, "exit $LASTEXITCODE keeps the entry's code, and a byte order mark does not hide the flags");
      assert.match(r.err, /--to must be one of/);
      writeFileSync(file, "");
      r = await h.ps(exe, powershellForm("wait", file), {});
      assert.equal(r.code, 0, r.err + r.out);
      // An empty session in the command's text: Windows PowerShell would drop a bare "" argument and shift the next one.
      writeFileSync(file, `--to grok --effort low ${text}`);
      r = await h.ps(exe, powershellForm("ask", file).replace(SESSION, ""), { ...markers("grok", text), CLAUDE_CODE_SESSION_ID: "from-the-host" });
      assert.equal(r.code, 0, r.err + r.out);
      assert.equal(readFileSync(h.job(r.job).turn.promptFile, "utf8"), text);
      r = await h.ps(exe, powershellForm("ask", join(h.root, "missing.txt")), {});
      assert.equal(r.code, 2);
      assert.match(r.err, /cannot read --input-file/);
    } finally { h.done(); }
  });
}

test("each command says how to run its Bash call: background for review, task, deep, exec tiers at xhigh or above, and heavy efforts", () => {
  const text = (name) => readFileSync(join(PLUGIN_DIR, "commands", `${name}.md`), "utf8");
  assert.deepEqual(heavyExec(), { codex: "max", grok: "xhigh" }, "exec tiers from tiers.json that run at xhigh or above");
  const heavy = /`--tier deep`, `--effort xhigh`, `max` or `ultra`/;
  for (const name of ["ask", "codex", "gemini", "grok", "reply"]) {
    assert.match(text(name), heavy, name);
    assert.match(text(name), /Otherwise run it in the foreground with timeout 600000\./, name);
  }
  assert.match(text("ask"), /`--tier exec` with `--to codex` or `--to grok` and no `--effort` below xhigh \(their exec tiers run at max and xhigh\)/);
  assert.match(text("codex"), /`--tier exec` and no `--effort` below xhigh \(codex's exec tier runs at max\)/);
  assert.match(text("grok"), /`--tier exec` and no `--effort` below xhigh \(grok's exec tier runs at xhigh\)/);
  assert.doesNotMatch(text("gemini"), /--tier exec/, "gemini's exec tier runs at high: foreground");
  assert.match(text("reply"), /`--tier exec` on a codex or grok thread with no `--effort` below xhigh, or they set neither and the thread already runs at deep or at xhigh or above\. When you cannot tell, run it in the background\./);
  for (const name of ["ask", "codex"]) assert.match(text(name), /Default consult calls for `codex` also run in the background when `--tier` is omitted or consult, unless `--effort` is below xhigh\./);
  assert.match(text("reply"), /On `codex` threads, `--tier consult` also runs in the background unless `--effort` is below xhigh\./);
  for (const name of ["gemini", "grok"]) assert.doesNotMatch(text(name), /Default consult calls/, "lower-effort defaults may run in the foreground");
  for (const name of ["review", "task"]) assert.match(text(name), /^Make one Bash tool call with `run_in_background: true`\./m);
  for (const name of ["wait", "cancel"]) assert.match(text(name), /^Make one Bash tool call in the foreground\. It starts no provider CLI\./m);
  for (const name of ["models", "setup"]) assert.match(text(name), /^Make one Bash tool call in the foreground\. It (starts no provider CLI unless|runs each provider's version)/m);
  for (const name of ["ask", "codex", "gemini", "grok", "reply", "review", "task"]) {
    assert.match(text(name), / --request-id @RID@ --session /, `${name} carries a request id`);
    assert.match(text(name), /Replace `@RID@` with 8 random letters and digits, a fresh id never used earlier in this conversation/, name);
    assert.match(text(name), /If it says the id was already used with different input, pick a new id and rerun\./, name);
  }
  for (const name of ["wait", "cancel", "models", "setup"]) assert.doesNotMatch(text(name), /@RID@/, name);
});

test("request ids: the substituted id reaches the entry, a retry replays without a second CLI, an id in the arguments wins, a left placeholder is refused", async () => {
  const h = harness();
  try {
    const env = CLAUDE;
    const body = command("task", "--to codex --effort low do the edit", { rid: "taskid01" });
    const first = await h.sh(body, { ...env, ...markers("codex", "do the edit") });
    assert.equal(first.code, 0, first.err + first.out);
    assert.equal(h.job(first.job).requestId, "taskid01");
    assert.ok(existsSync(join(h.home, "claims", "requests", `${first.job}.json`)), "the request tombstone exists");
    const spawned = h.invocations().length;
    const retry = await h.sh(body, { ...env, ...markers("codex", "do the edit") });
    assert.equal(retry.code, 0, retry.err + retry.out);
    assert.equal(retry.job, first.job);
    assert.equal(retry.out, first.out, "the retry prints the first result");
    assert.match(retry.err, / replay=taskid01/);
    assert.equal(h.invocations().length, spawned, "the retry started no CLI");
    // The same id with other text is refused rather than replayed.
    const changed = await h.sh(command("task", "--to codex --effort low other edit", { rid: "taskid01" }), env);
    assert.equal(changed.code, 2);
    // An id in the arguments takes precedence over the substituted one.
    writeFileSync(join(h.repo, "calc.js"), "export const x = 1;\n");
    const own = await h.sh(command("review", "--to codex --uncommitted --request-id userid02", { rid: "ignored2" }), { ...env, COUNCIL_FAKE_SCENARIO: "review-findings" });
    assert.equal(own.code, 10, own.err + own.out);
    assert.equal(h.job(own.job).requestId, "userid02");
    // A placeholder left in place is refused before anything runs.
    const before = h.jobIds().length;
    const left = await h.sh(command("ask", "--to grok hi", { rid: null }), { ...env, ...markers("grok", "hi") });
    assert.equal(left.code, 2);
    assert.match(left.err, /--request-id needs 1 to 128 letters/);
    assert.equal(h.jobIds().length, before);
  } finally { h.done(); }
});
