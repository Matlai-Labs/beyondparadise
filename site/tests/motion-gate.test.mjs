import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldEnhance, MOTION_QUERIES } from '../src/lib/motion/gate.mjs';

// A fake matchMedia: give it the set of queries that should report matches:true.
function mm(matching) {
  return (q) => ({ matches: matching.includes(q), media: q });
}

const MOUSE_OK = [MOTION_QUERIES.hover, MOTION_QUERIES.noPreference];

test('enhances only a hover-capable, fine-pointer device with no reduced-motion preference', () => {
  assert.equal(shouldEnhance({ matchMedia: mm(MOUSE_OK) }), true);
});

test('refuses when the user prefers reduced motion', () => {
  // hover is fine, but "reduce" is set: no-preference therefore does not match.
  assert.equal(shouldEnhance({ matchMedia: mm([MOTION_QUERIES.hover]) }), false);
});

test('refuses a touch device (no hover / coarse pointer) even with no motion preference', () => {
  assert.equal(shouldEnhance({ matchMedia: mm([MOTION_QUERIES.noPreference]) }), false);
});

test('refuses when neither query matches', () => {
  assert.equal(shouldEnhance({ matchMedia: mm([]) }), false);
});

test('the hover query tests the primary pointer, not any-hover', () => {
  // any-hover would wrongly match a desktop-with-touchscreen; see plan section 2.
  assert.match(MOTION_QUERIES.hover, /\(hover:\s*hover\)/);
  assert.match(MOTION_QUERIES.hover, /\(pointer:\s*fine\)/);
  assert.doesNotMatch(MOTION_QUERIES.hover, /any-hover|any-pointer/);
});

test('the motion query asks for no-preference rather than negating reduce', () => {
  // Asking for no-preference fails closed on a UA that does not know the feature.
  assert.match(MOTION_QUERIES.noPreference, /prefers-reduced-motion:\s*no-preference/);
});

test('fails closed when matchMedia is missing or throws', () => {
  assert.equal(shouldEnhance({ matchMedia: undefined }), false);
  assert.equal(shouldEnhance({}), false);
  assert.equal(shouldEnhance(), false);
  assert.equal(shouldEnhance({ matchMedia: () => { throw new Error('boom'); } }), false);
});

test('fails closed when matchMedia returns something unusable', () => {
  assert.equal(shouldEnhance({ matchMedia: () => undefined }), false);
  assert.equal(shouldEnhance({ matchMedia: () => ({}) }), false);
  // a truthy-but-not-true "matches" must not be accepted
  assert.equal(shouldEnhance({ matchMedia: () => ({ matches: 'yes' }) }), false);
});
