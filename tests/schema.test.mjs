import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = join(root, "plugins", "council", "schemas", "review-output.schema.json");
const fixturePath = join(root, "tests", "fixtures", "review-output.reference.json");

test("review-output schema equals the committed reference (repository files only)", () => {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  assert.ok(Array.isArray(fixture.provenance.sources) && fixture.provenance.sources.length === 2, "two named sources");
  for (const s of fixture.provenance.sources) assert.match(s.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(schema, fixture.schema);
});

test("review-output schema shape used by the normalizer", () => {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  assert.deepEqual(schema.required, ["verdict", "summary", "findings", "next_steps"]);
  assert.deepEqual(schema.properties.verdict.enum, ["approve", "needs-attention"]);
  assert.deepEqual(schema.properties.findings.items.properties.severity.enum, ["critical", "high", "medium", "low"]);
  assert.equal(schema.additionalProperties, false);
});
