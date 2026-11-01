import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("marketplace manifest", () => {
  const m = JSON.parse(readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.equal(m.name, "gphcod-council");
  assert.equal(m.owner.name, "gphcod");
  assert.equal(m.plugins.length, 1);
  assert.equal(m.plugins[0].name, "council");
  assert.equal(m.plugins[0].source, "./plugins/council");
});

test("plugin manifest", () => {
  const p = JSON.parse(readFileSync(join(root, "plugins", "council", ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(p.name, "council");
  assert.match(p.version, /^\d+\.\d+\.\d+/);
  assert.equal(p.author.name, "gphcod");
  assert.equal(p.homepage, "https://github.com/gphcod/codex-agy-grok-plugin-for-claude");
});

test("package.json has no dependencies and the required scripts", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.type, "module");
  assert.equal(pkg.private, true);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.engines.node, ">=18.20.8 <19 || >=22.19.0");
  for (const s of ["test", "test:live", "gen", "gen:check", "measure"]) assert.ok(pkg.scripts[s], s);
});

test("one version across package.json, plugin.json and the marketplace entry", () => {
  const read = (...p) => JSON.parse(readFileSync(join(root, ...p), "utf8"));
  const version = read("package.json").version;
  assert.match(version, /^\d+\.\d+\.\d+(-rc\.\d+)?$/);
  assert.equal(read("plugins", "council", ".claude-plugin", "plugin.json").version, version);
  const m = read(".claude-plugin", "marketplace.json");
  assert.equal(m.plugins[0].version, version);
  assert.equal(m.metadata.version, version);
});
