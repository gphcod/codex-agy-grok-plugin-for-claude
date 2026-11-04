// Grok adapter (PLAN.md S4, A5.1). Ported from grok-build-plugin-cc 1.1.5: lib/recipes.mjs (recipe,
// compatEnv, HOSTILE, FORBIDDEN, RESUME_DENY), lib/launcher.mjs (native Windows install fallback),
// lib/setup.mjs (parseModels, through the core parseModelListing), lib/reader.mjs:58-134 (catalogue
// guard, tool-call edit paths, session confirmation, stop reason, cost, usage) and grok.mjs:148-171
// (recipe selection by the session's agent, argv order, rules and schema carriers).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PLUGIN_ROOT, loadStaticCatalog, parseModelListing } from "../core/catalog.mjs";
import { hasFlagOperand } from "../core/execution.mjs";
import { pathCandidates, resolveLauncher as resolveBinary, runSync } from "../core/launcher.mjs";
import { loadTiers } from "../core/tiers.mjs";
import { normalizeStructuredReview, renderReview } from "../core/review.mjs";

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** Grok 1.0.70 has one CLI-wide effort set; `max` is rejected (A2), so the core clamps it to xhigh. */
export const EFFORTS = ["low", "medium", "high", "xhigh"];
export const BINS = ["grok", "grok.exe"];
/** grok-build reader LINE_CAP. */
export const LINE_CAP = 1024 * 1024;
const PATH_CAP = 10000;

// --- recipes (grok-build lib/recipes.mjs, whole) -----------------------------------------------------

// The verb defines scope in the prompt. Native tools remain available so a
// good-faith reviewer can inspect other repositories and use ordinary commands.
export const HOSTILE = [];
export const FORBIDDEN = [];
export const RESUME_DENY = [];

export function recipe(kind, { web = false, legacyExplore = false } = {}) {
  if (kind !== "read-only" && kind !== "write") throw new Error(`unknown recipe ${kind}`);
  return { readOnly: kind === "read-only", agent: "default", forbidden: [],
    args: [...(legacyExplore ? ["--agent", "default"] : []), "--always-approve"] };
}

/** Child environment: prevent updater and hook recursion; inherit native integrations. */
export function compatEnv(readOnly) {
  return {
    GROK_DISABLE_AUTOUPDATER: "1",
    GROK_CLAUDE_HOOKS_ENABLED: "0",
  };
}

/** The agent a session last ran: the thread record's, else inferred from its last mode (grok-build grok.mjs:150). */
export function sessionAgent(thread) {
  if (!thread) return null;
  return thread.agent ?? (thread.readOnly === false ? "default" : "explore");
}

/** One line: argv carries it, and nothing in it needs a newline (grok-build grok.mjs:23). */
export const oneLineContract = (text) => String(text).replace(/\s*\r?\n\s*/g, " ").trim();

const SCHEMA_FILE = path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json");
let schemaText = null;
/** The repository schema, minified, for the inline `--json-schema` carrier. */
export function inlineSchema() {
  schemaText ??= JSON.stringify(JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8")));
  return schemaText;
}

/** The known trade-offs `setup` states (A3.2). */
export const NOTES = [
  "every turn ends with a process scan for anything still carrying the job's --prompt-file (no launcher kind is trusted to leave nothing behind)",
  "turn instructions define scope; native tools use automatic approvals, and configured integrations and web search are inherited",
  "reviews run at the repository root (grok sessions refuse --add-dir) and answer in the inline review schema",
];

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
    // grok-build setup.mjs warnings: several executables on PATH, no login, a tier model missing from the listing.
    const warnings = [];
    const candidates = env.COUNCIL_GROK_BIN ? [] : distinctExecutables(pathCandidates("grok", env, process.platform));
    if (candidates.length > 1) warnings.push(`${candidates.length} grok executables on PATH; the first one runs`);
    if (!parsed.loggedIn) warnings.push("Grok is not logged in: run `grok` once and complete login");
    for (const [name, { model }] of Object.entries(loadTiers().grok ?? {})) {
      if (parsed.loggedIn && !Object.hasOwn(parsed.models, model)) warnings.push(`tier ${name}: model ${model} is not in \`grok models\``);
    }
    return {
      version: version.stdout.trim().split(/\r?\n/)[0] || null,
      loggedIn: parsed.loggedIn,
      models: Object.entries(parsed.models).map(([id, efforts]) => ({ id, efforts })),
      notes: NOTES,
      warnings,
    };
  },

  catalog: loadStaticCatalog().grok,

  /**
   * A5.1 argv: --prompt-file, --session-id (new) or -r (resumed), --cwd, streaming-json, model, effort,
   * --no-auto-update, the recipe, then --rules <contract> (not on reviews) or --json-schema <inline> (reviews).
   */
  buildTurn(request) {
    const kind = request.readOnly === false ? "write" : "read-only";
    const resumed = request.thread?.threadId ?? null;
    const plan = recipe(kind, { web: Boolean(request.web), legacyExplore: Boolean(resumed) && sessionAgent(request.thread) !== "default" });
    const threadId = resumed ?? randomUUID();
    const review = request.verb === "review";
    // grok 1.0.70 lists --add-dir but its sessions refuse it ("additionalDirectories is not supported"),
    // so a review runs at the repository root, where the diff's root-relative paths resolve.
    const cwd = review ? request.reviewTarget?.root ?? request.cwd : request.cwd;
    const promptFile = path.join(request.jobDir, "prompt.md");
    const args = [
      "--prompt-file", promptFile, ...(resumed ? ["-r", resumed] : ["--session-id", threadId]), "--cwd", cwd,
      "--output-format", "streaming-json", "--model", request.model, "--effort", request.effort, "--no-auto-update",
      ...plan.args,
      ...(review ? ["--json-schema", inlineSchema()] : ["--rules", oneLineContract(request.contract)]),
    ];
    return {
      args, env: compatEnv(plan.readOnly), promptFile, promptText: review ? request.reviewPrompt : request.text,
      answerFile: null, readOnly: plan.readOnly, agent: plan.agent, forbidden: plan.forbidden,
      contractCarrier: review ? "json-schema" : "rules", threadId,
    };
  },

  /**
   * grok-build reader.mjs:58-134 over the core reader. The turn (state.turn) says whether the read-only
   * guard applies; without one the guard applies (fail closed). Per-turn bookkeeping lives in state.grok.
   */
  parseEvent(line, state) {
    let ev;
    try { ev = JSON.parse(line); } catch { return null; }
    if (typeof ev?.type !== "string") return null;
    const turn = state?.turn ?? null;
    const readOnly = turn?.readOnly !== false;
    const g = (state.grok ??= { toolChecked: false, calls: new Map(), separate: false });
    switch (ev.type) {
      case "available_commands": {
        // Only `tools` is the catalogue (`commands` lists slash commands). An event without it leaves
        // validation pending; a `tools` value that is not a list fails the turn, even after a valid one.
        if (ev.tools === undefined) return {};
        if (!Array.isArray(ev.tools)) return { fatal: "malformed tool catalogue" };
        const names = ev.tools.map(toolName);
        if (names.some((n) => typeof n !== "string" || !n)) return { fatal: "malformed tool catalogue entry" };
        g.toolChecked = true;
        const bad = [];
        return bad.length ? { fatal: `read-only tool guard failed: ${bad.join(", ")}` } : {};
      }
      case "tool_call": {
        const name = nameOf(ev);
        // A forbidden or MCP call fails a read-only turn, whatever the catalogue said.
        if (g.calls.size >= PATH_CAP) return { fatal: "too many open tool calls in event stream" };
        g.calls.set(idOf(ev), { name, path: inputPath(ev) });
        g.separate = state.hasText; // Text before and after a tool call belongs to separate messages.
        return { toolStep: typeof name === "string" ? name : "tool_call" };
      }
      case "tool_call_update": {
        const id = idOf(ev);
        const call = g.calls.get(id);
        if (call && !call.path && EDIT_TOOLS.has(call.name)) call.path = updatePath(ev);
        if (ev.status === "failed") {
          const reason = (typeof ev.content === "string" ? ev.content : Array.isArray(ev.content)
            ? ev.content.map((part) => part?.text ?? "").join(" ") : "").slice(0, 2000);
          if (/permission denied|not (?:available|allowed)|approval required|user.configured deny/i.test(reason)) {
            g.calls.delete(id);
            return { denied: reason, deniedAction: call?.name ?? "tool" };
          }
        }
        const out = {};
        if (ev.status === "completed" && EDIT_TOOLS.has(call?.name) && call.path) out.edited = call.path;
        // A status of null (or none) is a progress update; only a named status other than these ends the call.
        if (typeof ev.status === "string" && ev.status !== "pending" && ev.status !== "in_progress") g.calls.delete(id);
        return out;
      }
      case "text": {
        const data = typeof ev.data === "string" ? ev.data : typeof ev.text === "string" ? ev.text : "";
        if (!data) return {};
        const delta = g.separate ? `\n\n${data}` : data;
        g.separate = false;
        return { textDelta: delta };
      }
      case "end": {
        const returned = ev.sessionId ?? ev.session_id ?? null;
        const expected = turn?.threadId ?? null;
        // Another session (or a malformed id) is fatal; a missing one keeps the answer but leaves the
        // session unconfirmed and not resumable (milestone 3 review Q4).
        if (returned !== null && returned !== "" && (typeof returned !== "string" || (expected && returned.toLowerCase() !== expected.toLowerCase()))) {
          return { fatal: `Grok answered on session ${JSON.stringify(returned)}, expected ${expected}` };
        }
        const stop = ev.stopReason ?? ev.stop_reason ?? null;
        const structured = ev.structuredOutput ?? ev.structured_output;
        return {
          completed: true,
          ...(returned ? { threadId: returned } : { unconfirmed: UNCONFIRMED }),
          // Grok's own `cancelled` stop is its headless permission refusal: a denial (exit 10), the turn
          // completed. With no text, the refusal is the answer, so the empty-answer rule cannot fail it
          // (S4.9, as the Codex-host twin). Council's own cancel path is unchanged.
          ...(stop === "cancelled" ? { denied: PERMISSION_STOP, deniedAction: deniedAction([...g.calls.values()].at(-1)?.name), ...(state.hasText ? {} : { textDelta: PERMISSION_STOP }) }
            // Any other stop but end_turn keeps the answer and fails the turn as incomplete (exit 1).
            : NORMAL_STOPS.has(stop) ? {} : { incomplete: `incomplete: Grok stopped with reason ${JSON.stringify(stop)}` }),
          ...(structured !== undefined && structured !== null ? { structured } : {}),
          ...(typeof ev.total_cost_usd === "number" ? { costUsd: ev.total_cost_usd } : {}),
          ...(ev.usage && typeof ev.usage === "object" ? { usage: ev.usage } : {}),
        };
      }
      case "error":
        return { error: typeof ev.message === "string" ? ev.message.slice(0, 2000) : "Grok reported an error" };
      case "max_turns_reached":
        return { incomplete: "incomplete: Grok stopped: max turns reached" };
      default:
        return {}; // thought, usage and anything new: activity, nothing to record.
    }
  },

  /** Collected-diff review (A5.1): the core renders the template over the diff; the schema rides inline. */
  reviewPlan(gitInfo, request) {
    return { native: false, template: request.adversarial ? "adversarial-review" : "review", schemaCarrier: "inline --json-schema" };
  },

  /** grok-build review.mjs: validate the structured output (reviewProblem), then map into A5.2. */
  finalizeReview({ structured, unreviewed }) {
    const { result, summary, nextSteps } = normalizeStructuredReview(structured, { unreviewed });
    return { ...result, summary, nextSteps, renderedText: renderReview(result, { summary, nextSteps }) };
  },
};

// --- event helpers (grok-build reader.mjs) ------------------------------------------------------------------

/** Stop reasons recorded as a finished turn; `cancelled` is a denial, anything else a failure. */
export const NORMAL_STOPS = new Set(["end_turn"]);
/** The footer hint for a turn whose end event named no session (core `unconfirmed`). */
export const UNCONFIRMED = "session not confirmed: start a new ask";
/** Grok's own `cancelled` stop: a tool needed a permission headless Grok cannot ask for (grok-build lifecycle.mjs:22). */
export const PERMISSION_STOP = "Grok cancelled the turn (a tool needed permission headless Grok cannot ask for)";
/** X1: the footer's `attention: denied <action>` for that refusal, naming the tool call still open when the turn stopped, if any. */
export const deniedAction = (tool) => `${typeof tool === "string" && tool && tool !== "tool_call" ? tool : "a tool call"} (needed permission headless Grok cannot ask for)`;
const EDIT_TOOLS = new Set(["search_replace", "write"]);
const nameOf = (ev) => ev.toolName ?? ev.tool_name ?? ev.name ?? ev.tool?.name ?? null;
const inputOf = (ev) => ev.rawInput ?? ev.input ?? ev.tool?.input ?? {};
const str = (v) => typeof v === "string" && v ? v : null;
// The file is in rawInput.file_path; updates repeat it in a diff, in locations (status null only) and
// in rawOutput.EditsApplied.absolute_path (completed only).
const inputPath = (ev) => { const input = inputOf(ev); return str(input?.file_path) ?? str(input?.path); };
const updatePath = (ev) => str(ev.rawOutput?.EditsApplied?.absolute_path)
  ?? (Array.isArray(ev.content) ? ev.content.map((c) => c?.type === "diff" ? str(c.path) : null).find(Boolean) : null)
  ?? (Array.isArray(ev.locations) ? ev.locations.map((l) => str(l?.path)).find(Boolean) : null) ?? null;
const idOf = (ev) => String(ev.toolCallId ?? ev.tool_call_id ?? ev.id ?? "");
const toolName = (entry) => typeof entry === "string" ? entry : entry?.name;
function promptFileOf(args) {
  if (!Array.isArray(args)) return null;
  const i = args.indexOf("--prompt-file");
  return i >= 0 ? args[i + 1] ?? null : null;
}

/** PATH entries that resolve to one file (a symlink such as ~/.local/bin/grok → ~/.grok/bin/grok) are one executable. */
export function distinctExecutables(candidates) {
  const seen = new Set();
  return candidates.filter((file) => {
    let key;
    try { key = fs.realpathSync(file); } catch { key = file; }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default adapter;
