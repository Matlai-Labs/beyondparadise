/* ------------------------------------------------------------------------------------------------
 * VENDORED PATTERN — source note
 * Pattern: Agent OS `docs/design/interaction-patterns` (magnetic-CTA offset maths).
 * Copied as code into this repo on purpose: product repos never import from Agent OS, and Agent OS
 * is not reachable from the cloud VM this was written in. Written independently to the same written
 * spec as masterplan build #3, which implements the pattern in parallel. Keep in step by hand.
 *
 * Spec: given a pointer position and the element's box, return the translate offset that nudges the
 * element towards the pointer. Pure — no DOM, no globals, no time. The caller writes the result into
 * --bp-magnet-x / --bp-magnet-y; CSS owns the transform, so the browser stays on the compositor and
 * the effect cannot contribute to CLS (see plan section 2, "CLS — what is safe to animate").
 *
 * Two deliberate choices:
 *  - The clamp is RADIAL (on the vector's magnitude), not per-axis. A per-axis clamp lets a diagonal
 *    pointer move the element maxOffset*sqrt(2) from its origin, which overshoots the budget and
 *    looks lopsided. Clamping the magnitude preserves direction and respects the budget exactly.
 *  - Every degenerate input returns {x:0, y:0} rather than NaN. A NaN reaching a custom property
 *    makes the whole transform invalid, which would make the CTA jump — far worse than no motion.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Conservative defaults. The pull is a nudge: a strong magnet fights the user, because the element
 * moves away from the point they are aiming at and the click target slides out from under them.
 */
export const MAGNET_DEFAULTS = Object.freeze({
  strength: 0.18,
  maxOffset: 8, // px
});

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const NONE = Object.freeze({ x: 0, y: 0 });

/**
 * Quantise to 2 dp by truncating TOWARDS ZERO, not rounding to nearest.
 *
 * This matters: quantising happens after the radial clamp, and rounding to nearest can push the
 * magnitude back over the cap. With maxOffset 8 and a 45° pointer the clamp yields x=y=5.65685;
 * round-to-nearest gives 5.66 and hypot(5.66, 5.66) = 8.0045 — over budget. Truncation can only
 * move a component closer to zero, so the clamp invariant |offset| <= maxOffset always survives it.
 */
const trunc2 = (n) => Math.trunc(n * 100) / 100;

/**
 * Translate offset pulling an element towards the pointer.
 *
 * @param {object}  args
 * @param {number}  args.pointerX  pointer X in the same space as `rect` (viewport coords)
 * @param {number}  args.pointerY  pointer Y in the same space as `rect`
 * @param {{left:number, top:number, width:number, height:number}} args.rect  element box
 * @param {number} [args.strength]   fraction of the centre→pointer distance to travel, clamped 0..1
 * @param {number} [args.maxOffset]  hard cap on the offset's magnitude, in px
 * @returns {{x:number, y:number}}   always finite; {0,0} when anything is unusable
 */
export function magnetOffset({ pointerX, pointerY, rect, strength, maxOffset } = {}) {
  if (!rect) return { ...NONE };
  const { left, top, width, height } = rect;
  if (![left, top, width, height].every(finite)) return { ...NONE };
  if (width <= 0 || height <= 0) return { ...NONE };
  if (!finite(pointerX) || !finite(pointerY)) return { ...NONE };

  const cap = finite(maxOffset) ? maxOffset : MAGNET_DEFAULTS.maxOffset;
  if (cap <= 0) return { ...NONE };

  const rawStrength = finite(strength) ? strength : MAGNET_DEFAULTS.strength;
  const pull = Math.min(1, Math.max(0, rawStrength));
  if (pull === 0) return { ...NONE };

  const dx = (pointerX - (left + width / 2)) * pull;
  const dy = (pointerY - (top + height / 2)) * pull;

  const magnitude = Math.hypot(dx, dy);
  if (magnitude === 0) return { ...NONE };

  // Radial clamp: scale the whole vector down so its length is at most `cap`, keeping direction.
  const scale = magnitude > cap ? cap / magnitude : 1;
  return { x: trunc2(dx * scale), y: trunc2(dy * scale) };
}
