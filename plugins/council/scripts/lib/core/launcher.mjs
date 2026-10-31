// Generic launcher resolver used by the adapters. Ported from grok-build-plugin-cc 1.1.5
// lib/launcher.mjs:15-30,60-63 (shim entry with node-shebang scripts, PATH candidates) and
// codex-plugin-cc 2.3.2 lib/launcher.mjs:20-31 (vendor .exe behind an npm shim). Never launches
// through cmd.exe: a .cmd shim runs as `node <entry>` or as the vendor executable it wraps, and a
// shim without a resolvable entry is refused. `kind` is the A5 enum: native | node-script |
// shim-native | shim-node.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export const KINDS = ["native", "node-script", "shim-native", "shim-node"];
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const NODE_SHEBANG = /^#!.*\bnode\b/;

/**
 * The JavaScript entry of an npm-style .cmd/.bat shim, or null: a .js/.cjs/.mjs target, or the
 * target npm's cmd-shim runs with "%_prog%" set to node. That target may have no extension
 * (@xai-official/grok 1.0.46 points at bin\grok), so it must also start with a node shebang.
 */
export function shimEntry(shim) {
  let text;
  try { text = fs.readFileSync(shim, "utf8"); } catch { return null; }
  const resolve = (target) => path.resolve(path.dirname(shim), target.replace(/\\/g, "/"));
  for (const m of text.matchAll(/"%~?dp0%?[\\/]*([^"]+\.[cm]?js)"/gi)) {
    if (isFile(resolve(m[1]))) return resolve(m[1]);
  }
  if (!/SET\s+"_prog=(%dp0%\\)?node(\.exe)?"/i.test(text)) return null;
  for (const m of text.matchAll(/"%_prog%"\s+"%~?dp0%?[\\/]*([^"]+)"/gi)) {
    const entry = resolve(m[1]);
    let head = "";
    try { head = fs.readFileSync(entry, "utf8").slice(0, 200); } catch { continue; }
    if (NODE_SHEBANG.test(head)) return entry;
  }
  return null;
}

/** Every `bin` executable on PATH, in PATH order (PATHEXT order within a directory on Windows). */
export function pathCandidates(bin, env = process.env, platform = process.platform) {
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const names = platform === "win32" ? exts.map((e) => `${bin}${e.toLowerCase()}`) : [bin];
  const found = [];
  for (const entry of (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":")) {
    const dir = entry.trim().replace(/^"|"$/g, "");
    if (!dir) continue;
    let actual = null;
    if (platform === "win32") {
      try { actual = fs.readdirSync(dir); } catch { continue; }
    }
    for (const name of names) {
      const file = path.join(dir, actual?.find((n) => n.toLowerCase() === name) ?? name);
      if (!isFile(file) || found.includes(file)) continue;
      if (platform !== "win32") { try { fs.accessSync(file, fs.constants.X_OK); } catch { continue; } }
      // A relative PATH entry is relative to this process, not to the workspace the child runs in.
      found.push(path.resolve(file));
    }
  }
  return found;
}

/**
 * `binEnv` override, then the first `bin` on PATH, then `fallback(env, platform)` (a vendor's
 * well-known install path, or null). Resolved on every call, so a new install or PATH change is
 * never hidden. `vendor(entry, platform, arch)` may name a native executable an npm shim wraps.
 * → {command, args, path, kind} | null; throws when a shim has no resolvable JavaScript entry.
 */
export function resolveLauncher({ bin, binEnv, env = process.env, platform = process.platform, arch = process.arch, fallback = null, vendor = null } = {}) {
  if (!bin) throw new Error("resolveLauncher needs the binary name");
  const found = (binEnv && env[binEnv]) ? path.resolve(env[binEnv])
    : pathCandidates(bin, env, platform)[0] ?? fallback?.(env, platform) ?? null;
  if (!found || !isFile(found)) return null;
  const ext = path.extname(found).toLowerCase();
  if (/^\.[cm]?js$/.test(ext)) return { command: process.execPath, args: [found], path: found, kind: "node-script" };
  if (ext === ".cmd" || ext === ".bat") {
    const entry = shimEntry(found);
    if (!entry) throw new Error(`${found} is a command shim without a JavaScript entry; set ${binEnv ?? "the binary override"} to the native executable`);
    const native = vendor?.(entry, platform, arch) ?? null;
    return native ? { command: native, args: [], path: native, kind: "shim-native" } : { command: process.execPath, args: [entry], path: entry, kind: "shim-node" };
  }
  return { command: found, args: [], path: found, kind: "native" };
}

/** The model-bearing child: piped stdio, its own process group outside Windows. */
export function spawnChild(launcher, args, { cwd, env, platform = process.platform }) {
  return spawn(launcher.command, [...launcher.args, ...args], {
    cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true, detached: platform !== "win32",
  });
}

/** A probe command (version, login, listing): synchronous, bounded, never a model call. */
export function runSync(launcher, args, { env, cwd, timeoutMs = 15000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return spawnSync(launcher.command, [...launcher.args, ...args], {
    cwd, env, encoding: "utf8", shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer, stdio: ["ignore", "pipe", "pipe"],
  });
}
