/** Production defaults; tests inject shorter ones through hooks. */
export const SHUTDOWN_MS = 60000;
export const RETRY_MS = 10000;
export const DRAIN_MS = 1500;
/**
 * How long after a clean exit the child's pipes may stay open, held by nothing the turn owns, before
 * the turn ends "cleanup pending" with the thread locked (codex-plugin-cc lib/lifecycle.mjs:18-25).
 */
export const PIPE_WAIT_MS = 12000;
export const DEFAULT_ROUNDS = 9;
export const INACTIVITY_S = 1200;
export const DEADLINE_S = 14400;
