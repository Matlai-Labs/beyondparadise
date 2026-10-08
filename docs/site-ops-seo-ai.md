# Site ops: SEO / AI-visibility build gates and env switches (2026-10-08)

## Build gates (run by `cd site && npm run build`, also by `site/deploy.sh`)
- `scripts/content-gate.mjs`: every built page needs title <= 60, description <= 155 and a complete sentence (no ellipsis), no AI-style title phrases ("What to Know Before You Go", "Complete Guide" ...), no duplicate titles.
- `scripts/check-links.mjs`: every internal href/src/og:image/anchor resolves inside `dist/`; no orphan pages; every page within 2 clicks of home.
- `src/lib/facts-stats.ts`: the stats page, CSV, Dataset JSON-LD and migration-calendar table throw at build time if a fact is not `confirmed`, has no source URL, or the displayed number is not in the fact text.
- `src/lib/site-metrics.ts`: hero numbers and `/llms.txt` are derived from the same counts (published reviews, Tim Scores, guides, confirmed facts).

## Excursion titles and descriptions
Hand-written per pickup area in `data/excursions/excursions.json` (`seo_title`, `seo_description`); `pipeline/seo/generate-excursion-pages.js` refuses to run without them. Regenerate with `node pipeline/seo/generate-excursion-pages.js`.

## Env switches (build time; see `.env.example`)
`PUBLIC_BEEHIIV_FORM_ACTION`, `PUBLIC_GA4_ID`, `PUBLIC_GSC_VERIFICATION`. GA4 also needs the event-scoped custom dimensions `ai_source` and `is_ai_referral` registered in GA4 admin.

## GitHub Pages limits
GitHub Pages cannot set response headers or server redirects. No `_headers`/`_redirects` (Cloudflare-only), no HSTS/CSP/Cache-Control control, no 301s for renamed slugs (use a meta-refresh stub page plus canonical if a slug ever changes), and no WAF (Bytespider cannot be blocked). If any of that is needed, put Cloudflare in front or move hosting.

## IndexNow
Key file `site/public/<32 hex>.txt`. After deploy: `cd site && node scripts/indexnow-submit.mjs` (dry run), then `--send`. It refuses to send until the key file is live. Google ignores IndexNow; submit the sitemap in Search Console.

## Quarterly refresh
Facts on the stats page were last accessed 2026-06-28 to 2026-06-30 (already past the quarterly window). Re-verify via the research pipeline, rebuild, deploy; `lastmod`, CSV and Dataset `dateModified` follow the facts.
