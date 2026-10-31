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
