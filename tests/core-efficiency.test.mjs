// Efficiency changes must preserve admission freshness, uncertain ownership and early job recovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { PassThrough } from 'node:stream';
import { main, fingerprint, resolveTarget } from '../plugins/council/scripts/council.mjs';
import { executionController, companionState, GUARD_VARS } from '../plugins/council/scripts/lib/core/execution.mjs';
import { bindScope, claimRequest, claimScope, homeDir, loadJob, saveThread } from '../plugins/council/scripts/lib/core/jobs.mjs';
import { runManagedTurn } from '../plugins/council/scripts/lib/core/lifecycle.mjs';
import { resultJson } from '../plugins/council/scripts/lib/core/output.mjs';
import { canonical } from '../plugins/council/scripts/lib/core/fs.mjs';
import adapter from './fixtures/null-adapter.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'council-efficiency-'));
  const cwd = canonical(root), home = homeDir({ COUNCIL_HOME: join(root, 'state') });
  const env = { ...process.env, COUNCIL_HOME: home, COUNCIL_TEST_NULL_ADAPTER: '1', CLAUDE_CODE_SESSION_ID: '' };
  for (const key of GUARD_VARS) delete env[key];
  t.after(() => {
    const rel = relative(tmpdir(), root);
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const call = async (args, hooks = {}) => {
    const stdin = new PassThrough(); stdin.end();
    let out = '', err = '';
    const code = await main(args, env, {
      cwd, stdin, stdout: { write: s => { out += s; } }, stderr: { write: s => { err += s; } },
    }, hooks);
    return { code, out, err };
  };
  return { root, ctx: { home, cwd, env, session: 'efficiency' }, call };
}

test('a reply avoids a speculative duplicate read but inherits history changed before its claim', async t => {
  const { ctx, call } = fixture(t);
  const first = await call(['ask', '--to', 'null', '--session', ctx.session, '--json', '--', 'start']);
  assert.equal(first.code, 0, first.err);
  const prior = JSON.parse(first.out);
  const originalRead = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', function (file, ...rest) {
    if (String(file).endsWith(`null-${prior.thread}.json`)) reads++;
    return originalRead.call(this, file, ...rest);
  });
  const reply = await call(['reply', '--thread', prior.job, '--json', '--', 'continue'], {
    beforeClaim() {
      assert.equal(reads, 1, 'resolveTarget is the only history read before admission');
      saveThread(ctx.home, {
        provider: 'null', threadId: prior.thread, cwd: ctx.cwd, model: 'null-fast', effort: 'medium',
        tier: 'exec', round: 5, rounds: 9, roundsSet: true, readOnly: false,
      });
    },
  });
  assert.equal(reply.code, 0, reply.err);
  const result = JSON.parse(reply.out);
  assert.deepEqual([result.model, result.effort, result.round], ['null-fast', 'medium', 6]);
  assert.equal(loadJob(ctx.home, result.job).readOnly, true, 'reply remains read-only after task history');
  assert.ok(reads >= 2, 'history refreshed under the claim');
});

test('an early durable job is announced before init and cannot be resumed before native confirmation', async t => {
  const { root, ctx } = fixture(t);
  const fake = join(root, 'fake-child.mjs');
  const thread = '11111111-1111-4111-8111-111111111111';
  fs.writeFileSync(fake, `setTimeout(() => {\n` +
    `for (const ev of [{type:'started',thread:'${thread}'},{type:'text',data:'done'},{type:'done'}]) process.stdout.write(JSON.stringify(ev)+'\\n');\n` +
    `}, 350);\n`, 'utf8');
  ctx.env.COUNCIL_NULL_BIN = fake;
  ctx.env.COUNCIL_NULL_ID = 'discovered';
  const request = {
    verb: 'ask', provider: 'null', cwd: ctx.cwd, model: 'null-model', effort: 'high', tier: 'consult',
    readOnly: true, text: 'start', contract: '<contract/>', thread: null, round: 1, rounds: 9,
  };
  let announced = 0;
  const result = await runManagedTurn(ctx, { ...adapter, trustsCleanExit: () => true }, request, () => request, {}, {
    announce(job) {
      announced++;
      assert.equal(job.threadId, null);
      assert.ok(loadJob(ctx.home, job.id).pid, 'spawn saved before announcing');
      assert.throws(() => resolveTarget(ctx, 'reply', { thread: job.id }), /native thread not confirmed yet; wait or cancel/);
    },
  });
  assert.equal(announced, 1);
  assert.equal(result.job.code, 0, result.job.error);
  assert.equal(resultJson(result.job, result.answer).thread, thread, 'native id retained publicly');
});

test('owner-only request queries preserve uncertainty and never free or run a reserved request', async t => {
  const { ctx, call } = fixture(t);
  for (const bound of [false, true]) {
    const id = bound ? 'bound' : 'unchosen';
    const options = { to: 'null', session: ctx.session, 'request-id': id, deadline: '0.02' };
    const fp = fingerprint('ask', options, 'start');
    const owner = { companionPid: 424242, companionIdentity: { pid: 424242, stamp: '1', raw: 'owner' }, fingerprint: fp };
    const scope = claimScope(ctx.home, { session: ctx.session, cwd: ctx.cwd, requestId: id }, owner);
    if (bound) {
      const reservation = claimRequest(ctx.home, 'null', id, ctx, owner);
      bindScope(scope.file, 'null', reservation.id);
    }
    const queries = [];
    const unknown = { state: 'unknown', rows: [], error: 'query unavailable' };
    const control = {
      self: () => owner.companionIdentity,
      snapshot(timeout, pid) { queries.push(pid); return unknown; },
    };
    const result = await call(['ask', '--to', 'null', '--session', ctx.session, '--request-id', id, '--deadline', '0.02', '--', 'start'], { control });
    assert.equal(result.code, bound ? 20 : 2, result.err);
    assert.ok(queries.length && queries.every(pid => pid === owner.companionPid));
    assert.ok(fs.existsSync(scope.file), 'unknown owner keeps its reservation');
    assert.equal(companionState(owner, unknown), 'unknown');
    const jobs = fs.existsSync(join(ctx.home, 'jobs')) ? fs.readdirSync(join(ctx.home, 'jobs')) : [];
    assert.ok(jobs.every(job => !loadJob(ctx.home, job)), 'reservations never become launched jobs');
  }
});

test('cleanup snapshots remain unrestricted and public usage keeps native counters without changing cost', () => {
  const queries = [];
  const control = executionController({ snapshot: options => { queries.push(options); return { state: 'ok', rows: [] }; } });
  control.snapshot(undefined, 424242);
  control.snapshot();
  assert.deepEqual(queries.map(q => q.pid), [424242, null]);
  const usage = { input_tokens: 123, cache_read_tokens: 100, output_tokens: 9 };
  const result = resultJson({ id: 'j', dir: '/j', provider: 'codex', verb: 'ask', usage, costUsd: 0.25 }, 'a');
  assert.deepEqual(result.usage, usage);
  assert.equal(result.costUsd, 0.25);
  assert.equal(resultJson({ id: 'j', dir: '/j' }, '').usage, null);
});
