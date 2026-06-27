# Beyond Paradise — Design System
> This file is read by Claude Code, Google Stitch, and Cursor to maintain visual consistency across all Beyond Paradise pages and components. Update this file when the brand evolves — all AI tools pick up the change automatically.

---

## Brand Identity

**Brand**: Beyond Paradise  
**Domain**: beyondparadise.com  
**Positioning**: Luxury travel editorial — East Africa + Southeast Asia — €6,000+ trips only  
**Tone**: "Not a travel blog. A media brand." Confident, editorial, first-hand authority.  
**Aesthetic**: Cinematic dark luxury. Condé Nast editorial meets Silicon Valley product. Liquid glass panels over void-black backgrounds.

---

## Color System

```css
/* Core palette */
--color-base:        #09090B;   /* Void Black — all page backgrounds */
--color-surface-01:  #111114;   /* Elevated surface — cards, sections */
--color-surface-02:  #1C1C21;   /* Double-elevated — modals, overlays */

/* Accent */
--color-gold:        #C9A96E;   /* Primary accent — CTAs, scores, headings */
--color-gold-light:  #E8C97A;   /* Hover / highlight state of gold */
--color-teal:        #2A7B8C;   /* Secondary accent — regions, tags, links */
--color-teal-light:  #4AABB8;   /* Teal hover / light variant */

/* Text */
--color-cream:       #F5F0E8;   /* Primary text — all body and headings */
--color-text-60:     rgba(245,240,232,0.65);  /* Secondary text */
--color-text-38:     rgba(245,240,232,0.38);  /* Muted / placeholder text */

/* Glass system */
--glass-fill:        rgba(255,255,255,0.06);  /* Default glass panel fill */
--glass-fill-hover:  rgba(255,255,255,0.10);  /* Glass hover state */
--glass-border:      rgba(255,255,255,0.12);  /* Glass panel border */
--glass-border-sub:  rgba(255,255,255,0.06);  /* Subtle divider lines */
```

**Usage rules:**
- Background of every page: `--color-base` (#09090B)
- Never use pure white (#FFFFFF) as a fill — only as opacity layer for glass
- Gold (#C9A96E) is for CTAs, Tim Score numbers, section labels, active states only — never decorative
- Teal (#2A7B8C) is for region tags, secondary links, Kim's Asia content indicators
- All glass panels: white fill at 6–12% opacity + 1px white border at 12% + `backdrop-filter: blur(20px)`

---

## Typography

```css
/* Font families */
--font-display: 'Playfair Display', Georgia, serif;   /* All headlines and display text */
--font-ui:      'Inter', system-ui, sans-serif;        /* Body, UI, labels, captions */

/* Type scale */
--text-display-xl: 96px / 1.0  Playfair Display Bold Italic  /* Hero headline */
--text-display-l:  64px / 1.1  Playfair Display Regular      /* Page titles */
--text-display-m:  48px / 1.15 Playfair Display Regular      /* Section titles */
--text-display-s:  32px / 1.2  Playfair Display Regular      /* Subsection titles */
--text-display-xs: 24px / 1.3  Playfair Display Italic       /* Pull quotes, captions */

--text-body-l:  18px / 1.6  Inter Regular    /* Lead paragraphs */
--text-body-m:  16px / 1.6  Inter Regular    /* Standard body text */
--text-body-s:  14px / 1.5  Inter Regular    /* Secondary body, card text */
--text-label:   11px / 1.0  Inter Semi Bold  /* ALL CAPS section labels, tags */
--text-meta:    12px / 1.4  Inter Regular    /* Dates, sources, attribution */

/* Letter spacing */
--tracking-label: 0.3em;   /* All uppercase LABEL text — always use this */
--tracking-tight: -0.02em; /* Large display text (>64px) */
```

**Usage rules:**
- Playfair Display for ALL display headlines — never Inter for a headline
- Playfair Display Italic for Tim quotes, pull quotes, manifesto text
- Inter Semi Bold ALL CAPS with `letter-spacing: 0.3em` for every section label
- Tim's name and attribution: Inter Regular, gold color (#C9A96E)
- Verified dates and sources: Inter Regular, muted (38% cream opacity)

---

## Spacing System

```
4px   — micro gaps (icon/text pairs)
8px   — tight spacing
12px  — compact padding
16px  — standard gap
24px  — component padding
32px  — section internal gap
48px  — component vertical rhythm
64px  — section padding top/bottom
80px  — large section padding
120px — hero section internal padding
```

---

## Glass Panel System

Every panel, card, nav bar, and modal uses this liquid glass treatment:

```css
.glass-panel {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
}

.glass-panel-hover:hover {
  background: rgba(255, 255, 255, 0.10);
  border-color: rgba(255, 255, 255, 0.18);
}

.glass-nav {
  background: rgba(9, 9, 11, 0.5);
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  backdrop-filter: blur(24px);
}
```

Border radius: `16px` for cards, `12px` for panels, `100px` for buttons and badges, `24px` for large CTA containers.

---

## Component Patterns

### The Tim Score Badge
```html
<!-- Gold pill badge, right-aligned on lodge cards -->
<span class="tim-score-badge">94</span>
```
```css
.tim-score-badge {
  background: #C9A96E;
  color: #09090B;
  font: 700 14px/1 'Inter', sans-serif;
  padding: 6px 16px;
  border-radius: 100px;
}
```

### Region Tag
```html
<span class="region-tag">SERENGETI, TANZANIA</span>
```
```css
.region-tag {
  color: #4AABB8;
  font: 600 10px/1 'Inter', sans-serif;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}
```

### Section Label (ALL CAPS gold, always above section titles)
```html
<p class="section-label">THE TIM SCORE</p>
<h2 class="section-title">A Rating Built on Actual Stays</h2>
```
```css
.section-label {
  color: #C9A96E;
  font: 600 11px/1 'Inter', sans-serif;
  letter-spacing: 0.35em;
  text-transform: uppercase;
}
.section-title {
  font: 400 48px/1.15 'Playfair Display', serif;
  color: #F5F0E8;
}
```

### Primary CTA Button
```css
.btn-primary {
  background: #C9A96E;
  color: #09090B;
  font: 600 15px/1 'Inter', sans-serif;
  padding: 16px 28px;
  border-radius: 100px;
  border: none;
}
.btn-primary:hover {
  background: #E8C97A;
}
```

### Secondary CTA Button (Glass)
```css
.btn-secondary {
  background: rgba(255,255,255,0.08);
  color: #F5F0E8;
  font: 600 15px/1 'Inter', sans-serif;
  padding: 16px 28px;
  border-radius: 100px;
  border: 1px solid rgba(255,255,255,0.2);
  backdrop-filter: blur(8px);
}
```

---

## Animation System (Framer Motion)

```js
// Entrance animation — all content sections
const fadeUp = {
  hidden:  { opacity: 0, y: 32 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.7, ease: [0.25, 0.46, 0.45, 0.94] } }
};

// Staggered children (destination cards, lodge cards, score badges)
const stagger = {
  visible: { transition: { staggerChildren: 0.12 } }
};

// Hero headline character reveal
const heroReveal = {
  hidden:  { opacity: 0, y: 60, rotateX: -15 },
  visible: { opacity: 1, y: 0, rotateX: 0, transition: { duration: 1.0, ease: 'easeOut' } }
};

// Glass panel shimmer on hover
const glassHover = {
  whileHover: { scale: 1.02, transition: { duration: 0.25, ease: 'easeOut' } }
};

// Tim Score number count-up (trigger on scroll into view)
// Use: react-countup with start=0, end=score, duration=1.5, delay=0.3
```

---

## Page Structure Rules

1. **Every page starts with the glass nav bar** — sticky, backdrop blur, gold "Get Intelligence" CTA on right
2. **Every section has a gold ALL CAPS label above the headline** — e.g. "DESTINATIONS" above "Where We Go"
3. **Answer-first structure** — the most important sentence appears in the first paragraph, not at the end
4. **Tim Score badge** appears on every lodge card and every property mention
5. **Region tag** (teal, ALL CAPS) appears above every property name
6. **Verified date and source** appears below every data point: `Verified June 2026 · Tim Hennig, on-site visit`
7. **Footer**: Three columns — East Africa destinations, Southeast Asia destinations, Intelligence links. Gold BP logo left. Newsletter signup right.

---

## Editorial Voice Rules (for AI-generated copy)

- Write as Tim: first-person, present tense, specific observations
- Never hedging language ("might be", "could be", "seems like") — state facts plainly or attribute them
- Never superlatives without evidence ("best in Africa") — use the Tim Score instead
- Always name the specific date of the visit in any lodge review
- "Tim Score: 94/100" not "highly rated" or "excellent"
- Kim writes Vietnam content — same voice standard, attributed to Kim

---

## What NOT to Do

- Never use white, light gray, or beige as a page background
- Never use blue (except teal for secondary accents)
- Never use Inter for a headline — Playfair Display only
- Never use gold decoratively — only for CTAs, scores, and section labels
- Never generate a fact without a source
- Never name a property "the best" without the Tim Score to back it up
- Never use placeholder lorem ipsum — always use real Beyond Paradise copy or leave a visible `[CONTENT NEEDED]` marker
