'use strict';

// ============================================================
// gather-facts.js — Gemini-grounded research for Beyond Paradise
//
// Two-step, honesty-guarded fact gathering for wildlife, lodges,
// destinations, and operators → structured, cross-checked candidates
// in data/facts/facts.candidates.json. Tim reviews; promote-fact.js
// moves approved entries into data/facts/facts.json.
//
// Pattern (same as PadelRevive gather-evidence.js):
//   1. GROUNDED call (google_search tool) → assessment text + the REAL
//      source domains Gemini actually used (groundingChunks[].web.title)
//   2. STRUCTURE call (ungrounded, JSON mode) → facts array restricted
//      to real domains only — no hallucinated URLs
//   3. Resolve Gemini redirect links → persistent article URLs
//   4. Cross-check by OWNER (not domain): a fact needs ≥2 independent
//      owners to be "confirmed". Two pages on singita.com = 1 owner.
//
// USAGE:
//   node gather-facts.js --type=wildlife --key=whale-shark-mafia \
//     --name="Whale Sharks Mafia Island" --topic=whale-sharks --region=mafia-island
//
//   node gather-facts.js --type=lodge --key=singita-grumeti \
//     --name="Singita Grumeti" --topic=lodge-review --region=serengeti
//
//   node gather-facts.js --type=destination --key=mafia-island \
//     --name="Mafia Island Tanzania" --topic=entry-requirements --region=mafia-island
//
//   node gather-facts.js --type=operator --key=aquatica-zanzibar \
//     --name="Aquatica Zanzibar" --topic=wildlife-ethics --region=zanzibar
//
//   Add --dry to inspect output without writing.
// ============================================================

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { ownerOf, distinctOwners, isAvoided, tierFor } = require('./owners');
const guard = require('./spend-guard');

const KEY = process.env.GEMINI_API_KEY;
const MODEL = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;

const cliArgs = process.argv.slice(2);
const arg = k => (cliArgs.find(a => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=');
const DRY = cliArgs.includes('--dry');

const TYPE = arg('type') || 'wildlife';
const KEY_ARG = arg('key');
const NAME = arg('name') || KEY_ARG;
const TOPIC = arg('topic');
const REGION = arg('region');

const ROOT = path.join(__dirname, '..', '..');
const DATA_FACTS = path.join(ROOT, 'data', 'facts');
const CANDIDATES_FILE = path.join(DATA_FACTS, 'facts.candidates.json');
const TAXONOMY_FILE = path.join(DATA_FACTS, 'taxonomy.json');

const VALID_TYPES = ['wildlife', 'lodge', 'destination', 'operator'];

if (!KEY) { console.error('\nGEMINI_API_KEY missing — add it to .env at the project root\n'); process.exit(1); }
if (!KEY_ARG) { console.error('\n--key required  e.g. --key=whale-shark-mafia\n'); process.exit(1); }
if (!VALID_TYPES.includes(TYPE)) { console.error(`\n--type must be one of: ${VALID_TYPES.join(', ')}\n`); process.exit(1); }
if (!REGION) { console.error('\n--region required  e.g. --region=mafia-island\n'); process.exit(1); }

const taxonomy = JSON.parse(fs.readFileSync(TAXONOMY_FILE, 'utf8'));
const allTopics = new Set(taxonomy.topics || []);
const allRegions = new Set(Object.values(taxonomy.regions).flat());

if (TOPIC && !allTopics.has(TOPIC)) {
  console.error(`\nUnknown topic "${TOPIC}"\nValid topics: ${[...allTopics].join(', ')}\n`);
  process.exit(1);
}
if (!allRegions.has(REGION)) {
  console.error(`\nUnknown region "${REGION}"\nCheck data/facts/taxonomy.json — add it there first if needed\n`);
  process.exit(1);
}

// ── helpers ──────────────────────────────────────────────────

const domainOf = u => {
  try { return new URL(u).hostname.replace(/^www\./, ''); }
  catch { return (u || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '') || null; }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

function slugify(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Stable fact ID: {key}-{dimension}-{index-within-dimension}
function factId(key, dimension, idx) {
  return `${slugify(key)}-${slugify(dimension)}-${idx}`;
}

// ── grounded prompts ──────────────────────────────────────────

const DIMENSIONS = {
  wildlife: 'season|population|probability|permit|ethics|iucn-status',
  lodge: 'price|capacity|conservation|seasons|access',
  destination: 'entry|health|seasons|getting-there|transfers',
  operator: 'permit|ethics|fleet|guide-standards|red-flags',
};

function groundedPrompt(type, name, region) {
  const regionLabel = region.replace(/-/g, ' ');

  if (type === 'wildlife') return `
Research "${name}" in ${regionLabel} (marine wildlife encounter, East Africa/Indian Ocean).

For EVERY finding, name the EXACT source: the government authority, scientific journal, conservation NGO, citizen-science database, or official permit body that published the data. E.g. "The Marine Megafauna Foundation 2023 report states..." or "MPRU Tanzania regulation No. X says...". When multiple sources agree, list all of them.

Cover these dimensions:
1. SEASON — exact months when animals aggregate at this site, peak months, off-season months
2. POPULATION — documented individual count or population estimate with source and year
3. PROBABILITY — monthly sighting probability (high/medium/low) with supporting data and sample size
4. PERMIT & REGULATIONS — official authority, max swimmers per animal, required distance, banned behaviours
5. ETHICS — published tourism impact studies, documented guide compliance, red flags for unethical operators
6. IUCN STATUS — current IUCN Red List status, population trend, last assessment year

Flag where data is conflicting, thin, or marketing-only.`.trim();

  if (type === 'lodge') return `
Research "${name}" luxury lodge in ${regionLabel} (East Africa).

For EVERY fact, name the EXACT source. Prefer official lodge communications, official conservation reports, reputable travel publications. Do NOT use TripAdvisor, Booking.com reviews, or liveaboard aggregators.

Cover:
1. PRICE — rate per night (high season and low season), what is included (meals/drives/fees/transfers)
2. CAPACITY — maximum guests at one time, number of rooms/tents/villas
3. CONSERVATION — documented partnerships (NGO, park authority), verifiable certifications (ISO, LEED, Rainforest Alliance, Fair Trade Tourism), specific anti-poaching or habitat commitments
4. SEASONS — which months open, which months closed, reason for closure (wet season, migration gap, maintenance)
5. ACCESS — nearest international and domestic airport, typical transfer mode and duration to lodge

Name every source specifically.`.trim();

  if (type === 'destination') return `
Research "${name}" (${regionLabel}) as a luxury travel destination.

For every fact, cite the EXACT government or official source: national travel advisory, official health authority, national tourism board, park authority.

Cover:
1. ENTRY — visa requirements for EU, US, and UK passport holders: e-visa, visa on arrival, or embassy only; cost; validity
2. HEALTH — mandatory vaccinations (yellow fever certificate required?), malaria prophylaxis recommendation, other health requirements
3. SEASONS — month-by-month dry/wet season guide; which months are best for each type of experience (wildlife, diving, beaches)
4. GETTING THERE — main international airport(s), typical routing from Europe (major hub connections)
5. TRANSFERS — distance and typical transport from arrival airport to luxury lodges/dive sites; charter flight options

Prefer WHO, CDC, government travel advisories, official tourism board data.`.trim();

  if (type === 'operator') return `
Research "${name}" as a marine or wildlife tour operator in ${regionLabel}.

For every finding, cite the EXACT source: official park authority, permit registry, peer-reviewed study, conservation org field report.

Cover:
1. PERMIT — which authority issues their permit, permit category, whether public licence number exists
2. ETHICS COMPLIANCE — documented compliance or violations, published tourism impact data, regulatory warnings
3. FLEET — number of boats, vessel type, maximum capacity per vessel
4. GUIDE STANDARDS — documented training requirements, certifications required for guides
5. RED FLAGS — any documented incidents of animal harassment, permit violations, overcrowding, illegal activity

Prefer official government permit records and peer-reviewed wildlife tourism impact studies.`.trim();

  return `Research "${name}" (${type}, ${regionLabel}). For every finding, name the exact source.`;
}

function structurePrompt(name, groundedText, realDomains, type) {
  return `Below is web research about "${name}" and the REAL source domains used.

REAL DOMAINS (use ONLY these — never invent domains): ${JSON.stringify(realDomains)}

RESEARCH:
${groundedText}

Extract ONLY a JSON object — no markdown, no explanation before or after:
{
  "facts": [
    {
      "claim": "one specific, falsifiable, numbered statement — include the actual number, month, or regulation",
      "dimension": "${DIMENSIONS[type]}",
      "sources": [
        {
          "domain": "<must be from REAL DOMAINS>",
          "name": "human-readable source name (e.g. Marine Megafauna Foundation)",
          "quote": "verbatim or near-verbatim excerpt from the research supporting this specific claim"
        }
      ]
    }
  ],
  "notes": "honest assessment of data quality: gaps, conflicts, thin evidence, marketing-only claims"
}

RULES:
- Every source.domain MUST be from the REAL DOMAINS list — never invent a domain
- Each claim must be falsifiable: not "whale sharks are present" but "whale sharks aggregate at Mafia Island from October to February, peaking November–January"
- Include EVERY supporting domain for each claim — multiple sources per claim is the goal
- 4–10 most important, decision-relevant facts (prioritise facts with ≥2 sources)
- Never invent statistics, dates, names, permit numbers, or regulations
- If a claim is only from one source, still include it — Tim will review
- Dim must be one of the options listed in the dimension field above`.trim();
}

// ── Gemini client ─────────────────────────────────────────────

async function gemini(parts, grounded, json) {
  if (grounded) guard.checkAffordable(1); // fail-closed BEFORE the paid grounded call
  const body = {
    contents: [{ parts }],
    generationConfig: { temperature: 0.2 },
  };
  if (grounded) body.tools = [{ google_search: {} }];
  if (json) body.generationConfig.responseMimeType = 'application/json';

  let r;
  for (let attempt = 0; attempt < 5; attempt++) {
    r = await axios.post(ENDPOINT, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 120000,
      validateStatus: () => true,
    });
    if (r.status === 200) break;
    if (r.status === 429 || r.status >= 500) {
      const wait = 20000 * (attempt + 1); // 20s, 40s, 60s, 80s, 100s
      console.log(`  ${r.status} — waiting ${wait / 1000}s before retry…`);
      await sleep(wait);
      continue;
    }
    throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  }
  if (r.status !== 200) throw new Error('Rate-limited after 5 retries');
  if (grounded) guard.record(1); // log successful call AFTER success

  const cand = r.data.candidates?.[0];
  const text = (cand?.content?.parts || []).map(p => p.text).filter(Boolean).join('\n');
  const chunks = (cand?.groundingMetadata?.groundingChunks || [])
    .map(c => ({ domain: domainOf(c.web?.title) || c.web?.title, redirect: c.web?.uri }))
    .filter(c => c.domain);
  return { text, chunks };
}

// Resolve Gemini's temporary redirect → real persistent article URL
async function resolve(redirect, domain) {
  try {
    const r = await axios.get(redirect, { maxRedirects: 5, timeout: 12000, validateStatus: () => true });
    const final = r.request?.res?.responseUrl;
    if (final && !/vertexaisearch|google\.com/.test(final)) return final;
  } catch { /* fall through */ }
  return `https://${domain}/`;
}

function parseJson(text) {
  let t = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s !== -1 && e !== -1) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

// confirmed = ≥2 independent owners
// single-source = 1 owner
// unverified = 0 sources or no domains
function statusFor(distinctOwnerCount) {
  if (distinctOwnerCount >= 2) return 'confirmed';
  if (distinctOwnerCount === 1) return 'single-source';
  return 'unverified';
}

// ── main ──────────────────────────────────────────────────────

async function main() {
  console.log(`\nBeyond Paradise Research Engine`);
  console.log(`  type: ${TYPE}  |  key: ${KEY_ARG}  |  name: ${NAME}`);
  console.log(`  topic: ${TOPIC || '(auto)'}  |  region: ${REGION}`);
  if (DRY) console.log('  [DRY RUN — nothing will be written]\n');

  // 1. Grounded call — web search
  console.log('\n[1/3] Grounded web research…');
  const gPrompt = groundedPrompt(TYPE, NAME, REGION);
  const g = await gemini([{ text: gPrompt }], true);

  const realDomains = [...new Set(g.chunks.map(c => c.domain).filter(Boolean))];
  console.log(`  sources Gemini used: ${realDomains.length} domains`);
  realDomains.forEach(d => console.log(`    - ${d}`));

  if (realDomains.length === 0) {
    console.error('\n  No grounding sources returned — aborting. The claim would be unverifiable.\n');
    process.exit(1);
  }

  // 2. Structure call — extract fact candidates (JSON mode, no search)
  console.log('\n[2/3] Structuring facts…');
  const sPrompt = structurePrompt(NAME, g.text, realDomains, TYPE);
  const s = await gemini([{ text: sPrompt }], false, true);

  let parsed;
  try {
    parsed = parseJson(s.text);
  } catch (err) {
    console.error('  JSON parse failed:', err.message);
    console.error('  Raw response (first 500 chars):', s.text.slice(0, 500));
    process.exit(1);
  }

  // 3. Resolve redirect URLs → persistent article links
  console.log('\n[3/3] Resolving source URLs…');
  const urlByDomain = {};
  for (const c of g.chunks) {
    if (!urlByDomain[c.domain]) {
      urlByDomain[c.domain] = await resolve(c.redirect, c.domain);
      process.stdout.write('.');
    }
  }
  console.log(' done\n');

  const realSet = new Set(realDomains);
  const dimCounts = {};

  const candidates = (parsed.facts || []).map(f => {
    const dim = slugify(f.dimension || 'general');
    dimCounts[dim] = (dimCounts[dim] || 0) + 1;
    const idx = dimCounts[dim];

    // Filter: only real grounded domains, not on avoid list
    const sources = (f.sources || [])
      .filter(src => {
        const d = domainOf(src.domain) || src.domain;
        if (!realSet.has(d)) return false;
        if (isAvoided(d)) { console.log(`  [avoid] ${d}`); return false; }
        return true;
      })
      .map(src => {
        const d = domainOf(src.domain) || src.domain;
        return {
          name: src.name || d,
          url: urlByDomain[d] || `https://${d}/`,
          tier: tierFor(d),      // null for unknown sources — Tim assigns tier on review
          accessed: today(),
          quote: src.quote || '',
          _domain: d,            // internal — stripped before writing to facts.json
          _owner: ownerOf(d),    // internal — used for independence check
        };
      });

    const owners = distinctOwners(sources.map(s => ({ domain: s._domain })));
    const status = statusFor(owners);
    const derivedTopic = TOPIC || (TYPE === 'lodge' ? 'lodge-review' : TYPE === 'destination' ? 'seasons' : 'wildlife-ethics');

    return {
      id: factId(KEY_ARG, dim, idx),
      claim: f.claim,
      sources: sources.map(({ _domain, _owner, ...keep }) => keep), // strip internal fields
      status,
      topic: derivedTopic,
      region: REGION,
      added: today(),
      // extra context kept only in the candidates buffer (not promoted to facts.json)
      _meta: {
        dimension: dim,
        type: TYPE,
        entityKey: KEY_ARG,
        distinctOwners: owners,
        researchedOn: today(),
      },
    };
  });

  // Print results
  console.log(`Facts extracted: ${candidates.length}`);
  for (const c of candidates) {
    const badge = c.status === 'confirmed' ? '✓' : c.status === 'single-source' ? '~' : '✗';
    const ownerCount = c._meta.distinctOwners;
    console.log(`\n  [${badge} ${c.status} ×${ownerCount}] ${c._meta.dimension}`);
    console.log(`  CLAIM: ${c.claim}`);
    for (const s of c.sources) {
      const tier = s.tier != null ? ` [tier ${s.tier}]` : ' [tier ?]';
      console.log(`    source: ${s.name}${tier} — ${s.url}`);
      if (s.quote) console.log(`    quote: "${s.quote.slice(0, 100)}${s.quote.length > 100 ? '…' : ''}"`);
    }
  }

  const confirmed = candidates.filter(c => c.status === 'confirmed').length;
  const single = candidates.filter(c => c.status === 'single-source').length;
  const unverified = candidates.filter(c => c.status === 'unverified').length;
  console.log(`\nSummary: ${confirmed} confirmed | ${single} single-source | ${unverified} unverified`);
  if (parsed.notes) console.log(`Notes: ${parsed.notes}`);
  console.log(`Spend today: ${guard.spentToday()} / ${guard.DAILY} grounded calls`);

  if (DRY) { console.log('\n(--dry: nothing written)\n'); return; }

  // Write to candidates buffer
  let store = { candidates: [], updated: today() };
  try { store = JSON.parse(fs.readFileSync(CANDIDATES_FILE, 'utf8')); }
  catch { /* first run */ }
  store.candidates = store.candidates || [];

  // Remove stale entries for same entity+dimension (re-run overwrites)
  const newIds = new Set(candidates.map(c => c.id));
  store.candidates = store.candidates.filter(c => !newIds.has(c.id));
  store.candidates.push(...candidates);
  store.updated = today();

  fs.writeFileSync(CANDIDATES_FILE, JSON.stringify(store, null, 2) + '\n');
  console.log(`\n→ ${path.relative(ROOT, CANDIDATES_FILE)}`);
  console.log(`  ${candidates.length} candidates added. Review with: node promote-fact.js --all --dry`);
  console.log(`  Promote approved facts: node promote-fact.js --key=${KEY_ARG}\n`);
}

main().catch(e => {
  const msg = e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
  console.error('\nFailed:', msg);
  process.exit(1);
});
