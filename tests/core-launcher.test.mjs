// S2.2: launcher.mjs resolution on PATH, through binEnv, missing binaries, and the Windows shim forms.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KINDS, pathCandidates, resolveLauncher, shimEntry } from "../plugins/council/scripts/lib/core/launcher.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "council-launcher-"));
const exe = (p, content = "#!/bin/sh\nexit 0\n") => { writeFileSync(p, content); chmodSync(p, 0o755); };

test("KINDS is the A5 enum", () => {
  assert.deepEqual(KINDS, ["native", "node-script", "shim-native", "shim-node"]);
});

test("PATH resolution on POSIX: first executable wins, non-executables are skipped", () => {
  const dir = tmp();
  try {
    const a = join(dir, "a"), b = join(dir, "b"), c = join(dir, "c");
    for (const d of [a, b, c]) mkdirSync(d);
    writeFileSync(join(a, "codex"), "not executable");
    exe(join(b, "codex"));
    exe(join(c, "codex"));
    const env = { PATH: `${a}:${b}:${c}` };
    assert.deepEqual(pathCandidates("codex", env, "linux"), [join(b, "codex"), join(c, "codex")]);
    const found = resolveLauncher({ bin: "codex", binEnv: "COUNCIL_CODEX_BIN", env, platform: "linux" });
    assert.deepEqual(found, { command: join(b, "codex"), args: [], path: join(b, "codex"), kind: "native" });
    assert.equal(resolveLauncher({ bin: "agy", binEnv: "COUNCIL_AGY_BIN", env, platform: "linux" }), null, "missing binary");
    assert.equal(resolveLauncher({ bin: "codex", binEnv: "X", env: { PATH: "" }, platform: "linux" }), null);
    assert.equal(resolveLauncher({ bin: "codex", binEnv: "X", env: {}, platform: "linux" }), null);
    assert.throws(() => resolveLauncher({ env, platform: "linux" }), /needs the binary name/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("binEnv override wins over PATH and may point at a JS entry; a bad override is null", () => {
  const dir = tmp();
  try {
    exe(join(dir, "codex"));
    writeFileSync(join(dir, "entry.mjs"), "console.log(1)");
    const env = { PATH: dir, COUNCIL_CODEX_BIN: join(dir, "entry.mjs") };
    const r = resolveLauncher({ bin: "codex", binEnv: "COUNCIL_CODEX_BIN", env, platform: "linux" });
    assert.deepEqual(r, { command: process.execPath, args: [join(dir, "entry.mjs")], path: join(dir, "entry.mjs"), kind: "node-script" });
    assert.equal(resolveLauncher({ bin: "codex", binEnv: "COUNCIL_CODEX_BIN", env: { ...env, COUNCIL_CODEX_BIN: join(dir, "missing") }, platform: "linux" }), null);
    const fallback = resolveLauncher({ bin: "grok", binEnv: "COUNCIL_GROK_BIN", env: { PATH: "" }, platform: "linux", fallback: () => join(dir, "codex") });
    assert.equal(fallback.kind, "native");
    assert.equal(fallback.command, join(dir, "codex"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("win32: .cmd shim with a .js entry runs as node <entry> (shim-node)", () => {
  const dir = tmp();
  try {
    const bin = join(dir, "bin");
    mkdirSync(join(bin, "node_modules", "@openai", "codex", "bin"), { recursive: true });
    writeFileSync(join(bin, "node_modules", "@openai", "codex", "bin", "codex.js"), "#!/usr/bin/env node\n");
    writeFileSync(join(bin, "codex.cmd"), '@ECHO off\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
    const env = { Path: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    assert.deepEqual(pathCandidates("codex", env, "win32"), [join(bin, "codex.cmd")]);
    const r = resolveLauncher({ bin: "codex", binEnv: "COUNCIL_CODEX_BIN", env, platform: "win32" });
    assert.equal(r.kind, "shim-node");
    assert.equal(r.command, process.execPath);
    assert.deepEqual(r.args, [join(bin, "node_modules", "@openai", "codex", "bin", "codex.js")]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("win32: .cmd shim with an extensionless node-shebang script (shim-node)", () => {
  const dir = tmp();
  try {
    const bin = join(dir, "bin");
    mkdirSync(join(bin, "node_modules", "@xai-official", "grok", "bin"), { recursive: true });
    writeFileSync(join(bin, "node_modules", "@xai-official", "grok", "bin", "grok"), "#!/usr/bin/env node\nconsole.log('grok')\n");
    writeFileSync(join(bin, "grok.cmd"), [
      "@ECHO off", "SETLOCAL", 'SET "_prog=node"', 'IF EXIST "%dp0%\\node.exe" ( SET "_prog=%dp0%\\node.exe" )',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@xai-official\\grok\\bin\\grok" %*', "",
    ].join("\r\n"));
    const r = resolveLauncher({ bin: "grok", binEnv: "COUNCIL_GROK_BIN", env: { Path: bin }, platform: "win32" });
    assert.equal(r.kind, "shim-node");
    assert.deepEqual(r.args, [join(bin, "node_modules", "@xai-official", "grok", "bin", "grok")]);
    assert.equal(shimEntry(join(bin, "grok.cmd")), join(bin, "node_modules", "@xai-official", "grok", "bin", "grok"));
    // the same shim pointing at a script without a node shebang resolves nothing
    writeFileSync(join(bin, "node_modules", "@xai-official", "grok", "bin", "grok"), "#!/bin/sh\necho no\n");
    assert.equal(shimEntry(join(bin, "grok.cmd")), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("win32: .cmd shim without a JavaScript entry throws, naming the override", () => {
  const dir = tmp();
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "agy.cmd"), '@ECHO off\r\n"%dp0%\\agy.real.exe" %*\r\n');
    assert.throws(() => resolveLauncher({ bin: "agy", binEnv: "COUNCIL_AGY_BIN", env: { Path: bin }, platform: "win32" }), /command shim without a JavaScript entry; set COUNCIL_AGY_BIN/);
    assert.equal(shimEntry(join(bin, "nope.cmd")), null, "unreadable shim");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("win32: vendor codex.exe behind the npm shim (shim-native), native .exe on PATH (native)", () => {
  const dir = tmp();
  try {
    const bin = join(dir, "bin");
    const pkg = join(bin, "node_modules", "@openai", "codex");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    mkdirSync(join(pkg, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin"), { recursive: true });
    writeFileSync(join(pkg, "bin", "codex.js"), "#!/usr/bin/env node\n");
    const native = join(pkg, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
    writeFileSync(native, "MZ");
    writeFileSync(join(bin, "codex.cmd"), '"%dp0%\\node.exe" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
    const vendor = (entry, platform, arch) => {
      const candidate = join(entry, "..", "..", "node_modules", "@openai", `codex-${platform}-${arch}`, "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
      try { return require_file(candidate) ? candidate : null; } catch { return null; }
    };
    const r = resolveLauncher({ bin: "codex", binEnv: "COUNCIL_CODEX_BIN", env: { Path: bin }, platform: "win32", arch: "x64", vendor });
    assert.equal(r.kind, "shim-native");
    assert.equal(r.command, native);
    assert.deepEqual(r.args, []);
    // a native exe directly on PATH
    const native2 = join(dir, "native");
    mkdirSync(native2);
    writeFileSync(join(native2, "grok.exe"), "MZ");
    const g = resolveLauncher({ bin: "grok", binEnv: "COUNCIL_GROK_BIN", env: { Path: native2 }, platform: "win32" });
    assert.deepEqual(g, { command: join(native2, "grok.exe"), args: [], path: join(native2, "grok.exe"), kind: "native" });
    // PATHEXT order within a directory: .EXE before .CMD
    writeFileSync(join(native2, "grok.cmd"), "");
    assert.equal(pathCandidates("grok", { Path: native2, PATHEXT: ".EXE;.CMD" }, "win32")[0], join(native2, "grok.exe"));
    assert.equal(pathCandidates("grok", { Path: native2, PATHEXT: ".CMD;.EXE" }, "win32")[0], join(native2, "grok.cmd"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { statSync } from "node:fs";
function require_file(p) { try { return statSync(p).isFile(); } catch { return false; } }
