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
};

function isFileSync(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}
export default adapter;
