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
import { normalizeStructuredReview, renderReview } from "../core/review.mjs";
import { TIERS, loadTiers } from "../core/tiers.mjs";
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

// --- stream events (gemini-plugin-cc lib/agy.mjs behaviour) ----------------------------------------------

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonempty = (v) => typeof v === "string" && v !== "";
const clip = (text, limit) => { const t = String(text).replace(/\s+/g, " ").trim(); return t.length > limit ? `${t.slice(0, limit - 1)}…` : t; };
/** S1.2 denial signature: a failed tool step whose TOOL_ERROR names a user-configured deny rule. */
export const DENY_RULE = /Permission denied for [\s\S]*Matches user-configured deny rule/;

/** Tool name plus its main argument (a path, command, query or URL), for the job's progress. */
export function describeToolStep(step) {
  const name = step.tool_name ?? step.tool_info?.name ?? "tool";
  const params = isObject(step.tool_info?.parameters) ? Object.entries(step.tool_info.parameters).filter(([, v]) => typeof v === "string" && v.trim()) : [];
  const main = params.find(([k]) => /path|file|command|query|url|pattern|dir/i.test(k)) ?? params[0];
  return main ? `${name} ${clip(main[1], 160)}` : name;
}

/** A failed step's reason lives in tool_info.error.message, not in a top-level field. */
export function describeStepError(step) {
  const reason = step.tool_info?.error?.message ?? step.error?.message ?? step.error ?? "no reason given";
  return `failed: ${describeToolStep(step)} — ${clip(reason, 200)}`;
}

export function isDenialStep(step) {
  return step?.step_type === "tool" && step.state === "ERROR" && step.tool_info?.error?.type === "TOOL_ERROR" && DENY_RULE.test(String(step.tool_info.error.message ?? ""));
}

/** The first balanced {...} in the text that parses as JSON (the fallback when structured_output is absent). */
export function firstJsonObject(text) {
  const src = String(text ?? "");
  for (let open = src.indexOf("{"); open >= 0; open = src.indexOf("{", open + 1)) {
    let depth = 0, quoted = false, escaped = false, end = -1;
    for (let i = open; i < src.length && end < 0; i++) {
      const c = src[i];
      if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; continue; }
      if (c === '"') quoted = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) end = i;
    }
    if (end < 0) continue; // unbalanced from here (`if (x) {` in prose): try the next opening brace
    try { const value = JSON.parse(src.slice(open, end + 1)); if (isObject(value)) return value; } catch { /* try the next brace */ }
  }
  return null;
}

/**
 * One stream-json line → the A5 event. The answer is the terminal result's response (the streamed
 * agent_response deltas when it is empty), emitted once at the result; deltas are collected up to
 * MAX_PARTIAL_BYTES. Terminal validation: a duplicate result, a malformed one, status other than
 * SUCCESS → fatal (exit 1); print_timeout → incomplete (exit 1, the partial answer still emitted); a denial (the S1.2 tool-step
 * signature, or non-empty denied_actions; the key may be absent or empty) → denied (exit 10), checked
 * before the empty-answer rule; an empty answer (response and deltas) without a denial → fatal. A missing result
 * leaves the turn uncompleted, which the core fails (exit 1).
 */
export function parseAgyEvent(line, state) {
  if (!line.trim()) return null;
  let ev;
  try { ev = JSON.parse(line); } catch { return { fatal: "agy emitted malformed stream-json output; expected one JSON event per line" }; }
  if (!isObject(ev) || typeof ev.event !== "string") return { fatal: "agy emitted a stream event without an event name" };
  const own = (state.gemini ??= { result: false, partial: "", partialBytes: 0, denials: [] });
  const out = {};
  const id = [ev.conversation_id, ev.step_update?.conversation_id, ev.result?.conversation_id].find(nonempty);
  if (id) out.threadId = id;
  if (ev.event === "step_update" && isObject(ev.step_update)) {
    const step = ev.step_update;
    if (step.step_type === "agent_response" && nonempty(step.text_delta)) {
      own.partialBytes += Buffer.byteLength(step.text_delta, "utf8");
      if (own.partialBytes > MAX_PARTIAL_BYTES) return { fatal: "agy partial response exceeds the 32 MiB limit; stopped instead of truncating" };
      own.partial += step.text_delta;
    }
    if (step.step_type === "tool" || step.tool_name || step.tool_info) {
      out.toolStep = step.state === "ERROR" ? describeStepError(step) : describeToolStep(step);
      if (isDenialStep(step)) { own.denials.push(out.toolStep); out.denied = `agy denied ${out.toolStep.replace(/^failed: /, "")}`; }
    }
    return Object.keys(out).length ? out : null;
  }
  if (ev.event !== "result") return Object.keys(out).length ? out : null;
  if (own.result) return { fatal: "agy emitted duplicate terminal results for one turn" };
  own.result = true;
  const r = ev.result;
  if (!isObject(r) || typeof r.status !== "string" || typeof r.response !== "string") return { fatal: "agy returned a malformed result: expected status and response strings" };
  if (r.denied_actions !== undefined && !Array.isArray(r.denied_actions)) return { fatal: "agy returned malformed denied_actions; expected an array" };
  if (isObject(r.usage)) out.usage = r.usage;
  if (r.status !== "SUCCESS") return { ...out, fatal: `agy finished with status ${r.status}${r.error ? `: ${clip(r.error, 500)}` : ""}` };
  const answer = r.response.trim() ? r.response : own.partial;
  // The partial answer is kept for the reader; the turn still fails (exit 1, A3.3).
  if (r.finished_reason === "print_timeout") return { ...out, ...(answer.trim() ? { textDelta: answer } : {}), completed: true, incomplete: "agy hit its print timeout before the turn finished; the response is partial. Retry with a larger --deadline or a narrower request" };
  const actions = r.denied_actions ?? [];
  const denied = actions.length ? `agy denied ${actions.length} requested action(s): ${clip(actions.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join("; "), 400)}`
    : own.denials.length ? `agy denied ${own.denials.length} tool call(s) by a deny rule: ${clip(own.denials.map((d) => d.replace(/^failed: /, "")).join("; "), 400)}` : null;
  if (!denied && !answer.trim()) return { ...out, fatal: "agy returned an empty response; no usable result was produced" };
  const structured = isObject(r.structured_output) ? r.structured_output : firstJsonObject(answer);
  if (structured) out.structured = structured;
  if (denied) out.denied = denied;
  out.textDelta = answer.trim() ? answer : `${denied}\n`;
  out.completed = true;
  return out;
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

export const WEB_NOTE = "web search stays available on read-only turns: agy's search_web tool ignores a search_web(*) deny rule (S1.2), so --web --to gemini exits 2 rather than pretending to switch it";

/** A5.1: each tier's resolved suffixed id (`gemini-4-argon` + high → `gemini-4-argon-high`) must be listed by `agy models`. */
export function tierWarnings(listed, tiers = loadTiers().gemini ?? {}) {
  const ids = new Set(listed);
  const warnings = [];
  for (const t of TIERS) {
    const tier = tiers[t];
    if (!tier?.model) continue;
    const id = /-(low|medium|high|xhigh|max)$/.test(tier.model) ? tier.model : `${tier.model}-${tier.effort}`;
    if (!ids.has(id)) warnings.push(`tier ${t} resolves to ${id}, which agy models does not list`);
  }
  return warnings;
}

/** gemini-plugin-cc getAgyAuthStatus: `agy models` exiting 0 is the login check; also the listing. */
export function probeAgy(launcher, env = {}, platform = process.platform, run = runSync, tiers = undefined) {
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
  const models = Object.entries(parsed.models).map(([id, efforts]) => ({ id, efforts }));
  return { version: versionText, loggedIn: true, models, notes: [WEB_NOTE], warnings: tierWarnings(models.map((m) => m.id), tiers) };
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
  parseEvent(line, state) { return parseAgyEvent(line, state); },
  reviewPlan(gitInfo, request) {
    return { native: false, template: request.adversarial ? "adversarial-review" : "review", schemaCarrier: "--json-schema" };
  },
  /** Schema output (structured_output, or the first JSON object of the answer) through the shared validator into A5.2. */
  finalizeReview({ structured, unreviewed = [] }) {
    const { result, summary, nextSteps } = normalizeStructuredReview(structured, { unreviewed });
    return { ...result, summary, nextSteps, renderedText: renderReview(result, { summary, nextSteps }) };
  },
};

export default adapter;
