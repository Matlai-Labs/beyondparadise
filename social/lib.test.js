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
test('brandGuard rejects the short brand name and links', () => {
  assert.match(brandGuard('Hello from Beyond Paradise today'), /in full/); assert.match(brandGuard('see https://x.y'), /links are disabled/); assert.equal(brandGuard('Beyond Paradise Adventures'), null);
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
