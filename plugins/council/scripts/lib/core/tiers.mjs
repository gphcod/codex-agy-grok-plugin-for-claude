// Tier resolution (PLAN.md A2 tiers table, A3.3 precedence): tiers.json defaults per provider,
// explicit --model / --effort win, then the catalog rules clamp and verify.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_ROOT, UsageError, resolveEffort, resolveModel } from "./catalog.mjs";

export const TIERS = ["consult", "exec", "deep"];
export const DEFAULT_TIER = "consult";

export function loadTiers(pluginRoot = PLUGIN_ROOT) {
  return JSON.parse(readFileSync(join(pluginRoot, "tiers.json"), "utf8"));
}

/**
 * → {tier, model, modelVerified, alias, effort, requestedEffort, clamped, suffixed}.
 * `overrides` = {model?, effort?} from argv (explicit values win over the tier); `inherited` =
 * {model?, effort?} from a thread record, used when the tier was not given explicitly.
 */
export function resolveTier(provider, tier, overrides = {}, catalog, { tiers = loadTiers(), inherited = null, tierExplicit = Boolean(tier) } = {}) {
  // An omitted --tier keeps the thread's persisted tier; only then does the default apply.
  const name = tier ?? inherited?.tier ?? DEFAULT_TIER;
  if (!TIERS.includes(name)) throw new UsageError(`--tier must be one of ${TIERS.join(", ")}`);
  const table = tiers[provider];
  if (!table || !table[name]) throw new UsageError(`no ${name} tier for ${provider} in tiers.json`);
  const base = tierExplicit || !inherited ? table[name] : { model: inherited.model ?? table[name].model, effort: inherited.effort ?? table[name].effort };
  const modelInput = overrides.model ?? base.model;
  const model = resolveModel(provider, modelInput, catalog);
  // A suffixed Gemini id is itself the explicit effort; only an explicit --effort can conflict with it.
  const suffixedId = catalog.suffixed && /-(low|medium|high|xhigh|max)$/.test(model.id);
  const requested = overrides.effort ?? (suffixedId ? null : base.effort);
  const effort = resolveEffort(provider, model.id, requested, catalog);
  return {
    tier: name,
    model: model.id,
    modelVerified: model.verified,
    alias: model.alias,
    effort: effort.effort,
    requestedEffort: effort.requested,
    clamped: effort.clamped,
    suffixed: effort.suffixed,
  };
}
