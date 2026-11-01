/* ------------------------------------------------------------------------------------------------
 * VENDORED PATTERN — source note
 * Pattern: Agent OS `docs/design/interaction-patterns` (staggered reveal delay table).
 * Copied as code into this repo on purpose: product repos never import from Agent OS, and Agent OS
 * is not reachable from the cloud VM this was written in. Written independently to the same written
 * spec as masterplan build #3, which implements the pattern in parallel. Keep in step by hand.
 *
 * Spec: index -> transition-delay in ms. Pure. The caller writes the value into --bp-stagger and CSS
 * consumes it as `transition-delay`, which replaces the hardcoded .reveal-delay-1..4 ladder in
 * global.css. That ladder silently dropped the delay for any list longer than four items
 * (DestinationsSection and YouTubeSection both interpolate `reveal-delay-${i+1}`) — see plan
 * finding A4.
 *
 * Step is 120 ms to match DESIGN.md's documented `staggerChildren: 0.12`.
 *
 * The cap is the point of this module. An uncapped n*step means the 10th card waits 1.2 s and the
 * 30th waits 3.6 s, which users read as a broken page rather than choreography — and under WCAG SC
 * 2.2.2 a long self-starting animation is exactly what you do not want. Capping the tail keeps the
 * whole sequence inside MAX while preserving the leading cascade that carries the effect.
 * ---------------------------------------------------------------------------------------------- */

export const STAGGER_DEFAULTS = Object.freeze({
  step: 120, // ms per item — DESIGN.md staggerChildren: 0.12
  max: 480, // ms — the tail cap; the 5th item onwards all land together
  maxItems: 200, // hard bound on staggerTable() output length
});

/** Non-negative finite integer, or `fallback`. */
function count(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  return n >= 0 ? n : fallback;
}

/**
 * transition-delay in ms for the item at `index`.
 *
 * @param {number} index  0-based position; anything unusable is treated as 0 (no delay)
 * @param {{step?: number, max?: number}} [opts]
 * @returns {number} integer ms, >= 0, <= max
 */
export function staggerDelay(index, opts = {}) {
  const i = count(index, 0);
  if (i === 0) return 0;
  const step = count(opts.step, STAGGER_DEFAULTS.step);
  const max = count(opts.max, STAGGER_DEFAULTS.max);
  return Math.min(i * step, max);
}

/**
 * One delay per item, in order. Length is bounded by STAGGER_DEFAULTS.maxItems so a bad count
 * cannot allocate an enormous array at build time.
 *
 * @param {number} itemCount
 * @param {{step?: number, max?: number}} [opts]
 * @returns {number[]}
 */
export function staggerTable(itemCount, opts = {}) {
  const n = Math.min(count(itemCount, 0), STAGGER_DEFAULTS.maxItems);
  const table = new Array(n);
  for (let i = 0; i < n; i++) table[i] = staggerDelay(i, opts);
  return table;
}
