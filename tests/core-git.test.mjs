// S2.5: git.mjs — review targets and diff collection over the fixtures of tests/fixtures/build-repos.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { canonical } from "../plugins/council/scripts/lib/core/fs.mjs";
import { UsageError } from "../plugins/council/scripts/lib/core/args.mjs";
import {
  INLINE_CAP, bound, buildCollectionGuidance, collectReview, commitParents, defaultBranch, diffFileName, git as coreGit, gitPaths, oidOf, readRegular, repoRoot, reviewTarget, unquotePath,
} from "../plugins/council/scripts/lib/core/git.mjs";
import {
  branchRepo, commitAll, git, initRepo, isolateGit, mergeRepo, outsideSymlinkRepo, renamedSpaceRepo, rootCommitRepo, shallowClone, symlinkChangeRepo, tempDir,
} from "./fixtures/build-repos.mjs";

isolateGit();
const usage = (fn, re) => assert.throws(fn, (e) => e instanceof UsageError && (!re || re.test(e.message)));
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

const canSymlink = process.platform !== "win32" || (() => { const dir = tempDir(); try { symlinkSync("x", join(dir, "link")); return true; } catch { return false; } finally { cleanup(dir); } })();

test("repoRoot and the lazy root: outside a repository is a usage error", () => {
  const base = tempDir();
  try {
    usage(() => repoRoot(base), /review must run inside a Git repository/);
    usage(() => reviewTarget(base, { uncommitted: true }), /inside a Git repository/);
    const { dir } = rootCommitRepo(base);
    mkdirSync(join(dir, "sub"));
    assert.equal(repoRoot(join(dir, "sub")), canonical(dir));
  } finally { cleanup(base); }
});

test("--commit <root> yields the root commit's patch", () => {
  const base = tempDir();
  try {
    const { dir, root } = rootCommitRepo(base);
    const target = reviewTarget(dir, { commit: root });
    assert.equal(target.kind, "commit");
    assert.equal(target.oid, root);
    assert.deepEqual(target.parents, []);
    assert.match(target.label, /^commit [0-9a-f]{12} \(root commit\)$/);
    assert.deepEqual(target.flags, ["--commit", root]);
    assert.match(target.sentence, /git show [0-9a-f]{40}/);
    const c = collectReview(target);
    assert.equal(c.empty, false);
    assert.match(c.diff, /^diff --git a\/a.txt b\/a.txt\nnew file mode 100644/m);
    assert.match(c.diff, /^\+alpha$/m);
    assert.deepEqual(c.reviewed, ["a.txt"]);
    assert.deepEqual(c.omitted, []);
    assert.equal(c.label, target.label);
    // a short ref and HEAD resolve to the same commit
    assert.equal(reviewTarget(dir, { commit: root.slice(0, 10) }).oid, root);
    assert.equal(reviewTarget(dir, { commit: "HEAD" }).oid, root);
  } finally { cleanup(base); }
});

test("--commit of a merge yields the first-parent diff with the label saying so", () => {
  const base = tempDir();
  try {
    const { dir, merge, mainTip, feature } = mergeRepo(base);
    const target = reviewTarget(dir, { commit: merge });
    assert.equal(target.merge, true);
    assert.deepEqual(target.parents, [mainTip, feature]);
    assert.match(target.label, new RegExp(`^commit ${merge.slice(0, 12)} \\(merge; first-parent diff against ${mainTip.slice(0, 12)}\\)$`));
    const c = collectReview(target);
    assert.deepEqual(c.reviewed, ["feature.txt"], "first parent is main: the merge brings in feature.txt only");
    assert.match(c.diff, /^\+from feature$/m);
    assert.doesNotMatch(c.diff, /from main/);
    // a non-merge commit on the branch is its own diff
    const single = collectReview(reviewTarget(dir, { commit: mainTip }));
    assert.deepEqual(single.reviewed, ["main.txt"]);
    assert.doesNotMatch(single.diff, /^commit /m, "diff-tree --no-commit-id prints no commit header");
  } finally { cleanup(base); }
});

test("--commit of the shallow clone's boundary commit exits 2 and never yields a root-style patch", () => {
  const base = tempDir();
  try {
    const { dir, boundary, commits } = shallowClone(base);
    assert.equal(boundary, commits[2]);
    assert.deepEqual(commitParents(dir, boundary), [commits[1]], "the commit object still names its parent");
    usage(() => reviewTarget(dir, { commit: boundary }), new RegExp(`parent ${commits[1].slice(0, 12)} missing from this clone \\(shallow history\\)`));
    usage(() => reviewTarget(dir, { commit: "HEAD" }), /shallow history/);
    // the same commit in the full origin is fine and is not a root-style patch
    const full = collectReview(reviewTarget(join(base, "origin"), { commit: boundary }));
    assert.match(full.diff, /^\+three$/m);
    assert.doesNotMatch(full.diff, /^\+one$/m, "only the third line was added by that commit");
  } finally { cleanup(base); }
});

test("bad refs exit 2: unknown, option-like, multi-line, and more than one target", () => {
  const base = tempDir();
  try {
    const { dir } = rootCommitRepo(base);
    usage(() => reviewTarget(dir, { commit: "no-such-ref" }), /invalid --commit ref "no-such-ref"/);
    usage(() => reviewTarget(dir, { commit: "--output=/tmp/x" }), /invalid --commit ref/);
    usage(() => reviewTarget(dir, { base: "main\nHEAD" }), /invalid --base ref/);
    usage(() => reviewTarget(dir, { base: "" }), /invalid --base ref/);
    usage(() => reviewTarget(dir, { base: "nope" }), /invalid --base ref "nope"/);
    usage(() => reviewTarget(dir, { commit: "HEAD", uncommitted: true }), /choose only one of --base, --commit and --uncommitted/);
    usage(() => reviewTarget(dir, { base: "main", commit: "HEAD" }), /choose only one/);
    assert.equal(oidOf(dir, "no-such-ref"), null);
    // a blob is not a commit
    const blob = git(dir, ["rev-parse", "HEAD:a.txt"]);
    usage(() => reviewTarget(dir, { commit: blob }), /invalid --commit ref/);
  } finally { cleanup(base); }
});

test("--base includes committed branch changes, the working tree and untracked files, with -z paths", () => {
  const base = tempDir();
  try {
    const { dir } = branchRepo(base);
    writeFileSync(join(dir, "app.js"), "export const a = 3;\n");
    writeFileSync(join(dir, "notes with space.md"), "untracked note\n");
    mkdirSync(join(dir, "dir"));
    const odd = process.platform === "win32" ? "dir/odd here.txt" : "dir/tab\there.txt"; // Windows forbids a tab in a name.
    writeFileSync(join(dir, odd), "odd name\n");
    writeFileSync(join(dir, "ünïcode.txt"), "unicode name\n");
    const target = reviewTarget(dir, { base: "main" });
    assert.equal(target.kind, "base");
    assert.match(target.label, /^branch against main \([0-9a-f]{12}\) plus working tree$/);
    assert.deepEqual(target.flags, ["--base", "main"]);
    assert.equal(target.base, git(dir, ["merge-base", "main", "HEAD"]));
    const c = collectReview(target);
    assert.match(c.diff, /^-export const a = 1;$/m, "compared against the merge base, not HEAD");
    assert.match(c.diff, /^\+export const a = 3;$/m, "working tree included");
    assert.match(c.diff, /^new untracked file notes with space.md\nuntracked note$/m);
    assert.ok(c.diff.includes(`new untracked file ${odd}\nodd name\n`) || c.diff.endsWith(`new untracked file ${odd}\nodd name`), "-z keeps a tab in a path");
    assert.match(c.diff, /^new untracked file ünïcode.txt$/m);
    assert.deepEqual(c.reviewed.sort(), ["app.js", odd, "notes with space.md", "ünïcode.txt"].sort());
    // ignored files are not untracked changes
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    writeFileSync(join(dir, "debug.log"), "noise\n");
    const c2 = collectReview(reviewTarget(dir, { base: "main" }));
    assert.ok(c2.reviewed.includes(".gitignore"));
    assert.ok(!c2.reviewed.includes("debug.log"));
  } finally { cleanup(base); }
});

test("--base with no common ancestor exits 2", () => {
  const base = tempDir();
  try {
    const { dir } = rootCommitRepo(base);
    git(dir, ["checkout", "-q", "--orphan", "island"]);
    writeFileSync(join(dir, "island.txt"), "x\n");
    commitAll(dir, "island");
    usage(() => reviewTarget(dir, { base: "main" }), /no common ancestor/);
  } finally { cleanup(base); }
});

test("a tracked symlink change contributes link text", { skip: !canSymlink && "creating a symlink needs Developer Mode or elevation here" }, () => {
  const base = tempDir();
  try {
    const { dir, after, before } = symlinkChangeRepo(base);
    const c = collectReview(reviewTarget(dir, { commit: after }));
    assert.match(c.diff, /^-target-one.txt$/m);
    assert.match(c.diff, /^\+target-two.txt$/m);
    assert.doesNotMatch(c.diff, /^\+two$/m, "never the target's contents");
    assert.deepEqual(c.reviewed, ["link"]);
    // retarget again in the working tree: --uncommitted shows the link text too
    rmSync(join(dir, "link"));
    symlinkSync("elsewhere.txt", join(dir, "link"));
    const w = collectReview(reviewTarget(dir, { uncommitted: true }));
    assert.match(w.diff, /^\+elsewhere.txt$/m);
    assert.ok(before);
  } finally { cleanup(base); }
});

test("an untracked symlink to an outside file contributes its link text and never the target's contents", { skip: !canSymlink && "creating a symlink needs Developer Mode or elevation here" }, () => {
  const base = tempDir();
  try {
    const { dir, secret } = outsideSymlinkRepo(base);
    const target = reviewTarget(dir, {});
    assert.equal(target.kind, "uncommitted", "an untracked file makes the tree dirty");
    const c = collectReview(target);
    assert.match(c.diff, new RegExp(`^new untracked symlink leak -> ${secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    assert.doesNotMatch(c.diff, /TOP-SECRET-OUTSIDE-CONTENT/);
    assert.deepEqual(c.reviewed, ["leak"]);
    // the same for --base
    const b = collectReview(reviewTarget(dir, { base: "main" }));
    assert.doesNotMatch(b.diff, /TOP-SECRET/);
  } finally { cleanup(base); }
});

test("a renamed file with a space is named by its new path", () => {
  const base = tempDir();
  try {
    const { dir } = renamedSpaceRepo(base);
    const c = collectReview(reviewTarget(dir, { uncommitted: true }));
    assert.deepEqual(c.reviewed, ["new name.txt"]);
    assert.match(c.diff, /^rename from old name.txt$/m);
    assert.match(c.diff, /^rename to new name.txt$/m);
    const committed = commitAll(dir, "rename");
    const viaCommit = collectReview(reviewTarget(dir, { commit: committed }));
    assert.deepEqual(viaCommit.reviewed, ["new name.txt"], "diff-tree -M names the rename like git diff does");
  } finally { cleanup(base); }
});

test("--uncommitted excludes committed changes and never falls back to a default branch", () => {
  const base = tempDir();
  try {
    const { dir } = branchRepo(base);
    const clean = reviewTarget(dir, { uncommitted: true });
    assert.equal(clean.kind, "uncommitted");
    const empty = collectReview(clean);
    assert.equal(empty.empty, true, "a clean tree is empty, not the branch diff");
    assert.equal(empty.diff, "");
    assert.deepEqual(empty.reviewed, []);
    writeFileSync(join(dir, "app.js"), "export const a = 4;\n");
    git(dir, ["add", "app.js"]);
    writeFileSync(join(dir, "app.js"), "export const a = 5;\n");
    const c = collectReview(reviewTarget(dir, { uncommitted: true }));
    assert.match(c.diff, /^-export const a = 2;$/m, "against HEAD (the topic commit), not main");
    assert.match(c.diff, /^\+export const a = 5;$/m, "staged and unstaged in one patch");
    assert.doesNotMatch(c.diff, /a = 1/);
    // with no flag, a clean tree reviews the branch against the default branch
    git(dir, ["checkout", "-q", "--", "app.js"]);
    git(dir, ["reset", "-q", "--hard"]);
    const auto = reviewTarget(dir, {});
    assert.equal(auto.kind, "base");
    assert.equal(auto.ref, "main");
  } finally { cleanup(base); }
});

test("a branch with no commits yet compares its working tree against the empty tree", () => {
  const base = tempDir();
  try {
    const dir = initRepo(join(base, "fresh"));
    usage(() => reviewTarget(dir, {}), /could not find the default branch; pass --base/, "clean and commitless: no default branch to fall back on");
    writeFileSync(join(dir, "first.txt"), "first\n");
    git(dir, ["add", "first.txt"]);
    writeFileSync(join(dir, "loose.txt"), "loose\n");
    const target = reviewTarget(dir, {});
    assert.equal(target.kind, "uncommitted", "dirty → the working tree");
    const c = collectReview(target);
    assert.match(c.diff, /^\+first$/m);
    assert.deepEqual(c.reviewed.sort(), ["first.txt", "loose.txt"]);
  } finally { cleanup(base); }
});

test("defaultBranch prefers origin/HEAD, then main, master, trunk; none is a usage error", () => {
  const base = tempDir();
  try {
    const dir = initRepo(join(base, "names"));
    writeFileSync(join(dir, "x"), "x\n");
    commitAll(dir, "x");
    assert.equal(defaultBranch(dir).ref, "main");
    git(dir, ["branch", "-m", "main", "trunk"]);
    assert.equal(defaultBranch(dir).ref, "trunk");
    git(dir, ["branch", "master"]);
    assert.equal(defaultBranch(dir).ref, "master");
    git(dir, ["branch", "-m", "master", "develop"]);
    git(dir, ["branch", "-m", "trunk", "feature"]);
    usage(() => defaultBranch(dir), /could not find the default branch/);
    // a tag named main never wins over refs/heads/main
    git(dir, ["tag", "main"]);
    usage(() => defaultBranch(dir), /could not find the default branch/);
    git(dir, ["update-ref", "refs/remotes/origin/develop", "HEAD"]);
    git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"]);
    assert.equal(defaultBranch(dir).ref, "refs/remotes/origin/develop");
  } finally { cleanup(base); }
});

test("size limit: whole files over the cap are omitted and named; binary and special files too", () => {
  const base = tempDir();
  try {
    const { dir } = rootCommitRepo(base);
    writeFileSync(join(dir, "small.txt"), "small\n");
    writeFileSync(join(dir, "big.txt"), "y".repeat(5000) + "\n");
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    writeFileSync(join(dir, "a.txt"), "alpha\nbeta\ngamma\n");
    mkfifoSafe(join(dir, "pipe"));
    const c = collectReview(reviewTarget(dir, { uncommitted: true }), { cap: 2048 });
    assert.ok(c.reviewed.includes("a.txt"));
    assert.ok(c.reviewed.includes("small.txt"));
    assert.ok(c.omitted.includes("big.txt (over the inline cap)"));
    assert.ok(c.omitted.includes("blob.bin (untracked, binary)"));
    assert.ok(Buffer.byteLength(c.diff) <= 2048);
    assert.doesNotMatch(c.diff, /yyyy/);
    if (process.platform !== "win32" && c.omitted.some((o) => o.startsWith("pipe"))) assert.ok(c.omitted.includes("pipe (untracked, unsupported file type)"));
    assert.equal(INLINE_CAP, 256 * 1024);
    // a tracked file's diff over the cap is omitted whole, never cut
    writeFileSync(join(dir, "a.txt"), "z".repeat(3000) + "\n");
    const tracked = collectReview(reviewTarget(dir, { uncommitted: true }), { cap: 1024 });
    assert.ok(tracked.omitted.includes("a.txt (over the inline cap)"));
    assert.doesNotMatch(tracked.diff, /zzzz/);
  } finally { cleanup(base); }
});

/** A FIFO through mkfifo(1) where available; the unsupported-type path is also covered through bound() with a directory. */
function mkfifoSafe(p) {
  spawnSync("mkfifo", [p]);
}

test("bound(): unreadable and changed-while-read untracked files are omitted, never read through", () => {
  const base = tempDir();
  try {
    writeFileSync(join(base, "ok.txt"), "fine\n");
    writeFileSync(join(base, "locked.txt"), "secret\n");
    chmodSync(join(base, "locked.txt"), 0o000);
    mkdirSync(join(base, "adir"));
    const r = bound(base, "", ["ok.txt", "locked.txt", "adir", "missing.txt"], 4096);
    const modes = process.platform !== "win32"; // A Windows chmod cannot take read access away.
    assert.deepEqual(r.reviewed, modes ? ["ok.txt"] : ["ok.txt", "locked.txt"]);
    assert.ok(r.omitted.includes("adir (untracked, unsupported file type)"));
    assert.ok(r.omitted.includes("missing.txt (untracked, unreadable)"));
    if (modes && process.getuid?.() !== 0) assert.ok(r.omitted.includes("locked.txt (untracked, unreadable)"));
    assert.equal(r.empty, false);
    chmodSync(join(base, "locked.txt"), 0o600);
    assert.equal(readRegular(join(base, "ok.txt"), 999), null, "size changed since the stat");
    assert.equal(readRegular(join(base, "ok.txt"), 5).toString(), "fine\n");
    if (canSymlink && fs.constants.O_NOFOLLOW) { // Windows has no O_NOFOLLOW.
      symlinkSync(join(base, "ok.txt"), join(base, "via-link"));
      assert.throws(() => readRegular(join(base, "via-link"), 5), /ELOOP|EMLINK|symbolic/i, "O_NOFOLLOW refuses a symlink");
    }
    assert.deepEqual(bound(base, "", [], 10), { diff: "", omitted: [], reviewed: [], empty: true });
  } finally { cleanup(base); }
});

test("unquotePath and diffFileName decode Git's C-quoted paths", () => {
  assert.equal(unquotePath("plain/path.txt"), "plain/path.txt");
  assert.equal(unquotePath("a\\tb"), "a\tb");
  assert.equal(unquotePath('q\\"uote'), 'q"uote');
  assert.equal(unquotePath("back\\\\slash"), "back\\slash");
  assert.equal(unquotePath("\\303\\274ber"), "über");
  assert.equal(unquotePath("emoji 😀"), "emoji 😀");
  assert.equal(diffFileName("diff --git a/x.js b/x.js\nindex 1..2\n--- a/x.js\n+++ b/x.js\n@@"), "x.js");
  assert.equal(diffFileName('diff --git "a/t\\tb" "b/t\\tb"\n--- "a/t\\tb"\n+++ "b/t\\tb"\n'), "t\tb");
  assert.equal(diffFileName("diff --git a/gone.js b/gone.js\ndeleted file mode 100644\n--- a/gone.js\n+++ /dev/null\n"), "gone.js");
  assert.equal(diffFileName("diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\n"), "new");
  assert.equal(diffFileName("diff --git a/bin.dat b/bin.dat\nBinary files a/bin.dat and b/bin.dat differ\n"), "bin.dat");
  assert.equal(diffFileName("garbage"), "unknown file");
});

test("gitPaths returns -z paths; the core runner reports failures", () => {
  const base = tempDir();
  try {
    const { dir } = rootCommitRepo(base);
    const odd = process.platform === "win32" ? "line break.txt" : "line\nbreak.txt"; // Windows forbids a newline in a name.
    writeFileSync(join(dir, odd), "x\n");
    assert.deepEqual(gitPaths(dir, ["ls-files", "--others", "--exclude-standard"]), [odd]);
    assert.throws(() => gitPaths(dir, ["no-such-command"]), /git no-such-command failed/);
    const r = coreGit(dir, ["rev-parse", "HEAD"]);
    assert.equal(r.status, 0);
    let seen = null;
    coreGit(dir, ["status"], { run: (cmd, args, opts) => { seen = { cmd, args, opts }; return { status: 0, stdout: "" }; } });
    assert.equal(seen.cmd, "git");
    assert.deepEqual(seen.args.slice(0, 2), ["-c", "core.quotepath=false"]);
    assert.equal(seen.opts.shell, false);
    assert.equal(seen.opts.cwd, dir);
  } finally { cleanup(base); }
});

test("buildCollectionGuidance: inline context, or the files the reviewer must read itself", () => {
  assert.equal(buildCollectionGuidance({ omitted: [] }), "Use the repository context below as primary evidence.");
  const g = buildCollectionGuidance({ omitted: ["big.txt (over the inline cap)", "x.bin (untracked, binary)"] });
  assert.match(g, /^2 changed file\(s\) are not included below/);
  assert.match(g, /\n- big.txt \(over the inline cap\)\n- x.bin \(untracked, binary\)$/);
});
