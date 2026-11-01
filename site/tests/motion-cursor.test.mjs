import test from 'node:test';
import assert from 'node:assert/strict';
import { cursorLabelPosition, resolveLabel, CURSOR_DEFAULTS } from '../src/lib/motion/cursor-label.mjs';

const VIEW = { viewportW: 1000, viewportH: 800 };
const LABEL = { labelW: 120, labelH: 32 };
const base = { ...VIEW, ...LABEL, offset: 16 };

const inside = (p, { labelW, labelH, viewportW, viewportH }) =>
  p.x >= 0 && p.y >= 0 && p.x + labelW <= viewportW && p.y + labelH <= viewportH;

test('in open space the label sits down-right of the pointer by the offset', () => {
  const p = cursorLabelPosition({ ...base, pointerX: 400, pointerY: 300 });
  assert.deepEqual(p, { x: 416, y: 316 });
});

test('near the right edge the label is pulled back inside, never clipped', () => {
  const p = cursorLabelPosition({ ...base, pointerX: 990, pointerY: 300 });
  assert.ok(inside(p, base), `label at ${JSON.stringify(p)} escaped the viewport`);
  assert.equal(p.x + base.labelW, base.viewportW);
});

test('near the bottom edge the label is pulled back inside', () => {
  const p = cursorLabelPosition({ ...base, pointerX: 400, pointerY: 795 });
  assert.ok(inside(p, base));
  assert.equal(p.y + base.labelH, base.viewportH);
});

test('in the bottom-right corner both axes are contained at once', () => {
  const p = cursorLabelPosition({ ...base, pointerX: 1000, pointerY: 800 });
  assert.ok(inside(p, base));
});

test('the label never escapes the viewport, for any pointer position', () => {
  for (const x of [-500, -1, 0, 1, 499, 999, 1000, 1001, 5000]) {
    for (const y of [-500, -1, 0, 1, 399, 799, 800, 801, 5000]) {
      const p = cursorLabelPosition({ ...base, pointerX: x, pointerY: y });
      assert.ok(inside(p, base), `pointer (${x},${y}) put the label at ${JSON.stringify(p)}`);
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `pointer (${x},${y}) gave non-finite`);
    }
  }
});

test('a label larger than the viewport is pinned to the origin rather than given a negative x', () => {
  // A negative x would widen the scroll box and could cost CLS; clamp to 0 instead.
  const p = cursorLabelPosition({ ...base, labelW: 2000, labelH: 1600, pointerX: 500, pointerY: 400 });
  assert.deepEqual(p, { x: 0, y: 0 });
});

test('missing or non-finite geometry yields the origin, never NaN', () => {
  for (const bad of [{}, { pointerX: NaN, pointerY: 0 }, { viewportW: 0, viewportH: 0 },
                     { viewportW: NaN }, { labelW: NaN }]) {
    const p = cursorLabelPosition({ ...base, pointerX: 100, pointerY: 100, ...bad });
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${JSON.stringify(bad)} gave ${JSON.stringify(p)}`);
    assert.ok(p.x >= 0 && p.y >= 0);
  }
  const none = cursorLabelPosition();
  assert.ok(Number.isFinite(none.x) && Number.isFinite(none.y));
});

test('positions are integers so the label lands on whole pixels', () => {
  const p = cursorLabelPosition({ ...base, pointerX: 123.7, pointerY: 456.3 });
  assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y));
});

// --- resolveLabel: reuse existing accessible names, never invent copy ------------------------

test('resolveLabel prefers an explicit data-cursor-label', () => {
  assert.equal(resolveLabel({ cursorLabel: 'Explore Mafia Island', ariaLabel: 'Other' }),
    'Explore Mafia Island');
});

test('resolveLabel falls back to the element aria-label, so no new copy is invented', () => {
  // Destination cards already carry aria-label="Explore Zanzibar" (DestinationsSection.astro).
  assert.equal(resolveLabel({ ariaLabel: 'Explore Zanzibar' }), 'Explore Zanzibar');
});

test('resolveLabel returns an empty string when there is nothing to show', () => {
  assert.equal(resolveLabel({}), '');
  assert.equal(resolveLabel(), '');
  assert.equal(resolveLabel({ ariaLabel: '   ' }), '');
  assert.equal(resolveLabel({ cursorLabel: '', ariaLabel: '' }), '');
});

test('resolveLabel trims and collapses whitespace', () => {
  assert.equal(resolveLabel({ ariaLabel: '  Explore \n  Zanzibar  ' }), 'Explore Zanzibar');
});

test('resolveLabel caps length so a long aria-label cannot blow up the overlay box', () => {
  const long = 'x'.repeat(500);
  const out = resolveLabel({ ariaLabel: long });
  assert.ok(out.length <= CURSOR_DEFAULTS.maxLabelChars,
    `label of ${out.length} chars exceeds the ${CURSOR_DEFAULTS.maxLabelChars} cap`);
});

test('resolveLabel coerces non-strings instead of throwing', () => {
  assert.equal(resolveLabel({ ariaLabel: 42 }), '42');
  assert.equal(resolveLabel({ ariaLabel: null, cursorLabel: undefined }), '');
});
