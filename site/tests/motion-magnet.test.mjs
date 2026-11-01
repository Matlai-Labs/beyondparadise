import test from 'node:test';
import assert from 'node:assert/strict';
import { magnetOffset, MAGNET_DEFAULTS } from '../src/lib/motion/magnet.mjs';

const rect = { left: 100, top: 100, width: 200, height: 100 }; // centre (200, 150)
const hypot = (o) => Math.hypot(o.x, o.y);

test('pointer at the element centre produces no offset', () => {
  assert.deepEqual(magnetOffset({ pointerX: 200, pointerY: 150, rect }), { x: 0, y: 0 });
});

test('offset points towards the pointer and scales with strength', () => {
  const o = magnetOffset({ pointerX: 300, pointerY: 150, rect, strength: 0.2, maxOffset: 100 });
  assert.equal(o.y, 0);
  assert.ok(o.x > 0, 'pulls right towards the pointer');
  assert.equal(o.x, 20); // 100 px away * 0.2
});

test('a pointer up and to the left pulls up and to the left', () => {
  const o = magnetOffset({ pointerX: 150, pointerY: 100, rect, strength: 0.5, maxOffset: 100 });
  assert.ok(o.x < 0 && o.y < 0);
});

test('offset magnitude is clamped radially, not per axis', () => {
  // 1000 px away on both axes: a per-axis clamp would give (8, 8) => magnitude 11.3 > 8.
  const o = magnetOffset({ pointerX: 1200, pointerY: 1150, rect, strength: 1, maxOffset: 8 });
  assert.ok(hypot(o) <= 8 + 1e-9, `magnitude ${hypot(o)} must not exceed maxOffset 8`);
  assert.ok(hypot(o) > 7.9, 'a far pointer should saturate the clamp');
  // direction preserved by the clamp
  assert.ok(Math.abs(o.x - o.y) < 1e-9, 'equal-distance axes stay equal after clamping');
});

test('clamp holds for every direction and distance', () => {
  for (const px of [-5000, -300, 0, 199, 200, 201, 5000]) {
    for (const py of [-5000, -300, 0, 149, 150, 151, 5000]) {
      const o = magnetOffset({ pointerX: px, pointerY: py, rect, strength: 1, maxOffset: 12 });
      assert.ok(hypot(o) <= 12 + 1e-9, `(${px},${py}) gave magnitude ${hypot(o)}`);
      assert.ok(Number.isFinite(o.x) && Number.isFinite(o.y), `(${px},${py}) produced a non-finite offset`);
    }
  }
});

test('strength is clamped into 0..1 so a bad config cannot amplify the pull', () => {
  const big = magnetOffset({ pointerX: 300, pointerY: 150, rect, strength: 50, maxOffset: 100 });
  assert.equal(big.x, 100, 'strength > 1 is treated as 1 (100 px away => 100), then clamped');
  const neg = magnetOffset({ pointerX: 300, pointerY: 150, rect, strength: -3, maxOffset: 100 });
  assert.deepEqual(neg, { x: 0, y: 0 }, 'negative strength must not invert the pull');
});

test('a negative or zero maxOffset yields no movement', () => {
  assert.deepEqual(magnetOffset({ pointerX: 999, pointerY: 999, rect, maxOffset: 0 }), { x: 0, y: 0 });
  assert.deepEqual(magnetOffset({ pointerX: 999, pointerY: 999, rect, maxOffset: -10 }), { x: 0, y: 0 });
});

test('a degenerate or missing rect yields no movement rather than NaN', () => {
  for (const bad of [undefined, null, {}, { left: 0, top: 0, width: 0, height: 0 },
                     { left: NaN, top: 0, width: 10, height: 10 }]) {
    assert.deepEqual(magnetOffset({ pointerX: 10, pointerY: 10, rect: bad }), { x: 0, y: 0 },
      `rect ${JSON.stringify(bad)} should produce no offset`);
  }
});

test('non-finite pointer coordinates yield no movement', () => {
  for (const [px, py] of [[NaN, 0], [0, NaN], [Infinity, 0], [undefined, undefined]]) {
    assert.deepEqual(magnetOffset({ pointerX: px, pointerY: py, rect }), { x: 0, y: 0 });
  }
});

test('defaults are conservative enough to stay a nudge', () => {
  assert.ok(MAGNET_DEFAULTS.strength > 0 && MAGNET_DEFAULTS.strength <= 0.5);
  assert.ok(MAGNET_DEFAULTS.maxOffset > 0 && MAGNET_DEFAULTS.maxOffset <= 12,
    'a large pull would move the CTA away from the cursor the user is aiming at');
});

test('offsets are rounded to hundredths so style writes stay short and stable', () => {
  const o = magnetOffset({ pointerX: 233, pointerY: 177, rect, strength: 0.3133, maxOffset: 100 });
  assert.equal(o.x, Number(o.x.toFixed(2)));
  assert.equal(o.y, Number(o.y.toFixed(2)));
});
