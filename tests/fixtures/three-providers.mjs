// Shared by tests/integration.test.mjs and tests/commands-e2e.test.mjs: a sandbox where the three
// adapters run against their fakes in one COUNCIL_HOME and one Git workspace. COUNCIL_<P>_BIN name
// wrappers that log each invocation (argv, pid, the guard variables) and then run the fake in-process;
// PATH holds only trap `codex`, `agy` and `grok` scripts (which log and exit 97) before the system
// directories, so a call that falls through to PATH is recorded, and `done()` fails on it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GUARD_VARS } from "../../plugins/council/scripts/lib/core/execution.mjs";
import { loadJob } from "../../plugins/council/scripts/lib/core/jobs.mjs";
import { canonical } from "../../plugins/council/scripts/lib/core/fs.mjs";
import { oneLineContract } from "../../plugins/council/scripts/lib/providers/grok.mjs";
import { GIT_ENV, git } from "./build-repos.mjs";

export const ENTRY = fileURLToPath(new URL("../../plugins/council/scripts/council.mjs", import.meta.url));
export const PLUGIN_DIR = fileURLToPath(new URL("../../plugins/council", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./", import.meta.url));
export const CONTRACT = readFileSync(new URL("../../plugins/council/contract.md", import.meta.url), "utf8").replace(/\r\n?/g, "\n").trim();
export const PROVIDERS = ["codex", "gemini", "grok"];
const FAKES = { codex: "fake-codex.mjs", gemini: "fake-agy.mjs", grok: "fake-grok.mjs" };
export const SESSION = "int-session";
export const footer = (out) => out.trim().split("\n").at(-1);

/** The content markers each fake checks for a plain turn carrying `text` (decisions S1.9 F1). */
export function markers(provider, text) {
  if (provider === "codex") return { COUNCIL_FAKE_EXPECT_CONTRACT: CONTRACT, COUNCIL_FAKE_EXPECT_PROMPT: text };
  if (provider === "grok") return { COUNCIL_FAKE_EXPECT_CONTRACT: oneLineContract(CONTRACT), COUNCIL_FAKE_EXPECT_PROMPT: text };
  return { COUNCIL_FAKE_EXPECT_CONTRACT: CONTRACT, COUNCIL_FAKE_EXPECT_PROMPT: `${CONTRACT}\n\n${text}` };
}

export function harness() {
  const root = mkdtempSync(join(tmpdir(), "council-3p-"));
  const home = join(root, "council");
  const userHome = join(root, "home");
  mkdirSync(join(userHome, ".gemini", "antigravity-cli"), { recursive: true });
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  writeFileSync(join(repo, "calc.js"), "export const sum = (items) => { let s = 0; for (let i = 0; i < items.length; i++) s += items[i]; return s; };\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "main"]);
  const cwd = canonical(repo);
  const calls = join(root, "calls.log");
  const traps = join(root, "traps.log");
  writeFileSync(calls, ""); writeFileSync(traps, "");
  const trapDir = join(root, "trap-bin");
  mkdirSync(trapDir);
  for (const bin of ["codex", "agy", "grok"]) {
    writeFileSync(join(trapDir, bin), `#!/bin/sh\necho "${bin} $*" >> "${traps}"\nexit 97\n`);
    chmodSync(join(trapDir, bin), 0o755);
  }
  const bins = {};
  for (const p of PROVIDERS) {
    bins[p] = join(root, `wrap-${p}.mjs`);
    writeFileSync(bins[p], [
      `import { appendFileSync, rmSync, writeFileSync } from "node:fs";`,
      `appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ provider: ${JSON.stringify(p)}, argv: process.argv.slice(2), pid: process.pid, guards: ${JSON.stringify(GUARD_VARS)}.filter((g) => process.env[g]) }) + "\\n");`,
      // COUNCIL_FAKE_SHELL_EDIT: [[path, content | null]], what a shell command in the turn would do; no edit event is emitted.
      `for (const [path, content] of JSON.parse(process.env.COUNCIL_FAKE_SHELL_EDIT ?? "[]")) { if (content === null) rmSync(path); else writeFileSync(path, content); }`,
      `await import(${JSON.stringify(pathToFileURL(join(FIXTURES, FAKES[p])).href)});`,
    ].join("\n") + "\n");
  }
  const base = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (GUARD_VARS.includes(k) || k.startsWith("COUNCIL_") || k === "GROK_CLAUDE_RULES_ENABLED") continue;
    base[k] = v;
  }
  Object.assign(base, GIT_ENV, {
    HOME: userHome, PATH: `${trapDir}:/usr/bin:/bin`, COUNCIL_HOME: home, COUNCIL_STDIN_DEADLINE_MS: "300", COUNCIL_FAKE_JOB_DIR: join(home, "jobs"),
    COUNCIL_CODEX_BIN: bins.codex, COUNCIL_AGY_BIN: bins.gemini, COUNCIL_GROK_BIN: bins.grok,
  });
  const collect = (child) => {
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    return new Promise((resolve) => child.on("close", (code) => resolve({ code, out, err, job: /job[= ]([a-z0-9]{16})/.exec(err + out)?.[1] })));
  };
  /** One companion process (`node council.mjs <argv>`, stdin closed); resolves when it exits. */
  const run = (argv, env = {}) => collect(spawn(process.execPath, [ENTRY, ...argv], { cwd: repo, env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] }));
  /** A shell body run by bash, as Claude's Bash tool runs a command's block; `node` resolves on PATH. */
  const sh = (body, env = {}) => collect(spawn("/bin/bash", ["-c", body], { cwd: repo, env: { ...base, PATH: `${trapDir}:${dirname(process.execPath)}:/usr/bin:/bin`, ...env }, stdio: ["ignore", "pipe", "pipe"] }));
  /** A threaded turn of `provider` with the fake's content markers. */
  const turn = (provider, argv, text, env = {}) => run([...argv, "--session", SESSION, "--", text], { ...markers(provider, text), ...env });
  const job = (id) => loadJob(canonical(home), id);
  const jobIds = () => { try { return readdirSync(join(home, "jobs")).filter((n) => /^[a-z0-9]{16}$/.test(n)); } catch { return []; } };
  const invocations = () => readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const trapped = () => readFileSync(traps, "utf8");
  const done = () => {
    assert.equal(trapped(), "", "no call reached a codex, agy or grok on PATH");
    rmSync(root, { recursive: true, force: true });
  };
  return { root, home, repo, cwd, base, run, sh, turn, job, jobIds, invocations, trapped, done };
}
