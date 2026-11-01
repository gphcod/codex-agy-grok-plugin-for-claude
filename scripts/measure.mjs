#!/usr/bin/env node
// S6.5: per-call framing bytes (start line + footer, everything the host reads except the answer) of
// one `ask` per provider against the fakes, with and without --request-id, and the skill's size.
// Runs in a temporary sandbox (tests/fixtures/three-providers.mjs); no real CLI is started.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_DIR, PROVIDERS, SESSION, harness, markers } from "../tests/fixtures/three-providers.mjs";

const bytes = (s) => Buffer.byteLength(s, "utf8");

/** Splits one ask's output into the answer and the framing the host reads around it. */
export function framing(r) {
  const lines = r.out.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const footer = `${lines.at(-1)}\n`;
  return { start: bytes(r.err), footer: bytes(footer), total: bytes(r.err) + bytes(footer), answer: bytes(r.out) - bytes(footer) };
}

export async function measure() {
  const h = harness();
  const rows = [];
  try {
    for (const p of PROVIDERS) {
      const text = "Reply with pong";
      const plain = await h.run(["ask", "--to", p, "--session", SESSION, "--", text], markers(p, text));
      const replayable = await h.run(["ask", "--to", p, "--session", SESSION, "--request-id", `abcd123${PROVIDERS.indexOf(p)}`, "--", text], markers(p, text));
      for (const r of [plain, replayable]) if (r.code !== 0) throw new Error(`${p} ask failed (${r.code}): ${r.err}${r.out}`);
      rows.push({ provider: p, ...framing(plain), withRequestId: framing(replayable).total, footerText: plain.out.trim().split("\n").at(-1), startText: plain.err.trim() });
    }
  } finally { h.done(); }
  const skill = readFileSync(join(PLUGIN_DIR, "skills", "council", "SKILL.md"), "utf8");
  return { rows, skillBytes: bytes(skill), descriptionBytes: bytes(/^description: (.+)$/m.exec(skill)[1]) };
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const { rows, skillBytes, descriptionBytes } = await measure();
  console.log("provider  start  footer  framing  with --request-id");
  for (const r of rows) console.log(`${r.provider.padEnd(8)}  ${String(r.start).padStart(5)}  ${String(r.footer).padStart(6)}  ${String(r.total).padStart(7)}  ${String(r.withRequestId).padStart(17)}`);
  console.log(`skill ${skillBytes} B, description ${descriptionBytes} B`);
  if (process.argv.includes("--verbose")) for (const r of rows) console.log(`${r.startText}\n${r.footerText}`);
}
