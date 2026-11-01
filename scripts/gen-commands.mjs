#!/usr/bin/env node
// Generates the 11 user-only slash commands of A3.4 from scripts/templates/command.md.
// --check regenerates in memory, compares byte for byte, exits 1 on drift.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..");
export const templatePath = join(repoRoot, "scripts", "templates", "command.md");
export const commandsDir = join(repoRoot, "plugins", "council", "commands");

/** Efforts at which a call runs in the background (the skill's rule), and the tiers from tiers.json. */
export const HEAVY = ["xhigh", "max", "ultra"];
const TIERS = JSON.parse(readFileSync(join(repoRoot, "plugins", "council", "tiers.json"), "utf8"));
/** Providers whose exec tier runs at a background effort, with that effort: {codex: "max", grok: "xhigh"} today. */
export function heavyExec(tiers = TIERS) {
  return Object.fromEntries(Object.entries(tiers).filter(([, t]) => HEAVY.includes(t.exec.effort)).map(([p, t]) => [p, t.exec.effort]));
}
const list = (items, and = "and") => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} ${and} ${items.at(-1)}`;
const HEAVY_FLAGS = "`--tier deep`, `--effort xhigh`, `max` or `ultra`";
const FOREGROUND_ELSE = "Otherwise run it in the foreground with timeout 600000.";
/** ask: the provider comes from the arguments, so every heavy exec tier is named. */
function askRule() {
  const exec = Object.entries(heavyExec());
  const execClause = exec.length ? `, or \`--tier exec\` with ${list(exec.map(([p]) => `\`--to ${p}\``), "or")} and no \`--effort\` below xhigh (their exec tiers run at ${list(exec.map(([p, e]) => `${e}`))})` : "";
  return `Make one Bash tool call. Run it with \`run_in_background: true\` when the tier is deep or the effective effort is xhigh or above: the arguments carry ${HEAVY_FLAGS}${execClause}. ${FOREGROUND_ELSE}`;
}
/** /council:<p>: the provider is fixed, so only its own exec tier matters. */
function providerRule(provider) {
  const effort = heavyExec()[provider];
  const execClause = effort ? `, or \`--tier exec\` and no \`--effort\` below xhigh (${provider}'s exec tier runs at ${effort})` : "";
  return `Make one Bash tool call. Run it with \`run_in_background: true\` when the tier is deep or the effective effort is xhigh or above: the arguments carry ${HEAVY_FLAGS}${execClause}. ${FOREGROUND_ELSE}`;
}
function replyRule() {
  const exec = Object.keys(heavyExec());
  return "Make one Bash tool call. A reply keeps its thread's tier and effort unless the arguments set them. Run it with `run_in_background: true` when the tier is deep or the effective effort is xhigh or above: " +
    `the arguments carry ${HEAVY_FLAGS}${exec.length ? `, or \`--tier exec\` on a ${list(exec, "or")} thread with no \`--effort\` below xhigh` : ""}, or they set neither and the thread already runs at deep or at xhigh or above. ` +
    "When you cannot tell, run it in the background. " + FOREGROUND_ELSE;
}
const BACKGROUND = "Make one Bash tool call with `run_in_background: true`.";
const CONTROL = "Make one Bash tool call in the foreground. It starts no provider CLI.";
/** Placeholder Claude replaces with a fresh request id; left as is, the entry refuses it (exit 2). */
export const RID = "@RID@";
const REQUEST_ID = `Replace \`${RID}\` with 8 random letters and digits; a \`--request-id <id>\` in the arguments takes precedence. If the result is lost, rerun the identical command with the same id: it replays the first result and never starts a second CLI. New work needs a new id.`;
const withId = (rule) => `${rule}\n${REQUEST_ID}`;
const TURN_FLAGS = ` --request-id ${RID}`;

export const COMMANDS = {
  ask: {
    verb: "ask",
    fixedFlags: TURN_FLAGS,
    description: "Ask Codex, Gemini or Grok a question on a new read-only thread",
    hint: "--to codex|gemini|grok [--tier consult|exec|deep] [--model <m>] [--effort <e>] <question>",
    rule: withId(askRule()),
  },
  reply: {
    verb: "reply",
    fixedFlags: TURN_FLAGS,
    description: "Continue a thread with a delta reply (provider inherited, read-only)",
    hint: "[--thread <job|thread> | --last] [--model <m>] [--effort <e>] <reply>",
    rule: withId(replyRule()),
  },
  review: {
    verb: "review",
    fixedFlags: TURN_FLAGS,
    description: "Review uncommitted changes, a branch against a base, or one commit",
    hint: "--to codex|gemini|grok [--base <ref> | --commit <sha> | --uncommitted] [--adversarial] [--tier consult|deep] [focus]",
    rule: withId(BACKGROUND + " Exit 10 means findings, an incomplete review or a denied action need attention."),
  },
  task: {
    verb: "task",
    fixedFlags: TURN_FLAGS,
    description: "Delegate work that may edit the working tree (user-authorized only)",
    hint: "--to codex|gemini|grok [--thread <id>] [--tier exec] <task>",
    rule: withId(BACKGROUND + " The user authorizes every task by running this command; never start one on your own."),
  },
  wait: {
    verb: "wait",
    fixedFlags: "",
    description: "List this session's council jobs or await one and print its result",
    hint: "[job] [--timeout <s>]",
    rule: CONTROL + " It waits up to `--timeout` seconds (90 by default); exit 20 means the job is still running.",
  },
  cancel: {
    verb: "cancel",
    fixedFlags: "",
    description: "Stop a council job and confirm its cleanup",
    hint: "[job] [--timeout <s>]",
    rule: CONTROL + " It returns once cleanup is confirmed.",
  },
  models: {
    verb: "models",
    fixedFlags: "",
    description: "Print the model catalog and cached listings; --refresh re-runs the listings",
    hint: "[--to codex|gemini|grok] [--refresh]",
    rule: "Make one Bash tool call in the foreground. It starts no provider CLI unless the arguments carry `--refresh`; then it runs each provider's model-listing command once.",
  },
  setup: {
    verb: "setup",
    fixedFlags: "",
    description: "Check binaries, login, versions, catalog age and resolved tiers for each provider",
    hint: "[--to codex|gemini|grok]",
    rule: "Make one Bash tool call in the foreground. It runs each provider's version, login and model-listing probes and no model turn.",
  },
  codex: {
    verb: "ask",
    fixedFlags: ` --to codex${TURN_FLAGS}`,
    description: "Ask Codex a question on a new read-only thread",
    hint: "[--tier consult|exec|deep] [--model <m>] [--effort <e>] <question>",
    rule: withId(providerRule("codex")),
  },
  gemini: {
    verb: "ask",
    fixedFlags: ` --to gemini${TURN_FLAGS}`,
    description: "Ask Gemini (agy) a question on a new read-only thread",
    hint: "[--tier consult|exec|deep] [--model <m>] [--effort <e>] <question>",
    rule: withId(providerRule("gemini")),
  },
  grok: {
    verb: "ask",
    fixedFlags: ` --to grok${TURN_FLAGS}`,
    description: "Ask Grok a question on a new read-only thread",
    hint: "[--tier consult|exec|deep] [--model <m>] [--effort <e>] <question>",
    rule: withId(providerRule("grok")),
  },
};

export function render(template, spec) {
  const values = {
    verb: spec.verb,
    description: spec.description,
    "argument-hint": spec.hint,
    "background-rule": spec.rule,
    "fixed-flags": spec.fixedFlags,
  };
  const out = template.replace(/\{\{([a-z-]+)\}\}/g, (match, key) => {
    if (!(key in values)) throw new Error(`unknown placeholder ${match}`);
    return values[key];
  });
  if (/\{\{[a-z-]+\}\}/.test(out)) throw new Error("unresolved placeholder");
  return out;
}

export function generate(template = readFileSync(templatePath, "utf8")) {
  const files = new Map();
  for (const [name, spec] of Object.entries(COMMANDS)) files.set(`${name}.md`, render(template, spec));
  return files;
}

export function check(dir = commandsDir) {
  const expected = generate();
  const drift = [];
  const present = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
  for (const [name, content] of expected) {
    const path = join(dir, name);
    if (!existsSync(path)) drift.push(`${name}: missing`);
    else if (!readFileSync(path).equals(Buffer.from(content, "utf8"))) drift.push(`${name}: differs`);
  }
  for (const name of present) if (!expected.has(name)) drift.push(`${name}: unexpected`);
  return drift;
}

export function write(dir = commandsDir) {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of generate()) writeFileSync(join(dir, name), content);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  if (process.argv.includes("--check")) {
    const drift = check();
    if (drift.length) {
      console.error(`command drift:\n  ${drift.join("\n  ")}\nrun: npm run gen`);
      process.exitCode = 1;
    } else {
      console.log(`${Object.keys(COMMANDS).length} commands up to date`);
    }
  } else {
    write();
    console.log(`wrote ${Object.keys(COMMANDS).length} commands to ${commandsDir}`);
  }
}
