import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { execFile } from 'node:child_process'; import { fileURLToPath } from 'node:url';
import { checkHealth, recordWorkerRun, healthTick } from './health.js';
import { reserveInstagramPublish, releaseInstagramReservation } from './ledger.js';
import { saveQueue, loadQueue, withQueueLock } from './lib.js';
import { runWorker } from './worker.js';
import { handle, dispatch } from './approval-server.js';
import { StoppedError, engageStop, stopStatus } from './stop.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bparev-'));
// The worker's Instagram gate reads the tokens file for its scopes only. test-env.js closes the real one, so this file gives it a made-up one (scopes, no token values).
{ const tf = path.join(tmp(), 'tokens.json'); fs.writeFileSync(tf, JSON.stringify({ user: { scopes: ['instagram_content_publish'] } })); process.env.META_TOKENS_PATH = tf; }
const T0 = new Date('2026-11-17T10:00:00Z'); const at = (min) => new Date(T0.getTime() + min * 60e3);
const rows = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const queued = (id, extra = {}) => ({ id, status: 'scheduled', kind: 'signal', text: 'x', sourceDate: '2026-11-01', scheduledFor: '2026-11-02T09:00:00+03:00', ig: { status: 'queued', at: '2026-11-02T09:00:00+03:00' }, ...extra });
function wfix(drafts = [queued('B1')]) {
  const d = tmp(); const queuePath = path.join(d, 'queue.json'); saveQueue({ seq: 9, drafts }, queuePath); const calls = { ig: 0, notify: 0, lines: [] };
  const deps = { now: T0, queuePath, igOn: () => true, config: {}, ledgerPath: path.join(d, 'l.jsonl'), runStatePath: path.join(d, 'run.json'), lastPostPath: path.join(d, 'lp.json'),
    stopOpts: { flagPath: path.join(d, 'nf'), fleetPath: path.join(d, 'nfl') }, publishIg: async () => { calls.ig++; return { permalink: 'https://example.invalid/1' }; },
    postStatus: async () => ({}), notify: async () => { calls.notify++; return true; }, say: (m) => calls.lines.push(m), approvalHealth: async () => ({ ok: true }) };
  return { d, deps, calls, queuePath };
}

// ── 1. the alarm measures "succeeded", not "ran" ──────────────────────────────
test('1: a worker that throws on three runs in a row alarms although lastRunAt is fresh', async () => {
  const { deps, d } = wfix(); await runWorker(deps); // one good run at T0
  for (const m of [15, 30, 45]) await assert.rejects(runWorker({ ...deps, now: at(m), stop: () => { throw new Error('kaboom'); } }), /kaboom/);
  const run = JSON.parse(fs.readFileSync(deps.runStatePath, 'utf8')); assert.equal(run.lastRunAt, at(45).toISOString()); assert.match(run.result, /^error: kaboom/); assert.equal(run.lastOkAt, T0.toISOString());
  const r = checkHealth({ now: at(46), config: {}, runStatePath: deps.runStatePath, stopOpts: deps.stopOpts });
  assert.deepEqual(r.problems.map((p) => p.key), ['worker-failing']); assert.match(r.problems[0].reason, /error: kaboom/);
});
test('1: a result starting with error alarms at once; a stale lastOkAt alarms even when the result is not an error', () => {
  const d = tmp(); const p = path.join(d, 'run.json'); const so = { flagPath: path.join(d, 'a'), fleetPath: path.join(d, 'b') };
  recordWorkerRun({ now: at(-5), result: 'ok', path: p }); recordWorkerRun({ now: at(0), result: 'error: x', path: p });
  assert.deepEqual(checkHealth({ now: at(1), config: {}, runStatePath: p, stopOpts: so }).problems.map((x) => x.key), ['worker-failing']);
  recordWorkerRun({ now: at(100), result: 'ok', path: p }); for (const m of [115, 130, 145, 150]) recordWorkerRun({ now: at(m), result: 'publish-failed', path: p });
  assert.deepEqual(checkHealth({ now: at(151), config: {}, runStatePath: p, stopOpts: so }).problems.map((x) => x.key), ['worker-failing']);
  assert.equal(checkHealth({ now: at(120), config: {}, runStatePath: p, stopOpts: so }).ok, true, 'one failed publish 20 min after the last good run is not yet an alarm');
});
test('1: stopped counts as ok for lastOkAt; a run with a failed publish does not update lastOkAt', async () => {
  const { deps } = wfix(); const f = () => JSON.parse(fs.readFileSync(deps.runStatePath, 'utf8'));
  await runWorker(deps); assert.equal(f().lastOkAt, T0.toISOString());
  await runWorker({ ...deps, now: at(15), publishIg: async () => { throw new Error('network down'); }, stopOpts: deps.stopOpts }); // item was posted in run 1, requeue it
  engageStop(deps.stopOpts); await runWorker({ ...deps, now: at(30) }); assert.equal(f().result, 'stopped'); assert.equal(f().lastOkAt, at(30).toISOString());
  fs.unlinkSync(deps.stopOpts.flagPath);
});
test('1: a failed publish run records result publish-failed and keeps the old lastOkAt', async () => {
  const { deps } = wfix(); const f = () => JSON.parse(fs.readFileSync(deps.runStatePath, 'utf8'));
  recordWorkerRun({ now: at(-15), result: 'ok', path: deps.runStatePath });
  await runWorker({ ...deps, publishIg: async () => { throw new Error('network down'); } });
  assert.equal(f().result, 'publish-failed'); assert.equal(f().lastRunAt, T0.toISOString()); assert.equal(f().lastOkAt, at(-15).toISOString());
});
test('1: README documents autoPublish / alarmNoPostDays as off-by-default (not claimed active)', () => {
  const r = fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  assert.match(r, /\|\s*`autoPublish`[^\n]*(absent|false)[^\n]*(not active|inactive|off)/i); assert.match(r, /`alarmNoPostDays`/); assert.match(r, /`maxInstagramPostsPerDay`/);
});

// ── 2. no false alert right after the approval server starts ──────────────────
test('2: missing or stale state is "unknown" for 20 minutes after the server start, then it alarms', async () => {
  const d = tmp(); const base = { config: {}, runStatePath: path.join(d, 'run.json'), lastPostPath: path.join(d, 'lp.json'), alertsPath: path.join(d, 'al.json'), stopOpts: { flagPath: path.join(d, 'a'), fleetPath: path.join(d, 'b') }, startedAt: T0 };
  const sent = []; const notify = async (t) => { sent.push(t); return true; }; const run = (now, extra = {}) => healthTick({ ...base, ...extra, now, notify, say: () => {} });
  await run(at(1)); assert.equal(sent.length, 0, 'missing state, 1 min after start: silent');
  recordWorkerRun({ now: at(-120), result: 'ok', path: base.runStatePath }); await run(at(19)); assert.equal(sent.length, 0, 'stale state, 19 min after start: silent');
  await run(at(21)); assert.equal(sent.length, 1, 'still stale after 20 min: alarm'); assert.match(sent[0], /has not run for/);
});
test('2: grace does not hide a real error result', async () => {
  const d = tmp(); const p = path.join(d, 'run.json'); recordWorkerRun({ now: at(0), result: 'error: boom', path: p }); const sent = [];
  await healthTick({ config: {}, runStatePath: p, alertsPath: path.join(d, 'al.json'), stopOpts: { flagPath: path.join(d, 'a'), fleetPath: path.join(d, 'b') }, startedAt: at(-1), now: at(1), notify: async (t) => { sent.push(t); return true; }, say: () => {} });
  assert.equal(sent.length, 1);
});

// ── 3. `bpa stop` says what it cannot stop ────────────────────────────────────
const stopFix = (drafts, qtxt) => { const d = tmp(); const queuePath = path.join(d, 'q.json'); if (qtxt !== undefined) fs.writeFileSync(queuePath, qtxt); else saveQueue({ seq: 1, drafts }, queuePath); return { queuePath, stopOpts: { flagPath: path.join(d, 'f', 'stop'), fleetPath: path.join(d, 'x') }, now: T0 }; };
test('3: bpa stop names the Facebook posts still scheduled at Meta (count + next time), in one line', async () => {
  const f = stopFix([{ id: 'B1', status: 'scheduled', scheduledFor: '2026-11-18T09:00:00+03:00' }, { id: 'B2', status: 'scheduled', scheduledFor: '2026-11-16T09:00:00+03:00' }, { id: 'B3', status: 'posted' }]);
  const out = await handle('bpa stop', f); assert.equal(out.split('\n').length, 1);
  assert.match(out, /^🛑 Stopped\./); assert.ok(out.endsWith('1 Facebook post is already scheduled at Meta for 18 Nov 09:00 and will still go out; cancel it in Meta if needed.'), out); assert.equal(stopStatus(f.stopOpts).stopped, true);
});
test('3: several scheduled posts: plural wording with the next time; none or a damaged queue: no note, still stopped', async () => {
  const two = stopFix([{ id: 'B1', status: 'scheduled', scheduledFor: '2026-11-19T09:00:00+03:00' }, { id: 'B2', status: 'scheduled', scheduledFor: '2026-11-18T09:00:00+03:00' }]);
  assert.ok((await handle('bpa stop', two)).endsWith('2 Facebook posts are already scheduled at Meta, the next for 18 Nov 09:00, and will still go out; cancel them in Meta if needed.'));
  const none = stopFix([{ id: 'B3', status: 'posted' }]); assert.doesNotMatch(await handle('bpa stop', none), /Meta/);
  const bad = stopFix(null, '{not json'); const out = await handle('bpa stop', bad); assert.doesNotMatch(out, /Meta/); assert.equal(stopStatus(bad.stopOpts).stopped, true);
});

// ── 5. bpa stop does not wait for the queue lock ──────────────────────────────
test('5: with the queue lock held by another call, bpa stop answers within one second and the flag exists; approve does wait', async () => {
  const f = stopFix([]); const lockPath = f.queuePath + '.lock'; let release; const held = withQueueLock(() => new Promise((r) => { release = r; }), { lockPath });
  await new Promise((r) => setTimeout(r, 50));
  const t = Date.now(); const out = await Promise.race([dispatch('bpa stop', f), new Promise((r) => setTimeout(() => r('TIMEOUT'), 1000))]);
  assert.notEqual(out, 'TIMEOUT'); assert.ok(Date.now() - t < 1000); assert.equal(stopStatus(f.stopOpts).stopped, true);
  assert.match(await Promise.race([dispatch('bpa start', f), new Promise((r) => setTimeout(() => r('TIMEOUT'), 1000))]), /started/);
  const wait = await Promise.race([dispatch('bpa list', f), new Promise((r) => setTimeout(() => r('WAITING'), 300))]); assert.equal(wait, 'WAITING', 'a normal command does queue behind the lock (so the test above is meaningful)');
  release(); await held;
});

// ── 4. a stop that arrives mid-publish ────────────────────────────────────────
test('4: ledger release removes exactly that reservation line, atomically, and nothing else', () => {
  const d = tmp(); const p = path.join(d, 'l.jsonl'); reserveInstagramPublish({ id: 'B1', now: new Date('2026-11-16T06:00:00Z'), path: p, config: {} });
  reserveInstagramPublish({ id: 'B2', now: new Date('2026-11-17T06:00:00Z'), path: p, config: {} });
  assert.deepEqual(releaseInstagramReservation({ id: 'B2', at: new Date('2026-11-17T06:00:00Z'), path: p }), { ok: true });
  assert.deepEqual(rows(p).map((r) => r.id), ['B1']); assert.equal(releaseInstagramReservation({ id: 'B9', at: T0, path: p }).ok, false); assert.deepEqual(rows(p).map((r) => r.id), ['B1']);
  assert.deepEqual(fs.readdirSync(d).sort(), ['l.jsonl']);
});
test('4: worker, stop appears between reserve and publish: item queued again, ledger has no line for it, no alert, one log line', async () => {
  const { deps, calls, queuePath } = wfix(); deps.publishIg = async () => { throw new StoppedError('stopped by flag since 2026-11-17T10:00:00.000Z'); };
  await runWorker(deps); const d0 = loadQueue(queuePath).drafts[0];
  assert.equal(d0.ig.status, 'queued'); assert.equal(d0.ig.at, '2026-11-02T09:00:00+03:00'); assert.equal(d0.ig.error, undefined); assert.deepEqual(rows(deps.ledgerPath), []);
  assert.equal(calls.notify, 0); assert.equal(calls.lines.filter((l) => /B1 .*stop/.test(l)).length, 1); assert.doesNotMatch(calls.lines.join('\n'), /publish failed/);
  assert.equal(JSON.parse(fs.readFileSync(deps.runStatePath, 'utf8')).result, 'ok');
});
test('4: worker, a NETWORK failure still keeps the reservation and marks the item failed', async () => {
  const { deps, queuePath } = wfix(); deps.publishIg = async () => { throw new Error('socket hang up'); }; await runWorker(deps);
  assert.deepEqual(rows(deps.ledgerPath).map((r) => r.id), ['B1']); assert.equal(loadQueue(queuePath).drafts[0].ig.status, 'failed');
});
const pending = () => ({ id: 'B1', status: 'pending_approval', kind: 'outlook', text: 'Outlook text with no figures', sourceDate: '2026-11-17' });
function hfix() { const d = tmp(); const queuePath = path.join(d, 'q.json'); saveQueue({ seq: 1, drafts: [pending()] }, queuePath); return { d, queuePath, ledgerPath: path.join(d, 'l.jsonl'), lastPostPath: path.join(d, 'lp.json'), config: {}, igOn: () => true, stopOpts: { flagPath: path.join(d, 'a'), fleetPath: path.join(d, 'b') }, publish: async () => ({ id: 'p1', permalink_url: 'https://example.invalid/p1' }) }; }
test('4: post now, stop appears before the Facebook post: nothing posted, item stays pending, reservation untouched, one line', async () => {
  const f = hfix(); f.publish = async () => { throw new StoppedError('stopped by flag since 2026-11-17T10:00:00.000Z'); }; let ig = 0; f.publishIg = async () => { ig++; return {}; };
  const out = await handle('bpa post B1 now', f); assert.match(out, /⏸ B1: stopped by flag since/); assert.equal(ig, 0); const d = loadQueue(f.queuePath).drafts[0]; assert.equal(d.status, 'pending_approval'); assert.equal(d.lastError, undefined);
});
test('4: post now, stop appears between the reservation and the Instagram publish: reservation released, Instagram queued, no failure recorded', async () => {
  const f = hfix(); f.publishIg = async () => { throw new StoppedError('stopped by flag since 2026-11-17T10:00:00.000Z'); };
  const out = await handle('bpa post B1 now', f); const d = loadQueue(f.queuePath).drafts[0];
  assert.equal(d.status, 'posted'); assert.equal(d.ig.status, 'queued'); assert.deepEqual(rows(f.ledgerPath), []); assert.match(out, /Instagram held.*stopped by flag since.*queued/);
});
test('4: post now, a NETWORK failure on the Instagram leg keeps the reservation', async () => {
  const f = hfix(); f.publishIg = async () => { throw new Error('socket hang up'); }; await handle('bpa post B1 now', f);
  assert.deepEqual(rows(f.ledgerPath).map((r) => r.id), ['B1']); assert.equal(loadQueue(f.queuePath).drafts[0].ig.status, 'failed');
});

// ── 8. post now with the cap reached: the Instagram leg is queued for the next free day ──
test('8: post now with the daily cap reached queues the Instagram leg and says so', async () => {
  const f = hfix(); reserveInstagramPublish({ id: 'B0', now: new Date(), path: f.ledgerPath, config: {} }); let ig = 0; f.publishIg = async () => { ig++; return {}; };
  const out = await handle('bpa post B1 now', f); const d = loadQueue(f.queuePath).drafts[0];
  assert.equal(ig, 0); assert.equal(d.status, 'posted'); assert.equal(d.ig.status, 'queued'); assert.ok(!Number.isNaN(Date.parse(d.ig.at)));
  assert.match(out, /Instagram not posted: daily cap 1 reached.*It is queued; the worker will post it on the next free day\./);
});

// ── 6. the stale ledger lock is broken by atomic rename, so two contenders cannot both steal it ──
test('6: six processes against a stale lock: exactly one reservation passes, and no .stale or .lock file is left', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (let round = 0; round < 4; round++) {
    const d = tmp(); const p = path.join(d, 'l.jsonl'); fs.writeFileSync(p + '.lock', 'dead-owner'); const old = new Date(Date.now() - 120e3); fs.utimesSync(p + '.lock', old, old);
    const code = `import { reserveInstagramPublish } from ${JSON.stringify(path.join(here, 'ledger.js'))}; const r = reserveInstagramPublish({ id: process.argv[1], now: new Date('2026-11-17T06:00:00Z'), path: process.argv[2], config: {} }); console.log(r.ok ? 'PASS' : 'REFUSED');`;
    const run = (id) => new Promise((res, rej) => execFile(process.execPath, ['--input-type=module', '-e', code, id, p], { env: { ...process.env, BPA_QUIET: '1' } }, (e, o) => (e ? rej(e) : res(o.trim()))));
    const out = await Promise.all(['B1', 'B2', 'B3', 'B4', 'B5', 'B6'].map(run));
    assert.equal(out.filter((x) => x === 'PASS').length, 1, `round ${round}: ${out}`); assert.deepEqual(fs.readdirSync(d).sort(), ['l.jsonl']);
  }
});
test('6: ledger.js breaks a stale lock with rename (like the queue lock in lib.js), never with a bare unlink of the shared path', () => {
  const s = fs.readFileSync(new URL('./ledger.js', import.meta.url), 'utf8'); assert.match(s, /renameSync\(lockPath/); assert.doesNotMatch(s, /unlinkSync\(lockPath\); continue/);
});
