// Catalog and tier rules (S1.6) against the recorded listings in docs/spike and a stub probe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLUGIN_ROOT, SHARED_ENUM, UsageError, catalogPath, loadCatalog, loadStaticCatalog, parseModelListing, refreshCatalog, resolveEffort, resolveModel,
} from "../plugins/council/scripts/lib/core/catalog.mjs";
import { loadTiers, resolveTier } from "../plugins/council/scripts/lib/core/tiers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const spike = (f) => readFileSync(join(root, "docs", "spike", f), "utf8");
const usage = (fn, re) => assert.throws(fn, (e) => e instanceof UsageError && (!re || re.test(e.message)));

test("plugin root resolves to plugins/council", () => {
  assert.ok(existsSync(join(PLUGIN_ROOT, "models.json")));
  assert.ok(existsSync(join(PLUGIN_ROOT, "tiers.json")));
});

test("parseModelListing: codex debug models", () => {
  const c = parseModelListing("codex", spike("codex-models.json"));
  assert.deepEqual(c.models["gpt-6.1-sol"], ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.deepEqual(c.models["gpt-6-luna"], ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(Object.keys(c.models).length, 11);
});

test("parseModelListing: agy models indexes suffixed ids and families, skips other vendors", () => {
  const g = parseModelListing("gemini", spike("agy-models.txt"));
  assert.deepEqual(g.models["gemini-4-argon-high"], ["high"]);
  assert.deepEqual(g.families["gemini-4-argon"], ["low", "medium", "high"]);
  assert.deepEqual(g.families["gemini-3.8-flash"], ["low", "medium", "high"]);
  assert.equal(g.models["claude-opus-5-5-high"], undefined);
  assert.equal(g.models["gpt-oss-120b-medium"], undefined);
});

test("parseModelListing: grok models", () => {
  const k = parseModelListing("grok", spike("grok-models.txt"));
  assert.deepEqual(Object.keys(k.models), ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"]);
  assert.deepEqual(k.models["grok-4.7"], ["low", "medium", "high", "xhigh"]);
  assert.equal(k.defaultModel, "grok-4.6");
  assert.equal(k.loggedIn, true);
});

test("static catalog matches the recorded listings", () => {
  const stat = loadStaticCatalog();
  const codex = parseModelListing("codex", spike("codex-models.json"));
  assert.deepEqual(stat.codex.models, codex.models);
  const gemini = parseModelListing("gemini", spike("agy-models.txt"));
  assert.deepEqual(stat.gemini.families, gemini.families);
  const grok = parseModelListing("grok", spike("grok-models.txt"));
  assert.deepEqual(stat.grok.models, grok.models);
});

test("tiers.json equals the A2 table", () => {
  assert.deepEqual(loadTiers(), {
    codex: { consult: { model: "gpt-6.1-sol", effort: "high" }, exec: { model: "gpt-6-luna", effort: "max" }, deep: { model: "gpt-6.1-sol", effort: "xhigh" } },
    grok: { consult: { model: "grok-4.7", effort: "high" }, exec: { model: "grok-4.7-build-fast", effort: "xhigh" }, deep: { model: "grok-4.7", effort: "xhigh" } },
    gemini: { consult: { model: "gemini-4-argon", effort: "high" }, exec: { model: "gemini-3.8-flash", effort: "high" }, deep: { model: "gemini-4-argon", effort: "high" } },
  });
});

test("gemini: --effort xhigh clamps to high; max clamps to high", () => {
  const cat = loadCatalog(null, "gemini");
  assert.deepEqual(resolveEffort("gemini", "gemini-4-argon", "xhigh", cat), { effort: "high", requested: "xhigh", clamped: true, suffixed: false });
  assert.equal(resolveEffort("gemini", "gemini-4-argon", "max", cat).effort, "high");
  assert.equal(resolveEffort("gemini", "gemini-4-argon", "low", cat).clamped, false);
});

test("gemini: suffixed id with a different --effort is a UsageError; alone it is the explicit effort", () => {
  const cat = loadCatalog(null, "gemini");
  usage(() => resolveEffort("gemini", "gemini-4-argon-high", "medium", cat), /conflicts/);
  assert.deepEqual(resolveEffort("gemini", "gemini-4-argon-high", null, cat), { effort: "high", requested: "high", clamped: false, suffixed: true });
  assert.equal(resolveEffort("gemini", "gemini-4-argon-high", "high", cat).effort, "high");
  const m = resolveModel("gemini", "gemini-4-argon-high", cat);
  assert.equal(m.id, "gemini-4-argon-high", "id passed unchanged");
  assert.equal(m.verified, true);
});

test("gemini: family verified against the listing; aliases", () => {
  const cat = loadCatalog(null, "gemini");
  assert.deepEqual(resolveModel("gemini", "gemini-4-argon", cat), { id: "gemini-4-argon", verified: true, alias: null });
  assert.deepEqual(resolveModel("gemini", "argon", cat), { id: "gemini-4-argon", verified: true, alias: "argon" });
  assert.equal(resolveModel("gemini", "flash", cat).id, "gemini-3.8-flash");
});

test("grok: --effort max clamps to xhigh; low stays low", () => {
  const cat = loadCatalog(null, "grok");
  assert.deepEqual(resolveEffort("grok", "grok-4.7", "max", cat), { effort: "xhigh", requested: "max", clamped: true, suffixed: false });
  assert.deepEqual(resolveEffort("grok", "grok-4.7", "low", cat), { effort: "low", requested: "low", clamped: false, suffixed: false });
  assert.equal(resolveModel("grok", "build-fast", cat).id, "grok-4.7-build-fast");
  usage(() => resolveEffort("grok", "grok-4.7", "ultra", cat), /--effort must be one of/);
});

test("codex: ultra on gpt-6-luna is a UsageError with the static catalog alone; on gpt-6.1-sol it passes through", () => {
  const cat = loadCatalog(null, "codex");
  usage(() => resolveEffort("codex", "gpt-6-luna", "ultra", cat), /does not offer effort ultra/);
  usage(() => resolveEffort("codex", "luna", "ultra", cat) && resolveEffort("codex", resolveModel("codex", "luna", cat).id, "ultra", cat));
  assert.deepEqual(resolveEffort("codex", "gpt-6.1-sol", "ultra", cat), { effort: "ultra", requested: "ultra", clamped: false, suffixed: false });
  assert.deepEqual(resolveEffort("codex", "gpt-6.1-sol", "max", cat), { effort: "max", requested: "max", clamped: false, suffixed: false });
  assert.equal(resolveModel("codex", "sol", cat).id, "gpt-6.1-sol");
});

test("unknown id passes through unverified and unclamped", () => {
  const cat = loadCatalog(null, "codex");
  assert.deepEqual(resolveModel("codex", "gpt-9-nova", cat), { id: "gpt-9-nova", verified: false, alias: null });
  assert.deepEqual(resolveEffort("codex", "gpt-9-nova", "max", cat), { effort: "max", requested: "max", clamped: false, suffixed: false });
  assert.equal(resolveEffort("codex", "gpt-9-nova", "ultra", cat).effort, "ultra", "pass-through token on an unknown model");
  usage(() => resolveEffort("codex", "gpt-9-nova", "bogus", cat));
  usage(() => resolveModel("codex", "", cat));
});

test("refresh honours COUNCIL_HOME and the refreshed list wins with identical rules", () => {
  const home = mkdtempSync(join(tmpdir(), "council-home-"));
  try {
    const before = loadCatalog(home, "grok");
    assert.equal(before.source, "static");
    const probe = () => ({ version: "grok 1.0.71", loggedIn: true, models: [{ id: "grok-4.7", efforts: ["low", "medium", "high", "xhigh", "max"] }, { id: "grok-5", efforts: ["low", "high"] }] });
    const record = refreshCatalog(home, "grok", probe);
    assert.ok(existsSync(catalogPath(home, "grok")));
    assert.equal(record.models["grok-5"].length, 2);
    const after = loadCatalog(home, "grok");
    assert.equal(after.source, "refreshed");
    assert.equal(after.models["grok-4.6"][3], "xhigh", "static entries kept");
    assert.deepEqual(resolveEffort("grok", "grok-4.7", "max", after), { effort: "max", requested: "max", clamped: false, suffixed: false });
    assert.deepEqual(resolveEffort("grok", "grok-5", "medium", after), { effort: "low", requested: "medium", clamped: true, suffixed: false });
    assert.equal(resolveModel("grok", "grok-5", after).verified, true);
    // gemini refresh derives families from suffixed ids
    const g = refreshCatalog(home, "gemini", { models: parseModelListing("gemini", spike("agy-models.txt")).models });
    assert.deepEqual(g.families["gemini-4-argon"], ["low", "medium", "high"]);
    const gcat = loadCatalog(home, "gemini");
    assert.equal(resolveEffort("gemini", "gemini-3.8-flash", "xhigh", gcat).effort, "high");
    // codex: a refreshed catalog that still lacks ultra on luna rejects it the same way
    refreshCatalog(home, "codex", { models: parseModelListing("codex", spike("codex-models.json")).models });
    usage(() => resolveEffort("codex", "gpt-6-luna", "ultra", loadCatalog(home, "codex")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveTier: defaults, explicit overrides win, clamp reported, inheritance", () => {
  const codex = loadCatalog(null, "codex"), gemini = loadCatalog(null, "gemini"), grok = loadCatalog(null, "grok");
  assert.deepEqual(resolveTier("codex", undefined, {}, codex), { tier: "consult", model: "gpt-6.1-sol", modelVerified: true, alias: null, effort: "high", requestedEffort: "high", clamped: false, suffixed: false });
  assert.equal(resolveTier("codex", "exec", {}, codex).effort, "max");
  assert.equal(resolveTier("codex", "deep", { model: "luna" }, codex).model, "gpt-6-luna");
  assert.equal(resolveTier("gemini", "deep", {}, gemini).effort, "high", "gemini deep and consult coincide");
  const clamped = resolveTier("gemini", "consult", { effort: "xhigh" }, gemini);
  assert.equal(clamped.effort, "high"); assert.equal(clamped.requestedEffort, "xhigh"); assert.equal(clamped.clamped, true);
  const suffixed = resolveTier("gemini", "consult", { model: "gemini-4-argon-low" }, gemini);
  assert.equal(suffixed.effort, "low"); assert.equal(suffixed.suffixed, true);
  usage(() => resolveTier("gemini", "consult", { model: "gemini-4-argon-low", effort: "high" }, gemini), /conflicts/);
  assert.equal(resolveTier("grok", "exec", {}, grok).model, "grok-4.7-build-fast");
  assert.equal(resolveTier("grok", "consult", { effort: "max" }, grok).effort, "xhigh");
  usage(() => resolveTier("grok", "ultra", {}, grok), /--tier must be one of/);
  usage(() => resolveTier("codex", "exec", { effort: "ultra" }, codex), /does not offer effort ultra/);
  assert.equal(resolveTier("codex", "consult", { effort: "ultra" }, codex).effort, "ultra");
  // inheritance: a thread's model and effort stand in for the tier unless --tier was given explicitly
  const inherited = resolveTier("codex", undefined, {}, codex, { inherited: { model: "gpt-6-luna", effort: "low" }, tierExplicit: false });
  assert.equal(inherited.model, "gpt-6-luna"); assert.equal(inherited.effort, "low");
  const explicitTier = resolveTier("codex", "consult", {}, codex, { inherited: { model: "gpt-6-luna", effort: "low" }, tierExplicit: true });
  assert.equal(explicitTier.model, "gpt-6.1-sol"); assert.equal(explicitTier.effort, "high");
  const unverified = resolveTier("codex", "consult", { model: "gpt-9-nova" }, codex);
  assert.equal(unverified.modelVerified, false);
  assert.deepEqual(SHARED_ENUM, ["low", "medium", "high", "xhigh", "max"]);
});
