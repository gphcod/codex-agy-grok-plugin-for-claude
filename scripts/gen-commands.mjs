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

const FOREGROUND = "Make one Bash tool call: foreground with timeout 600000, or `run_in_background: true` for `--tier deep` or an effort of xhigh, max or ultra.";
const BACKGROUND = "Make one Bash tool call with `run_in_background: true`.";
const CONTROL = "Make one Bash tool call in the foreground. It starts no provider CLI.";

export const COMMANDS = {
  ask: {
    verb: "ask",
    fixedFlags: "",
    description: "Ask Codex, Gemini or Grok a question on a new read-only thread",
    hint: "--to codex|gemini|grok [--tier consult|exec|deep] [--model <m>] [--effort <e>] <question>",
    rule: FOREGROUND,
  },
  reply: {
    verb: "reply",
    fixedFlags: "",
    description: "Continue a thread with a delta reply (provider inherited, read-only)",
    hint: "[--thread <job|thread> | --last] [--model <m>] [--effort <e>] <reply>",
    rule: FOREGROUND,
  },
  review: {
    verb: "review",
    fixedFlags: "",
    description: "Review uncommitted changes, a branch against a base, or one commit",
    hint: "--to codex|gemini|grok [--base <ref> | --commit <sha> | --uncommitted] [--adversarial] [--tier consult|deep] [focus]",
    rule: BACKGROUND + " Exit 10 means findings need attention.",
  },
  task: {
    verb: "task",
    fixedFlags: "",
    description: "Delegate work that may edit the working tree (user-authorized only)",
    hint: "--to codex|gemini|grok [--thread <id>] [--tier exec] <task>",
    rule: BACKGROUND + " The user authorizes every task; never start one on your own.",
  },
  wait: {
    verb: "wait",
    fixedFlags: "",
    description: "List this session's council jobs or await one and print its result",
    hint: "[job] [--timeout <s>]",
    rule: CONTROL + " Exit 20 means the job is still running.",
  },
  cancel: {
    verb: "cancel",
    fixedFlags: "",
    description: "Stop a council job and confirm its cleanup",
    hint: "[job]",
    rule: CONTROL,
  },
  models: {
    verb: "models",
    fixedFlags: "",
    description: "Print the model catalog and cached listings; --refresh re-runs the listings",
    hint: "[--to codex|gemini|grok] [--refresh]",
    rule: CONTROL + " With `--refresh` it runs each provider's model-listing command once.",
  },
  setup: {
    verb: "setup",
    fixedFlags: "",
    description: "Check binaries, login, versions, catalog age and resolved tiers for each provider",
    hint: "[--to codex|gemini|grok]",
    rule: CONTROL + " It runs each provider's documented probe commands.",
  },
  codex: {
    verb: "ask",
    fixedFlags: " --to codex",
    description: "Ask Codex a question on a new read-only thread",
    hint: "[--tier consult|exec|deep] [--model <m>] [--effort <e>] <question>",
    rule: FOREGROUND,
  },
  gemini: {
    verb: "ask",
    fixedFlags: " --to gemini",
    description: "Ask Gemini (agy) a question on a new read-only thread",
    hint: "[--tier consult|exec|deep] [--model <m>] [--effort <e>] <question>",
    rule: FOREGROUND,
  },
  grok: {
    verb: "ask",
    fixedFlags: " --to grok",
    description: "Ask Grok a question on a new read-only thread",
    hint: "[--tier consult|exec|deep] [--model <m>] [--effort <e>] <question>",
    rule: FOREGROUND,
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
