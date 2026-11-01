// Builds the Git fixtures of PLAN.md S2.5 on demand, each in a fresh temporary directory: a root-commit
// repository, a shallow clone of a three-commit repository, a merge, a symlink change, an untracked
// symlink to a file outside the repository, and a renamed file with a space. Git runs with the user's
// global and system configuration switched off, so hooks, signing or a default branch name cannot
// change what the fixtures contain.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Environment for every git call in the tests (fixtures and the code under test alike). */
export const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_AUTHOR_DATE: "2026-10-31T10:00:00Z", GIT_COMMITTER_DATE: "2026-10-31T10:00:00Z",
};

/** Applies GIT_ENV to this process, so the code under test sees the same isolated configuration. */
export function isolateGit() {
  Object.assign(process.env, GIT_ENV);
}

export function git(cwd, args, input) {
  const r = spawnSync("git", ["-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd, input, encoding: "utf8", env: { ...process.env, ...GIT_ENV },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

export function tempDir(prefix = "council-repo-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  return dir;
}
function commitAll(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** One commit, `a.txt`; returns {dir, root}. */
export function rootCommitRepo(base = tempDir()) {
  const dir = initRepo(join(base, "root-commit"));
  writeFileSync(join(dir, "a.txt"), "alpha\nbeta\n");
  const root = commitAll(dir, "root");
  return { dir, root };
}

/** Three commits in `origin`, then `git clone --depth 1`; the clone's HEAD has a missing parent. */
export function shallowClone(base = tempDir()) {
  const origin = initRepo(join(base, "origin"));
  const commits = [];
  for (const [i, text] of ["one\n", "one\ntwo\n", "one\ntwo\nthree\n"].entries()) {
    writeFileSync(join(origin, "f.txt"), text);
    commits.push(commitAll(origin, `c${i + 1}`));
  }
  const dir = join(base, "shallow");
  git(base, ["clone", "-q", "--depth", "1", `file://${origin}`, dir]);
  return { dir, origin, commits, boundary: git(dir, ["rev-parse", "HEAD"]) };
}

/** main: base commit; feature: one commit; main: one commit; then a --no-ff merge of feature into main. */
export function mergeRepo(base = tempDir()) {
  const dir = initRepo(join(base, "merge"));
  writeFileSync(join(dir, "base.txt"), "base\n");
  const first = commitAll(dir, "base");
  git(dir, ["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(dir, "feature.txt"), "from feature\n");
  const feature = commitAll(dir, "feature work");
  git(dir, ["checkout", "-q", "main"]);
  writeFileSync(join(dir, "main.txt"), "from main\n");
  const mainTip = commitAll(dir, "main work");
  git(dir, ["merge", "-q", "--no-ff", "-m", "merge feature", "feature"]);
  return { dir, first, feature, mainTip, merge: git(dir, ["rev-parse", "HEAD"]) };
}

/** A committed symlink `link -> target-one.txt`, then (committed) retargeted to `target-two.txt`. */
export function symlinkChangeRepo(base = tempDir()) {
  const dir = initRepo(join(base, "symlink"));
  writeFileSync(join(dir, "target-one.txt"), "one\n");
  writeFileSync(join(dir, "target-two.txt"), "two\n");
  symlinkSync("target-one.txt", join(dir, "link"));
  const before = commitAll(dir, "add link");
  rmSync(join(dir, "link"));
  symlinkSync("target-two.txt", join(dir, "link"));
  const after = commitAll(dir, "retarget link");
  return { dir, before, after };
}

/** A clean repository plus an untracked symlink to a secret file outside it. */
export function outsideSymlinkRepo(base = tempDir()) {
  const secret = join(base, "secret.txt");
  writeFileSync(secret, "TOP-SECRET-OUTSIDE-CONTENT\n");
  const dir = initRepo(join(base, "outside"));
  writeFileSync(join(dir, "README.md"), "readme\n");
  const head = commitAll(dir, "readme");
  symlinkSync(secret, join(dir, "leak"));
  return { dir, secret, head };
}

/** `old name.txt` committed, then `git mv` to `new name.txt` (staged, not committed). */
export function renamedSpaceRepo(base = tempDir()) {
  const dir = initRepo(join(base, "rename"));
  writeFileSync(join(dir, "old name.txt"), "content that moves\nline two\n");
  const head = commitAll(dir, "old name");
  git(dir, ["mv", "old name.txt", "new name.txt"]);
  return { dir, head };
}

/** A repository on `main` with one commit, a topic branch with one commit, and a dirty tree on the branch. */
export function branchRepo(base = tempDir()) {
  const dir = initRepo(join(base, "branch"));
  writeFileSync(join(dir, "app.js"), "export const a = 1;\n");
  const main = commitAll(dir, "main");
  git(dir, ["checkout", "-q", "-b", "topic"]);
  writeFileSync(join(dir, "app.js"), "export const a = 2;\n");
  const topic = commitAll(dir, "topic change");
  return { dir, main, topic };
}

export { commitAll, initRepo };
