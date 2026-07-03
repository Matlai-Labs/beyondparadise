'use strict';

// ============================================================
// cross-share.js — regenerate Beyond Paradise's outbound
// knowledge-sharing files for WildToSea and Matlai.
//
// Zero AI cost: pure filtering + schema transformation, no API calls.
// Always regenerates the FULL output from current facts.json — no
// incremental diff state to maintain (cheap at BP's current scale).
//
// Mirrors the existing, working WildToSea -> Matlai bridge pattern
// (matlai_wix/matlai-seo-engine/config/facts/wildtosea-bridge.json)
// rather than inventing a new architecture:
//   - BP -> WildToSea: BP's facts are small enough to duplicate/absorb,
//     so this produces a candidates-shaped supplement WildToSea's own
//     merge_runs.py / promote.py can ingest through ITS OWN pipeline
//     (this script does not touch WildToSea's repo directly).
//   - BP -> Matlai: BP's facts.json is small and local, so this
//     produces a pointer/index file (same shape as wildtosea-bridge.json)
//     rather than a full duplicate.
//
// Run manually after significant KB growth:
//   node cross-share.js          # write both outputs
//   node cross-share.js --dry    # preview counts only, write nothing
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DATA_FACTS = path.join(ROOT, 'data', 'facts');
const SHARED = path.join(ROOT, '..', 'shared_knowledge');
const MATLAI_TARGETS = [
  path.join(ROOT, '..', 'matlai_wix', 'matlai-seo-engine', 'config', 'facts'),
  path.join(ROOT, '..', 'matlai-zanzibar-guide', 'src', 'data', 'facts'),
];

const DRY = process.argv.includes('--dry');
const today = () => new Date().toISOString().slice(0, 10);
const slugify = str => String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const factsRaw = JSON.parse(fs.readFileSync(path.join(DATA_FACTS, 'facts.json'), 'utf8'));
const allFacts = Array.isArray(factsRaw) ? factsRaw : factsRaw.facts;
const sourceRegistryRaw = JSON.parse(fs.readFileSync(path.join(DATA_FACTS, 'sources.json'), 'utf8'));
const sourcesMap = sourceRegistryRaw.sources || sourceRegistryRaw;

function normalizeSources(f) {
  return (f.sources || []).map(s => {
    if (typeof s === 'string') {
      const reg = sourcesMap[s];
      return { id: s, tier: reg ? reg.tier : null };
    }
    const id = slugify(s.name || s.url || 'unknown-source');
    return { id, tier: s.tier ?? null };
  });
}

// ── BP -> WildToSea candidate supplement ──────────────────────
// Explicit allowlist, not a mechanical diff against WildToSea's taxonomy —
// BP topic *names* like "exclusivity", "photography", "guide-quality" don't
// match WildToSea's naming but ARE already covered there under "experience"/
// "activities"; exporting them would just be noise, not a real gap-fill.
// This list is BP's genuine species/ecosystem specialist research — the
// kind of depth WildToSea's broad "marine"/"conservation" buckets don't have.
// Re-review this list whenever BP's topic set or WildToSea's taxonomy shifts.
const WILDTOSEA_GAP_TOPICS = new Set([
  'whale-sharks', 'sea-turtles', 'dolphins', 'humpback-whales', 'coral-reefs', 'marine-conservation',
  'african-lion', 'african-leopard', 'african-cheetah', 'african-elephant', 'african-buffalo',
  'black-rhino', 'african-wild-dog', 'big-cats', 'gorilla-trekking', 'wildebeest-migration',
  'wildebeest-calving', 'great-migration', 'anti-poaching', 'walking-safari', 'boat-safari', 'birds',
]);

// Topics/statuses that shift over time and shouldn't be treated as permanent
const VOLATILE_TOPICS = new Set(['prices', 'value', 'entry', 'entry-requirements', 'visa', 'health', 'seasons']);

function buildWildToSeaSupplement() {
  const eligible = allFacts.filter(f => WILDTOSEA_GAP_TOPICS.has(f.topic) && f.status !== 'unverified');

  const candidates = eligible.map(f => {
    const srcs = normalizeSources(f);
    const status = f.status === 'confirmed' ? 'confirmed' : 'single';
    const confidence = status === 'confirmed' ? 'high' : (srcs.some(s => s.tier && s.tier <= 2) ? 'medium' : 'low');
    const volatile = VOLATILE_TOPICS.has(f.topic);
    return {
      id: `beyondparadise-${f.id}`,
      topic: f.topic,
      region: f.region,
      claim: f.claim,
      value: f.claim,
      sources: srcs.map(s => s.id),
      status,
      confidence,
      volatile,
      lastChecked: f.added || f.lastChecked || today(),
      notes: `Source: Beyond Paradise research database (beyondparadiseadventures/data/facts/facts.json). Cross-shared ${today()}. Original id: ${f.id}.`,
    };
  });

  const out = {
    _meta: {
      description: 'Beyond Paradise -> WildToSea candidate supplement. Regenerated in full on each run from the live BP facts.json — not a point-in-time snapshot. Scoped to BP\'s genuine specialist gap-fill topics (species x season x ethics wildlife research) rather than a mechanical topic-name diff, since many BP topic names (exclusivity, photography, guide-quality, etc.) are just differently-named versions of things WildToSea already covers under experience/activities.',
      source: 'beyondparadiseadventures/data/facts/facts.json',
      generated: today(),
      count: candidates.length,
      topicsIncluded: [...new Set(candidates.map(c => c.topic))].sort(),
      howToImport: [
        '1. Copy this file into wildtosea/site/src/data/research/ as the next available run{N}_output.json',
        '2. cd wildtosea/site/src/data/research && python3 merge_runs.py {N}',
        '3. python3 second_source.py --max 300 --budget 3   (optional — corroborates single-source facts for free)',
        '4. python3 promote.py',
        "Unknown source IDs default to tier 4 in WildToSea's promote.py (safe, conservative) — tiers can be upgraded later by adding these sources to WildToSea's own sources.json.",
      ],
    },
    candidates,
  };

  const outPath = path.join(SHARED, 'data', 'bp-wildtosea-supplement.json');
  if (!DRY) fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  return { outPath, count: candidates.length };
}

// ── BP -> Matlai bridge (pointer/index, mirrors wildtosea-bridge.json) ──
const MATLAI_REGIONS = new Set(['zanzibar', 'menai-bay', 'mnemba-atoll', 'stone-town', 'pemba', 'mafia-island']);

const MATLAI_TOPIC_INFO = {
  'dolphins': { category: 'marineWildlife', relevance: 'Guest-facing marine wildlife content — Menai Bay dolphin excursions, ethical operator guidance (BP flags this as the site\'s most cautionary wildlife guide — rules exist but are often ignored in practice).', useCase: 'Marine wildlife FAQ, activities pages, guest excursion recommendations.' },
  'sea-turtles': { category: 'marineWildlife', relevance: 'Mnemba Atoll turtle encounters — nesting season, ethical viewing rules for guest advisories.', useCase: 'Snorkelling/activities content, marine wildlife FAQ.' },
  'marine-conservation': { category: 'marineWildlife', relevance: 'Reef health and conservation context for guest-facing sustainability messaging.', useCase: 'Sustainability posts, activities pages.' },
  'coral-reefs': { category: 'marineWildlife', relevance: 'Reef health/dive site detail for snorkelling and diving guest content.', useCase: 'Snorkelling/diving activity pages.' },
  'snorkelling': { category: 'marineWildlife', relevance: 'Zanzibar snorkelling site and ethics detail.', useCase: 'Activities pages, excursion recommendations.' },
  'scuba-diving': { category: 'marineWildlife', relevance: 'Zanzibar/Pemba dive site detail.', useCase: 'Activities pages.' },
  'kitesurfing': { category: 'marineWildlife', relevance: 'Paje kitesurfing season/school detail — relevant for guests asking about kite season.', useCase: 'Activities pages, seasonal guides.' },
  'humpback-whales': { category: 'marineWildlife', relevance: 'Whale-watching season detail for the Zanzibar channel.', useCase: 'Seasonal activity guides.' },
  'whale-sharks': { category: 'marineWildlife', relevance: 'Mafia Island whale shark day-trip detail — relevant for guests extending their stay beyond Zanzibar.', useCase: 'Excursion recommendations beyond Zanzibar.' },
  'seasons': { category: 'seasonsAndEntry', relevance: 'Kaskazi/Kusi season timing — core guest-facing best-time-to-visit content.', useCase: 'Best time to visit posts, seasonal activity guides.' },
  'entry-requirements': { category: 'seasonsAndEntry', relevance: 'Visa/entry requirements for guest pre-arrival guidance.', useCase: 'FAQ, pre-arrival guest communication.' },
  'visa': { category: 'seasonsAndEntry', relevance: 'Visa cost/process detail for guest pre-arrival guidance.', useCase: 'FAQ, pre-arrival guest communication.' },
  'health': { category: 'seasonsAndEntry', relevance: 'Malaria/vaccination guidance for guest pre-arrival communication.', useCase: 'FAQ, pre-arrival guest communication.' },
  'getting-there': { category: 'transferAndAccess', relevance: 'Airport/transfer logistics for guest arrival guidance.', useCase: '"How to get to Matlai" content, FAQ.' },
  'transfers': { category: 'transferAndAccess', relevance: 'Transfer time/mode detail for guest arrival guidance.', useCase: '"How to get to Matlai" content, FAQ.' },
  'destinations': { category: 'zanzibarDestinations', relevance: 'General Zanzibar destination/cultural detail for local-area content.', useCase: 'Local area exploration posts.' },
};

function buildMatlaiBridge() {
  const eligible = allFacts.filter(f => MATLAI_REGIONS.has(f.region) && MATLAI_TOPIC_INFO[f.topic] && f.status !== 'unverified');

  const byCategory = {};
  for (const f of eligible) {
    const info = MATLAI_TOPIC_INFO[f.topic];
    byCategory[info.category] = byCategory[info.category] || [];
    byCategory[info.category].push({
      bpFact: f.id,
      topic: f.claim.length > 90 ? f.claim.slice(0, 87) + '...' : f.claim,
      matlaiRelevance: info.relevance,
      blogUseCase: info.useCase,
    });
  }

  const out = {
    _meta: {
      description: "Index of Beyond Paradise fact IDs relevant to Matlai content — a peer bridge to wildtosea-bridge.json (Layer 2b). Does NOT duplicate facts — points to them. Beyond Paradise specializes in marine-wildlife-ethics-grade research (species x season x ethics) at a depth WildToSea's broader 'marine' topic doesn't cover.",
      lastUpdated: today(),
      bpDbPath: path.join(ROOT, 'data', 'facts', 'facts.json'),
      totalBpFacts: allFacts.length,
      matlaiRelevantFacts: eligible.length,
      howToUse: "Layer 2b of the knowledge architecture, alongside wildtosea-bridge.json (Layer 2a). When writing content, check both bridges for an existing fact ID before writing a claim from scratch. Tim-verified Matlai facts (Layer 1) always override both bridges on conflict.",
    },
    ...byCategory,
  };

  const results = [];
  for (const dir of MATLAI_TARGETS) {
    if (!fs.existsSync(dir)) { results.push({ dir, skipped: true }); continue; }
    const outPath = path.join(dir, 'beyondparadise-bridge.json');
    if (!DRY) fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
    results.push({ dir: outPath, skipped: false });
  }
  return { results, count: eligible.length };
}

// ── main ──────────────────────────────────────────────────────
function main() {
  console.log(`\nBeyond Paradise cross-share${DRY ? ' [DRY RUN]' : ''}`);
  console.log(`Source: ${allFacts.length} facts in data/facts/facts.json\n`);

  const wts = buildWildToSeaSupplement();
  console.log(`WildToSea supplement: ${wts.count} candidates -> ${path.relative(ROOT, wts.outPath)}`);

  const matlai = buildMatlaiBridge();
  console.log(`Matlai bridge: ${matlai.count} facts indexed`);
  matlai.results.forEach(r => {
    console.log(`  -> ${r.skipped ? 'SKIPPED (directory not found): ' + r.dir : path.relative(path.join(ROOT, '..'), r.dir)}`);
  });

  if (DRY) console.log('\n(--dry: nothing written)\n');
  else console.log('\nDone. BP\'s own repo files are not touched by this script (only shared_knowledge/ and Matlai\'s two config/facts/ folders).\n');
}

main();
