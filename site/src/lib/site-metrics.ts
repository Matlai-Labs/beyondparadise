// Counts used in hero copy and llms.txt. Derived at build time so the two can never disagree
// and nothing is hand-typed. A lodge counts as "reviewed" only if its review is published
// (draft: false) AND carries a Tim Score (which requires Tim's paid stay).
import { getCollection } from 'astro:content';
import { factCounts } from './facts-stats';

export async function siteMetrics() {
  const [reviews, wildlife, destinations, excursions] = await Promise.all([
    getCollection('reviews', ({ data }) => !data.draft),
    getCollection('wildlife', ({ data }) => !data.draft),
    getCollection('destinations', ({ data }) => !data.draft),
    getCollection('excursions', ({ data }) => !data.draft),
  ]);
  const scoredLodges = reviews.filter(r => typeof r.data.tim_score === 'number').length;
  const fc = factCounts();
  return {
    scoredLodges,
    publishedReviews: reviews.length,
    wildlife, destinations, excursions, reviews,
    guideCount: wildlife.length + destinations.length + excursions.length,
    factsConfirmed: fc.confirmed,
    factsTotal: fc.total,
  };
}
