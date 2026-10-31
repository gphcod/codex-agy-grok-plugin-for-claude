#!/usr/bin/env node
// council entry. S0 stub: parses the verb, prints usage with exit 2 for every
// verb not yet implemented, and implements `setup` as far as resolving the
// three provider binaries on PATH (which/where.exe semantics in Node, no spawn).
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VERBS = ["ask", "reply", "review", "task", "wait", "cancel", "models", "setup"];

export const PROVIDERS = [
  { id: "codex", bin: "codex", binEnv: "COUNCIL_CODEX_BIN" },
  { id: "gemini", bin: "agy", binEnv: "COUNCIL_AGY_BIN" },
  { id: "grok", bin: "grok", binEnv: "COUNCIL_GROK_BIN" },
];

export const USAGE = `usage: council <verb> [flags] [-- <text>]

verbs: ${VERBS.join(", ")}
Only \`setup\` (binary resolution) is implemented in this build.`;

function isExecutableFile(path, platform) {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform === "win32") return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// PATH lookup with `which` (POSIX) / `where.exe` (Windows, PATHEXT) semantics.
export function whichBinary(name, env, platform = process.platform) {
  if (isAbsolute(name) || name.includes("/") || (platform === "win32" && name.includes("\\"))) {
    return isExecutableFile(name, platform) ? resolve(name) : null;
  }
  const pathValue = env.PATH ?? env.Path ?? "";
  const dirs = pathValue.split(platform === "win32" ? ";" : delimiter).filter(Boolean);
  const exts = platform === "win32"
    ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

export function resolveBinaries(env, platform = process.platform) {
  return PROVIDERS.map((p) => {
    const override = env[p.binEnv];
    const path = override ? whichBinary(override, env, platform) : whichBinary(p.bin, env, platform);
    return { ...p, path, source: override ? p.binEnv : "PATH" };
  });
}

export async function main(argv, env = process.env, io = { stdout: process.stdout, stderr: process.stderr }) {
  const out = (s) => io.stdout.write(s + "\n");
  const err = (s) => io.stderr.write(s + "\n");
  const verb = argv[0];
  if (!verb || !VERBS.includes(verb)) {
    err(USAGE);
    return 2;
  }
  if (verb === "setup") {
    for (const p of resolveBinaries(env)) {
      out(`${p.id}: ${p.bin} -> ${p.path ?? "not found"} (${p.source})`);
    }
    return 0;
  }
  err(`${verb}: not implemented in this build`);
  err(USAGE);
  return 2;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2), process.env, { stdout: process.stdout, stderr: process.stderr }).then(
    (code) => { process.exitCode = code; },
    (error) => { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; },
  );
}
