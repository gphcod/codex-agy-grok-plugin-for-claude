// Model catalog: static models.json merged with a refreshed listing under <home>/catalog, model and
// alias resolution, and the effort rules of PLAN.md A3.3 (downward clamp only, Gemini suffixed ids,
// codex `ultra` pass-through). The rules are identical for the static and the refreshed catalog.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROVIDERS = ["codex", "gemini", "grok"];
export const SHARED_ENUM = ["low", "medium", "high", "xhigh", "max"];
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Invalid input: the entry maps it to exit 2. S2.2's args.mjs re-exports this class. */
export class UsageError extends Error {
  constructor(message) { super(message); this.name = "UsageError"; this.exitCode = 2; }
}

const rank = (e) => SHARED_ENUM.indexOf(e);
const byRank = (a, b) => rank(a) - rank(b);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function loadStaticCatalog(pluginRoot = PLUGIN_ROOT) {
  return JSON.parse(readFileSync(join(pluginRoot, "models.json"), "utf8"));
}

/**
 * Parses one provider's listing. codex: `codex debug models` JSON (slug, supported_reasoning_levels).
 * gemini: `agy models` tab-separated `id<TAB>display`; suffixed ids index themselves (`gemini-4-argon-high`
 * → ["high"]) and their family (`gemini-4-argon` → ["low","medium","high"]); ids outside the route
 * prefixes are ignored. grok: `grok models` rows `- id` / `* id (default)`; the effort set is CLI-wide.
 */
export function parseModelListing(provider, rawText, { route = ["gemini-"], grokEfforts = ["low", "medium", "high", "xhigh"] } = {}) {
  const models = {};
  const families = {};
  if (provider === "codex") {
    let parsed;
    try { parsed = JSON.parse(rawText); } catch { throw new Error("codex debug models: not JSON"); }
    if (!Array.isArray(parsed?.models)) throw new Error("codex debug models: unexpected shape");
    for (const m of parsed.models) {
      if (typeof m?.slug !== "string") continue;
      models[m.slug] = (m.supported_reasoning_levels ?? []).map((l) => l?.effort).filter((e) => typeof e === "string");
    }
    return { provider, models, families, defaultModel: null };
  }
  if (provider === "gemini") {
    for (const line of String(rawText).split(/\r?\n/)) {
      const id = line.split("\t")[0].trim();
      if (!id || !route.some((p) => id.startsWith(p))) continue;
      const m = /^(.+)-(low|medium|high|xhigh|max)$/.exec(id);
      if (!m) { models[id] = models[id] ?? []; continue; }
      models[id] = [m[2]];
      families[m[1]] = [...new Set([...(families[m[1]] ?? []), m[2]])].sort(byRank);
    }
    return { provider, models, families, defaultModel: null };
  }
  if (provider === "grok") {
    let defaultModel = null;
    for (const line of String(rawText).split(/\r?\n/)) {
      const m = /^\s*([-*])\s+(\S+)/.exec(line);
      if (!m) continue;
      models[m[2]] = [...grokEfforts];
      if (m[1] === "*") defaultModel = m[2];
    }
    return { provider, models, families, defaultModel, loggedIn: !/not authenticated|not logged in/i.test(rawText) };
  }
  throw new UsageError(`unknown provider ${provider}`);
}

export function catalogPath(home, provider) {
  return join(home, "catalog", `${provider}.json`);
}

/** Static entry merged with the refreshed listing when present; the refreshed effort lists win per model. */
export function loadCatalog(home, provider, { pluginRoot = PLUGIN_ROOT, staticEntry = null } = {}) {
  // A provider outside models.json (the test-only null adapter) brings its own entry (A5 `catalog`).
  if (!PROVIDERS.includes(provider) && !staticEntry) throw new UsageError(`unknown provider ${provider}`);
  const stat = staticEntry ?? loadStaticCatalog(pluginRoot)[provider] ?? {};
  const catalog = {
    provider,
    models: { ...(stat.models ?? {}) },
    families: { ...(stat.families ?? {}) },
    aliases: { ...(stat.aliases ?? {}) },
    sharedEnum: stat.sharedEnum ?? SHARED_ENUM,
    passThrough: stat.passThrough ?? [],
    suffixed: stat.suffixed === true,
    route: stat.route ?? [],
    updatedAt: null,
    source: "static",
  };
  const file = home ? catalogPath(home, provider) : null;
  if (file && existsSync(file)) {
    let refreshed = null;
    try { refreshed = JSON.parse(readFileSync(file, "utf8")); } catch { refreshed = null; }
    if (isObject(refreshed) && isObject(refreshed.models)) {
      Object.assign(catalog.models, refreshed.models);
      if (isObject(refreshed.families)) Object.assign(catalog.families, refreshed.families);
      catalog.updatedAt = typeof refreshed.updatedAt === "string" ? refreshed.updatedAt : null;
      catalog.source = "refreshed";
    }
  }
  return catalog;
}

/** `${family}-${suffix}` → {family, suffix} for a Gemini suffixed id, else null. */
export function splitSuffix(id, catalog) {
  if (!catalog?.suffixed || typeof id !== "string") return null;
  const m = /^(.+)-(low|medium|high|xhigh|max)$/.exec(id);
  if (!m) return null;
  return { family: m[1], suffix: m[2] };
}

/**
 * Effort list the catalog knows for this id, or null when the id is not catalogued. A catalogued
 * model with an empty list returns [] (known, offers nothing), which is not the same as absent.
 * A Gemini suffixed id is known only when its family lists that suffix (`gemini-4-argon-xhigh` is
 * unknown while the listing has low, medium, high).
 */
export function effortsFor(id, catalog) {
  if (Object.hasOwn(catalog.models ?? {}, id) && Array.isArray(catalog.models[id])) {
    if (catalog.models[id].length) return catalog.models[id];
    const split = splitSuffix(id, catalog);
    if (!split) return [];
  }
  if (Object.hasOwn(catalog.families ?? {}, id)) return catalog.families[id];
  const split = splitSuffix(id, catalog);
  if (split && Object.hasOwn(catalog.families ?? {}, split.family)) {
    return catalog.families[split.family].includes(split.suffix) ? [split.suffix] : null;
  }
  return null;
}

/** Alias or exact id → {id, verified, alias}. An unknown id passes through unchanged, unverified. */
export function resolveModel(provider, input, catalog) {
  if (typeof input !== "string" || !input.trim()) throw new UsageError("model id is empty");
  const alias = Object.hasOwn(catalog.aliases ?? {}, input) ? input : null;
  const id = alias ? catalog.aliases[alias] : input;
  return { id, verified: effortsFor(id, catalog) !== null, alias };
}

/**
 * A3.3: downward clamp only, against the model's own list; Gemini suffix is an explicit effort and a
 * conflicting --effort exits 2; codex `ultra` passes through only when the model's list has it; an
 * unknown model passes the request through unclamped.
 */
export function resolveEffort(provider, id, requested, catalog) {
  const split = splitSuffix(id, catalog);
  if (split) {
    if (requested != null && requested !== split.suffix) {
      throw new UsageError(`--model ${id} already fixes the effort at ${split.suffix}; --effort ${requested} conflicts`);
    }
    return { effort: split.suffix, requested: requested ?? split.suffix, clamped: false, suffixed: true };
  }
  if (requested == null) return { effort: null, requested: null, clamped: false, suffixed: false };
  const offered = effortsFor(id, catalog);
  if ((catalog.passThrough ?? []).includes(requested)) {
    // offered === [] is a catalogued model that offers nothing: rejected, never passed through.
    if (offered !== null && !offered.includes(requested)) throw new UsageError(`${id} does not offer effort ${requested}`);
    return { effort: requested, requested, clamped: false, suffixed: false };
  }
  if (!SHARED_ENUM.includes(requested)) throw new UsageError(`--effort must be one of ${SHARED_ENUM.join(", ")}${(catalog.passThrough ?? []).length ? ` (or ${catalog.passThrough.join(", ")} where ${provider} offers it)` : ""}`);
  if (offered === null) return { effort: requested, requested, clamped: false, suffixed: false };
  const shared = offered.filter((e) => SHARED_ENUM.includes(e)).sort(byRank);
  if (!shared.length) throw new UsageError(`${id} lists no effort council can select`);
  const below = shared.filter((e) => rank(e) <= rank(requested));
  const effort = below.length ? below[below.length - 1] : shared[0];
  return { effort, requested, clamped: effort !== requested, suffixed: false };
}

/**
 * Writes <home>/catalog/<provider>.json as {updatedAt, models, families} from an adapter probe
 * result ({version, loggedIn, models: [{id, efforts}]}) or from a parsed listing.
 */
export function refreshCatalog(home, provider, probe, { now = () => new Date().toISOString() } = {}) {
  if (!home) throw new Error("refreshCatalog needs the state root");
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(provider ?? "")) throw new UsageError(`unknown provider ${provider}`);
  const result = typeof probe === "function" ? probe() : probe;
  const list = Array.isArray(result?.models) ? result.models : isObject(result?.models) ? Object.entries(result.models).map(([id, efforts]) => ({ id, efforts })) : null;
  if (!list) throw new Error(`${provider} probe returned no model list`);
  const models = {};
  const families = {};
  for (const entry of list) {
    if (typeof entry?.id !== "string") continue;
    const efforts = Array.isArray(entry.efforts) ? entry.efforts.filter((e) => typeof e === "string") : [];
    models[entry.id] = efforts;
    const m = provider === "gemini" ? /^(.+)-(low|medium|high|xhigh|max)$/.exec(entry.id) : null;
    if (m) families[m[1]] = [...new Set([...(families[m[1]] ?? []), m[2]])].sort(byRank);
  }
  const record = { updatedAt: now(), version: result.version ?? null, loggedIn: result.loggedIn ?? null, models, families };
  const file = catalogPath(home, provider);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
  renameSync(tmp, file);
  return record;
}
