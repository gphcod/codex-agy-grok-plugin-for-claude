// X2 (S7.1 fixes): a task's `edited N` is the union of the provider's edit events and a Git snapshot
// of the working tree taken before the spawn and after the turn. Real Git; the three fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unionEdited, statusPaths, worktreeChanges, worktreeSnapshot } from "../plugins/council/scripts/lib/core/git.mjs";
import { canonical } from "../plugins/council/scripts/lib/core/fs.mjs";
import { PROVIDERS, footer, harness } from "./fixtures/three-providers.mjs";
import { git, isolateGit } from "./fixtures/build-repos.mjs";

isolateGit();
const shellEdit = (...edits) => ({ COUNCIL_FAKE_SHELL_EDIT: JSON.stringify(edits) });
const edited = (r) => /· edited (\d+)/.exec(footer(r.out))?.[1];

test("every provider: an edit made through a shell, with no edit event, counts", async () => {
  const h = harness();
  try {
    for (const p of PROVIDERS) {
      const r = await h.turn(p, ["task", "--to", p, "--effort", "low"], `fix it on ${p}`, shellEdit(["calc.js", `// ${p}\n`]));
      assert.equal(r.code, 0, r.err + r.out);
      assert.equal(edited(r), "1", footer(r.out));
      assert.deepEqual(h.job(r.job).edited, ["calc.js"], p);
    }
  } finally { h.done(); }
});

test("an event edit and a shell edit of one file count once, whatever the event's spelling", async () => {
  const h = harness();
  try {
    for (const spelling of ["calc.js", "./calc.js", join(h.repo, "calc.js")]) {
      const r = await h.turn("grok", ["task", "--to", "grok", "--effort", "low"], `same file ${spelling}`, { ...shellEdit(["calc.js", `// ${spelling}\n`]), COUNCIL_FAKE_GROK_EDIT: spelling });
      assert.equal(r.code, 0, r.err + r.out);
      assert.equal(edited(r), "1", `${spelling}: ${footer(r.out)}`);
    }
    const two = await h.turn("grok", ["task", "--to", "grok", "--effort", "low"], "two files", { ...shellEdit(["other.js", "x\n"]), COUNCIL_FAKE_GROK_EDIT: "event-only.js" });
    assert.deepEqual(h.job(two.job).edited.sort(), ["event-only.js", "other.js"], "an event's path counts though nothing was written");
  } finally { h.done(); }
});

test("a new untracked file, a file dirty before and changed again, one left alone, one reverted to clean", async () => {
  const h = harness();
  const task = (text, env) => h.turn("codex", ["task", "--to", "codex", "--effort", "low"], text, env);
  try {
    const created = await task("new file", shellEdit(["dir-new.txt", "new\n"]));
    assert.deepEqual(h.job(created.job).edited, ["dir-new.txt"]);
    rmSync(join(h.repo, "dir-new.txt"));

    writeFileSync(join(h.repo, "calc.js"), "// dirty before the turn\n");
    const untouched = await task("touch nothing");
    assert.equal(edited(untouched), "0", "dirty before and unchanged is not this turn's edit");
    const again = await task("change it again", shellEdit(["calc.js", "// changed again\n"]));
    assert.deepEqual(h.job(again.job).edited, ["calc.js"]);

    const reverted = await task("revert it", shellEdit(["calc.js", "export const sum = (items) => { let s = 0; for (let i = 0; i < items.length; i++) s += items[i]; return s; };\n"]));
    assert.deepEqual(h.job(reverted.job).edited, ["calc.js"], "dirty before, clean after: the turn changed it");
    assert.equal(git(h.repo, ["status", "--porcelain"]).trim(), "", "the fixture really is clean again");

    const removed = await task("delete it", shellEdit(["calc.js", null]));
    assert.deepEqual(h.job(removed.job).edited, ["calc.js"]);
  } finally { h.done(); }
});

test("outside a repository the count stays event-only and the turn does not fail", async () => {
  const h = harness();
  try {
    rmSync(join(h.repo, ".git"), { recursive: true, force: true });
    const r = await h.turn("grok", ["task", "--to", "grok", "--effort", "low"], "no git", { ...shellEdit(["shell.js", "x\n"]), COUNCIL_FAKE_GROK_EDIT: "event.js" });
    assert.equal(r.code, 0, r.err + r.out);
    assert.deepEqual(h.job(r.job).edited, ["event.js"]);
  } finally { h.done(); }
});

test("read-only turns take no snapshot: a write they make is not reported as an edit", async () => {
  const h = harness();
  try {
    const r = await h.turn("codex", ["ask", "--to", "codex", "--effort", "low"], "only a question", shellEdit(["calc.js", "// written\n"]));
    assert.equal(r.code, 0, r.err + r.out);
    assert.doesNotMatch(footer(r.out), /edited/);
    assert.deepEqual(h.job(r.job).edited, []);
  } finally { h.done(); }
});

function repo() {
  const dir = canonical(mkdtempSync(join(tmpdir(), "council-snap-")));
  git(dir, ["init", "-q"]);
  writeFileSync(join(dir, "a.txt"), "a\n");
  writeFileSync(join(dir, "b.txt"), "b\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "one"]);
  return dir;
}
const rel = (dir, paths) => paths.map((p) => p.slice(dir.length + 1)).sort();

test("snapshot: HEAD moving counts what the commits changed; a commit of dirty work counts it", () => {
  const dir = repo();
  try {
    const before = worktreeSnapshot(dir);
    assert.deepEqual(before.states.size, 0);
    writeFileSync(join(dir, "a.txt"), "a2\n");
    git(dir, ["commit", "-q", "-am", "two"]);
    assert.deepEqual(rel(dir, worktreeChanges(dir, before)), ["a.txt"], "clean before and after: only the HEADs differ");
    git(dir, ["reset", "-q", "--hard", "HEAD~1"]);
    writeFileSync(join(dir, "b.txt"), "b2\n");
    const dirty = worktreeSnapshot(dir);
    git(dir, ["commit", "-q", "-am", "b"]);
    assert.deepEqual(rel(dir, worktreeChanges(dir, dirty)), ["b.txt"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("snapshot: a rename counts both sides; a chmod and a symlink target count; an unborn HEAD works", () => {
  const dir = repo();
  try {
    const before = worktreeSnapshot(dir);
    renameSync(join(dir, "a.txt"), join(dir, "c.txt"));
    git(dir, ["add", "-A"]);
    assert.deepEqual(rel(dir, worktreeChanges(dir, before)), ["a.txt", "c.txt"]);
    git(dir, ["reset", "-q", "--hard"]);
    if (process.platform !== "win32") {
      symlinkSync("a.txt", join(dir, "link"));
      const linked = worktreeSnapshot(dir);
      rmSync(join(dir, "link"));
      symlinkSync("b.txt", join(dir, "link"));
      assert.deepEqual(rel(dir, worktreeChanges(dir, linked)), ["link"]);
    }
    const fresh = canonical(mkdtempSync(join(tmpdir(), "council-snap-")));
    git(fresh, ["init", "-q"]);
    const unborn = worktreeSnapshot(fresh);
    assert.equal(unborn.head, null);
    writeFileSync(join(fresh, "first.txt"), "1\n");
    git(fresh, ["add", "-A"]);
    git(fresh, ["commit", "-q", "-m", "first"]);
    assert.deepEqual(rel(fresh, worktreeChanges(fresh, unborn)), ["first.txt"]);
    rmSync(fresh, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("snapshot: null outside a repository and over the cap; changes are then empty", () => {
  const dir = repo();
  const plain = canonical(mkdtempSync(join(tmpdir(), "council-plain-")));
  try {
    assert.equal(worktreeSnapshot(plain), null);
    assert.deepEqual(worktreeChanges(plain, null), []);
    writeFileSync(join(dir, "x.txt"), "x\n");
    writeFileSync(join(dir, "y.txt"), "y\n");
    assert.equal(worktreeSnapshot(dir, { cap: 1 }), null);
    assert.equal(worktreeSnapshot(dir, { cap: 2 }).states.size, 2);
    const before = worktreeSnapshot(dir);
    assert.deepEqual(worktreeChanges(dir, before, { cap: 1 }), [], "the second snapshot over the cap: event-only");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(plain, { recursive: true, force: true }); }
});

test("unionEdited: relative to the job cwd in a subdirectory, absolute outside it, each path once", () => {
  const dir = repo();
  const elsewhere = canonical(mkdtempSync(join(tmpdir(), "council-link-")));
  try {
    mkdirSync(join(dir, "sub"));
    const cwd = join(dir, "sub");
    assert.deepEqual(unionEdited(cwd, ["x.js", join(cwd, "x.js")], [join(dir, "a.txt")]), ["x.js", join(dir, "a.txt").replace(/\\/g, "/")]);
    if (process.platform !== "win32") {
      const spelled = join(elsewhere, "alias");
      symlinkSync(cwd, spelled);
      assert.deepEqual(unionEdited(cwd, [join(spelled, "x.js")], [join(cwd, "x.js")]), ["x.js"], "a symlinked spelling of the same file");
    }
    assert.deepEqual(unionEdited(cwd, ["../a.txt"], [join(dir, "a.txt")]), [join(dir, "a.txt").replace(/\\/g, "/")]);
    assert.deepEqual(unionEdited(cwd, ["gone/dir/x.js"], []), ["gone/dir/x.js"], "a directory that no longer exists");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); }
});

test("statusPaths: -z records, renames carry the old path, copies do not, a directory loses its slash", () => {
  assert.deepEqual(statusPaths(" M a.txt\0?? new file.txt\0R  to.txt\0from.txt\0C  copy.txt\0orig.txt\0?? sub/\0"), ["a.txt", "new file.txt", "to.txt", "from.txt", "copy.txt", "sub"]);
  assert.deepEqual(statusPaths(""), []);
});
