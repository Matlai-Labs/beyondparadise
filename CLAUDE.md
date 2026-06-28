# Beyond Paradise — Agent Instructions

Beyond Paradise is an independent luxury travel editorial brand for East Africa + Southeast Asia. €6,000+ trips only. No press trips. No hosted stays. No advertiser influence. Every claim is first-hand or peer-reviewed.

**Before doing anything, read the master checklist:**
`/Users/tim/Desktop/AI_projects/shared_knowledge/docs/new-site-master-checklist.md`

**Design system (visual/brand rules):**
`/Users/tim/Desktop/AI_projects/beyondparadiseadventures/DESIGN.md`

---

## Mission & positioning

Beyond Paradise is NOT a package-tourism directory. It is a **decision-support engine** for high-AOV travelers asking: *Which lodge? Which animal, which month? Is this operator ethical?*

The keystone product is the **Marine Wildlife Encounter Index**: species × location × month × sighting-probability × legality × verified-ethical-operator — a unified, AI-citable index that no incumbent owns.

- **Tim** covers East Africa: Zanzibar, Serengeti (Tanzania), Masai Mara (Kenya), Rwanda, Mafia Island
- **Kim** covers Southeast Asia: Vietnam (Hoi An, Hanoi, Ha Long Bay, Hue)
- Distinct from WildToSea (WildToSea = "where to go in Tanzania"; Beyond Paradise = "which experience, which month, is it ethical?")
- Distinct from Matlai (Matlai = hotel; Beyond Paradise = independent editorial)

---

## Tech stack

- **Framework:** Astro 4 (static site, zero JS bloat, AI-crawler friendly)
- **Deploy:** Cloudflare Pages — auto-deploys on `git push main` (`github.com/Matlai-Labs/beyondparadiseadventures`)
- **URL:** `beyondparadise.com` (owned, domain connected after first deploy)
- **Styling:** Custom CSS only, no Tailwind. Design tokens in `site/src/styles/global.css`
- **Data:** JSON databases in `data/` (not inside `site/`) — lodges, wildlife, destinations, operators, facts
- **Languages:** English first, German (DE) + French (FR) Phase 2
- **Newsletter:** Beehiiv — free to 2,500 subscribers; form action in `NewsletterCTA.astro`
- **Pipelines:** ≤€20/month total cap across all pipelines. Hard fail-closed — no exceptions.
- **Daily pipeline:** (to be built) research → promote → feed → push → IndexNow → GSC → Bing

---

## Non-negotiable rules

### 1. Tim Score on every lodge
Every lodge review must display a Tim Score badge. Score is 0–100 integer, based on 12 weighted criteria, only assigned after Tim's personal stay. No score = no review published.

Tim Score criteria (12 factors, weighted):
1. **Wilderness position** (15%) — isolation, habitat quality, zero light/noise pollution
2. **Accommodation quality** (12%) — construction, materials, maintenance
3. **Wildlife access** (12%) — density, diversity, proximity, guide quality
4. **Food & beverage** (10%) — quality, sourcing, creativity
5. **Service** (10%) — staff warmth, proactivity, personalisation
6. **Activities** (8%) — range, exclusivity, guides' expertise
7. **Conservation impact** (8%) — verifiable contributions, land, anti-poaching
8. **Value for money** (8%) — at €6k+ price point, value must be extraordinary
9. **Sustainability** (7%) — energy, water, waste, supply chain (observable only)
10. **Sense of place** (5%) — architecture, materials rooted in local culture
11. **Exclusivity** (3%) — number of guests, privacy
12. **Repeat visit intention** (2%) — would Tim go back?

Score bands: 90–100 = Exceptional · 85–89 = Excellent · 80–84 = Very Good · <80 = Not recommended

### 2. Never write specifics without the database
Every price, fee, season, probability, or named claim must exist in `data/` or `data/facts/facts.json` with ≥2 independent sources. If it's not there, don't write it — add it first with proper sourcing.

### 3. Wildlife ethics = non-negotiable
Ethics grading uses **observable criteria only**: documented tourism-impact studies, conservation partnerships, permit status, habitat restoration. Never speculate on "sustainability." Every species × location × ethics entry must link to a peer-reviewed source or official regulation. Re-verify sighting/legality data on cadence:
- **Monthly:** in-season encounter probabilities
- **Quarterly:** operator permit status, species range updates
- **Annually:** IUCN Red List status, operator directory audit

### 4. First-hand authority or citation
Every claim is either:
- **Tim first-hand** (marked `[TIM]`, includes visit date + specific observation)
- **Kim first-hand** (marked `[KIM]`, Vietnam content)
- **Peer-reviewed** (PLOS ONE, Marine Mammal Science, CORDIO EA, IUCN Red List — all in `data/facts/sources.json`)
- **Official** (TANAPA, KWS, Marine Parks Authority, WWF/WCS official reports)

No hedging ("might be", "could be", "seems like"). State facts plainly or attribute them.

### 5. Editorial independence is the brand
Tim's Matlai conflict of interest is disclosed on `/about/editorial-policy/`. Beyond Paradise **never reviews Matlai** (Tim owns it = conflict). All other lodges are reviewed after paid stays. Never accept free stays, press trips, or hosted experiences. This is the core moat — guard it.

### 6. Page structure — mandatory on every page
Read `shared_knowledge/docs/content-page-standards-playbook.md`. Every guide page must have:

```
AnswerBox (50–100 words, direct answer with at least 1 number)
→ Quick-facts table
→ ≥5 H2 sections (answer in sentence 1 of each)
→ Tim Score card (lodge reviews only)
→ FAQ (5–8 questions, 2–3 sentence answers)
→ AuthorBlock (Tim or Kim, with first-hand context)
→ RelatedReads (3 internal links minimum)
```

Word counts:
- Spoke guides: 1,500 minimum, 2,000 target
- Hub pages: 900 minimum, 1,200 target
- Lodge reviews: 2,000 minimum, 2,500 target
- Wildlife guides: 1,800 minimum, 2,200 target

### 7. SEO + AI visibility before publishing
Read `shared_knowledge/docs/seo-ai-content-site-playbook.md`. Key rules:
- Answer in sentence 1 of every section
- Lists over prose for extractable content
- ≥1 Tim or Kim first-person anecdote per article
- heroAlt on every image (descriptive, not keyword-stuffed)
- Schema.org markup: Article + Person (author) + Review (lodges) + Place + Event (migration calendar)
- AI citation config: `public/llms.txt` (exists) + `public/robots.txt` (AI crawlers explicitly welcome)

### 8. URL scheme — locked, never change
```
/reviews/[lodge-slug]/              # lodge review pages
/east-africa/[region]/[slug]/       # East Africa destination + guide pages
/southeast-asia/[region]/[slug]/    # Kim's Southeast Asia pages
/wildlife/[species-slug]/           # Marine wildlife encounter guides
/intelligence/                      # Data hub (migration calendar, price DB)
/intelligence/migration-calendar/
/intelligence/prices/
/about/tim-score/                   # Tim Score methodology
/about/editorial-policy/
/about/kim/                         # Kim's author page
```

Published slugs are append-only. If a slug must change: 301 redirect, update internal links same commit.

### 9. Build must pass before commit
```bash
cd site && npm run build
```
Fix all errors before pushing. `git push` triggers Cloudflare Pages rebuild.

### 10. Internal linking rules
- Every new page needs ≥2 inbound links from existing pages wired on the same commit
- Lodge reviews link to: region hub, species guide (if wildlife adjacent), Tim Score page
- Species guides link to: location hub, operator directory, ethical framework
- Run link audit before major publishes

---

## File map

```
beyondparadiseadventures/
├── CLAUDE.md                         # This file — agent instructions
├── DESIGN.md                         # Visual/brand system (colors, type, spacing, components)
├── data/                             # Knowledge base — all structured data
│   ├── lodges/
│   │   └── lodges.json               # Reviewed lodges with Tim Scores
│   ├── wildlife/
│   │   ├── species.json              # Species × location × month × probability × ethics
│   │   └── calendar.json             # Month-by-month encounter calendar
│   ├── destinations/
│   │   └── destinations.json         # Region profiles (geography, best season, anchors)
│   ├── operators/
│   │   └── operators.json            # Verified ethical operators (wildlife + lodges)
│   └── facts/
│       ├── facts.json                # Sourced facts (WildToSea schema — 2+ source rule)
│       ├── sources.json              # Source tier registry (6 tiers)
│       └── taxonomy.json             # Closed vocabulary (topics, regions, statuses)
└── site/                             # Astro site (landing page live at beyondparadise.com)
    ├── src/
    │   ├── components/               # All landing page sections
    │   ├── layouts/                  # Base.astro, BaseHead.astro
    │   ├── pages/                    # index.astro (live), future: reviews/, wildlife/
    │   └── styles/global.css         # Design tokens + glass system
    └── public/
        ├── robots.txt                # AI crawlers explicitly welcome
        ├── llms.txt                  # AI citation guidance
        └── favicon.svg
```

---

## Data schemas

### lodges.json entry
```json
{
  "id": "singita-grumeti",
  "name": "Singita Grumeti",
  "region": "serengeti",
  "sub_region": "Western Corridor",
  "country": "tz",
  "tim_score": 94,
  "tim_score_date": "2026-01",
  "price_per_night_eur": 3200,
  "price_all_in": true,
  "price_includes": ["accommodation", "meals", "game-drives", "park-fees", "transfers"],
  "best_season": ["jun", "jul", "aug", "sep"],
  "tags": ["big-five", "migration", "ultra-luxury", "serengeti"],
  "status": "recommended",
  "tim_visited": true,
  "tim_visit_date": "2025-11",
  "description": "Tim's short verdict (2–3 sentences, first-person)",
  "website": "https://singita.com/lodge/singita-grumeti/",
  "affiliate_url": ""
}
```

### species.json entry
```json
{
  "id": "whale-shark",
  "common_name": "Whale Shark",
  "scientific_name": "Rhincodon typus",
  "iucn_status": "EN",
  "iucn_url": "https://www.iucnredlist.org/species/19488/2365291",
  "locations": [
    {
      "region": "mafia-island",
      "country": "tz",
      "site": "Mafia Marine Park",
      "months": [10, 11, 12, 1, 2],
      "peak_months": [11, 12, 1],
      "probability": "high",
      "probability_notes": "~180–200 individuals documented; citizen-science via sharkbook.ai",
      "permit_required": true,
      "permit_authority": "MPRU Tanzania",
      "max_swimmers_per_animal": 6,
      "source": "marine-megafauna-foundation-2023"
    }
  ],
  "ethics": {
    "swim_with": "permitted",
    "restrictions": ["no touching", "minimum 3m distance", "max 6 swimmers per animal", "no flash photography", "no underwater scooters"],
    "red_flags": ["operators ignoring separation distance", "motorised approaches within 50m"]
  },
  "tim_firsthand": false,
  "kim_firsthand": false
}
```

### facts.json entry (WildToSea-compatible schema)
```json
{
  "id": "whale-shark-mafia-season",
  "claim": "Whale sharks aggregate around Mafia Island from October to February, with peak sightings in November–January.",
  "sources": [
    {
      "name": "Marine Megafauna Foundation",
      "url": "https://marinemegafauna.org/research/whale-sharks/",
      "tier": 1,
      "accessed": "2026-06-27"
    },
    {
      "name": "Wildbook for Whale Sharks (sharkbook.ai) — Tanzania records",
      "url": "https://www.sharkbook.ai",
      "tier": 2,
      "accessed": "2026-06-27"
    }
  ],
  "status": "confirmed",
  "topic": "whale-sharks",
  "region": "mafia-island",
  "added": "2026-06-27"
}
```

---

## Revenue model

1. **High-ticket liveaboard lead-gen** — ZuBlu / Bluewater / PADI Travel sub-agent (€100–300+/booking). Requires formal agency relationship. Phase 2.
2. **GetYourGuide + Viator wildlife day-tours** — 8–10% commission, 30-day cookie. Wire on first wildlife guide pages.
3. **Verified ethical operator directory** — $29–499/year recurring B2B. Operators pay to be listed + verified. Income independent of bookings.
4. **Lodge affiliate** — Stay22 lodging (~$10/booking, fixes Booking.com session-cookie leak).
5. **Consultation product** (Phase 3) — automated AI itinerary (form → AI → PDF), €49–99 each.

**Monthly cost cap: ≤€20 across all pipelines.** Hard fail-closed. See global CLAUDE.md rule.

---

## What NOT to do

- **Never review Matlai** (Tim owns it = undisclosable conflict)
- **Never duplicate WildToSea content** (WildToSea = package tourism; Beyond Paradise = encounter decision engine)
- **Never accept free stays, press trips, or hosted experiences**
- **Never assign a Tim Score without Tim's personal stay**
- **Never speculate on sustainability** — only grade observable, documented criteria
- **Never use affiliate links without disclosure**
- **Never write a specific number without ≥2 sources in facts.json**
- **Never promise encounter certainty** ("you will see whale sharks") — always give probability + caveat
- **Never index content before Tim Score is assigned** (for lodge reviews)

---

## Shared infrastructure (what exists, where to clone from)

| Infrastructure | Clone from | Path |
|----------------|-----------|------|
| Daily pipeline | WildToSea | `wildtosea/auto_pipeline.sh` |
| Search submission | WildToSea | `wildtosea/tools/` (IndexNow, GSC, Bing) |
| Research engine | PadelRevive | `padelrevive-research-engine/` |
| Social engine | PadelRevive | `padelrevive-social-engine/` |
| Wikidata automation | Matlai | `shared_knowledge/scripts/wikidata_sync.py` |
| Fact DB schema | WildToSea | `wildtosea/site/src/data/research/facts.json` |
| SEO playbook | Shared | `shared_knowledge/docs/seo-ai-content-site-playbook.md` |
| Content standards | Shared | `shared_knowledge/docs/content-page-standards-playbook.md` |
| Fact DB playbook | Shared | `shared_knowledge/docs/sourced-fact-database-playbook.md` |
| Site design blueprint | Shared | `shared_knowledge/docs/travel-site-design-blueprint-playbook.md` |
| Slug + cluster rules | Shared | `shared_knowledge/docs/slug-and-cluster-quick-reference.md` |
| AI model selection | Shared | `shared_knowledge/docs/ai-model-selection-database.md` |
| Verify-before-done | Shared | `shared_knowledge/docs/verify-fixes-before-claiming-done-playbook.md` |

---

## Phase roadmap

**Phase 1 (Now — Q3 2026):** Landing page live ✅ → Tim Score methodology page → Editorial policy page → 3–5 first lodge reviews (East Africa) → First wildlife guide (whale sharks Mafia) → Beehiiv newsletter setup → Domain connect

**Phase 2 (Q4 2026):** Kim's Vietnam hub (3–5 pages) → Ethical operator directory (beta) → GYG/Viator affiliate wired → Daily pipeline live → German language pilot → Wikidata entities created

**Phase 3 (2027):** Marine Wildlife Encounter Index (full species × location × month DB) → Price database → Migration calendar (live-updated) → AI consultation product → Liveaboard agency relationship

---

## Authors

**Tim Hennig** — East Africa lead. GM, Boutique Hotel Matlai, Michamvi Pingwe, Zanzibar. 5+ years living East Africa. 80+ luxury properties personally reviewed.

**Kim** — Southeast Asia lead. Vietnamese, lives in Zanzibar. First-hand knowledge of Vietnam luxury travel: Hoi An, Hanoi, Ha Long Bay, Hue.

Wikidata: Tim Hennig = Q140307013 (see `shared_knowledge/scripts/wikidata_configs/matlai.json`)
