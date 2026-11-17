import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { createDraftActions } from './draft-decisions.js';
import { appendDecision } from './review-decisions.js';
import { draftVersion } from './draft-version.js';
import { withQueueLock, saveQueue } from './lib.js';
import { withDecisionLock } from './decision-lock.js';
import { StoppedError } from './stop.js';
import { sourcesRecord } from './claim-gate.js';
import { statusCodeOf } from './draft-actions.js';
import { BAD_CHARS, GOOD_TEXTS, EMOJI_OK_TEXTS, EMOJI_BAD_TEXTS } from './review-test-chars.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NP = ['examplehotel'];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-dd-'));
const draft = (id, extra = {}) => ({ id, status: 'pending_approval', kind: 'outlook', text: `Lions sleep most of the day on the plains (${id}).`, sourceDate: '2026-11-17', createdAt: '2026-11-17T08:00:00Z', ...extra });
function kit(drafts = [draft('B1'), draft('B2'), draft('B3')], over = {}) {
  const d = tmp(); const queuePath = path.join(d, 'q.json'); const recordFile = path.join(d, 'rec.jsonl');
  fs.writeFileSync(queuePath, JSON.stringify({ seq: 3, drafts }, null, 2));
  const actions = createDraftActions({ queuePath, recordFile, neverPromotePatterns: NP, now: () => new Date('2026-11-18T10:00:00Z'), lockTimeoutMs: 100, ...over });
  const ctx = { record: (r) => appendDecision(recordFile, { ...r, claimedLogin: 'owner@example.com', at: '2026-11-18T10:00:00Z' }), voidRecord: (n) => appendDecision(recordFile, { kind: 'draft', id: 'x', version: null, decision: 'void', ref: n, claimedLogin: 'owner@example.com', at: '2026-11-18T10:00:00Z' }) };
  return { d, queuePath, recordFile, actions, ctx, bytes: () => fs.readFileSync(queuePath, 'utf8'), q: () => JSON.parse(fs.readFileSync(queuePath, 'utf8')), lines: () => (fs.existsSync(recordFile) && fs.statSync(recordFile).isFile() ? fs.readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) };
}
const ver = (k, id = 'B1') => draftVersion(k.q().drafts.find((x) => x.id === id));
const skipReq = (k, id = 'B1', over = {}) => ({ kind: 'draft', id, version: ver(k, id), action: 'skip', ...over });
const editReq = (k, text, id = 'B1', over = {}) => ({ kind: 'draft', id, version: ver(k, id), action: 'edit', text, ...over });

test('1 skip ok: status skipped, decidedAt, the other drafts byte-identical, one record line with the seen version', async () => {
  const k = kit(); const before = k.q(); const v = ver(k);
  assert.deepEqual(await k.actions.skipDraft(skipReq(k), k.ctx), { ok: true, change: { kind: 'draft', id: 'B1', decision: 'skipped' } });
  const after = k.q(); assert.equal(after.drafts[0].status, 'skipped'); assert.equal(after.drafts[0].decidedAt, '2026-11-18T10:00:00.000Z');
  assert.equal(JSON.stringify(after.drafts.slice(1)), JSON.stringify(before.drafts.slice(1)));
  const l = k.lines(); assert.equal(l.length, 1); assert.deepEqual({ kind: l[0].kind, id: l[0].id, decision: l[0].decision, version: l[0].version }, { kind: 'draft', id: 'B1', decision: 'skip', version: v });
});
test('2 skip refusals write nothing: wrong version, every other status, unknown id, __proto__, constructor, a non-string version', async () => {
  for (const status of ['scheduled', 'posted', 'expired', 'blocked', 'skipped']) {
    const k = kit([draft('B1', { status })]); const b = k.bytes(); const r = await k.actions.skipDraft(skipReq(k), k.ctx);
    assert.deepEqual(r, { ok: false, code: statusCodeOf(status) }, status); assert.equal(k.bytes(), b); assert.equal(k.lines().length, 0);
  }
  const k = kit(); const b = k.bytes();
  const table = [[skipReq(k, 'B1', { version: 'f'.repeat(64) }), 'version-changed'], [skipReq(k, 'B1', { id: 'B9' }), 'not-found'], [skipReq(k, 'B1', { id: '__proto__' }), 'not-found'], [skipReq(k, 'B1', { id: 'constructor' }), 'not-found'], [skipReq(k, 'B1', { version: 7 }), 'bad-request'], [skipReq(k, 'B1', { id: 5 }), 'bad-request']];
  for (const [req, code] of table) assert.deepEqual(await k.actions.skipDraft(req, k.ctx), { ok: false, code }, JSON.stringify(req));
  assert.equal(k.bytes(), b); assert.equal(k.lines().length, 0);
});
test('3 an unreadable queue is refused and not overwritten; a missing queue is unreadable on the page too', async () => {
  const k = kit(); const req = skipReq(k); const ereq = editReq(k, 'New text here.'); fs.writeFileSync(k.queuePath, '{broken');
  assert.deepEqual(await k.actions.skipDraft(req, k.ctx), { ok: false, code: 'queue-unreadable' }); assert.equal(k.bytes(), '{broken');
  assert.deepEqual(await k.actions.editDraft(ereq, k.ctx), { ok: false, code: 'queue-unreadable' }); assert.equal(k.bytes(), '{broken'); assert.equal(k.lines().length, 0);
  const m = kit(); const r2 = skipReq(m); fs.unlinkSync(m.queuePath); assert.deepEqual(await m.actions.skipDraft(r2, m.ctx), { ok: false, code: 'queue-unreadable' }); assert.ok(!fs.existsSync(m.queuePath));
});
test('4 a busy queue lock answers lock-busy within a second and writes nothing', async () => {
  const k = kit(); const b = k.bytes(); const req = skipReq(k); const t0 = Date.now();
  const r = await withQueueLock(async () => k.actions.skipDraft(req, k.ctx), { lockPath: k.queuePath + '.lock' });
  assert.deepEqual(r, { ok: false, code: 'lock-busy' }); assert.ok(Date.now() - t0 < 1000); assert.equal(k.bytes(), b); assert.equal(k.lines().length, 0);
});
test('5 a record that cannot be written changes nothing; a save that fails voids the record line', async () => {
  const k = kit(); fs.mkdirSync(k.recordFile); const b = k.bytes();
  assert.deepEqual(await k.actions.skipDraft(skipReq(k), k.ctx), { ok: false, code: 'record-failed' }); assert.equal(k.bytes(), b);
  const s = kit([draft('B1'), draft('B2')], { save: () => { throw new Error('disk full'); } }); const sb = s.bytes();
  assert.deepEqual(await s.actions.skipDraft(skipReq(s), s.ctx), { ok: false, code: 'write-failed' }); assert.equal(s.bytes(), sb);
  const l = s.lines(); assert.equal(l.length, 2); assert.equal(l[0].decision, 'skip'); assert.equal(l[1].decision, 'void'); assert.equal(l[1].ref, l[0].n);
});
test('6 a double tap and two concurrent skips: exactly one succeeds, the other is already-skipped, one record line', async () => {
  const k = kit(); const req = skipReq(k); const [a, b] = await Promise.all([k.actions.skipDraft(req, k.ctx), k.actions.skipDraft(req, k.ctx)]);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]); assert.equal([a, b].find((x) => !x.ok).code, 'already-skipped'); assert.equal(k.lines().length, 1);
  assert.equal((await k.actions.skipDraft(req, k.ctx)).code, 'already-skipped'); assert.equal(k.lines().length, 1);
});
test('7 edit ok: new text with its line feed, claim fields gone, editedAt, new version recorded', async () => {
  const k = kit([draft('B1', { claimSources: [{}], claimSourcesHash: 'h', claimSourcesAt: 't' }), draft('B2')]); const old = ver(k); const text = 'Giraffes feed on tall acacia trees.\nThey are gentle.';
  assert.deepEqual(await k.actions.editDraft(editReq(k, `  ${text}  `), k.ctx), { ok: true, change: { kind: 'draft', id: 'B1', decision: 'edited' } });
  const d = k.q().drafts[0]; assert.equal(d.text, text); for (const f of ['claimSources', 'claimSourcesHash', 'claimSourcesAt']) assert.ok(!(f in d), f); assert.equal(d.editedAt, '2026-11-18T10:00:00.000Z'); assert.equal(d.status, 'pending_approval');
  const l = k.lines(); assert.equal(l.length, 1); assert.equal(l[0].decision, 'edit'); assert.equal(l[0].version, draftVersion(d)); assert.notEqual(l[0].version, old);
});
test('8 edit refusals write nothing; the character rules', async () => {
  const claims = [{ text: 'Lions sleep up to 20 hours a day' }];
  const k = kit([draft('B1', { claims }), draft('B2')]); const b = k.bytes();
  const table = [[k.q().drafts[0].text, 'no-change'], ['Beyond Paradise is lovely.', 'brand-rule'], ['Let us delve into a rich tapestry of seamless synergy. It is a game-changer!', 'voice-rule'], ['Book now for big waves today at the beach.', 'rules'], ['Lions sleep about 22 hours a day.', 'number-not-in-facts'], ['x'.repeat(2001), 'bad-request'], ['', 'bad-request'], ['   ', 'bad-request'], [5, 'bad-request']];
  for (const [text, code] of table) assert.deepEqual(await k.actions.editDraft(editReq(k, text), k.ctx), { ok: false, code }, String(text).slice(0, 40));
  for (const c of [...BAD_CHARS, '\r', '\u0085', ' ', ' ']) assert.deepEqual(await k.actions.editDraft(editReq(k, `Lions${c}sleep`), k.ctx), { ok: false, code: 'bad-characters' }, 'U+' + c.codePointAt(0).toString(16));
  for (const t of EMOJI_BAD_TEXTS) assert.equal((await k.actions.editDraft(editReq(k, t), k.ctx)).code, 'bad-characters', t);
  assert.equal(k.bytes(), b); assert.equal(k.lines().length, 0);
  const g = kit(); for (const t of [...GOOD_TEXTS, ...EMOJI_OK_TEXTS]) { const r = await g.actions.editDraft(editReq(g, t), g.ctx); assert.equal(r.ok, true, t + JSON.stringify(r)); }
});
test('9 static: one lock call each, order check then record then apply, no publisher, no writes by assignment, no default queuePath', () => {
  const s = fs.readFileSync(path.join(HERE, 'draft-decisions.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const n = (re) => (s.match(re) || []).length;
  assert.equal(n(/withQueueLock\(/g), 1); assert.equal(n(/withDecisionLock\(/g), 1);
  const sections = s.split('return queueLocked(').slice(1).map((x) => x.split(/\n  async function |\n  return \{/)[0]); assert.ok(sections.length >= 2);
  for (const sec of sections) { assert.ok(sec.includes('recordLocked('), 'a draft section records'); assert.ok(!sec.includes('withQueueLock(')); }
  for (const w of ['schedulePost', 'publishNow', 'igPostDraftAny', 'autoPublish', 'config.json', 'fetch(']) assert.ok(!s.includes(w), w);
  assert.equal(n(/\bapplyEdit\(/g), 1); assert.equal(n(/\bapplySkip\(/g), 1); assert.equal(n(/\bcheckEdit\(/g), 1); assert.equal(n(/\bcheckSkip\(/g), 1);
  const skip = sections.find((x) => x.includes('applySkip(')); assert.ok(skip.indexOf('checkSkip(') < skip.indexOf('recordLocked(') && skip.indexOf('recordLocked(') < skip.indexOf('applySkip('), 'skip: check, record, apply');
  const edit = sections.find((x) => x.includes('applyEdit(')); assert.ok(edit.indexOf('checkEdit(') < edit.indexOf('applyEdit(') && edit.indexOf('applyEdit(') < edit.indexOf('recordLocked(') && edit.indexOf('recordLocked(') < edit.indexOf('drafts[o.i] = nd'), 'edit: check, apply on the copy, record, then the real draft is replaced');
  assert.match(edit, /structuredClone\(o\.d\)/); assert.match(edit, /applyEdit\(nd,/);
  assert.ok(!/\[req\.id\]|\[body\.id\]/.test(s)); assert.ok(!/\.drafts\s*=[^=]/.test(s)); assert.ok(!/\.text\s*=[^=]/.test(s)); assert.ok(!/queuePath\s*=[^=]/.test(s), 'no default for queuePath');
  assert.ok(s.includes("Object.hasOwn(options, 'neverPromotePatterns')"));
});
test('9b a function without queuePath, recordFile or the neverPromotePatterns key answers check-failed and touches nothing; the key with value undefined is accepted', async () => {
  const k = kit(); const b = k.bytes(); const req = skipReq(k);
  for (const opts of [{ recordFile: k.recordFile, neverPromotePatterns: NP }, { queuePath: k.queuePath, neverPromotePatterns: NP }, { queuePath: k.queuePath, recordFile: k.recordFile }, { queuePath: '', recordFile: k.recordFile, neverPromotePatterns: NP }]) {
    const a = createDraftActions(opts); assert.deepEqual(await a.skipDraft(req, k.ctx), { ok: false, code: 'check-failed' }); assert.deepEqual(await a.editDraft(editReq(k, 'New text here.'), k.ctx), { ok: false, code: 'check-failed' }); assert.deepEqual(await a.approveDraft(req, k.ctx), { ok: false, code: 'check-failed' });
  }
  assert.equal(k.bytes(), b); assert.equal(k.lines().length, 0);
  const u = createDraftActions({ queuePath: k.queuePath, recordFile: k.recordFile, neverPromotePatterns: undefined }); assert.equal((await u.skipDraft(req, k.ctx)).ok, true);
});

// ══ Task 9: Approve of a draft. EVERYTHING that leaves the process is injected and counted. ═══════════════════════════════
const NOWT = new Date('2026-11-18T10:00:00Z'); const LOGF = process.env.BPA_LOG_PATH;
const SEA = 'Book now for big waves today at the beach.';
const src = (host, n = 1) => ({ claim: 'x', source: `Site ${n}`, url: `https://${host}/p`, line: `exact line quoted from page ${n}` });
function ak(drafts = [draft('B1', { createdAt: '2026-11-17T08:00:00Z' }), draft('B2', { createdAt: '2026-11-17T08:00:00Z' })], over = {}) {
  const calls = { schedule: [], stop: 0, notify: [], igOn: 0, approveOn: 0, finalCheck: 0 };
  const k = kit(drafts); const opts = {
    queuePath: k.queuePath, recordFile: k.recordFile, neverPromotePatterns: NP, now: () => NOWT, lockTimeoutMs: 200,
    schedule: async (text, at) => { calls.schedule.push([text, at]); return { id: 'p1' }; }, stop: () => { calls.stop++; return { stopped: false }; },
    igOn: () => { calls.igOn++; return false; }, notify: async (m) => { calls.notify.push(m); return true; }, approveOn: () => { calls.approveOn++; return true; }, ...over };
  const actions = createDraftActions(opts); const req = (id = 'B1', o = {}) => ({ kind: 'draft', id, version: ver(k, id), action: 'approve', ...o });
  return { ...k, actions, calls, opts, req, approve: (r, c = k.ctx) => actions.approveDraft(r ?? req(), c) };
}
const logLines = (was) => (fs.existsSync(LOGF) ? fs.readFileSync(LOGF, 'utf8').slice(was).split('\n').filter(Boolean) : []);
const logSize = () => (fs.existsSync(LOGF) ? fs.readFileSync(LOGF, 'utf8').length : 0);
const nothingHappened = (k, bytes) => { assert.equal(k.calls.schedule.length, 0, 'schedule not called'); assert.equal(k.bytes(), bytes, 'queue unchanged'); assert.equal(k.lines().length, 0, 'no record line'); };

test('A1 approve ok: one schedule call with the text and a 09:00 slot, state saved, one approve record, the time in words; igOn adds the queued leg', async () => {
  const k = ak(); const v = ver(k); const r = await k.approve();
  assert.equal(r.ok, true); assert.deepEqual(r.change, { kind: 'draft', id: 'B1', decision: 'scheduled' }); assert.match(r.scheduledFor, /^\d{4}-\d{2}-\d{2}T09:00:00\+03:00$/); assert.match(r.scheduledForText, /^\d{1,2} \w{3} at 09:00 \(East Africa time\)$/);
  assert.equal(k.calls.schedule.length, 1); assert.equal(k.calls.schedule[0][0], k.q().drafts[0].text); assert.equal(k.calls.schedule[0][1], r.scheduledFor);
  const d = k.q().drafts[0]; assert.equal(d.status, 'scheduled'); assert.equal(d.postId, 'p1'); assert.equal(d.scheduledFor, r.scheduledFor); assert.equal(d.decidedAt, '2026-11-18T10:00:00.000Z'); assert.ok(!('ig' in d));
  const l = k.lines(); assert.equal(l.length, 1); assert.deepEqual({ kind: l[0].kind, decision: l[0].decision, version: l[0].version }, { kind: 'draft', decision: 'approve', version: v });
  const i = ak(undefined, { igOn: () => true }); const ri = await i.approve(); assert.deepEqual(i.q().drafts[0].ig, { status: 'queued', at: ri.scheduledFor });
});
test('A2 nothing is scheduled or recorded: wrong version, every status, unknown id, stop, sources, unreadable queue, expired, hidden characters', async () => {
  { const k = ak(); const b = k.bytes(); assert.deepEqual(await k.approve(k.req('B1', { version: 'f'.repeat(64) })), { ok: false, code: 'version-changed' }); nothingHappened(k, b); }
  for (const status of ['scheduled', 'posted', 'expired', 'blocked', 'skipped', 'failed']) { const k = ak([draft('B1', { status })]); const b = k.bytes(); assert.deepEqual(await k.approve(), { ok: false, code: statusCodeOf(status) }, status); nothingHappened(k, b); }
  for (const id of ['B9', '__proto__', 'constructor']) { const k = ak(); const b = k.bytes(); assert.deepEqual(await k.approve(k.req('B1', { id })), { ok: false, code: 'not-found' }, id); nothingHappened(k, b); }
  { const k = ak(undefined, { stop: () => ({ stopped: true, reason: 'stopped by flag since T1' }) }); const b = k.bytes(); assert.deepEqual(await k.approve(), { ok: false, code: 'stopped' }); nothingHappened(k, b); }
  const T = 'A resort on Muyuni Beach';
  const cases = [[draft('B1', { text: T }), 'sources-missing'],
    [draft('B1', { text: T, ...sourcesRecord('Another text on Paje Beach', [src('a.com'), src('b.org', 2)]) }), 'sources-outdated'],
    [draft('B1', { text: T, ...sourcesRecord(T, [src('a.com'), src('www.a.com', 2)]) }), 'sources-too-few']];
  for (const [d, code] of cases) { const k = ak([d]); const b = k.bytes(); assert.deepEqual(await k.approve(), { ok: false, code }, code); nothingHappened(k, b); }
  { const k = ak(); const rq = k.req(); fs.writeFileSync(k.queuePath, '{broken'); assert.deepEqual(await k.approve(rq), { ok: false, code: 'queue-unreadable' }); assert.equal(k.bytes(), '{broken'); assert.equal(k.calls.schedule.length, 0); }
  { const k = ak([draft('B1', { createdAt: '2026-11-10T09:00:00Z' })]); const b = k.bytes(); assert.deepEqual(await k.approve(), { ok: false, code: 'expired' }); nothingHappened(k, b); }
  for (const over of [{ text: 'Lions sleep​ most of the day.' }, { videoText: 'Lions​' }]) { const k = ak([draft('B1', over)]); const b = k.bytes(); assert.deepEqual(await k.approve(), { ok: false, code: 'bad-characters' }, JSON.stringify(over)); nothingHappened(k, b); }
  { const k = ak([draft('B1', { text: 'Love the lions ❤️ on the plains.' })]); assert.equal((await k.approve()).ok, true); }
});
test('A3 a missing parameter makes approve answer check-failed and call nothing; approveOn false is cannot-decide before anything else', async () => {
  for (const key of ['schedule', 'stop', 'igOn', 'notify', 'approveOn', 'queuePath', 'recordFile', 'neverPromotePatterns']) {
    const k = ak(); const o = { ...k.opts }; delete o[key]; const a = createDraftActions(o); const b = k.bytes();
    assert.deepEqual(await a.approveDraft(k.req(), k.ctx), { ok: false, code: 'check-failed' }, key); nothingHappened(k, b);
  }
  { const k = ak(); const a = createDraftActions({ ...k.opts, schedule: 'nope' }); assert.equal((await a.approveDraft(k.req(), k.ctx)).code, 'check-failed'); assert.equal(k.calls.schedule.length, 0); }
  { const k = ak(undefined, { neverPromotePatterns: undefined }); assert.equal((await k.approve()).ok, true, 'a key present with undefined is accepted'); }
  const k = ak(undefined, { approveOn: () => false }); const b = k.bytes(); assert.deepEqual(await k.approve(), { ok: false, code: 'cannot-decide' }); nothingHappened(k, b); assert.equal(k.calls.stop, 0); assert.equal(k.calls.notify.length, 0);
});
test('A4 the final check: a violation blocks and alerts once with no record; a check that could not run, or an unavailable voice lint, leaves the draft pending', async () => {
  { const k = ak([draft('B1', { text: SEA })]); const r = await k.approve(); assert.deepEqual(r, { ok: false, code: 'blocked' }); const d = k.q().drafts[0]; assert.equal(d.status, 'blocked'); assert.deepEqual(d.blocked.rules, ['sea-conditions', 'paid-link-wording']); assert.equal(k.calls.notify.length, 1); assert.equal(k.calls.schedule.length, 0); assert.equal(k.lines().length, 0); }
  const fc = (o) => async () => ({ ok: false, violations: [], listReason: null, ...o });
  for (const [name, f, code, status, alerts] of [
    ['check-error', fc({ ruleIds: ['check-error'] }), 'check-failed', 'pending_approval', 0],
    ['voice unavailable', fc({ ruleIds: ['voice-lint'], voiceUnavailable: true }), 'check-failed', 'pending_approval', 0],
    ['real voice violation', fc({ ruleIds: ['voice-lint'], voiceUnavailable: false }), 'blocked', 'blocked', 1]]) {
    const k = ak(undefined, { finalCheck: f }); const r = await k.approve(); assert.deepEqual(r, { ok: false, code }, name); assert.equal(k.q().drafts[0].status, status, name); assert.equal(k.calls.notify.length, alerts, name); assert.equal(k.calls.schedule.length, 0); assert.equal(k.lines().length, 0, name);
  }
});
test('A5 a stop during the call voids the record; an ordinary failure keeps it and saves lastError', async () => {
  { const k = ak(undefined, { schedule: async () => { throw new StoppedError('stopped by flag since T1'); } }); const b = k.bytes(); assert.deepEqual(await k.approve(), { ok: false, code: 'stopped' }); assert.equal(k.bytes(), b); const l = k.lines(); assert.equal(l.length, 2); assert.equal(l[0].decision, 'approve'); assert.equal(l[1].decision, 'void'); assert.equal(l[1].ref, l[0].n); }
  { const k = ak(undefined, { schedule: async () => { throw new Error('boom'); } }); assert.deepEqual(await k.approve(), { ok: false, code: 'schedule-failed' }); assert.equal(k.q().drafts[0].lastError, 'boom'); assert.equal(k.q().drafts[0].status, 'pending_approval'); const l = k.lines(); assert.equal(l.length, 1); assert.equal(l[0].decision, 'approve'); }
});
test('A6 a save that fails after a good schedule: schedule-not-saved, no void, the log has the code and no text', async () => {
  let n = 0; const k = ak(undefined, { save: (q, p) => { if (n++ === 0) throw new Error('disk full: Lions sleep'); saveQueue(q, p); } }); const was = logSize();
  assert.deepEqual(await k.approve(), { ok: false, code: 'schedule-not-saved' }); assert.equal(k.calls.schedule.length, 1); const l = k.lines(); assert.equal(l.length, 1); assert.equal(l[0].decision, 'approve');
  const lines = logLines(was).join('\n'); assert.match(lines, /review failed: schedule-not-saved/); assert.ok(!lines.includes('Lions')); assert.ok(!lines.includes('disk full'));
});
test('A7 a record that cannot be written: record-failed, nothing scheduled', async () => {
  const k = ak(); fs.mkdirSync(k.recordFile); const b = k.bytes(); assert.deepEqual(await k.approve(), { ok: false, code: 'record-failed' }); assert.equal(k.calls.schedule.length, 0); assert.equal(k.bytes(), b);
});
test('A8 a double tap and two concurrent approves schedule exactly once', async () => {
  const k = ak(undefined, { schedule: async (t, a) => { await new Promise((r) => setTimeout(r, 30)); k2.push(1); return { id: 'p1' }; } }); const k2 = [];
  const rq = k.req(); const [a, b] = await Promise.all([k.approve(rq), k.approve(rq)]); assert.deepEqual([a.ok, b.ok].sort(), [false, true]); assert.equal([a, b].find((x) => !x.ok).code, 'already-scheduled'); assert.equal(k2.length, 1);
  assert.equal((await k.approve(rq)).code, 'already-scheduled'); assert.equal(k2.length, 1); assert.equal(k.lines().length, 1);
});
test('A9 an automatic draft that is already scheduled answers already-scheduled', async () => {
  const k = ak([draft('B1', { auto: true, status: 'scheduled' })]); const b = k.bytes(); assert.deepEqual(await k.approve(), { ok: false, code: 'already-scheduled' }); nothingHappened(k, b);
});
test('A10 lock order: while schedule is waiting, the decision lock is free (hook and clip decisions are not blocked)', async () => {
  let release; const gate = new Promise((r) => { release = r; }); let started; const seen = new Promise((r) => { started = r; });
  const k = ak(undefined, { schedule: async () => { started(); await gate; return { id: 'p1' }; } }); const running = k.approve();
  await Promise.race([seen, new Promise((_, rej) => setTimeout(() => rej(new Error('schedule was never reached')), 1500))]); assert.equal(await withDecisionLock(() => 'ok', { env: process.env, timeoutMs: 200 }), 'ok'); release(); assert.equal((await running).ok, true);
});
test('A11 the log is clean: only closed codes, never an id, text, source line, claim-gate message or Meta message', async () => {
  const was = logSize(); const T = 'A resort on Muyuni Beach';
  { const k = ak([draft('B1', { text: T, ...sourcesRecord(T, [src('a.com'), src('www.a.com', 2)]) })]); await k.approve(); }
  { const k = ak([draft('B1', { text: T })]); await k.approve(); }
  { const k = ak(undefined, { stop: () => ({ stopped: true, reason: 'stopped by flag since T1' }) }); await k.approve(); }
  { const k = ak(undefined, { schedule: async () => { throw new Error('SECRET-META-TEXT 123'); } }); await k.approve(); }
  const lines = logLines(was); assert.ok(lines.length >= 3);
  for (const l of lines) assert.match(l, /^\S+ review (draft|failed): [a-z0-9-]+$/, l);
  const all = lines.join('\n'); for (const bad of ['B1', 'SECRET-META', 'Muyuni', 'exact line quoted', 'no recorded source', 'Lions']) assert.ok(!all.includes(bad), bad);
});
test('A12 static: no publisher, one scheduleDraft after the guards and the record, no default for the doors, the version check before the guards', () => {
  const s = fs.readFileSync(path.join(HERE, 'draft-decisions.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  for (const w of ['publish(', 'publishNow', 'schedulePost', 'igPostDraftAny', 'createPost']) assert.ok(!s.includes(w), w);
  assert.equal((s.match(/\bscheduleDraft\(/g) || []).length, 1);
  const sec = s.split('async function approveDraft')[1].split(/\n  return \{/)[0];
  const at = (x) => { const i = sec.indexOf(x); assert.ok(i >= 0, x); return i; };
  assert.ok(at('draftVersion(d) !== req.version') < at('approveGuards(') && at('approveGuards(') < at('recordLocked(') && at('recordLocked(') < at('scheduleDraft('), 'version, guards, record, schedule');
  assert.ok(at("approveOn() !== true") < at('queueLocked('));
  const head = s.slice(s.indexOf('export function createDraftActions'), s.indexOf('const ready')); for (const k of ['schedule', 'igOn', 'stop', 'notify', 'queuePath', 'recordFile', 'approveOn']) assert.ok(!new RegExp(`\\b${k}\\s*=[^=]`).test(head), `no default for ${k}`);
  assert.match(head, /ttlDays = CONFIG\.draftTtlDays/);
});
