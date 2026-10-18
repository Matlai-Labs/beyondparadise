import { test } from 'node:test'; import assert from 'node:assert/strict';
import { RUBRIC, hookScore, scoreDraft, renderScore } from './score.js';
import { buildDrafts, renderList, STATUS } from './lib.js';

const GOOD = 'How many nights should you book in Zanzibar before the 15 December rush?\n\nPeak season fills Stone Town by 80% in three weeks, and rooms from $120 vanish first. Book your February dates now, because the festival weekend sells out every year and the good rooms go early. Send me a message and I will check which weeks are still open for your group, and which beaches are quiet then.\n\nDry season runs from June to October, with the warmest water in January and February. That is the window most guests regret missing.\n\nMessage me to plan your dates.\n\n#Zanzibar #Tanzania #BeyondParadiseAdventures';
const part = (s, id) => s.rubric.find((r) => r.id === id);

test('RUBRIC has 12 parts, 3 of them profile-level', () => {
  assert.equal(RUBRIC.length, 12);
  assert.equal(new Set(RUBRIC.map((r) => r.id)).size, 12);
  assert.equal(RUBRIC.filter((r) => r.test({}).pass === null).length, 3);
});
test('hookScore is high for a question/number hook', () => {
  const h = hookScore('How many nights should you book in Zanzibar before the 15 December rush?');
  assert.ok(h.score >= 8, `got ${h.score}`); assert.ok(Array.isArray(h.signals) && h.signals.length > 0);
});
test('hookScore is low for a hashtag-only first line', () => {
  assert.ok(hookScore('#Zanzibar #Tanzania\n\nSome text').score <= 3);
  assert.ok(hookScore('🌴🌴🌴').score <= 3);
  assert.equal(hookScore('').score, 0);
});
test('rubric marks CTA present and missing', () => {
  assert.equal(part(scoreDraft({ text: GOOD }), 'cta').pass, true);
  assert.equal(part(scoreDraft({ text: 'Zanzibar rooms are filling.\n\nNothing else to say.' }), 'cta').pass, false);
});
test('profile-level parts are null and excluded from applicable/total', () => {
  const s = scoreDraft({ text: GOOD });
  const prof = s.rubric.filter((r) => r.pass === null);
  assert.equal(prof.length, 3); assert.ok(prof.every((r) => /profile-level/.test(r.note)));
  assert.equal(s.applicable, 9);
  assert.ok(s.passed <= s.applicable);
  assert.ok(s.total >= 0 && s.total <= 100);
});
test('a good caption outscores a bad one', () => {
  assert.ok(scoreDraft({ text: GOOD }).total > scoreDraft({ text: '#Zanzibar' }).total);
});
test('scoreDraft never throws', () => {
  for (const bad of [{}, null, undefined, { text: 42 }, { text: { a: 1 } }, 'str']) {
    const s = scoreDraft(bad); assert.equal(typeof s.total, 'number'); assert.ok(s.total >= 0);
  }
  assert.equal(scoreDraft(null).total, 0);
});
test('renderScore format', () => {
  const line = renderScore(scoreDraft({ text: GOOD }));
  assert.match(line, /^score \d+\/100 · hook \d+\/10 · rubric \d+\/9/);
  const bad = renderScore(scoreDraft({ text: '#Zanzibar' })); assert.match(bad, /✗ /);
  assert.equal(renderScore(undefined), '');
});
test('buildDrafts output carries score; renderList shows it', async () => {
  const brief = { date: '2026-09-11', items: [{ signal: { id: 'x', subject: 'Sauti za Busara', region: 'zanzibar', summary: 'The festival dates were confirmed for February.', confidence: 0.9, magnitude: 1, sourceIds: ['a', 'b'] }, whyItMatters: 'Beds in Stone Town fill a month early.', whatToDo: 'Open February availability now.', confidence: 0.9, sources: [{ id: 'a' }, { id: 'b' }] }] };
  const out = await buildDrafts({ briefs: [brief], now: new Date('2026-09-12T00:00:00Z'), existingDrafts: [] });
  assert.equal(out.length, 1);
  const d = out[0];
  if (d.rejected) return; // voice-lint is a sibling-repo dependency; rejected drafts are not scored
  assert.equal(typeof d.score.total, 'number'); assert.equal(d.score.rubric.length, 12);
  assert.match(renderList({ drafts: [{ id: 'B1', status: STATUS.PENDING, kind: 'signal', sourceDate: '2026-09-11', text: 'x', score: d.score }] }), /score \d+\/100/);
});
