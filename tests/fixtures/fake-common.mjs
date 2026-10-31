// Shared helpers for the three fake provider CLIs (fake-codex, fake-agy, fake-grok).
// A fake validates the complete launch contract of PLAN.md A5.1 before emitting anything;
// a mismatch exits 99 with the reason on stderr. Scenario selection: COUNCIL_FAKE_SCENARIO.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const fixturesDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(fixturesDir, "..", "..");
export const spikeDir = join(repoRoot, "docs", "spike");
export const streamsDir = join(fixturesDir, "streams");

export const SCENARIOS = ["ok", "resume", "denied", "effort-error", "review-findings", "review-malformed", "slow", "hold-pipes"];
export const GUARD_VARS = ["COUNCIL_DEPTH", "CODEX_COMPANION_DEPTH", "GROK_BUILD_DEPTH", "CLAUDE_PLUGIN_CODEX_DEPTH"];
export const SHARED_ENUM = ["low", "medium", "high", "xhigh", "max"];

export function fail(message) {
  process.stderr.write(`fake launch contract violated: ${message}\n`);
  process.exit(99);
}

export function scenario(env = process.env) {
  const s = env.COUNCIL_FAKE_SCENARIO || "ok";
  if (!SCENARIOS.includes(s)) fail(`unknown COUNCIL_FAKE_SCENARIO ${s}`);
  return s;
}

export function requireGuards(env = process.env) {
  for (const name of GUARD_VARS) {
    if (!env[name]) fail(`guard variable ${name} is not set on the child`);
  }
}

/**
 * Expected-content markers the test (or an adapter test) passes so the fake can check the exact
 * bytes a turn carries: COUNCIL_FAKE_EXPECT_PROMPT (exact) or COUNCIL_FAKE_EXPECT_PROMPT_CONTAINS
 * (substring), COUNCIL_FAKE_EXPECT_CONTRACT (exact contract text), COUNCIL_FAKE_JOB_DIR (directory
 * every per-job file must live in) and COUNCIL_FAKE_WEB=1 (the turn is a --web turn).
 */
export function expectPrompt(actual, what, env = process.env) {
  const exact = env.COUNCIL_FAKE_EXPECT_PROMPT;
  const contains = env.COUNCIL_FAKE_EXPECT_PROMPT_CONTAINS;
  if (exact === undefined && contains === undefined) fail(`no COUNCIL_FAKE_EXPECT_PROMPT or COUNCIL_FAKE_EXPECT_PROMPT_CONTAINS marker to check the ${what} against`);
  if (exact !== undefined && actual !== exact) fail(`${what} differs from COUNCIL_FAKE_EXPECT_PROMPT (${JSON.stringify(actual.slice(0, 80))})`);
  if (contains !== undefined && !actual.includes(contains)) fail(`${what} lacks COUNCIL_FAKE_EXPECT_PROMPT_CONTAINS`);
}

export function expectContract(actual, what, env = process.env) {
  const contract = env.COUNCIL_FAKE_EXPECT_CONTRACT;
  if (contract === undefined) fail(`no COUNCIL_FAKE_EXPECT_CONTRACT marker to check the ${what} against`);
  if (actual !== contract) fail(`${what} differs from COUNCIL_FAKE_EXPECT_CONTRACT`);
}

export function expectInJobDir(file, what, env = process.env) {
  const dir = env.COUNCIL_FAKE_JOB_DIR;
  if (!dir) fail(`no COUNCIL_FAKE_JOB_DIR marker to check the ${what} path against`);
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const inside = real(dirname(file)) === real(dir) || real(dirname(file)).startsWith(real(dir) + sep);
  if (!inside) fail(`${what} ${file} is outside the job directory ${dir}`);
}

export function wantsWeb(env = process.env) {
  return env.COUNCIL_FAKE_WEB === "1";
}

export function readRepoSchema() {
  return JSON.parse(readFileSync(join(repoRoot, "plugins", "council", "schemas", "review-output.schema.json"), "utf8"));
}

export function deepEqual(a, b) {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

export function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch (error) {
    if (error.code === "EAGAIN" || error.code === "EOF") return "";
    return "";
  }
}

/** Splits argv into {flags: Map(name -> [values]), positionals}, treating `-` as a positional. */
export function parseArgs(argv, { valueFlags, boolFlags, repeatable = [] }) {
  const flags = new Map();
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-" || !a.startsWith("-")) { positionals.push(a); continue; }
    if (boolFlags.includes(a)) { flags.set(a, [...(flags.get(a) ?? []), true]); continue; }
    if (valueFlags.includes(a)) {
      if (i + 1 >= argv.length) fail(`${a} needs a value`);
      flags.set(a, [...(flags.get(a) ?? []), argv[++i]]);
      continue;
    }
    fail(`unexpected argument ${a}`);
  }
  for (const [name, values] of flags) {
    if (values.length > 1 && !repeatable.includes(name)) fail(`${name} given ${values.length} times`);
  }
  return { flags, positionals, one: (n) => flags.get(n)?.[0], has: (n) => flags.has(n), all: (n) => flags.get(n) ?? [] };
}

export function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/** Writes a (possibly large) text to stdout and exits once the pipe has drained. */
export function printAndExit(text, code = 0) {
  return new Promise(() => { process.stdout.write(text, () => process.exit(code)); });
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function slowMs(env = process.env) {
  return Number(env.COUNCIL_FAKE_SLOW_MS ?? 30000);
}

/**
 * hold-pipes: a detached grandchild inherits stdout/stderr and keeps them open for
 * COUNCIL_FAKE_HOLD_MS (default 15 s) after this process exits, the way a CLI's leftover
 * helper would. Labelled synthetic: no probe produced it.
 */
export function holdPipes(env = process.env) {
  const ms = Number(env.COUNCIL_FAKE_HOLD_MS ?? 15000);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--hold", String(ms)], {
    detached: true, stdio: ["ignore", "inherit", "inherit"],
  });
  child.unref();
}

export function readSpike(name) {
  const p = join(spikeDir, name);
  if (!existsSync(p)) fail(`missing docs/spike/${name}`);
  return readFileSync(p, "utf8");
}

export function readStreamFixture(provider, name) {
  return readFileSync(join(streamsDir, provider, name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function uuid() {
  const hex = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)];
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-8${s.slice(17, 20)}-${s.slice(20)}`;
}

// Grandchild mode for hold-pipes.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--hold") {
  setTimeout(() => process.exit(0), Number(process.argv[3]));
}
