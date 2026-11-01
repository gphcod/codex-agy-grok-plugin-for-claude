// S6.2: each generated slash command's Bash block, taken verbatim from plugins/council/commands/*.md,
// with `$ARGUMENTS` replaced by the arguments as Claude Code does, run by bash with CLAUDE_PLUGIN_ROOT,
// CLAUDE_SESSION_ID, a temporary COUNCIL_HOME and the wrapped fakes (tests/fixtures/three-providers.mjs).
// The fakes check the exact prompt bytes (COUNCIL_FAKE_EXPECT_PROMPT) and exit 99 on a mismatch.
// The skill's direct call form is run the same way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reviewTarget } from "../plugins/council/scripts/lib/core/git.mjs";
import { PLUGIN_DIR, SESSION, footer, harness, markers } from "./fixtures/three-providers.mjs";

const block = (file) => {
  const m = /```bash\n([\s\S]*?)```/.exec(readFileSync(join(PLUGIN_DIR, file), "utf8"));
  assert.ok(m, `${file} has a bash block`);
  return m[1];
};
/** Claude Code replaces `$ARGUMENTS` in the command text with the user's arguments, verbatim. */
const command = (name, args, delimiter = null) => {
  let body = block(join("commands", `${name}.md`));
  if (delimiter) body = body.replaceAll("COUNCIL_EOF", delimiter);
  return body.replaceAll("$ARGUMENTS", args);
};
const CLAUDE = { CLAUDE_PLUGIN_ROOT: PLUGIN_DIR, CLAUDE_SESSION_ID: SESSION };

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
    assert.match(footer(r.out), /^council codex ok · .* · gpt-6\.1-sol\/high · /, "no option was taken from inside the text");

    // Multiline text, quotes, $, backticks: the quoted heredoc passes them unexpanded.
    const multi = "First line\n\n  second line with 'quotes', \"double\", $HOME and `ticks`\nlast";
    r = await h.sh(command("gemini", `--effort low ${multi}`), { ...env, ...markers("gemini", multi) });
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(footer(r.out), /^council gemini ok · .* · gemini-4-argon\/low · /);

    // A line equal to the delimiter: the command says to pick another delimiter in both places.
    const collide = "before\nCOUNCIL_EOF\nafter";
    r = await h.sh(command("ask", `--to codex ${collide}`, "COUNCIL_EOF_1"), { ...env, ...markers("codex", collide) });
    assert.equal(r.code, 0, r.err + r.out);
    for (const name of ["ask", "codex", "gemini", "grok"]) assert.match(readFileSync(join(PLUGIN_DIR, "commands", `${name}.md`), "utf8"), /If a line of the arguments is exactly `COUNCIL_EOF`, use another delimiter/);

    // The skill's direct form (`--` on argv, text in the heredoc) runs as written.
    const direct = block(join("skills", "council", "SKILL.md")).replace("<text>", "skill form\n-- not an option");
    r = await h.sh(direct, { ...env, ...markers("codex", "skill form\n-- not an option") });
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(footer(r.out), /^council codex ok · .* · gpt-6\.1-sol\/high · /);
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

test("each command says how to run its Bash call (foreground or background)", () => {
  for (const name of ["ask", "codex", "gemini", "grok", "reply"]) {
    assert.match(readFileSync(join(PLUGIN_DIR, "commands", `${name}.md`), "utf8"), /in the foreground with timeout 600000, or with `run_in_background: true` when /);
  }
  for (const name of ["review", "task"]) assert.match(readFileSync(join(PLUGIN_DIR, "commands", `${name}.md`), "utf8"), /^Make one Bash tool call with `run_in_background: true`\./m);
  for (const name of ["wait", "cancel"]) assert.match(readFileSync(join(PLUGIN_DIR, "commands", `${name}.md`), "utf8"), /^Make one Bash tool call in the foreground\. It starts no provider CLI\./m);
  for (const name of ["models", "setup"]) assert.match(readFileSync(join(PLUGIN_DIR, "commands", `${name}.md`), "utf8"), /^Make one Bash tool call in the foreground\. It (starts no provider CLI unless|runs each provider's version)/m);
});
