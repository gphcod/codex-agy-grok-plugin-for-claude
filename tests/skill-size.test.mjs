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

test("with no model named the skill rules out a task, even for a fix, and says how to get one (S7.1 C1)", () => {
  const text = readFileSync(skillPath, "utf8");
  assert.match(text, /User named no model \(a provider is no model\): ask\/reply\/review only/);
  assert.match(text, /Never task, even for a fix or edit: ask or review, then say `\/council:task` or naming a model lets the provider edit\./);
  assert.match(text, /`task --to <p> \[--thread id\]`: edits files; needs a named model and authorization\./);
  assert.doesNotMatch(text, /only when the user authorizes it/, "the wording Claude read as permission");
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
