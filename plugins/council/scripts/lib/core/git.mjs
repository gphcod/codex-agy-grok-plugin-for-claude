// Review targets and diff collection. Ported from codex-plugin-cc 2.3.2 lib/git.mjs (reviewTarget,
// defaultBranch), grok-build-plugin-cc 1.1.5 lib/review.mjs (collector, -z paths, lstat/readlink,
// O_NOFOLLOW readRegular, unquotePath, bound) and gemini-plugin-cc 2.1.0 lib/git.mjs:27 (gitPaths) and
// :354-365 (buildCollectionGuidance). Changes (PLAN.md S2 table, A5.2): the repository root is
// resolved only here, lazily; `--base` collects <merge-base>...working tree plus untracked files;
// `--uncommitted` never falls back to a default branch; `--commit` uses `diff-tree --root` for a
// non-merge commit (with -M, so renames read as in `git diff`) and the first-parent diff for a merge, and a commit whose parent object is missing
// (shallow boundary) exits 2. Every subprocess goes through the one runner below.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./catalog.mjs";

/** Diff text carried inline; beyond it whole per-file diffs and untracked files are listed as omitted. */
export const INLINE_CAP = 256 * 1024;
const DIFF_BUFFER = 64 * 1024 * 1024;
const OID = /^[0-9a-f]{40,64}$/i;

/** The core git runner. core.quotepath=false keeps non-ASCII paths readable; -z output is used for paths. */
export function git(cwd, args, { input, run = spawnSync, timeout = 15000 } = {}) {
  return run("git", ["-c", "core.quotepath=false", ...args], { cwd, input, encoding: "utf8", shell: false, windowsHide: true, timeout, maxBuffer: DIFF_BUFFER });
}
function checked(result, what) {
  if (result.error?.code === "ENOBUFS") throw new Error(`${what} exceeds ${DIFF_BUFFER} bytes; review a smaller range`);
  if (result.error || result.status !== 0) throw new Error(`${what} failed: ${(result.stderr || result.error?.message || "").trim().split(/\r?\n/)[0]}`);
  return result.stdout;
}
/** NUL-separated paths, exactly as on disk (gemini-plugin-cc gitPaths). */
export function gitPaths(cwd, args) {
  return checked(git(cwd, [...args, "-z"]), `git ${args[0]}`).split("\0").filter(Boolean);
}

export function repoRoot(cwd) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.error || top.status !== 0) throw new UsageError("review must run inside a Git repository");
  return top.stdout.trim();
}
function checkRef(ref, flag) {
  if (typeof ref !== "string" || !ref || ref.startsWith("-") || /[\r\n\0]/.test(ref)) throw new UsageError(`invalid ${flag} ref ${JSON.stringify(ref)}`);
}
export function oidOf(cwd, ref) {
  const r = git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  const oid = r.stdout?.trim();
  return r.status === 0 && OID.test(oid) ? oid : null;
}
/** origin/HEAD, then main, master, trunk (local before remote); fully qualified so a tag never wins. */
export function defaultBranch(cwd) {
  const head = git(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  const remote = head.status === 0 ? head.stdout.trim() : "";
  for (const ref of [remote, "refs/heads/main", "refs/remotes/origin/main", "refs/heads/master", "refs/remotes/origin/master", "refs/heads/trunk", "refs/remotes/origin/trunk"].filter(Boolean)) {
    const oid = oidOf(cwd, ref);
    // The short name is for labels only; resolution keeps the fully qualified ref and its oid, so a
    // tag with the branch's name never stands in for it (codex-plugin-cc lib/git.mjs:8).
    if (oid) return { ref: ref.replace(/^refs\/heads\//, ""), qualified: ref, oid };
  }
  throw new UsageError("could not find the default branch; pass --base <ref>");
}
/** Parent oids from the commit object itself, so a shallow boundary still lists the parent it lacks. */
export function commitParents(cwd, oid) {
  const body = checked(git(cwd, ["cat-file", "-p", oid]), "git cat-file");
  const header = body.split("\n\n")[0];
  return header.split("\n").filter((l) => l.startsWith("parent ")).map((l) => l.slice(7).trim());
}
const hasCommit = (cwd, oid) => git(cwd, ["cat-file", "-e", `${oid}^{commit}`]).status === 0;

/**
 * What a dirty tree is compared against: HEAD, or the empty tree when HEAD names a branch with no
 * commits yet. Any other failure to resolve HEAD is an error; a guessed base would hide deletions.
 */
function worktreeBase(cwd) {
  const head = git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!head.error && head.status === 0) return "HEAD";
  if (head.error || head.status !== 1) checked(head, "git rev-parse HEAD");
  const branch = git(cwd, ["symbolic-ref", "--quiet", "HEAD"]);
  const probe = !branch.error && branch.status === 0 ? git(cwd, ["rev-parse", "--verify", "--quiet", branch.stdout.trim()]) : null;
  if (!probe || probe.error || probe.status !== 1) throw new Error("git could not resolve HEAD");
  return checked(git(cwd, ["hash-object", "-t", "tree", "--stdin"], { input: "" }), "git hash-object").trim();
}

// --- task edits (S7.1 fix X2) -------------------------------------------------------------------------

/** Over this many dirty paths the snapshot is skipped and `edited` stays event-only. */
export const SNAPSHOT_CAP = 5000;
/** A larger file is compared by size and mtime, not read. */
export const SNAPSHOT_HASH_CAP = 64 * 1024 * 1024;

/** The paths of `git status --porcelain=v1 -z`: `XY path`, followed by the old path after a rename or copy. */
export function statusPaths(output) {
  const tokens = output.split("\0").filter(Boolean), paths = [];
  for (let i = 0; i < tokens.length; i++) {
    const xy = tokens[i].slice(0, 2);
    paths.push(tokens[i].slice(3));
    if (/[RC]/.test(xy)) { i += 1; if (xy.includes("R") && tokens[i]) paths.push(tokens[i]); }
  }
  return [...new Set(paths.map((p) => p.replace(/\/$/, "")))];
}
/** What a path holds now, as a string compared between snapshots. Never reads through a link. */
function pathState(file) {
  let st;
  try { st = fs.lstatSync(file); } catch { return "gone"; }
  if (st.isSymbolicLink()) { try { return `link:${fs.readlinkSync(file)}`; } catch { return "link"; } }
  if (st.isDirectory()) return "dir"; // An embedded repository or submodule; what is inside it is not hashed.
  if (!st.isFile()) return "other";
  const exec = st.mode & 0o111 ? "x" : "-";
  if (st.size > SNAPSHOT_HASH_CAP) return `big:${exec}:${st.size}:${st.mtimeMs}`;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const hash = createHash("sha1"), buffer = Buffer.allocUnsafe(64 * 1024);
    for (let n; (n = fs.readSync(fd, buffer, 0, buffer.length, null));) hash.update(buffer.subarray(0, n));
    return `file:${exec}:${hash.digest("hex")}`;
  } catch { return `unreadable:${st.size}:${st.mtimeMs}`; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* the state stands */ } }
}
/**
 * {root, head, states}: HEAD (null on an unborn branch) and a content state per dirty path, relative
 * to the repository root. Null outside a repository, on a git failure or over the cap: the caller
 * keeps the provider's own edit events. Never throws.
 */
export function worktreeSnapshot(cwd, { cap = SNAPSHOT_CAP } = {}) {
  try {
    const top = git(cwd, ["rev-parse", "--show-toplevel"]);
    if (top.error || top.status !== 0) return null;
    const root = top.stdout.replace(/\r?\n$/, "");
    const head = git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    if (head.error || (head.status !== 0 && head.status !== 1)) return null;
    const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (status.error || status.status !== 0) return null;
    const paths = statusPaths(status.stdout);
    if (paths.length > cap) return null;
    return { root, head: head.status === 0 ? head.stdout.trim() : null, states: new Map(paths.map((p) => [p, pathState(path.join(root, p))])) };
  } catch { return null; }
}
/**
 * The paths that changed since `before`, as absolute paths: state differs, plus what differs between
 * the two HEADs if HEAD moved. Empty when the second snapshot cannot be taken. Never throws.
 */
export function worktreeChanges(cwd, before, options) {
  const after = worktreeSnapshot(cwd, options);
  if (!before || !after || after.root !== before.root) return [];
  const changed = new Set();
  for (const [p, state] of before.states) if (after.states.get(p) !== state) changed.add(p);
  for (const p of after.states.keys()) if (!before.states.has(p)) changed.add(p);
  if (before.head !== after.head) {
    try {
      const empty = () => checked(git(after.root, ["hash-object", "-t", "tree", "--stdin"], { input: "" }), "git hash-object").trim();
      const moved = git(after.root, ["diff", "--name-only", "--no-renames", "-z", before.head ?? empty(), after.head ?? empty()]);
      if (!moved.error && moved.status === 0) for (const p of moved.stdout.split("\0").filter(Boolean)) changed.add(p);
    } catch { /* the states alone */ }
  }
  return [...changed].map((p) => path.join(after.root, p));
}
/**
 * The union of a turn's edit events and its snapshot changes, each path once, relative to the job
 * cwd when inside it and absolute otherwise. An event's path is compared through its real directory,
 * so a symlinked spelling of the same file counts once.
 */
export function unionEdited(cwd, events, changed) {
  let base = cwd;
  try { base = fs.realpathSync(cwd); } catch { /* as spelled */ }
  const shown = (p) => {
    let abs = path.resolve(base, p);
    try { abs = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch { /* a directory the turn removed: as spelled */ }
    const rel = path.relative(base, abs);
    return (rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : abs).replace(/\\/g, "/");
  };
  return [...new Set([...events, ...changed].map(shown))];
}

/**
 * Resolves the review target without collecting anything (A5.2). With no flag: a dirty tree is the
 * working tree, a clean one the branch against the default branch (codex-plugin-cc). → {kind, root,
 * ref, oid, base, merge, parents, label, flags, sentence}; `flags` and `sentence` are the native
 * `codex exec review` route (A2: flags without focus, sentence plus focus on stdin).
 */
export function reviewTarget(cwd, { base, commit, uncommitted } = {}) {
  if ([base, commit, uncommitted].filter((v) => v !== undefined && v !== false).length > 1) throw new UsageError("choose only one of --base, --commit and --uncommitted");
  const root = repoRoot(cwd);
  let fallback = null;
  if (base === undefined && commit === undefined && !uncommitted) {
    const status = checked(git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]), "git status");
    if (status) uncommitted = true;
    else fallback = defaultBranch(root);
  }
  if (commit !== undefined) {
    checkRef(commit, "--commit");
    const oid = oidOf(root, commit);
    if (!oid) throw new UsageError(`invalid --commit ref ${JSON.stringify(commit)}`);
    const parents = commitParents(root, oid);
    const missing = parents.find((p) => !hasCommit(root, p));
    if (missing) throw new UsageError(`commit ${oid.slice(0, 12)} has parent ${missing.slice(0, 12)} missing from this clone (shallow history); deepen the clone or review another commit`);
    const merge = parents.length > 1;
    const label = merge ? `commit ${oid.slice(0, 12)} (merge; first-parent diff against ${parents[0].slice(0, 12)})` : `commit ${oid.slice(0, 12)}${parents.length ? "" : " (root commit)"}`;
    return { kind: "commit", root, ref: commit, oid, parents, merge, label, flags: ["--commit", commit], sentence: `Review the changes introduced by commit ${JSON.stringify(commit)}; run \`git show ${oid}\`.` };
  }
  if (base !== undefined || fallback) {
    // An implicit base is the default branch already resolved: its qualified ref and oid, never the short name again.
    const ref = fallback ? fallback.qualified : base;
    if (!fallback) checkRef(base, "--base");
    const oid = fallback ? fallback.oid : oidOf(root, base);
    if (!oid) throw new UsageError(`invalid --base ref ${JSON.stringify(base)}`);
    const shown = fallback ? fallback.ref : base;
    const mb = git(root, ["merge-base", oid, "HEAD"]);
    if (mb.status !== 0 || !OID.test(mb.stdout.trim())) throw new UsageError(`--base ${shown} has no common ancestor with HEAD`);
    return { kind: "base", root, ref: shown, qualified: ref, oid, base: mb.stdout.trim(), merge: false, parents: [], label: `branch against ${shown} (${oid.slice(0, 12)}) plus working tree`, flags: ["--base", ref], sentence: `Review the changes on this branch against ${JSON.stringify(shown)}; run \`git diff ${oid}...HEAD\`.` };
  }
  return { kind: "uncommitted", root, ref: null, oid: null, merge: false, parents: [], label: "working tree (staged, unstaged and untracked)", flags: ["--uncommitted"], sentence: "Review the uncommitted changes in this working tree (staged, unstaged and untracked); run `git status` and `git diff HEAD`." };
}

const ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
/** A path as Git C-quotes it ("a/x\ty", octal bytes for anything else unusual), decoded. */
export function unquotePath(quoted) {
  // Plain text is encoded in whole runs, so characters outside the BMP stay intact.
  const parts = (quoted.match(/\\[0-7]{1,3}|\\.|[^\\]+/gsu) ?? []).map((t) => t[0] !== "\\" ? Buffer.from(t)
    : /[0-7]/.test(t[1]) ? Buffer.from([parseInt(t.slice(1), 8)])
    : ESCAPES[t[1]] !== undefined ? Buffer.from([ESCAPES[t[1]]]) : Buffer.from(t.slice(1)));
  return Buffer.concat(parts).toString("utf8");
}
/** The path one per-file diff is about: the new side, or the old side of a deletion. */
export function diffFileName(file) {
  const side = (re) => {
    const m = re.exec(file);
    if (!m) return null;
    return m[1] !== undefined ? unquotePath(m[1]) : m[2];
  };
  return side(/^\+\+\+ (?:"b\/((?:[^"\\]|\\.)*)"|b\/(.*))$/m)
    ?? side(/^rename to (?:"((?:[^"\\]|\\.)*)"|(.*))$/m)
    ?? side(/^--- (?:"a\/((?:[^"\\]|\\.)*)"|a\/(.*))$/m)
    ?? side(/^diff --git (?:"a\/((?:[^"\\]|\\.)*)"|a\/(.*?)) "?b\//)
    ?? "unknown file";
}

/**
 * A regular file's bytes, opened without following a symlink where the platform allows it, or null
 * when what was opened is no longer the regular file of the checked size (swapped for a link or FIFO, or grown).
 */
export function readRegular(file, size) {
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
  const fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== size) return null;
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
const isText = (buffer) => !buffer.subarray(0, 8192).includes(0);

/** Whole per-file diffs up to the cap, then untracked text files; everything left out is named. */
export function bound(root, diff, untracked, cap = INLINE_CAP) {
  const files = diff.split(/(?=^diff --git )/m).filter((f) => f.trim());
  const omitted = [], reviewed = [];
  let text = "", bytes = 0;
  const add = (name, part) => {
    const size = Buffer.byteLength(part);
    if (bytes + size > cap) { omitted.push(`${name} (over the inline cap)`); return false; }
    text += part; bytes += size; reviewed.push(name);
    return true;
  };
  for (const file of files) add(diffFileName(file), file.endsWith("\n") ? file : `${file}\n`);
  for (const name of untracked) {
    const header = `new untracked file ${name}\n`;
    let body;
    try {
      // lstat, never stat: an untracked symlink is reviewed as its link text, so a link to a file
      // outside the repository never puts that file's contents in the prompt.
      const file = path.join(root, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) { add(name, `new untracked symlink ${name} -> ${fs.readlinkSync(file)}\n`); continue; }
      if (!stat.isFile()) { omitted.push(`${name} (untracked, unsupported file type)`); continue; }
      // The size is checked before the file is read, so a large untracked log is never loaded.
      if (bytes + Buffer.byteLength(header) + stat.size + 1 > cap) { omitted.push(`${name} (over the inline cap)`); continue; }
      const content = readRegular(file, stat.size);
      if (content === null) { omitted.push(`${name} (untracked, changed while read)`); continue; }
      if (!isText(content)) { omitted.push(`${name} (untracked, binary)`); continue; }
      body = content.toString("utf8");
    } catch { omitted.push(`${name} (untracked, unreadable)`); continue; }
    add(name, `${header}${body}${body.endsWith("\n") ? "" : "\n"}`);
  }
  return { diff: text, omitted, reviewed, empty: !files.length && !untracked.length };
}

/**
 * Collects the diff for a collected-diff review (gemini, grok). Everything is collected from the
 * repository root with --no-relative: run from a subdirectory with diff.relative set, Git would
 * otherwise silently drop changes outside it. → {label, diff, omitted, reviewed, empty}
 */
export function collectReview(target, { cap = INLINE_CAP } = {}) {
  const { root } = target;
  const flags = ["--no-relative", "--no-color", "--no-ext-diff"];
  let diff, untracked = [];
  if (target.kind === "commit") {
    diff = target.merge
      ? checked(git(root, ["diff", ...flags, target.parents[0], target.oid, "--"]), "git diff")
      : checked(git(root, ["diff-tree", "--no-commit-id", "-p", "-M", "--root", "--no-color", "--no-ext-diff", target.oid, "--"]), "git diff-tree");
  } else {
    const from = target.kind === "base" ? target.base : worktreeBase(root);
    diff = checked(git(root, ["diff", ...flags, from, "--"]), "git diff");
    untracked = gitPaths(root, ["ls-files", "--others", "--exclude-standard"]);
  }
  return { label: target.label, ...bound(root, diff, untracked, cap) };
}

/** gemini-plugin-cc buildCollectionGuidance, provider-neutral: what the reviewer must read itself. */
export function buildCollectionGuidance(collection) {
  if (!collection.omitted?.length) return "Use the repository context below as primary evidence.";
  return [
    `${collection.omitted.length} changed file(s) are not included below (size limit, binary or unreadable). Read them directly by path before finalizing findings; they are reported as unreviewed whatever you conclude:`,
    ...collection.omitted.map((o) => `- ${o}`),
  ].join("\n");
}
