# Reel-11 — BPA motion kit: plan

Branch: `claude/reel11-motion-kit-cgov8r` · Base: `main` @ `24eb2e0` · Written 2026-11-01 · Cloud run (no deploy, no PR, no paid API, no sends, no secrets printed).

> **Branch-name note for Tim:** the task text names `cloud/reel11-bpa-motion-kit`; the session was provisioned on
> `claude/reel11-motion-kit-cgov8r` and that branch already exists on `origin`. Work is on the provisioned branch.
> `main` is untouched. Rename/cherry-pick if you want the other name.

---

## 1. Audit findings (Phase A)

### Baseline, measured before any change

| Check | Result |
|---|---|
| `cd social && node --test lib.test.js` | **PASS** — 22 tests, 22 pass, 0 fail, 0 skipped, 0 todo |
| `cd site && node --test tests/*.test.mjs` | **PASS** — 13 tests, 13 pass, 0 fail, 0 skipped |
| `cd site && npm run build` | **PASS** — exit 0 |
| └ content-gate | PASS (29 pages) |
| └ check-links | PASS (0 broken, 0 orphans, max depth 2) |
| └ seo-gates | `lib-tests=pass title-gate=pass claim-clock=pass click-depth=pass stale-page=warn data-freshness=warn` |
| `dist/` JS footprint | **0 external `.js` files**; 5 inline `<script>` blocks on `index.astro` = 2,692 B raw |
| Lighthouse performance (local `dist/`, 3 runs) | **91 / 91 / 93** — median **91**. FCP 1.7 s · **LCP 3.1 s** · CLS **0** · TBT **0 ms** · SI 4.1 s |

Sandbox caveat for every Lighthouse number in this document: `images.unsplash.com` is **not resolvable** from this
cloud session's egress policy, so the hero photo never loads. Production LCP is very likely that image, not the
headline. The before/after delta under identical sandbox conditions is still valid — the absolute score is not
comparable to production.

### Stack as it actually is

- Astro 4.16, static, `trailingSlash: 'always'`, custom CSS only. Dependencies: `astro` + `@astrojs/sitemap@3.2.1` (pinned, do not bump — comment in `astro.config.mjs`). No Tailwind, no framework renderer, no client runtime.
- `site/src/lib/` holds plain `.mjs`/`.ts` helpers with `node:test` suites in `site/tests/` (13 tests). That is the convention to follow.
- **No Playwright anywhere in the project.** The only hit for "playwright" is prose in `.claude/skills/social/references/listening.md`. The task says "a Playwright check *if the site already has one*" — it does not, so no Playwright test is committed. (A throwaway browser check using the pre-installed Chromium is run for evidence and reported in the build log; nothing is added to `package.json`.)
- Motion today: one `is:inline` IntersectionObserver in `Base.astro` toggling `.reveal` → `.in`, plus `.reveal-delay-1..4` in `global.css`. No magnet, no cursor layer.

### Defects found, all pre-existing

**A1 — (severe) With JS disabled, most content on all 29 pages is invisible.**
`global.css:147` sets `.reveal { opacity: 0; transform: translateY(28px) }` unconditionally, and only the inline
script ever adds `.in`. There is no `<noscript>` block (`grep -c noscript dist/index.html` → 0) and no
`@media (prefers-reduced-motion)` rule anywhere in the built CSS. `.reveal` is used on section heads, cards,
tables and body copy across every page. JS off ⇒ blank panels. This directly violates the task's own hard
constraint ("page fully usable and identical in content with JS off"), so it is in scope, not scope creep.
Crawlers that read the DOM without executing JS still see the text, so this is a human-visitor and
reduced-motion-user defect rather than an indexing one.

**A2 — (severe, measured) The LCP element is animated, and the animation *is* the LCP.**
Lighthouse `lcp-breakdown-insight` on the baseline build names the LCP node exactly:

```
selector: main#main-content > section.hero > div.hero__content > h1.hero__title
snippet:  <h1 class="hero__title reveal reveal-delay-1 in">
timeToFirstByte      7 ms
elementRenderDelay   3,138 ms
```

Chrome does not treat an `opacity: 0` element as an LCP candidate, so LCP is not recorded until the observer
fires, the class flips and the 0.7 s transition (+0.10 s delay) paints. 7 ms of server time, 3.1 s of LCP.
The task constraint "no motion on LCP element" is currently violated by the existing code.

**A3 — (minor) `html { scroll-behavior: smooth }` at `global.css:35` is unconditional**, so in-page anchor jumps
animate even for users who asked for reduced motion.

**A4 — (minor) The delay scale is a hardcoded 4-step CSS ladder.** `DestinationsSection.astro:50` and
`YouTubeSection.astro:34` interpolate `reveal-delay-${i+1}`; a list of 5+ silently loses its delay because
`.reveal-delay-5` does not exist. Today's longest list is 4, so this is latent, not live.

**A5 — No JS size gate exists.** Nothing in the build would notice if the client bundle grew. The task sets a
4 KB gzipped budget, so the budget needs to become an assertion, not a hope.

Out of scope, noted and left alone: the `stale-page` / `data-freshness` warnings on
`/intelligence/east-africa-tourism-stats/` (fact refresh, needs Tim — item 13 in `docs/audits/2026-11-cloud-audit.md`).

---

## 2. Research (Phase B)

Direct fetches to `developer.mozilla.org`, `www.w3.org`, `w3c.github.io` and `web.dev` are **blocked by this
session's egress policy** (`getaddrinfo ENOTFOUND`). Findings below come from search-engine retrieval of those
pages plus secondary sources; URLs are cited so Tim can verify against the primaries. Where only secondary
sources were reachable, that is stated.

**Reduced motion — `prefers-reduced-motion`**
- Values are `no-preference` and `reduce`. WCAG 2.1 **SC 2.3.3 Animation from Interactions** (Level AAA) covers motion *started by user interaction* that is not essential; **SC 2.2.2 Pause, Stop, Hide** covers motion the page starts itself. Sufficient technique **C39** is specifically "using the `prefers-reduced-motion` query to prevent motion". Essential motion is exempt — none of this kit is essential.
  - https://w3c.github.io/wcag/understanding/animation-from-interactions.html
  - https://w3c.github.io/wcag/techniques/css/C39
  - https://www.w3.org/WAI/WCAG21/Understanding/animation-from-interactions
- Implication: the gate must be *both* a CSS rule (so motion is off before any JS runs) and a JS check (so listeners are never attached). Belt and braces, because CSS alone cannot stop a `pointermove` handler.

**Hover capability — `(hover: hover)`, `(pointer: fine)`**
- `hover` / `pointer` describe the **primary** input; `any-hover` / `any-pointer` describe **any** input. A desktop with a touchscreen matches `any-hover: hover`, so `any-hover: none` is the wrong touch test — a Firefox bug report makes exactly this point.
- The reliable mouse-first test is `(hover: hover) and (pointer: fine)`. Known evaluation bugs exist on iPadOS/iOS with a mouse attached and on Windows hybrids, which is an argument for failing *closed* (no enhancement) when the query does not clearly match.
  - https://developer.mozilla.org/en-US/docs/Web/CSS/@media/hover (not fetchable here)
  - https://css-irl.info/detecting-hover-capable-devices/
  - https://bugzilla.mozilla.org/show_bug.cgi?id=1528441 · https://bugs.webkit.org/show_bug.cgi?id=209292

**CLS — what is safe to animate**
- Animate `transform` / `opacity` / `filter` only: the compositor handles them and they trigger neither layout nor paint, so they do not feed the layout-instability algorithm. Animating `top`/`margin`/`width` makes every frame a candidate shift. Lighthouse's "Avoid non-composited animations" audit catches the bad cases.
  - https://web.dev/articles/css-web-vitals (not fetchable here)
  - https://shopify.dev/docs/storefronts/themes/best-practices/performance/use-transform-for-animations
  - https://engineering.spendesk.com/posts/how-we-fixed-cls-issue/ · https://corewebvitals.io/pagespeed/scroll-triggered-animations-cause-cls
- Implication: magnet and cursor label must be `transform`-only, and the cursor label must be `position: fixed` + `pointer-events: none` so it can never add to the scroll box or trigger a scrollbar.

**LCP — never fade in the LCP element**
- Chrome has ignored `opacity: 0` elements as LCP candidates since Aug 2020; LCP is only recorded on the repaint at visible opacity. Shopify reports 3–6 s LCP improvements purely from removing fade-ins on hero elements. The `opacity: 0.1` trick exists but is a hack; removing the animation is the recommended fix.
  - https://www.debugbear.com/blog/opacity-animation-poor-lcp
  - https://shopify.dev/docs/storefronts/themes/best-practices/performance/dont-hide-lcp-image-behind-animations
  - https://dev.to/gillygangopolus/the-scroll-animation-that-was-hiding-our-lcp-element-2edp
- This is finding A2, independently confirmed by the project's own Lighthouse trace.

**INP — pointer handlers**
- Register scroll/pointer listeners `{ passive: true }`; coalesce to one `requestAnimationFrame` with a `ticking` flag rather than writing style per event; keep handlers short to avoid >50 ms long tasks.
  - https://web.dev/articles/inp (not fetchable here)
  - https://shopify.dev/docs/storefronts/themes/best-practices/performance/debounce-throttle-event-handlers
- Implication: exactly one delegated `pointermove` on `document`, rAF-coalesced, writing only custom properties.

**No-JS fallback — `@media (scripting: enabled)`**
- The `scripting` media feature (`none` / `initial-only` / `enabled`) is **Baseline since Dec 2023** (Chrome/Edge 120, Firefox 113, Safari 17). Decisive property: a browser that does not understand `scripting` never matches the query, so wrapping the hiding rule in it leaves content **visible** on old browsers — it fails in the safe direction, unlike a `.js`-class approach which needs the script to run to un-hide.
  - https://developer.mozilla.org/en-US/docs/Web/CSS/@media/scripting (not fetchable here; Baseline status per MDN compat data)
  - Also recommended by component libraries: default to visible, hide only when enhancement is possible — https://github.com/phantomstudios/reveal-on-scroll

**Magnetic CTA / cursor-label accessibility**
- The pull is decorative: it must not change semantics. Keep the element a real `<a>`/`<button>`, keep focus/Enter/Space, move only `transform`. Mark the floating label `aria-hidden="true"` and `pointer-events: none`; it is a visual echo of an accessible name that already exists.
  - https://www.shadcn.io/button/aria/magnetic-button · https://glinui-app.pages.dev/docs/components/magnetic-cta

---

## 3. Approaches considered (Phase C)

**Approach 1 — Astro island with a framework + Framer Motion.**
`DESIGN.md` §"Animation System" is literally written in Framer Motion variants, so this is the documented
intent. Rejected: it needs `@astrojs/react` + `react` + `react-dom` + `framer-motion` (~45 KB gzipped minimum
for the runtime alone, >10× the budget), adds four npm dependencies against an explicit "no new npm dependency"
constraint, and contradicts the CLAUDE.md stack rule ("Astro 4, static site, zero JS bloat"). `DESIGN.md`'s
Framer snippets are best read as *timing/easing specification* rather than an implementation mandate — the
durations and the `cubic-bezier(0.25,0.46,0.45,0.94)` curve are reusable, the library is not.

**Approach 2 — Pure CSS, no JS at all.**
Scroll-driven animations (`animation-timeline: view()`) could do the staggered reveal with zero JS, and
`@supports not (animation-timeline: view())` gives a clean fallback. Genuinely tempting for the reveal. But a
magnetic CTA needs the pointer's distance from the element's centre, and a cursor label needs the pointer's
viewport coordinates — **CSS cannot read pointer position**, so 2 of the 3 requested features are impossible.
Rejected as a whole; adopted in part — the reveal stays CSS-transition-driven and all three effects are
expressed as CSS custom properties, with JS writing nothing but numbers.

**Approach 3 (chosen) — Hand-written vanilla ES module + CSS custom properties, pure logic split into
unit-tested modules.**
JS computes numbers and writes three custom properties (`--bp-magnet-x/y`, `--bp-stagger`, `--bp-cursor-x/y`);
CSS owns every visual. One delegated `pointermove` on `document`, `{ passive: true }`, rAF-coalesced. All
decision logic lives in pure functions in `site/src/lib/motion/` that take plain arguments (including an
injected `matchMedia`), so `node:test` covers them with no jsdom and no new dependency.

Why this one: it is the only option that satisfies all four hard constraints at once (no new dependency, <4 KB
gzipped, CLS 0, works with JS off), it matches the existing `src/lib/*.mjs` + `tests/*.test.mjs` convention, and
making the gate a pure function of an injected `matchMedia` is what makes the reduced-motion and touch guards
*testable* — and therefore provable by sabotage — instead of something only a human with a device lab could check.
Trade-off accepted: ~200 lines of motion code we own and must maintain, versus a library someone else maintains.
Mitigated by unit tests on the whole decision core and a byte-budget gate in the build.

Credible alternatives worth a look if this ever needs to grow: **Motion One** (~3.8 KB gzipped, WAAPI-based —
would roughly consume the entire budget by itself, which is why it lost here), **GSAP** (already vendored in
`social/video.js` for reel rendering, so there is in-house familiarity, but ~23 KB gzipped core), and native
**scroll-driven animations** once `animation-timeline` support is wide enough to drop the JS reveal entirely.

### Vendored pattern — source note

The motion spec (gate order, custom-property handoff, rAF coalescing, byte budget) is **vendored as copied code
with a source-note header**, per the repo rule. Agent OS `docs/design/interaction-patterns` is *not* imported and
is not reachable from this cloud VM; build #3 of this masterplan writes that pattern in parallel, so this is an
independent implementation to the same written spec. Every file carries a header saying so.

---

## 4. Task list (Phase E)

Test-first throughout: write the failing test, run it, watch it fail, then implement, then watch it pass.

| # | Task | Proof |
|---|---|---|
| 1 | `site/src/lib/motion/gate.mjs` — `shouldEnhance({ matchMedia })`, fail-closed | `tests/motion-gate.test.mjs`; sabotage = drop the reduced-motion clause |
| 2 | `site/src/lib/motion/magnet.mjs` — `magnetOffset()` with radial clamp | `tests/motion-magnet.test.mjs`; sabotage = remove the clamp |
| 3 | `site/src/lib/motion/stagger.mjs` — `staggerDelay()` / `staggerTable()`, capped tail | `tests/motion-stagger.test.mjs` |
| 4 | `site/src/lib/motion/cursor-label.mjs` — `cursorLabelPosition()` viewport containment, `resolveLabel()` | `tests/motion-cursor.test.mjs` |
| 5 | `site/src/lib/motion/enhance.mjs` — the only DOM module; wires 1–4, one passive rAF-coalesced `pointermove` | browser check + budget gate |
| 6 | `site/src/styles/motion.css` — all visuals; `@media (scripting: enabled)` fix for A1; reduced-motion resets; A3 fix | `scripts/motion-gate.mjs` |
| 7 | Fix A2: remove `reveal` from the hero `<h1>` | `scripts/motion-gate.mjs` asserts no reveal class on the `<h1>` in `dist/` |
| 8 | `scripts/motion-gate.mjs` — post-build gate: 4 KB gzip budget, no-JS rule present, LCP element clean | sabotage each of the three assertions |
| 9 | Wire gate into `npm run build`; opt-in attributes on hero CTA + destination cards | full build green |

Deliberate scope limits: no copy, claim, imagery or data file is touched. The cursor label reuses each card's
**existing** `aria-label` ("Explore Zanzibar") rather than inventing new copy. `social/` is not touched.
`site/deploy.sh` is not run.

---

## 5. Acceptance tests

1. `cd social && node --test lib.test.js` — still 22/22, 0 fail (no worse than baseline).
2. `cd site && npm run build` — exit 0; content-gate, check-links and seo-gates no worse than baseline.
3. New `node:test` suites green; total site unit tests ≥ 13 + new.
4. **Budget:** gzipped size of all JS Astro emits into `dist/` < 4,096 B, asserted in the build.
5. **No-JS:** built CSS hides `.reveal` only inside `@media (scripting: enabled)`, asserted in the build; verified in a real browser with JS disabled.
6. **LCP:** no `reveal`/opacity-0 class on the `<h1>` in `dist/index.html`, asserted in the build.
7. **CLS 0** and performance score within 2 points of the 91 baseline median, Lighthouse, same sandbox.
8. **Touch + reduced motion:** real-browser check shows no transform and no floating label under `prefers-reduced-motion: reduce` and under touch emulation.
9. Every guard in 4–6 proved by sabotage: break it, watch the build fail, restore it.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Removing the hero `<h1>` reveal changes the look Tim signed off | Smallest possible change — only the `<h1>`; label, sub and CTAs still animate. Flagged in the build log as Tim's call to revert. |
| `@media (scripting: enabled)` unsupported on an old browser | Fails safe: query never matches ⇒ content stays visible. Strictly better than today. |
| `(hover: hover) and (pointer: fine)` misreports on iPadOS-with-mouse / Windows hybrids | Fails closed — no enhancement, base experience intact. |
| Astro inlines the bundled script instead of emitting a file, so a naive gate measures 0 B | Gate measures emitted `.js` **and** inline `<script>` growth, and asserts the motion entry is actually referenced, so it cannot pass vacuously. |
| Lighthouse numbers not comparable to production (`images.unsplash.com` blocked) | Stated everywhere; 3-run medians; delta-only claims. |
| Hand-rolled motion code is ours to maintain | Decision core fully unit-tested; byte budget enforced in CI (`.github/workflows/ci.yml` already runs the site build). |
| Scope creep into pre-existing defects | Only A1–A3 are fixed, each because a *stated task constraint* requires it. A4/A5 are addressed incidentally by the new delay table and the budget gate. Fact-freshness warnings left for Tim. |
