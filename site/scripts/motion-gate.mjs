#!/usr/bin/env node
/* ------------------------------------------------------------------------------------------------
 * motion-gate — post-build assertions for the site motion layer.
 *
 * Runs after `astro build`, against dist/, in the same style as content-gate.mjs and
 * check-links.mjs. Exits non-zero on any failure, so the build and CI stop.
 *
 * It encodes four acceptance criteria from docs/reel11/bpa-motion-kit-plan.md that are otherwise
 * only promises:
 *   1. BUDGET   — client JS stays under 4 KB gzipped.
 *   2. WIRED    — the motion entry is actually referenced by the built HTML, so the budget check
 *                 cannot pass vacuously by measuring a bundle nobody ships.
 *   3. NO-JS    — the .reveal hidden state is reachable only inside @media (scripting: enabled),
 *                 so content is visible with JS off.
 *   4. LCP      — the hero <h1> carries no reveal/fade class.
 * Plus 5. REDUCED-MOTION — a prefers-reduced-motion block exists in the shipped CSS.
 *
 * Each is proved by sabotage in docs/reel11/bpa-motion-kit-build-log.md.
 * ---------------------------------------------------------------------------------------------- */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DIST = path.resolve(import.meta.dirname, '..', 'dist');
const BUDGET_GZIP_BYTES = 4096; // 4 KB, from the task's hard constraints

const failures = [];
const notes = [];
const fail = (msg) => failures.push(msg);

if (!fs.existsSync(DIST)) {
  console.error('motion-gate: dist/ not found — run astro build first');
  process.exit(1);
}

/** Every file under dist/ matching a predicate on its path. */
function walk(dir, test, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, test, out);
    else if (test(full)) out.push(full);
  }
  return out;
}

const gzipSize = (buf) => zlib.gzipSync(buf, { level: 9 }).length;

// ── 1. BUDGET ─────────────────────────────────────────────────────────────────────────────────
// What counts as "added JS":
//
//   a) every .js file Astro emits. The pre-change build emitted ZERO .js files (this site shipped
//      only is:inline scripts), so emitted JS is exactly what the motion layer added. Verified on
//      main @ 24eb2e0: `find dist -name '*.js' | wc -l` -> 0.
//   b) any INLINE script that is JavaScript and mentions a motion identifier. Without (b) the
//      budget could be dodged by inlining the layer instead of bundling it.
//
// Deliberately NOT counted: `type="application/ld+json"` blocks (SEO structured data, not script —
// they are the bulk of this site's inline <script> bytes) and the pre-existing inline reveal /
// sticky-nav / burger-menu scripts, which this task did not add. Their size is reported as a note
// so creep stays visible without failing the build on code that predates the budget.
const MOTION_MARKERS = /--bp-magnet|--bp-stagger|--bp-cursor|bp-cursor-label|data-bp-motion/;
const isJsType = (attrs) => {
  const type = /\btype=["']([^"']+)["']/i.exec(attrs);
  if (!type) return true; // no type attribute => classic JS
  return /^(module|text\/javascript|application\/javascript)$/i.test(type[1].trim());
};

const jsFiles = walk(DIST, (f) => f.endsWith('.js'));
let externalGzip = 0;
for (const f of jsFiles) externalGzip += gzipSize(fs.readFileSync(f));

const htmlFiles = walk(DIST, (f) => f.endsWith('.html'));
// De-duplicate by body: the same inline script is repeated across 29 pages, and the budget is a
// statement about code size, not page count.
const inlineMotion = new Set();
const inlinePreExisting = new Set();
for (const f of htmlFiles) {
  const html = fs.readFileSync(f, 'utf8');
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const [, attrs, body] = m;
    if (!body.trim() || !isJsType(attrs)) continue;
    (MOTION_MARKERS.test(body) ? inlineMotion : inlinePreExisting).add(body);
  }
}
const inlineMotionGzip = inlineMotion.size ? gzipSize(Buffer.from([...inlineMotion].join('\n'))) : 0;
const addedGzip = externalGzip + inlineMotionGzip;

const preExistingGzip = inlinePreExisting.size
  ? gzipSize(Buffer.from([...inlinePreExisting].join('\n'))) : 0;

notes.push(`budget: ${addedGzip} B gzipped of ${BUDGET_GZIP_BYTES} B ` +
  `(${jsFiles.length} emitted .js = ${externalGzip} B, ` +
  `${inlineMotion.size} inline motion script(s) = ${inlineMotionGzip} B)`);
notes.push(`budget: not counted — ${inlinePreExisting.size} pre-existing inline script(s) = ` +
  `${preExistingGzip} B gzipped (reveal observer, sticky nav, burger menu); ld+json excluded`);
if (addedGzip > BUDGET_GZIP_BYTES) {
  fail(`[budget] added client JS is ${addedGzip} B gzipped, over the ${BUDGET_GZIP_BYTES} B budget`);
}
if (addedGzip === 0) {
  fail('[budget] measured 0 B of added JS — the motion bundle is not in dist/, so the budget ' +
    'check would pass vacuously');
}

// ── 2. WIRED ──────────────────────────────────────────────────────────────────────────────────
// Guards against a vacuous pass: if the motion entry were dropped from Base.astro the budget would
// read 0 B and sail through, so require evidence the layer actually ships.
const indexHtml = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const motionShipped =
  /data-magnetic/.test(indexHtml) &&
  /data-stagger/.test(indexHtml) &&
  /data-cursor-label-from-aria/.test(indexHtml);
if (!motionShipped) {
  fail('[wired] index.html is missing data-magnetic / data-stagger / data-cursor-label-from-aria — ' +
    'the motion layer is not wired into the markup');
}

const referencedJs = new Set();
for (const m of indexHtml.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) referencedJs.add(m[1]);
const hasModuleScript = referencedJs.size > 0 || /<script\b[^>]*type=["']module["']/i.test(indexHtml);
if (!hasModuleScript) {
  fail('[wired] index.html references no module script — the bundled motion entry is not being served');
}
notes.push(`wired: ${referencedJs.size} external script ref(s) on index.html`);

// ── 3. NO-JS ──────────────────────────────────────────────────────────────────────────────────
// The `.reveal` hidden state must sit inside @media (scripting: enabled). If it is reachable
// unconditionally, content is invisible with JS off.
//
// Scope this to the stylesheets index.html actually LINKS, not everything under dist/: checking
// "any file in dist" would let the gate pass on a rule sitting in a page-specific stylesheet that
// the homepage never loads. Astro splits CSS per route, so that distinction is real here.
const linkedCss = [...indexHtml.matchAll(/<link\b[^>]*href=["'](\/[^"']+\.css)["']/gi)]
  .map((m) => path.join(DIST, m[1]))
  .filter((f) => fs.existsSync(f));
const cssFiles = linkedCss;
if (!cssFiles.length) {
  fail('[no-js] index.html links no stylesheet from dist/ — cannot verify the no-JS fallback');
}
notes.push(`css: checking ${cssFiles.length} stylesheet(s) linked from index.html: ` +
  cssFiles.map((f) => path.relative(DIST, f)).join(', '));

let sawGatedReveal = false;
for (const file of cssFiles) {
  const css = fs.readFileSync(file, 'utf8');
  // Find the @media (scripting: enabled) block(s) and note their byte ranges.
  const gatedRanges = [];
  for (const m of css.matchAll(/@media[^{]*\(\s*scripting\s*:\s*enabled\s*\)[^{]*\{/gi)) {
    // Walk braces to find the matching close for this at-rule.
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    gatedRanges.push([m.index, i]);
  }
  const insideGate = (pos) => gatedRanges.some(([s, e]) => pos >= s && pos < e);

  // A rule that sets opacity:0 on .reveal. Minified CSS has no spaces, so match loosely.
  for (const m of css.matchAll(/\.reveal(?![-\w])[^{}]*\{[^{}]*opacity\s*:\s*0[^{}]*\}/gi)) {
    if (insideGate(m.index)) sawGatedReveal = true;
    else {
      fail(`[no-js] ${path.relative(DIST, file)} hides .reveal (opacity:0) outside ` +
        '@media (scripting: enabled) — content would be invisible with JS disabled: ' +
        m[0].slice(0, 120));
    }
  }
}
if (!sawGatedReveal) {
  fail('[no-js] found no `.reveal { opacity: 0 }` rule inside @media (scripting: enabled) — ' +
    'the no-JS fallback is not in the shipped CSS (did the rule get renamed?)');
}

// ── 4. LCP ────────────────────────────────────────────────────────────────────────────────────
// The hero <h1> is the LCP element; an opacity-0 reveal on it costs seconds of LCP.
const h1 = indexHtml.match(/<h1\b[^>]*>/i);
if (!h1) fail('[lcp] no <h1> found on index.html');
else if (/\bclass=["'][^"']*\breveal\b/i.test(h1[0])) {
  fail(`[lcp] the hero <h1> carries a reveal class, so it paints at opacity 0 and is not an LCP ` +
    `candidate until JS runs: ${h1[0]}`);
} else {
  notes.push(`lcp: hero <h1> has no reveal class`);
}

// ── 5. REDUCED MOTION ─────────────────────────────────────────────────────────────────────────
const anyReducedMotion = cssFiles.some((f) =>
  /@media[^{]*prefers-reduced-motion\s*:\s*reduce/i.test(fs.readFileSync(f, 'utf8')));
if (!anyReducedMotion) {
  fail('[reduced-motion] no @media (prefers-reduced-motion: reduce) block in the shipped CSS ' +
    '(WCAG 2.1 SC 2.3.3, technique C39)');
}

// ── report ────────────────────────────────────────────────────────────────────────────────────
for (const n of notes) console.log('motion-gate: ' + n);
if (failures.length) {
  console.error('\nmotion-gate: FAIL');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log('motion-gate: PASS (budget, wired, no-js, lcp, reduced-motion)');
