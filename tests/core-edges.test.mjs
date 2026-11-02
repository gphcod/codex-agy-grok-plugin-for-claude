// S2.7 (ratio): edge paths of the core not reached elsewhere — escalation to SIGKILL for a child that
// ignores SIGTERM, a companion interrupted mid-turn, held pipes released by stopping the holder,
// collection of deletions, binaries and quoted paths, PATH quirks, listing parse errors, and template
// loading from another plugin root.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nullAdapter from "./fixtures/null-adapter.mjs";
import { GUARD_VARS } from "./fixtures/fake-common.mjs";
import { commitAll, git, initRepo, isolateGit } from "./fixtures/build-repos.mjs";
import { parseModelListing } from "../plugins/council/scripts/lib/core/catalog.mjs";
import { executionController } from "../plugins/council/scripts/lib/core/execution.mjs";
import { collectReview, reviewTarget } from "../plugins/council/scripts/lib/core/git.mjs";
import { homeDir, loadJob } from "../plugins/council/scripts/lib/core/jobs.mjs";
import { pathCandidates } from "../plugins/council/scripts/lib/core/launcher.mjs";
import { runManagedTurn } from "../plugins/council/scripts/lib/core/lifecycle.mjs";
import { loadTemplate, renderReviewPrompt } from "../plugins/council/scripts/lib/core/review.mjs";

isolateGit();
const posix = process.platform !== "win32";
const tmp = (p = "council-edge-") => mkdtempSync(join(tmpdir(), p));

function turnSetup(childScript) {
  const root = tmp();
  const home = homeDir({ COUNCIL_HOME: join(root, "home") });
  const cwd = join(root, "work");
  mkdirSync(cwd);
  const env = { ...process.env };
  for (const g of GUARD_VARS) delete env[g];
  delete env.COUNCIL_FAKE_SCENARIO;
  if (childScript) { writeFileSync(join(root, "child.mjs"), childScript); env.COUNCIL_NULL_BIN = join(root, "child.mjs"); }
  const req = { verb: "ask", provider: "null", cwd, session: "s", tier: "consult", model: "null-model", effort: "high", requestedEffort: "high", modelVerified: true, thread: null, readOnly: true, text: "hi", contract: "<c/>", rounds: 9, round: 1 };
  return { root, home, cwd, env, req, ctx: { home, env, cwd, session: "s" }, done: () => rmSync(root, { recursive: true, force: true }) };
}
// A child that announces its thread, then ignores SIGTERM and never finishes.
const STUBBORN = `const i = process.argv.indexOf("--thread");
process.stdout.write(JSON.stringify({ type: "started", thread: process.argv[i + 1] }) + "\\n");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);`;

test("a child that ignores SIGTERM is killed after the grace by its verified identity", { skip: !posix }, async () => {
  const s = turnSetup(STUBBORN);
  try {
    const started = Date.now();
    const { job } = await runManagedTurn(s.ctx, nullAdapter, s.req, () => s.req, { deadlineMs: 400, inactivityMs: 30000 }, { drainMs: 150, shutdownMs: 8000, retryMs: 2000, graceMs: 300 });
    assert.equal(job.code, 1);
    assert.equal(job.error, "wall-clock deadline passed");
    assert.equal(job.cleanupPending, false, "the SIGKILL was confirmed by the rescan");
    assert.ok(Date.now() - started < 6000);
    assert.ok(loadJob(s.home, job.id).execution.some((r) => r.pid === job.pid), "the child's identity was recorded before it was signalled");
  } finally { s.done(); }
});

test("a companion interrupted mid-turn stops its child and fails the turn as interrupted", { skip: !posix }, async () => {
  const s = turnSetup(null);
  try {
    let jobId = null;
    const turn = runManagedTurn({ ...s.ctx, env: { ...s.env, COUNCIL_FAKE_SCENARIO: "slow", COUNCIL_FAKE_SLOW_MS: "30000" } }, nullAdapter, s.req, () => s.req, { deadlineMs: 30000, inactivityMs: 30000 }, { drainMs: 150, shutdownMs: 5000, graceMs: 200, announce: (j) => { jobId = j.id; } });
    for (const end = Date.now() + 5000; !(jobId && loadJob(s.home, jobId)?.pid); await new Promise((r) => setTimeout(r, 20))) assert.ok(Date.now() < end);
    process.emit("SIGHUP"); // the turn's handler only; no real signal is delivered to the test runner
    const { job } = await turn;
    assert.equal(job.code, 1);
    assert.equal(job.error, "interrupted");
    assert.equal(job.cleanupPending, false);
  } finally { s.done(); }
});

test("held pipes whose identified holder is stopped: the turn fails with the survivor stopped, not thread locked", { skip: !posix }, async () => {
  const s = turnSetup(null);
  try {
    // the grandchild that holds the pipes carries the --job operand, so the post-exit scan identifies it
    const holder = `const i = process.argv.indexOf("--thread"), j = process.argv.indexOf("--job");
const { spawn } = await import("node:child_process");
process.stdout.write(JSON.stringify({ type: "started", thread: process.argv[i + 1] }) + "\\n");
process.stdout.write(JSON.stringify({ type: "text", data: "answer" }) + "\\n" + JSON.stringify({ type: "done" }) + "\\n");
spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)", "--", "--job", process.argv[j + 1], process.env.TEMP ?? ""], { stdio: ["ignore", "inherit", "inherit"], detached: true }).unref();
process.exit(0);`;
    writeFileSync(join(s.root, "holder.mjs"), holder);
    const env = { ...s.env, COUNCIL_NULL_BIN: join(s.root, "holder.mjs") };
    const { job } = await runManagedTurn({ ...s.ctx, env }, nullAdapter, s.req, () => s.req, { deadlineMs: 30000, inactivityMs: 30000 }, { drainMs: 200, shutdownMs: 8000, pipeWaitMs: 400, graceMs: 200, control: executionController({ adapter: { ownsProcess: (row, j) => (row.argv ?? row.raw?.split(" ") ?? []).includes(j.id) } }) });
    assert.equal(job.code, 1);
    assert.equal(job.error, "owned execution survived the launcher");
    assert.equal(job.unattributedPipes, undefined, "the holder was identified, so this is not an unattributed pipe");
    assert.equal(job.cleanupPending, false);
  } finally { s.done(); }
});

test("a name with a space is reported without the tab Git ends its diff header with", () => {
  const base = tmp();
  try {
    const dir = initRepo(join(base, "repo"));
    writeFileSync(join(dir, "space name.txt"), "a\n");
    writeFileSync(join(dir, "gone name.txt"), "a\n");
    commitAll(dir, "base");
    writeFileSync(join(dir, "space name.txt"), "b\n");
    git(dir, ["rm", "-q", "gone name.txt"]);
    assert.deepEqual(collectReview(reviewTarget(dir, { uncommitted: true })).reviewed.sort(), ["gone name.txt", "space name.txt"]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("collection: deletions are named by their old path, a binary diff stays as context and counts as left out, odd names are decoded", () => {
  const base = tmp();
  try {
    const dir = initRepo(join(base, "repo"));
    writeFileSync(join(dir, "gone.txt"), "bye\n");
    writeFileSync(join(dir, "image.bin"), Buffer.from([0, 1, 2]));
    const tab = process.platform === "win32" ? "tab name.txt" : "tab\tname.txt"; // Windows forbids a tab in a name.
    writeFileSync(join(dir, tab), "t\n");
    const quote = process.platform === "win32" ? "quote name.txt" : "quote\"name.txt"; // Windows forbids a quote in a name.
    writeFileSync(join(dir, quote), "q\n");
    commitAll(dir, "base");
    git(dir, ["rm", "-q", "gone.txt"]);
    writeFileSync(join(dir, "image.bin"), Buffer.from([0, 9, 9, 9]));
    writeFileSync(join(dir, tab), "t2\n");
    writeFileSync(join(dir, quote), "q2\n");
    const c = collectReview(reviewTarget(dir, { uncommitted: true }));
    assert.deepEqual(c.reviewed.sort(), ["gone.txt", quote, tab].sort());
    assert.deepEqual(c.omitted, ["image.bin (binary)"]);
    assert.match(c.diff, /^Binary files a\/image\.bin and b\/image\.bin differ$/m);
    assert.match(c.diff, /^deleted file mode 100644$/m);
    if (process.platform !== "win32") assert.match(c.diff, /^\+\+\+ "b\/tab\\tname\.txt"$/m, "Git C-quotes the header; the name is decoded for coverage");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the native review route: flags and sentence for every target kind", () => {
  const base = tmp();
  try {
    const dir = initRepo(join(base, "repo"));
    writeFileSync(join(dir, "a"), "1\n");
    const head = commitAll(dir, "one");
    writeFileSync(join(dir, "a"), "2\n");
    assert.deepEqual(reviewTarget(dir, { uncommitted: true }).flags, ["--uncommitted"]);
    assert.match(reviewTarget(dir, { uncommitted: true }).sentence, /run `git status` and `git diff HEAD`/);
    const b = reviewTarget(dir, { base: "main" });
    assert.deepEqual(b.flags, ["--base", "main"]);
    assert.equal(b.sentence, `Review the changes from the merge base with "main" through the working tree, including untracked files; run \`git diff ${head}\` and \`git ls-files --others --exclude-standard\`.`);
    const c = reviewTarget(dir, { commit: head.slice(0, 8) });
    assert.deepEqual(c.flags, ["--commit", head.slice(0, 8)], "the ref is passed as the user gave it");
    assert.equal(c.sentence, `Review the changes introduced by commit "${head.slice(0, 8)}"; run \`git show ${head}\`.`);
    // A clean merge shows no patch in `git show`: the sentence names the first-parent diff the label promises.
    git(dir, ["reset", "-q", "--hard"]);
    git(dir, ["checkout", "-q", "-b", "topic"]);
    writeFileSync(join(dir, "b"), "1\n");
    commitAll(dir, "topic");
    git(dir, ["checkout", "-q", "main"]);
    git(dir, ["merge", "-q", "--no-ff", "-m", "merge", "topic"]);
    const m = reviewTarget(dir, { commit: "HEAD" });
    assert.equal(m.merge, true);
    assert.equal(m.sentence, `Review the changes introduced by commit "HEAD"; run \`git diff ${head} ${m.oid}\`.`);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("PATH quirks: relative entries resolve against this process, quoted Windows entries are unquoted, unreadable dirs skipped", { skip: !posix }, () => {
  const base = tmp();
  try {
    mkdirSync(join(base, "bin"));
    writeFileSync(join(base, "bin", "grok"), "#!/bin/sh\n");
    chmodSync(join(base, "bin", "grok"), 0o755);
    const cwd = process.cwd();
    process.chdir(base);
    try { assert.deepEqual(pathCandidates("grok", { PATH: "bin" }, "linux"), [join(realpathSync(base), "bin", "grok")]); }
    finally { process.chdir(cwd); }
    mkdirSync(join(base, "win dir"));
    writeFileSync(join(base, "win dir", "grok.exe"), "MZ");
    assert.deepEqual(pathCandidates("grok", { Path: `"${join(base, "win dir")}";${join(base, "missing")}`, PATHEXT: ".EXE" }, "win32"), [join(base, "win dir", "grok.exe")]);
    assert.deepEqual(pathCandidates("grok", { PATH: ":::" }, "linux"), []);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("listing parsers: malformed codex JSON, gemini lines outside the route, a grok logout", () => {
  assert.throws(() => parseModelListing("codex", "not json"), /codex debug models: not JSON/);
  assert.throws(() => parseModelListing("codex", '{"data": []}'), /unexpected shape/);
  assert.deepEqual(parseModelListing("codex", '{"models":[{"slug":"m","supported_reasoning_levels":[{"effort":"low"},{"bogus":1}]},{"name":"x"}]}').models, { m: ["low"] });
  const g = parseModelListing("gemini", "Fetching...\ngemini-5-pro\tGemini 5 Pro\nclaude-x-high\tC\n\n");
  assert.deepEqual(g.models, { "gemini-5-pro": [] }, "an unsuffixed id is listed without efforts");
  assert.deepEqual(g.families, {});
  const k = parseModelListing("grok", "Not logged in. Run grok login.\n");
  assert.equal(k.loggedIn, false);
  assert.deepEqual(k.models, {});
  assert.throws(() => parseModelListing("bard", ""), /unknown provider bard/);
});

test("templates load from another plugin root, and an unknown template name is refused there too", () => {
  const root = tmp();
  try {
    mkdirSync(join(root, "prompts"));
    writeFileSync(join(root, "prompts", "review.md"), "T={{TARGET_LABEL}} F={{USER_FOCUS}} G={{REVIEW_COLLECTION_GUIDANCE}} C={{COVERAGE_NOTE}} I={{REVIEW_INPUT}}");
    const out = renderReviewPrompt({ template: "review", collection: { label: "L", diff: "D\n", omitted: [] }, focus: "f", pluginRoot: root });
    assert.equal(out, "T=L F=f G=Use the repository context below as primary evidence. C=Every changed file is included below. I=D");
    assert.throws(() => loadTemplate("adversarial-review", root), /ENOENT/);
    assert.throws(() => loadTemplate("../review", root), /unknown review template/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
