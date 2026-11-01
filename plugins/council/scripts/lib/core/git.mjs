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

/**
 * Bounds of one snapshot, the same as the Codex-host twin's lib/core/snapshot.mjs: dirty paths listed,
 * bytes hashed in total and per git call's output, ms per git call, ms for the whole snapshot. It runs
 * synchronously and the heartbeat goes stale after 30 s, so the whole snapshot stays well under that.
 */
export const SNAPSHOT = Object.freeze({ maxFiles: 5000, maxBytes: 4 * 1024 * 1024, timeoutMs: 2500, totalMs: 10000 });
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

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
/**
 * A regular file's bytes, or null when it is not one, does not fit in `remaining` or changes size while
 * it is read. O_NONBLOCK: a file swapped for a FIFO after its lstat never blocks the open.
 */
export function readBounded(file, remaining, io = fs) {
  const fd = io.openSync(file, READ_FLAGS);
  try {
    const stat = io.fstatSync(fd);
    if (!stat.isFile()) return null;
    const buffer = Buffer.alloc(Math.min(stat.size + 1, remaining + 1));
    let got = 0;
    for (let n; got < buffer.length && (n = io.readSync(fd, buffer, got, buffer.length - got, got)); got += n);
    return got > remaining || got !== stat.size || io.fstatSync(fd).size !== stat.size ? null : buffer.subarray(0, got);
  } finally { io.closeSync(fd); }
}
/** What a path holds now. A file past the byte budget, or unreadable, keeps `hash: null` and compares by size and mtime. */
function pathEntry(file, budget) {
  let st;
  try { st = fs.lstatSync(file); }
  catch (error) { return error.code === "ENOENT" || error.code === "ENOTDIR" ? { kind: "gone" } : { kind: "unreadable" }; }
  if (st.isSymbolicLink()) { try { return { kind: "link", target: fs.readlinkSync(file) }; } catch { return { kind: "link", target: null }; } }
  if (st.isDirectory()) return { kind: "dir" }; // An embedded repository or submodule; what is inside it is not hashed.
  if (!st.isFile()) return { kind: "other" };
  const entry = { kind: "file", exec: Boolean(st.mode & 0o111), size: st.size, mtimeMs: st.mtimeMs, hash: null };
  if (st.size > budget.left) return entry;
  let data = null;
  try { data = readBounded(file, budget.left); } catch { /* by size and mtime */ }
  if (!data) return entry;
  budget.left -= data.length;
  return { ...entry, hash: createHash("sha1").update(data).digest("hex") };
}
/** Same content. Which side ran out of budget depends on the other dirty files, so one missing hash compares by size and mtime. */
export function sameEntry(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "link") return a.target === b.target;
  if (a.kind !== "file") return true;
  if (a.exec !== b.exec) return false;
  return a.hash !== null && b.hash !== null ? a.hash === b.hash : a.size === b.size && a.mtimeMs === b.mtimeMs;
}
/** One bounded git call of a snapshot, as bytes; takes no optional lock while the provider may be working. */
function boundedGit(cwd, args, { timeoutMs, maxBytes, run, input }) {
  return run("git", ["--no-optional-locks", ...args], { cwd, input, env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" }, encoding: "buffer", shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: maxBytes });
}
const bounds = (options) => ({ ...SNAPSHOT, run: spawnSync, now: Date.now, ...options });
/** Git's path bytes as text. Throws on invalid UTF-8: two such names could decode to one and compare equal. */
const strictUtf8 = (bytes) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
/**
 * {root, head, states}: HEAD (null on an unborn branch) and an entry per dirty path, relative to the
 * repository root. Null when the tree cannot be listed whole (outside a repository, a git failure or
 * timeout, output past the byte bound, a path that is not UTF-8, over maxFiles or past the wall clock): the caller keeps the
 * provider's own edit events. Past the byte budget only the comparison weakens. Never throws.
 */
export function worktreeSnapshot(cwd, options) {
  const o = bounds(options);
  const start = o.now();
  const left = () => o.totalMs - (o.now() - start);
  const call = (at, args) => {
    if (left() <= 0) return null;
    const r = boundedGit(at, args, { ...o, timeoutMs: Math.min(o.timeoutMs, left()) });
    return r.error ? null : r;
  };
  try {
    const top = call(cwd, ["rev-parse", "--show-toplevel"]);
    if (!top || top.status !== 0) return null;
    const root = strictUtf8(top.stdout).replace(/\r?\n$/, "");
    const head = call(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    if (!head || (head.status !== 0 && head.status !== 1)) return null;
    const status = call(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (!status || status.status !== 0) return null;
    const paths = statusPaths(strictUtf8(status.stdout));
    if (paths.length > o.maxFiles) return null;
    const budget = { left: o.maxBytes }, states = new Map();
    for (const p of paths) {
      if (left() <= 0) return null;
      states.set(p, pathEntry(path.join(root, p), budget));
    }
    return { root, head: head.status === 0 ? head.stdout.toString("utf8").trim() : null, states };
  } catch { return null; }
}
/**
 * The paths that changed since `before`, as absolute paths: state differs, plus what differs between
 * the two HEADs if HEAD moved. Empty when either side cannot be told, so the count stays event-only.
 * Never throws.
 */
export function worktreeChanges(cwd, before, options) {
  try {
    const after = worktreeSnapshot(cwd, options);
    if (!before || !after || after.root !== before.root) return [];
    const changed = new Set();
    for (const [p, entry] of before.states) if (!sameEntry(entry, after.states.get(p))) changed.add(p);
    for (const p of after.states.keys()) if (!before.states.has(p)) changed.add(p);
    if (before.head !== after.head) {
      const o = bounds(options);
      const empty = () => boundedGit(after.root, ["hash-object", "-t", "tree", "--stdin"], { ...o, input: "" }).stdout.toString("utf8").trim();
      const moved = boundedGit(after.root, ["diff", "--name-only", "--no-renames", "-z", before.head ?? empty(), after.head ?? empty()], o);
      if (moved.error || moved.status !== 0) return [];
      for (const p of strictUtf8(moved.stdout).split("\0").filter(Boolean)) changed.add(p);
    }
    return [...changed].map((p) => path.join(after.root, p));
  } catch { return []; }
}
/**
 * The union of a turn's edit events and its snapshot changes, each path once, relative to the job
 * cwd when inside it and absolute otherwise. An event's path is compared through its real directory,
 * so a symlinked spelling of the same file counts once.
 */
export function unionEdited(cwd, events, changed, platform = process.platform) {
  // On POSIX a backslash is an ordinary file name character: `a\\b` and `a/b` are two files.
  const slashes = (p) => (platform === "win32" ? p.replace(/\\/g, "/") : p);
  let base = cwd;
  try { base = fs.realpathSync(cwd); } catch { /* as spelled */ }
  const shown = (p) => {
    let abs = path.resolve(base, p);
    try { abs = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch { /* a directory the turn removed: as spelled */ }
    const rel = path.relative(base, abs);
    return slashes(rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : abs);
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
