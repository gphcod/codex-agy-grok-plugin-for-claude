// Gemini adapter (PLAN.md A5.1 gemini, S5) over the Antigravity CLI `agy` 1.4.12.
// Behaviour reimplemented from gemini-plugin-cc 2.1.0 (lib/agy.mjs buildLaunchDescription, the stdin
// message, resultFailure, isDeniedFailure, describeToolStep, describeStepError, MAX_FRAME_BYTES,
// MAX_PARTIAL_BYTES; gemini-companion.mjs getAgyAuthStatus; lib/review-output.mjs) without copying
// its code (no LICENSE in the installed copy, docs/decisions.md S0), and from gemini-plugin-for-codex
// (MIT) skills/agy/scripts/lib/settings.mjs (configuredPolicy, sessionSettings).
// Changes from gemini-plugin-cc: a job-specific --settings file on every turn (merged global lists,
// A2 deny union on read-only turns), --mode accept-edits only on tasks, --sandbox always, denial
// exits 10 instead of 20 (S5.7 parity record).
import path from "node:path";
import { UsageError } from "../core/args.mjs";
import { loadStaticCatalog, parseModelListing } from "../core/catalog.mjs";
import { hasFlagOperand } from "../core/execution.mjs";
import { resolveLauncher as resolveBinary, runSync } from "../core/launcher.mjs";

/** One stream-json frame, and the streamed answer, are capped at 32 MiB (gemini-plugin-cc lib/agy.mjs). */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
export const MAX_PARTIAL_BYTES = 32 * 1024 * 1024;
export const BINARIES = ["agy", "agy.exe"];
/** S7.2 sets this when the Windows session qualifies the agy path (A8). */
export const WINDOWS_QUALIFIED = false;
export const WINDOWS_UNSUPPORTED = "Gemini (agy) is not supported on Windows in council 1.0: the agy path is not qualified there (PLAN.md A8); use --to codex or --to grok";

/** The settings file of a job: recorded in the turn, else derived from the job directory. */
export function settingsPathOf(job) {
  return job?.turn?.settingsPath ?? (job?.dir ? path.join(job.dir, "settings.json") : null);
}

/** A8: turn verbs and probes refuse win32 until S7.2 qualifies agy there. */
export function assertPlatform(platform = process.platform) {
  if (platform === "win32" && !WINDOWS_QUALIFIED) throw new UsageError(WINDOWS_UNSUPPORTED);
}

/** checkRequest with the platform as a parameter, so tests can exercise win32 on any host. */
export function checkGeminiRequest(request, env = {}, platform = process.platform) {
  assertPlatform(platform);
  // S1.2: a search_web(*) deny rule did not block search_web, so no --web mapping exists (A3.3).
  if (request?.web) throw new UsageError("--web has no tested mapping for gemini: agy's search_web tool cannot be denied by a settings rule (S1.2), so web search cannot be switched; omit --web");
}

/** gemini-plugin-cc getAgyAuthStatus: `agy models` exiting 0 is the login check; also the listing. */
export function probeAgy(launcher, env = {}, platform = process.platform, run = runSync) {
  assertPlatform(platform);
  const version = run(launcher, ["--version"], { env });
  if (version.error) throw new Error(`agy --version failed: ${version.error.message}`);
  if (version.status !== 0) throw new Error(`agy --version exited ${version.status}: ${(version.stderr || version.stdout || "").trim().slice(0, 200)}`);
  const versionText = String(version.stdout ?? "").trim() || null;
  const listing = run(launcher, ["models"], { env, timeoutMs: 30000 });
  if (listing.error || listing.status !== 0) {
    const detail = listing.error?.message ?? ((listing.stderr || listing.stdout || "").trim().slice(0, 200) || `agy models exited ${listing.status}`);
    // A failed listing is reported, never written to the catalog as an empty refresh.
    throw new Error(`agy ${versionText ?? "?"}: not logged in or listing failed (${detail}); run agy once in a terminal to sign in`);
  }
  const parsed = parseModelListing("gemini", listing.stdout ?? "");
  return { version: versionText, loggedIn: true, models: Object.entries(parsed.models).map(([id, efforts]) => ({ id, efforts })) };
}

const adapter = {
  id: "gemini",
  binEnv: "COUNCIL_AGY_BIN",
  resolveLauncher(env = {}, platform = process.platform) {
    return resolveBinary({ bin: "agy", binEnv: this.binEnv, env, platform });
  },
  /** No agy launcher kind is qualified for a trusted clean exit; S7.2 may qualify one (A5.1). */
  trustsCleanExit() { return false; },
  /** The job-specific `--settings <job-dir>/settings.json` operand (A5.1). */
  ownsProcess(row, job, platform) {
    return hasFlagOperand(row, "--settings", settingsPathOf(job), job, platform, BINARIES);
  },
  maxLineBytes: MAX_FRAME_BYTES,
  probe(launcher, env = {}) { return probeAgy(launcher, env); },
  catalog: loadStaticCatalog().gemini,
  checkRequest(request, env = {}) { checkGeminiRequest(request, env); },
  buildTurn() { throw new Error("gemini buildTurn is not implemented yet"); },
  parseEvent() { return null; },
  reviewPlan(gitInfo, request) {
    return { native: false, template: request.adversarial ? "adversarial-review" : "review", schemaCarrier: "--json-schema" };
  },
  finalizeReview() { throw new Error("gemini finalizeReview is not implemented yet"); },
};

export default adapter;
