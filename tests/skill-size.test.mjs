import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = join(root, "plugins", "council", "skills", "council", "SKILL.md");

test("SKILL.md stays at or under 3,000 bytes", () => {
  const text = readFileSync(skillPath, "utf8");
  assert.ok(Buffer.byteLength(text, "utf8") <= 3000, `SKILL.md is ${Buffer.byteLength(text, "utf8")} bytes`);
  assert.match(text, /^---\nname: council\ndescription: .+\n---\n/);
});

test("the skill's PowerShell form is one statement, and its temp file is named for the session", () => {
  const text = readFileSync(skillPath, "utf8");
  const [, form] = /then PowerShell `(.*?)`\./.exec(text);
  assert.match(form, /^node "/, "PowerShell(node:*) matches only a statement that starts with node");
  assert.doesNotMatch(form, /;|LASTEXITCODE/, "a second statement needs approval under default permissions");
  assert.match(text, /new UTF-8 temp file `council-\$\{CLAUDE_SESSION_ID\}-<random>\.txt`/);
});

test("the skill's example is a foreground call by its own rule, and the rule names a consult tier that is not", () => {
  const text = readFileSync(skillPath, "utf8");
  const tiers = JSON.parse(readFileSync(join(root, "plugins", "council", "tiers.json"), "utf8"));
  const heavy = ["xhigh", "max", "ultra"];
  const [, example] = /ask --to (\w+) .*--tier consult -- <<'COUNCIL_EOF'/.exec(text);
  assert.ok(!heavy.includes(tiers[example].consult.effort), `the example runs ${example} in the foreground at ${tiers[example].consult.effort}`);
  assert.ok(!/ --request-id /.test(/```bash\n(.*)\n/.exec(text)[1]), "a foreground example needs no request id");
  for (const [provider, table] of Object.entries(tiers)) {
    if (heavy.includes(table.consult.effort)) assert.match(text, new RegExp(`\`run_in_background: true\` for every [^.]*${table.consult.effort} \\(${provider} consult\\)`), provider);
  }
});

test("with no model named the skill rules out a task, even for a fix, and says how to get one (S7.1 C1)", () => {
  const text = readFileSync(skillPath, "utf8");
  assert.match(text, /No model named \(provider names excluded\): ask\/reply\/review with/);
  assert.match(text, /Never task, even for a fix or edit: ask or review, then say `\/council:task` or naming a model lets the provider edit\./);
  assert.match(text, /`task --to <p> \[--thread id\]`: edits files; needs a named model and authorization\./);
  assert.doesNotMatch(text, /only when the user authorizes it/, "the wording Claude read as permission");
});

test("request ids are fresh per call; a refused reuse takes a new id (S7.1 C3)", () => {
  const text = readFileSync(skillPath, "utf8");
  assert.match(text, /a fresh `--request-id <8 random letters\/digits>`, unique here/);
  assert.match(text, /`already used with different input`: new id, rerun\./);
});

test("every flag, verb and tier the skill states exists in the code as built", async () => {
  const text = readFileSync(skillPath, "utf8");
  const { SPEC, VERBS, PROVIDERS } = await import("../plugins/council/scripts/lib/core/args.mjs");
  const flags = new Set([...text.matchAll(/(?<![\w-])--([a-z][a-z-]+)/g)].map((m) => m[1]));
  for (const f of flags) assert.ok([...SPEC.value, ...SPEC.bool].includes(f), `--${f} is not an option`);
  for (const v of VERBS) assert.match(text, new RegExp("`" + v + "[ `]"), `verb ${v} is named`);
  const tiers = JSON.parse(readFileSync(join(root, "plugins", "council", "tiers.json"), "utf8"));
  for (const p of PROVIDERS) {
    const line = ["consult", "exec", "deep"].map((t) => `${tiers[p][t].model}/${tiers[p][t].effort}`).join(" · ");
    assert.ok(text.includes(`- ${p}: ${line}\n`), `${p} tier line matches tiers.json`);
  }
  const description = /^description: (.+)$/m.exec(text)[1];
  assert.ok(Buffer.byteLength(description) <= 200, `description is ${Buffer.byteLength(description)} bytes`);
});
