import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, commandsDir, COMMANDS } from "../scripts/gen-commands.mjs";

test("gen-commands --check reports no drift", () => {
  const r = spawnSync(process.execPath, [join(repoRoot, "scripts", "gen-commands.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("eleven commands with the required frontmatter and the slash-command form", () => {
  const files = readdirSync(commandsDir).filter((f) => f.endsWith(".md")).sort();
  assert.equal(files.length, 11);
  assert.deepEqual(files, Object.keys(COMMANDS).map((n) => `${n}.md`).sort());
  for (const f of files) {
    const text = readFileSync(join(commandsDir, f), "utf8");
    assert.match(text, /^---\ndescription: .+\nargument-hint: ".+"\ndisable-model-invocation: true\nallowed-tools: Bash\(node:\*\), PowerShell\(node:\*\), Write\n---\n/);
    assert.match(text, /--session "\$\{CLAUDE_SESSION_ID\}" <<'COUNCIL_EOF'\n\$ARGUMENTS\nCOUNCIL_EOF\n/);
    assert.doesNotMatch(text, / -- /, `${f}: slash-command form carries no -- on argv`);
    assert.match(text, /If a line of the arguments is exactly `COUNCIL_EOF`/);
    const powershell = /```powershell\n(.*)\n```/.exec(text)?.[1];
    assert.match(powershell ?? "", /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/council\.mjs" [^;]* "--session=\$\{CLAUDE_SESSION_ID\}" "--input-file=<file>"$/, `${f}: one statement that starts with node, because under default permissions PowerShell(node:*) grants nothing more, and it carries no text`);
    assert.doesNotMatch(powershell, /ARGUMENTS|LASTEXITCODE/, f);
    assert.match(text, /a new UTF-8 file named `council-\$\{CLAUDE_SESSION_ID\}-<8 random letters and digits>\.txt` in the system temp directory/, `${f}: temp directories are shared, and models repeat "random" names across sessions`);
  }
  for (const p of ["codex", "gemini", "grok"]) {
    assert.match(readFileSync(join(commandsDir, `${p}.md`), "utf8"), new RegExp(`council\\.mjs" ask --to ${p} --request-id @RID@ --session`));
  }
});
