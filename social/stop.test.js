import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { stopStatus, engageStop, releaseStop, assertNotStopped, StoppedError, stopFlagPath, fleetStopPath } from './stop.js';
import { parseCommand, loadQueue, saveQueue } from './lib.js';
import { runWorker } from './worker.js';
import { runDraft } from './draft.js';
import { handle } from './approval-server.js';

const tmp = (p = 'bpastop-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const paths = () => { const d = tmp(); return { dir: d, flagPath: path.join(d, 'sub', 'bpa-social-stop'), fleetPath: path.join(d, 'fleet', 'stop-all.flag') }; };
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;

test('no flag: not stopped (a missing folder is "no flag", not an error)', () => {
  const p = paths(); assert.deepEqual(stopStatus(p), { stopped: false, reason: null });
});
test('own flag: stopped, reason is "stopped by flag since <mtime>"', () => {
  const p = paths(); fs.mkdirSync(path.dirname(p.flagPath), { recursive: true }); fs.writeFileSync(p.flagPath, 'x');
  const s = stopStatus(p); assert.equal(s.stopped, true); assert.match(s.reason, new RegExp(`^stopped by flag since ${ISO.source}$`));
});
test('fleet stop-all flag also stops', () => {
  const p = paths(); fs.mkdirSync(path.dirname(p.fleetPath), { recursive: true }); fs.writeFileSync(p.fleetPath, '');
  const s = stopStatus(p); assert.equal(s.stopped, true); assert.match(s.reason, /fleet stop-all flag since/);
});
test('unreadable flag directory fails CLOSED (stopped)', { skip: process.getuid?.() === 0 }, () => {
  const p = paths(); const locked = path.join(p.dir, 'locked'); fs.mkdirSync(locked); const flag = path.join(locked, 'bpa-social-stop');
  fs.chmodSync(locked, 0o000);
  try { const s = stopStatus({ ...p, flagPath: flag }); assert.equal(s.stopped, true); assert.match(s.reason, /unreadable.*failing closed/); }
  finally { fs.chmodSync(locked, 0o700); }
});
test('a flag path below a regular file (ENOTDIR) fails closed too', () => {
  const p = paths(); const file = path.join(p.dir, 'afile'); fs.writeFileSync(file, '');
  assert.equal(stopStatus({ ...p, flagPath: path.join(file, 'bpa-social-stop') }).stopped, true);
});
test('assertNotStopped throws StoppedError only when stopped', () => {
  const p = paths(); assert.doesNotThrow(() => assertNotStopped(p)); engageStop(p);
  assert.throws(() => assertNotStopped(p), (e) => e instanceof StoppedError && /stopped by flag since/.test(e.message));
});
test('default paths: env overrides win, and the default is under ~/.matlai', () => {
  assert.equal(stopFlagPath({ BPA_STOP_FLAG: '/x/f' }), '/x/f'); assert.equal(stopFlagPath({ BPA_STATE_DIR: '/x' }), '/x/bpa-social-stop');
  assert.equal(stopFlagPath({}), path.join(os.homedir(), '.matlai', 'bpa-social-stop'));
  assert.equal(fleetStopPath({ STOP_ALL_FLAG_PATH: '/y' }), '/y'); assert.match(fleetStopPath({}), /\.matlai\/stop-all\.flag$/);
});
test('bpa stop / bpa start parse', () => { assert.equal(parseCommand('bpa stop').cmd, 'stop'); assert.equal(parseCommand('BPA start').cmd, 'start'); });
test('bpa stop then bpa start round trip through the approval handler, one reply line each', async () => {
  const p = paths(); const deps = { stopOpts: p, queuePath: path.join(p.dir, 'q.json') };
  const a = await handle('bpa stop', deps); assert.equal(a.split('\n').length, 1); assert.equal(stopStatus(p).stopped, true);
  const again = await handle('bpa stop', deps); assert.match(again, /already stopped since/);
  const b = await handle('bpa start', deps); assert.equal(b.split('\n').length, 1); assert.equal(stopStatus(p).stopped, false);
  assert.match(await handle('bpa start', deps), /was not stopped/);
});
test('bpa start says so when the fleet-wide flag still holds', async () => {
  const p = paths(); fs.mkdirSync(path.dirname(p.fleetPath), { recursive: true }); fs.writeFileSync(p.fleetPath, '');
  engageStop(p); assert.match(releaseStop(p), /still stopped by fleet stop-all flag/);
});

// ── the worker ───────────────────────────────────────────────────────────────
function workerFixture() {
  const p = paths(); const queuePath = path.join(p.dir, 'queue.json');
  saveQueue({ seq: 1, drafts: [{ id: 'B1', status: 'scheduled', kind: 'signal', text: 'x', sourceDate: '2026-11-01', scheduledFor: '2026-11-02T09:00:00+03:00', ig: { status: 'queued', at: '2026-11-02T09:00:00+03:00' } }] }, queuePath);
  const calls = { ig: 0, notify: 0, lines: [] };
  const deps = { now: new Date('2026-11-17T10:00:00Z'), queuePath, stopOpts: p, igOn: () => true, publishIg: async () => { calls.ig++; return { permalink: 'https://example.invalid/p/1' }; },
    postStatus: async () => ({ is_published: false }), notify: async () => { calls.notify++; return true; }, say: (m) => calls.lines.push(m), approvalHealth: async () => ({ ok: true }),
    ledgerPath: path.join(p.dir, 'ledger.jsonl'), runStatePath: path.join(p.dir, 'run.json'), lastPostPath: path.join(p.dir, 'lastpost.json') };
  return { p, deps, calls, queuePath };
}
test('worker with the stop flag: the publisher is never called, one "stopped by flag since" line, exit code 0, queue untouched', async () => {
  const { p, deps, calls, queuePath } = workerFixture(); engageStop(p);
  const before = fs.readFileSync(queuePath, 'utf8');
  const r = await runWorker(deps);
  assert.equal(calls.ig, 0); assert.equal(r.exitCode, 0); assert.equal(r.stopped, true);
  assert.equal(calls.lines.length, 1); assert.match(calls.lines[0], /stopped by flag since \d{4}-/);
  assert.equal(fs.readFileSync(queuePath, 'utf8'), before, 'a stopped worker must not touch the queue');
});
test('worker without the flag: the publisher is called exactly once', async () => {
  const { deps, calls } = workerFixture(); const r = await runWorker(deps);
  assert.equal(calls.ig, 1); assert.equal(r.exitCode, 0); assert.equal(r.stopped, false);
});
test('flag set mid-run (between two checks): the publisher is not called', async () => {
  const { p, deps, calls } = workerFixture(); let n = 0; const real = deps.stopOpts;
  deps.stop = () => (++n >= 2 ? { stopped: true, reason: 'stopped by flag since 2026-11-17T10:00:00.000Z' } : stopStatus(real));
  await runWorker(deps); assert.equal(calls.ig, 0);
});
test('worker with an unreadable flag directory: stopped (fail closed)', { skip: process.getuid?.() === 0 }, async () => {
  const { p, deps, calls } = workerFixture(); const locked = path.join(p.dir, 'locked'); fs.mkdirSync(locked); fs.chmodSync(locked, 0o000);
  try { deps.stopOpts = { ...p, flagPath: path.join(locked, 'bpa-social-stop') }; const r = await runWorker(deps); assert.equal(r.stopped, true); assert.equal(calls.ig, 0); }
  finally { fs.chmodSync(locked, 0o700); }
});

// ── the drafting job ──────────────────────────────────────────────────────────
test('draft job with the flag drafts nothing, sends nothing, logs one line, exit code 0', async () => {
  const p = paths(); engageStop(p); const lines = []; let built = 0, sent = 0;
  const r = await runDraft({ stopOpts: p, say: (m) => lines.push(m), buildDrafts: async () => { built++; return []; }, notify: async () => { sent++; return true; }, queuePath: path.join(p.dir, 'q.json'), readBriefs: () => [] });
  assert.equal(built, 0); assert.equal(sent, 0); assert.equal(r.exitCode, 0); assert.equal(lines.length, 1); assert.match(lines[0], /stopped by flag since/);
  assert.equal(fs.existsSync(path.join(p.dir, 'q.json')), false);
});
test('draft job without the flag runs', async () => {
  const p = paths(); let built = 0; const r = await runDraft({ stopOpts: p, say: () => {}, buildDrafts: async () => { built++; return []; }, notify: async () => true, queuePath: path.join(p.dir, 'q.json'), readBriefs: () => [] });
  assert.equal(built, 1); assert.equal(r.exitCode, 0);
});

// ── every path to a publish or schedule call passes the stop check (behaviour, not a name search) ──
const read = (f) => fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
function bodyOf(src, name) {
  const re = new RegExp(`^export (?:async )?function ${name}\\b`, 'm'); const m = re.exec(src); assert.ok(m, `lib.js must define ${name}`);
  const rest = src.slice(m.index + 1); const next = rest.search(/\n(?:export |async function |function |const |let |\/\/ ──|\/\*\*)/);
  return rest.slice(0, next === -1 ? undefined : next);
}
test('every lib.js function that calls createPost or media_publish contains assertNotStopped (call sites counted, not just named)', () => {
  const src = read('lib.js'); const names = [...src.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
  const publishing = names.filter((n) => /createPost\(|media_publish/.test(bodyOf(src, n)));
  assert.deepEqual(publishing.sort(), ['igPublish', 'igPublishCarousel', 'igPublishReel', 'publishNow', 'schedulePost'], 'the set of functions that reach a publish call changed: review each for the stop check');
  for (const n of [...publishing, 'igPostDraftAny']) assert.match(bodyOf(src, n), /assertNotStopped\(/, `${n} reaches a publish call without the stop check`);
});
test('no source file other than lib.js, worker.js and approval-server.js calls a publish function', () => {
  const dir = path.dirname(new URL(import.meta.url).pathname);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && !x.endsWith('.test.js') && !['lib.js', 'worker.js', 'approval-server.js'].includes(x))) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /\b(schedulePost|publishNow|igPostDraftAny|igPostDraft|igPublish\w*)\s*\(/, `${f} calls a publish function outside the audited callers`);
  }
});
const pend = () => ({ id: 'B1', status: 'pending_approval', kind: 'outlook', text: 'Outlook text with no figures', sourceDate: '2026-11-17' });
function hdeps(flagged) {
  const p = paths(); const queuePath = path.join(p.dir, 'q.json'); saveQueue({ seq: 1, drafts: [pend()] }, queuePath); if (flagged) engageStop(p);
  const calls = { schedule: 0, publish: 0, publishIg: 0 };
  return { calls, queuePath, deps: { queuePath, stopOpts: p, igOn: () => true, config: {}, ledgerPath: path.join(p.dir, 'l.jsonl'), lastPostPath: path.join(p.dir, 'lp.json'),
    schedule: async () => { calls.schedule++; return { id: 'p1' }; }, publish: async () => { calls.publish++; return { id: 'p1', permalink_url: 'https://example.invalid/p1' }; }, publishIg: async () => { calls.publishIg++; return { permalink: 'https://example.invalid/i1' }; } } };
}
test('handle: with the stop flag, approve and post-now call none of schedule/publish/publishIg and reply with the refusal', async () => {
  for (const cmd of ['bpa approve B1', 'bpa post B1 now']) {
    const { calls, deps, queuePath } = hdeps(true); const out = await handle(cmd, deps);
    assert.deepEqual(calls, { schedule: 0, publish: 0, publishIg: 0 }, cmd); assert.match(out, /^⏸ B1: stopped by flag since/, cmd); assert.equal(loadQueue(queuePath).drafts[0].status, 'pending_approval');
  }
});
test('handle: without the flag, approve schedules and post-now publishes (so the test above can fail)', async () => {
  { const { calls, deps } = hdeps(false); await handle('bpa approve B1', deps); assert.equal(calls.schedule, 1); assert.equal(calls.publish, 0); }
  { const { calls, deps } = hdeps(false); await handle('bpa post B1 now', deps); assert.equal(calls.publish, 1); assert.equal(calls.publishIg, 1); }
});
test('the backstop inside lib.js: with the flag set, the REAL schedulePost/publishNow/igPostDraftAny/igPublish* reach no network and throw StoppedError', async () => {
  const lib = await import('./lib.js'); const flag = process.env.BPA_STOP_FLAG; const realFetch = globalThis.fetch; let fetched = 0;
  fs.mkdirSync(path.dirname(flag), { recursive: true }); fs.writeFileSync(flag, 'x'); globalThis.fetch = () => { fetched++; throw new Error('network must not be reached'); };
  try {
    const d = { id: 'B1', kind: 'signal', text: 'x', sourceDate: '2026-11-17' };
    for (const call of [() => lib.schedulePost('x', '2026-11-18T09:00:00+03:00'), () => lib.publishNow('x'), () => lib.igPostDraftAny(d), () => lib.igPublish('c', 'https://example.invalid/i.png'), () => lib.igPublishReel('c', 'https://example.invalid/v.mp4'), () => lib.igPublishCarousel('c', ['https://example.invalid/1.png', 'https://example.invalid/2.png'])]) {
      await assert.rejects(Promise.resolve().then(call), (e) => e instanceof StoppedError);
    }
    assert.equal(fetched, 0);
  } finally { globalThis.fetch = realFetch; fs.unlinkSync(flag); }
});

test('engaged flags carry the time and which flag; the unreadable case has no time', () => {
  const p = paths(); fs.mkdirSync(path.dirname(p.flagPath), { recursive: true }); fs.writeFileSync(p.flagPath, 'x');
  const s = stopStatus(p); assert.deepEqual(s, { stopped: true, reason: `stopped by flag since ${s.since}`, since: s.since, by: 'own' }); assert.match(s.since, new RegExp(`^${ISO.source}$`));
  const q = paths(); fs.mkdirSync(path.dirname(q.fleetPath), { recursive: true }); fs.writeFileSync(q.fleetPath, '');
  const f = stopStatus(q); assert.equal(f.by, 'fleet'); assert.match(f.since, new RegExp(`^${ISO.source}$`));
  const file = path.join(q.dir, 'afile'); fs.writeFileSync(file, ''); const u = stopStatus({ ...q, flagPath: path.join(file, 'x'), fleetPath: q.fleetPath + 'none' });
  assert.equal(u.stopped, true); assert.ok(!('since' in u) && !('by' in u));
});
