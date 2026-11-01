/* ------------------------------------------------------------------------------------------------
 * VENDORED PATTERN — source note
 * Pattern: Agent OS `docs/design/interaction-patterns` (progressive-enhancement motion gate).
 * Copied as code into this repo on purpose: product repos never import from Agent OS, and Agent OS
 * is not reachable from the cloud VM this was written in. Written independently to the same written
 * spec as masterplan build #3, which implements the pattern in parallel. Keep in step by hand.
 *
 * Spec: motion is opt-in. Enhancement runs only when the primary pointer can hover AND is fine AND
 * the user has expressed no reduced-motion preference. Every other state, including "cannot tell",
 * must fail closed — no listeners attached, base experience untouched.
 *
 * Research behind the two queries (URLs in docs/reel11/bpa-motion-kit-plan.md section 2):
 *  - `hover`/`pointer` describe the PRIMARY input; `any-hover`/`any-pointer` describe any attached
 *    input, so a desktop with a touchscreen matches `any-hover: hover`. Using any-* here would let
 *    touch-primary tablets through. Use the primary-input queries.
 *  - Ask for `prefers-reduced-motion: no-preference` rather than negating `reduce`. A user agent that
 *    does not know the feature reports no match for both, so asking for no-preference denies
 *    enhancement while negating reduce would grant it. Fail closed.
 *  - WCAG 2.1 SC 2.3.3 technique C39: use prefers-reduced-motion to prevent motion.
 * ---------------------------------------------------------------------------------------------- */

/** The two media queries the gate consults. Mirrored in src/styles/motion.css — keep in step. */
export const MOTION_QUERIES = {
  hover: '(hover: hover) and (pointer: fine)',
  noPreference: '(prefers-reduced-motion: no-preference)',
};

/**
 * True only if this device/user should get the motion layer.
 *
 * Fails closed on every uncertainty: no matchMedia, a throwing matchMedia, a missing or non-boolean
 * `matches`. `matches` is compared with `=== true` so a truthy string from a shim cannot slip past.
 *
 * @param {{ matchMedia?: (q: string) => { matches?: boolean } | undefined }} [env]
 * @returns {boolean}
 */
export function shouldEnhance(env) {
  const matchMedia = env && env.matchMedia;
  if (typeof matchMedia !== 'function') return false;
  try {
    for (const query of [MOTION_QUERIES.hover, MOTION_QUERIES.noPreference]) {
      const result = matchMedia(query);
      if (!result || result.matches !== true) return false;
    }
    return true;
  } catch {
    // A shim that throws must not be read as consent.
    return false;
  }
}
