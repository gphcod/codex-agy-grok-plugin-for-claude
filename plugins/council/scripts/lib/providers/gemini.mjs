// Gemini adapter (PLAN.md A5.1 gemini, S5) over the Antigravity CLI `agy` 1.4.12.
// Behaviour reimplemented from gemini-plugin-cc 2.1.0 (lib/agy.mjs buildLaunchDescription, the stdin
// message, resultFailure, isDeniedFailure, describeToolStep, describeStepError, MAX_FRAME_BYTES,
// MAX_PARTIAL_BYTES; gemini-companion.mjs getAgyAuthStatus; lib/review-output.mjs) without copying
// its code (no LICENSE in the installed copy, docs/decisions.md S0), and from gemini-plugin-for-codex
// (MIT) skills/agy/scripts/lib/settings.mjs (configuredPolicy, sessionSettings).
// Changes from gemini-plugin-cc: a job-specific --settings file on every turn (merged global lists,
// A2 deny union on read-only turns), --mode accept-edits only on tasks, --sandbox always, denial
// exits 10 instead of 20 (S5.7 parity record).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageError } from "../core/args.mjs";
import { PLUGIN_ROOT, loadStaticCatalog, parseModelListing, splitSuffix } from "../core/catalog.mjs";
import { hasFlagOperand } from "../core/execution.mjs";
import { resolveLauncher as resolveBinary, runSync } from "../core/launcher.mjs";

/** One stream-json frame, and the streamed answer, are capped at 32 MiB (gemini-plugin-cc lib/agy.mjs). */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
export const MAX_PARTIAL_BYTES = 32 * 1024 * 1024;
export const BINARIES = ["agy", "agy.exe"];
/** S7.2 sets this when the Windows session qualifies the agy path (A8). */
export const WINDOWS_QUALIFIED = false;
export const WINDOWS_UNSUPPORTED = "Gemini (agy) is not supported on Windows in council 1.0: the agy path is not qualified there (PLAN.md A8); use --to codex or --to grok";

/** A2 read-only deny list: the union of gemini-plugin-cc's and gemini-plugin-for-codex's rules. */
export const READ_ONLY_DENY = ["write_file(*)", "edit_file(*)", "command(*)", "unsandboxed(*)", "mcp(*)", "execute_url(*)"];
/** The only global allow rules a read-only turn keeps (gemini-plugin-for-codex sessionSettings). */
const READ_ONLY_ALLOW = /^(read_file|read_url)\(.*\)$/;
const LISTS = ["allow", "ask", "deny"];
export const GLOBAL_SETTINGS_MAX = 2 * 1024 * 1024;
export const SCHEMA_PATH = path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json");

/** The user's global agy settings file, under the HOME of the call's environment (never process.env). */
export function globalSettingsPath(env = {}) {
  return path.join(env.HOME || env.USERPROFILE || os.homedir(), ".gemini", "antigravity-cli", "settings.json");
}

function permissionLists(data, where) {
  const value = data?.permissions;
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error(`${where}: permissions must be an object; no turn submitted`);
  return Object.fromEntries(LISTS.map((key) => {
    const items = value?.[key] ?? [];
    if (!Array.isArray(items) || items.some((item) => typeof item !== "string")) throw new Error(`${where}: permissions.${key} must be a string array; no turn submitted`);
    return [key, items];
  }));
}

/**
 * The global permission policy (gemini-plugin-for-codex configuredPolicy): the three lists and the
 * toolPermission mode only, never credentials or other keys. An absent file is an empty policy.
 */
export function readGlobalPolicy(env = {}) {
  const file = globalSettingsPath(env);
  let text;
  try {
    if (fs.statSync(file).size > GLOBAL_SETTINGS_MAX) throw new Error(`${file} exceeds 2 MiB; no turn submitted`);
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { permissions: permissionLists({}, file), toolPermission: null };
    throw error;
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`${file} is not valid JSON; no turn submitted`); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${file} must contain a JSON object; no turn submitted`);
  return { permissions: permissionLists(data, file), toolPermission: typeof data.toolPermission === "string" ? data.toolPermission : null };
}

/**
 * The job's session settings (A5.1). A session list replaces the global one (S1.2), so the global
 * lists are carried over; a read-only turn keeps only read_file/read_url allow rules and adds the A2
 * deny rules; a task keeps the global lists as they are. `strict` tool permission is preserved.
 */
export function sessionSettings(policy, readOnly) {
  const permissions = Object.fromEntries(LISTS.map((key) => [key, [...new Set(policy.permissions[key])]]));
  if (readOnly) {
    permissions.allow = permissions.allow.filter((rule) => READ_ONLY_ALLOW.test(rule));
    permissions.deny = [...new Set([...permissions.deny, ...READ_ONLY_DENY])];
  }
  return { permissions, ...(policy.toolPermission === "strict" ? { toolPermission: "strict" } : {}) };
}

/** `--print-timeout` operand: plain decimal seconds, never grouped or in exponent form. */
export function printTimeout(seconds) {
  return `${Number(seconds).toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 })}s`;
}

/** A suffixed id passes alone (it fixes the effort); a family carries the clamped --effort (A5.1). */
export function modelArgs(model, effort, catalog) {
  if (splitSuffix(model, catalog)) return ["--model", model];
  return ["--model", model, ...(effort ? ["--effort", effort] : [])];
}

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
    return resolveBinary({ bin: "agy", binEnv: adapter.binEnv, env, platform });
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
  /**
   * A5.1: one NDJSON user message on stdin with the contract prepended (reviews send the rendered
   * review prompt alone); a job-specific --settings file on every turn; --sandbox always;
   * --mode accept-edits only on tasks; --conversation on reply and task --thread.
   */
  buildTurn(request) {
    assertPlatform(process.platform);
    const env = request.env ?? {};
    const readOnly = request.readOnly !== false;
    const review = request.verb === "review";
    const settingsPath = path.join(request.jobDir, "settings.json");
    fs.writeFileSync(settingsPath, `${JSON.stringify(sessionSettings(readGlobalPolicy(env), readOnly), null, 2)}\n`, { mode: 0o600 });
    const args = [
      "--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands",
      "--print-timeout", printTimeout(request.deadline), "--sandbox", "--settings", settingsPath,
      ...modelArgs(request.model, request.effort, adapter.catalog),
    ];
    if (!readOnly) args.push("--mode", "accept-edits");
    if (request.thread?.threadId) args.push("--conversation", request.thread.threadId);
    if (review) args.push("--json-schema", SCHEMA_PATH);
    const content = review ? request.reviewPrompt : `${request.contract}\n\n${request.text}`;
    return {
      args, env: {}, stdin: `${JSON.stringify({ event: "user", message: { content } })}\n`, settingsPath,
      answerFile: null, readOnly, contractCarrier: review ? "none" : "stdin-prefix", threadId: null,
    };
  },
  parseEvent() { return null; },
  reviewPlan(gitInfo, request) {
    return { native: false, template: request.adversarial ? "adversarial-review" : "review", schemaCarrier: "--json-schema" };
  },
  finalizeReview() { throw new Error("gemini finalizeReview is not implemented yet"); },
};

export default adapter;
