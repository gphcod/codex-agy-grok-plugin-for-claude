// Ported from grok-build-plugin-cc 1.1.5 lib/args.mjs (commit 9c66028). Options are matched by
// arity, never by guessing: a value option takes the next token, a boolean takes none, anything
// else that starts with a dash is an error. Free text is never re-tokenized.
// Changes (PLAN.md S2 table): SPEC.value gains `to`, `commit`; SPEC.bool gains `uncommitted`,
// `adversarial`, `refresh`, `web`; the verb lists come from A3.2; UsageError lives in catalog.mjs.
import { UsageError } from "./catalog.mjs";

export { UsageError };

export const SPEC = {
  value: ["session", "to", "tier", "model", "effort", "thread", "base", "commit", "timeout", "inactivity-timeout", "deadline", "rounds", "request-id", "input-file"],
  bool: ["last", "json", "web", "uncommitted", "adversarial", "refresh"],
};

/** A3.2: verbs that run a provider CLI, and verbs that never do. */
export const TURN_VERBS = ["ask", "reply", "review", "task"];
export const CONTROL_VERBS = ["wait", "cancel", "models", "setup"];
export const VERBS = [...TURN_VERBS, ...CONTROL_VERBS];
export const PROVIDERS = ["codex", "gemini", "grok"];

function option(token, spec, next) {
  const [key, inline] = token.slice(2).split(/=(.*)/s, 2);
  if (spec.bool.includes(key)) {
    return { key, value: inline === undefined ? true : inline !== "false", used: 0 };
  }
  if (spec.value.includes(key)) {
    const value = inline ?? next();
    if (value === undefined) {
      throw new UsageError(`Missing value for ${token}`);
    }
    return { key, value, used: inline === undefined ? 1 : 0 };
  }
  throw new UsageError(`Unknown option ${token}. Put -- before the text if it starts with a dash.`);
}

/** Leading `--options` of a command line; the first other token and the rest are positionals. */
export function parseArgv(argv, spec = SPEC) {
  const options = {};
  const positionals = [];
  let literal = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      literal = true;
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const found = option(token, spec, () => argv[i + 1]);
    options[found.key] = found.value;
    i += found.used;
  }
  return { options, positionals, literal };
}

/**
 * Leading options of free text (what a slash command's `$ARGUMENTS` holds), then the rest
 * byte for byte. Text with no leading option is returned untouched; after `--` nothing is parsed,
 * and `literal` says that `--` was there, so the caller does not parse the text again either.
 */
export function splitLeading(raw, spec = SPEC) {
  const options = {};
  const sticky = /\s*(\S+)/y;
  const read = (from) => {
    sticky.lastIndex = from;
    const m = sticky.exec(raw);
    return m && { text: m[1], start: sticky.lastIndex - m[1].length, end: sticky.lastIndex };
  };
  let pos = 0;
  for (;;) {
    const t = read(pos);
    if (!t) {
      return { options, text: pos ? "" : raw, literal: false };
    }
    if (t.text === "--") {
      return { options, text: raw.slice(t.end).replace(/^[ \t]*(\r?\n)?/, ""), literal: true };
    }
    if (!t.text.startsWith("--")) {
      return { options, text: pos ? raw.slice(t.start) : raw, literal: false };
    }
    const found = option(t.text, spec, () => read(t.end)?.text);
    options[found.key] = found.value;
    pos = found.used ? read(t.end).end : t.end;
  }
}

/** A positive finite number of seconds within the timer range, or the fallback when undefined. */
export function seconds(value, fallback, name) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n <= 0 || n * 1000 > 2147483647) throw new UsageError(`--${name} needs a finite positive number of seconds within the timer range`);
  return n;
}

export function roundCount(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new UsageError(`${name} needs a positive integer`);
  return n;
}
