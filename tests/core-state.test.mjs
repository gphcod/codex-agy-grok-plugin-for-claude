// S2.7 (ratio): the state layer under concurrency and corruption — request claims raced by separate
// processes, job records and markers, listing order, event tails — plus the catalog paths the entry
// added in S2.6 (an adapter's own static entry, refreshed files that are malformed) and the A3.4
// footer over every field combination.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogPath, loadCatalog, refreshCatalog, resolveEffort, resolveModel } from "../plugins/council/scripts/lib/core/catalog.mjs";
import { resolveTier } from "../plugins/council/scripts/lib/core/tiers.mjs";
import { claimRequest, createJob, homeDir, lastEvent, listJobs, loadJob, markDone, markStopped, requestJobId, saveJob, stateOf } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { footer, startLine } from "../plugins/council/scripts/lib/core/output.mjs";
import nullAdapter from "./fixtures/null-adapter.mjs";

const JOBS = fileURLToPath(new URL("../plugins/council/scripts/lib/core/jobs.mjs", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "council-state-"));

test("request claims raced by eight processes: exactly one is fresh, every loser sees the same id", async () => {
  const root = tmp();
  try {
    const home = homeDir({ COUNCIL_HOME: join(root, "home") });
    const script = `import { claimRequest } from ${JSON.stringify(JOBS)};
const r = claimRequest(process.argv[1], "null", "race-1", { session: "s", cwd: "/w" }, { fingerprint: "fp" });
process.stdout.write(JSON.stringify({ id: r.id, fresh: r.fresh }));`;
    const runs = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, home], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))));
    })));
    assert.equal(runs.filter((r) => r.fresh).length, 1, "one winner");
    assert.equal(new Set(runs.map((r) => r.id)).size, 1);
    assert.equal(runs[0].id, requestJobId("null", "s", "/w", "race-1"));
    const reservation = JSON.parse(readFileSync(join(home, "jobs", runs[0].id, "request.json"), "utf8"));
    assert.equal(reservation.fingerprint, "fp");
    assert.equal(claimRequest(home, "null", "race-1", { session: "s", cwd: "/w" }).fresh, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("job records: read-time fields never persist; markers win over metadata; listing is newest first", () => {
  const root = tmp();
  try {
    const home = homeDir({ COUNCIL_HOME: join(root, "home") });
    const a = createJob(home, { provider: "null", verb: "ask", status: "running", spawnedAt: "2026-10-31T10:00:00.000Z", admittedAt: "2026-10-31T10:00:01.000Z" });
    const b = createJob(home, { provider: "null", verb: "ask", status: "running", spawnedAt: "2026-10-31T11:00:00.000Z" });
    saveJob({ ...a, done: true, beatMs: 5, stopped: true, stoppedAt: "x", cancelRequested: true, claimHeld: true });
    const meta = JSON.parse(readFileSync(join(a.dir, "meta.json"), "utf8"));
    for (const k of ["dir", "done", "beatMs", "stopped", "stoppedAt", "cancelRequested", "claimHeld"]) assert.ok(!(k in meta), `${k} is a read-time field`);
    assert.equal(loadJob(home, a.id).done, false, "done comes from the marker, not the record");
    markDone(a);
    assert.equal(loadJob(home, a.id).done, true);
    markStopped(b); markStopped(b);
    writeFileSync(join(b.dir, "cancel"), "");
    const lb = loadJob(home, b.id);
    assert.deepEqual([lb.stopped, lb.cancelRequested, stateOf(lb)], [true, true, "cancelled"]);
    assert.deepEqual(listJobs(home).map((j) => j.id), [b.id, a.id], "sorted by admittedAt ?? spawnedAt, newest first");
    writeFileSync(join(b.dir, "meta.json"), "{ torn");
    assert.equal(loadJob(home, b.id), null, "an unreadable record is no job");
    assert.deepEqual(listJobs(home).map((j) => j.id), [a.id]);
    mkdirSync(join(home, "jobs", ".claim-123-abcd"));
    assert.deepEqual(listJobs(home).map((j) => j.id), [a.id], "temporary claim directories are never jobs");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("lastEvent reads only the tail of a long event stream", () => {
  const root = tmp();
  try {
    const home = homeDir({ COUNCIL_HOME: join(root, "home") });
    const job = createJob(home, { provider: "null", verb: "ask", status: "running", spawnedAt: new Date().toISOString() });
    const lines = [];
    for (let i = 0; i < 2000; i++) lines.push(JSON.stringify({ type: "text", data: `chunk ${i}` }));
    lines.push(JSON.stringify({ type: "item.completed", item: { type: "agent_message" } }));
    writeFileSync(join(job.dir, "events.jsonl"), lines.join("\n") + "\n" + "x".repeat(100));
    assert.equal(lastEvent(job), "item.completed:agent_message");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("catalog: an adapter's own static entry, merged with a refreshed file; malformed refreshed files are ignored", () => {
  const root = tmp();
  try {
    const home = homeDir({ COUNCIL_HOME: join(root, "home") });
    const cat = loadCatalog(home, "null", { staticEntry: nullAdapter.catalog });
    assert.equal(cat.source, "static");
    assert.deepEqual(cat.models["null-fast"], ["low", "medium"]);
    assert.equal(resolveModel("null", "fast", cat).id, "null-fast");
    assert.throws(() => loadCatalog(home, "null"), /unknown provider null/, "without its entry the name is unknown");
    mkdirSync(join(home, "catalog"), { recursive: true });
    for (const junk of ["not json", "[]", '{"models": 3}', "null"]) {
      writeFileSync(catalogPath(home, "null"), junk);
      assert.equal(loadCatalog(home, "null", { staticEntry: nullAdapter.catalog }).source, "static", `ignored: ${junk}`);
    }
    refreshCatalog(home, "null", { version: "null 0.0.1", loggedIn: true, models: { "null-model": ["low"], "null-new": ["high", "low"] } }, { now: () => "2026-11-01T00:00:00.000Z" });
    const merged = loadCatalog(home, "null", { staticEntry: nullAdapter.catalog });
    assert.deepEqual([merged.source, merged.updatedAt], ["refreshed", "2026-11-01T00:00:00.000Z"]);
    assert.deepEqual(merged.models["null-model"], ["low"], "the refreshed list wins per model");
    assert.deepEqual(merged.models["null-fast"], ["low", "medium"], "static entries the listing lacks stay");
    assert.deepEqual(resolveEffort("null", "null-model", "max", merged), { effort: "low", requested: "max", clamped: true, suffixed: false });
    const record = JSON.parse(readFileSync(catalogPath(home, "null"), "utf8"));
    assert.deepEqual([record.version, record.loggedIn], ["null 0.0.1", true]);
    assert.throws(() => refreshCatalog(home, "null", { models: null }), /null probe returned no model list/);
    assert.throws(() => refreshCatalog(home, "../x", { models: [] }), /unknown provider/);
    assert.throws(() => refreshCatalog(null, "null", { models: [] }), /needs the state root/);
    const viaFn = refreshCatalog(home, "null", () => ({ models: [{ id: "f", efforts: ["low", 7] }, { nope: 1 }] }));
    assert.deepEqual(viaFn.models, { f: ["low"] }, "non-string efforts and id-less entries are dropped");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tiers through an adapter's table: default, explicit, inherited tier kept, clamp recorded", () => {
  const cat = loadCatalog(null, "null", { staticEntry: nullAdapter.catalog });
  const tiers = { null: nullAdapter.tiers };
  assert.deepEqual(resolveTier("null", undefined, {}, cat, { tiers }), { tier: "consult", model: "null-model", modelVerified: true, alias: null, effort: "high", requestedEffort: "high", clamped: false, suffixed: false });
  assert.equal(resolveTier("null", "exec", { effort: "max" }, cat, { tiers }).effort, "medium");
  const kept = resolveTier("null", undefined, {}, cat, { tiers, inherited: { tier: "exec", model: "null-fast", effort: "low" }, tierExplicit: false });
  assert.deepEqual([kept.tier, kept.model, kept.effort], ["exec", "null-fast", "low"]);
  const override = resolveTier("null", undefined, { model: "null-model" }, cat, { tiers, inherited: { tier: "exec", model: "null-fast", effort: "low" }, tierExplicit: false });
  assert.deepEqual([override.model, override.effort], ["null-model", "low"], "an explicit model keeps the inherited effort");
  assert.throws(() => resolveTier("null", "deep", {}, cat, { tiers: { null: { consult: tiers.null.consult } } }), /no deep tier for null/);
});

test("A3.4 footer over every combination of verb, outcome and optional field", () => {
  const verbs = ["ask", "reply", "review", "task"];
  const outcomes = [["ok", "ok"], ["attention", "needs attention"], ["failed", "failed"], ["cancelled", "cancelled"]];
  const flags = ["clamped", "unverified", "clipped", "error", "pending", "edited", "unreviewed"];
  let checked = 0;
  for (const verb of verbs) for (const [outcome, label] of outcomes) for (let mask = 0; mask < 1 << flags.length; mask++) {
    const on = (f) => Boolean(mask & (1 << flags.indexOf(f)));
    const job = {
      provider: "grok", id: "abcdefghij123456", dir: "/j", verb, outcome, model: "grok-4.7", effort: on("clamped") ? "xhigh" : "high", requestedEffort: on("clamped") ? "max" : "high",
      modelVerified: !on("unverified"), round: 2, rounds: 9, threadId: "t", admitted: true, spawnedAt: "2026-10-31T10:00:00.000Z", endedAt: "2026-10-31T10:01:05.000Z",
      error: on("error") ? "boom" : null, cleanupPending: on("pending"), edited: on("edited") ? ["a", "b"] : [], unreviewed: on("unreviewed") ? ["x"] : [],
    };
    const parts = footer(job, on("clipped")).split(" · ");
    assert.equal(parts[0], `council grok ${label}`);
    assert.equal(parts[1], "job abcdefghij123456");
    assert.equal(parts[2], on("clamped") ? "grok-4.7/xhigh<=max" : "grok-4.7/high");
    assert.equal(parts[3], "1m05s");
    const rest = parts.slice(4);
    const expected = [
      ...(verb !== "review" ? ["round 2/9"] : []),
      ...(verb === "task" ? [`edited ${on("edited") ? 2 : 0}`] : []),
      ...(verb === "review" && on("unreviewed") ? ["unreviewed 1"] : []),
      ...(on("unverified") ? ["model unverified"] : []),
      ...(on("clipped") ? ["full: /j/answer.md"] : []),
      ...(on("error") ? ["error: boom"] : []),
      ...(on("pending") ? ["cleanup pending; next: cancel abcdefghij123456; do not resume"] : verb !== "review" ? ["next: reply abcdefghij123456"] : []),
    ];
    assert.deepEqual(rest, expected, `${verb} ${outcome} mask ${mask}`);
    checked += 1;
  }
  assert.equal(checked, 4 * 4 * 128);
  assert.equal(startLine({ provider: "gemini", id: "x", threadId: null, requestedThreadId: null }), "[council] provider=gemini job=x thread=?");
});
