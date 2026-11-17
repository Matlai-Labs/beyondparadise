import './test-env.js';
// C: the automatic lane. prepareAutoPost (idea -> verbatim draft -> checks -> clip -> overlay -> render checks), ensureDailyAuto (once a day, into the
// queue), and the worker path that publishes it. Everything injected: no network, no model (an `ask` that throws is passed everywhere and must never run),
// no real queue, no real log, no real library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { prepareAutoPost, ensureDailyAuto, afterAutoPublish, autoKindsOf, autoSlotHour, slotFor, describeRefusal, MAX_IDEAS_PER_RUN } from './auto-lane.js';
import { runWorker } from './worker.js';
import { reservationsOnDay, reserveInstagramPublish } from './ledger.js';
import { CONFIG, loadQueue, saveQueue, finalCheck, autoTextHash, nextSlots } from './lib.js';
import { readUsage } from './reel-clip.js';
import { engageStop } from './stop.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-auto-'));
const NP = ['examplehotel'];
const NOW = new Date('2026-11-17T09:00:00Z'); // 12:00 EAT, before the 18:00 slot
const THROW_ASK = async () => { throw new Error('a model was asked on the automatic path'); };
const claim = (text, n = 1) => ({ text, ruleId: `r${n}`, sourceDate: '2026-10-01' });
const idea = (n, over = {}) => ({ id: `idea_${n}`, sourceId: `rule:r${n}`, kind: 'rule', topic: 'visa', title: `Lion entry rule number ${n}`, claims: [claim(`The listed fee for item ${n} is ${n + 10} US dollars for most visitors.`, n)], link: '/destinations/tanzania/', score: 100 - n, ...over });
const clipEntry = (id, over = {}) => ({ id, file: `${id}.mp4`, durationSec: 7, source: [{ videoId: `v-${id}`, startSec: 10, endSec: 17 }], subject: 'x', checks: { rendered: 'ok' }, flash: { flash: false, atSec: [] }, verified: { verdict: 'pass', by: 't', at: '2026-11-16T00:00:00Z', notes: '', singleSubject: 'yes' }, shows: { tags: ['lion'], by: 't', at: '2026-11-17T00:00:00Z', notes: '' }, ...over });
const manifestOf = (...clips) => ({ version: 1, clips });
const okCompose = (log) => async ({ clipFile, overlayPng, out }) => { log?.push({ clipFile, overlayPng, out }); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, 'composed-bytes'); return { ok: true, problems: [], out, rendered: { ok: true, problems: [], durationSec: 7 }, qa: { ok: true, problems: [] } }; };
const okOverlay = async ({ out }) => { fs.writeFileSync(out, 'png'); return { ok: true }; };

function kit(over = {}) {
  const dir = tmp(); const libraryDir = path.join(dir, 'library'); const outDir = path.join(dir, 'out'); const lines = []; const composeLog = [];
  const input = { pool: [idea(1), idea(2), idea(3)], manifest: manifestOf(clipEntry('clip-a'), clipEntry('clip-b')), usage: [], history: [], config: {}, now: NOW, ...over.input };
  const deps = { ask: THROW_ASK, outDir, libraryDir, exists: () => true, neverPromotePatterns: NP, say: (m) => lines.push(m), overlay: okOverlay, compose: okCompose(composeLog), ...over.deps };
  return { dir, libraryDir, outDir, lines, composeLog, input, deps };
}

// ── config helpers ───────────────────────────────────────────────────────────────
test('config: autoKinds defaults to rule and fact; a bad value is refused (not defaulted); the slot hour defaults to 18 and a bad value falls back to 18', () => {
  assert.deepEqual(autoKindsOf({}), { ok: true, kinds: ['rule', 'fact'] });
  assert.deepEqual(autoKindsOf({ autoKinds: ['fact'] }), { ok: true, kinds: ['fact'] });
  for (const bad of ['fact', [], [1], null, {}, ['']]) assert.equal(autoKindsOf({ autoKinds: bad }).ok, false, JSON.stringify(bad));
  assert.equal(autoSlotHour({}), 18); assert.equal(autoSlotHour({ autoSlotHourEAT: 7 }), 7); assert.equal(autoSlotHour({ autoSlotHourEAT: 0 }), 0);
  for (const bad of [24, -1, 1.5, '18', null, NaN]) assert.equal(autoSlotHour({ autoSlotHourEAT: bad }), 18, String(bad));
  assert.equal(MAX_IDEAS_PER_RUN, 15);
});
test('slotFor: 18:00 EAT of the same day, or of the next day when that hour has passed', () => {
  assert.equal(slotFor(new Date('2026-11-17T09:00:00Z'), 18), '2026-11-17T18:00:00+03:00');
  assert.equal(slotFor(new Date('2026-11-17T15:00:00Z'), 18), '2026-11-18T18:00:00+03:00', 'exactly 18:00 EAT has passed');
  assert.equal(slotFor(new Date('2026-11-17T22:30:00Z'), 18), '2026-11-18T18:00:00+03:00', '01:30 EAT on the 18th is the same EAT day');
  assert.equal(slotFor(new Date('2026-11-30T20:59:00Z'), 9), '2026-12-01T09:00:00+03:00', '23:59 EAT, month end');
});

// ── prepareAutoPost ──────────────────────────────────────────────────────────────
test('prepareAutoPost: the best-ranked idea of an allowed kind wins; other kinds and ideas already in history are not candidates', async () => {
  const k = kit({ input: { pool: [idea(1, { kind: 'page', score: 999 }), idea(2, { score: 50 }), idea(3, { score: 90 }), idea(4, { kind: 'fact', score: 80 }), idea(5, { score: 95 })], history: [{ sourceId: 'rule:r5', date: '2026-11-01' }, { sourceId: null, ideaId: 'idea_3' }] } });
  const r = await prepareAutoPost(k.input, k.deps);
  assert.equal(r.ok, true); assert.equal(r.draft.ideaId, 'idea_4', JSON.stringify(r.refused)); // idea_5 and idea_3 are in history, the page idea is not an allowed kind
  assert.deepEqual(r.refused.map((x) => x.reason), ['in-history', 'in-history']);
});
test('prepareAutoPost: a pool given as { ideas } works, and input order never matters (score descending, id ascending)', async () => {
  const k = kit({ input: { pool: { ideas: [idea(2, { score: 10 }), idea(3, { score: 70 }), idea(1, { score: 70 })] } } });
  assert.equal((await prepareAutoPost(k.input, k.deps)).draft.ideaId, 'idea_1');
});
test('prepareAutoPost: success carries claims, ideaId, lane, writer, the ready file with its hash, the clip id and its source, and the text is the verbatim one', async () => {
  const k = kit(); const r = await prepareAutoPost(k.input, k.deps);
  assert.equal(r.ok, true); const d = r.draft;
  assert.deepEqual([d.lane, d.writer, d.ideaId, d.ideaTitle], ['auto', 'verbatim', 'idea_1', 'Lion entry rule number 1']);
  assert.deepEqual(d.claims, k.input.pool[0].claims); assert.ok(d.text.split('\n').includes(k.input.pool[0].claims[0].text));
  assert.equal(d.clipId, 'clip-a'); assert.deepEqual(d.clipSource, [{ videoId: 'v-clip-a', startSec: 10, endSec: 17 }]);
  assert.equal(path.dirname(d.readyFile), k.outDir); assert.match(path.basename(d.readyFile), /\.mp4$/);
  assert.equal(d.readyFileSha256, crypto.createHash('sha256').update(fs.readFileSync(d.readyFile)).digest('hex'));
  assert.equal(r.clip.id, 'clip-a'); assert.equal(k.composeLog.length, 1); assert.equal(k.composeLog[0].clipFile, path.join(k.libraryDir, 'clip-a.mp4'));
  assert.equal(r.checks.rendered.ok, true); assert.equal(r.checks.qa.ok, true);
});
test('prepareAutoPost refusals: claim-too-long, title-too-long, no claims -> next idea, each logged with the idea id and the reason', async () => {
  const k = kit({ input: { pool: [idea(1, { title: `Lion ${'Z'.repeat(80)}` }), idea(2, { claims: [claim('x'.repeat(241))] }), idea(3, { claims: [] }), idea(4)] } });
  const r = await prepareAutoPost(k.input, k.deps);
  assert.equal(r.ok, true); assert.equal(r.draft.ideaId, 'idea_4');
  assert.deepEqual(r.refused, [{ ideaId: 'idea_1', reason: 'title-too-long' }, { ideaId: 'idea_2', reason: 'claim-too-long' }, { ideaId: 'idea_3', reason: 'idea-has-no-claims' }]);
  for (const [id, why] of [['idea_1', 'title-too-long'], ['idea_2', 'claim-too-long'], ['idea_3', 'idea-has-no-claims']]) assert.ok(k.lines.some((l) => l.includes(id) && l.includes(why)), `${id} logged`);
});
test('prepareAutoPost: a claim that fails the voice linter or the rules makes the idea ineligible (final-check:<rule ids>), the next idea is tried', async () => {
  const k = kit({ input: { pool: [idea(1, { claims: [claim('Big waves are listed for the coast this week at 5 metres.')] }), idea(2, { claims: [claim('Book now to see 12 lions at the park gate.')] }), idea(3)] } });
  const r = await prepareAutoPost(k.input, k.deps);
  assert.equal(r.draft.ideaId, 'idea_3'); assert.match(r.refused[0].reason, /^final-check:.*sea-conditions/); assert.match(r.refused[1].reason, /^final-check:.*paid-link-wording/);
});
test('prepareAutoPost: the deterministic judge part refuses filler wording (judge:filler); the model part is not asked', async () => {
  const k = kit({ input: { pool: [idea(1, { claims: [claim('Keep in mind that 1 of the 14 lodges is listed for visitors.')] }), idea(2)] } });
  const r = await prepareAutoPost(k.input, k.deps); assert.equal(r.draft.ideaId, 'idea_2'); assert.equal(r.refused[0].reason, 'judge:filler');
});
test('prepareAutoPost: at most 15 ideas are tried per run; then no-eligible-idea with the refusal reasons counted', async () => {
  const pool = Array.from({ length: 20 }, (_, i) => idea(i + 1, { title: `Lion ${'Q'.repeat(90)}` })); pool.push(idea(99, { score: 1 }));
  const k = kit({ input: { pool } }); const r = await prepareAutoPost(k.input, k.deps);
  assert.deepEqual([r.ok, r.reasons], [false, ['no-eligible-idea']]); assert.equal(r.refused.length, 15); assert.equal(k.composeLog.length, 0);
  assert.equal(describeRefusal(r), 'no-eligible-idea (title-too-long x15)');
});
test('prepareAutoPost: a bad autoKinds is a refusal; no ideas of the allowed kinds is no-eligible-idea', async () => {
  const k = kit({ input: { config: { autoKinds: 'rule' } } }); assert.deepEqual(await prepareAutoPost(k.input, k.deps), { ok: false, reasons: ['bad-config:autoKinds'], refused: [] });
  const j = kit({ input: { pool: [idea(1, { kind: 'page' })] } }); assert.deepEqual((await prepareAutoPost(j.input, j.deps)).reasons, ['no-eligible-idea']);
  const l = kit({ input: { pool: [idea(1, { kind: 'fact' })], config: { autoKinds: ['rule'] } } }); assert.deepEqual((await prepareAutoPost(l.input, l.deps)).reasons, ['no-eligible-idea']);
});
test('prepareAutoPost: no eligible clip -> exactly { ok:false, reasons:["no-eligible-clip"] }, nothing is composed, no other footage is used', async () => {
  const cases = { 'empty manifest': manifestOf(), 'no manifest': null, 'no passed verdict': manifestOf(clipEntry('c1', { verified: null }), clipEntry('c2', { verified: { verdict: 'fail', by: 't', at: 'x' } })),
    'flash': manifestOf(clipEntry('c3', { flash: { flash: true, atSec: [1] } })), 'not rendered ok': manifestOf(clipEntry('c4', { checks: { rendered: ['bad'] } })) };
  for (const [name, manifest] of Object.entries(cases)) {
    const k = kit({ input: { manifest } }); const r = await prepareAutoPost(k.input, k.deps);
    assert.deepEqual({ ok: r.ok, reasons: r.reasons }, { ok: false, reasons: ['no-eligible-clip'] }, name); assert.equal(k.composeLog.length, 0, name);
  }
  const used = kit({ input: { usage: [{ id: 'v-clip-a', startSec: 11, endSec: 15 }, { id: 'v-clip-b', startSec: 9, endSec: 12 }] } });
  assert.deepEqual((await prepareAutoPost(used.input, used.deps)).reasons, ['no-eligible-clip'], 'both clips are in the usage ledger');
  const missing = kit({ deps: { exists: () => false } }); assert.deepEqual((await prepareAutoPost(missing.input, missing.deps)).reasons, ['no-eligible-clip'], 'file absent');
});
test('prepareAutoPost: the next clip not in the usage ledger is taken; a manifest file name that leaves the library folder is skipped', async () => {
  const k = kit({ input: { manifest: manifestOf(clipEntry('evil', { file: '../escape.mp4' }), clipEntry('clip-a'), clipEntry('clip-b')), usage: [{ id: 'v-clip-a', startSec: 10, endSec: 17 }] } });
  const r = await prepareAutoPost(k.input, k.deps); assert.equal(r.clip.id, 'clip-b');
});
test('prepareAutoPost: an overlay refusal or a failed render check ends the run with a named reason; the ready file is not left behind', async () => {
  const a = kit({ deps: { overlay: async () => ({ ok: false, reason: 'overlay refused: the hook does not fit' }) } }); const ra = await prepareAutoPost(a.input, a.deps);
  assert.deepEqual([ra.ok, ra.reasons[0]], [false, 'overlay-refused']); assert.match(describeRefusal(ra), /the hook does not fit/); assert.equal(a.composeLog.length, 0);
  const b = kit({ deps: { compose: async ({ out }) => { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, 'x'); return { ok: false, problems: ['rendered: size 1x1'], out, rendered: { ok: false }, qa: { ok: true } }; } } });
  const rb = await prepareAutoPost(b.input, b.deps); assert.deepEqual([rb.ok, rb.reasons[0]], [false, 'compose-failed']); assert.match(describeRefusal(rb), /size 1x1/); assert.deepEqual(fs.readdirSync(b.outDir), []);
});
test('prepareAutoPost: the idea title, claims and clip file are never changed by the run; the pool and manifest objects are not mutated', async () => {
  const k = kit(); const before = JSON.stringify([k.input.pool, k.input.manifest, k.input.usage]); await prepareAutoPost(k.input, k.deps); assert.equal(JSON.stringify([k.input.pool, k.input.manifest, k.input.usage]), before);
});
test('no model on the automatic path: neither source file reaches the model caller', () => {
  for (const f of ['auto-lane.js', 'fact-post.js']) { const s = fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\/.*$/gm, ''); assert.doesNotMatch(s, /localAsk|askLocal|local-model|captionModel|judgeModel|judgeDraft\b/, f); }
});

// ── ledger helper ────────────────────────────────────────────────────────────────
test('reservationsOnDay: counts the East Africa day of `now`; a missing file is 0; a corrupt one is not ok (fail closed)', () => {
  const dir = tmp(); const p = path.join(dir, 'ledger.jsonl');
  assert.deepEqual(reservationsOnDay({ now: NOW, path: p }), { ok: true, count: 0 });
  assert.equal(reserveInstagramPublish({ id: 'B1', now: new Date('2026-11-16T20:30:00Z'), path: p, config: {} }).ok, true); // 23:30 EAT on the 16th
  assert.equal(reservationsOnDay({ now: NOW, path: p }).count, 0);
  assert.equal(reservationsOnDay({ now: new Date('2026-11-16T10:00:00Z'), path: p }).count, 1);
  assert.equal(reserveInstagramPublish({ id: 'B2', now: NOW, path: p, config: {} }).ok, true); assert.equal(reservationsOnDay({ now: NOW, path: p }).count, 1);
  fs.writeFileSync(p, 'garbage\n'); const r = reservationsOnDay({ now: NOW, path: p }); assert.equal(r.ok, false); assert.match(r.reason, /unreadable or corrupt/);
});

// ── ensureDailyAuto ──────────────────────────────────────────────────────────────
function daily(over = {}) {
  const dir = tmp(); const calls = { pool: 0, manifest: 0, usage: 0 }; const sent = []; const lines = []; const composeLog = [];
  const p = (n) => path.join(dir, n);
  const deps = { config: { autoPublish: true }, now: NOW, queuePath: p('queue.json'), statePath: p('auto-state.json'), ledgerPath: p('ledger.jsonl'), usagePath: p('usage.jsonl'),
    stopOpts: { flagPath: p('stop'), fleetPath: p('fleet') }, igOn: () => true, notify: async (m) => { sent.push(m); return true; }, say: (m) => lines.push(m),
    loadPool: async () => { calls.pool++; return { ok: true, ideas: [idea(1), idea(2)], sourceNames: {} }; }, readManifest: () => { calls.manifest++; return manifestOf(clipEntry('clip-a'), clipEntry('clip-b')); }, readUsage: () => { calls.usage++; return []; },
    libraryDir: p('library'), outDir: p('out'), prepareDeps: { ask: THROW_ASK, exists: () => true, neverPromotePatterns: NP, overlay: okOverlay, compose: okCompose(composeLog) }, ...over };
  return { dir, p, deps, calls, sent, lines, composeLog };
}
const queued = (d) => loadQueue(d.deps.queuePath).drafts;

test('switch off (absent, false, or anything but boolean true): returns at once, reads nothing, asks nothing, writes nothing', async () => {
  for (const config of [{}, { autoPublish: false }, { autoPublish: 'true' }, { autoPublish: 1 }, { autoPublish: null }, { autoPublish: [true] }, undefined]) {
    const boom = () => { throw new Error('touched'); };
    const d = daily({ config, loadPool: boom, readManifest: boom, readUsage: boom, igOn: boom, stop: boom, notify: boom, prepare: boom, prepareDeps: { ask: boom } });
    const r = await ensureDailyAuto(d.deps); assert.deepEqual(r, { ran: false, why: 'switch-off' }, JSON.stringify(config));
    assert.deepEqual(fs.readdirSync(d.dir), [], 'no file of any kind was created'); assert.deepEqual(d.lines, []);
  }
  assert.equal('autoPublish' in CONFIG, false, 'the shipped config.json leaves the switch absent');
});
test('switch on: one item is queued for 18:00 EAT of the same day, in the state the worker publishes from, carrying the claims and auto:true; Instagram only', async () => {
  const d = daily(); const r = await ensureDailyAuto(d.deps); assert.deepEqual([r.ran, r.queued], [true, true]);
  const items = queued(d); assert.equal(items.length, 1); const it = items[0];
  assert.deepEqual([it.id, it.status, it.auto, it.lane, it.writer, it.format, it.kind], ['B1', 'scheduled', true, 'auto', 'verbatim', 'reel', 'auto']);
  assert.deepEqual(it.ig, { status: 'queued', at: '2026-11-17T18:00:00+03:00' }); assert.equal(it.scheduledFor, '2026-11-17T18:00:00+03:00'); assert.equal('postId' in it, false, 'no Facebook leg');
  assert.deepEqual(it.claims, [idea(1).claims[0]]); assert.equal(it.ideaId, 'idea_1'); assert.equal(it.sourceId, 'rule:r1'); assert.ok(it.readyFile.startsWith(d.p('out')) && fs.existsSync(it.readyFile));
  assert.equal(loadQueue(d.deps.queuePath).seq, 1); assert.equal(d.sent.length, 0, 'no alert for a successful preparation: the alert comes after the publish');
  assert.equal(fs.existsSync(d.deps.usagePath), false, 'the usage ledger is untouched until a successful publish');
  assert.equal(fs.existsSync(d.deps.ledgerPath), false, 'no cap reservation yet: that happens in the worker right before the publish');
});
test('ensureDailyAuto never passes the rehearsal-only preview switch on, whatever prepareDeps or config carry', async () => {
  let seen = null; const d = daily({ config: { autoPublish: true, includeUnapproved: true, previewUnapproved: true }, prepare: async (input, deps) => { seen = { input, deps }; return { ok: false, reasons: ['x'], refused: [] }; } });
  d.deps.prepareDeps = { ...d.deps.prepareDeps, previewUnapproved: true }; await ensureDailyAuto(d.deps);
  assert.ok(seen); assert.equal(seen.deps.previewUnapproved, false); assert.equal('previewUnapproved' in seen.input, false);
});
test('the item is added next to the existing items; the sequence number continues; an existing draft is untouched', async () => {
  const d = daily(); saveQueue({ seq: 4, drafts: [{ id: 'B4', status: 'pending_approval', kind: 'outlook', text: 'x', sourceDate: '2026-11-01' }] }, d.deps.queuePath);
  await ensureDailyAuto(d.deps); const items = queued(d); assert.deepEqual(items.map((x) => x.id), ['B4', 'B5']); assert.equal(items[0].text, 'x');
});
test('slot: after 18:00 EAT the item is for the next day; autoSlotHourEAT moves it', async () => {
  const late = daily({ now: new Date('2026-11-17T16:00:00Z') }); await ensureDailyAuto(late.deps); assert.equal(queued(late)[0].ig.at, '2026-11-18T18:00:00+03:00');
  const early = daily({ config: { autoPublish: true, autoSlotHourEAT: 7 } }); await ensureDailyAuto(early.deps); assert.equal(queued(early)[0].ig.at, '2026-11-18T07:00:00+03:00');
});
test('once per East Africa day: a second call the same day does nothing; the next day it may run again once the earlier item is gone from the queue', async () => {
  const d = daily(); await ensureDailyAuto(d.deps); const again = await ensureDailyAuto({ ...d.deps, now: new Date('2026-11-17T12:00:00Z') });
  assert.deepEqual(again, { ran: false, why: 'already-today' }); assert.equal(queued(d).length, 1); assert.equal(d.calls.pool, 1);
  const tomorrow = { ...d.deps, now: new Date('2026-11-18T01:00:00Z') };
  assert.deepEqual(await ensureDailyAuto(tomorrow), { ran: false, why: 'auto-item-queued' }, 'an automatic item still waiting for its slot is not doubled');
  const q = loadQueue(d.deps.queuePath); q.drafts[0].ig.status = 'posted'; saveQueue(q, d.deps.queuePath);
  const r = await ensureDailyAuto(tomorrow); assert.equal(r.queued, true); assert.equal(queued(d).length, 2);
});
test('the day is written BEFORE the work: a crash inside the work cannot loop, one alert only, and the next call the same day does nothing', async () => {
  let sawState = null; const d = daily();
  d.deps.loadPool = async () => { sawState = JSON.parse(fs.readFileSync(d.deps.statePath, 'utf8')); throw new Error('pool exploded'); };
  const r = await ensureDailyAuto(d.deps); assert.equal(sawState.day, '2026-11-17'); assert.equal(r.queued, false);
  assert.deepEqual(d.sent, ['No automatic post today: error: pool exploded.']);
  assert.deepEqual(await ensureDailyAuto(d.deps), { ran: false, why: 'already-today' }); assert.equal(d.sent.length, 1); assert.equal(queued(d).length, 0);
});
test('when the state file cannot be written nothing is prepared (fail closed)', async () => {
  const d = daily(); d.deps.statePath = path.join(d.dir, 'no-such-dir', 'deeper', 'x.json'); fs.writeFileSync(path.join(d.dir, 'no-such-dir'), 'a file where a folder should be');
  const r = await ensureDailyAuto(d.deps); assert.deepEqual(r, { ran: false, why: 'state-unwritable' }); assert.equal(d.calls.pool, 0);
});
test('nothing when the stop flag is set (own or fleet-wide): no state written, nothing read', async () => {
  for (const which of ['flagPath', 'fleetPath']) {
    const d = daily(); fs.writeFileSync(d.deps.stopOpts[which], 'x');
    assert.deepEqual(await ensureDailyAuto(d.deps), { ran: false, why: 'stopped' }); assert.equal(d.calls.pool + d.calls.manifest, 0); assert.equal(fs.existsSync(d.deps.statePath), false);
  }
  const d = daily(); engageStop({ flagPath: d.deps.stopOpts.flagPath }); assert.equal((await ensureDailyAuto(d.deps)).why, 'stopped');
});
test('nothing when today already has an Instagram reservation, when the cap is 0, when the ledger is unreadable, or when Instagram is off in practice', async () => {
  const a = daily(); reserveInstagramPublish({ id: 'B9', now: NOW, path: a.deps.ledgerPath, config: {} });
  assert.deepEqual(await ensureDailyAuto(a.deps), { ran: false, why: 'cap-reserved-today' }); assert.equal(a.calls.pool, 0); assert.equal(fs.existsSync(a.deps.statePath), false);
  const b = daily({ config: { autoPublish: true, maxInstagramPostsPerDay: 0 } }); assert.deepEqual(await ensureDailyAuto(b.deps), { ran: false, why: 'cap-zero' });
  const c = daily(); fs.writeFileSync(c.deps.ledgerPath, 'garbage\n'); assert.equal((await ensureDailyAuto(c.deps)).why, 'ledger-unreadable'); assert.equal(c.calls.pool, 0);
  const e = daily({ igOn: () => false }); assert.deepEqual(await ensureDailyAuto(e.deps), { ran: false, why: 'instagram-off' }); assert.equal(e.calls.pool, 0);
  const f = daily(); reserveInstagramPublish({ id: 'B9', now: new Date('2026-11-16T09:00:00Z'), path: f.deps.ledgerPath, config: {} }); assert.equal((await ensureDailyAuto(f.deps)).queued, true, 'yesterday\'s reservation does not count');
});
test('a failed preparation sends at most one line a day with the reasons, and queues nothing', async () => {
  const d = daily({ readManifest: () => manifestOf() }); const r = await ensureDailyAuto(d.deps); assert.deepEqual([r.ran, r.queued], [true, false]);
  assert.deepEqual(d.sent, ['No automatic post today: no-eligible-clip.']); assert.equal(queued(d).length, 0);
  await ensureDailyAuto(d.deps); assert.equal(d.sent.length, 1);
  const next = await ensureDailyAuto({ ...d.deps, now: new Date('2026-11-18T01:00:00Z') }); assert.equal(next.ran, true); assert.equal(d.sent.length, 2, 'a new day, a new line: silence never hides an empty library');
  const e = daily({ loadPool: async () => ({ ok: false, reason: 'the never-promote list is missing' }) }); await ensureDailyAuto(e.deps); assert.deepEqual(e.sent, ['No automatic post today: no-pool (the never-promote list is missing).']);
});
test('ideas already in the real queue are history: an idea queued or posted before is not used again', async () => {
  const d = daily(); saveQueue({ seq: 1, drafts: [{ id: 'B1', status: 'posted', kind: 'idea', sourceId: 'rule:r1', text: 't', postedAt: '2026-11-01T00:00:00Z' }] }, d.deps.queuePath);
  await ensureDailyAuto(d.deps); assert.equal(queued(d)[1].ideaId, 'idea_2');
});
test('no model on any path: the injected ask never ran (success and failure paths above all carried it)', async () => {
  const d = daily({ readManifest: () => manifestOf() }); await ensureDailyAuto(d.deps); const e = daily(); await ensureDailyAuto(e.deps); // a throwing ask would have thrown into the one-line alert
  assert.ok(![...d.sent, ...e.sent].some((m) => /model was asked/.test(m)));
});

// ── the worker path: the existing guarded functions publish it ────────────────────
const BAD = 'Big waves this week, book now.';
function wk(over = {}) {
  const d = daily(over); const calls = { ig: [], igStatusAtCall: [], status: 0 };
  const deps = { now: NOW, queuePath: d.deps.queuePath, stopOpts: d.deps.stopOpts, igOn: () => true, config: { autoPublish: true }, ledgerPath: d.deps.ledgerPath, runStatePath: d.p('run.json'), lastPostPath: d.p('lastpost.json'),
    publishIg: async (x) => { calls.ig.push(x); calls.igStatusAtCall.push(x.ig.status); return over.publishResult ? over.publishResult(x) : { permalink: 'https://example.invalid/p/1', id: 'm1' }; }, postStatus: async () => { calls.status++; return {}; },
    notify: d.deps.notify, say: d.deps.say, approvalHealth: async () => ({ ok: true }), auto: Object.fromEntries(['statePath', 'usagePath', 'loadPool', 'readManifest', 'readUsage', 'libraryDir', 'outDir', 'prepareDeps'].map((k) => [k, d.deps[k]])), ...over.worker };
  return { ...d, wdeps: deps, calls };
}
const EVENING = new Date('2026-11-17T15:30:00Z'); // 18:30 EAT: the slot has come

test('runWorker, switch on: after its existing work it queues the day\'s item; the item is NOT published in the same run (its slot is later)', async () => {
  const w = wk(); await runWorker(w.wdeps); assert.equal(queued(w).length, 1); assert.equal(w.calls.ig.length, 0); assert.equal(fs.existsSync(w.deps.ledgerPath), false);
});
test('runWorker, later: the existing path publishes it (stop check, final check, cap reservation, claim) -> posted, usage ledger written once, one alert with the exact words', async () => {
  const w = wk(); await runWorker(w.wdeps); w.sent.length = 0; await runWorker({ ...w.wdeps, now: EVENING });
  assert.equal(w.calls.ig.length, 1); assert.equal(w.calls.ig[0].auto, true); assert.equal(w.calls.igStatusAtCall[0], 'publishing', 'claimed before the publisher ran');
  const it = queued(w)[0]; assert.deepEqual([it.status, it.ig.status, it.permalink], ['posted', 'posted', 'https://example.invalid/p/1']);
  assert.equal(reservationsOnDay({ now: EVENING, path: w.deps.ledgerPath }).count, 1, 'the daily cap slot was reserved');
  const used = readUsage(w.deps.usagePath); assert.deepEqual(used.map((u) => [u.id, u.startSec, u.endSec]), [['v-clip-a', 10, 17]]);
  assert.deepEqual(w.sent, ['Automatic post published: https://example.invalid/p/1. Idea: Lion entry rule number 1. Reply bpa stop to halt automatic posting.']);
  await runWorker({ ...w.wdeps, now: new Date('2026-11-17T15:45:00Z') }); assert.equal(w.calls.ig.length, 1, 'never twice'); assert.equal(readUsage(w.deps.usagePath).length, 1);
});
test('the usage ledger is written only after a successful publish: a failed publish writes nothing and sends no "published" line', async () => {
  const w = wk({ publishResult: () => { throw new Error('Meta said no'); } }); await runWorker(w.wdeps); w.sent.length = 0; await runWorker({ ...w.wdeps, now: EVENING });
  assert.equal(w.calls.ig.length, 1); assert.equal(fs.existsSync(w.deps.usagePath), false); assert.equal(queued(w)[0].ig.status, 'failed'); assert.ok(!w.sent.some((m) => /Automatic post published/.test(m)));
});
test('a queued automatic item whose text was changed in the queue file to a refused wording is BLOCKED by the existing final check: publisher never called, no usage, no cap slot', async () => {
  const w = wk(); await runWorker(w.wdeps); const q = loadQueue(w.deps.queuePath); q.drafts[0].text = BAD; saveQueue(q, w.deps.queuePath);
  w.sent.length = 0; await runWorker({ ...w.wdeps, now: EVENING });
  assert.equal(w.calls.ig.length, 0); assert.equal(queued(w)[0].status, 'blocked'); assert.equal(fs.existsSync(w.deps.usagePath), false); assert.equal(fs.existsSync(w.deps.ledgerPath), false);
  assert.ok(w.sent.some((m) => /blocked/.test(m)) && !w.sent.some((m) => /Automatic post published/.test(m)));
});
test('finalCheck on an automatic item: intact passes; any change of text, on-video text or claims is auto-text-changed (the figure check of the rules gate is a heuristic, this one is exact)', async () => {
  const k = kit(); const r = await prepareAutoPost(k.input, k.deps); const d = { ...r.draft, id: 'B1' }; const chk = (x) => finalCheck(x, { neverPromotePatterns: NP });
  assert.equal((await chk(d)).ok, true); assert.equal(d.autoTextSha256, autoTextHash(d));
  const swap = { ...d, text: d.text.replace('11 US dollars', '99 US dollars') }; assert.equal((await chk(swap)).ok, false); assert.ok((await chk(swap)).ruleIds.includes('auto-text-changed'));
  assert.ok((await chk({ ...d, videoText: 'Another hook' })).ruleIds.includes('auto-text-changed'));
  const noHash = { ...d }; delete noHash.autoTextSha256; assert.ok((await chk(noHash)).ruleIds.includes('auto-text-changed'));
  const lost = { ...d, claims: [{ ...d.claims[0], text: 'A sentence that is not in the text.' }] }; assert.ok((await chk(lost)).ruleIds.includes('auto-text-changed'));
  assert.ok(!(await chk({ ...d, auto: false, text: swap.text })).ruleIds.includes('auto-text-changed'), 'only automatic items carry the guard');
});
test('the same for a changed on-video text (videoText) and for a claim edited to a figure that is not sourced', async () => {
  const a = wk(); await runWorker(a.wdeps); const qa = loadQueue(a.deps.queuePath); qa.drafts[0].videoText = 'Book now'; saveQueue(qa, a.deps.queuePath); await runWorker({ ...a.wdeps, now: EVENING });
  assert.equal(a.calls.ig.length, 0); assert.equal(queued(a)[0].status, 'blocked');
  const b = wk(); await runWorker(b.wdeps); const qb = loadQueue(b.deps.queuePath); qb.drafts[0].text = qb.drafts[0].text.replace('11 US dollars', '99 US dollars'); saveQueue(qb, b.deps.queuePath); await runWorker({ ...b.wdeps, now: EVENING });
  assert.equal(b.calls.ig.length, 0); assert.equal(queued(b)[0].status, 'blocked');
});
test('switch turned off while an automatic item waits: the worker holds it (not published, not blocked, nothing sent); turned on again it goes out', async () => {
  const w = wk(); await runWorker(w.wdeps); const off = { ...w.wdeps, config: {}, now: EVENING };
  await runWorker(off); assert.equal(w.calls.ig.length, 0); assert.equal(queued(w)[0].ig.status, 'queued'); assert.ok(w.lines.some((l) => /automatic item .* held/.test(l)));
  await runWorker({ ...w.wdeps, now: EVENING }); assert.equal(w.calls.ig.length, 1);
});
test('the stop flag: the worker returns before anything, the lane is not reached, a queued item is not published', async () => {
  const w = wk(); await runWorker(w.wdeps); engageStop({ flagPath: w.deps.stopOpts.flagPath });
  let reached = 0; const r = await runWorker({ ...w.wdeps, now: EVENING, auto: { ...w.wdeps.auto, loadPool: async () => { reached++; return { ok: false, reason: 'x' }; } } });
  assert.equal(r.stopped, true); assert.equal(w.calls.ig.length, 0); assert.equal(reached, 0);
});
test('runWorker, switch absent: the lane is not even loaded, the queue is not touched, no state file', async () => {
  const w = wk({ worker: { config: {} } }); const boom = () => { throw new Error('touched'); }; w.wdeps.auto = { loadPool: boom, readManifest: boom, readUsage: boom, prepareDeps: { ask: boom } };
  const r = await runWorker(w.wdeps); assert.equal(r.exitCode, 0); assert.deepEqual(loadQueue(w.deps.queuePath).drafts, [], 'no item was queued'); assert.equal(fs.existsSync(w.deps.statePath), false, 'no state file'); assert.equal(fs.existsSync(w.p('out')), false);
});
test('an exception inside the lane never breaks the worker run: it is logged and the run still succeeds', async () => {
  const w = wk(); w.wdeps.auto = { ...w.wdeps.auto, statePath: w.deps.statePath, loadPool: async () => { throw new Error('boom'); } }; const r = await runWorker(w.wdeps); assert.equal(r.exitCode, 0);
});
test('afterAutoPublish: never throws, even with a bad usage path and a failing alert; the alert falls back to the media id', async () => {
  const lines = []; const d = { id: 'B7', auto: true, status: 'scheduled', ideaTitle: 'Some title', clipSource: [{ videoId: 'v', startSec: 1, endSec: 2 }], ig: {} };
  const sent = []; await afterAutoPublish(d, { id: 'media-42' }, { now: NOW, usagePath: '/proc/definitely/not/writable/usage.jsonl', notify: async (m) => { sent.push(m); throw new Error('bridge down'); }, say: (m) => lines.push(m) });
  assert.equal(d.status, 'posted'); assert.equal(sent[0], 'Automatic post published: media-42. Idea: Some title. Reply bpa stop to halt automatic posting.'); assert.ok(lines.some((l) => /usage ledger/.test(l)));
});

test('nextSlots: an automatic item is Instagram only and does not take a Facebook day slot', () => {
  const q = { drafts: [{ id: 'B1', status: 'scheduled', scheduledFor: '2026-11-18T18:00:00+03:00', auto: true }, { id: 'B2', status: 'scheduled', scheduledFor: '2026-11-19T09:00:00+03:00' }] };
  assert.deepEqual(nextSlots(q, 2, new Date('2026-11-17T09:00:00Z')), ['2026-11-18T09:00:00+03:00', '2026-11-20T09:00:00+03:00']);
});
