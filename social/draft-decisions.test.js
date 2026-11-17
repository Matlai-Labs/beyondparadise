import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { createDraftActions } from './draft-decisions.js';
import { appendDecision } from './review-decisions.js';
import { draftVersion } from './draft-version.js';
import { withQueueLock } from './lib.js';
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
