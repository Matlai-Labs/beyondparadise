import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { coverage, renderGapTable } from '../fanout-coverage.mjs';
import { makeSite, page } from './helpers.mjs';

const hub = {
  hub: '/honeymoon',
  spokes: ['/honeymoon/dinner'],
  questions: [
    { id: 'cost', q: 'How much does a honeymoon cost?', keywords: ['cost', 'price'], synonyms: ['rates', 'budget', 'per night'] },
    { id: 'halal', q: 'Is halal food available?', keywords: ['halal'], synonyms: ['muslim', 'pork-free'] },
    { id: 'ramadan', q: 'What happens during Ramadan?', keywords: ['ramadan'], synonyms: ['fasting'] },
  ],
};

test('questions answered by an H2/H3/FAQ on hub or spokes are covered; the rest are gaps', () => {
  const dir = makeSite({
    'honeymoon.html': page('H', [], '<h2>What does a honeymoon cost?</h2><p>x</p><h3>Budget tips</h3>'),
    'honeymoon/dinner.html': page('D', [], '<h2>Dinner</h2><details><summary>Is the menu halal?</summary></details>'),
  });
  const r = coverage(hub, dir);
  const by = Object.fromEntries(r.rows.map((x) => [x.id, x]));
  assert.equal(by.cost.covered, true);
  assert.equal(by.cost.where, '/honeymoon');
  assert.equal(by.halal.covered, true);
  assert.equal(by.halal.where, '/honeymoon/dinner');
  assert.equal(by.ramadan.covered, false);
  assert.deepEqual(r.gaps.map((g) => g.id), ['ramadan']);
  assert.match(renderGapTable(r), /ramadan/);
});

test('body text mentions alone do NOT count as answering (heading/FAQ required)', () => {
  const dir = makeSite({ 'honeymoon.html': page('H', [], '<h2>Overview</h2><p>We talk about Ramadan and halal here.</p>') });
  const r = coverage(hub, dir);
  assert.equal(r.gaps.length, 3);
});

test('seeded matlai-site question set is valid and includes the audit gaps', () => {
  const cfg = JSON.parse(fs.readFileSync(new URL('../fanout/matlai-site.json', import.meta.url), 'utf8'));
  const hubs = cfg.hubs.map((h) => h.hub);
  assert.ok(hubs.length >= 8);
  const ids = cfg.hubs.flatMap((h) => h.questions.map((q) => q.id));
  for (const need of ['halal', 'dietary', 'cancellation', 'weather', 'money', 'ramadan']) assert.ok(ids.includes(need), need);
  for (const h of cfg.hubs) for (const q of h.questions) assert.ok(q.keywords.length, q.id);
});
