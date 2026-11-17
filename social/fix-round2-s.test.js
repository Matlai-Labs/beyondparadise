import './test-env.js';
// S2: `again` followed by a refusal keeps the mark. S3: three paths that had no test.
import { test } from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { handle } from './approval-server.js';
import { createDraftActions } from './draft-decisions.js';
import { appendDecision } from './review-decisions.js';
import { draftVersion } from './draft-version.js';
import { saveQueue, loadQueue, nextSlots } from './lib.js';
import { StoppedError } from './stop.js';

const NP = ['examplehotel']; const NOWD = new Date('2026-11-18T10:00:00Z');
const TEXTS = { B1: 'Lions sleep most of the day on the plains.', B2: 'Giraffes feed on tall acacia trees.' };
const LINE = (id) => `⚠️ ${id}: the last try may already have scheduled this post at Meta. Look in Meta first. If no post is there, send: bpa approve ${id} again`;
function kit(ids = ['B1'], over = {}, actionOver = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-s-')); const queuePath = path.join(dir, 'q.json'); const recordFile = path.join(dir, 'rec.jsonl');
  saveQueue({ seq: 1, drafts: ids.map((id) => ({ id, status: 'pending_approval', kind: 'outlook', text: TEXTS[id], sourceDate: '2026-11-17', createdAt: '2026-11-17T08:00:00Z' })) }, queuePath);
  const calls = { schedule: [], publish: [] }; const mode = { fail: null, stopped: false, hook: null };
  const schedule = async (text) => { calls.schedule.push(text); if (mode.hook) mode.hook(); if (mode.fail) throw mode.fail; return { id: 'p1' }; };
  const publish = async (text) => { calls.publish.push(text); if (mode.hook) mode.hook(); if (mode.fail) throw mode.fail; return { id: 'p9', permalink_url: 'https://example.invalid/p9' }; };
  const stop = () => (mode.stopped ? { stopped: true, reason: 'stopped by flag since T1' } : { stopped: false });
  const deps = { queuePath, stop, igOn: () => false, neverPromotePatterns: NP, config: {}, ledgerPath: path.join(dir, 'l.jsonl'), lastPostPath: path.join(dir, 'lp.json'), schedule, publish, notify: async () => true, ...over };
  const actions = createDraftActions({ queuePath, recordFile, neverPromotePatterns: NP, now: () => NOWD, lockTimeoutMs: 200, schedule, igOn: () => false, stop, notify: async () => true, approveOn: () => true, ...actionOver });
  const ctx = { record: (r) => appendDecision(recordFile, { ...r, claimedLogin: 'owner@example.com', at: '2026-11-18T10:00:00Z' }), voidRecord: (n) => appendDecision(recordFile, { kind: 'draft', id: 'x', version: null, decision: 'void', ref: n, claimedLogin: 'owner@example.com', at: '2026-11-18T10:00:00Z' }) };
  const onDisk = (id = 'B1') => loadQueue(queuePath).drafts.find((d) => d.id === id);
  const mark = (id = 'B1') => { const q = loadQueue(queuePath); q.drafts.find((d) => d.id === id).metaUnknown = { at: '2026-11-18T09:00:00.000Z' }; saveQueue(q, queuePath); };
  return { calls, mode, deps, actions, ctx, onDisk, mark, queuePath, recordFile, dir, pageReq: () => ({ kind: 'draft', id: 'B1', version: draftVersion(onDisk()), action: 'approve', slot: nextSlots(loadQueue(queuePath), 1, NOWD)[0] }) };
}

for (const [name, again, plain, calls, okLine] of [['approve', 'bpa approve B1 again', 'bpa approve B1', 'schedule', /^📅 B1 scheduled/], ['post now', 'bpa post B1 now again', 'bpa post B1 now', 'publish', /^✅ B1 posted now/]]) {
  test(`S2 ${name}: again while stopped is refused with the stop reply, the mark stays on disk, a plain retry still says look in Meta, after the stop again schedules or posts once`, async () => {
    const k = kit(); k.mark(); k.mode.stopped = true;
    assert.equal(await handle(again, k.deps), '⏸ B1: stopped by flag since T1. Reply *bpa start* to resume.'); assert.ok(k.onDisk().metaUnknown, 'the mark is still on disk'); assert.equal(k.calls[calls].length, 0);
    k.mode.stopped = false; assert.equal(await handle(plain, k.deps), LINE('B1')); assert.equal(k.calls[calls].length, 0);
    assert.match(await handle(again, k.deps), okLine); assert.equal(k.calls[calls].length, 1); assert.ok(!('metaUnknown' in k.onDisk()));
  });
  test(`S2 ${name}: again refused by another guard (blocked by the final check) keeps the mark too; a refusal of a draft that is not pending is untouched`, async () => {
    const k = kit(); k.mark(); const fc = { ...k.deps, notify: async () => true };
    const q = loadQueue(k.queuePath); q.drafts[0].text = 'Book now for big waves today at the beach.'; q.drafts[0].metaUnknown = { at: '2026-11-18T09:00:00.000Z' }; saveQueue(q, k.queuePath);
    const out = await handle(again, fc); assert.match(out, /^🚫 B1 blocked/); assert.equal(k.onDisk().status, 'blocked'); assert.equal(k.calls[calls].length, 0);
    const s = kit(); s.mark(); const sq = loadQueue(s.queuePath); sq.drafts[0].status = 'skipped'; saveQueue(sq, s.queuePath); assert.equal(await handle(again, s.deps), '⚠️ B1 is skipped');
  });
}
test('S2 sabotage target: a failed call after again keeps a fresh mark (not restored over, not lost)', async () => {
  const k = kit(); k.mark(); k.mode.fail = new Error('boom'); assert.match(await handle('bpa approve B1 again', k.deps), /^❌ B1: boom$/); assert.ok(k.onDisk().metaUnknown); assert.equal(k.onDisk().metaUnknown.at !== '2026-11-18T09:00:00.000Z', true, 'a new mark from this try');
});

test('S3.1 the stop-refusal persist failing leaves the mark on disk: page (second save fails) and WhatsApp (queue cannot be written after the first save)', async () => {
  let n = 0; const p = kit(['B1'], {}, { save: (q, f) => { if (n++ >= 1) throw new Error('disk full'); saveQueue(q, f); } }); p.mode.fail = new StoppedError('stopped by flag since T1');
  assert.equal((await p.actions.approveDraft(p.pageReq(), p.ctx)).code, 'stopped'); assert.ok(p.onDisk().metaUnknown, 'the mark stays: fail closed');
  const w = kit(); w.mode.fail = new StoppedError('stopped by flag since T1'); w.mode.hook = () => fs.mkdirSync(w.queuePath + '.tmp');
  await assert.rejects(handle('bpa approve B1', w.deps)); assert.ok(w.onDisk().metaUnknown, 'the mark stays on disk');
});
test('S3.3 WhatsApp: only the FIRST save fails (the write-ahead one) and the final save works: the new line, nothing called for that draft, no mark left; the next draft in the command goes on', async () => {
  const k = kit(['B1', 'B2']); fs.mkdirSync(k.queuePath + '.tmp'); let stops = 0;
  const deps = { ...k.deps, stop: () => { stops++; if (stops === 2) fs.rmdirSync(k.queuePath + '.tmp'); return { stopped: false }; } }; // the second draft's guards run after the blocking directory is gone
  const out = await handle('bpa approve B1 B2', deps);
  const [l1, l2] = out.split('\n'); assert.equal(l1, '❌ B1: the queue could not be saved, so nothing was scheduled.'); assert.match(l2, /^📅 B2 scheduled/);
  assert.deepEqual(k.calls.schedule, [TEXTS.B2], 'schedule was called for B2 only'); assert.equal(k.onDisk('B1').status, 'pending_approval'); assert.ok(!('metaUnknown' in k.onDisk('B1'))); assert.equal(k.onDisk('B2').status, 'scheduled');
  const p = kit(['B1', 'B2']); fs.mkdirSync(p.queuePath + '.tmp'); let s2 = 0;
  const out2 = await handle('bpa post B1 now', { ...p.deps, stop: () => { s2++; return { stopped: false }; } }).catch((e) => e); assert.ok(out2 instanceof Error, 'a queue that stays unwritable still ends in the old error'); assert.equal(p.calls.publish.length, 0);
});
