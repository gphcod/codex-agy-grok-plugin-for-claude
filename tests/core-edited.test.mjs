// X2 (S7.1 fixes): a task's `edited N` is the union of the provider's edit events and a Git snapshot
// of the working tree taken before the spawn and after the turn. Real Git; the three fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SNAPSHOT, readBounded, sameEntry, statusPaths, unionEdited, worktreeChanges, worktreeSnapshot } from "../plugins/council/scripts/lib/core/git.mjs";
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
    assert.equal(worktreeSnapshot(dir, { maxFiles: 1 }), null);
    assert.equal(worktreeSnapshot(dir, { maxFiles: 2 }).states.size, 2);
    const before = worktreeSnapshot(dir);
    assert.deepEqual(worktreeChanges(dir, before, { maxFiles: 1 }), [], "the second snapshot over the cap: event-only");
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

test("bounds: the same as the twin's, and the whole snapshot stays well under the 30 s heartbeat", () => {
  assert.deepEqual({ ...SNAPSHOT }, { maxFiles: 5000, maxBytes: 4 * 1024 * 1024, timeoutMs: 2500, totalMs: 10000 });
});

test("byte budget: an oversized file compares by size and mtime; exhausting it does not read as a change", () => {
  const dir = repo();
  try {
    const big = join(dir, "big.bin");
    writeFileSync(big, "x".repeat(500));
    utimesSync(big, 1700000000, 1700000000); // Whole seconds, so setting it again gives the same mtime.
    const before = worktreeSnapshot(dir, { maxBytes: 200 });
    assert.equal(before.states.get("big.bin").hash, null, "never hashed");
    assert.equal(before.states.get("big.bin").size, 500);
    assert.deepEqual(worktreeChanges(dir, before, { maxBytes: 200 }), [], "unchanged");

    writeFileSync(big, "y".repeat(500));
    utimesSync(big, 1700000000, 1700000000);
    assert.deepEqual(worktreeChanges(dir, before, { maxBytes: 200 }), [], "known limit: same size and mtime reads as unchanged");
    writeFileSync(big, "y".repeat(501));
    assert.deepEqual(rel(dir, worktreeChanges(dir, before, { maxBytes: 200 })), ["big.bin"], "a new size counts");
    rmSync(big);

    // Which file gets hashed depends on the others: hashed on one side and measured on the other is no change.
    writeFileSync(join(dir, "a.txt"), "a".repeat(60));
    writeFileSync(join(dir, "b.txt"), "b".repeat(60));
    const roomy = worktreeSnapshot(dir, { maxBytes: 1000 });
    assert.ok(roomy.states.get("b.txt").hash);
    const tight = worktreeSnapshot(dir, { maxBytes: 100 });
    assert.deepEqual([tight.states.get("a.txt").hash === null, tight.states.get("b.txt").hash === null], [false, true], "the budget ran out at the second file");
    assert.deepEqual(worktreeChanges(dir, roomy, { maxBytes: 100 }), []);
    writeFileSync(join(dir, "b.txt"), "b".repeat(61));
    assert.deepEqual(rel(dir, worktreeChanges(dir, roomy, { maxBytes: 100 })), ["b.txt"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readBounded: a file that grows while it is read, or does not fit, is not hashed", () => {
  const dir = canonical(mkdtempSync(join(tmpdir(), "council-read-")));
  try {
    const file = join(dir, "f");
    writeFileSync(file, "12345");
    assert.equal(readBounded(file, 100).toString(), "12345");
    assert.equal(readBounded(file, 5).toString(), "12345", "exactly the budget");
    assert.equal(readBounded(file, 4), null);
    const growing = { ...fs, readSync: (...args) => { appendFileSync(file, "more"); return fs.readSync(...args); } };
    assert.equal(readBounded(file, 100, growing), null);
    const before = statSync(file).size;
    const late = { ...fs, fstatSync: ((calls) => (fd) => { const st = fs.fstatSync(fd); calls += 1; return calls === 2 ? { ...st, size: st.size + 1, isFile: () => true } : st; })(0) };
    assert.equal(readBounded(file, 100, late), null, "the size changed after the read");
    assert.equal(statSync(file).size, before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a FIFO never blocks: read directly, listed as a tracked file's replacement, or swapped in after the lstat", { skip: process.platform === "win32" }, () => {
  const dir = repo();
  try {
    const before = worktreeSnapshot(dir);
    rmSync(join(dir, "a.txt"));
    assert.equal(spawnSync("mkfifo", [join(dir, "a.txt")]).status, 0);
    assert.equal(readBounded(join(dir, "a.txt"), 100), null, "O_NONBLOCK opens it, fstat refuses it");
    const after = worktreeSnapshot(dir);
    assert.equal(after.states.get("a.txt").kind, "other");
    assert.deepEqual(rel(dir, worktreeChanges(dir, before)), ["a.txt"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("time bound through an injected clock: past the wall clock at any step is not listed whole", () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, "x.txt"), "x\n");
    writeFileSync(join(dir, "y.txt"), "y\n");
    // Each read of the clock advances it; the snapshot reads it once per step.
    const ticking = (step) => { let t = 0; return () => (t += step); };
    assert.ok(worktreeSnapshot(dir, { now: ticking(1) }), "well inside the bound");
    assert.equal(worktreeSnapshot(dir, { now: ticking(20000) }), null, "past it before the first git call");
    let reads = 0;
    const lateInLoop = () => { reads += 1; return reads > 8 ? 20000 : 0; };
    assert.equal(worktreeSnapshot(dir, { now: lateInLoop }), null, "past it while hashing");
    assert.ok(reads > 8, "reached the per-path check");
    const before = worktreeSnapshot(dir);
    assert.deepEqual(worktreeChanges(dir, before, { now: ticking(20000) }), [], "the second snapshot past it: event-only");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a git call that fails, times out or overflows its byte bound is not listed whole", () => {
  const dir = repo();
  try {
    const failing = (word, result) => (cmd, args, opts) => (args.includes(word) ? result : spawnSync(cmd, args, opts));
    assert.equal(worktreeSnapshot(dir, { run: failing("status", { error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }), stdout: Buffer.alloc(0) }) }), null);
    assert.equal(worktreeSnapshot(dir, { run: failing("status", { status: 128, stdout: Buffer.alloc(0) }) }), null);
    assert.equal(worktreeSnapshot(dir, { run: failing("HEAD^{commit}", { status: 128, stdout: Buffer.alloc(0) }) }), null);
    writeFileSync(join(dir, "long-name-for-the-listing.txt"), "x\n");
    assert.equal(worktreeSnapshot(dir, { maxBytes: 8 }), null, "real git: the listing itself is over the bound");
    const seen = [];
    worktreeSnapshot(dir, { run: (cmd, args, opts) => { seen.push([args[0], opts.timeout, opts.maxBuffer, opts.env.GIT_OPTIONAL_LOCKS]); return spawnSync(cmd, args, opts); } });
    assert.ok(seen.every(([first, timeout, maxBuffer, locks]) => first === "--no-optional-locks" && timeout <= 2500 && maxBuffer === SNAPSHOT.maxBytes && locks === "0"), JSON.stringify(seen));
    const before = worktreeSnapshot(dir);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "moved"]);
    assert.deepEqual(worktreeChanges(dir, before, { run: failing("diff", { status: 128, stdout: Buffer.alloc(0) }) }), [], "HEAD moved and its diff failed: event-only");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sameEntry: kinds, link targets, one missing hash, absent entries", () => {
  const file = (over) => ({ kind: "file", exec: false, size: 1, mtimeMs: 1, hash: "h", ...over });
  assert.equal(sameEntry(file(), file({ mtimeMs: 2 })), true, "two hashes ignore a touch");
  assert.equal(sameEntry(file(), file({ hash: "other" })), false);
  assert.equal(sameEntry(file(), file({ hash: null })), true);
  assert.equal(sameEntry(file(), file({ hash: null, mtimeMs: 2 })), false);
  assert.equal(sameEntry(file(), { kind: "gone" }), false);
  assert.equal(sameEntry({ kind: "gone" }, { kind: "gone" }), true);
  assert.equal(sameEntry({ kind: "link", target: "a" }, { kind: "link", target: "b" }), false);
  assert.equal(sameEntry(file(), undefined), false);
});

test("real Git: chmod +x counts, on an already dirty file and on a clean one", { skip: process.platform === "win32" }, () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, "a.txt"), "dirty\n");
    const before = worktreeSnapshot(dir);
    assert.equal(before.states.get("a.txt").exec, false);
    fs.chmodSync(join(dir, "a.txt"), 0o755);
    assert.deepEqual(rel(dir, worktreeChanges(dir, before)), ["a.txt"], "same content, new mode");
    assert.equal(worktreeSnapshot(dir).states.get("a.txt").exec, true);
    const clean = worktreeSnapshot(dir);
    fs.chmodSync(join(dir, "b.txt"), 0o755);
    assert.deepEqual(rel(dir, worktreeChanges(dir, clean)), ["b.txt"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

