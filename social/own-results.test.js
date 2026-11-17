import './test-env.js';
// Own Instagram results as a small, bounded nudge for the idea ranking: topic median reach against the account median, capped at +-5, only with 4+ posts and a state not older than 14 days.
import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { topicAdjustments, MAX_ADJUST, MIN_TOPIC_POSTS } from './insights.js';
import { buildIdeaPool, loadInputs } from './ideas.js';

const NOW = new Date('2026-11-17T10:00:00Z');
const topicMap = { 'fact:a1': 'beaches', 'fact:a2': 'beaches', 'fact:a3': 'beaches', 'fact:a4': 'beaches', 'fact:a5': 'beaches', 'fact:a6': 'beaches', 'fact:b1': 'safari', 'fact:b2': 'safari', 'fact:b3': 'safari' };
const topicOfSource = (s) => topicMap[s] ?? null;
/** n posts of a topic (sourceIds fact:<prefix>1..n) with the given reach each, plus `others` posts with no queue item. */
function world({ beaches = [], safari = [], others = [], fetchedAt = '2026-11-15T00:00:00Z' } = {}) {
  const media = [], drafts = []; let n = 0;
  const add = (prefix, reaches) => reaches.forEach((reach, i) => { n++; media.push({ id: `m${n}`, reach, queueId: `B${n}` }); drafts.push({ id: `B${n}`, sourceId: `fact:${prefix}${i + 1}` }); });
  add('a', beaches); add('b', safari); others.forEach((reach) => { n++; media.push({ id: `m${n}`, reach, queueId: null }); });
  return { state: { fetchedAt, media }, queue: { drafts } };
}

test('a topic with 6 posts and a median far above the account median gets the capped +5 and a plain reason', () => {
  const w = world({ beaches: [400, 410, 420, 400, 410, 500], others: [100, 110, 120, 130, 90, 80, 100, 100, 100, 100, 100, 100, 100, 100] });
  const m = topicAdjustments({ ...w, topicOfSource, now: NOW }); const a = m.get('beaches');
  assert.equal(a.adjust, MAX_ADJUST); assert.match(a.reason, /^own results: topic median reach 410 against \d+(\.\d+)?, 6 posts \(\+5\)$/);
});
test('a weak topic is nudged down in proportion, never below -5', () => {
  const mid = world({ beaches: [60, 60, 60, 60], others: [120, 120, 120, 120, 120, 120, 120, 120, 120, 120] }); // topic 60 vs account median 120: ratio .5 -> -2.5
  assert.equal(topicAdjustments({ ...mid, topicOfSource, now: NOW }).get('beaches').adjust, -2.5);
  const low = world({ beaches: [0, 0, 0, 0], others: [500, 500, 500, 500, 500, 500, 500, 500, 500, 500] }); assert.equal(topicAdjustments({ ...low, topicOfSource, now: NOW }).get('beaches').adjust, -MAX_ADJUST);
});
test('fewer than 4 posts of a topic: no adjustment for it', () => {
  const w = world({ beaches: [900, 900, 900], safari: [900, 900, 900], others: [10, 10, 10, 10, 10] });
  assert.equal(MIN_TOPIC_POSTS, 4); assert.equal(topicAdjustments({ ...w, topicOfSource, now: NOW }).size, 0);
});
test('a state older than 14 days, a missing state and a broken state give no adjustment and no error', () => {
  const ok = world({ beaches: [400, 400, 400, 400], others: [100, 100, 100, 100, 100, 100] });
  assert.equal(topicAdjustments({ ...ok, topicOfSource, now: NOW }).size, 1);
  const old = world({ beaches: [400, 400, 400, 400], others: [100, 100, 100, 100, 100, 100], fetchedAt: '2026-11-02T09:00:00Z' }); assert.equal(topicAdjustments({ ...old, topicOfSource, now: NOW }).size, 0, '15 days old');
  const edge = world({ beaches: [400, 400, 400, 400], others: [100, 100, 100, 100, 100, 100], fetchedAt: '2026-11-03T10:00:00Z' }); assert.equal(topicAdjustments({ ...edge, topicOfSource, now: NOW }).size, 1, 'exactly 14 days still counts');
  for (const bad of [null, undefined, {}, { media: 'x' }, { fetchedAt: 'not a date', media: [] }, 'text']) assert.equal(topicAdjustments({ state: bad, queue: ok.queue, topicOfSource, now: NOW }).size, 0);
  assert.equal(topicAdjustments({ state: ok.state, queue: null, topicOfSource, now: NOW }).size, 0); assert.equal(topicAdjustments({ state: ok.state, queue: ok.queue, topicOfSource: () => { throw new Error('x'); }, now: NOW }).size, 0);
});
test('media without a queue item or without reach do not count as posts of a topic', () => {
  const w = world({ beaches: [400, 400, 400], others: [100, 100, 100, 100] }); w.state.media.push({ id: 'z', reach: null, queueId: 'B1' }, { id: 'y', reach: 400, queueId: null });
  assert.equal(topicAdjustments({ ...w, topicOfSource, now: NOW }).size, 0);
});

const fact = (o) => ({ id: 'f1', topic: 'beaches', region: 'zanzibar', claim: 'A beach claim', value: 'The beach is long.', sources: ['a', 'b'], status: 'confirmed', lastChecked: '2026-10-01', ...o });
const poolWorld = () => { // 4 posted beach facts (dropped from the pool as repeats, but their topic is still known), one fresh beach fact, one fresh safari fact
  const facts = [fact({ id: 'a1' }), fact({ id: 'a2' }), fact({ id: 'a3' }), fact({ id: 'a4' }), fact({ id: 'n1' }), fact({ id: 's1', topic: 'safari', claim: 'A safari claim', value: 'The park is big.' })];
  const history = ['a1', 'a2', 'a3', 'a4'].map((i) => ({ sourceId: `fact:${i}`, date: '2026-11-01' }));
  const media = [{ id: 'm1', reach: 500, queueId: 'B1' }, { id: 'm2', reach: 500, queueId: 'B2' }, { id: 'm3', reach: 500, queueId: 'B3' }, { id: 'm4', reach: 500, queueId: 'B4' }, ...Array.from({ length: 8 }, (_, i) => ({ id: `o${i}`, reach: 100, queueId: null }))];
  const queue = { drafts: ['a1', 'a2', 'a3', 'a4'].map((i, k) => ({ id: `B${k + 1}`, sourceId: `fact:${i}` })) };
  return { facts, history, own: { state: { fetchedAt: '2026-11-16T00:00:00Z', media }, queue } };
};
test('buildIdeaPool adds the adjustment to the score of an idea of that topic and says so in reasons; other topics are untouched', () => {
  const { facts, history, own } = poolWorld();
  const base = buildIdeaPool({ facts, history, now: NOW }); const withOwn = buildIdeaPool({ facts, history, now: NOW, own });
  const b = (r, id) => r.ideas.find((i) => i.sourceId === id);
  assert.equal(base.ideas.length, 2); assert.equal(withOwn.ideas.length, 2);
  assert.equal(b(withOwn, 'fact:n1').score, Math.round((b(base, 'fact:n1').score + 5) * 1000) / 1000);
  assert.ok(b(withOwn, 'fact:n1').reasons.some((r) => /^own results: topic median reach 500 against 100, 4 posts \(\+5\)$/.test(r)));
  assert.equal(b(withOwn, 'fact:s1').score, b(base, 'fact:s1').score); assert.deepEqual(b(withOwn, 'fact:s1').reasons, b(base, 'fact:s1').reasons);
});
test('buildIdeaPool without own results is exactly what it was, and an own object with a broken state changes nothing', () => {
  const { facts, history, own } = poolWorld(); const base = buildIdeaPool({ facts, history, now: NOW });
  assert.deepEqual(buildIdeaPool({ facts, history, now: NOW, own: { state: null, queue: own.queue } }), base);
  assert.deepEqual(buildIdeaPool({ facts, history, now: NOW, own: { state: { fetchedAt: '2026-01-01T00:00:00Z', media: own.state.media }, queue: own.queue } }), base, 'stale state');
  assert.deepEqual(buildIdeaPool({ facts, history, now: NOW, own: 'junk' }), base);
});
test('loadInputs reads the injected insights file; a missing or unreadable one gives own.state null', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-own-')); const f = path.join(root, 'ins.json');
  assert.equal(loadInputs({ root, insightsFile: f }).own.state, null);
  fs.writeFileSync(f, '{broken'); assert.equal(loadInputs({ root, insightsFile: f }).own.state, null);
  fs.writeFileSync(f, JSON.stringify({ fetchedAt: '2026-11-16T00:00:00Z', media: [] })); assert.deepEqual(loadInputs({ root, insightsFile: f }).own.state.media, []);
  assert.equal(loadInputs({ root }).own.state, null, 'the default path is the throwaway state folder of the test setup: nothing there');
});
