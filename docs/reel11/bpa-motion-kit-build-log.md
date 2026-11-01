# Reel-11 — BPA motion kit: build log

Branch: `claude/reel11-motion-kit-cgov8r` · Base: `main` @ `24eb2e0` · 2026-11-01
Plan: `docs/reel11/bpa-motion-kit-plan.md`

No deploy (`site/deploy.sh` not run). No PR opened. No merge. No paid API call of any kind. No
email/WhatsApp/social send. No secret or `.env` content printed or committed. No new npm dependency.
`social/`, `pipeline/` and `data/` are byte-for-byte untouched (`git diff main --stat` over those
paths is empty).

---

## Done

**The three requested effects**, in `site/src/lib/motion/`, opt-in by attribute:

| Effect | Where | Opt-in |
|---|---|---|
| Magnetic CTA | both hero CTAs | `data-magnetic` |
| Staggered section reveal | destinations grid | `data-stagger` |
| Contextual cursor label | destination cards | `data-cursor-label-from-aria` |

Architecture: four **pure** modules (`gate`, `magnet`, `stagger`, `cursor-label`) hold every
decision and carry all the unit tests; one DOM module (`enhance.mjs`) wires them up and writes
nothing but CSS custom properties; `src/styles/motion.css` owns every visual. JS never touches a
layout property, so the whole layer stays on the compositor.

- The gate uses `(hover: hover) and (pointer: fine)` (primary input, not `any-hover`, which would
  wrongly match a desktop with a touchscreen) and asks for `prefers-reduced-motion: no-preference`
  rather than negating `reduce`, so a user agent that does not know the feature is **denied**
  enhancement. It also fails closed on a missing, throwing or non-boolean `matchMedia`.
- One `pointermove` listener on `document`, `{ passive: true }`, coalesced into a single
  `requestAnimationFrame` behind a ticking flag. Element rects are cached on `pointerenter` and
  invalidated on `resize`, so the hot path forces no reflow. Measured TBT stayed at 0 ms.
- The cursor label is `position: fixed` + `pointer-events: none` + `aria-hidden="true"`, and its
  position is clamped so it is always fully inside the viewport — it can neither widen the scroll
  box (CLS) nor intercept the click it labels (usability).

**Three pre-existing defects fixed**, each because a stated task constraint required it:

- **A1, no-JS.** `global.css` set `.reveal { opacity: 0 }` unconditionally while only the
  IntersectionObserver ever adds `.in`, so with JS off section heads, cards, tables and body copy
  were invisible on all 29 pages. The hidden state now sits inside `@media (scripting: enabled)`.
- **A2, LCP.** The hero `<h1>` carried `reveal reveal-delay-1`. The reveal animation *was* the LCP.
  The headline now paints with the document. **LCP 3.1 s → 1.6 s.**
- **A3.** `scroll-behavior: smooth` is now gated on `prefers-reduced-motion: no-preference`
  (WCAG 2.1 SC 2.3.3, technique C39).

**New build gate**, `site/scripts/motion-gate.mjs`, wired into `npm run build` between `check-links`
and `seo-gates` (and available alone as `npm run check:motion`). Five assertions — budget, wired,
no-js, lcp, reduced-motion — all proved by sabotage below.

### One subtlety worth knowing about before anyone refactors it

The no-JS fix had to use the **positive** query. With `@media (scripting: enabled)` wrapping the
*hiding* rule, a browser that does not know the `scripting` feature evaluates it false, the rule
never applies, and content stays **visible** — it fails safe. The intuitive-looking inverse,
`@media not (scripting: enabled) { .reveal { opacity: 1 } }`, is a **bug**: per Media Queries error
handling an unknown feature evaluates to `unknown`, and `not unknown` is also false for `@media`, so
the un-hiding rule would never fire and content would stay hidden on exactly the old browsers it was
meant to protect. Both `global.css` and `motion.css` carry a comment saying not to invert it.

## Skipped, and why

- **Playwright test — not committed.** The task said "a Playwright check *if the site already has
  one*". It does not: the only "playwright" string in the repo is prose in
  `.claude/skills/social/references/listening.md`. Adding one would mean a new dev dependency, a
  browser download in CI and a server harness, which is a bigger decision than this task. A
  throwaway script using the VM's pre-installed Chromium was run for evidence instead (21 checks,
  results below) and left in `/tmp`. **Open question for Tim** below.
- **`data-magnetic` on the nav "Get Intelligence" CTA** — left off. The nav is sticky and its CTA sits
  next to the burger menu; a magnet on a persistently visible control is more likely to annoy than
  delight. Easy to add if wanted.
- **The fact-freshness warnings** on `/intelligence/east-africa-tourism-stats/` (`stale-page`,
  `data-freshness`) are unchanged from baseline. They need a fact review from Tim — item 13 in
  `docs/audits/2026-11-cloud-audit.md`.
- **Copy, claims, imagery and data** — untouched, as instructed. The cursor label deliberately reuses
  each card's existing `aria-label` ("Explore Zanzibar") rather than introducing a new string.

## Tests added

45 new tests in 4 files, all `node:test`, no jsdom, no new dependency. Site unit tests went
**13 → 58**.

| File | Tests | Covers |
|---|---|---|
| `site/tests/motion-gate.test.mjs` | 8 | the enhancement gate; every fail-closed path |
| `site/tests/motion-magnet.test.mjs` | 11 | radial clamp, strength clamp, degenerate rects/pointers |
| `site/tests/motion-stagger.test.mjs` | 12 | delay table, tail cap, monotonicity, hostile config |
| `site/tests/motion-cursor.test.mjs` | 14 | viewport containment sweep, label resolution and capping |

**Two real bugs were caught by tests while writing them**, which is the argument for test-first here:

1. Quantising the magnet offset with round-to-nearest *after* the radial clamp pushed the magnitude
   back over the cap — with `maxOffset: 8` and a 45° pointer, `x = y = 5.65685` rounds to `5.66` and
   `hypot(5.66, 5.66) = 8.0045`. Now truncated toward zero, which can only shrink the vector.
2. A cursor label larger than the viewport took a negative coordinate instead of pinning to the
   origin — a negative `left` is exactly what could widen the scroll box and cost CLS.

A third was caught while hardening the gate: it checked `prefers-reduced-motion` and the no-JS rule
with `.some()` across **all** of `dist/`, which would have passed on a rule sitting in a
route-specific stylesheet the homepage never loads (Astro splits CSS per route). It now reads only
the stylesheets `index.html` links.

## Guards proved by sabotage

Each break was applied, the gate run, and the break reverted. Gate exit code in brackets.

| # | Sabotage | Result |
|---|---|---|
| 1 | Appended ~900 padding statements to the emitted bundle | **[1]** `[budget] added client JS is 8145 B gzipped, over the 4096 B budget` |
| 2 | Moved the motion bundle out of `dist/` | **[1]** `[budget] measured 0 B of added JS — the motion bundle is not in dist/, so the budget check would pass vacuously` |
| 3 | Stripped `data-magnetic` / `data-stagger` / `data-cursor-label-from-aria` from the built HTML | **[1]** `[wired] index.html is missing data-magnetic / data-stagger / data-cursor-label-from-aria` |
| 4 | Pulled the `.reveal{opacity:0}` rule out of the `@media (scripting: enabled)` wrapper | **[1]** `[no-js] ... hides .reveal (opacity:0) outside @media (scripting: enabled) — content would be invisible with JS disabled` |
| 5 | Deleted the `@media (prefers-reduced-motion: reduce)` block | **[1]** `[reduced-motion] no @media (prefers-reduced-motion: reduce) block in the shipped CSS` |
| 6 | Restored `reveal reveal-delay-1` on the hero `<h1>` | **[1]** `[lcp] the hero <h1> carries a reveal class, so it paints at opacity 0 and is not an LCP candidate until JS runs` |
| — | All restored | **[0]** `motion-gate: PASS (budget, wired, no-js, lcp, reduced-motion)` |

The reduced-motion clause in the *runtime* gate was proved separately: removing
`MOTION_QUERIES.noPreference` from the query list in `gate.mjs` turns "refuses when the user prefers
reduced motion" red (7/8 pass), then green again on restore.

---

## Verification output

### `cd social && node --test lib.test.js` — unchanged from baseline

```
# tests 22
# suites 0
# pass 22
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### `cd site && npm run build` — exit 0

```
# tests 58
# pass 58
# fail 0
content-gate: 29 pages checked (title <= 60, description <= 155)
content-gate: PASS
check-links: 29 pages scanned
  broken internal links/assets/anchors: 0 (0 distinct targets)
  orphan pages (0 inbound links): 0
  pages deeper than 2 clicks from home: 0
check-links: PASS
motion-gate: budget: 1771 B gzipped of 4096 B (1 emitted .js = 1771 B, 0 inline motion script(s) = 0 B)
motion-gate: budget: not counted — 3 pre-existing inline script(s) = 585 B gzipped (reveal observer, sticky nav, burger menu); ld+json excluded
motion-gate: wired: 1 external script ref(s) on index.html
motion-gate: css: checking 2 stylesheet(s) linked from index.html: _astro/_slug_.DosijXoh.css, _astro/index.B8cVrluY.css
motion-gate: lcp: hero <h1> has no reveal class
motion-gate: PASS (budget, wired, no-js, lcp, reduced-motion)
seo-gates summary (today 2026-11-01): lib-tests=pass title-gate=pass claim-clock=pass click-depth=pass stale-page=warn data-freshness=warn
```

`stale-page=warn` and `data-freshness=warn` are **identical to the baseline** — both predate this
branch and concern fact freshness, not motion.

### Budget

**1,771 B gzipped of the 4,096 B allowance (43%).** The pre-change build emitted zero `.js` files, so
emitted JS is exactly what this branch added. Zero new npm dependencies — `site/package.json`
changed only in its `scripts` block, and `package-lock.json` is untouched (the lockfile churn my
`npm install` produced was reverted; it was npm-version format normalisation, not a dependency
change).

### Lighthouse, before vs after

Local `dist/` over `127.0.0.1`, headless Chromium, mobile defaults, 3 runs each.

| | Before (`main` @ 24eb2e0) | After | Δ |
|---|---|---|---|
| Performance | 91 · 91 · 93 → **median 91** | 99 · 99 · 99 → **median 99** | **+8** |
| FCP | 1.7 s | 1.6–1.7 s | — |
| **LCP** | **3.1 s** | **1.6–1.7 s** | **−1.4 s** |
| CLS | **0** | **0** | **0** |
| TBT | 0 ms | 0 ms | — |

Acceptance was "no drop > 2 points". The score **rose 8 points**, because fixing A2 removed the
animation that was holding LCP open:

```
BEFORE  Time to first byte 7 ms | Element render delay 3,138 ms
AFTER   Time to first byte 7 ms | Element render delay 1,270 ms
```

LCP now equals FCP — the headline paints with the document. The residual 1,270 ms is Playfair
Display web-font loading, which is pre-existing and out of scope.

Two supporting audits on the after run:
- `non-composited-animations`: **no items** — confirms only compositor-friendly properties animate.
- `layout-shifts`: **none found** — CLS 0 is real, not a rounding artefact.

> **Caveat, stated plainly.** `images.unsplash.com` is not resolvable from this cloud session's
> egress policy, so the hero photo never loaded in any run. In production that image is the likely
> LCP element, so these absolute numbers do not transfer. Both columns were measured under identical
> sandbox conditions, so the **delta** is sound, and the CLS-0 and TBT-0 results are unaffected by
> the missing image. Re-run on production to get real figures.

### Real-browser checks — 21/21

Throwaway script, VM's pre-installed Chromium, not committed.

```
PASS  JS off: no .reveal element is hidden — 23 reveal elements, 0 hidden
PASS  JS off: hero headline is visible with its text — opacity 1, "BeyondParadiseAdventures"
PASS  JS off: all destination cards visible — 4 cards, opacities 1
PASS  desktop: motion layer attached
PASS  desktop: magnet offset written and non-zero — --bp-magnet-x=7.99px --bp-magnet-y=0.01px
PASS  desktop: magnet magnitude within the 8px cap — |offset|=7.990px
PASS  desktop: cursor label shown with the card aria-label text — "Explore Zanzibar"
PASS  desktop: label is aria-hidden, pointer-events:none, position:fixed
PASS  desktop: label stays inside the viewport — rect 212,462,380,487 in 1280x900
PASS  desktop: label contained at the far corner of the last card — "Explore Mafia Island" rect 1081,653,1280,678 in 1280x900
PASS  desktop: stagger delays applied from the table — [0ms, 120ms, 240ms, 360ms]
PASS  desktop: label adds no horizontal overflow — scrollWidth 1280 <= clientWidth 1280
PASS  reduced motion: pointer layer NOT attached
PASS  reduced motion: CTA has no transform — transform=none
PASS  reduced motion: no cursor label rendered
PASS  reduced motion: all content visible
PASS  reduced motion: scroll-behavior is auto, not smooth — scroll-behavior=auto
PASS  touch: (hover: hover) and (pointer: fine) does not match
PASS  touch: pointer layer NOT attached
PASS  touch: no cursor label element created
PASS  touch: page still renders reveal content — 23 reveal elements present
```

The clamp is visible working at the boundary in the corner case: the label's right edge lands on
1280 in a 1280-wide viewport — flush, never past.

---

## Open questions for Tim

1. **Branch name.** The task text named `cloud/reel11-bpa-motion-kit`; this session was provisioned
   on `claude/reel11-motion-kit-cgov8r`, which already existed on `origin`, so the work is there.
   `main` is untouched. Rename or cherry-pick if you want the other name. **No PR was opened** — the
   run's hard rules forbid it, so the branch is pushed and waiting for you.
2. **The hero headline no longer fades in.** This is the LCP fix and it is worth 1.4 s of LCP, but it
   is a visible change to a design you signed off: the gold label above still fades, the headline now
   lands immediately, then the sub-line and CTAs fade. I think it reads *better* — the headline
   arriving with the page is more confident than it sliding up — but it is your call. To revert,
   restore `class="hero__title reveal reveal-delay-1"` in `HeroSection.astro` and delete the `[lcp]`
   block from `scripts/motion-gate.mjs`; please don't revert just the markup, or the build will fail
   by design. A middle option exists if you want some motion back: animate `transform` only, with no
   `opacity`, which keeps the element an LCP candidate.
3. **Commit a Playwright test?** The repo has none, so I did not add one. If you want these 21 checks
   in CI it means `@playwright/test` as a dev dependency plus a browser step in
   `.github/workflows/ci.yml` — say the word and it is a small follow-up. The script is throwaway in
   `/tmp` and will vanish with this VM.
4. **`DESIGN.md` now disagrees with the code.** Its "Animation System" section is written as Framer
   Motion variants and recommends `react-countup`. That stack would cost four npm dependencies and
   over ten times this task's JS budget, so the kit implements the same *timings* (0.12 s stagger,
   the `cubic-bezier(0.25,0.46,0.45,0.94)` curve) in vanilla CSS. Worth a line in `DESIGN.md` saying
   the Framer snippets are a timing spec, not an implementation mandate — I did not edit `DESIGN.md`
   because it is a brand document and that is your call.
5. **Where else should the effects go?** Only the hero CTAs and destination cards are wired, so the
   blast radius is small. Lodge cards, the Tim Score badges and the newsletter CTA are the obvious
   next candidates; they just need the attributes, no new code.
6. **Wider scope than asked, flagged for the record.** The no-JS and LCP fixes touch `global.css`
   and `HeroSection.astro` rather than only `site/src/lib/motion/`. Both were required by the task's
   own hard constraints ("identical content with JS off", "no motion on LCP element") and the
   existing code violated them, so fixing them was the task, not scope creep. Nothing else outside
   the motion layer was changed.
