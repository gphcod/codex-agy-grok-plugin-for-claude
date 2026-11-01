import { test } from "node:test";
import assert from "node:assert/strict";
import { processSnapshot, startTime } from "../plugins/council/scripts/lib/core/execution.mjs";

// macOS lstart stamps are identity evidence compared across processes: the query must not depend
// on the caller's time zone, or a cancel run under another TZ reads a live owner as gone.
test("the darwin process query runs with TZ=UTC whatever the caller's TZ", () => {
  const seen = [];
  const run = (cmd, args, opts) => { seen.push(opts.env.TZ); return { status: 0, stdout: `  101     1   101   ${process.getuid?.() ?? 501} S    Sun Nov  1 14:39:06 2026 /bin/sleep 9\n` }; };
  const previous = process.env.TZ;
  try {
    for (const tz of ["America/Los_Angeles", "Asia/Tokyo", undefined]) {
      if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
      const snap = processSnapshot({ platform: "darwin", run });
      assert.equal(snap.state, "ok");
      assert.equal(snap.rows[0].pid, 101);
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  assert.deepEqual(seen, ["UTC", "UTC", "UTC"]);
});

test("an lstart stamp is read as UTC", () => {
  assert.equal(startTime("Sun Nov  1 14:39:06 2026"), BigInt(Date.UTC(2026, 10, 1, 14, 39, 6) / 1000));
  assert.equal(startTime("12345"), 12345n);
  assert.equal(startTime("not a date"), null);
});
