import './test-env.js';
// Fix round R12: the "may be at Meta" mark is written to the queue file BEFORE the call to Meta, on every route.
import { test } from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { handle } from './approval-server.js';
import { createDraftActions } from './draft-decisions.js';
import { appendDecision, readDecisions } from './review-decisions.js';
import { draftVersion } from './draft-version.js';
import { saveQueue, loadQueue, nextSlots, parseCommand } from './lib.js';
import { StoppedError } from './stop.js';

const NP = ['examplehotel']; const NOWD = new Date('2026-11-18T10:00:00Z'); const CLEAN = 'Lions sleep most of the day on the plains.';
const LINE = (id) => `⚠️ ${id}: the last try may already have scheduled this post at Meta. Look in Meta first. If no post is there, send: bpa approve ${id} again`;
const LINE_POST = (id) => LINE(id); // the pinned R1 line, byte for byte, in the post-now state too
function kit(over = {}, actionOver = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-r12-')); const queuePath = path.join(dir, 'q.json'); const recordFile = path.join(dir, 'rec.jsonl');
  saveQueue({ seq: 1, drafts: [{ id: 'B1', status: 'pending_approval', kind: 'outlook', text: CLEAN, sourceDate: '2026-11-17', createdAt: '2026-11-17T08:00:00Z' }] }, queuePath);
  const calls = { schedule: 0, publish: 0 }; const mode = { fail: null, seen: [], snap: null, die: false };
  const onDisk = () => loadQueue(queuePath).drafts[0];
  const hook = () => { mode.seen.push(Boolean(onDisk().metaUnknown)); if (mode.die) mode.snap = fs.readFileSync(queuePath); if (mode.fail) throw mode.fail; };
  const schedule = async () => { calls.schedule++; hook(); return { id: 'p1' }; };
  const publish = async () => { calls.publish++; hook(); return { id: 'p9', permalink_url: 'https://example.invalid/p9' }; };
  const stop = () => ({ stopped: false }); const notify = async () => true;
  const deps = { queuePath, stopOpts: { flagPath: path.join(dir, 'f', 'stop'), fleetPath: path.join(dir, 'fleet.flag') }, igOn: () => false, neverPromotePatterns: NP, config: {}, ledgerPath: path.join(dir, 'l.jsonl'), lastPostPath: path.join(dir, 'lp.json'), schedule, publish, notify, ...over };
  const actions = createDraftActions({ queuePath, recordFile, neverPromotePatterns: NP, now: () => NOWD, lockTimeoutMs: 200, schedule, igOn: () => false, stop, notify, approveOn: () => true, ...actionOver });
  const ctx = { record: (r) => appendDecision(recordFile, { ...r, claimedLogin: 'owner@example.com', at: '2026-11-18T10:00:00Z' }), voidRecord: (n) => appendDecision(recordFile, { kind: 'draft', id: 'x', version: null, decision: 'void', ref: n, claimedLogin: 'owner@example.com', at: '2026-11-18T10:00:00Z' }) };
  const pageReq = () => ({ kind: 'draft', id: 'B1', version: draftVersion(onDisk()), action: 'approve', slot: nextSlots(loadQueue(queuePath), 1, NOWD)[0] });
  const die = () => { fs.writeFileSync(queuePath, mode.snap); }; // the process died inside the call: the file is as it was when the call started
  return { calls, mode, deps, actions, ctx, onDisk, pageReq, queuePath, recordFile, die };
}

test('R12 WhatsApp approve: the mark is on disk when schedule starts; a death inside the call leaves it; plain approve and page approve are refused; approve again schedules once', async () => {
  const k = kit(); k.mode.die = true; k.mode.fail = new Error('process died');
  await handle('bpa approve B1', k.deps); assert.deepEqual(k.mode.seen, [true], 'the mark was already on disk inside the call'); k.die(); assert.ok(k.onDisk().metaUnknown); assert.equal(k.onDisk().status, 'pending_approval');
  k.mode.die = false; k.mode.fail = null;
  assert.equal(await handle('bpa approve B1', k.deps), LINE('B1')); assert.deepEqual(await k.actions.approveDraft(k.pageReq(), k.ctx), { ok: false, code: 'check-meta' }); assert.equal(k.calls.schedule, 1);
  assert.match(await handle('bpa approve B1 again', k.deps), /^📅 B1 scheduled/); assert.equal(k.calls.schedule, 2); assert.ok(!('metaUnknown' in k.onDisk())); assert.equal(k.onDisk().status, 'scheduled');
});
test('R12 page approve: the mark is on disk when schedule starts; a death leaves it; WhatsApp then refuses', async () => {
  const k = kit(); k.mode.die = true; k.mode.fail = new Error('process died');
  await k.actions.approveDraft(k.pageReq(), k.ctx); assert.deepEqual(k.mode.seen, [true]); k.die(); k.mode.die = false; k.mode.fail = null;
  assert.equal(await handle('bpa approve B1', k.deps), LINE('B1')); assert.equal(await handle('bpa post B1 now', k.deps), LINE('B1')); assert.equal(k.calls.schedule, 1); assert.equal(k.calls.publish, 0);
});
test('R12 a good schedule leaves no mark on disk, on both routes', async () => {
  const a = kit(); assert.match(await handle('bpa approve B1', a.deps), /^📅/); assert.ok(!('metaUnknown' in a.onDisk())); assert.equal(a.onDisk().status, 'scheduled');
  const b = kit(); assert.equal((await b.actions.approveDraft(b.pageReq(), b.ctx)).ok, true); assert.ok(!('metaUnknown' in b.onDisk())); assert.equal(b.onDisk().status, 'scheduled');
});
test('R12 a stop refusal removes the mark again and persists that (nothing reached Meta), on both routes', async () => {
  const a = kit(); a.mode.fail = new StoppedError('stopped by flag since T1'); assert.match(await handle('bpa approve B1', a.deps), /^⏸ B1: /); assert.deepEqual(a.mode.seen, [true]); assert.ok(!('metaUnknown' in a.onDisk()));
  const b = kit(); b.mode.fail = new StoppedError('stopped by flag since T1'); assert.equal((await b.actions.approveDraft(b.pageReq(), b.ctx)).code, 'stopped'); assert.ok(!('metaUnknown' in b.onDisk()));
});
test('R12 the persist-before step fails: schedule is never called, no mark is left, no record stays (page: write-failed)', async () => {
  const k = kit({}, { save: () => { throw new Error('disk full'); } }); const b = fs.readFileSync(k.queuePath, 'utf8');
  assert.deepEqual(await k.actions.approveDraft(k.pageReq(), k.ctx), { ok: false, code: 'write-failed' }); assert.equal(k.calls.schedule, 0); assert.equal(fs.readFileSync(k.queuePath, 'utf8'), b);
  const l = readDecisions(k.recordFile); assert.equal(l.ok, true); assert.equal(l.records.filter((x) => x.decision === 'approve').length, 0, 'the approve line was voided');
  // WhatsApp: a queue that cannot be written answers what a failed save always answered (the error), and nothing is called
  const w = kit(); fs.mkdirSync(w.queuePath + '.tmp'); const wb = fs.readFileSync(w.queuePath, 'utf8');
  await assert.rejects(handle('bpa approve B1', w.deps)); assert.equal(w.calls.schedule, 0); assert.equal(fs.readFileSync(w.queuePath, 'utf8'), wb);
});
test('R12 post now: the mark is on disk when publish starts; a failed publish leaves it; a plain retry (post now or approve) is refused; post now again publishes once', async () => {
  const k = kit(); k.mode.fail = new Error('boom'); assert.match(await handle('bpa post B1 now', k.deps), /^❌ B1: boom$/); assert.deepEqual(k.mode.seen, [true]); assert.ok(k.onDisk().metaUnknown); assert.equal(k.onDisk().status, 'pending_approval');
  k.mode.fail = null; assert.equal(await handle('bpa post B1 now', k.deps), LINE_POST('B1')); assert.equal(await handle('bpa approve B1', k.deps), LINE('B1')); assert.equal(k.calls.publish, 1); assert.equal(k.calls.schedule, 0);
  const logPath = process.env.BPA_LOG_PATH; const was = fs.readFileSync(logPath, 'utf8').length;
  assert.match(await handle('bpa post B1 now again', k.deps), /^✅ B1 posted now on the Page/); assert.equal(k.calls.publish, 2); assert.ok(!('metaUnknown' in k.onDisk())); assert.equal(k.onDisk().status, 'posted');
  const logged = fs.readFileSync(logPath, 'utf8').slice(was); assert.match(logged, /post now again B1/); assert.ok(!logged.includes('Lions'));
});
test('R12 post now: a success leaves no mark; a stop refusal leaves no mark; again without the mark is refused; the write-ahead failure calls nothing', async () => {
  const a = kit(); assert.match(await handle('bpa post B1 now', a.deps), /^✅/); assert.ok(!('metaUnknown' in a.onDisk()));
  const s = kit(); s.mode.fail = new StoppedError('stopped by flag since T1'); assert.match(await handle('bpa post B1 now', s.deps), /^⏸ B1: /); assert.ok(!('metaUnknown' in s.onDisk()));
  const n = kit(); assert.equal(await handle('bpa post B1 now again', n.deps), '❌ B1: nothing to repeat'); assert.equal(n.calls.publish, 0); assert.equal(await handle('bpa post B9 now again', n.deps), '❌ B9: not found');
  const w = kit(); fs.mkdirSync(w.queuePath + '.tmp'); await assert.rejects(handle('bpa post B1 now', w.deps)); assert.equal(w.calls.publish, 0);
});
test('R12 post now died inside the call: the file as it was at that moment carries the mark', async () => {
  const k = kit(); k.mode.die = true; k.mode.fail = new Error('process died'); await handle('bpa post B1 now', k.deps); k.die(); k.mode.die = false; k.mode.fail = null;
  assert.equal(await handle('bpa post B1 now', k.deps), LINE('B1')); assert.equal(k.calls.publish, 1);
});
test('R12 the command parser: post now again is a new form; the old forms are unchanged', () => {
  assert.deepEqual(parseCommand('bpa post B1 now again'), { cmd: 'postnowagain', ids: ['B1'] }); assert.deepEqual(parseCommand('post b1 NOW  Again'), { cmd: 'postnowagain', ids: ['B1'] });
  assert.deepEqual(parseCommand('bpa post B1 now'), { cmd: 'postnow', ids: ['B1'] }); assert.equal(parseCommand('bpa post B1 again').cmd, 'unknown');
});
