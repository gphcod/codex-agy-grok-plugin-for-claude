// Milestone 3 review (Argon F5): adapter.checkRequest runs before the review target is resolved or a
// diff collected, so a refused review starts no git process, leaves no job and releases its request id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { main } from "../plugins/council/scripts/council.mjs";
import { GUARD_VARS } from "../plugins/council/scripts/lib/core/execution.mjs";
import { commitAll, initRepo, isolateGit } from "./fixtures/build-repos.mjs";

isolateGit();

function harness() {
  const root = mkdtempSync(join(tmpdir(), "council-check-order-"));
  const home = join(root, "home");
  const env = { ...process.env, COUNCIL_TEST_NULL_ADAPTER: "1", COUNCIL_HOME: home, COUNCIL_STDIN_DEADLINE_MS: "300", COUNCIL_NULL_NO_ADVERSARIAL: "1" };
  for (const g of GUARD_VARS) delete env[g];
  const call = async (argv, cwd) => {
    let out = "", err = "";
    const stdin = new PassThrough(); stdin.end("");
    const code = await main(argv, env, { stdout: { write: (s) => { out += s; return true; } }, stderr: { write: (s) => { err += s; return true; } }, stdin, cwd });
    return { code, out, err };
  };
  const jobs = () => { try { return readdirSync(join(home, "jobs")).filter((n) => /^[a-z0-9]{16}$/.test(n)); } catch { return []; } };
  return { root, home, call, jobs, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("a refused review fails on the adapter's refusal before any git work: outside a repository, and with nothing to review", async () => {
  const h = harness();
  try {
    const plain = join(h.root, "not-a-repo");
    mkdirSync(plain);
    const outside = await h.call(["review", "--to", "null", "--adversarial", "--request-id", "r1"], plain);
    assert.equal(outside.code, 2);
    assert.match(outside.err, /--adversarial has no tested mapping for null/, "the refusal, not a git error");
    assert.doesNotMatch(outside.err, /[Gg]it/);
    const repo = initRepo(join(h.root, "repo"));
    writeFileSync(join(repo, "a.txt"), "a\n");
    commitAll(repo, "one");
    const bad = await h.call(["review", "--to", "null", "--adversarial", "--commit", "no-such-ref"], repo);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /--adversarial has no tested mapping for null/, "the bad ref is never resolved");
    const empty = await h.call(["review", "--to", "null", "--adversarial", "--uncommitted"], repo);
    assert.match(empty.err, /--adversarial has no tested mapping for null/, "no collection: never `nothing to review`");
    assert.deepEqual(h.jobs(), []);
    assert.equal(existsSync(join(h.home, "claims", "requests")) ? readdirSync(join(h.home, "claims", "requests")).length : 0, 0, "the request id was released");
    // Without the refusal the same call reaches review resolution (the target check fails outside a repository).
    const allowed = await h.call(["review", "--to", "null", "--uncommitted"], plain);
    assert.equal(allowed.code, 2);
    assert.doesNotMatch(allowed.err, /no tested mapping/);
  } finally { h.done(); }
});
