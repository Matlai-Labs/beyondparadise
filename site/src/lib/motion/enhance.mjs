/* ------------------------------------------------------------------------------------------------
 * VENDORED PATTERN — source note
 * Pattern: Agent OS `docs/design/interaction-patterns` (motion-layer DOM wiring).
 * Copied as code into this repo on purpose: product repos never import from Agent OS, and Agent OS
 * is not reachable from the cloud VM this was written in. Written independently to the same written
 * spec as masterplan build #3, which implements the pattern in parallel. Keep in step by hand.
 *
 * The ONLY module here that touches the DOM. Everything it decides comes from the pure functions in
 * ./gate, ./magnet, ./stagger and ./cursor-label, which carry the unit tests.
 *
 * Rules it keeps:
 *  - Nothing runs until shouldEnhance() says so, so a touch device and a reduced-motion user attach
 *    no listeners at all.
 *  - Exactly ONE pointermove listener on the document, { passive: true }, coalesced into a single
 *    requestAnimationFrame with a ticking flag. Per-event style writes are what turn a pointer
 *    handler into an INP problem; this writes at most once per frame.
 *  - Writes only custom properties. No layout property is ever set, nothing is measured inside the
 *    rAF callback except cached rects, so the effect stays on the compositor and costs no CLS.
 *  - Element rects are read on pointerenter and on resize, never per pointermove, so the hot path
 *    does no forced reflow.
 * ---------------------------------------------------------------------------------------------- */

import { shouldEnhance } from './gate.mjs';
import { magnetOffset, MAGNET_DEFAULTS } from './magnet.mjs';
import { staggerDelay } from './stagger.mjs';
import { cursorLabelPosition, resolveLabel, CURSOR_DEFAULTS } from './cursor-label.mjs';

const SEL = {
  magnetic: '[data-magnetic]',
  stagger: '[data-stagger]',
  cursorLabel: '[data-cursor-label], [data-cursor-label-from-aria]',
};

/**
 * Apply the stagger delay table to the children of every [data-stagger] container.
 *
 * Runs regardless of the motion gate: it only sets transition-delay, and the reduced-motion CSS
 * block forces `transition-delay: 0ms !important`, so a reduced-motion user is unaffected either
 * way. Doing it here rather than in markup is what removes the four-step ladder's 5+ item blind
 * spot (plan finding A4).
 *
 * @param {Document|Element} root
 */
export function applyStagger(root) {
  const containers = root.querySelectorAll(SEL.stagger);
  for (const container of containers) {
    const step = Number(container.dataset.staggerStep) || undefined;
    const children = container.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!child.classList.contains('reveal')) continue;
      child.style.setProperty('--bp-stagger', staggerDelay(i, { step }) + 'ms');
    }
  }
}

/**
 * Attach the motion layer. Idempotent and safe to call before or after DOMContentLoaded.
 *
 * @param {object} [env]
 * @param {Document} [env.document]
 * @param {Window} [env.window]
 * @returns {boolean} true if the pointer-driven layer was attached
 */
export function enhance(env = {}) {
  const doc = env.document || (typeof document !== 'undefined' ? document : undefined);
  const win = env.window || (typeof window !== 'undefined' ? window : undefined);
  if (!doc || !win) return false;

  // The stagger table is independent of the pointer gate.
  applyStagger(doc);

  if (!shouldEnhance({ matchMedia: win.matchMedia && win.matchMedia.bind(win) })) return false;
  if (doc.documentElement.hasAttribute('data-bp-motion')) return false; // already attached
  doc.documentElement.setAttribute('data-bp-motion', '');

  /* ---- shared pointer state, written by one listener, read by one rAF ---- */
  let pointerX = 0;
  let pointerY = 0;
  let ticking = false;

  /* ---- magnetic CTAs ---- */
  /** @type {{el: Element, rect: DOMRect|null, strength: number, max: number}[]} */
  const magnets = [];
  for (const el of doc.querySelectorAll(SEL.magnetic)) {
    const entry = {
      el,
      rect: null,
      strength: Number(el.dataset.magnetStrength) || MAGNET_DEFAULTS.strength,
      max: Number(el.dataset.magnetMax) || MAGNET_DEFAULTS.maxOffset,
    };
    magnets.push(entry);
    // Measure on enter only: the hot path must never force a reflow.
    el.addEventListener('pointerenter', () => {
      entry.rect = el.getBoundingClientRect();
      el.removeAttribute('data-magnet-idle');
    }, { passive: true });
    el.addEventListener('pointerleave', () => {
      entry.rect = null;
      el.setAttribute('data-magnet-idle', '');
      el.style.setProperty('--bp-magnet-x', '0px');
      el.style.setProperty('--bp-magnet-y', '0px');
    }, { passive: true });
  }

  /* ---- contextual cursor label ---- */
  const labelTargets = doc.querySelectorAll(SEL.cursorLabel);
  /** @type {HTMLElement|null} */
  let labelEl = null;
  let labelW = 0;
  let labelH = 0;
  let labelActive = false;

  function ensureLabelEl() {
    if (labelEl) return labelEl;
    labelEl = doc.createElement('div');
    labelEl.className = 'bp-cursor-label';
    labelEl.setAttribute('aria-hidden', 'true'); // echoes an accessible name the card already has
    doc.body.appendChild(labelEl);
    return labelEl;
  }

  for (const target of labelTargets) {
    const text = resolveLabel({
      cursorLabel: target.dataset.cursorLabel,
      ariaLabel: target.getAttribute('aria-label'),
    });
    if (!text) continue;
    target.addEventListener('pointerenter', () => {
      const el = ensureLabelEl();
      el.textContent = text;
      const box = el.getBoundingClientRect();
      labelW = box.width;
      labelH = box.height;
      labelActive = true;
      el.setAttribute('data-visible', '');
      target.setAttribute('data-cursor-label-active', '');
    }, { passive: true });
    target.addEventListener('pointerleave', () => {
      labelActive = false;
      if (labelEl) labelEl.removeAttribute('data-visible');
      target.removeAttribute('data-cursor-label-active');
    }, { passive: true });
  }

  /* ---- the single rAF-coalesced write pass ---- */
  function frame() {
    ticking = false;
    for (const m of magnets) {
      if (!m.rect) continue;
      const off = magnetOffset({
        pointerX, pointerY, rect: m.rect, strength: m.strength, maxOffset: m.max,
      });
      m.el.style.setProperty('--bp-magnet-x', off.x + 'px');
      m.el.style.setProperty('--bp-magnet-y', off.y + 'px');
    }
    if (labelActive && labelEl) {
      const pos = cursorLabelPosition({
        pointerX, pointerY, labelW, labelH,
        viewportW: win.innerWidth, viewportH: win.innerHeight,
        offset: CURSOR_DEFAULTS.offset,
      });
      labelEl.style.setProperty('--bp-cursor-x', pos.x + 'px');
      labelEl.style.setProperty('--bp-cursor-y', pos.y + 'px');
    }
  }

  function onPointerMove(event) {
    pointerX = event.clientX;
    pointerY = event.clientY;
    if (ticking) return;
    ticking = true;
    win.requestAnimationFrame(frame);
  }

  doc.addEventListener('pointermove', onPointerMove, { passive: true });

  // A resize invalidates every cached rect; drop them and let pointerenter re-measure.
  win.addEventListener('resize', () => {
    for (const m of magnets) m.rect = null;
  }, { passive: true });

  return true;
}
