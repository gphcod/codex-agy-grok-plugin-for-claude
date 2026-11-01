#!/usr/bin/env node
// council entry (PLAN.md S2.6): parse → request-id lookup → resolve provider → fingerprint → load the
// provider module → resolve tier, model, effort → admit → runManagedTurn → print. Ported from
// grok-build-plugin-cc 1.1.5 grok.mjs (requestKey, replay, runTurn, thread resolution, round and
// settings inheritance, finished-result replay, wait/cancel dispatch) and codex-plugin-cc 2.3.2
// codex-companion.mjs and lib/requests.mjs (fingerprint over raw inputs). Provider modules are
// loaded by fs.existsSync plus dynamic import(); S3–S5 add them without editing this file.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROVIDERS, TURN_VERBS, VERBS, UsageError, parseArgv, roundCount, seconds } from "./lib/core/args.mjs";
import { readControlArgs, readText, splitReply, stdinIdleMs } from "./lib/core/stdin.mjs";
import { canonical } from "./lib/core/fs.mjs";
import { PLUGIN_ROOT, catalogPath, loadCatalog, refreshCatalog } from "./lib/core/catalog.mjs";
import { TIERS, loadTiers, resolveTier } from "./lib/core/tiers.mjs";
import { assertNotNested, childEnv, companionState, executionController } from "./lib/core/execution.mjs";
import {
  REQUEST_ID, bindScope, candidates, claimRequest, claimScope, homeDir, loadJob, loadScope, loadThread, loadTombstone, markRequestPrepared, releaseRequest, releaseScope,
} from "./lib/core/jobs.mjs";
import { DEADLINE_S, DEFAULT_ROUNDS, INACTIVITY_S, cancelJob, replayRequest, runManagedTurn, waitFor } from "./lib/core/lifecycle.mjs";
import { renderResult, resultJson, startLine } from "./lib/core/output.mjs";
import { collectReview, reviewTarget } from "./lib/core/git.mjs";
import { renderReviewPrompt } from "./lib/core/review.mjs";
import { pathCandidates } from "./lib/core/launcher.mjs";

export { VERBS };
/** Display names of the provider binaries, for `setup` when a provider module is not in this build. */
export const BINARIES = { codex: "codex", gemini: "agy", grok: "grok" };
const FIXTURES = path.resolve(PLUGIN_ROOT, "..", "..", "tests", "fixtures");
/** Test-only providers: two ids, so cross-provider paths can be tested without a real provider module. */
const TEST_PROVIDERS = { null: "null-adapter.mjs", null2: "null2-adapter.mjs" };
/**
 * Options that never change what runs: output, scope and timing (codex-plugin-cc lib/requests.mjs:10,
 * plus wait's timeout and the two turn timers), so a retry with a longer deadline replays.
 */
const NOT_INPUTS = new Set(["json", "request-id", "session", "timeout", "deadline", "inactivity-timeout"]);
const REVIEW_ONLY = ["base", "commit", "uncommitted", "adversarial"];

export const USAGE = `usage: council <${VERBS.join("|")}> [--options] [-- text] (text on stdin otherwise)`;

// --- provider registry -------------------------------------------------------------------------------

/** codex, gemini, grok; plus the test providers `null` and `null2` only when COUNCIL_TEST_NULL_ADAPTER=1. */
export function providerNames(env) {
  return env.COUNCIL_TEST_NULL_ADAPTER === "1" ? [...PROVIDERS, ...Object.keys(TEST_PROVIDERS)] : [...PROVIDERS];
}
/**
 * The module file of a provider, or null when it is not in this build. Test seam: under
 * COUNCIL_TEST_NULL_ADAPTER=1, COUNCIL_TEST_ABSENT_PROVIDERS (comma-separated) hides real provider
 * modules, so core tests of the "not available in this build" paths never launch a real CLI once the
 * adapters exist.
 */
export function adapterFile(provider, env) {
  if (Object.hasOwn(TEST_PROVIDERS, provider)) return env.COUNCIL_TEST_NULL_ADAPTER === "1" ? path.join(FIXTURES, TEST_PROVIDERS[provider]) : null;
  if (env.COUNCIL_TEST_NULL_ADAPTER === "1" && String(env.COUNCIL_TEST_ABSENT_PROVIDERS ?? "").split(",").includes(provider)) return null;
  return path.join(PLUGIN_ROOT, "scripts", "lib", "providers", `${provider}.mjs`);
}
function checkProvider(provider, env) {
  if (!providerNames(env).includes(provider)) throw new UsageError(`--to must be one of ${PROVIDERS.join(", ")}`);
}
/** Loads a provider module; an absent file exits 2 (`provider <p> not available in this build`). */
export async function loadAdapter(provider, env) {
  checkProvider(provider, env);
  const file = adapterFile(provider, env);
  if (!file || !fs.existsSync(file)) throw new UsageError(`provider ${provider} not available in this build`);
  const adapter = (await import(pathToFileURL(file).href)).default;
  if (!adapter || adapter.id !== provider) throw new Error(`provider module ${file} does not export the ${provider} adapter`);
  return adapter;
}
/** Static catalog and tier table: models.json/tiers.json for the three providers, the adapter's own otherwise. */
export function catalogFor(home, adapter) {
  return loadCatalog(home, adapter.id, PROVIDERS.includes(adapter.id) ? {} : { staticEntry: adapter.catalog ?? {} });
}
export function tiersFor(adapter, env = {}) {
  return PROVIDERS.includes(adapter.id) ? loadTiers() : { [adapter.id]: typeof adapter.tiersFor === "function" ? adapter.tiersFor(env) : adapter.tiers };
}

// --- request identity (A7.4) ---------------------------------------------------------------------------

/** Fingerprint over the raw inputs, taken before thread, tier or catalog resolution. */
export function fingerprint(verb, o, text) {
  const inputs = Object.keys(o).filter((key) => !NOT_INPUTS.has(key)).sort().map((key) => [key, o[key]]);
  return createHash("sha256").update(JSON.stringify([verb, inputs, text])).digest("hex");
}
/**
 * Waits on another call's binding of this request id (A7.4, S2.9): a different fingerprint exits 2;
 * once the binding names its provider and job, the job is replayed; a binding whose call was proven
 * gone before it named a job is reported as safe to retry with a new id; a released binding is
 * claimed again. → {replay: claimed-job descriptor} | {retry: true}
 */
async function awaitScope(ctx, o, scope, fp, control, sleepMs = 50) {
  const name = `request id ${o["request-id"]}`;
  const end = Date.now() + seconds(o.deadline, DEADLINE_S, "deadline") * 1000;
  for (let checkedAt = 0; ; await new Promise((r) => setTimeout(r, sleepMs))) {
    if (!fs.existsSync(scope.file)) return { retry: true };
    // Bindings are created complete (claimScope links a written file), so an unreadable one was damaged
    // afterwards: its creator cannot be proven gone, so it is waited on like a live one until the deadline.
    const record = loadScope(scope.file);
    if (record?.fingerprint && record.fingerprint !== fp) throw new UsageError(`${name} was already used with different input; use a new request id`);
    if (record?.job) return { replay: { id: record.job, fresh: false, tombstone: loadTombstone(ctx.home, record.job), provider: record.provider } };
    if (record && Date.now() - checkedAt >= 1000) {
      checkedAt = Date.now();
      let snapshot;
      try { snapshot = control.snapshot(); } catch { snapshot = { state: "unknown", rows: [] }; }
      if (companionState(record, snapshot) === "gone" && !loadScope(scope.file)?.job) {
        throw new UsageError(`${name}: its first call ended before it chose a provider; nothing ran, so a new request id is safe`);
      }
    }
    if (Date.now() >= end) throw new UsageError(`${name}: the first call with this id has not chosen its provider yet; retry with the same request id to keep waiting`);
  }
}

// --- provider and thread resolution ----------------------------------------------------------------------

/**
 * ask/review/fresh task: `--to` names the provider. reply and `task --thread`: the job or thread
 * record names it (a conflicting `--to` exits 2); `reply --last` is this session's latest threaded
 * job in this workspace (A7.2). A native thread is never adopted across workspaces (A7.3).
 */
export function resolveTarget(ctx, verb, o) {
  if (o.to !== undefined) checkProvider(o.to, ctx.env);
  if (verb === "ask" || verb === "review" || (verb === "task" && o.thread === undefined)) {
    if (o.thread !== undefined) throw new UsageError(`${verb} starts a new thread; continue one with reply --thread`);
    if (o.last) throw new UsageError(`--last applies to reply`);
    if (o.to === undefined) throw new UsageError(`${verb} needs --to ${PROVIDERS.join("|")}`);
    return { provider: o.to, thread: null };
  }
  if (o.last && verb !== "reply") throw new UsageError("--last applies to reply");
  let job = null, provider = null, threadId = null;
  if (o.last) {
    job = candidates(ctx.home, ctx).find((j) => j.admitted !== false && j.threadId && j.verb !== "review");
    if (!job) throw new UsageError(`no earlier thread in this ${ctx.session ? "session and " : ""}workspace; start one with ask`);
  } else {
    const ref = o.thread;
    if (!ref) throw new UsageError(`${verb} needs --thread <job|thread>${verb === "reply" ? ", --last, or the job id as the first word" : ""}`);
    job = loadJob(ctx.home, ref);
    if (!job) {
      const owners = providerNames(ctx.env).filter((p) => loadThread(ctx.home, p, ref));
      if (o.to !== undefined && !owners.includes(o.to)) throw new UsageError(`no ${o.to} thread ${ref}`);
      if (o.to === undefined && owners.length > 1) throw new UsageError(`thread ${ref} exists for ${owners.join(" and ")}; pass --to`);
      if (!owners.length) throw new UsageError(`no job or thread ${ref}`);
      provider = o.to ?? owners[0];
      threadId = ref;
    }
  }
  if (job) {
    if (job.admitted === false) throw new UsageError(`job ${job.id} was not admitted; use the original thread`);
    if (job.verb === "review") throw new UsageError(`job ${job.id} is a review; reviews start no thread to reply to`);
    if (job.unconfirmed) throw new UsageError(`job ${job.id}: ${job.unconfirmed}`);
    if (!job.threadId) throw new UsageError(`job ${job.id} has no ${job.provider} thread (it failed before one started)`);
    provider = job.provider;
    threadId = job.threadId;
  }
  if (o.to !== undefined && o.to !== provider) throw new UsageError(`thread ${threadId} belongs to ${provider}; --to ${o.to} conflicts`);
  const record = loadThread(ctx.home, provider, threadId)
    ?? (job ? { provider, threadId, cwd: job.cwd, model: job.model, effort: job.effort, tier: job.tier, round: job.round, rounds: job.rounds, roundsSet: job.roundsSet } : null);
  if (!record) throw new UsageError(`no ${provider} thread ${threadId}`);
  if (record.resumable === false) throw new UsageError(`${provider} thread ${threadId}: ${record.unconfirmed ?? "not resumable"}`);
  if (record.cwd && record.cwd !== ctx.cwd) throw new UsageError(`${provider} thread ${threadId} belongs to workspace ${record.cwd}; a thread is never adopted across workspaces`);
  return { provider, thread: { ...record, provider, threadId } };
}

/**
 * Builds the A5 `request` (everything but jobId/jobDir). Called before admission and again after the
 * thread claim, so a turn that finished meanwhile is inherited; the review target and collection are
 * computed once.
 */
export function prepareRequest(ctx, adapter, verb, o, text, target, memo) {
  if (verb !== "review" && !text.trim()) throw new UsageError(`${verb} needs text on stdin or after --`);
  const provider = adapter.id;
  const thread = target.thread ? { ...(loadThread(ctx.home, provider, target.thread.threadId) ?? target.thread), provider, threadId: target.thread.threadId } : null;
  const catalog = catalogFor(ctx.home, adapter);
  const tier = o.tier ?? (verb === "task" ? "exec" : undefined);
  if (tier !== undefined && !TIERS.includes(tier)) throw new UsageError(`--tier must be one of ${TIERS.join(", ")}`);
  const resolved = resolveTier(provider, tier, { model: o.model, effort: o.effort }, catalog, {
    tiers: tiersFor(adapter, ctx.env), inherited: verb === "reply" ? thread : null, tierExplicit: o.tier !== undefined,
  });
  const roundsSet = o.rounds !== undefined || thread?.roundsSet === true;
  const rounds = o.rounds !== undefined ? roundCount(o.rounds, "--rounds") : roundsSet ? thread.rounds
    : ctx.env.COUNCIL_ROUNDS ? roundCount(ctx.env.COUNCIL_ROUNDS, "COUNCIL_ROUNDS") : DEFAULT_ROUNDS;
  const request = {
    verb, provider, cwd: ctx.cwd, session: ctx.session ?? null, tier: resolved.tier, model: resolved.model, modelVerified: resolved.modelVerified,
    effort: resolved.effort, requestedEffort: resolved.requestedEffort ?? resolved.effort, thread, readOnly: verb !== "task", text,
    contract: memo.contract ??= fs.readFileSync(path.join(PLUGIN_ROOT, "contract.md"), "utf8").replace(/\r\n?/g, "\n").trim(),
    // --web is inherited from the thread unless given explicitly (grok-build grok.mjs:142).
    web: o.web !== undefined ? Boolean(o.web) : Boolean(thread?.web), adversarial: Boolean(o.adversarial), deadline: seconds(o.deadline, DEADLINE_S, "deadline"),
    rounds, roundsSet, round: verb === "review" ? null : thread ? (thread.round ?? 0) + 1 : 1,
    target: null, reviewTarget: null, reviewNative: null, reviewPrompt: null, reviewed: [], unreviewed: [],
  };
  // A5: a flag the adapter has no tested mapping for exits 2 before anything else runs, so a refused
  // review never resolves its target or collects a diff (milestone 3 review, Argon F5). Once per call.
  if (!memo.checked) { adapter.checkRequest?.(request, ctx.env); memo.checked = true; }
  if (verb === "review") {
    memo.target ??= reviewTarget(ctx.cwd, { base: o.base, commit: o.commit, uncommitted: o.uncommitted });
    const gitInfo = { root: memo.target.root, target: memo.target, collect: () => (memo.collection ??= collectReview(memo.target)) };
    const plan = adapter.reviewPlan(gitInfo, request);
    request.reviewTarget = memo.target;
    request.target = memo.target.label;
    if (plan?.native) request.reviewNative = { flags: plan.flags ?? [], stdin: plan.stdin ?? null };
    else {
      const collection = gitInfo.collect();
      if (collection.empty) throw new UsageError(`nothing to review: no changes in the ${collection.label}`);
      request.reviewPrompt = memo.prompt ??= renderReviewPrompt({ template: plan?.template ?? (o.adversarial ? "adversarial-review" : "review"), targetLabel: collection.label, focus: text, collection });
      request.reviewed = collection.reviewed;
      request.unreviewed = collection.omitted;
    }
  }
  return request;
}

// --- verbs ---------------------------------------------------------------------------------------------

async function runTurn(ctx, io, verb, o, text, literal, hooks) {
  ({ o, text } = splitReply(verb, o, text, literal));
  // Every argument is checked before a request id is claimed: a rejected call leaves nothing behind.
  const timers = { inactivityMs: seconds(o["inactivity-timeout"], INACTIVITY_S, "inactivity-timeout") * 1000, deadlineMs: seconds(o.deadline, DEADLINE_S, "deadline") * 1000 };
  for (const flag of REVIEW_ONLY) if (o[flag] !== undefined && verb !== "review") throw new UsageError(`--${flag} applies to review`);
  // A review starts no thread, so it has no round budget; and it reads the collected diff, never the web (grok-build refused --web on reviews).
  if (verb === "review" && o.rounds !== undefined) throw new UsageError("--rounds does not apply to review");
  if (verb === "review" && o.web !== undefined) throw new UsageError("--web does not apply to review");
  if (o.refresh !== undefined) throw new UsageError("--refresh applies to models");
  if (o.rounds !== undefined) roundCount(o.rounds, "--rounds");
  const requestId = o["request-id"];
  if (requestId !== undefined && !REQUEST_ID.test(requestId)) throw new UsageError("--request-id needs 1 to 128 letters, digits, '.', '_', ':' or '-', starting with a letter or digit");
  const fp = fingerprint(verb, o, text);
  const control = hooks.control ?? executionController();
  // A7.4 (S2.9): one provider-neutral binding per session + realpath(cwd) + request id, taken with an
  // exclusive create before anything is resolved; a second caller waits on it, replays it, or exits 2.
  let scope = null;
  while (requestId !== undefined && !scope) {
    const claim = claimScope(ctx.home, { session: ctx.session, cwd: ctx.cwd, requestId }, { fingerprint: fp, verb, companionPid: process.pid, companionIdentity: control.self() }, hooks.scopeIo);
    if (claim.fresh) { scope = claim; break; }
    const waited = await awaitScope(ctx, o, claim, fp, control);
    if (waited.replay) return replayRequest(ctx, o, waited.replay, fp, io.out, { control });
  }
  const memo = {};
  let claimed = null, adapter, target, initial;
  try {
    await hooks.beforeResolve?.();
    target = resolveTarget(ctx, verb, o);
    adapter = await loadAdapter(target.provider, ctx.env);
    if (scope) {
      claimed = claimRequest(ctx.home, adapter.id, requestId, { session: ctx.session, cwd: ctx.cwd }, {
        fingerprint: fp, verb, companionPid: process.pid, companionIdentity: control.self(),
      });
      // A job claim under this binding can only exist from an earlier binding that was released after its tombstone: replay it.
      if (!claimed.fresh) { const prior = claimed; claimed = null; bindScope(scope.file, adapter.id, prior.id); return replayRequest(ctx, o, prior, fp, io.out, { control }); }
      bindScope(scope.file, adapter.id, claimed.id);
    }
    initial = prepareRequest(ctx, adapter, verb, o, text, target, memo); // runs adapter.checkRequest first
    if (claimed) markRequestPrepared(ctx.home, claimed.id, { provider: adapter.id, requestId, fingerprint: fp, session: ctx.session, cwd: ctx.cwd, verb });
  } catch (error) {
    // Nothing ran: a retry may. The job claim and the binding go together.
    if (claimed) releaseRequest(ctx.home, claimed.id);
    if (scope && !(claimed && loadTombstone(ctx.home, claimed.id))) releaseScope(scope.file);
    throw error;
  }
  const result = await runManagedTurn(ctx, adapter, initial, () => prepareRequest(ctx, adapter, verb, o, text, target, memo),
    { jobId: claimed?.id, requestId: requestId ?? null, fingerprint: fp, json: Boolean(o.json), ...timers },
    { announce: (job) => io.err(`${startLine(job)}\n`), ...hooks });
  io.out(o.json ? `${JSON.stringify(resultJson(result.job, result.answer))}\n` : renderResult(result.job, result.answer));
  return result.job.code;
}

/** `models [--to <p>] [--refresh]`: the catalog from models.json plus the cached listing. */
async function runModels(ctx, io, o, refs) {
  if (refs.length) throw new UsageError("models takes no positional arguments");
  const names = o.to !== undefined ? (checkProvider(o.to, ctx.env), [o.to]) : providerNames(ctx.env);
  const rows = [];
  for (const provider of names) {
    let adapter = null;
    try { adapter = await loadAdapter(provider, ctx.env); }
    catch (error) { if (!(error instanceof UsageError)) throw error; rows.push({ provider, available: false, error: error.message }); continue; }
    let refreshError = null;
    if (o.refresh) {
      try {
        const launcher = adapter.resolveLauncher(ctx.env, process.platform);
        if (!launcher) throw new Error(`${provider} not found; set ${adapter.binEnv}`);
        refreshCatalog(ctx.home, provider, adapter.probe(launcher, childEnv(ctx.env))); // A5.1: every provider child carries the guards
      } catch (error) { refreshError = error.message; }
    }
    const catalog = catalogFor(ctx.home, adapter);
    const models = { ...Object.fromEntries(Object.entries(catalog.families ?? {})), ...catalog.models };
    rows.push({ provider, available: true, source: catalog.source, updatedAt: catalog.updatedAt, models, aliases: catalog.aliases, tiers: tiersFor(adapter, ctx.env)[provider], refreshError });
  }
  if (o.json) io.out(`${JSON.stringify(rows)}\n`);
  else for (const r of rows) {
    if (!r.available) { io.out(`${r.provider}: ${r.error}\n`); continue; }
    io.out(`${r.provider} (${r.source}${r.updatedAt ? `, refreshed ${r.updatedAt}` : ""})${r.refreshError ? ` · refresh failed: ${r.refreshError}` : ""}\n`);
    for (const [id, efforts] of Object.entries(r.models)) io.out(`  ${id}: ${efforts.join(", ") || "-"}\n`);
    io.out(`  tiers: ${Object.entries(r.tiers ?? {}).map(([t, v]) => `${t} ${v.model}/${v.effort}`).join(" · ")}\n`);
  }
  return rows.some((r) => r.refreshError) ? 1 : 0;
}

/** `setup [--to <p>]`: binary, login, version, catalog age, resolved tiers, launcher kind. */
async function runSetup(ctx, io, o, refs) {
  if (refs.length) throw new UsageError("setup takes no positional arguments");
  const names = o.to !== undefined ? (checkProvider(o.to, ctx.env), [o.to]) : providerNames(ctx.env);
  const rows = [];
  for (const provider of names) {
    const binary = BINARIES[provider] ? pathCandidates(BINARIES[provider], ctx.env)[0] ?? null : null;
    let adapter = null;
    try { adapter = await loadAdapter(provider, ctx.env); }
    catch (error) { if (!(error instanceof UsageError)) throw error; rows.push({ provider, available: false, ready: false, binary, error: error.message }); continue; }
    const row = { provider, available: true, ready: false, binary, launcher: null, version: null, loggedIn: null, catalog: null, tiers: {}, notes: [], warnings: [] };
    try {
      const launcher = adapter.resolveLauncher(ctx.env, process.platform);
      if (!launcher) throw new Error(`${provider} not found; set ${adapter.binEnv}`);
      row.launcher = { kind: launcher.kind, path: launcher.path };
      const probe = adapter.probe(launcher, childEnv(ctx.env)); // A5.1: every provider child carries the guards
      Object.assign(row, { version: probe.version ?? null, loggedIn: probe.loggedIn ?? null, ready: probe.loggedIn !== false });
      // A provider's own setup lines (A5.1: Codex states its MCP trade-off) and probe warnings.
      const lines = (v) => (Array.isArray(v) ? v : []).filter((x) => typeof x === "string" && x.trim());
      row.notes.push(...lines(probe.notes));
      row.warnings.push(...lines(probe.warnings));
      const catalog = catalogFor(ctx.home, adapter);
      row.catalog = { source: catalog.source, updatedAt: catalog.updatedAt, file: catalogPath(ctx.home, provider) };
      for (const t of TIERS) {
        const r = resolveTier(provider, t, {}, catalog, { tiers: tiersFor(adapter, ctx.env) });
        row.tiers[t] = `${r.model}/${r.effort}${r.modelVerified ? "" : " (model unverified)"}`;
        if (!r.modelVerified) row.warnings.push(`tier ${t}: ${r.model} is not in the catalog`);
      }
    } catch (error) { row.warnings.push(error.message); }
    rows.push(row);
  }
  if (o.json) io.out(`${JSON.stringify(rows)}\n`);
  else for (const r of rows) {
    if (!r.available) { io.out(`${r.provider}: ${r.error}${BINARIES[r.provider] ? ` · ${BINARIES[r.provider]} -> ${r.binary ?? "not found"}` : ""}\n`); continue; }
    io.out(`${r.provider}: ${r.ready ? "ready" : "not ready"}${r.launcher ? ` · ${r.launcher.path} (${r.launcher.kind})` : ""}${r.version ? ` · ${r.version}` : ""}${r.loggedIn === null ? "" : ` · ${r.loggedIn ? "logged in" : "not logged in"}`}\n`);
    if (r.catalog) io.out(`  catalog: ${r.catalog.source}${r.catalog.updatedAt ? ` (${r.catalog.updatedAt})` : ""}\n`);
    if (Object.keys(r.tiers).length) io.out(`  tiers: ${Object.entries(r.tiers).map(([t, v]) => `${t} ${v}`).join(" · ")}\n`);
    for (const n of r.notes ?? []) io.out(`  note: ${n}\n`);
    for (const w of r.warnings) io.out(`  warning: ${w}\n`);
  }
  return rows.some((r) => r.available && !r.ready) ? 1 : 0;
}

/** cancel and owner-death recovery load the recorded provider's module for ownsProcess only. */
async function ownershipControl(ctx, job) {
  const file = adapterFile(job.provider, ctx.env);
  if (!file || !fs.existsSync(file)) throw new Error(`job ${job.id} ran on ${job.provider}, whose module is not in this build; its processes cannot be identified`);
  const adapter = (await import(pathToFileURL(file).href)).default;
  return executionController({ adapter: { id: adapter.id, ownsProcess: adapter.ownsProcess } });
}

// --- main ----------------------------------------------------------------------------------------------

/**
 * main(argv, env, io) → exit code. `io` = {stdout, stderr, stdin, cwd}; hooks are test seams passed to
 * runManagedTurn. Errors print as `council: <message>` on stderr, or as JSON under --json.
 */
export async function main(argv, env = process.env, io = {}, hooks = {}) {
  const stdout = io.stdout ?? process.stdout, stderr = io.stderr ?? process.stderr;
  const out = (s, stream) => (stream === "stderr" ? stderr : stdout).write(s);
  const err = (s) => stderr.write(s);
  let options = {};
  try {
    const [verb, ...rest] = argv;
    if (!VERBS.includes(verb)) throw new UsageError(USAGE);
    let positionals, literal, text = "";
    ({ options, positionals, literal } = parseArgv(rest));
    const stdinIo = { stream: io.stdin ?? process.stdin, idleMs: stdinIdleMs(env) };
    if (TURN_VERBS.includes(verb)) ({ options, text, literal } = await readText(options, positionals, literal, stdinIo));
    else ({ options, positionals } = await readControlArgs(options, positionals, stdinIo));
    // After stdin, so the refusal follows its --json too; nothing has run yet (A5.1 depth guard).
    assertNotNested(env);
    const session = options.session && !options.session.includes("${") ? options.session : null;
    const ctx = { env, home: homeDir(env), cwd: canonical(io.cwd ?? process.cwd()), session };
    const sink = { out, err };
    if (TURN_VERBS.includes(verb)) return await runTurn(ctx, sink, verb, options, text, literal, hooks);
    if ((verb === "wait" || verb === "cancel") && options.to !== undefined) checkProvider(options.to, env);
    if (verb === "wait") return await waitFor(ctx, options, positionals, out, { provider: options.to ?? null });
    if (verb === "cancel") return await cancelJob(ctx, options, positionals, out, { provider: options.to ?? null, controlFor: (job) => hooks.controlFor?.(job) ?? ownershipControl(ctx, job) });
    if (verb === "models") return await runModels(ctx, sink, options, positionals);
    return await runSetup(ctx, sink, options, positionals);
  } catch (error) {
    const code = error instanceof UsageError ? 2 : 1;
    if (options.json) out(`${JSON.stringify({ status: "failed", exit: code, error: error.message })}\n`);
    else err(`council: ${error.message}\n`);
    return code;
  }
}

// Node loads a symlinked entry point from its real path, so both sides are compared resolved.
if (process.argv[1] && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url))) {
  process.stdout.on("error", () => {}); // A departed caller must not bypass durable finalization.
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; });
}
