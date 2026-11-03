// S6.5: scripts/measure.mjs measures one ask per provider against the fakes and the skill size.
import { test } from "node:test";
import assert from "node:assert/strict";
import { framing, measure } from "../scripts/measure.mjs";

test("framing counts the start line and the footer line, never the answer", () => {
  const f = framing({ err: "[council] provider=x job=j thread=t\n", out: "pong\nmore\ncouncil x ok · job j\n" });
  assert.deepEqual(f, { start: 36, footer: 22, total: 58, answer: 10 });
});

test("npm run measure: three rows, framing within the frozen grammar's range, the skill under 3,000 B", async () => {
  const { rows, skillBytes } = await measure();
  assert.deepEqual(rows.map((r) => r.provider), ["codex", "gemini", "grok"]);
  for (const r of rows) {
    assert.equal(r.total, r.start + r.footer);
    assert.ok(r.total > 100 && r.total < 190, `${r.provider}: ${r.total} B`);
    assert.equal(r.withRequestId, r.total, "a request id adds nothing to a first call's framing");
    assert.match(r.footerText, new RegExp(`^council ${r.provider} ok · job [a-z0-9]{16} · `));
  }
  assert.ok(skillBytes <= 3000);
});
