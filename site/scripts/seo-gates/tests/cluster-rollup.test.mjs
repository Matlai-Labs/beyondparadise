import test from 'node:test';
import assert from 'node:assert/strict';
import { rollup, renderMarkdown, loadClusterDefs } from '../cluster-rollup.mjs';

const defs = loadClusterDefs({
  clusters: [
    { name: 'honeymoon', match: ['/zanzibar-honeymoon*', 're:^/de/hochzeitsreise'] },
    { name: 'dining', match: ['/restaurant/*'] },
  ],
});
const cur = [
  { path: '/zanzibar-honeymoon-guide', clicks: 30, impressions: 1000, position: 4 },
  { path: '/de/hochzeitsreise-sansibar', clicks: 10, impressions: 1000, position: 8 },
  { path: '/restaurant/menu', clicks: 5, impressions: 100, position: 2 },
  { path: '/unmapped', clicks: 1, impressions: 10, position: 20 },
];
const prev = [
  { path: '/zanzibar-honeymoon-guide', clicks: 20, impressions: 800, position: 5 },
  { path: '/restaurant/menu', clicks: 8, impressions: 100, position: 2 },
];

test('rolls up clicks, impressions, CTR, impression-weighted position per cluster', () => {
  const r = rollup({ defs, current: cur });
  const h = r.clusters.find((c) => c.name === 'honeymoon');
  assert.equal(h.clicks, 40);
  assert.equal(h.impressions, 2000);
  assert.equal(h.ctr, 0.02);
  assert.equal(h.position, 6);
  assert.equal(h.pages, 2);
  assert.ok(r.clusters.find((c) => c.name === '(unclustered)'));
});

test('quarter-over-quarter delta incl. AI impressions and AI sessions', () => {
  const r = rollup({
    defs, current: cur, previous: prev,
    aiCurrent: [{ key: 'https://x.test/zanzibar-honeymoon-guide', impressions: 50, clicks: null }],
    aiPrevious: [{ key: 'https://x.test/zanzibar-honeymoon-guide', impressions: 20, clicks: null }],
    sessions: [{ path: '/zanzibar-honeymoon-guide', sessions: 6 }],
    sessionsPrevious: [{ path: '/zanzibar-honeymoon-guide', sessions: 2 }],
  });
  const h = r.clusters.find((c) => c.name === 'honeymoon');
  assert.equal(h.aiImpressions, 50);
  assert.equal(h.aiSessions, 6);
  assert.equal(h.delta.clicks.abs, 40 - 20);
  assert.equal(h.delta.aiImpressions.abs, 30);
  assert.equal(h.delta.aiSessions.abs, 4);
  const d = r.clusters.find((c) => c.name === 'dining');
  assert.equal(d.delta.clicks.abs, -3);
  assert.match(renderMarkdown(r), /honeymoon/);
});

test('engine cluster-definitions.json format (pillar/spokes) is accepted', () => {
  const eng = loadClusterDefs({ clusters: { 'boutique-hotel-zanzibar': { pillar: '/boutique-hotel-zanzibar', spokes: ['/services'] } } });
  const r = rollup({ defs: eng, current: [{ path: '/boutique-hotel-zanzibar/x', clicks: 1, impressions: 2, position: 1 }, { path: '/services', clicks: 1, impressions: 2, position: 1 }] });
  assert.equal(r.clusters.find((c) => c.name === 'boutique-hotel-zanzibar').pages, 2);
});
