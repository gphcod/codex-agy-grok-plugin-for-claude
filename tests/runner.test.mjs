import { test } from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover, isDefaultName, isLiveName, isLiveSelection } from "../scripts/run-tests.mjs";

function fixtureTree() {
  const dir = mkdtempSync(join(tmpdir(), "council-runner-"));
  mkdirSync(join(dir, "live", "nested"), { recursive: true });
  mkdirSync(join(dir, "fixtures"), { recursive: true });
  const names = [
    "core-args.test.mjs",
    "catalog.test.mjs",
    "codex.live.test.mjs",
    "live/codex.live.test.mjs",
    "live/nested/agy.live.test.mjs",
    "live/helper.mjs",
    "live/stray.test.mjs",
    "fixtures/fake-codex.mjs",
    "notes.md",
  ];
  for (const n of names) writeFileSync(join(dir, n), "");
  return dir;
}

test("default and live selections are disjoint and cover the right files", () => {
  const dir = fixtureTree();
  try {
    const def = discover(dir, "default").map((f) => f.slice(dir.length + 1));
    const live = discover(dir, "live").map((f) => f.slice(dir.length + 1));
    assert.deepEqual(def, ["catalog.test.mjs", "core-args.test.mjs"]);
    assert.deepEqual(live, ["live/codex.live.test.mjs", "live/nested/agy.live.test.mjs"]);
    assert.equal(def.filter((f) => live.includes(f)).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a live file name never matches the default pattern", () => {
  for (const name of ["x.live.test.mjs", "live/x.test.mjs", "live/deep/x.live.test.mjs", "a/live/b.test.mjs"]) {
    assert.equal(isLiveName(name), true, name);
    assert.equal(isDefaultName(name), false, name);
  }
  assert.equal(isDefaultName("core-jobs.test.mjs"), true);
  assert.equal(isLiveSelection("x.live.test.mjs"), false, "a live-named file outside tests/live is in neither set");
});

test("an unknown argument exits 2 and runs no test set", () => {
  const r = spawnSync(process.execPath, ["scripts/run-tests.mjs", "--live", "--help"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown argument --help/);
});
