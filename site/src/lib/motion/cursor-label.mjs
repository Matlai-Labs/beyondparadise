/* ------------------------------------------------------------------------------------------------
 * VENDORED PATTERN — source note
 * Pattern: Agent OS `docs/design/interaction-patterns` (contextual cursor-label placement).
 * Copied as code into this repo on purpose: product repos never import from Agent OS, and Agent OS
 * is not reachable from the cloud VM this was written in. Written independently to the same written
 * spec as masterplan build #3, which implements the pattern in parallel. Keep in step by hand.
 *
 * Spec: given the pointer and the label's size, return a viewport position that keeps the label
 * fully on screen. Pure — no DOM.
 *
 * Why containment is a correctness requirement and not polish: the label is rendered
 * position:fixed / pointer-events:none, but a position that puts part of it past the viewport edge
 * can still widen the scroll box on some engines, which would show a scrollbar, reflow the page and
 * cost CLS. The task budget is CLS 0, so the geometry must guarantee 0 <= x and x + w <= viewportW
 * for every possible pointer position, including pointers reported outside the viewport.
 *
 * resolveLabel() deliberately reads an EXISTING accessible name rather than taking new copy: the
 * destination cards already carry aria-label="Explore Zanzibar" (DestinationsSection.astro), so the
 * overlay echoes text the page already has. The task forbids changing copy, and inventing a new
 * visible string would be exactly that.
 * ---------------------------------------------------------------------------------------------- */

export const CURSOR_DEFAULTS = Object.freeze({
  offset: 16, // px down-right of the pointer, so the label never sits under the cursor itself
  maxLabelChars: 48,
});

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const num = (v, fallback) => (finite(v) ? v : fallback);

/**
 * Viewport position for the floating label.
 *
 * @param {object}  args
 * @param {number}  args.pointerX
 * @param {number}  args.pointerY
 * @param {number}  args.labelW
 * @param {number}  args.labelH
 * @param {number}  args.viewportW
 * @param {number}  args.viewportH
 * @param {number} [args.offset]
 * @returns {{x:number, y:number}} integers; always fully inside the viewport when it fits, and
 *                                 pinned to {0,0} when the label is larger than the viewport
 */
export function cursorLabelPosition(args = {}) {
  const pointerX = num(args.pointerX, 0);
  const pointerY = num(args.pointerY, 0);
  const labelW = Math.max(0, num(args.labelW, 0));
  const labelH = Math.max(0, num(args.labelH, 0));
  const viewportW = Math.max(0, num(args.viewportW, 0));
  const viewportH = Math.max(0, num(args.viewportH, 0));
  const offset = num(args.offset, CURSOR_DEFAULTS.offset);

  // Math.max(0, ...) is applied last so an oversized label pins to the origin rather than taking a
  // negative coordinate, which is the case that could widen the scroll box.
  const x = Math.max(0, Math.min(pointerX + offset, viewportW - labelW));
  const y = Math.max(0, Math.min(pointerY + offset, viewportH - labelH));
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * The text to show, taken from names the element already has.
 *
 * @param {{cursorLabel?: unknown, ariaLabel?: unknown}} [source]
 *        `cursorLabel` is the element's data-cursor-label, `ariaLabel` its aria-label.
 * @returns {string} trimmed, whitespace-collapsed, length-capped; '' when there is nothing to show
 */
export function resolveLabel(source = {}) {
  const raw = source && source.cursorLabel != null && String(source.cursorLabel).trim() !== ''
    ? source.cursorLabel
    : (source && source.ariaLabel != null ? source.ariaLabel : '');
  const text = String(raw).replace(/\s+/g, ' ').trim();
  return text.slice(0, CURSOR_DEFAULTS.maxLabelChars);
}
