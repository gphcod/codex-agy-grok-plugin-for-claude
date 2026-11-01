#!/usr/bin/env node
// Test runner. Default: tests/**/*.test.mjs minus tests/live/** and *.live.test.mjs.
// --live: tests/live/**/*.live.test.mjs only. --ratio: core test density check.
// Spawns `node --test <files>` itself, so no shell globbing is needed on Windows.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..");

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function toPosix(path) {
  return path.split(sep).join("/");
}

export function isLiveName(relPath) {
  const posix = toPosix(relPath);
  return posix.startsWith("live/") || posix.includes("/live/") || posix.endsWith(".live.test.mjs");
}

export function isDefaultName(relPath) {
  return toPosix(relPath).endsWith(".test.mjs") && !isLiveName(relPath);
}

export function isLiveSelection(relPath) {
  const posix = toPosix(relPath);
  return posix.startsWith("live/") && posix.endsWith(".live.test.mjs");
}

export function discover(testsDir, mode = "default") {
  const files = walk(testsDir).map((f) => relative(testsDir, f));
  const pick = mode === "live" ? isLiveSelection : isDefaultName;
  return files.filter(pick).sort().map((f) => join(testsDir, f));
}

function countLines(files) {
  let n = 0;
  for (const f of files) {
    for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
      if (line.trim() !== "") n += 1;
    }
  }
  return n;
}

export function ratio(root = repoRoot) {
  const testsDir = join(root, "tests");
  const coreDir = join(root, "plugins", "council", "scripts", "lib", "core");
  const testFiles = walk(testsDir).filter((f) => /^core-.*\.test\.mjs$/.test(relative(testsDir, f)));
  const coreFiles = walk(coreDir).filter((f) => f.endsWith(".mjs"));
  const testLines = countLines(testFiles);
  const coreLines = countLines(coreFiles);
  return { testLines, coreLines, ratio: coreLines === 0 ? Infinity : testLines / coreLines };
}

function main(argv) {
  // An unknown flag (for example `--help`) must never fall through to running a test set,
  // least of all the paid live set.
  const unknown = argv.filter((a) => a !== "--live" && a !== "--ratio");
  if (unknown.length) {
    console.error(`run-tests: unknown argument ${unknown.join(" ")}; usage: run-tests.mjs [--live | --ratio]`);
    return 2;
  }
  if (argv.includes("--ratio")) {
    const r = ratio();
    const shown = Number.isFinite(r.ratio) ? r.ratio.toFixed(2) : "n/a (no core files)";
    console.log(`core test ratio: ${r.testLines} test lines / ${r.coreLines} core lines = ${shown}`);
    return r.ratio >= 1.5 ? 0 : 1;
  }
  const mode = argv.includes("--live") ? "live" : "default";
  const files = discover(join(repoRoot, "tests"), mode);
  if (files.length === 0) {
    console.error(`no ${mode} test files found`);
    return 1;
  }
  // A suite run from inside Claude Code must not see that session: the entry falls back to its id.
  const { CLAUDE_CODE_SESSION_ID: _host, ...env } = process.env;
  const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit", cwd: repoRoot, env });
  return result.status ?? 1;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
