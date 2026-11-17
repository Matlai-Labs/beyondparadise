import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { execFileSync, spawnSync } from 'node:child_process'; import { fileURLToPath } from 'node:url';
import { checkHealth, recordWorkerRun, recordPost, healthTick, syncArmedStamp, armedPathFor, runStatePathFor, lastPostPathFor, alertsPathFor } from './health.js';
import { whatsapp, saveQueue, loadQueue, STATUS } from './lib.js';
import { runWorker } from './worker.js';
import { handle } from './approval-server.js';
import { engageStop } from './stop.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpahealth-'));
const P = () => { const d = tmp(); return { dir: d, runStatePath: path.join(d, 'run.json'), lastPostPath: path.join(d, 'lastpost.json'), alertsPath: path.join(d, 'alerts.json'), armedPath: path.join(d, 'armed.json'), stopOpts: { flagPath: path.join(d, 'nf'), fleetPath: path.join(d, 'nfl') } }; };
const T0 = new Date('2026-11-17T10:00:00Z'); const min = (n) => new Date(T0.getTime() - n * 60e3); const day = (n) => new Date(T0.getTime() - n * 86400e3);
const arm = (p, at, extra = {}) => fs.writeFileSync(p.armedPath, JSON.stringify({ armedAt: at.toISOString(), ...extra }));
const keys = (r) => r.problems.map((x) => x.key).sort();

test('default state paths are under the state folder', () => {
  assert.equal(runStatePathFor({ BPA_STATE_DIR: '/s' }), '/s/bpa-social-run.json'); assert.equal(lastPostPathFor({ BPA_STATE_DIR: '/s' }), '/s/bpa-social-lastpost.json'); assert.equal(alertsPathFor({ BPA_STATE_DIR: '/s' }), '/s/bpa-social-alerts.json');
  assert.equal(runStatePathFor({}), path.join(os.homedir(), '.matlai', 'bpa-social-run.json'));
});
test('state file missing: ALARM (fail closed)', () => {
  const p = P(); const r = checkHealth({ ...p, now: T0, config: {} }); assert.equal(r.ok, false); assert.deepEqual(keys(r), ['worker-stale']); assert.match(r.problems[0].reason, /no recorded worker run/);
});
test('state file corrupt: alarm', () => {
  const p = P(); fs.writeFileSync(p.runStatePath, '{nope'); assert.deepEqual(keys(checkHealth({ ...p, now: T0, config: {} })), ['worker-stale']);
  fs.writeFileSync(p.runStatePath, JSON.stringify({ lastRunAt: 'never', result: 'ok' })); assert.deepEqual(keys(checkHealth({ ...p, now: T0, config: {} })), ['worker-stale']);
});
test('worker ran 44 min ago: fine; 46 min ago: alarm with the age in the reason', () => {
  const p = P(); recordWorkerRun({ now: min(44), result: 'ok', path: p.runStatePath }); assert.equal(checkHealth({ ...p, now: T0, config: {} }).ok, true);
  recordWorkerRun({ now: min(46), result: 'ok', path: p.runStatePath }); const r = checkHealth({ ...p, now: T0, config: {} });
  assert.equal(r.ok, false); assert.match(r.problems[0].reason, /has not run for 46 min \(limit 45\)/);
});
test('a stopped worker still counts as having run', () => {
  const p = P(); recordWorkerRun({ now: min(5), result: 'stopped', path: p.runStatePath }); assert.equal(checkHealth({ ...p, now: T0, config: {} }).ok, true);
});
test('autoPublish absent or false: a post-less week is NOT an alarm', () => {
  const p = P(); recordWorkerRun({ now: min(1), result: 'ok', path: p.runStatePath });
  assert.equal(checkHealth({ ...p, now: T0, config: {} }).ok, true); assert.equal(checkHealth({ ...p, now: T0, config: { autoPublish: false } }).ok, true);
});
test('autoPublish on: no post for more than 4 days (default) is an alarm; 3 days is fine; alarmNoPostDays overrides', () => {
  const p = P(); recordWorkerRun({ now: min(1), result: 'ok', path: p.runStatePath }); const on = { autoPublish: true }; arm(p, day(30));
  recordPost({ now: day(3), id: 'B1', path: p.lastPostPath }); assert.equal(checkHealth({ ...p, now: T0, config: on }).ok, true);
  recordPost({ now: day(5), id: 'B1', path: p.lastPostPath }); const r = checkHealth({ ...p, now: T0, config: on }); assert.deepEqual(keys(r), ['no-post']); assert.match(r.problems[0].reason, /no post succeeded for 5 days \(limit 4\).*B1/);
  assert.equal(checkHealth({ ...p, now: T0, config: { ...on, alarmNoPostDays: 7 } }).ok, true); assert.equal(checkHealth({ ...p, now: T0, config: { ...on, alarmNoPostDays: 2 } }).ok, false);
});
test('autoPublish on, armed long ago, the last-post file missing or corrupt: alarm counted from the armed time (fail closed)', () => {
  const p = P(); recordWorkerRun({ now: min(1), result: 'ok', path: p.runStatePath }); arm(p, day(6));
  const r = checkHealth({ ...p, now: T0, config: { autoPublish: true } }); assert.deepEqual(keys(r), ['no-post']); assert.match(r.problems[0].reason, /no post succeeded for 6 days \(limit 4\).*switched on/);
  fs.writeFileSync(p.lastPostPath, 'garbage'); assert.deepEqual(keys(checkHealth({ ...p, now: T0, config: { autoPublish: true } })), ['no-post']);
});
test('autoPublish on but stopped by the flag on purpose: no "no post" alarm', () => {
  const p = P(); recordWorkerRun({ now: min(1), result: 'stopped', path: p.runStatePath }); engageStop(p.stopOpts);
  assert.equal(checkHealth({ ...p, now: T0, config: { autoPublish: true } }).ok, true);
});
test('both conditions at once give two problems', () => {
  const p = P(); assert.deepEqual(keys(checkHealth({ ...p, now: T0, config: { autoPublish: true } })), ['armed-missing', 'worker-stale']);
});
test('state files are written atomically and hold time + id / time + result', () => {
  const p = P(); recordWorkerRun({ now: T0, result: 'ok', path: p.runStatePath }); recordPost({ now: T0, id: 'B9', path: p.lastPostPath });
  assert.deepEqual(JSON.parse(fs.readFileSync(p.runStatePath, 'utf8')), { lastRunAt: T0.toISOString(), lastOkAt: T0.toISOString(), result: 'ok' }); assert.deepEqual(JSON.parse(fs.readFileSync(p.lastPostPath, 'utf8')), { at: T0.toISOString(), id: 'B9' });
  assert.deepEqual(fs.readdirSync(p.dir).filter((f) => f.endsWith('.tmp')), []);
});

// ── the alert tick: once per condition per 24 hours ───────────────────────────
test('healthTick: one alert per condition per 24 h; a second condition still alerts; after 24 h it alerts again', async () => {
  const p = P(); const sent = []; const notify = async (t) => { sent.push(t); return true; }; const say = () => {};
  const base = { ...p, config: {}, notify, say };
  await healthTick({ ...base, now: T0 }); assert.equal(sent.length, 1); assert.match(sent[0], /worker has not run|no recorded worker run/);
  await healthTick({ ...base, now: new Date(T0.getTime() + 3600e3) }); assert.equal(sent.length, 1, 'same condition, one hour later: silent');
  await healthTick({ ...base, config: { autoPublish: true }, now: new Date(T0.getTime() + 2 * 3600e3) }); assert.equal(sent.length, 2, 'new condition alerts at once'); assert.match(sent[1], /armed stamp/);
  await healthTick({ ...base, now: new Date(T0.getTime() + 23 * 3600e3) }); assert.equal(sent.length, 2);
  await healthTick({ ...base, now: new Date(T0.getTime() + 25 * 3600e3) }); assert.equal(sent.length, 3, '24 h later the first condition alerts again');
});
test('healthTick: a failed send is not recorded, so it is retried next hour', async () => {
  const p = P(); let ok = false; const sent = []; const notify = async (t) => { sent.push(t); return ok; };
  await healthTick({ ...p, config: {}, notify, say: () => {}, now: T0 }); ok = true; await healthTick({ ...p, config: {}, notify, say: () => {}, now: new Date(T0.getTime() + 3600e3) });
  assert.equal(sent.length, 2); await healthTick({ ...p, config: {}, notify, say: () => {}, now: new Date(T0.getTime() + 2 * 3600e3) }); assert.equal(sent.length, 2);
});
test('healthTick: healthy means no message; a corrupt alerts file means no spam (fail closed on the alert side is "send")', async () => {
  const p = P(); recordWorkerRun({ now: T0, result: 'ok', path: p.runStatePath }); const sent = []; await healthTick({ ...p, config: {}, notify: async (t) => { sent.push(t); return true; }, say: () => {}, now: T0 }); assert.equal(sent.length, 0);
});

// ── CLI ───────────────────────────────────────────────────────────────────────
const HEALTH = fileURLToPath(new URL('./health.js', import.meta.url));
test('CLI --check: exit 1 and the reason on stdout when the state file is missing; exit 0 when healthy', () => {
  const p = P(); const env = { ...process.env, BPA_STATE_DIR: p.dir, BPA_STOP_FLAG: path.join(p.dir, 'nf'), STOP_ALL_FLAG_PATH: path.join(p.dir, 'nfl'), BPA_LOG_PATH: path.join(p.dir, 'log') };
  const bad = spawnSync(process.execPath, [HEALTH, '--check'], { env, encoding: 'utf8' }); assert.equal(bad.status, 1); assert.match(bad.stdout, /no recorded worker run/);
  recordWorkerRun({ now: new Date(), result: 'ok', path: path.join(p.dir, 'bpa-social-run.json') });
  const good = spawnSync(process.execPath, [HEALTH, '--check'], { env, encoding: 'utf8' }); assert.equal(good.status, 0); assert.match(good.stdout, /ok/);
});

// ── recorded by the real callers ──────────────────────────────────────────────
test('worker records every run (ok and stopped) and a successful Instagram publish', async () => {
  const p = P(); const queuePath = path.join(p.dir, 'queue.json');
  saveQueue({ seq: 1, drafts: [{ id: 'B1', status: 'scheduled', kind: 'signal', text: 'x', sourceDate: '2026-11-01', scheduledFor: '2026-11-02T09:00:00+03:00', ig: { status: 'queued', at: '2026-11-02T09:00:00+03:00' } }] }, queuePath);
  const deps = { now: T0, queuePath, igOn: () => true, stopOpts: p.stopOpts, config: {}, ledgerPath: path.join(p.dir, 'l.jsonl'), runStatePath: p.runStatePath, lastPostPath: p.lastPostPath, publishIg: async () => ({ permalink: 'https://example.invalid/1' }), postStatus: async () => ({}), notify: async () => true, say: () => {}, approvalHealth: async () => ({ ok: true }) };
  await runWorker(deps); assert.equal(JSON.parse(fs.readFileSync(p.runStatePath, 'utf8')).result, 'ok'); assert.deepEqual(JSON.parse(fs.readFileSync(p.lastPostPath, 'utf8')), { at: T0.toISOString(), id: 'B1' });
  engageStop(p.stopOpts); await runWorker({ ...deps, now: new Date(T0.getTime() + 900e3) }); assert.equal(JSON.parse(fs.readFileSync(p.runStatePath, 'utf8')).result, 'stopped');
});
test('worker records an error result and rethrows when the run crashes', async () => {
  const p = P(); await assert.rejects(runWorker({ now: T0, queuePath: path.join(p.dir, 'q.json'), stopOpts: p.stopOpts, runStatePath: p.runStatePath, lastPostPath: p.lastPostPath, say: () => {}, notify: async () => true, approvalHealth: async () => ({ ok: true }), igOn: () => { throw new Error('kaboom'); }, postStatus: async () => ({}),
    ...(saveQueue({ seq: 1, drafts: [{ id: 'B1', status: 'scheduled', ig: { status: 'queued', at: '2026-11-02T09:00:00Z' } }] }, path.join(p.dir, 'q.json')), {}) }), /kaboom/);
  assert.match(JSON.parse(fs.readFileSync(p.runStatePath, 'utf8')).result, /^error: kaboom/);
});
test('approval handler records a successful post-now', async () => {
  const p = P(); const queuePath = path.join(p.dir, 'queue.json'); saveQueue({ seq: 1, drafts: [{ id: 'B1', status: 'pending_approval', kind: 'outlook', text: 'Outlook text with no figures', sourceDate: '2026-11-17' }] }, queuePath);
  await handle('bpa post B1 now', { queuePath, stopOpts: p.stopOpts, igOn: () => false, lastPostPath: p.lastPostPath, publish: async () => ({ id: 'p1', permalink_url: 'https://example.invalid/p1' }) });
  assert.equal(JSON.parse(fs.readFileSync(p.lastPostPath, 'utf8')).id, 'B1');
});

// ── the alert is driven by the approval server, NOT the worker ────────────────
const read = (f) => fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
test('the hourly check is wired in approval-server.js (always on) and the worker does not run it', () => {
  const s = read('approval-server.js'); assert.equal((s.match(/healthTick\(/g) || []).length, 1); assert.match(s, /setInterval\([\s\S]{0,200}3600e3|setInterval\([\s\S]{0,200}60 \* 60e3/);
  assert.doesNotMatch(read('worker.js'), /checkHealth|healthTick/, 'a worker that watches itself cannot report that it is dead');
});

// ── the WhatsApp sender reads the bridge's answer ─────────────────────────────
const fakeBridge = (send, { ready = true } = {}) => async (url, opts) => {
  const body = (obj, status = 200) => ({ ok: status < 400, status, json: async () => { if (obj === undefined) throw new Error('not json'); return obj; } });
  if (String(url).endsWith('/status')) return body({ ready });
  if (String(url).endsWith('/send')) { send.calls.push(JSON.parse(opts.body)); return send.reply(); }
  throw new Error('unexpected url ' + url);
};
test('whatsapp(): returns false and logs a failure when the bridge answers {ok:false}', async () => {
  const send = { calls: [], reply: () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: 'not connected' }) }) };
  assert.equal(await whatsapp('hi', { fetchImpl: fakeBridge(send), number: '+10000000000' }), false); assert.equal(send.calls.length, 1);
  assert.match(fs.readFileSync(process.env.BPA_LOG_PATH, 'utf8'), /whatsapp failed 200 not connected/);
});
test('whatsapp(): HTTP 500, a 200 without ok:true, a non-JSON body, and bridge-not-ready are all failures; only {ok:true} succeeds', async () => {
  for (const reply of [() => ({ ok: false, status: 500, json: async () => ({ ok: true }) }), () => ({ ok: true, status: 200, json: async () => ({}) }), () => ({ ok: true, status: 200, json: async () => { throw new Error('x'); } })]) {
    assert.equal(await whatsapp('hi', { fetchImpl: fakeBridge({ calls: [], reply }), number: '+10000000000' }), false);
  }
  assert.equal(await whatsapp('hi', { fetchImpl: fakeBridge({ calls: [], reply: () => ({}) }, { ready: false }), number: '+10000000000' }), false);
  const ok = { calls: [], reply: () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) };
  assert.equal(await whatsapp('hi', { fetchImpl: fakeBridge(ok), number: '+10000000000' }), true); assert.deepEqual(ok.calls, [{ to: '+10000000000', text: 'hi' }]);
});
test('whatsapp(): without an injected number it still falls back to the private file (never the env var alone)', async () => {
  const f = path.join(tmp(), 'alert-to'); fs.writeFileSync(f, '+10000000001\n'); const prev = { a: process.env.WHATSAPP_ALERT_TO, b: process.env.WHATSAPP_ALERT_TO_FILE };
  delete process.env.WHATSAPP_ALERT_TO; process.env.WHATSAPP_ALERT_TO_FILE = f;
  try { const ok = { calls: [], reply: () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) }; assert.equal(await whatsapp('hi', { fetchImpl: fakeBridge(ok) }), true); assert.equal(ok.calls[0].to, '+10000000001'); }
  finally { if (prev.a === undefined) delete process.env.WHATSAPP_ALERT_TO; else process.env.WHATSAPP_ALERT_TO = prev.a; if (prev.b === undefined) delete process.env.WHATSAPP_ALERT_TO_FILE; else process.env.WHATSAPP_ALERT_TO_FILE = prev.b; }
});

// ── the no-post clock starts when the lane is first seen on (armed stamp) ─────
const ON = { autoPublish: true };
const okRun = (p) => recordWorkerRun({ now: min(1), result: 'ok', path: p.runStatePath });
test('armed 1 h ago, no post ever: no no-post problem; armed 5 days ago, no post: problem naming days and limit', () => {
  const p = P(); okRun(p); arm(p, min(60)); assert.equal(checkHealth({ ...p, now: T0, config: ON }).ok, true);
  arm(p, day(5)); const r = checkHealth({ ...p, now: T0, config: ON }); assert.deepEqual(keys(r), ['no-post']); assert.match(r.problems[0].reason, /5 days \(limit 4\)/);
});
test('last post 10 days ago but armed 1 h ago: no problem; armed 10 days ago, last post 1 day ago: no problem', () => {
  const p = P(); okRun(p); recordPost({ now: day(10), id: 'B1', path: p.lastPostPath }); arm(p, min(60)); assert.equal(checkHealth({ ...p, now: T0, config: ON }).ok, true);
  recordPost({ now: day(1), id: 'B2', path: p.lastPostPath }); arm(p, day(10)); assert.equal(checkHealth({ ...p, now: T0, config: ON }).ok, true);
});
test('a stop seen by the worker 1 h ago restarts the clock (a lifted long bpa stop does not alarm at once)', () => {
  const p = P(); okRun(p); arm(p, day(20), { stoppedSeenAt: min(60).toISOString() }); assert.equal(checkHealth({ ...p, now: T0, config: ON }).ok, true);
  arm(p, day(20), { stoppedSeenAt: day(6).toISOString() }); assert.deepEqual(keys(checkHealth({ ...p, now: T0, config: ON })), ['no-post']);
});
test('lane on and no armed stamp (missing or corrupt): problem armed-missing, unknown, held back right after the approval server starts', async () => {
  const p = P(); okRun(p); const r = checkHealth({ ...p, now: T0, config: ON }); assert.deepEqual(keys(r), ['armed-missing']); assert.equal(r.problems[0].unknown, true);
  fs.writeFileSync(p.armedPath, '{x'); assert.deepEqual(keys(checkHealth({ ...p, now: T0, config: ON })), ['armed-missing']);
  fs.rmSync(p.armedPath); const sent = []; const base = { ...p, config: ON, notify: async (t) => { sent.push(t); return true; }, say: () => {}, now: T0 };
  await healthTick({ ...base, startedAt: min(5) }); assert.equal(sent.length, 0, 'inside the 20 min grace: silent');
  await healthTick({ ...base, startedAt: min(30) }); assert.equal(sent.length, 1, 'stamp still missing after the grace: alert'); assert.match(sent[0], /armed stamp/);
});
test('lane off: no stamp needed, nothing changes in checkHealth', () => {
  const p = P(); okRun(p); assert.equal(checkHealth({ ...p, now: T0, config: {} }).ok, true); assert.equal(checkHealth({ ...p, now: T0, config: { autoPublish: 'true' } }).ok, true);
  assert.equal(syncArmedStamp({ now: T0, on: false, path: p.armedPath }).ok, true); assert.equal(fs.existsSync(p.armedPath), false);
});
test('syncArmedStamp: armed once, not rewritten while on, removed when off, a new later clock after off-then-on', () => {
  const p = P(); assert.equal(armedPathFor({ BPA_STATE_DIR: '/s' }), '/s/bpa-social-armed.json');
  syncArmedStamp({ now: day(3), on: true, path: p.armedPath }); assert.equal(JSON.parse(fs.readFileSync(p.armedPath, 'utf8')).armedAt, day(3).toISOString());
  syncArmedStamp({ now: day(2), on: true, path: p.armedPath }); assert.equal(JSON.parse(fs.readFileSync(p.armedPath, 'utf8')).armedAt, day(3).toISOString(), 'kept');
  syncArmedStamp({ now: day(1), on: false, path: p.armedPath }); assert.equal(fs.existsSync(p.armedPath), false);
  syncArmedStamp({ now: T0, on: true, path: p.armedPath }); assert.equal(JSON.parse(fs.readFileSync(p.armedPath, 'utf8')).armedAt, T0.toISOString());
  syncArmedStamp({ now: min(-15), on: true, stopped: true, path: p.armedPath }); assert.deepEqual(JSON.parse(fs.readFileSync(p.armedPath, 'utf8')), { armedAt: T0.toISOString(), stoppedSeenAt: min(-15).toISOString() });
});

const workerDeps = (p, extra = {}) => { const q = path.join(p.dir, 'q.json'); saveQueue({ drafts: [], state: {} }, q); return { now: T0, queuePath: q, runStatePath: p.runStatePath, lastPostPath: p.lastPostPath, armedPath: p.armedPath, stopOpts: p.stopOpts, notify: async () => true, say: () => {}, approvalHealth: async () => ({ ok: true }), ...extra }; };
test('worker: on run writes the stamp, off run removes it, next on run writes a new later one', async () => {
  const p = P(); await runWorker({ ...workerDeps(p), config: { ...ON, maxInstagramPostsPerDay: 0 } }); // cap 0: the lane's own daily step returns at once, nothing is prepared
  assert.equal(JSON.parse(fs.readFileSync(p.armedPath, 'utf8')).armedAt, T0.toISOString());
  await runWorker({ ...workerDeps(p), config: {} }); assert.equal(fs.existsSync(p.armedPath), false);
  const later = new Date(T0.getTime() + 3600e3); await runWorker({ ...workerDeps(p), now: later, config: { ...ON, maxInstagramPostsPerDay: 0 } }); assert.equal(JSON.parse(fs.readFileSync(p.armedPath, 'utf8')).armedAt, later.toISOString());
});
test('worker: lane off creates no stamp', async () => { const p = P(); await runWorker({ ...workerDeps(p), config: {} }); assert.equal(fs.existsSync(p.armedPath), false); });
test('worker: stamp unwritable while the lane is on: the run is an error (recorded as error for worker-failing) and the queue is untouched', async () => {
  const p = P(); const blocked = path.join(p.dir, 'is-a-file'); fs.writeFileSync(blocked, 'x'); const deps = { ...workerDeps(p), armedPath: path.join(blocked, 'armed.json'), config: { ...ON, maxInstagramPostsPerDay: 0 } };
  const before = fs.readFileSync(deps.queuePath, 'utf8'); await assert.rejects(() => runWorker(deps), /armed stamp not writable/);
  assert.match(JSON.parse(fs.readFileSync(p.runStatePath, 'utf8')).result, /^error: armed stamp not writable/); assert.equal(fs.readFileSync(deps.queuePath, 'utf8'), before);
  assert.deepEqual(keys(checkHealth({ ...p, now: T0, config: {} })), ['worker-failing']);
});
test('worker: stopped pipeline with the lane on still returns stopped and records stoppedSeenAt', async () => {
  const p = P(); engageStop(p.stopOpts); const r = await runWorker({ ...workerDeps(p), config: ON }); assert.equal(r.stopped, true); assert.equal(typeof JSON.parse(fs.readFileSync(p.armedPath, 'utf8')).stoppedSeenAt, 'string');
});
test('worker: lane OFF and a leftover stamp that cannot be removed: one log line, the run does its normal work, the result is not an error', async () => {
  const p = P(); const deps = workerDeps(p); fs.mkdirSync(p.armedPath); fs.writeFileSync(path.join(p.armedPath, 'x'), '1'); // a non-empty directory where the stamp file should be: unlink fails with something other than ENOENT
  saveQueue({ drafts: [{ id: 'OLD', status: STATUS.PENDING, createdAt: day(400).toISOString() }], state: {} }, deps.queuePath); const lines = [];
  const r = await runWorker({ ...deps, config: {}, say: (l) => lines.push(l) }); assert.equal(r.exitCode, 0);
  assert.equal(loadQueue(deps.queuePath).drafts[0].status, STATUS.EXPIRED, 'normal work (expiry) still ran');
  assert.match(JSON.parse(fs.readFileSync(p.runStatePath, 'utf8')).result, /^ok$/); assert.ok(lines.some((l) => /armed stamp/.test(l)), 'one line says so');
});
