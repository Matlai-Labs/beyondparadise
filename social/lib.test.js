import { test } from 'node:test'; import assert from 'node:assert/strict';
import { pickItems, draftFromItem, draftFromForecast, brandGuard, parseCommand, nextSlots, STATUS, renderList } from './lib.js';
const item = (id, conf, mag, region = 'zanzibar') => ({ signal: { id, subject: 'Sauti za Busara', region, summary: 'The festival dates were confirmed for February.', confidence: conf, magnitude: mag, sourceIds: ['a', 'b'] }, whyItMatters: 'Beds in Stone Town fill a month early.', whatToDo: 'Open February availability now.', confidence: conf, sources: [{ id: 'a' }, { id: 'b' }] });
test('pickItems dedupes by signal id and ranks by confidence×magnitude', () => {
  const briefs = [{ date: '2026-09-10', items: [item('x', 0.9, 1), item('y', 0.7, 3)] }, { date: '2026-09-11', items: [item('x', 0.9, 1)] }];
  const out = pickItems(briefs, 3); assert.equal(out.length, 2); assert.equal(out[0].signal.id, 'y');
});
test('draftFromItem writes first person, full brand, date, no links', () => {
  const d = draftFromItem({ ...item('x', 0.88, 1), date: '2026-09-11' });
  assert.match(d.text, /Sauti za Busara — Zanzibar, 11 September 2026/); assert.match(d.text, /What I'd do:/);
  assert.match(d.text, /— Tim, Beyond Paradise Adventures/); assert.doesNotMatch(d.text, /https?:/); assert.equal(brandGuard(d.text), null);
});
test('brandGuard rejects the short brand name and links', async () => {
  assert.match(brandGuard('Hello from Beyond Paradise today'), /in full/); assert.equal(brandGuard('Beyond Paradise Adventures'), null);
  // links are gated by config.includeLinks (false until the site went live on 2026-09-14)
  const { CONFIG } = await import('./lib.js');
  if (CONFIG.includeLinks) assert.equal(brandGuard('see https://beyondparadiseadventures.com/x'), null); else assert.match(brandGuard('see https://x.y'), /links are disabled/);
});
test('draftFromForecast renders both regions', () => {
  const d = draftFromForecast({ date: '2026-09-13', forecasts: [{ region: 'zanzibar', direction: 'rising', confidence: 0.82, drivers: ['Peak dry season'] }, { region: 'dar-es-salaam', direction: 'rising', confidence: 0.82, drivers: [] }] });
  assert.match(d.text, /Zanzibar: rising \(82% confidence\) — Peak dry season/); assert.match(d.text, /Dar es Salaam: rising/); assert.equal(d.kind, 'outlook');
});
test('parseCommand handles the bpa family', () => {
  assert.deepEqual(parseCommand('bpa'), { cmd: 'list' }); assert.deepEqual(parseCommand('BPA approve b1 B2'), { cmd: 'approve', ids: ['B1', 'B2'] });
  assert.deepEqual(parseCommand('bpa skip b3'), { cmd: 'skip', ids: ['B3'] }); assert.equal(parseCommand('bpa edit B1: new words').text, 'new words');
  assert.deepEqual(parseCommand('bpa post b2 now'), { cmd: 'postnow', ids: ['B2'] }); assert.equal(parseCommand('bpa dance').cmd, 'unknown');
});
test('nextSlots skips days already scheduled and is one per day', () => {
  const now = new Date('2026-09-13T12:00:00Z');
  const q = { drafts: [{ status: STATUS.SCHEDULED, scheduledFor: '2026-09-14T09:00:00+03:00' }] };
  const s = nextSlots(q, 2, now); assert.deepEqual(s, ['2026-09-15T09:00:00+03:00', '2026-09-16T09:00:00+03:00']);
});
test('renderList shows commands', () => { assert.match(renderList({ drafts: [{ id: 'B1', status: STATUS.PENDING, kind: 'outlook', sourceDate: '2026-09-13', text: 'x' }] }), /bpa approve B1 B2/); });
import { cardSpec } from './lib.js';
test('cardSpec derives label/headline/tag/lines from a draft', () => {
  const d = { id: 'B1', kind: 'outlook', region: 'all', sourceDate: '2026-09-13', text: 'Demand outlook, next 8 weeks — 13 September 2026\n\nZanzibar: rising (82% confidence) — Peak dry season\nDar es Salaam: rising (82% confidence)\n\nThis is what my intelligence engine reads.\n— Tim, Beyond Paradise Adventures\n\n#BeyondParadiseAdventures' };
  const s = cardSpec(d); assert.equal(s.headline, 'Demand outlook, next 8 weeks'); assert.equal(s.date, '13 September 2026'); assert.match(s.tag, /Zanzibar & Dar/); assert.equal(s.lines.length, 2); assert.equal(s.label, 'Demand outlook · next 8 weeks');
});
import { outlookIsFresh, outlookSignature } from './lib.js';
test('outlook is drafted only when content changes or 14 days passed', () => {
  const fc = { date: '2026-09-14', forecasts: [{ region: 'zanzibar', direction: 'rising', drivers: ['Peak dry season'] }] };
  const sig = outlookSignature(fc); const now = new Date('2026-09-14T04:00:00Z');
  assert.equal(outlookIsFresh(fc, [], now), true);
  assert.equal(outlookIsFresh(fc, [{ kind: 'outlook', signature: sig, createdAt: '2026-09-13T13:55:00Z' }], now), false, 'same content → no');
  assert.equal(outlookIsFresh(fc, [{ kind: 'outlook', signature: 'other', createdAt: '2026-09-13T13:55:00Z' }], now), false, 'different content but <14 days → no');
  assert.equal(outlookIsFresh(fc, [{ kind: 'outlook', signature: 'other', createdAt: '2026-08-20T13:55:00Z' }], now), true, 'different content and 14+ days → yes');
});

// ── audit fixes (2026-11): queue lock/merge, publish claim, source gate, tz slots, auth, pinned CDN, no PII default ──
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { stuckIgPublishes, markStuckAlerted, withQueueLock, mergeQueue, claimIgPublish, loadQueue, saveQueue, sourceGate, buildDrafts, whatsapp } from './lib.js';
import { authorize } from './auth.js';
import { buildComposition } from './video.js';
const tmpq = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bpaq-')), 'queue.json');
test('withQueueLock runs concurrent critical sections serially', async () => {
  const lockPath = tmpq() + '.lock'; let active = 0, max = 0; const order = [];
  const job = (n) => withQueueLock(async () => { active++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, 30)); order.push(n); active--; }, { lockPath, pollMs: 5 });
  await Promise.all([job(1), job(2), job(3)]); assert.equal(max, 1); assert.equal(order.length, 3); assert.equal(fs.existsSync(lockPath), false);
});
test('withQueueLock breaks a stale lock', async () => {
  const lockPath = tmpq() + '.lock'; fs.writeFileSync(lockPath, '1'); const old = new Date(Date.now() - 3600e3); fs.utimesSync(lockPath, old, old);
  assert.equal(await withQueueLock(async () => 'ok', { lockPath, staleMs: 1000 }), 'ok');
});
test('withQueueLock never deletes a lock it no longer owns', async () => {
  const lockPath = tmpq() + '.lock';
  await withQueueLock(async () => { fs.unlinkSync(lockPath); fs.writeFileSync(lockPath, 'other-owner'); }, { lockPath });
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'other-owner', "another process's lock survives our release");
});
test('withQueueLock: concurrent waiters on one stale lock still run one at a time', async () => {
  const lockPath = tmpq() + '.lock'; fs.writeFileSync(lockPath, 'dead'); const old = new Date(Date.now() - 3600e3); fs.utimesSync(lockPath, old, old);
  let active = 0, max = 0;
  const job = () => withQueueLock(async () => { active++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, 20)); active--; }, { lockPath, staleMs: 1000, pollMs: 2 });
  await Promise.all([job(), job(), job(), job()]); assert.equal(max, 1); assert.equal(fs.existsSync(lockPath), false);
  assert.deepEqual(fs.readdirSync(path.dirname(lockPath)).filter((f) => f.includes('.stale')), [], 'no stale leftovers');
});
test('worker snapshot save does not undo a skip made by the approval server', () => {
  const base = { drafts: [{ id: 'B1', status: STATUS.PENDING, text: 'a' }, { id: 'B2', status: STATUS.SCHEDULED, postId: null }], state: {} };
  const mine = JSON.parse(JSON.stringify(base)); mine.drafts[0].status = STATUS.EXPIRED; mine.drafts[1].status = STATUS.POSTED; mine.state.lastRunOk = 'now';
  const fresh = JSON.parse(JSON.stringify(base)); fresh.drafts[0].status = STATUS.SKIPPED; fresh.drafts[1].postId = 'p1';
  const m = mergeQueue(base, mine, fresh);
  assert.equal(m.drafts[0].status, STATUS.SKIPPED, 'server decision wins'); assert.equal(m.drafts[1].status, STATUS.POSTED, 'worker change kept'); assert.equal(m.drafts[1].postId, 'p1', 'server field kept'); assert.equal(m.state.lastRunOk, 'now');
});
test('claimIgPublish marks publishing once; a second claim gets nothing', async () => {
  const p = tmpq(); saveQueue({ seq: 1, drafts: [{ id: 'B1', status: STATUS.SCHEDULED, ig: { status: 'queued', at: 'x' } }] }, p);
  const first = await claimIgPublish('B1', new Date(), p); assert.equal(first.status, 'publishing'); assert.equal(loadQueue(p).drafts[0].ig.status, 'publishing');
  assert.equal(await claimIgPublish('B1', new Date(), p), null, 'already publishing → not republished');
});
test('sourceGate / buildDrafts reject signal drafts with fewer than 2 sources', async () => {
  const one = item('s1', 0.9, 1); one.sources = [{ id: 'a' }]; one.signal.sourceIds = ['a'];
  assert.match(sourceGate(draftFromItem({ ...one, date: '2026-09-11' })), /fewer than 2/); assert.equal(sourceGate(draftFromItem({ ...item('s2', 0.9, 1), date: '2026-09-11' })), null);
  const out = await buildDrafts({ briefs: [{ date: '2026-09-11', items: [one] }], existingDrafts: [] });
  assert.match(out[0].rejected, /fewer than 2/);
});
test('nextSlots uses the Africa/Dar_es_Salaam day, not the UTC day', () => {
  const s = nextSlots({ drafts: [] }, 1, new Date('2026-11-02T22:30:00Z')); assert.deepEqual(s, ['2026-11-04T09:00:00+03:00']);
  const t = nextSlots({ drafts: [{ status: STATUS.SCHEDULED, scheduledFor: '2026-11-04T09:00:00+03:00' }] }, 1, new Date('2026-11-02T22:30:00Z')); assert.deepEqual(t, ['2026-11-05T09:00:00+03:00']);
});
test('authorize: fail closed, host, content-type and token checks', () => {
  const req = (h) => ({ headers: { host: '127.0.0.1:3028', 'content-type': 'application/json', 'x-bpa-token': 's3cret', ...h } });
  assert.equal(authorize(req(), {}).code, 503); assert.equal(authorize(req(), {}).ok, false);
  const env = { BPA_APPROVAL_TOKEN: 's3cret' };
  assert.equal(authorize(req({ host: 'evil.example:3028' }), env).code, 403); assert.equal(authorize(req({ host: '127.0.0.1:9999' }), env).code, 403);
  assert.equal(authorize(req({ 'x-bpa-token': undefined }), env).code, 401); assert.equal(authorize(req({ 'x-bpa-token': 'wrong' }), env).code, 401);
  assert.equal(authorize(req({ 'content-type': 'text/plain' }), env).code, 415);
  assert.equal(authorize(req(), env).ok, true); assert.equal(authorize(req({ host: 'localhost:3028' }), env).ok, true);
});
test('reel composition loads only version-pinned CDN scripts', () => {
  const html = buildComposition({ headline: 'h', lines: [], brand: 'b', label: 'l', tag: 't', date: 'd' });
  for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) assert.match(m[1], /@\d+\.\d+\.\d+\//, `unpinned script: ${m[1]}`);
});
test('whatsapp() fails closed without WHATSAPP_ALERT_TO and no phone number is committed', async () => {
  const prev = process.env.WHATSAPP_ALERT_TO; delete process.env.WHATSAPP_ALERT_TO; process.env.BPA_QUIET = '1';
  assert.equal(await whatsapp('x'), false); if (prev) process.env.WHATSAPP_ALERT_TO = prev;
  assert.doesNotMatch(fs.readFileSync(new URL('./lib.js', import.meta.url), 'utf8'), /\+255\d{6,}/);
});

test('stuck IG publish is alerted once per draft, not on every run', () => {
  const now = new Date('2026-11-01T10:00:00Z');
  const q = { drafts: [
    { id: 'B1', ig: { status: 'publishing', publishingAt: '2026-11-01T09:00:00Z' } },
    { id: 'B2', ig: { status: 'publishing', publishingAt: '2026-11-01T09:50:00Z' } },
    { id: 'B3', ig: { status: 'posted' } }] };
  assert.deepEqual(stuckIgPublishes(q, now), ['B1'], 'only >30 min in publishing');
  markStuckAlerted(q, ['B1'], now);
  assert.equal(q.drafts[0].ig.stuckAlertedAt, now.toISOString()); assert.equal(q.drafts[0].ig.status, 'publishing', 'status untouched (human verifies on Meta)');
  assert.deepEqual(stuckIgPublishes(q, new Date('2026-11-01T16:00:00Z')), ['B2'], 'B1 already alerted → silent; B2 newly stuck');
});

test('a re-claimed IG publish that gets stuck again is alerted again (old stuckAlertedAt does not silence it)', async () => {
  const p = tmpq(); const t0 = new Date('2026-11-01T09:00:00Z');
  saveQueue({ drafts: [{ id: 'B1', status: STATUS.SCHEDULED, ig: { status: 'queued' } }], state: {} }, p);
  await claimIgPublish('B1', t0, p);
  let q = loadQueue(p); assert.deepEqual(stuckIgPublishes(q, new Date('2026-11-01T10:00:00Z')), ['B1']);
  markStuckAlerted(q, ['B1'], new Date('2026-11-01T10:00:00Z'));
  q.drafts[0].ig.status = 'queued'; saveQueue(q, p); // human reset after checking Meta
  await claimIgPublish('B1', new Date('2026-11-02T09:00:00Z'), p);
  q = loadQueue(p); assert.deepEqual(stuckIgPublishes(q, new Date('2026-11-02T10:00:00Z')), ['B1']);
});
