import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { STATUS_CODE, statusCodeOf, checkSkip, applySkip, skipDraft, checkEdit, applyEdit, editDraft } from './draft-actions.js';
const NP = ['examplehotel'];
const SEA = 'Book now for big waves today at the beach.'; const VOICE_BAD = 'Let us delve into a rich tapestry of seamless synergy. It is a game-changer!';
const pend = (extra = {}) => ({ id: 'B1', status: 'pending_approval', kind: 'outlook', text: 'Lions sleep most of the day on the plains.', ...extra });
const NOW = () => new Date('2026-11-18T10:00:00Z');

test('statusCodeOf: each status has its code, anything else is not-pending', () => {
  const want = { scheduled: 'already-scheduled', skipped: 'already-skipped', posted: 'already-posted', expired: 'expired', blocked: 'blocked', failed: 'not-pending' };
  for (const [s, c] of Object.entries(want)) { assert.equal(STATUS_CODE.get(s), c, s); assert.equal(statusCodeOf(s), c, s); }
  assert.equal(statusCodeOf('weird'), 'not-pending'); assert.equal(statusCodeOf(undefined), 'not-pending');
});
test('checkSkip: pending is ok; every other status gives its code and the exact WhatsApp line', () => {
  assert.deepEqual(checkSkip(pend()), { ok: true });
  for (const s of ['scheduled', 'skipped', 'posted', 'expired', 'blocked', 'failed', 'weird']) assert.deepEqual(checkSkip(pend({ status: s })), { ok: false, code: statusCodeOf(s), line: `⚠️ B1 is ${s}` }, s);
});
test('skip: apply sets status and decidedAt and answers the pinned line; skipDraft is check then apply', () => {
  const d = pend(); assert.equal(applySkip(d, { now: NOW }), '🚫 B1 skipped'); assert.equal(d.status, 'skipped'); assert.equal(d.decidedAt, '2026-11-18T10:00:00.000Z');
  const e = pend(); assert.deepEqual(skipDraft(e, { now: NOW }), { ok: true, line: '🚫 B1 skipped' }); assert.equal(e.status, 'skipped');
  const f = pend({ status: 'scheduled' }); assert.deepEqual(skipDraft(f), { ok: false, code: 'already-scheduled', line: '⚠️ B1 is scheduled' }); assert.equal(f.status, 'scheduled');
});
test('checkEdit: each refusal has its code and line, and the draft is unchanged', async () => {
  const cases = [
    [pend({ status: 'posted' }), 'fine text here.', 'already-posted', '⚠️ B1 is posted'],
    [pend(), 'Beyond Paradise is lovely.', 'brand-rule', '❌ B1: brand must be written in full: "Beyond Paradise Adventures"'],
    [pend(), VOICE_BAD, 'voice-rule', /^❌ B1: voice-lint — /],
    [pend(), SEA, 'rules', '❌ B1: rules — sea-conditions, paid-link-wording'],
  ];
  for (const [d, text, code, line] of cases) {
    const before = structuredClone(d); const r = await checkEdit(d, text, { neverPromotePatterns: NP });
    assert.equal(r.ok, false); assert.equal(r.code, code); if (line instanceof RegExp) assert.match(r.line, line); else assert.equal(r.line, line); assert.deepEqual(d, before);
  }
});
test('checkSkip and checkEdit never mutate (a frozen draft does not throw); applySkip on a frozen draft throws', async () => {
  const d = Object.freeze(pend()); assert.doesNotThrow(() => checkSkip(d));
  assert.deepEqual(await checkEdit(d, 'Giraffes feed on tall acacia trees.', { neverPromotePatterns: NP }), { ok: true });
  assert.throws(() => applySkip(d), TypeError);
});
test('applyEdit: new text, the three claim fields gone, editedAt set, the pinned line; editDraft is check then apply', async () => {
  const text = 'Giraffes feed on tall acacia trees.';
  const d = pend({ claimSources: [{}], claimSourcesHash: 'h', claimSourcesAt: 't' }); assert.equal(applyEdit(d, text, { now: NOW }), `✏️ B1 updated (${text.length} chars). Reply *bpa approve B1* to schedule.`);
  assert.equal(d.text, text); for (const k of ['claimSources', 'claimSourcesHash', 'claimSourcesAt']) assert.ok(!(k in d), k); assert.equal(d.editedAt, '2026-11-18T10:00:00.000Z');
  const e = pend(); assert.deepEqual(await editDraft(e, text, { neverPromotePatterns: NP, now: NOW }), { ok: true, line: `✏️ B1 updated (${text.length} chars). Reply *bpa approve B1* to schedule.` }); assert.equal(e.text, text);
  const f = pend(); const r = await editDraft(f, SEA, { neverPromotePatterns: NP }); assert.equal(r.ok, false); assert.equal(r.code, 'rules'); assert.equal(f.text, pend().text);
});
