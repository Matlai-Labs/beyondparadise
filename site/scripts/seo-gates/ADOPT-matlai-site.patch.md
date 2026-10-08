# Adopting seo-gates in `matlai-site` (steps only - this file edits nothing)

Written 2026-10-08. `matlai-site` was NOT modified by the build. Apply these steps in a matlai-site worktree/branch of your choice.
Anchors refer to `matlai-site/scripts/dashboard.mjs` as read on 2026-10-08 (`gscPanel()` ~L158, `ga4Panel()` ~L302, `render()` ~L676, `main()` ~L720).

## 0. Vendor the library (products never import Agent OS or shared_knowledge at runtime)

```bash
cd /Users/tim/Desktop/AI_projects/matlai-site
mkdir -p scripts/seo-gates
cp -R ../shared_knowledge/scripts/seo-gates/{lib,*.mjs,claims.json,fanout,ga4-ai-assistants,tests,package.json} scripts/seo-gates/
node --test scripts/seo-gates/tests/*.test.mjs       # must be green before wiring anything
```

## 1. Package scripts (matlai-site/package.json)

```json
"seo:depth":  "node scripts/seo-gates/click-depth.mjs dist --max-depth 3",
"seo:titles": "node scripts/seo-gates/title-gate.mjs dist --limits scripts/seo-gates/limits.matlai-site.json --allow scripts/seo-gates/title-allow.json",
"seo:claims": "node scripts/seo-gates/claim-clock.mjs dist src content-db/pages content-db/posts",
"seo:stale":  "node scripts/seo-gates/stale-page.mjs dist",
"seo:fanout": "node scripts/seo-gates/fanout-coverage.mjs dist scripts/seo-gates/fanout/matlai-site.json",
"seo:flips":  "node scripts/seo-gates/claim-clock.mjs --flips",
"seo:gates":  "npm run seo:claims && npm run seo:titles && npm run seo:depth"
```

* Gate order: build -> `seo:gates`. `claim-clock` exits 1 on any ERROR (present-tense claim about a not-yet-operating route).
* Start `title-gate` in report mode (it WILL fail today: 186 `too-long` errors on the 2026-10-08 dist, mostly DE/FR/IT/ES/PL).
  Create `limits.matlai-site.json` (`{"de":{"max":68,"warnAt":63}, ...}`) only after Tim agrees the per-language limits, and an
  allow file for deliberate exceptions (`{"/recognition":["too-long"]}`).
* Known live hit to fix first: `claim-clock` ERROR on the "Your Zanzibar Compass part 1" post (all 6 languages, `content-db/posts/*/…compass…`).

## 2. dashboard.mjs - cluster panel (additive, ~30 lines)

Add near the other requires (top of file):

```js
import { rollup, renderMarkdown, loadClusterDefs } from './seo-gates/cluster-rollup.mjs';
import { parseGscPages, parseGenerativeAiCsv } from './seo-gates/lib/gsc.mjs';
```

Add a panel function after `gscPanel()`. It reuses the SAME OAuth objects gscPanel builds (`sc`), asking page-level data for the
last full quarter vs the one before - two extra `searchanalytics.query` calls, cached by the existing 24h cadence:

```js
async function clusterPanel(sc) {
  try {
    const defs = loadClusterDefs(JSON.parse(fs.readFileSync(path.join(__dirname, 'seo-gates', 'clusters.matlai-site.json'), 'utf8')));
    // ^ copy matlai_wix/matlai-seo-engine/config/cluster-definitions.json there ({clusters:{name:{pillar,spokes}}}); localized (de/fr/..)
    //   slugs differ per language, so add a "match" array of globs / "re:" regexes to any cluster that needs them
    //   (the roll-up also tries each path with its /de /fr /it /es /pl prefix stripped).
    const q = async (start, end) => (await sc.searchanalytics.query({ siteUrl: SITE_URL,
      requestBody: { startDate: start, endDate: end, dimensions: ['page'], rowLimit: 5000 } })).data.rows || [];
    const toPages = (rows) => parseGscPages(JSON.stringify({ rows }));
    const cur = toPages(await q(daysAgo(91), daysAgo(2))), prev = toPages(await q(daysAgo(182), daysAgo(92)));
    // Optional inputs (hand-exported, no API exists for the generative-AI report):
    const aiCsv = path.join(__dirname, '..', 'content-db', 'gsc-ai', 'latest.csv');          // Search Console -> Performance -> Search generative AI -> Export
    const ai = fs.existsSync(aiCsv) ? parseGenerativeAiCsv(fs.readFileSync(aiCsv, 'utf8')).rows : [];
    return rollup({ defs, current: cur, previous: prev, aiCurrent: ai, sessions: ga4AiSessionsByLandingPage /* from ga4Panel, see 3 */ });
  } catch (e) { return { error: e.message }; }
}
```

In `render()` add (after the GA4 card, ~L691):

```js
<h2>Clusters (quarter over quarter)</h2>
<div class="card">${cluster.error ? `<p class="warn">Cluster rollup unavailable: ${esc(cluster.error)}</p>` : `<pre>${esc(renderMarkdown(cluster))}</pre>`}</div>
```

In `main()` thread it through: build `sc` once (or return it from `gscPanel`), then
`const cluster = await clusterPanel(sc);` and pass `{ ..., cluster }` into `render`.

## 3. GA4 AI-assistant channel (so the "AI sessions" column is real)

1. Tim creates the **AI Assistants** channel group in GA4 (UI steps: `ga4-ai-assistants/README.md`, Part A).
2. In `ga4Panel()` replace the loose `AI_REFERRER_RE` filter with the channel: dimension `sessionAiAssistants`... **API name of a custom
   channel group is not predictable** - read it once from GA4 Admin -> Channel groups (or Data API metadata) and put it in one const.
   Until then keep the existing `sessionSource` regex, imported from `ga4-ai-assistants/ai-source.mjs` (`AI_SESSION_SOURCE_REGEX`) so
   the regex lives in ONE place.
3. Add a 6th `run()` with dimensions `[{name:'landingPage'}]`, metric `sessions`, same AI filter, 91-day range; map rows to
   `[{path: row.dimensionValues[0].value, sessions: Number(row.metricValues[0].value)}]` and pass as `sessions` above.

## 4. Verify

```bash
node --test scripts/seo-gates/tests/*.test.mjs
node scripts/dashboard.mjs && open reports/dashboard.html     # Clusters section shows one row per cluster + (unclustered) + TOTAL
node scripts/seo-gates/claim-clock.mjs dist --today $(date +%F)   # exit 1 until the Compass post is corrected
```

## 5. Scheduling the monthly "what flips today" report

`node scripts/seo-gates/claim-clock.mjs --flips` prints claims whose `valid_from` has passed (copy must flip to present tense),
claims that ended, and flips due in 45 days. Add it to the existing daily launchd dashboard job (print only; WhatsApp via the local
bridge if the "NOW OPERATING" or "ENDED" list is non-empty - first expected on **2027-05-29** for British Airways).
