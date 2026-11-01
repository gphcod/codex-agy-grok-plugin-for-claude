// core fix (S4): parseEvent sees the turn's own buildTurn result as `state.turn`, so an adapter can
// apply per-turn rules (the grok read-only tool guard) without module-level state, even when two turns
// run concurrently in one process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nullAdapter from "./fixtures/null-adapter.mjs";
import { GUARD_VARS } from "./fixtures/fake-common.mjs";
import { createReader } from "../plugins/council/scripts/lib/core/reader.mjs";
import { homeDir } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { runManagedTurn } from "../plugins/council/scripts/lib/core/lifecycle.mjs";

test("createReader exposes the turn as state.turn (null when none is given)", () => {
  const seen = [];
  const adapter = { parseEvent(line, state) { seen.push(state.turn); return nullAdapter.parseEvent(line, state); } };
  const turn = { args: ["x"], readOnly: true, marker: 1 };
  const r = createReader({ adapter, turn });
  r.feed('{"type":"text","data":"hi"}\n');
  assert.equal(seen[0], turn);
  assert.equal(r.state.turn, turn);
  const r2 = createReader({ adapter });
  assert.equal(r2.state.turn, null);
});

test("runManagedTurn hands each concurrent turn its own built turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "council-rt-"));
  try {
    const home = homeDir({ COUNCIL_HOME: join(root, "home") });
    const cwd = join(root, "work");
    mkdirSync(cwd);
    writeFileSync(join(root, "spawns.log"), "");
    const env = { ...process.env, COUNCIL_FAKE_SPAWN_LOG: join(root, "spawns.log"), COUNCIL_NULL_ID: "preassigned", COUNCIL_NULL_INPUT: "stdin", COUNCIL_NULL_OUTPUT: "stream" };
    for (const g of GUARD_VARS) delete env[g];
    const seen = new Map();
    const adapter = Object.create(Object.getPrototypeOf(nullAdapter), Object.getOwnPropertyDescriptors(nullAdapter));
    adapter.buildTurn = (request) => ({ ...nullAdapter.buildTurn(request), tag: request.jobId });
    adapter.parseEvent = (line, state) => {
      const ev = nullAdapter.parseEvent(line, state);
      if (ev?.textDelta) seen.set(state.turn.tag, ev.textDelta);
      return ev;
    };
    const ctx = { home, env, cwd, session: "s" };
    const request = { verb: "ask", provider: "null", cwd, session: "s", tier: "consult", model: "null-model", effort: "high", requestedEffort: "high", modelVerified: true, thread: null, readOnly: true, text: "hello", contract: "<c/>", web: false, rounds: 9, round: 1 };
    const fast = { drainMs: 150, shutdownMs: 4000, retryMs: 300, graceMs: 150, pipeWaitMs: 500 };
    const [a, b] = await Promise.all([1, 2].map(() => runManagedTurn(ctx, adapter, request, () => request, { deadlineMs: 20000, inactivityMs: 20000 }, fast)));
    assert.equal(a.job.code, 0, a.job.error);
    assert.equal(b.job.code, 0, b.job.error);
    assert.equal(seen.get(a.job.id), `pong for job ${a.job.id}`);
    assert.equal(seen.get(b.job.id), `pong for job ${b.job.id}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
