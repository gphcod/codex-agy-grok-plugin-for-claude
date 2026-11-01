import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distinctExecutables } from "../plugins/council/scripts/lib/providers/grok.mjs";

test("PATH entries that are links to one grok binary count once", { skip: process.platform === "win32" && "symlinks need privileges on Windows" }, () => {
  const root = mkdtempSync(join(tmpdir(), "council-grok-path-"));
  try {
    mkdirSync(join(root, "a")); mkdirSync(join(root, "b")); mkdirSync(join(root, "c"));
    writeFileSync(join(root, "a", "grok"), "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync(join(root, "a", "grok"), join(root, "b", "grok"));
    writeFileSync(join(root, "c", "grok"), "#!/bin/sh\n", { mode: 0o755 });
    assert.deepEqual(distinctExecutables([join(root, "a", "grok"), join(root, "b", "grok")]), [join(root, "a", "grok")]);
    assert.equal(distinctExecutables([join(root, "a", "grok"), join(root, "b", "grok"), join(root, "c", "grok")]).length, 2);
    assert.deepEqual(distinctExecutables([join(root, "missing")]), [join(root, "missing")]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
