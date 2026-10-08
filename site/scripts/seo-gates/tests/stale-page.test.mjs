import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeStale, analyzeDoc } from '../stale-page.mjs';

const today = '2026-10-08';

test('visible "Last updated" older than 180 days is stale; fresh one is not', () => {
  const old = analyzeDoc({ id: '/a', kind: 'html', content: '<body><p>Last updated: 3 February 2026</p></body>' }, { today });
  assert.ok(old.some((f) => f.rule === 'stale-date'));
  const fresh = analyzeDoc({ id: '/b', kind: 'html', content: '<body><p>Last updated: 1 September 2026</p></body>' }, { today });
  assert.ok(!fresh.some((f) => f.rule === 'stale-date'));
});

test('JSON-LD dateModified and markdown frontmatter updated are read', () => {
  const ld = '<script type="application/ld+json">{"@type":"Article","dateModified":"2025-01-02"}</script>';
  assert.ok(analyzeDoc({ id: '/c', kind: 'html', content: ld }, { today }).some((f) => f.rule === 'stale-date'));
  const md = '---\ntitle: X\nupdated: 2024-06-01\n---\nBody';
  assert.ok(analyzeDoc({ id: 'x.md', kind: 'md', content: md }, { today }).some((f) => f.rule === 'stale-date'));
  assert.ok(analyzeDoc({ id: 'y.md', kind: 'md', content: '---\nupdated: 2026-09-30\n---\nBody' }, { today }).every((f) => f.rule !== 'stale-date'));
});

test('localised "aktualisiert" label is read', () => {
  const f = analyzeDoc({ id: '/de', kind: 'html', content: '<p>Zuletzt aktualisiert: 1. Januar 2025</p>' }, { today });
  assert.ok(f.some((x) => x.rule === 'stale-date'));
});

test('past period / season range in a rates sentence is flagged (WildToSea 2024/25 incident)', () => {
  const f = analyzeDoc({ id: '/fees', kind: 'md', content: 'Park fees for the 2024/25 rates apply to all visitors.\n' }, { today });
  assert.ok(f.some((x) => x.rule === 'past-period' && /2024\/25/.test(x.excerpt)));
});

test('ISO dates and current season are NOT flagged as periods', () => {
  const f = analyzeDoc({ id: '/ok', kind: 'md', content: 'Checked 2026-10-08. The 2026/27 fee schedule applies.\n' }, { today });
  assert.deepEqual(f.filter((x) => x.rule === 'past-period'), []);
});

test('past year in future tense is an error; past start date is flagged', () => {
  const f = analyzeDoc({ id: '/t', kind: 'md', content: 'The new terminal will open in 2025.\nThe route starts on 1 July 2025.\n' }, { today });
  assert.ok(f.some((x) => x.rule === 'past-year-future-tense' && x.severity === 'error'));
  assert.ok(f.some((x) => x.rule === 'past-start-date'));
});

test('a future start date is fine', () => {
  const f = analyzeDoc({ id: '/t2', kind: 'md', content: 'The route starts on 29 May 2027.\n' }, { today });
  assert.deepEqual(f, []);
});

test('analyzeStale walks a directory', async () => {
  const { makeSite } = await import('./helpers.mjs');
  const dir = makeSite({ 'a.md': '---\nupdated: 2020-01-01\n---\nhi', 'b/c.html': '<p>fine</p>' });
  const r = analyzeStale([dir], { today });
  assert.equal(r.filter((f) => f.rule === 'stale-date').length, 1);
});
