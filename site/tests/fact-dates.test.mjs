import test from 'node:test';
import assert from 'node:assert/strict';
import { factVerifiedDate, oldestDate, newestDate } from '../src/lib/fact-dates.mjs';

const S = (accessed, tier = null) => ({ accessed, tier });

test('no tier-1 source: the OLDEST source date is the fact date (never the newest)', () => {
  assert.equal(factVerifiedDate([S('2026-10-08'), S('2026-06-28')], '2026-06-27'), '2026-06-28');
});
test('tier-1 source present: its date is used, but a stale tier-1 is not masked by a fresh secondary', () => {
  assert.equal(factVerifiedDate([S('2026-10-08', 1), S('2026-06-28'), S('2026-06-28')], ''), '2026-10-08');
  assert.equal(factVerifiedDate([S('2026-06-28', 1), S('2026-10-08')], ''), '2026-06-28');
});
test('missing source dates fall back to the fact lastChecked', () => {
  assert.equal(factVerifiedDate([S(''), S('')], '2026-06-27'), '2026-06-27');
});
test('no date anywhere throws', () => {
  assert.throws(() => factVerifiedDate([S('')], ''));
});
test('page-level labels: oldest and newest are computed, not global', () => {
  assert.equal(oldestDate(['2026-10-08', '2026-06-28', '2026-06-30']), '2026-06-28');
  assert.equal(newestDate(['2026-10-08', '2026-06-28']), '2026-10-08');
});
