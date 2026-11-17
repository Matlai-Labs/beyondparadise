import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STATUS_CODE, statusCodeOf, checkSkip, applySkip, skipDraft, checkEdit, applyEdit, editDraft, approveGuards, scheduleDraft } from './draft-actions.js';
import { claimGate, sourcesRecord } from './claim-gate.js';
import { finalCheck } from './lib.js'; import { StoppedError } from './stop.js';
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

// ── approveGuards and scheduleDraft: everything injected ─────────────────────────────────────────────────────────────
const FIG = 'The park fee is 25 USD per adult.';
function gk(d = pend(), over = {}) {
  const log = []; const calls = { notify: [], schedule: [], igOn: 0 };
  const opts = { cmd: 'approve', stop: () => ({ stopped: false }), neverPromotePatterns: NP, notify: async (m) => { calls.notify.push(m); return true; }, say: (t, c) => log.push([t, c]), ...over };
  const sched = { schedule: async (text, at) => { calls.schedule.push([text, at]); return { id: 'p1' }; }, igOn: () => { calls.igOn++; return false; }, say: opts.say, now: NOW };
  return { d, opts, calls, log, sched };
}
test('approveGuards: every refusal has its code and pinned line, says the old text AND the code, calls nothing else', async () => {
  { const k = gk(pend({ status: 'scheduled' })); assert.deepEqual(await approveGuards(k.d, k.opts), { ok: false, code: 'already-scheduled', line: '⚠️ B1 is scheduled' }); assert.deepEqual(k.log, []); }
  { const k = gk(pend(), { stop: () => ({ stopped: true, reason: 'stopped by flag since T1' }) }); assert.deepEqual(await approveGuards(k.d, k.opts), { ok: false, code: 'stopped', line: '⏸ B1: stopped by flag since T1. Reply *bpa start* to resume.' }); assert.deepEqual(k.log, [['approve B1 refused: stopped by flag since T1', 'stopped']]); assert.equal(k.calls.notify.length, 0); }
  { const k = gk(pend({ text: FIG })); const msg = claimGate({ text: FIG }); assert.deepEqual(await approveGuards(k.d, k.opts), { ok: false, code: 'sources-missing', line: `❌ B1: ${msg}` }); assert.deepEqual(k.log, [[`approve B1 refused: ${msg}`, 'sources-missing']]); assert.equal(k.calls.notify.length, 0); }
  { const k = gk(pend({ text: SEA }), { cmd: 'postnow' }); assert.deepEqual(await approveGuards(k.d, k.opts), { ok: false, code: 'blocked', line: '🚫 B1 blocked: sea-conditions, paid-link-wording. Nothing was posted or scheduled; it will not be retried.' }); assert.equal(k.d.status, 'blocked'); assert.equal(k.calls.notify.length, 1); }
});
test('approveGuards: a passing draft is ok, is not mutated, and is accepted once by scheduleDraft', async () => {
  const k = gk(); const before = structuredClone(k.d); assert.deepEqual(await approveGuards(k.d, k.opts), { ok: true }); assert.deepEqual(k.d, before);
  const r = await scheduleDraft({ drafts: [] }, k.d, k.sched); assert.equal(r.ok, true); assert.equal(k.calls.schedule.length, 1);
  const again = await scheduleDraft({ drafts: [] }, pend(), k.sched); assert.deepEqual(again, { ok: false, code: 'check-failed', line: '❌ B1: checks were not run' }); assert.equal(k.calls.schedule.length, 1);
});
test('F3: notify missing still blocks, and the real WhatsApp sender is never reached (no "whatsapp skipped" line); the code has the typeof replacement', async () => {
  const log = process.env.BPA_LOG_PATH; const was = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').length : 0;
  const k = gk(pend({ text: SEA }), { notify: undefined }); const r = await approveGuards(k.d, k.opts); assert.equal(r.code, 'blocked'); assert.equal(k.d.status, 'blocked');
  assert.ok(!(fs.existsSync(log) ? fs.readFileSync(log, 'utf8').slice(was) : '').includes('whatsapp skipped'));
  assert.match(fs.readFileSync(new URL('./draft-actions.js', import.meta.url), 'utf8'), /typeof notify === 'function'/);
});
test('F8: on the page a check that could not run is refused, not blocked for good; on WhatsApp it blocks as before', async () => {
  const fcs = [async () => ({ ok: false, ruleIds: ['check-error'], violations: [], listReason: null }), async () => ({ ok: false, ruleIds: ['rule-x'], violations: [], listReason: 'never-promote list unreadable' })];
  for (const fc of fcs) {
    const k = gk(pend(), { onCheckError: 'refuse', finalCheck: fc }); const r = await approveGuards(k.d, k.opts); assert.equal(r.code, 'check-failed'); assert.equal(k.d.status, 'pending_approval'); assert.equal(k.calls.notify.length, 0); assert.deepEqual(k.log, [['final check could not run', 'check-failed']]);
    const w = gk(pend(), { finalCheck: fc }); const x = await approveGuards(w.d, w.opts); assert.equal(x.code, 'blocked'); assert.equal(w.d.status, 'blocked');
  }
});
test('S4: an unavailable voice lint is transient on the page, blocked on WhatsApp; a real voice violation is blocked on both', async () => {
  const res = (u) => async () => ({ ok: false, ruleIds: ['voice-lint'], violations: [{ rule: 'voice-lint', match: '' }], listReason: null, voiceUnavailable: u });
  { const k = gk(pend(), { onCheckError: 'refuse', finalCheck: res(true) }); assert.equal((await approveGuards(k.d, k.opts)).code, 'check-failed'); assert.equal(k.d.status, 'pending_approval'); assert.equal(k.calls.notify.length, 0); }
  { const k = gk(pend(), { finalCheck: res(true) }); assert.equal((await approveGuards(k.d, k.opts)).code, 'blocked'); }
  { const k = gk(pend(), { onCheckError: 'refuse', finalCheck: res(false) }); assert.equal((await approveGuards(k.d, k.opts)).code, 'blocked'); assert.equal(k.d.status, 'blocked'); }
});
test('S4: the real finalCheck tells an unavailable linter from a real violation', async () => {
  const a = await finalCheck(pend(), { neverPromotePatterns: NP, voice: async () => ({ ok: false, reason: 'voice-lint unavailable at x (fail closed)' }) }); assert.equal(a.voiceUnavailable, true);
  for (const reason of ['voice-lint crashed (fail closed): x', 'voice-lint returned no result (fail closed)']) assert.equal((await finalCheck(pend(), { neverPromotePatterns: NP, voice: async () => ({ ok: false, reason }) })).voiceUnavailable, true, reason);
  const b = await finalCheck(pend(), { neverPromotePatterns: NP, voice: async () => ({ ok: false, reason: '{"rules":[]}' }) }); assert.equal(b.voiceUnavailable, false); assert.deepEqual(b.ruleIds, ['voice-lint']);
  assert.equal((await finalCheck(pend(), { neverPromotePatterns: NP, voice: async () => ({ ok: true, reason: null }) })).voiceUnavailable, false);
});
test('F10: scheduleDraft without a pass from approveGuards calls nothing; a second call after a success calls nothing; missing schedule or igOn calls nothing', async () => {
  const k = gk(); const r = await scheduleDraft({ drafts: [] }, k.d, k.sched); assert.deepEqual(r, { ok: false, code: 'check-failed', line: '❌ B1: checks were not run' }); assert.equal(k.calls.schedule.length, 0); assert.equal(k.calls.igOn, 0); assert.equal(k.d.status, 'pending_approval');
  await approveGuards(k.d, k.opts); await scheduleDraft({ drafts: [] }, k.d, k.sched); assert.equal(k.calls.schedule.length, 1);
  const s2 = await scheduleDraft({ drafts: [] }, k.d, k.sched); assert.equal(s2.code, 'check-failed'); assert.equal(k.calls.schedule.length, 1);
  for (const missing of ['schedule', 'igOn']) { const m = gk(); await approveGuards(m.d, m.opts); const r2 = await scheduleDraft({ drafts: [] }, m.d, { ...m.sched, [missing]: undefined }); assert.equal(r2.code, 'schedule-failed'); assert.equal(m.calls.schedule.length, 0); assert.equal(m.d.status, 'pending_approval'); }
});
test('scheduleDraft: the success shape, igOn once and only for d.ig, the slot from nextSlots(now) or the given one, schedule called once with (text, at)', async () => {
  const k = gk(); await approveGuards(k.d, k.opts); const r = await scheduleDraft({ drafts: [] }, k.d, k.sched);
  assert.match(r.scheduledFor, /^2026-11-\d\dT09:00:00\+03:00$/); assert.deepEqual(k.calls.schedule, [[k.d.text, r.scheduledFor]]); assert.equal(k.calls.igOn, 1);
  assert.deepEqual(r, { ok: true, line: `📅 B1 scheduled for ${r.scheduledFor.slice(0, 16)} on the Page (p1)`, scheduledFor: r.scheduledFor, postId: 'p1' });
  assert.equal(k.d.status, 'scheduled'); assert.equal(k.d.postId, 'p1'); assert.equal(k.d.scheduledFor, r.scheduledFor); assert.equal(k.d.decidedAt, '2026-11-18T10:00:00.000Z'); assert.ok(!('ig' in k.d));
  const i = gk(); await approveGuards(i.d, i.opts); const r2 = await scheduleDraft({ drafts: [] }, i.d, { ...i.sched, igOn: () => true, at: '2026-12-01T09:00:00+03:00' });
  assert.equal(r2.line, '📅 B1 scheduled for 2026-12-01T09:00 on the Page + Instagram (p1)'); assert.deepEqual(i.d.ig, { status: 'queued', at: '2026-12-01T09:00:00+03:00' }); assert.deepEqual(i.calls.schedule, [[i.d.text, '2026-12-01T09:00:00+03:00']]);
});
test('scheduleDraft: a stop during the call and an ordinary failure answer as pinned; a rejected promise is awaited', async () => {
  const a = gk(); await approveGuards(a.d, a.opts); const ra = await scheduleDraft({ drafts: [] }, a.d, { ...a.sched, schedule: async () => { throw new StoppedError('stopped by flag since T1'); } });
  assert.deepEqual(ra, { ok: false, code: 'stopped', line: '⏸ B1: stopped by flag since T1. Nothing was posted. Reply *bpa start* to resume.' }); assert.deepEqual(a.log, [['approve B1 refused: stopped by flag since T1', 'stopped']]); assert.equal(a.d.status, 'pending_approval');
  const b = gk(); await approveGuards(b.d, b.opts); const rb = await scheduleDraft({ drafts: [] }, b.d, { ...b.sched, schedule: () => Promise.reject(new Error('boom')) });
  assert.deepEqual(rb, { ok: false, code: 'schedule-failed', line: '❌ B1: boom' }); assert.equal(b.d.lastError, 'boom'); assert.deepEqual(b.log, [['approve B1 failed: boom', 'schedule-failed']]);
});
