'use strict';

// ============================================================
// kb-validate.js — integrity gate for the Beyond Paradise KB
//
// Handles two source schemas:
//   Legacy (existing facts.json): sources: ["source-id", "other-id"]
//   New (gather-facts.js output): sources: [{name, url, tier, accessed}]
//
// Validates facts.json (and --candidates buffer) against taxonomy.json:
//   - topic and region must exist in taxonomy.json
//   - status must be a known value
//   - confirmed facts must have ≥2 independent owners (re-verified)
//   - unverified facts must NOT live in facts.json
//   - warns if tier is null, url missing, or source ID unknown
//
// Exit 1 on any ERROR in facts.json. Warnings don't block.
//
// USAGE:
//   node kb-validate.js              # validate facts.json
//   node kb-validate.js --candidates # also validate candidates buffer
// ============================================================

const fs = require('fs');
const path = require('path');
const { ownerOf, distinctOwners, isAvoided, loadSources } = require('./owners');

const ROOT = path.join(__dirname, '..', '..');
const DATA_FACTS = path.join(ROOT, 'data', 'facts');
const CHECK_CANDIDATES = process.argv.includes('--candidates');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_FACTS, file), 'utf8')); }
  catch { return null; }
}

const taxonomy = readJson('taxonomy.json') || { topics: [], regions: {} };
const sourcesDb = loadSources(); // sources.json for resolving string IDs

const allTopics = new Set(taxonomy.topics || []);
const allRegions = new Set(Object.values(taxonomy.regions || {}).flat());
const validStatuses = new Set(['confirmed', 'single-source', 'unverified', 'conflicting', 'outdated']);

const knownSourceIds = new Set(Object.keys(sourcesDb.sources || {}));

const errors = [];
const warns = [];

// Normalise sources to [{domain, url, tier}] regardless of schema
function normaliseSources(rawSources) {
  if (!rawSources || !rawSources.length) return [];
  return rawSources.map(s => {
    if (typeof s === 'string') {
      // Legacy: string source ID → look up in sources.json
      const entry = (sourcesDb.sources || {})[s];
      if (!entry) return { domain: null, url: null, tier: null, _unknownId: s };
      const url = entry.url || null;
      const domain = url ? url.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '') : null;
      return { domain, url, tier: entry.tier || null };
    }
    // New schema: inline object
    const url = s.url || null;
    const domain = url ? url.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '') : null;
    return { domain, url, tier: s.tier || null };
  });
}

function validateFact(f, where) {
  const id = f.id || '(no id)';
  const E = m => errors.push(`[${where}] ${id}: ${m}`);
  const W = m => warns.push(`[${where}] ${id}: ${m}`);

  if (!f.id) E('missing id');
  if (!f.claim && !f.value) E('missing claim/value');
  if (!f.topic) W('missing topic');
  else if (!allTopics.has(f.topic)) E(`topic "${f.topic}" not in taxonomy.json — add it`);
  if (!f.region) W('missing region');
  else if (!allRegions.has(f.region)) E(`region "${f.region}" not in taxonomy.json — add it`);
  if (!f.status) E('missing status');
  else if (!validStatuses.has(f.status)) E(`status "${f.status}" not valid (use: ${[...validStatuses].join(', ')})`);

  const rawSources = f.sources || [];
  if (!rawSources.length) E('no sources');

  // Check legacy string IDs
  rawSources.forEach((s, i) => {
    if (typeof s === 'string') {
      if (!knownSourceIds.has(s)) W(`source[${i}] unknown ID "${s}" — add to sources.json`);
    } else {
      if (!s.url) W(`source[${i}] missing url`);
      if (!s.name) W(`source[${i}] missing name`);
      if (s.tier == null) W(`source[${i}] (${s.name || 'unknown'}) tier not set`);
      if (s.url) {
        const domain = s.url.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
        if (isAvoided(domain)) E(`source[${i}] domain "${domain}" is on the avoid list`);
      }
    }
  });

  // Owner-independence check (only works when we can resolve domains)
  const normalised = normaliseSources(rawSources).filter(s => s.domain);
  if (normalised.length > 0) {
    const owners = distinctOwners(normalised);
    if (f.status === 'confirmed' && owners < 2) {
      W(`status=confirmed but only ${owners} resolvable owner(s) — verify sources have distinct domains`);
    }
    if (f.status === 'single-source' && owners >= 2) {
      W(`status=single-source but ${owners} owners found — could be upgraded to confirmed`);
    }
  }

  if (f.status === 'unverified' && where === 'facts.json') {
    E('unverified facts must not be in facts.json — keep in candidates buffer for Tim review');
  }
}

const factsDb = readJson('facts.json') || { facts: [] };
const facts = factsDb.facts || [];
facts.forEach(f => validateFact(f, 'facts.json'));

if (CHECK_CANDIDATES) {
  const store = readJson('facts.candidates.json') || { candidates: [] };
  (store.candidates || []).forEach(f => validateFact(f, 'candidates'));
}

console.log(`\nBeyond Paradise KB Validate`);
console.log(`  facts.json: ${facts.length} facts${CHECK_CANDIDATES ? ' + candidates checked' : ''}`);
console.log(`  errors: ${errors.length} | warnings: ${warns.length}`);

if (warns.length) {
  console.log('\nWARNINGS (non-blocking):');
  warns.slice(0, 30).forEach(w => console.log(`  ⚠  ${w}`));
  if (warns.length > 30) console.log(`  … and ${warns.length - 30} more warnings (run with --verbose to see all)`);
}
if (errors.length) {
  console.log('\nERRORS (must fix):');
  errors.forEach(e => console.log(`  ✗  ${e}`));
  console.log('');
  process.exit(1);
}
console.log('  ✓ knowledge base integrity OK\n');
