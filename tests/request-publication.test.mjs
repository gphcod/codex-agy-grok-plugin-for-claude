import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { reservationRecord, readPublications, publishRequest, publicationFile, cleanupPublications, syncPublicationDirectory, linkReservation, releaseReservation } from '../plugins/council/scripts/lib/core/request-publication.mjs';
import * as jobs from '../plugins/council/scripts/lib/core/jobs.mjs';
import { writeFileAtomic, sleepSync } from '../plugins/council/scripts/lib/core/fs.mjs';
import { main } from '../plugins/council/scripts/council.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'council-publication-'));
  t.after(() => { const relative = path.relative(os.tmpdir(), root); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });
  const file = path.join(root, 'request.json');
  const record = { fingerprint: 'fp', state: 'reserved', provider: null, job: null, recordToken: 'a'.repeat(32) };
  fs.writeFileSync(file, JSON.stringify(record), 'utf8');
  return { root, file, record, lookup: () => readPublications(file, JSON.parse(fs.readFileSync(file, 'utf8'))) };
}

test('binding/prepared publications are complete, immutable and leave the reservation bytes unchanged', t => {
  const f = fixture(t), original = fs.readFileSync(f.file);
  publishRequest(f.file, f.record, 'binding', { provider: 'null', job: 'a'.repeat(16) });
  publishRequest(f.file, f.lookup(), 'prepared', { state: 'tombstone', preparedAt: 'first' });
  publishRequest(f.file, f.lookup(), 'prepared', { state: 'tombstone', preparedAt: 'second' });
  assert.deepEqual(fs.readFileSync(f.file), original);
  assert.equal(f.lookup().state, 'tombstone'); assert.equal(f.lookup().preparedAt, 'first');
  assert.equal(f.lookup().job, 'a'.repeat(16));
  assert.throws(() => publishRequest(f.file, f.lookup(), 'binding', { provider: 'other', job: 'b'.repeat(16) }), /different work/);
  assert.equal(fs.readdirSync(f.root).filter(n => n.endsWith('.tmp')).length, 0);
});

test('damaged/mismatched stage data is never treated as an unbound request', t => {
  const f = fixture(t), sidecar = publicationFile(f.file, f.record.recordToken, 'binding');
  for (const data of ['{broken', JSON.stringify({ recordToken: 'b'.repeat(32), data: { provider: 'null', job: 'a' } }), JSON.stringify({ recordToken: f.record.recordToken, data: { provider: 'null', job: 'a', fingerprint: 'changed' } })]) {
    fs.writeFileSync(sidecar, data, 'utf8'); assert.throws(f.lookup, /unreadable|invalid request publication/); assert.ok(fs.existsSync(sidecar));
  }
});

test('failed stage creation publishes nothing; a changed reservation cannot receive an old generation', t => {
  const f = fixture(t), io = { ...fs, writeFileSync() { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } };
  assert.throws(() => publishRequest(f.file, f.record, 'binding', { provider: 'null', job: 'a' }, io), /ENOSPC/);
  assert.equal(f.lookup().job, null);
  fs.writeFileSync(f.file, JSON.stringify({ ...f.record, recordToken: 'b'.repeat(32) }), 'utf8');
  assert.throws(() => publishRequest(f.file, f.record, 'binding', { provider: 'null', job: 'a' }), /reservation changed/);
  assert.equal(f.lookup().job, null);
});

test('a short lock on the private stage publication retries without replacing the reservation', t => {
  const f = fixture(t); let attempts = 0;
  const io = { ...fs, linkSync(from, to) {
    if (++attempts < 3) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    return fs.linkSync(from, to);
  } };
  publishRequest(f.file, f.record, 'binding', { provider: 'null', job: 'a' }, io);
  assert.equal(attempts, 3); assert.equal(f.lookup().job, 'a');
});

test('legacy inline tombstones remain readable; cleanup only touches its own generation', t => {
  const f = fixture(t), legacy = { fingerprint: 'old', state: 'tombstone', provider: 'null', job: 'oldjob' };
  fs.writeFileSync(f.file, JSON.stringify(legacy), 'utf8');
  const view = f.lookup(); assert.equal(view.state, 'tombstone'); assert.equal(view.job, 'oldjob');
  publishRequest(f.file, view, 'prepared', { state: 'tombstone', preparedAt: 'legacy' });
  const newRecord = { ...f.record, recordToken: 'b'.repeat(32) };
  fs.writeFileSync(f.file, JSON.stringify(newRecord), 'utf8');
  publishRequest(f.file, newRecord, 'binding', { provider: 'null', job: 'newjob' });
  cleanupPublications(f.file, view);
  assert.equal(f.lookup().job, 'newjob');
});

test('new reservations fail closed for old clients while current clients see the real stage', t => {
  const f = fixture(t), raw = reservationRecord(f.record);
  fs.unlinkSync(f.file); const temp = f.file + '.private';
  fs.writeFileSync(temp, JSON.stringify(raw), 'utf8'); linkReservation(temp, f.file, f.record); fs.unlinkSync(temp);
  assert.equal(raw.state, 'tombstone'); assert.equal(raw.provider, 'publication-v2'); assert.equal(raw.job, 'unsupported');
  assert.equal(f.lookup().state, 'reserved'); assert.equal(f.lookup().job, null);
  publishRequest(f.file, f.lookup(), 'binding', { provider: 'null', job: 'actualjob' });
  publishRequest(f.file, f.lookup(), 'prepared', { state: 'tombstone', preparedAt: 'now' });
  assert.equal(f.lookup().job, 'actualjob'); assert.equal(f.lookup().state, 'tombstone');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), raw, 'old readers cannot mistake completed work for an abandoned reservation');
});

test('publishing both stages between reads never yields a tombstone without its provider', t => {
  const f = fixture(t), binding = publicationFile(f.file, f.record.recordToken, 'binding'); let raced = false;
  const io = { ...fs, readFileSync(file, ...args) {
    if (file === binding && !raced) {
      raced = true; publishRequest(f.file, f.record, 'binding', { provider: 'null', job: 'racejob' });
      publishRequest(f.file, f.lookup(), 'prepared', { state: 'tombstone', preparedAt: 'race' });
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    return fs.readFileSync(file, ...args);
  } };
  const view = readPublications(f.file, f.record, undefined, io);
  assert.ok(view.state !== 'tombstone' || view.job, 'a consistent pre-progress snapshot or complete binding');
  assert.equal(f.lookup().state, 'tombstone'); assert.equal(f.lookup().job, 'racejob');
});

test('a prepared stage without a binding stays blocked and cleanup removes terminal stage first', t => {
  const f = fixture(t), order = [];
  assert.throws(() => publishRequest(f.file, f.record, 'prepared', { state: 'tombstone', preparedAt: 'bad' }), /without.*binding/);
  fs.writeFileSync(publicationFile(f.file, f.record.recordToken, 'prepared'), JSON.stringify({ recordToken: f.record.recordToken, data: { state: 'tombstone', preparedAt: 'damaged' } }), 'utf8');
  assert.throws(f.lookup, /no provider binding/);
  cleanupPublications(f.file, f.record, { ...fs, rmSync(file, ...args) { order.push(file); return fs.rmSync(file, ...args); } });
  assert.match(order[0], /\.prepared\.json$/); assert.match(order[1], /\.binding\.json$/);
});

test('stage bytes flush before linking and POSIX directory sync closes its descriptor', t => {
  const f = fixture(t), order = [];
  publishRequest(f.file, f.record, 'binding', { provider: 'null', job: 'flushed' }, { ...fs,
    writeFileSync(file, data, options) { assert.equal(options.flush, true); order.push('flushed-write'); return fs.writeFileSync(file, data, options); },
    linkSync(from, to) { order.push('link'); return fs.linkSync(from, to); },
  });
  assert.deepEqual(order.slice(0, 2), ['flushed-write', 'link']);
  syncPublicationDirectory(f.file, { openSync(dir, mode) { assert.equal(dir, f.root); assert.equal(mode, 'r'); order.push('open-dir'); return 123; }, fsyncSync(fd) { assert.equal(fd, 123); order.push('sync-dir'); }, closeSync(fd) { assert.equal(fd, 123); order.push('close-dir'); } }, 'linux');
  assert.deepEqual(order.slice(-3), ['open-dir', 'sync-dir', 'close-dir']);
});

test('losing the generation during publication blocks completion without changing the replacement', t => {
  const f = fixture(t), replacement = { ...f.record, recordToken: 'b'.repeat(32) };
  const io = { ...fs, linkSync(from, to) { fs.linkSync(from, to); fs.writeFileSync(f.file, JSON.stringify(reservationRecord(replacement)), 'utf8'); } };
  assert.throws(() => publishRequest(f.file, f.record, 'binding', { provider: 'null', job: 'old' }, io), /changed during publication/);
  assert.equal(f.lookup().recordToken, replacement.recordToken); assert.equal(f.lookup().job, null);
});

test('host cleanup cannot delete a replacement owner or an already prepared request', t => {
  const f = fixture(t), state = path.join(f.root, 'state'); fs.mkdirSync(state);
  if (jobs.claimScope) {
    const claim = jobs.claimScope(state, { session: null, cwd: f.root, requestId: 'generation' }, { fingerprint: 'fp' });
    const replacement = { ...jobs.loadScope(claim.file), recordToken: 'b'.repeat(32) };
    fs.writeFileSync(claim.file, JSON.stringify(reservationRecord(replacement)), 'utf8');
    assert.throws(() => jobs.releaseScope(claim.file, claim.recordToken), /reservation changed/);
    assert.throws(() => jobs.bindScope(claim.file, 'null', 'oldjob', claim.recordToken), /reservation changed/);
    assert.equal(jobs.loadScope(claim.file).recordToken, replacement.recordToken);
  } else {
    const key = jobs.requestKey(null, f.root, 'generation'), jobId = jobs.requestJobId('null', null, f.root, 'generation');
    const first = jobs.claimRequest(state, { key, requestId: 'generation', session: null, cwd: f.root, fingerprint: 'fp' });
    jobs.bindRequest(state, key, { provider: 'null', jobId, recordToken: first.record.recordToken });
    jobs.markRequestPrepared(state, key, first.record.recordToken);
    assert.equal(jobs.releaseRequest(state, key, jobId, first.record.recordToken), false, 'prepared work is never released');
    const file = path.join(state, 'requests', key + '.json'), replacement = { ...first.record, recordToken: 'b'.repeat(32) };
    fs.writeFileSync(file, JSON.stringify(reservationRecord(replacement)), 'utf8');
    assert.throws(() => jobs.releaseRequest(state, key, jobId, first.record.recordToken), /reservation changed/);
    assert.throws(() => jobs.markRequestPrepared(state, key, first.record.recordToken), /record changed/);
    assert.equal(jobs.lookupRequest(state, key).recordToken, replacement.recordToken); assert.ok(fs.existsSync(path.join(state, 'jobs', jobId)));
  }
});

test('only one concurrent cleanup can unlink the common root, and a replacement owner remains intact', t => {
  const f = fixture(t); fs.unlinkSync(f.file);
  const create = record => { const temp = f.file + '.private'; fs.writeFileSync(temp, JSON.stringify(reservationRecord(record)), 'utf8'); linkReservation(temp, f.file, record); fs.unlinkSync(temp); };
  create(f.record); let raced = false;
  const replacement = { ...f.record, recordToken: 'b'.repeat(32) };
  const io = { ...fs, unlinkSync(file) {
    if (file === f.file && !raced) {
      raced = true; assert.throws(() => releaseReservation(f.file, f.record.recordToken), /cleanup is already in progress/);
      fs.unlinkSync(file); create(replacement); return;
    }
    return fs.unlinkSync(file);
  } };
  assert.equal(releaseReservation(f.file, f.record.recordToken, io), true);
  assert.equal(f.lookup().recordToken, replacement.recordToken);
  assert.ok(fs.existsSync(publicationFile(f.file, replacement.recordToken, 'owner')));
});

test('a failed root unlink restores its cleanup ownership gate and preserves the original error', t => {
  const f = fixture(t); fs.unlinkSync(f.file);
  const temp = f.file + '.private'; fs.writeFileSync(temp, JSON.stringify(reservationRecord(f.record)), 'utf8'); linkReservation(temp, f.file, f.record); fs.unlinkSync(temp);
  const error = Object.assign(new Error('root disk error'), { code: 'EIO' });
  assert.throws(() => releaseReservation(f.file, f.record.recordToken, { ...fs, unlinkSync(file) { if (file === f.file) throw error; return fs.unlinkSync(file); } }), candidate => candidate === error);
  assert.ok(fs.existsSync(f.file)); assert.ok(fs.existsSync(publicationFile(f.file, f.record.recordToken, 'owner')));
  assert.equal(releaseReservation(f.file, f.record.recordToken), true);
});

test('unfinished legacy reservations remain occupied for explicit reconciliation', t => {
  const f = fixture(t);
  const legacy = { fingerprint: 'old', state: 'reserved', provider: null, job: null };
  fs.writeFileSync(f.file, JSON.stringify(legacy), 'utf8');
  assert.throws(() => releaseReservation(f.file), /legacy request cleanup.*reconciliation/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), legacy);
});

test('preparation published between cleanup reads preserves the root and restores its gate', t => {
  const f = fixture(t); fs.unlinkSync(f.file); const temp = f.file + '.private';
  fs.writeFileSync(temp, JSON.stringify(reservationRecord(f.record)), 'utf8'); linkReservation(temp, f.file, f.record); fs.unlinkSync(temp);
  publishRequest(f.file, f.lookup(), 'binding', { provider: 'null', job: 'preparedrace' });
  const owner = publicationFile(f.file, f.record.recordToken, 'owner'); let raced = false;
  const io = { ...fs, unlinkSync(file) {
    if (file === owner && !raced) { raced = true; publishRequest(f.file, f.lookup(), 'prepared', { state: 'tombstone', preparedAt: 'race' }); }
    return fs.unlinkSync(file);
  } };
  assert.equal(releaseReservation(f.file, f.record.recordToken, io), false);
  assert.equal(f.lookup().state, 'tombstone'); assert.ok(fs.existsSync(owner));
});

test('a publisher cannot start work if cleanup already removed its ownership gate', t => {
  const f = fixture(t); fs.unlinkSync(f.file); const temp = f.file + '.private';
  fs.writeFileSync(temp, JSON.stringify(reservationRecord(f.record)), 'utf8'); linkReservation(temp, f.file, f.record); fs.unlinkSync(temp);
  publishRequest(f.file, f.lookup(), 'binding', { provider: 'null', job: 'blockedstart' });
  fs.unlinkSync(publicationFile(f.file, f.record.recordToken, 'owner')); let started = false;
  assert.throws(() => { publishRequest(f.file, f.lookup(), 'prepared', { state: 'tombstone', preparedAt: 'racing' }); started = true; }, /cleanup began during preparation/);
  assert.equal(started, false); assert.ok(fs.existsSync(f.file));
});

function hold(file) {
  const ready = file + '.lock-ready';
  const binary = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = fileURLToPath(new URL('./fixtures/hold-request-file.ps1', import.meta.url));
  const child = spawn(binary, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-TargetPath', file, '-ReadyFile', ready], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let diagnostic = ''; child.stderr.on('data', d => diagnostic += d); child.on('error', e => diagnostic += e.message);
  const exited = new Promise(resolve => child.once('close', resolve));
  const end = Date.now() + 8000;
  while (!fs.existsSync(ready) && Date.now() < end) sleepSync(20);
  if (!fs.existsSync(ready)) { child.kill(); throw new Error('Windows lock helper missed its readiness deadline: ' + diagnostic); }
  let released = false;
  return { child, release: async () => {
    if (released) return; released = true; child.stdin.end('\n');
    let timer; const code = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill(); resolve('timeout'); }, 5000); })]); clearTimeout(timer);
    assert.equal(code, 0, 'lock helper closed: ' + diagnostic);
  } };
}

test('real Windows lock exceeds the old rename window; immutable stages publish while it remains held', { skip: process.platform !== 'win32', timeout: 25000 }, async t => {
  const f = fixture(t), locked = hold(f.file), original = fs.readFileSync(f.file);
  try {
    const before = performance.now();
    assert.throws(() => writeFileAtomic(f.file, '{}'), e => ['EPERM', 'EACCES', 'EBUSY'].includes(e.code));
    assert.ok(performance.now() - before >= 4900, 'the existing five-second retry window was exhausted');
    const start = performance.now();
    publishRequest(f.file, f.record, 'binding', { provider: 'null', job: 'a'.repeat(16) });
    publishRequest(f.file, f.lookup(), 'prepared', { state: 'tombstone', preparedAt: 'now' });
    assert.ok(performance.now() - start < 5000, 'no longer waits for the held root file to become replaceable');
    assert.equal(locked.child.exitCode, null); assert.deepEqual(fs.readFileSync(f.file), original);
    assert.equal(f.lookup().state, 'tombstone');
  } finally { await locked.release(); }
});

test('real Windows pre-provider lock still permits one submission and identical replay through the entry', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const f = fixture(t), work = path.join(f.root, 'work'), state = path.join(f.root, 'state'); fs.mkdirSync(work);
  const log = path.join(f.root, 'native-log'), spawns = path.join(f.root, 'spawns');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^COUNCIL_|^(CODEX_COMPANION_DEPTH|GROK_BUILD_DEPTH|CLAUDE_PLUGIN_CODEX_DEPTH|GROK_CODEX_DEPTH|AGY_BRIDGE_DEPTH)$/.test(key)) delete env[key];
  Object.assign(env, { COUNCIL_HOME: state, COUNCIL_CODEX_HOME: state, COUNCIL_TEST_NULL_ADAPTER: '1', COUNCIL_TEST_ABSENT_PROVIDERS: 'codex,claude,gemini,grok', COUNCIL_FAKE_LOG: log, COUNCIL_FAKE_SPAWN_LOG: spawns, CODEX_THREAD_ID: '', CLAUDE_CODE_SESSION_ID: '' });
  const original = fs.linkSync; let locked = null, reservation = null;
  fs.linkSync = (from, to) => {
    const result = original(from, to), name = path.basename(String(to));
    if (!locked && path.basename(path.dirname(String(to))) === 'requests' && (/^scope-[a-f0-9]+\.json$/.test(name) || /^[a-f0-9]+\.json$/.test(name))) { reservation = String(to); locked = hold(reservation); }
    return result;
  };
  const call = async () => {
    const stdin = new PassThrough(); stdin.end(''); let out = '', err = '';
    const code = await main(['ask', '--to', 'null', '--request-id', 'locked-request', '--json', '--', 'q'], env,
      { stdin, stdout: { write(s) { out += s; } }, stderr: { write(s) { err += s; } }, cwd: work }, { cwd: work });
    return { code, out, err };
  };
  try {
    const first = await call(); assert.equal(first.code, 0, first.err + first.out); assert.ok(locked);
    assert.equal(locked.child.exitCode, null); const second = await call(); assert.equal(second.code, 0, second.err + second.out);
    assert.equal(JSON.parse(first.out).job, JSON.parse(second.out).job);
    const actualLog = fs.existsSync(spawns) ? spawns : log;
    const entries = fs.readFileSync(actualLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const submissions = entries.filter(row => !row.probe);
    assert.equal(submissions.length, 1, 'no duplicate provider submission: ' + JSON.stringify(entries));
    assert.ok(fs.existsSync(reservation));
  } finally { fs.linkSync = original; if (locked) await locked.release(); }
});
