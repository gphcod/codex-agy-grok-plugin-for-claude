import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, relative, isAbsolute } from 'node:path';
import adapter from '../plugins/council/scripts/lib/providers/gemini.mjs';
import { createReader } from '../plugins/council/scripts/lib/core/reader.mjs';
import { geminiServiceFailure, serviceRetry, saveServiceDraft } from '../plugins/council/scripts/lib/core/gemini-service.mjs';
import { resultJson } from '../plugins/council/scripts/lib/core/output.mjs';
import { GUARD_VARS } from '../plugins/council/scripts/lib/core/execution.mjs';
const makeReader = () => createReader({ adapter, turn: { readOnly: true } });
const ERROR = 'API error (attempt 1): UNAVAILABLE (code 503): The service is currently unavailable.';
const result = error => ({ event: 'result', result: { status: 'ERROR', response: '', error, usage: { input_tokens: 0 } } });
const failed = transientFailure => ({ provider: 'gemini', verb: 'ask', outcome: 'failed', code: 1, readOnly: true, transientFailure });

test('a 503 with denied actions remains incomplete; a pure denial keeps its normal completion semantics', () => {
  const mixed = result(ERROR); mixed.result.denied_actions = [{ action: 'run_command' }];
  const reader = makeReader(); reader.feed(JSON.stringify(mixed) + '\n'); reader.end();
  assert.match(reader.state.failed, /503/); assert.equal(reader.state.completed, false);
  assert.equal(serviceRetry(failed(reader.state.transientFailure)).eligible, false);
  const denial = makeReader(); denial.feed(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '', denied_actions: [{ action: 'run_command' }] } }) + '\n'); denial.end();
  assert.equal(denial.state.completed, true); assert.equal(denial.state.failed, null);
});

test('the recorded native 503 is transient; authentication, other errors and successful text are not', () => {
  assert.equal(geminiServiceFailure(ERROR).status, 503);
  for (const error of ['503', 'API error (attempt 1): UNAUTHENTICATED (code 403): denied', 'Read file named 503', null]) {
    assert.equal(geminiServiceFailure(error), null);
  }
  const reader = makeReader(); reader.feed(JSON.stringify(result(ERROR)) + '\n'); reader.end();
  assert.equal(reader.state.transientFailure.status, 503);
  assert.match(reader.state.failed, /503/);
  assert.equal((reader.state.usage.conversation ?? reader.state.usage).input_tokens, 0, 'failure counters retained');
  assert.equal(serviceRetry(failed(reader.state.transientFailure)).eligible, true);
});

test('partial output, a started tool, tasks and uncertain cleanup prohibit a host retry', () => {
  for (const step_update of [
    { step_type: 'agent_response', state: 'DONE', text_delta: 'partial' },
    { step_type: 'tool', state: 'STARTED', tool_name: 'read_file' },
  ]) {
    const reader = makeReader();
    reader.feed(JSON.stringify({ event: 'step_update', step_update }) + '\n');
    reader.feed(JSON.stringify(result(ERROR)) + '\n'); reader.end();
    assert.equal(serviceRetry(failed(reader.state.transientFailure)).eligible, false);
  }
  const job = failed(geminiServiceFailure(ERROR));
  assert.equal(serviceRetry({ ...job, verb: 'task', readOnly: false }).maxRetries, 0);
  assert.equal(serviceRetry(job, true).eligible, false);
  assert.equal(serviceRetry({ ...job, edited: ['a'] }).eligible, false);
  for (const blocked of [{ mutationCoverage: 'unknown' }, { unconfirmed: 'native id unconfirmed' }, { admitted: true, requestedThreadId: 'old', threadId: null }, { verb: 'reply', round: 9, rounds: 9 }]) assert.equal(serviceRetry({ ...job, ...blocked }).eligible, false);
  assert.equal(serviceRetry({ ...job, outcome: 'attention', code: 10 }), null);
});

for (const testedVerb of ['ask', 'reply', 'review', 'partial', 'partial-review']) test('503 replay and one explicit fresh recovery: ' + testedVerb, async t => {
  const partial = testedVerb.startsWith('partial');
  const verb = testedVerb === 'partial-review' ? 'review' : testedVerb === 'partial' ? 'ask' : testedVerb;
  const root = fs.mkdtempSync(join(tmpdir(), 'council-503-'));
  t.after(() => { const rel = relative(tmpdir(), root); assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel)); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });
  const home = join(root, 'state'), log = join(root, 'turns.jsonl'), workspace = join(root, 'work');
  fs.mkdirSync(workspace); fs.writeFileSync(log, '', 'utf8');
  const entry = fileURLToPath(new URL('../plugins/council/scripts/council.mjs', import.meta.url));
  const env = { ...process.env, COUNCIL_FAKE_TRANSIENT_PARTIAL: partial ? '1' : '0', COUNCIL_FAKE_TRANSIENT_PARTIAL_TEXT: verb === 'review' ? JSON.stringify({ verdict: 'approve', findings: [], coverage: { reviewed: 1, unreviewed: 0, pending: 0 } }) : 'partial answer', COUNCIL_HOME: home, COUNCIL_CODEX_HOME: home, CODEX_THREAD_ID: '503-test', CLAUDE_CODE_SESSION_ID: '',
    HOME: root, USERPROFILE: root, COUNCIL_AGY_BIN: fileURLToPath(new URL('./fixtures/fake-agy-transient.mjs', import.meta.url)),
    COUNCIL_FAKE_TRANSIENT_LOG: log, COUNCIL_FAKE_EXPECT_PROMPT_CONTAINS: '', COUNCIL_FAKE_JOB_DIR: join(home, 'jobs') };
  for (const guard of GUARD_VARS) delete env[guard];
  const contract = fs.readFileSync(new URL('../plugins/council/contract.md', import.meta.url), 'utf8').trim();
  const run = (request, verb, thread = null) => new Promise(resolve => {
    let out = '', err = '';
    const args = [entry, verb, ...(thread ? ['--thread', thread] : ['--to', 'gemini', '--tier', 'consult']),
      '--request-id', request, '--json', ...(verb === 'review' ? ['--uncommitted'] : []), '--', 'Reply with pong'];
    const child = spawn(process.execPath, args, { cwd: workspace,
      env: { ...env, COUNCIL_FAKE_SCENARIO: verb === 'review' ? 'review-findings' : verb === 'reply' ? 'resume' : 'ok',
        COUNCIL_FAKE_EXPECT_CONTRACT: verb === 'review' ? '' : contract }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
    child.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
  const git = args => { const r = spawnSync('git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr); };
  git(['init', '-q', '-b', 'main']); fs.writeFileSync(join(workspace, 'calc.js'), 'export const n = 1;\n', 'utf8');
  git(['add', '.']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);
  let thread = null;
  if (testedVerb === 'reply') {
    fs.writeFileSync(log, '{}\n', 'utf8'); // let the normal fake establish a resumable thread
    const seed = await run('seed', 'ask'); assert.equal(seed.code, 0, seed.err + seed.out);
    thread = JSON.parse(seed.out).job; fs.writeFileSync(log, '', 'utf8');
  }
  if (verb === 'review') {
    fs.writeFileSync(join(workspace, 'calc.js'), 'export const n = 0 / 0;\n', 'utf8');
  }
  const first = await run('original', verb, thread);
  assert.equal(first.code, 1, first.err + first.out);
  const error = JSON.parse(first.out);
  assert.equal(error.retry?.eligible, !partial, first.out);
  assert.equal(error.retry.afterMs, 2000); assert.equal(error.retry.maxRetries, partial ? 0 : 1);
  assert.equal(error.cleanupPending, false); assert.ok(error.usage, 'failure usage exposed');
  const replay = await run('original', verb, thread);
  assert.equal(replay.code, 1); const replayed = JSON.parse(replay.out);
  assert.equal(replayed.job, error.job); assert.deepEqual(replayed.retry, error.retry); assert.deepEqual(replayed.usage, error.usage);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, 'same id replays the failed job');
  if (partial) {
    assert.equal(error.partial, true); assert.equal(replayed.partialFile, error.partialFile);
    const draft = fs.readFileSync(error.partialFile, 'utf8');
    assert.match(draft, /unfinished/); assert.match(draft, verb === 'review' ? /"verdict":"approve"/ : /partial answer/);
    assert.equal(error.answer, ''); assert.equal(error.verdict, null);
    const reviewed = error.coverage?.reviewed;
    assert.equal(Array.isArray(reviewed) ? reviewed.length : reviewed ?? 0, 0, 'a failed review grants no coverage'); return;
  }
  const retry = await run('recovery1', testedVerb, thread);
  assert.equal(retry.code, testedVerb === 'review' ? 10 : 0, retry.err + retry.out);
  assert.notEqual(JSON.parse(retry.out).job, error.job);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 2, 'exactly one explicit new submission');
});

test('a later 503 cannot replace an earlier malformed-stream failure', () => {
  for (const sameChunk of [true, false]) {
    const reader = makeReader();
    const second = JSON.stringify(result(ERROR)) + '\n';
    reader.feed(sameChunk ? 'not-json\n' + second : 'not-json\n');
    if (!sameChunk) reader.feed(second);
    reader.end();
    assert.match(reader.state.failed, /malformed/i);
    assert.equal(reader.state.transientFailure, undefined);
    assert.equal(reader.state.partialText, undefined);
    assert.equal(serviceRetry(failed(reader.state.transientFailure)), null);
  }
});

test('draft persistence failures never mask the provider error or grant retry/approval', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'council-draft-'));
  t.after(() => { const rel = relative(tmpdir(), root); assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel)); fs.rmSync(root, { recursive: true, force: true }); });
  const job = { ...failed(geminiServiceFailure(ERROR, { partial: true })), id: 'draft', dir: root, error: ERROR };
  saveServiceDraft(job, '{"verdict":"approve"}', fs);
  assert.match(fs.readFileSync(job.partialFile, 'utf8'), /not a completed review or approval/);
  assert.equal(resultJson(job, '').partial, true); assert.notEqual(resultJson(job, '').verdict, 'approve');
  const blocked = { ...job }; delete blocked.partialFile;
  saveServiceDraft(blocked, 'draft', { writeFileSync() { throw new Error('EACCES'); } });
  assert.equal(blocked.error, ERROR); assert.equal(blocked.code, 1); assert.match(blocked.partialError, /EACCES/);
  assert.equal(serviceRetry(blocked).eligible, false); assert.equal(resultJson(blocked, '').partialFile, null);
});
