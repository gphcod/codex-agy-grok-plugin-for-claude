// Frozen contracts (PLAN.md S2.7, docs/decisions.md "S2 freeze"). Type definitions only; nothing runs.
// Changing any of them needs a decisions entry and a review by one of the three models.

/** @typedef {"codex"|"gemini"|"grok"} ProviderId */
/** @typedef {"native"|"node-script"|"shim-native"|"shim-node"} LauncherKind */
/** @typedef {{command: string, args: string[], path: string, kind: LauncherKind}} Launcher  an adapter may add its own fields */
/** @typedef {{pid: number, ppid: number, stamp: string, raw: string|null, argv: string[]|null, name: string, group?: number, boot?: string, inaccessible?: boolean, exiting?: boolean}} ProcessRow */
/** @typedef {{version: string|null, loggedIn: boolean|null, models: {id: string, efforts: string[]}[]|null, notes?: string[], warnings?: string[]}} Probe  setup prints notes and warnings (S3) */
/** @typedef {{provider: ProviderId, threadId: string, cwd: string, model: string, effort: string, tier: string, round: number, rounds: number, roundsSet?: boolean, web?: boolean, agent?: string|null, readOnly?: boolean, resumable?: false, unconfirmed?: string, lastJob?: string, lastVerb?: string, updatedAt?: string}} ThreadRecord */

/**
 * @typedef {object} Request  What the core passes to buildTurn (plus jobId, jobDir) and checkRequest.
 * @property {"ask"|"reply"|"review"|"task"} verb
 * @property {ProviderId} provider
 * @property {string} cwd  realpath of the workspace
 * @property {string|null} session
 * @property {string} tier
 * @property {string} model
 * @property {boolean} modelVerified
 * @property {string|null} effort  after the A3.3 clamp
 * @property {string|null} requestedEffort
 * @property {ThreadRecord|null} thread  the thread to resume, or null for a new one
 * @property {boolean} readOnly  false only on task
 * @property {string} text
 * @property {string} contract  contract.md
 * @property {boolean} web
 * @property {boolean} adversarial
 * @property {number} deadline  seconds
 * @property {number} rounds
 * @property {boolean} roundsSet  a budget someone set with --rounds, inherited by later turns
 * @property {number|null} round  null on review
 * @property {string|null} target  review label
 * @property {object|null} reviewTarget  git.mjs reviewTarget()
 * @property {{flags: string[], stdin: string|null}|null} reviewNative
 * @property {string|null} reviewPrompt  rendered collected-diff prompt
 * @property {string[]} reviewed
 * @property {string[]} unreviewed
 */

/**
 * @typedef {object} Turn  buildTurn's return.
 * @property {string[]} args
 * @property {Record<string,string>} env  additions; the core adds the four guard variables
 * @property {string} [stdin]
 * @property {string} [promptFile]  with promptText, written by the core before the spawn
 * @property {string} [settingsPath]  a job-specific settings file the adapter wrote (Gemini)
 * @property {string} [promptText]
 * @property {string|null} answerFile  null: the answer is the streamed text
 * @property {boolean} readOnly
 * @property {string|null} [agent]  persisted on the thread record (Grok)
 * @property {string} contractCarrier
 * @property {string|null} [threadId]  a preassigned id, claimed before the spawn
 */

/**
 * @typedef {object} ParsedEvent  parseEvent's return; null for a line that carries nothing.
 * @property {string} [threadId]
 * @property {string} [textDelta]
 * @property {string} [toolStep]
 * @property {boolean} [completed]
 * @property {string|boolean} [fatal]  latched: a later success cannot clear it
 * @property {string|boolean} [denied]  exit 10
 * @property {string|boolean} [incomplete]  exit 1
 * @property {string} [unconfirmed]  the turn finished without confirming its thread: answer kept, this text is the footer hint, the thread is not resumable
 * @property {object} [structured]
 * @property {string|string[]} [edited]
 * @property {object|string} [failedCommand]
 * @property {number} [costUsd]
 * @property {object} [usage]
 * @property {string} [error]
 */

/** @typedef {{severity: "BLOCKER"|"MAJOR"|"MINOR", file: string, line: number|null, lineEnd?: number, title: string, text: string, recommendation?: string, confidence?: number}} Finding */
/** @typedef {{verdict: "approve"|"changes"|"incomplete", findings: Finding[], coverage: {reviewed: string[], unreviewed: string[]}, incomplete: string|null}} ReviewResult  A5.2 */
/**
 * @typedef {{native: true, flags: string[], stdin: string|null} | {native: false, template: "review"|"adversarial-review", schemaCarrier?: string, diff?: string}} ReviewPlan
 * For the collected route the core collects the diff (gitInfo.collect()) and renders the template;
 * `diff` and `schemaCarrier` are informational and optional — how the schema reaches the CLI is
 * the adapter's buildTurn business.
 */

/**
 * @typedef {object} Adapter  A5, loaded from lib/providers/<id>.mjs by the entry.
 * @property {ProviderId} id
 * @property {string} binEnv
 * @property {(env: object, platform: string) => Launcher|null} resolveLauncher  never via cmd.exe
 * @property {(launcher: Launcher) => boolean} trustsCleanExit
 * @property {(row: ProcessRow, job: object, platform: string) => boolean} ownsProcess  via hasFlagOperand
 * @property {number} maxLineBytes
 * @property {(launcher: Launcher, env: object) => Probe} probe
 * @property {object} catalog  this provider's models.json entry
 * @property {(request: Request & {jobId: string, jobDir: string, env: object, launcher: Launcher}) => Turn} buildTurn  reads env and launcher from the request, never process.env
 * @property {(request: Request, env: object) => void} [checkRequest]  throws UsageError (exit 2) before any job
 * @property {(ctx: {job: object, request: Request, turn: Turn, home: string, env: object}) => void} [beforeTurn]  once, before the spawn; a throw fails the turn
 * @property {(ctx: {job: object, request: Request, turn: Turn, home: string, env: object}, outcome: {outcome: string, code: number, error: string|null}) => void} [afterTurn]  once, after finalization with verified cleanup; independent of beforeTurn
 * @property {(line: string, state: object) => ParsedEvent|null} parseEvent  state.turn is this turn's buildTurn result (S4 core fix)
 * @property {(gitInfo: {root: string, target: object, collect: () => object}, request: Request) => ReviewPlan} reviewPlan
 * @property {(input: {answerText: string, answerFile: string|null, structured: object|null, unreviewed: string[]}) => ReviewResult & {renderedText?: string, summary?: string, nextSteps?: string[]}} finalizeReview  answerText is the whole stored answer
 */

/** Exit codes (A3.4): done, needs attention, still running, failed/cancelled/busy, invalid input. */
export const EXIT = Object.freeze({ OK: 0, ATTENTION: 10, RUNNING: 20, FAILED: 1, USAGE: 2 });
