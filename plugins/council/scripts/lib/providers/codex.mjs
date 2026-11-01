// Codex adapter (PLAN.md A5.1, S3). Ported from codex-plugin-cc 2.3.2: codex-companion.mjs (turn
// construction, SANDBOX per verb, review routes at 150-159), lib/tools.mjs (MCP policy,
// CODEX_COMPANION_MCP → COUNCIL_CODEX_MCP), lib/setup.mjs (extractModels, the MCP trade-off),
// lib/reader.mjs:50-74 (events), lib/answer.mjs:16 (the [P0]/[P1] scan) and lib/launcher.mjs
// (vendor codex.exe behind an npm shim; waitsForCodex, the launcher kinds whose clean exit is trusted).
// The core supplies jobs, claims, lifecycle, execution and the reader; nothing here reads process.env.
import { statSync } from "node:fs";
import path from "node:path";
import { UsageError } from "../core/args.mjs";
import { loadStaticCatalog, parseModelListing } from "../core/catalog.mjs";
import { childEnv, hasFlagOperand } from "../core/execution.mjs";
import { resolveLauncher as resolveCoreLauncher, runSync } from "../core/launcher.mjs";
import { renderReview } from "../core/review.mjs";

export const BIN_ENV = "COUNCIL_CODEX_BIN";
export const MCP_ENV = "COUNCIL_CODEX_MCP";
/** codex-companion.mjs SANDBOX; `rescue` is council's `task`. */
export const SANDBOX = { ask: "read-only", reply: "read-only", review: "read-only", task: "workspace-write" };
/** lib/reader.mjs LINE_CAP. */
export const LINE_CAP = 1024 * 1024;
/** Binary names that qualify a macOS `ps` row carrying the job's operand (npm's codex.js runs under node). */
const BINS = ["codex", "codex.js"];
// lib/tools.mjs: ask, reply and review drop the user's tools under COUNCIL_CODEX_MCP=off; a task keeps them.
const MCP_READ_ONLY = new Set(["ask", "reply", "review"]);
// Plugins and ChatGPT apps are switched off whole: a per-server override on a plugin's server is a
// config error in Codex 0.162 ("invalid transport"), and `mcp list` does not mark them.
const WHOLE = ["--disable", "plugins", "--disable", "apps"];
// lib/setup.mjs MCP_TRADE_OFF, the codex-plugin-cc 2.3.0 measurement.
export const MCP_TRADE_OFF = "measured 19-29% fewer input tokens on a fresh ask, for one or two `codex mcp list` runs before each such call " +
  "(about 155-195 ms with native codex.exe on Windows, 300 ms with npm's codex.js; about 90-100 ms on macOS)";
/** codex-rs review_format: the text `codex exec review` writes when the reviewer produced nothing. */
export const REVIEW_FALLBACK = "Reviewer failed to output a response.";
const NATIVE = {
  "win32-x64": ["@openai/codex-win32-x64", "x86_64-pc-windows-msvc"],
  "win32-arm64": ["@openai/codex-win32-arm64", "aarch64-pc-windows-msvc"],
};

const firstLine = (run) => String(run.stderr || run.stdout || run.error?.message || `exit ${run.status}`).trim().split(/\r?\n/)[0];
function messageOf(value) {
  const raw = typeof value === "string" ? value : value?.message;
  if (typeof raw !== "string") return null;
  try { return JSON.parse(raw)?.error?.message ?? raw; } catch { return raw; }
}
const shortCommand = (cmd = "") => String(cmd)
  .replace(/^"?[^"]*?(?:pwsh|powershell|bash|zsh|sh|cmd)(?:\.exe)?"?\s+(?:-Command|-l?c|\/c)\s+/i, "")
  .replace(/^(['"])(.*)\1$/s, "$2").slice(0, 80);

/** The vendor codex.exe an npm shim's codex.js would run (lib/launcher.mjs nativeFor). */
export function vendorExe(entry, platform, arch, isFile) {
  const target = NATIVE[`${platform}-${arch}`];
  if (!target) return null;
  const [pkg, triple] = target;
  const root = path.resolve(path.dirname(entry), "..");
  const nodeModules = path.dirname(path.dirname(root));
  return [
    path.join(root, "node_modules", pkg, "vendor", triple, "bin", "codex.exe"),
    path.join(nodeModules, pkg, "vendor", triple, "bin", "codex.exe"),
    path.join(root, "vendor", triple, "bin", "codex.exe"),
  ].find(isFile) ?? null;
}

/**
 * lib/launcher.mjs waitsForCodex: native codex.exe, or npm's codex.js, which runs the native Codex with
 * inherited output and exits only after it. Another launcher (a wrapper in COUNCIL_CODEX_BIN) may leave
 * a backend running with output of its own.
 */
export function waitsForCodex(launcher) {
  if (!launcher || !Array.isArray(launcher.args)) return false;
  if (!launcher.args.length) return /(?:^|[\\/])codex\.exe$/i.test(launcher.command);
  return launcher.args.length === 1 && /[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js$/i.test(launcher.args[0]);
}

/**
 * lib/tools.mjs toolPolicy: the Codex arguments that keep MCP servers, plugins and apps out of a
 * read-only turn under COUNCIL_CODEX_MCP=off, or none. Servers left after plugins and apps are off
 * are disabled by name for this invocation only, and Codex lists them again with the same arguments;
 * a server still enabled fails the turn. Costs one `codex mcp list --json` call, two when servers are
 * configured (S1.1). No per-process cache: a companion runs one turn.
 */
export function toolPolicy({ verb, launcher, cwd, env = {}, run = runSync }) {
  const policy = env[MCP_ENV] || "inherit";
  if (policy !== "inherit" && policy !== "off") throw new UsageError(`${MCP_ENV} must be inherit or off`);
  if (policy === "inherit" || !MCP_READ_ONLY.has(verb)) return [];
  const servers = (args) => {
    const r = run(launcher, ["mcp", "list", "--json", ...args], { env: childEnv(env), cwd });
    if (r.error || r.status !== 0) throw new Error(`${MCP_ENV}=off needs \`codex mcp list --json\`, which failed: ${firstLine(r)}`);
    let list = null;
    try { list = JSON.parse(r.stdout); } catch { /* reported below */ }
    if (!Array.isArray(list) || !list.every((s) => typeof s?.name === "string" && typeof s.enabled === "boolean")) {
      throw new Error(`${MCP_ENV}=off cannot read \`codex mcp list --json\` from this Codex version`);
    }
    return list;
  };
  const direct = servers(WHOLE).filter((s) => s.enabled);
  if (!direct.length) return [...WHOLE];
  const args = [...WHOLE, "-c", `mcp_servers={${direct.map((s) => `${JSON.stringify(s.name)}={enabled=false}`).join(",")}}`];
  const left = servers(args).filter((s) => s.enabled).map((s) => s.name);
  if (left.length) throw new Error(`${MCP_ENV}=off could not disable MCP server ${left.join(", ")}; nothing was started`);
  return args;
}

// --- review output (lib/answer.mjs:16, codex-rs review_format) ------------------------------------------

const FINDING_LINE = /^\s*[-*]\s+\[P(\d)\]\s+(.+?)\s+—\s+(.+):(\d+)(?:-(\d+))?\s*$/;
const MARKER = /\[P\d\]/;
const HEADER = /^\s*(?:Review comment|Full review comments):\s*$/;

/**
 * The native review text → A5.2. `[P0]` → BLOCKER and `[P1]` → MAJOR, scanned over the whole answer.
 * Codex renders a review as its explanation plus, when there are findings, a "Review comment(s):"
 * block of `- [P<n>] <title> — <path>:<start>-<end>` lines with indented bodies; a model output Codex
 * could not parse becomes explanation text with no findings, so text without a [P0]/[P1] finding can
 * never prove an approval (A5.1, A5.2). Any other finding form (another priority, a marker outside the
 * line shape), an empty answer or Codex's fallback text is `incomplete`.
 */
export function parseNativeReview(answerText = "") {
  const text = String(answerText).replace(/\r\n?/g, "\n");
  const findings = [], unrecognized = [], summary = [];
  let current = null, inBlock = false;
  for (const line of text.split("\n")) {
    if (HEADER.test(line)) { inBlock = true; current = null; continue; }
    const m = FINDING_LINE.exec(line);
    if (m && (m[1] === "0" || m[1] === "1")) {
      const start = Number(m[4]), end = m[5] === undefined ? start : Number(m[5]);
      if (start >= 1 && end >= start) {
        current = { severity: m[1] === "0" ? "BLOCKER" : "MAJOR", file: m[3].trim(), line: start, ...(end > start ? { lineEnd: end } : {}), title: m[2].trim(), text: "" };
        findings.push(current); inBlock = true;
        continue;
      }
    }
    if (MARKER.test(line)) { unrecognized.push(line.trim()); current = null; inBlock = true; continue; }
    if (current && /^\s+\S/.test(line)) { current.text = current.text ? `${current.text}\n${line.trim()}` : line.trim(); continue; }
    if (line.trim()) current = null;
    if (!inBlock) summary.push(line);
  }
  const explanation = summary.join("\n").trim();
  let incomplete = null;
  if (!text.trim()) incomplete = "Codex returned no review text";
  else if (text.trim() === REVIEW_FALLBACK) incomplete = "Codex's reviewer failed to output a response";
  else if (unrecognized.length) incomplete = `${unrecognized.length} finding line(s) in a form other than [P0]/[P1] with a location: ${unrecognized.slice(0, 3).map((l) => JSON.stringify(l.slice(0, 120))).join(", ")}`;
  else if (!findings.length) incomplete = "no [P0]/[P1] finding, and Codex's native review text cannot prove an approval";
  return { findings, unrecognized, summary: explanation || null, incomplete };
}

// --- the adapter -----------------------------------------------------------------------------------------

const adapter = {
  id: "codex",
  binEnv: BIN_ENV,

  /** PATH or COUNCIL_CODEX_BIN through the core resolver; the platform rides on the launcher for trustsCleanExit. */
  resolveLauncher(env = {}, platform = process.platform, arch = process.arch) {
    const launcher = resolveCoreLauncher({ bin: "codex", binEnv: BIN_ENV, env, platform, arch, vendor: (entry, p, a) => vendorExe(entry, p, a, isFileSync) });
    return launcher ? { ...launcher, platform } : null;
  },

  /**
   * codex-plugin-cc trusted a clean exit only on Windows and only for waitsForCodex launchers
   * (lifecycle.mjs:210): Linux and macOS scan after every exit (a few ms), Windows would pay a
   * PowerShell query. Every other platform or launcher gets the post-exit scan.
   */
  trustsCleanExit(launcher) {
    return launcher?.platform === "win32" && waitsForCodex(launcher);
  },

  /** A5.1 ownership: the job's exact `-o <answer>` operand. */
  ownsProcess(row, job, platform = process.platform) {
    const answer = job?.turn?.answerFile ?? (job?.dir ? path.join(job.dir, "answer.md") : null);
    return hasFlagOperand(row, "-o", answer, job, platform, BINS);
  },

  maxLineBytes: LINE_CAP,
  catalog: loadStaticCatalog().codex,

  /** Version, login and `debug models` (lib/setup.mjs), plus the MCP policy line setup states. */
  probe(launcher, env = {}) {
    const version = runSync(launcher, ["--version"], { env });
    if (version.error || version.status !== 0) throw new Error(`codex --version failed: ${firstLine(version)}`);
    const login = runSync(launcher, ["login", "status"], { env });
    const warnings = [], notes = [];
    if (login.status !== 0) warnings.push(`codex login status: ${firstLine(login)}`);
    let models = null;
    try {
      const listing = runSync(launcher, ["debug", "models"], { env, timeoutMs: 30000 });
      if (listing.status === 0) models = Object.entries(parseModelListing("codex", listing.stdout).models).map(([id, efforts]) => ({ id, efforts }));
    } catch { /* reported below */ }
    if (!models) warnings.push("could not read the model catalogue (codex debug models)");
    const policy = env[MCP_ENV];
    if (policy === "off") {
      try {
        const started = performance.now();
        const args = toolPolicy({ verb: "ask", launcher, cwd: undefined, env });
        const ms = Math.round(performance.now() - started), servers = args.some((a) => a.startsWith("mcp_servers="));
        notes.push(`mcp: off for ask, reply and review: plugins, apps${servers ? " and configured servers" : ""} disabled; this check ran \`codex mcp list\` ${servers ? "twice" : "once"} in ${ms} ms, and each such call repeats it`);
      } catch (error) { warnings.push(error.message); }
    } else if (policy && policy !== "inherit") warnings.push(`${MCP_ENV} must be inherit or off`);
    else notes.push(`mcp: inherit (default): ask, reply and review keep your MCP servers, plugins and apps; ${MCP_ENV}=off would drop them there: ${MCP_TRADE_OFF}`);
    return { version: version.stdout.trim(), loggedIn: login.status === 0, models, warnings, notes };
  },

  /** A3.3: flags Codex has no tested mapping for exit 2 before any job record. */
  checkRequest(request, env = {}) {
    if (request.adversarial) throw new UsageError("review --to codex has no --adversarial: Codex's native review has no adversarial mode; give focus text instead");
    if (request.web) throw new UsageError("--web has no tested mapping for codex");
    const policy = env[MCP_ENV];
    if (policy && policy !== "inherit" && policy !== "off") throw new UsageError(`${MCP_ENV} must be inherit or off`);
  },

  /**
   * A5.1: fresh `exec -C <cwd> -s <mode>`; `exec resume <thread> -c sandbox_mode=<mode>` (resume and
   * review accept neither -C nor -s; the core spawns with cwd set); `exec review` with the target flags
   * and no stdin, or with focus: the target sentence plus focus on stdin, a trailing `-` and no flags.
   */
  buildTurn(request) {
    const env = request.env ?? {};
    const answerFile = path.join(request.jobDir, "answer.md");
    const tools = toolPolicy({ verb: request.verb, launcher: request.launcher, cwd: request.cwd, env });
    const effortArgs = [...(request.effort ? ["-c", `model_reasoning_effort=${request.effort}`] : []), ...tools];
    const base = { env: {}, answerFile, threadId: null };
    if (request.verb === "review") {
      const native = request.reviewNative ?? { flags: request.reviewTarget?.flags ?? [], stdin: null };
      const focused = typeof native.stdin === "string" && native.stdin.length > 0;
      const args = ["exec", "review", ...(focused ? [] : native.flags), "--json", "-o", answerFile, "-c", "sandbox_mode=read-only",
        "-m", request.model, "-c", `review_model=${request.model}`, ...effortArgs, ...(focused ? ["-"] : [])];
      return { ...base, args, ...(focused ? { stdin: native.stdin } : {}), readOnly: true, contractCarrier: "none" };
    }
    const sandbox = request.readOnly === false ? SANDBOX.task : SANDBOX[request.verb] ?? "read-only";
    const tail = ["-m", request.model, ...effortArgs, "-c", `developer_instructions=${JSON.stringify(request.contract)}`, "-"];
    const thread = request.thread?.threadId ?? null;
    const args = thread
      ? ["exec", "resume", thread, "--json", "-o", answerFile, "-c", `sandbox_mode=${sandbox}`, ...tail]
      : ["exec", "--json", "-o", answerFile, "-C", request.cwd, "-s", sandbox, ...tail];
    return { ...base, args, stdin: request.text, readOnly: sandbox === "read-only", contractCarrier: "developer_instructions" };
  },

  /** lib/reader.mjs:50-74. The answer comes from the -o file, so agent_message carries nothing here. */
  parseEvent(line) {
    let ev;
    try { ev = JSON.parse(line); } catch { return null; }
    if (typeof ev?.type !== "string") return null;
    const item = ev.item;
    switch (ev.type) {
      case "thread.started":
        return typeof ev.thread_id === "string" ? { threadId: ev.thread_id } : { fatal: "invalid thread.started id" };
      case "turn.completed":
        return { completed: true, ...(ev.usage ? { usage: ev.usage } : {}) };
      case "turn.failed":
        return { fatal: messageOf(ev.error) ?? "turn failed" };
      case "error":
        // Not latched: Codex reports retries this way and may still complete (lib/reader.mjs keeps it as
        // the message for a turn that ends without turn.completed).
        return { error: messageOf(ev) ?? "codex reported an error" };
      case "item.started":
        return item?.type === "command_execution" ? { toolStep: `command: ${shortCommand(item.command)}` } : item?.type ? { toolStep: item.type } : null;
      case "item.completed":
        if (item?.type === "file_change" && item.status === "completed") {
          if (!Array.isArray(item.changes)) return { fatal: "invalid file_change changes" };
          return { edited: item.changes.map((c) => c?.path).filter((p) => typeof p === "string"), toolStep: "file_change" };
        }
        if (item?.type === "command_execution" && Number.isInteger(item.exit_code) && item.exit_code !== 0) {
          return { failedCommand: { cmd: shortCommand(item.command), exit: item.exit_code }, toolStep: "command_execution" };
        }
        return item?.type ? { toolStep: item.type } : null;
      default:
        return null;
    }
  },

  /** Native route always: the target flags, or the target sentence plus focus on stdin. */
  reviewPlan(gitInfo, request) {
    const target = gitInfo.target;
    const focus = typeof request.text === "string" && request.text.trim() ? request.text : null;
    return { native: true, flags: target.flags, stdin: focus ? `${target.sentence}\n\n${focus}` : null };
  },

  /** The whole stored answer → A5.2; an incomplete result keeps Codex's text after the verdict. */
  finalizeReview({ answerText = "" }) {
    const parsed = parseNativeReview(answerText);
    const result = { verdict: parsed.incomplete ? "incomplete" : "changes", findings: parsed.findings, coverage: { reviewed: [], unreviewed: [] }, incomplete: parsed.incomplete };
    let renderedText = renderReview(result, { summary: parsed.summary });
    if (parsed.incomplete && String(answerText).trim()) renderedText += `\nCodex review output:\n\n${String(answerText).trimEnd()}\n`;
    return { ...result, summary: parsed.summary, renderedText };
  },
};

function isFileSync(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}
export default adapter;
