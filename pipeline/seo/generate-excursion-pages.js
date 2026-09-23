'use strict';

// ============================================================
// generate-excursion-pages.js — programmatic local-SEO page generator
//
// Builds one real Astro content-collection page per (tour x pickup area)
// combination for Beyond Paradise Adventures, from data/excursions/excursions.json.
//
// Hard rules this script enforces (do not weaken these without Tim's sign-off):
//   1. Every fact_id referenced in excursions.json must exist in data/facts/facts.json.
//      A missing fact_id is a fatal error (fail-closed), never a silent skip.
//   2. Only combinations listed under `tours[].pickup_areas` are generated. Anything
//      that would require inventing a fact belongs in `skipped_combinations` instead —
//      this script prints that list on every run so it stays visible, not hidden.
//   3. A minimum-uniqueness check runs across every generated page BODY (frontmatter
//      excluded) using a word-shingle Jaccard similarity. Any pair over the 0.70
//      threshold fails the whole run (exit 1) rather than publishing near-duplicates.
//   4. No page gets a price/Offer unless a real price fact backs it (none currently do —
//      see skipped_combinations in excursions.json for why).
//
// Usage:
//   node pipeline/seo/generate-excursion-pages.js            # generate + check, write files
//   node pipeline/seo/generate-excursion-pages.js --check-only  # uniqueness check only, no writes
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const EXCURSIONS_PATH = path.join(ROOT, 'data', 'excursions', 'excursions.json');
const FACTS_PATH = path.join(ROOT, 'data', 'facts', 'facts.json');
const OUT_DIR = path.join(ROOT, 'site', 'src', 'content', 'excursions');
const SIMILARITY_THRESHOLD = 0.70;
const CHECK_ONLY = process.argv.includes('--check-only');

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function truncate(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[,.;:]?$/, '') + '…';
}

function wordShingles(text, n = 5) {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const shingles = new Set();
  for (let i = 0; i + n <= words.length; i++) {
    shingles.add(words.slice(i, i + n).join(' '));
  }
  return shingles;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function yamlEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function main() {
  const excursions = loadJson(EXCURSIONS_PATH);
  const factsDb = loadJson(FACTS_PATH);
  const factIds = new Set(factsDb.facts.map(f => f.id));
  const factsById = new Map(factsDb.facts.map(f => [f.id, f]));

  const combosFound = [];
  const errors = [];

  for (const tour of excursions.tours) {
    for (const area of tour.pickup_areas) {
      combosFound.push({ tour, area });
    }
  }

  // --- Rule 1: fail closed on any unresolved fact_id ---
  const allFactIdRefs = [];
  for (const tour of excursions.tours) {
    for (const id of tour.intro_fact_ids || []) allFactIdRefs.push({ where: `${tour.id}.intro_fact_ids`, id });
    for (const area of tour.pickup_areas) {
      for (const id of area.transfer_fact_ids || []) allFactIdRefs.push({ where: `${tour.id}/${area.area_id}.transfer_fact_ids`, id });
      for (const id of area.character_fact_ids || []) allFactIdRefs.push({ where: `${tour.id}/${area.area_id}.character_fact_ids`, id });
    }
  }
  for (const ref of allFactIdRefs) {
    if (!factIds.has(ref.id)) {
      errors.push(`Unknown fact_id "${ref.id}" referenced at ${ref.where} — refusing to generate (never invent a fact).`);
    }
  }
  if (errors.length) {
    console.error('FATAL: fact_id validation failed:\n' + errors.map(e => '  - ' + e).join('\n'));
    process.exit(2);
  }

  // --- Build each page's rendered content (frontmatter + body kept separate) ---
  const pages = [];
  for (const tour of excursions.tours) {
    for (const area of tour.pickup_areas) {
      const slug = `${tour.id}-from-${area.area_id}`;
      const permalink = `/excursions/${slug}/`;
      const title = `${tour.name} from ${area.area_name}: What to Know Before You Go`;

      const transferClause = area.transfer_short ? `Transfer: ${area.transfer_short}.` : '';
      const descBudget = Math.max(40, 158 - transferClause.length - 1);
      const charSnippet = area.character_text ? truncate(area.character_text, descBudget) : truncate(tour.intro_text, descBudget);
      const description = [charSnippet, transferClause].filter(Boolean).join(' ');

      const answerParts = [
        `${tour.name} from ${area.area_name}: ${area.transfer_short || area.transfer_text}.`,
        area.character_text ? area.character_text.split(/(?<=[.!?])\s/)[0] : tour.intro_text.split(/(?<=[.!?])\s/)[0],
      ];
      const answer = answerParts.join(' ');

      const faq = [];
      faq.push({
        q: `How do I get to ${tour.name} from ${area.area_name}?`,
        a: area.transfer_text + (area.extra_note ? ' ' + area.extra_note : ''),
      });
      if (area.character_text) {
        faq.push({
          q: `What's ${area.area_name} like, and does this pairing make sense?`,
          a: area.character_text,
        });
      }
      faq.push({
        q: `What exactly is ${tour.name}?`,
        a: tour.intro_text,
      });

      const factIdsUsed = Array.from(new Set([
        ...(tour.intro_fact_ids || []),
        ...(area.transfer_fact_ids || []),
        ...(area.character_fact_ids || []),
      ]));

      const relatedLinksMd = (tour.related_links || [])
        .map(l => `- [${l.label}](${l.href})`)
        .join('\n');

      const bodyParts = [];
      bodyParts.push(`<!-- SOURCE FACTS: ${factIdsUsed.join(', ')} — see data/excursions/excursions.json. Do not edit this file by hand; regenerate via pipeline/seo/generate-excursion-pages.js. -->`);
      bodyParts.push(`## Quick facts\n\n| | |\n|---|---|\n| Pickup area | ${area.area_name} |\n| Experience | ${tour.name} |\n| Region | ${tour.region} |\n| Transfer | ${area.transfer_short || '—'} |`);
      bodyParts.push(`## What ${tour.name} actually is\n\n${tour.intro_text}`);
      let gettingThere = `## Getting there from ${area.area_name}\n\n${area.transfer_text}`;
      if (area.extra_note) {
        gettingThere += `\n\n**A note on this figure:** ${area.extra_note}`;
      }
      bodyParts.push(gettingThere);
      if (area.character_text) {
        bodyParts.push(`## What ${area.area_name} brings to this trip\n\n${area.character_text}`);
      }
      if (relatedLinksMd) {
        bodyParts.push(`## Plan the rest of your trip\n\n${relatedLinksMd}`);
      }
      const body = bodyParts.join('\n\n');

      const frontmatter = [
        '---',
        `title: "${yamlEscape(title)}"`,
        `description: "${yamlEscape(description)}"`,
        `permalink: "${permalink}"`,
        `tour_id: "${tour.id}"`,
        `tour_name: "${yamlEscape(tour.name)}"`,
        `pickup_area_id: "${area.area_id}"`,
        `pickup_area_name: "${yamlEscape(area.area_name)}"`,
        `destination_id: "${tour.destination_id}"`,
        `region: "${yamlEscape(tour.region)}"`,
        `hero_image: "${tour.hero_image}"`,
        `hero_alt: "${yamlEscape(tour.name)} — ${yamlEscape(area.area_name)}, ${yamlEscape(tour.region)}"`,
        'author: "tim"',
        `last_updated: "${excursions._meta.created}"`,
        'draft: false',
        `answer: "${yamlEscape(answer)}"`,
        'faq:',
        ...faq.flatMap(item => [
          `  - q: "${yamlEscape(item.q)}"`,
          `    a: "${yamlEscape(item.a)}"`,
        ]),
        ...(factIdsUsed.length
          ? ['fact_ids:', ...factIdsUsed.map(id => `  - "${id}"`)]
          : ['fact_ids: []']),
        ...(() => {
          const siblingIds = tour.pickup_areas.filter(a => a.area_id !== area.area_id).map(a => a.area_id);
          return siblingIds.length
            ? ['sibling_area_ids:', ...siblingIds.map(id => `  - "${id}"`)]
            : ['sibling_area_ids: []'];
        })(),
        '---',
      ].join('\n');

      pages.push({
        tourId: tour.id,
        areaId: area.area_id,
        slug,
        permalink,
        title,
        fileContent: `${frontmatter}\n\n${body}\n`,
        bodyForUniqueness: body,
      });
    }
  }

  // --- Rule 3: uniqueness gate, pairwise, on body text only ---
  const violations = [];
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const a = wordShingles(pages[i].bodyForUniqueness);
      const b = wordShingles(pages[j].bodyForUniqueness);
      const sim = jaccard(a, b);
      if (sim > SIMILARITY_THRESHOLD) {
        violations.push({ a: pages[i].slug, b: pages[j].slug, sim: sim.toFixed(3) });
      }
    }
  }

  console.log(`Combinations defined: ${combosFound.length}`);
  console.log(`Pages to generate: ${pages.length}`);
  console.log('Pairwise similarity check (5-word shingle Jaccard, threshold ' + SIMILARITY_THRESHOLD + '):');
  if (violations.length === 0) {
    console.log('  OK — no pair exceeds the threshold.');
  } else {
    console.log('  FAILED — the following pairs are too similar:');
    for (const v of violations) console.log(`    ${v.a} <-> ${v.b}: ${v.sim}`);
  }

  console.log('\nSkipped combinations (see data/excursions/excursions.json skipped_combinations for full reasons):');
  for (const s of excursions.skipped_combinations || []) {
    console.log(`  - ${s.tour_or_area}: ${s.reason.slice(0, 100)}${s.reason.length > 100 ? '…' : ''}`);
  }

  if (violations.length > 0) {
    console.error('\nRefusing to write pages: uniqueness check failed.');
    process.exit(1);
  }

  if (CHECK_ONLY) {
    console.log('\n--check-only: not writing files.');
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const p of pages) {
    fs.writeFileSync(path.join(OUT_DIR, `${p.slug}.md`), p.fileContent, 'utf8');
  }
  console.log(`\nWrote ${pages.length} files to ${path.relative(ROOT, OUT_DIR)}/`);
  console.log('\nGenerated pages:');
  for (const p of pages) console.log(`  ${p.permalink}  (${p.title})`);
}

main();
