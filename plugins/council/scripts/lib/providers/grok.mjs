// Grok adapter (PLAN.md S4, A5.1). Ported from grok-build-plugin-cc 1.1.5: lib/recipes.mjs (recipe,
// compatEnv, HOSTILE, FORBIDDEN, RESUME_DENY), lib/launcher.mjs (native Windows install fallback),
// lib/setup.mjs (parseModels, through the core parseModelListing), lib/reader.mjs:58-134 (catalogue
// guard, tool-call edit paths, session confirmation, stop reason, cost, usage) and grok.mjs:148-171
// (recipe selection by the session's agent, argv order, rules and schema carriers).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLUGIN_ROOT, loadStaticCatalog, parseModelListing } from "../core/catalog.mjs";
import { hasFlagOperand } from "../core/execution.mjs";
import { resolveLauncher as resolveBinary, runSync } from "../core/launcher.mjs";

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** Grok 1.0.70 has one CLI-wide effort set; `max` is rejected (A2), so the core clamps it to xhigh. */
export const EFFORTS = ["low", "medium", "high", "xhigh"];
export const BINS = ["grok", "grok.exe"];
/** grok-build reader LINE_CAP. */
export const LINE_CAP = 1024 * 1024;
const PATH_CAP = 10000;

// --- adapter ---------------------------------------------------------------------------------------------

const adapter = {
  id: "grok",
  binEnv: "COUNCIL_GROK_BIN",

  /** COUNCIL_GROK_BIN, then grok on PATH, then the native Windows install under USERPROFILE (grok-build launcher.mjs:60-63). */
  resolveLauncher(env = {}, platform = process.platform) {
    const home = (platform === "win32" ? env.USERPROFILE : env.HOME) || os.homedir();
    const native = path.join(home, ".grok", "bin", "grok.exe");
    return resolveBinary({ bin: "grok", binEnv: "COUNCIL_GROK_BIN", env, platform, fallback: () => (platform === "win32" && isFile(native) ? native : null) });
  },

  /** A5.1: never trusted; the post-exit scan runs after every exit. */
  trustsCleanExit() { return false; },

  /** The prompt-file operand is job-specific (it lives in the job directory); a native grok behind a node launcher counts. */
  ownsProcess(row, job, platform = process.platform) {
    const recorded = job?.turn?.promptFile ?? promptFileOf(job?.childArgs);
    return hasFlagOperand(row, "--prompt-file", recorded, job, platform, BINS);
  },

  maxLineBytes: LINE_CAP,

  /** `grok --version` and `grok models` (login line plus model rows); no model call. */
  probe(launcher, env = {}) {
    const first = (run) => (run.stderr || run.stdout || run.error?.message || `exit ${run.status}`).trim().split(/\r?\n/)[0];
    const version = runSync(launcher, ["--version"], { env });
    if (version.status !== 0) throw new Error(`grok --version failed: ${first(version)}`);
    const listing = runSync(launcher, ["models"], { env, timeoutMs: 30000 });
    if (listing.status !== 0) throw new Error(`grok models failed: ${first(listing)}`);
    const parsed = parseModelListing("grok", listing.stdout, { grokEfforts: EFFORTS });
    return {
      version: version.stdout.trim().split(/\r?\n/)[0] || null,
      loggedIn: parsed.loggedIn,
      models: Object.entries(parsed.models).map(([id, efforts]) => ({ id, efforts })),
    };
  },

  catalog: loadStaticCatalog().grok,

};

// --- helpers ---------------------------------------------------------------------------------------------

function promptFileOf(args) {
  if (!Array.isArray(args)) return null;
  const i = args.indexOf("--prompt-file");
  return i >= 0 ? args[i + 1] ?? null : null;
}

export default adapter;
