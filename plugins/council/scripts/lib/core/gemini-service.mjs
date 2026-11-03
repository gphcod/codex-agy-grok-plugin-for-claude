// Native agy 503 failures are temporary; retries remain separate, replay-safe host calls.
import path from 'node:path';
export function geminiServiceFailure(error, { partial = false, toolActivity = false } = {}) {
  if (typeof error !== 'string' || !/^API error \(attempt [1-9]\d*\): UNAVAILABLE \(code 503\):(?:\s|$)/.test(error)) return null;
  return { category: 'service_unavailable', status: 503, noVisibleWork: !partial && !toolActivity };
}

export function serviceRetry(job, pending = false) {
  const failure = job.transientFailure;
  if (job.provider !== 'gemini' || job.outcome !== 'failed' || job.code !== 1 || failure?.status !== 503) return null;
  const unconfirmed = job.admitted && job.requestedThreadId && !job.threadId;
  const atLimit = job.verb === 'reply' && Number.isFinite(job.rounds) && job.round >= job.rounds;
  const eligible = !pending && job.verb !== 'task' && job.readOnly === true
    && failure.noVisibleWork === true && !(job.edited?.length) && job.mutationCoverage !== 'unknown'
    && !unconfirmed && !job.unconfirmed && !job.threadLocked && !job.unattributedPipes && !job.partial && !atLimit;
  return {
    category: 'service_unavailable', status: 503,
    eligible, afterMs: 2000, maxRetries: eligible ? 1 : 0,
  };
}

export function serviceRetryHint(job, pending = false) {
  const retry = serviceRetry(job, pending);
  if (!retry) return null;
  return retry.eligible
    ? 'temporary 503; next: repeat once after 2s with a fresh request id'
    : 'temporary 503; next: report failure; no automatic repeat';
}

export function saveServiceDraft(job, text, io) {
  if (typeof text !== 'string' || !text.trim()) return;
  job.partial = true;
  const file = path.join(job.dir, 'partial.md');
  const heading = '# Partial Gemini response (unfinished)\n\nThis turn failed with 503. This draft is not a completed review or approval.\n\n';
  try {
    io.writeFileSync(file, heading + text, { encoding: 'utf8', mode: 0o600 });
    job.partialFile = file;
  } catch (error) { job.partialError = String(error.message).slice(0, 1000); }
}
