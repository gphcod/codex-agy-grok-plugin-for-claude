// Ported from grok-build-plugin-cc 1.1.5 grok.mjs:46-105 (readStdin, readText, splitReply) and
// grok.mjs:308-317 (control-verb stdin tokens). Unchanged 10 s idle deadline, shortened through
// COUNCIL_STDIN_DEADLINE_MS; literal mode only when argv had `--`.
import fs from "node:fs";
import { SPEC, UsageError, parseArgv, splitLeading } from "./args.mjs";

/** Seconds stdin may stay open without a byte or its end before a call stops reading it. */
export const STDIN_IDLE_S = 10;

export function stdinIdleMs(env = process.env) {
  const n = Number(env.COUNCIL_STDIN_DEADLINE_MS);
  return Number.isFinite(n) && n > 0 ? n : STDIN_IDLE_S * 1000;
}

/**
 * Reads stdin to its end; a terminal gives none. A caller can leave a pipe open and silent: Claude
 * Code's Bash tool does so for a command that holds a heredoc anywhere, and a blocking read never
 * returned. So reading stops after `idleMs` without a byte or the end: with nothing read it resolves
 * null, and after part of an input it is a usage error.
 */
export function readStdin(stream = process.stdin, idleMs = stdinIdleMs()) {
  if (stream.isTTY) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    const chunks = [];
    let timer = null;
    const finish = (settle, value) => {
      clearTimeout(timer);
      stream.off("data", onData).off("end", onEnd).off("error", onError);
      settle(value);
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // An open handle would keep the process alive after main().
        stream.on("error", () => {}).destroy();
        if (chunks.length) finish(reject, new UsageError(`stdin sent nothing for ${idleMs / 1000} s before its end; close it after the input`));
        else finish(resolve, null);
      }, idleMs);
    };
    const onData = (chunk) => { chunks.push(chunk); arm(); };
    const onEnd = () => finish(resolve, Buffer.concat(chunks).toString("utf8"));
    const onError = (error) => finish(reject, error);
    stream.on("data", onData).on("end", onEnd).on("error", onError);
    arm();
  });
}

/** `--input-file` names the input, so inside the input it is refused like any other unknown option. */
const INPUT_SPEC = { ...SPEC, value: SPEC.value.filter((key) => key !== "input-file") };

/**
 * `--input-file`: a UTF-8 file that stands in for stdin. PowerShell has no heredoc, and text placed in one of its
 * here-strings can end the string and run as a command, so a PowerShell call never carries the text itself.
 */
function readInputFile(file) {
  try { return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""); }
  catch (error) { throw new UsageError(`cannot read --input-file ${file}: ${error.code ?? error.message}`); }
}

/** Stdin's text. A pipe left open with nothing sent is no input when arguments carry it, and refused otherwise. */
export async function stdinText(positionals, { stream = process.stdin, idleMs = stdinIdleMs(), inputFile = null } = {}) {
  if (inputFile !== null) return readInputFile(inputFile);
  const raw = await readStdin(stream, idleMs);
  if (raw !== null) return raw;
  if (positionals.length) return "";
  throw new UsageError(`stdin stayed open for ${idleMs / 1000} s with no input; close it after the input, or use </dev/null when there is none`);
}

/**
 * The text of a turn verb: positionals after `--` (literal), or stdin, whose leading options are
 * parsed out unless argv had `--`. Options found in the text join the argv options.
 */
export async function readText(options, positionals, literal, io = {}) {
  const raw = (await stdinText(positionals, io)).replace(/\r?\n$/, "");
  if (raw.trim() && positionals.length) throw new UsageError("give the text on stdin or as arguments, not both");
  if (positionals.length) return { options, text: positionals.join(" "), literal };
  if (literal) return { options, text: raw, literal };
  const split = splitLeading(raw, INPUT_SPEC);
  return { options: { ...options, ...split.options }, text: split.text, literal: split.literal };
}

/** Control verbs accept only scalar options and ids, on argv or on stdin. No shell or eval tokenization. */
export async function readControlArgs(options, positionals, io = {}) {
  const raw = (await stdinText(positionals, io)).trim();
  if (raw && positionals.length) throw new UsageError("give control arguments on stdin or argv, not both");
  if (!raw) return { options, positionals };
  const supplied = parseArgv(raw.split(/\s+/), INPUT_SPEC);
  return { options: { ...options, ...supplied.options }, positionals: supplied.positionals };
}

/** `reply k3f9 more`: the first word names the thread unless --thread or --last does; options after it apply. */
export function splitReply(verb, o, text, literal) {
  if (verb !== "reply" || o.thread || o.last) return { o, text };
  const first = /^\s*(\S+)\s*/.exec(text);
  if (!first) throw new UsageError("reply needs a job or thread id, or --last");
  const rest = literal ? { options: {}, text: text.slice(first[0].length) } : splitLeading(text.slice(first[0].length), INPUT_SPEC);
  return { o: { ...o, ...rest.options, thread: first[1] }, text: rest.text };
}
