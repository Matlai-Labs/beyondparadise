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

## Open items needing Tim (2026-10-08)
### Beehiiv newsletter (no publication exists anywhere in the fleet; account creation is Tim's)
1. Sign up free at beehiiv.com with info@ or tim@ (Tim's choice), create a publication named "Beyond Paradise Adventures".
2. Grow > Subscribe forms > create an Embed form > copy the form `action` URL.
3. Put it in `site/.env` as `PUBLIC_BEEHIIV_FORM_ACTION=<url>`.
4. `cd site && ./deploy.sh`. The honest "not open yet" notice then becomes the real form.
5. Test with one subscription from a private address and confirm it lands in Beehiiv.

### Tim: paste these (4 env vars, about 20 minutes in total)
Put each value in `site/.env` (one `NAME=value` per line, no quotes), then `cd site && ./deploy.sh`. Anything left unset emits nothing.

| Variable | Where to get it | Time |
|---|---|---|
| `PUBLIC_GSC_VERIFICATION` | search.google.com/search-console > Add property > URL prefix `https://beyondparadiseadventures.com` > HTML tag. Copy only the `content="..."` value. After deploy click Verify, then submit `sitemap-index.xml`. | 5 min |
| `PUBLIC_BING_VERIFICATION` | bing.com/webmasters > Add site (or Import from Search Console, which skips this) > HTML Meta Tag. Copy only the `content="..."` value of `msvalidate.01`. After deploy click Verify, submit `sitemap-index.xml`. | 5 min |
| `PUBLIC_GA4_ID` | analytics.google.com > Admin > Create property > Web stream. Copy the `G-XXXXXXXXXX` Measurement ID. | 5 min |
| `PUBLIC_CF_ANALYTICS_TOKEN` | dash.cloudflare.com > Web Analytics > Add a site > enter `beyondparadiseadventures.com`, choose the JS snippet option (works on any host, GitHub Pages included, no Cloudflare proxy needed). Copy only the `token` value from `data-cf-beacon='{"token": "..."}'`. Free and cookieless. | 5 min |

The site sets no Content-Security-Policy (GitHub Pages sends none and the layout has no CSP meta tag), so the Cloudflare beacon needs no allow-list. If a CSP is ever added, allow `script-src https://static.cloudflareinsights.com` and `connect-src https://cloudflareinsights.com`.

### GA4 and Search Console (detail)
GA4: Admin > Create property "Beyond Paradise Adventures" > Web stream https://beyondparadiseadventures.com > copy `G-...` into `PUBLIC_GA4_ID`; register event-scoped custom dimensions `ai_source`, `is_ai_referral`.
GSC: add URL-prefix property https://beyondparadiseadventures.com > HTML tag method > copy only the `content` value into `PUBLIC_GSC_VERIFICATION` > deploy > Verify. (DNS TXT alternative: Hostinger, not editable from here; apex currently shows no TXT records.) Then submit `sitemap-index.xml` (live URL https://beyondparadiseadventures.com/sitemap-index.xml; `/sitemap.xml` does not exist and returns 404).

### Decisions recorded
- Social profiles verified 2026-10-08 (HTTP 200, correct titles): facebook.com/beyondparadiseadventures, instagram.com/beyondparadiseadventures, YouTube @BPA-Africa and @beyondparadiseadventures (titled "BPA - Asia"). Old @BeyondParadiseAfrica/@BeyondParadiseAsia 404.
- Editorial policy wins: no editorial copy names the hotel; only the disclosure on /about/editorial-policy/, author bios and llms.txt do.
- "80+ properties" stays removed; counts come from `site-metrics.ts`.
- Park fees stay labelled 2023/24 tariff: tanzaniaparks.go.tz exposes no newer tariff; secondary 2025/26 sources disagree ($70 to $83), so none is adopted.
- Mainland Tanzania inbound insurance (NIC, from 1 Oct 2026, reported by secondary sources only) is not yet in facts; add once the official notice is fetched.
