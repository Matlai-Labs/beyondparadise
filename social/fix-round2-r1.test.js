import './test-env.js';
// Fix round R1: one "check Meta first" rule for both routes (the page and the WhatsApp commands).
import { test } from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { handle } from './approval-server.js';
import { createDraftActions } from './draft-decisions.js';
import { appendDecision } from './review-decisions.js';
import { draftVersion } from './draft-version.js';
import { saveQueue, loadQueue, nextSlots, parseCommand } from './lib.js';
import { StoppedError } from './stop.js';

const NP = ['examplehotel']; const NOWD = new Date('2026-11-18T10:00:00Z');
const CLEAN = 'Lions sleep most of the day on the plains.';
const LINE = (id) => `⚠️ ${id}: the last try may already have scheduled this post at Meta. Look in Meta first. If no post is there, send: bpa approve ${id} again`;
function kit(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-r1-')); const queuePath = path.join(dir, 'q.json'); const recordFile = path.join(dir, 'rec.jsonl');
  saveQueue({ seq: 1, drafts: [{ id: 'B1', status: 'pending_approval', kind: 'outlook', text: CLEAN, sourceDate: '2026-11-17', createdAt: '2026-11-17T08:00:00Z' }] }, queuePath);
  const calls = { schedule: 0, publish: 0 }; const mode = { fail: null };
  const schedule = async () => { calls.schedule++; if (mode.fail) throw mode.fail; return { id: 'p1' }; };
  const publish = async () => { calls.publish++; return { id: 'p9', permalink_url: 'https://example.invalid/p9' }; };
  const stop = () => ({ stopped: false }); const notify = async () => true;
  const deps = { queuePath, stopOpts: { flagPath: path.join(dir, 'f', 'stop'), fleetPath: path.join(dir, 'fleet.flag') }, igOn: () => false, neverPromotePatterns: NP, config: {}, ledgerPath: path.join(dir, 'l.jsonl'), lastPostPath: path.join(dir, 'lp.json'), schedule, publish, notify, ...over };
  const actions = createDraftActions({ queuePath, recordFile, neverPromotePatterns: NP, now: () => NOWD, lockTimeoutMs: 200, schedule, igOn: () => false, stop, notify, approveOn: () => true });
  const ctx = { record: (r) => appendDecision(recordFile, { ...r, claimedLogin: 'owner@example.com', at: '2026-11-18T10:00:00Z' }), voidRecord: (n) => appendDecision(recordFile, { kind: 'draft', id: 'x', version: null, decision: 'void', ref: n, claimedLogin: 'owner@example.com', at: '2026-11-18T10:00:00Z' }) };
  const draft = () => loadQueue(queuePath).drafts[0];
  const pageReq = () => ({ kind: 'draft', id: 'B1', version: draftVersion(draft()), action: 'approve', slot: nextSlots(loadQueue(queuePath), 1, NOWD)[0] });
  return { calls, mode, deps, actions, ctx, draft, pageReq, queuePath, recordFile };
}

test('R1 the page approve fails: the WhatsApp approve and post-now are refused with the pinned line, schedule was called once in total', async () => {
  const k = kit(); k.mode.fail = new Error('boom');
  assert.equal((await k.actions.approveDraft(k.pageReq(), k.ctx)).code, 'schedule-failed'); assert.equal(k.calls.schedule, 1);
  k.mode.fail = null;
  assert.equal(await handle('bpa approve B1', k.deps), LINE('B1'));
  assert.equal(await handle('bpa post B1 now', k.deps), LINE('B1'));
  assert.equal(k.calls.schedule, 1); assert.equal(k.calls.publish, 0); assert.equal(k.draft().status, 'pending_approval');
});
test('R1 the WhatsApp approve fails: the draft is marked, the page approve is refused with check-meta, schedule was called once in total', async () => {
  const k = kit(); k.mode.fail = new Error('boom');
  assert.match(await handle('bpa approve B1', k.deps), /^❌ B1: boom$/); assert.ok(k.draft().metaUnknown, 'marked'); assert.equal(k.draft().lastError, 'boom');
  k.mode.fail = null; assert.deepEqual(await k.actions.approveDraft(k.pageReq(), k.ctx), { ok: false, code: 'check-meta' });
  assert.equal(k.calls.schedule, 1); assert.equal(fs.existsSync(k.recordFile) ? fs.readFileSync(k.recordFile, 'utf8') : '', '', 'the page wrote no record');
});
test('R1 a failed WhatsApp approve, then a second WhatsApp approve: refused, schedule once', async () => {
  const k = kit(); k.mode.fail = new Error('timed out'); await handle('bpa approve B1', k.deps); k.mode.fail = null;
  assert.equal(await handle('bpa approve B1', k.deps), LINE('B1')); assert.equal(k.calls.schedule, 1);
});
test('R1 approve B1 again clears the mark, logs closed words, and schedules exactly once with every guard', async () => {
  const k = kit(); k.mode.fail = new Error('boom'); await handle('bpa approve B1', k.deps); k.mode.fail = null;
  const logPath = process.env.BPA_LOG_PATH; const was = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').length : 0;
  const out = await handle('bpa approve B1 again', k.deps); assert.match(out, /^📅 B1 scheduled for \d{4}-\d{2}-\d{2}T09:00 on the Page \(p1\)$/);
  assert.equal(k.calls.schedule, 2); const d = k.draft(); assert.equal(d.status, 'scheduled'); assert.ok(!('metaUnknown' in d));
  const logged = fs.readFileSync(logPath, 'utf8').slice(was); assert.match(logged, /approve again B1/); assert.ok(!logged.includes('Lions'));
});
test('R1 approve B1 again with a stop in force: refused by the normal guards, nothing scheduled', async () => {
  const k = kit(); k.mode.fail = new Error('boom'); await handle('bpa approve B1', k.deps); k.mode.fail = null;
  const out = await handle('bpa approve B1 again', { ...k.deps, stop: () => ({ stopped: true, reason: 'stopped by flag since T1' }) }); assert.match(out, /^⏸ B1: stopped by flag/); assert.equal(k.calls.schedule, 1);
});
test('R1 again on a draft without the mark is refused in plain words and schedules nothing', async () => {
  const k = kit(); assert.equal(await handle('bpa approve B1 again', k.deps), '❌ B1: nothing to repeat'); assert.equal(k.calls.schedule, 0); assert.equal(k.draft().status, 'pending_approval');
  assert.equal(await handle('bpa approve B9 again', k.deps), '❌ B9: not found');
});
test('R1 a stop refusal does not set the mark (nothing reached Meta)', async () => {
  const k = kit(); k.mode.fail = new StoppedError('stopped by flag since T1'); assert.match(await handle('bpa approve B1', k.deps), /^⏸ B1: /);
  assert.ok(!('metaUnknown' in k.draft())); k.mode.fail = null; assert.match(await handle('bpa approve B1', k.deps), /^📅 /);
});
test('R1 the command parser: again is a new form; every other form parses as before', () => {
  assert.deepEqual(parseCommand('bpa approve B1 again'), { cmd: 'approveagain', ids: ['B1'] });
  assert.deepEqual(parseCommand('approve b1  AGAIN'), { cmd: 'approveagain', ids: ['B1'] });
  assert.deepEqual(parseCommand('bpa approve B1 B2'), { cmd: 'approve', ids: ['B1', 'B2'] });
  assert.deepEqual(parseCommand('bpa approve B1'), { cmd: 'approve', ids: ['B1'] });
  assert.equal(parseCommand('bpa approve B1 B2 again').cmd, 'unknown'); assert.equal(parseCommand('bpa skip B1 again').cmd, 'unknown');
  assert.equal(parseCommand('bpa approve again').cmd, 'unknown');
});
