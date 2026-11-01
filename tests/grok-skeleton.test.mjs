// S4.1: grok adapter skeleton — launcher, trust, ownership by the prompt-file operand, line cap, probe, catalog.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import grok, { BINS, EFFORTS, LINE_CAP } from "../plugins/council/scripts/lib/providers/grok.mjs";
import { loadStaticCatalog } from "../plugins/council/scripts/lib/core/catalog.mjs";

const FAKE = fileURLToPath(new URL("./fixtures/fake-grok.mjs", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "council-grok-s1-"));

test("identity, binEnv, line cap and catalog", () => {
  assert.equal(grok.id, "grok");
  assert.equal(grok.binEnv, "COUNCIL_GROK_BIN");
  assert.equal(grok.maxLineBytes, LINE_CAP);
  assert.equal(LINE_CAP, 1024 * 1024, "grok-build reader LINE_CAP");
  assert.deepEqual(grok.catalog, loadStaticCatalog().grok);
  assert.deepEqual(EFFORTS, ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(BINS, ["grok", "grok.exe"]);
});

test("trustsCleanExit is false for every launcher kind (A5.1)", () => {
  for (const kind of ["native", "node-script", "shim-native", "shim-node"]) assert.equal(grok.trustsCleanExit({ kind }), false);
  assert.equal(grok.trustsCleanExit(null), false);
});

test("resolveLauncher: COUNCIL_GROK_BIN, PATH, Windows native install fallback, missing", () => {
  const dir = tmp();
  try {
    const viaEnv = grok.resolveLauncher({ COUNCIL_GROK_BIN: FAKE, PATH: "" }, "darwin");
    assert.deepEqual([viaEnv.kind, viaEnv.path, viaEnv.command], ["node-script", FAKE, process.execPath]);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "grok"), "#!/bin/sh\n");
    chmodSync(join(bin, "grok"), 0o755);
    const viaPath = grok.resolveLauncher({ PATH: bin }, "darwin");
    assert.deepEqual([viaPath.kind, viaPath.path], ["native", join(bin, "grok")]);
    assert.equal(grok.resolveLauncher({ PATH: "", HOME: dir }, "darwin"), null, "no fallback outside Windows");
    const profile = join(dir, "profile");
    mkdirSync(join(profile, ".grok", "bin"), { recursive: true });
    writeFileSync(join(profile, ".grok", "bin", "grok.exe"), "MZ");
    const win = grok.resolveLauncher({ PATH: "", USERPROFILE: profile }, "win32");
    assert.deepEqual([win.kind, win.path], ["native", join(profile, ".grok", "bin", "grok.exe")]);
    assert.equal(grok.resolveLauncher({ PATH: "", USERPROFILE: join(dir, "nobody") }, "win32"), null);
    assert.equal(grok.resolveLauncher({ COUNCIL_GROK_BIN: join(dir, "missing") }, "darwin"), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("probe: version, login and the CLI-wide effort set from the fake's recorded listing", () => {
  const launcher = grok.resolveLauncher({ COUNCIL_GROK_BIN: FAKE }, process.platform);
  const probe = grok.probe(launcher, { ...process.env });
  assert.equal(probe.version, "grok 1.0.70 (f50904eaee6c) [stable]");
  assert.equal(probe.loggedIn, true);
  assert.deepEqual(probe.models.map((m) => m.id), ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"]);
  for (const m of probe.models) assert.deepEqual(m.efforts, EFFORTS, "no max: the CLI rejects it");
});

test("probe: failures name the command", () => {
  const dir = tmp();
  try {
    const failing = join(dir, "grok.mjs");
    writeFileSync(failing, "process.stderr.write('boom\\n'); process.exit(3);\n");
    const launcher = grok.resolveLauncher({ COUNCIL_GROK_BIN: failing }, process.platform);
    assert.throws(() => grok.probe(launcher, {}), /grok --version failed: boom/);
    const noModels = join(dir, "grok2.mjs");
    writeFileSync(noModels, "if (process.argv[2] === '--version') { console.log('grok 1.0.70'); process.exit(0); } console.error('You are not logged in'); process.exit(1);\n");
    assert.throws(() => grok.probe(grok.resolveLauncher({ COUNCIL_GROK_BIN: noModels }, process.platform), {}), /grok models failed: You are not logged in/);
    const loggedOut = join(dir, "grok3.mjs");
    writeFileSync(loggedOut, "if (process.argv[2] === '--version') { console.log('grok 1.0.70'); } else { console.log('You are not logged in.'); }\n");
    const p = grok.probe(grok.resolveLauncher({ COUNCIL_GROK_BIN: loggedOut }, process.platform), {});
    assert.equal(p.loggedIn, false);
    assert.deepEqual(p.models, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- ownership: the prompt-file operand (A5.1) --------------------------------------------------------

const jobFor = (id, launcherArgs = ["/opt/grok/bin/grok"]) => {
  const promptFile = `/home/u/.council/jobs/${id}/prompt.md`;
  const childArgs = ["--prompt-file", promptFile, "--session-id", "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f", "--cwd", "/w", "--output-format", "streaming-json", "--model", "grok-4.7", "--effort", "low", "--no-auto-update"];
  return { id, childArgs, argv: [...launcherArgs, ...childArgs], turn: { promptFile } };
};

test("ownsProcess: argv rows (Linux, Windows) match only this job's prompt file", () => {
  const a = jobFor("aaaaaaaaaaaaaaaa"), b = jobFor("bbbbbbbbbbbbbbbb");
  const rowA = { pid: 1, argv: a.argv }, rowB = { pid: 2, argv: b.argv };
  assert.equal(grok.ownsProcess(rowA, a, "linux"), true);
  assert.equal(grok.ownsProcess(rowB, a, "linux"), false, "same model and effort, another job's prompt file");
  assert.equal(grok.ownsProcess(rowA, b, "linux"), false);
  assert.equal(grok.ownsProcess({ pid: 3, argv: ["grok", "--prompt-file"] }, a, "linux"), false);
  const winJob = { ...a, turn: { promptFile: "C:\\Users\\u\\.council\\jobs\\aaaaaaaaaaaaaaaa\\prompt.md" } };
  assert.equal(grok.ownsProcess({ pid: 4, argv: ["C:\\grok.exe", "--prompt-file", "c:\\users\\u\\.council\\jobs\\aaaaaaaaaaaaaaaa\\prompt.md"] }, winJob, "win32"), true, "Windows paths compare case-insensitively");
});

test("ownsProcess: macOS raw rows, including a native grok behind a recorded node launcher", () => {
  const a = jobFor("aaaaaaaaaaaaaaaa"), b = jobFor("bbbbbbbbbbbbbbbb");
  const raw = (job, program) => `${program} ${job.childArgs.join(" ")}`;
  assert.equal(grok.ownsProcess({ pid: 1, raw: raw(a, "/opt/grok/bin/grok"), argv: null }, a, "darwin"), true);
  assert.equal(grok.ownsProcess({ pid: 2, raw: raw(b, "/opt/grok/bin/grok"), argv: null }, a, "darwin"), false, "the other job's row never matches");
  const viaNode = jobFor("cccccccccccccccc", ["/usr/local/bin/node", "/npm/lib/grok/bin/grok"]);
  assert.equal(grok.ownsProcess({ pid: 3, raw: raw(viaNode, "/usr/local/bin/node /npm/lib/grok/bin/grok"), argv: null }, viaNode, "darwin"), true, "the recorded launcher");
  assert.equal(grok.ownsProcess({ pid: 4, raw: raw(viaNode, "/vendor/x64/grok"), argv: null }, viaNode, "darwin"), true, "a native backend named grok counts");
  assert.equal(grok.ownsProcess({ pid: 5, raw: raw(viaNode, "/usr/bin/python3"), argv: null }, viaNode, "darwin"), false, "another program with the operand does not");
});

test("ownsProcess: the operand comes from childArgs when the turn record is missing; nothing without one", () => {
  const a = jobFor("aaaaaaaaaaaaaaaa");
  const bare = { id: a.id, childArgs: a.childArgs, argv: a.argv };
  assert.equal(grok.ownsProcess({ pid: 1, argv: a.argv }, bare, "linux"), true);
  assert.equal(grok.ownsProcess({ pid: 1, argv: a.argv }, { id: a.id }, "linux"), false);
});
