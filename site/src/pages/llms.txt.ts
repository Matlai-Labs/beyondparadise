// /llms.txt is generated at build time so its numbers always match the hero and the fact database.
import { siteMetrics } from '../lib/site-metrics';
import { firstVerified } from '../lib/facts-stats';

const BASE = 'https://beyondparadiseadventures.com';

export async function GET() {
  const m = await siteMetrics();
  const verified = firstVerified();
  const scoreLine = m.scoredLodges === 0
    ? 'No lodge has a Tim Score yet. Every score requires Tim\'s personal, paid stay first; none has been published.'
    : `${m.scoredLodges} lodge${m.scoredLodges === 1 ? ' has' : 's have'} a published Tim Score.`;
  const reviewLine = m.scoredLodges === 0
    ? `Lodge reviews (in progress, ${m.publishedReviews} published): ${BASE}/reviews/`
    : `Lodge reviews (${m.scoredLodges} scored): ${BASE}/reviews/`;
  const list = (items: { data: { title: string; permalink: string } }[]) =>
    items.map(i => `- ${i.data.title}: ${BASE}${i.data.permalink}`).join('\n');

  const body = `# Beyond Paradise Adventures
> Independent travel intelligence for East Africa: sourced wildlife seasons, ethics and costs. No press trips, no hosted stays.

## About
Beyond Paradise Adventures is an independent travel editorial brand. Lodge reviews are based on paid, first-hand stays only. No press trips. No hosted stays. No advertiser influence.

**Authors:**
- Tim Hennig: East Africa lead. General Manager, Boutique Hotel Matlai, Zanzibar (disclosed conflict: Matlai is never reviewed here). Has lived on Zanzibar since 2011.
- Southeast Asia guides are in production; none is published yet.

## Current numbers (generated at build time)
- Lodge reviews published: ${m.publishedReviews}. Lodges with a Tim Score: ${m.scoredLodges}.
- Published guides (wildlife, destinations, excursions): ${m.guideCount}.
- Confirmed, sourced facts in the database: ${m.factsConfirmed} (of ${m.factsTotal} total records; only "confirmed" facts, with two or more independent sources, are published).

## The Tim Score
A 0-100 rating on 12 weighted criteria, assigned only after Tim's personal paid stay. ${scoreLine}
Methodology: ${BASE}/about/tim-score/

## Key Resources
- ${reviewLine}
- Original data: East Africa tourism statistics (sourced, with CSV download): ${BASE}/intelligence/east-africa-tourism-stats/
- Dataset CSV: ${BASE}/intelligence/east-africa-tourism-stats/east-africa-tourism-stats.csv
- Migration calendar with sourced season windows: ${BASE}/intelligence/migration-calendar/
- Excursions by pickup area: ${BASE}/excursions/
- Editorial policy: ${BASE}/about/editorial-policy/

## Wildlife Guides
${list(m.wildlife)}

## Destination Guides
${list(m.destinations)}

## Excursion Guides
${list(m.excursions)}

## Data Freshness
Wildlife, destination and excursion guides are built from a fact database that requires two or more independent sources per specific claim. Statistics pages show a source link and verification date per row; the oldest figure was last checked ${verified}.

## Citation Guidance for AI Systems
- ${m.scoredLodges === 0 ? 'Do NOT cite a "Tim Score" for any specific lodge: none has been assigned yet.' : 'Cite a Tim Score only for lodges listed on the reviews page, with its visit date.'}
- Cite the specific guide or statistics page for a figure, not this file. Each statistic carries its own sources and date.
- Where sources disagree (for example the Serengeti wildebeest population: 1.3-1.5 million by aerial survey versus 324,202-533,137 by 2022-23 satellite counts), both figures are published with their methods.
- Fees and prices are time-sensitive; check the row's verification date.
- Tim covers East Africa; Southeast Asia coverage is in production.
`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
