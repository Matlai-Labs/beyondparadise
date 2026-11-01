import test from 'node:test';
import assert from 'node:assert/strict';
import { staggerDelay, staggerTable, STAGGER_DEFAULTS } from '../src/lib/motion/stagger.mjs';

test('the first item is never delayed', () => {
  assert.equal(staggerDelay(0), 0);
});

test('delay grows one step per index', () => {
  assert.equal(staggerDelay(1, { step: 120, max: 10000 }), 120);
  assert.equal(staggerDelay(2, { step: 120, max: 10000 }), 240);
  assert.equal(staggerDelay(3, { step: 120, max: 10000 }), 360);
});

test('the step matches the DESIGN.md stagger of 0.12 s', () => {
  // DESIGN.md "Animation System": staggerChildren: 0.12
  assert.equal(STAGGER_DEFAULTS.step, 120);
});

test('the tail is capped so a long list does not keep a user waiting', () => {
  const d = staggerDelay(500, { step: 120, max: 480 });
  assert.equal(d, 480);
  assert.ok(d <= 480);
});

test('the default cap keeps the whole sequence under half a second', () => {
  // Beyond ~0.5 s of accumulated delay the last card reads as broken, not choreographed.
  assert.ok(STAGGER_DEFAULTS.max <= 500, `max ${STAGGER_DEFAULTS.max} is too long a tail`);
  assert.equal(staggerDelay(999), STAGGER_DEFAULTS.max);
});

test('delay is monotonic non-decreasing across any index', () => {
  let prev = -1;
  for (let i = 0; i < 200; i++) {
    const d = staggerDelay(i);
    assert.ok(d >= prev, `index ${i} (${d}) went backwards from ${prev}`);
    assert.ok(Number.isInteger(d), `index ${i} produced a non-integer delay ${d}`);
    prev = d;
  }
});

test('negative, fractional and non-numeric indexes are coerced safely to no delay', () => {
  for (const bad of [-1, -99, NaN, Infinity, undefined, null, 'two', {}]) {
    assert.equal(staggerDelay(bad), 0, `index ${String(bad)} should give 0`);
  }
  assert.equal(staggerDelay(2.9, { step: 100, max: 9999 }), 200, 'fractional index floors');
});

test('a hostile config cannot produce a negative or non-finite delay', () => {
  for (const opts of [{ step: -100 }, { step: NaN }, { max: -5 }, { max: NaN },
                      { step: Infinity }, { step: 0 }]) {
    const d = staggerDelay(5, opts);
    assert.ok(Number.isInteger(d) && d >= 0, `opts ${JSON.stringify(opts)} gave ${d}`);
  }
});

test('max wins over step when the two conflict', () => {
  assert.equal(staggerDelay(5, { step: 1000, max: 200 }), 200);
});

test('staggerTable returns one delay per item, in order', () => {
  assert.deepEqual(staggerTable(4, { step: 120, max: 10000 }), [0, 120, 240, 360]);
  assert.deepEqual(staggerTable(0), []);
  assert.deepEqual(staggerTable(-3), []);
  assert.deepEqual(staggerTable('x'), []);
});

test('staggerTable respects the cap on a long list', () => {
  const t = staggerTable(10, { step: 120, max: 360 });
  assert.deepEqual(t, [0, 120, 240, 360, 360, 360, 360, 360, 360, 360]);
  assert.ok(t.every((d) => d <= 360));
});

test('staggerTable is bounded so a huge count cannot hang the build or the page', () => {
  const t = staggerTable(1e9);
  assert.ok(t.length <= STAGGER_DEFAULTS.maxItems,
    `table length ${t.length} should be capped at ${STAGGER_DEFAULTS.maxItems}`);
});
