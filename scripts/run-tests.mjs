#!/usr/bin/env node
// Test runner. Default: tests/**/*.test.mjs minus tests/live/** and *.live.test.mjs.
// --live: tests/live/**/*.live.test.mjs only. --ratio: core test density check.
// Spawns `node --test <files>` itself, so no shell globbing is needed on Windows.
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
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
  if (mode === "live") return spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit", cwd: repoRoot, env }).status ?? 1;
  // One temp root per default run, removed afterwards: the tests make thousands of directories under os.tmpdir().
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "council-run-")));
  const status = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit", cwd: repoRoot, env: { ...env, TMPDIR: scratch, TMP: scratch, TEMP: scratch } }).status ?? 1;
  return removeScratch(scratch) ? status : status || 1;
}

/**
 * Removes the run's temp root. On Windows a directory stays locked while a process has it as its cwd, so the fixtures'
 * leftover holders go first: each names the root on its command line. A root that cannot go fails the run.
 */
function removeScratch(scratch) {
  if (process.platform === "win32") {
    const stop = "$env:PSModulePath=\"$PSHOME\\Modules\"; CimCmdlets\\Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.IndexOf($env:COUNCIL_RUN_SCRATCH, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    const powershell = process.env.SystemRoot ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
    spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", stop], { env: { ...process.env, COUNCIL_RUN_SCRATCH: scratch }, stdio: "ignore", windowsHide: true, timeout: 30000 });
  }
  for (const end = Date.now() + (process.platform === "win32" ? 30000 : 0); ;) {
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }); return true; }
    catch (error) {
      if (Date.now() >= end) { console.error(`run-tests: could not remove ${scratch}: ${error.message}`); return false; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); // fs.rmSync retries only its root, not a locked directory inside it.
    }
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
