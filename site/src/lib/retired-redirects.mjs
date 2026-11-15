// Retired excursion URLs. GitHub Pages cannot send 301s, so each old URL is built as a small stub page
// (canonical + noindex + meta refresh + JS redirect) pointing at the merged page. Keep these forever;
// published slugs are append-only (CLAUDE.md rule 8). The stubs are filtered out of the sitemap (astro.config.mjs).
const SPICE = '/excursions/stone-town-spice-farm-day-trip-from-zanzibar-beaches/';
const MNEMBA = '/excursions/mnemba-atoll-snorkeling-from-kendwa-or-stone-town/';
export const RETIRED = {
  'stone-town-spice-tour-from-jambiani': SPICE,
  'stone-town-spice-tour-from-kendwa': SPICE,
  'stone-town-spice-tour-from-michamvi': SPICE,
  'stone-town-spice-tour-from-nungwi': SPICE,
  'stone-town-spice-tour-from-paje': SPICE,
  'mnemba-atoll-snorkeling-from-kendwa': MNEMBA,
  'mnemba-atoll-snorkeling-from-stone-town-airport': MNEMBA,
};
