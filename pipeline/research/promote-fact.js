'use strict';

// ============================================================
// promote-fact.js — move Tim-reviewed candidates into the curated KB
//
// gather-facts.js writes to facts.candidates.json.
// Tim runs THIS after reviewing candidates to promote them into
// facts.json (the shippable source of truth for the site).
//
// Gates before promotion:
//   - status must not be 'unverified'
//   - must have id, claim, and at least one source
//   - topic must exist in taxonomy.json
//   - region must exist in taxonomy.json
//
// USAGE:
//   node promote-fact.js --key=whale-shark-mafia       # all for this entity
//   node promote-fact.js --id=whale-shark-mafia-season-1  # one specific fact
//   node promote-fact.js --all                          # everything in buffer
//   node promote-fact.js --key=singita-grumeti --dry    # preview without writing
//   node promote-fact.js --all --reviewer="Tim Hennig"  # stamp reviewer name
// ============================================================

const fs = require('fs');
const path = require('path');

const cliArgs = process.argv.slice(2);
const arg = k => (cliArgs.find(a => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=');
const DRY = cliArgs.includes('--dry');
const ALL = cliArgs.includes('--all');
const KEY_ARG = arg('key');
const ID_ARG = arg('id');
const reviewer = arg('reviewer') || 'Tim Hennig';

const ROOT = path.join(__dirname, '..', '..');
const DATA_FACTS = path.join(ROOT, 'data', 'facts');
const CANDIDATES_FILE = path.join(DATA_FACTS, 'facts.candidates.json');
const FACTS_FILE = path.join(DATA_FACTS, 'facts.json');
const TAXONOMY_FILE = path.join(DATA_FACTS, 'taxonomy.json');

if (!ALL && !KEY_ARG && !ID_ARG) {
  console.error('\nSpecify --key=<entityKey>, --id=<factId>, or --all\n');
  process.exit(1);
}

const taxonomy = JSON.parse(fs.readFileSync(TAXONOMY_FILE, 'utf8'));
const allTopics = new Set(taxonomy.topics || []);
const allRegions = new Set(Object.values(taxonomy.regions).flat());
const today = () => new Date().toISOString().slice(0, 10);

// Gate: returns array of error strings; empty = promotable
function gate(c) {
  const e = [];
  if (!c.id) e.push('missing id');
  if (!c.claim) e.push('missing claim');
  if (!c.sources || c.sources.length === 0) e.push('no sources');
  if (c.status === 'unverified') e.push('status=unverified — review sources first');
  if (c.topic && !allTopics.has(c.topic)) e.push(`unknown topic "${c.topic}" — add to taxonomy.json`);
  if (c.region && !allRegions.has(c.region)) e.push(`unknown region "${c.region}" — add to taxonomy.json`);
  return e;
}

// Strip internal _meta fields before writing to facts.json
function toFactsEntry(c) {
  const { _meta, ...rest } = c;
  // Strip internal source fields too (quote stays — it's useful reference)
  const sources = (rest.sources || []).map(({ _domain, _owner, ...s }) => s);
  return { ...rest, sources };
}

let store, factsDb;
try { store = JSON.parse(fs.readFileSync(CANDIDATES_FILE, 'utf8')); }
catch { console.error(`\nCandidates file not found: ${CANDIDATES_FILE}\nRun gather-facts.js first.\n`); process.exit(1); }

try { factsDb = JSON.parse(fs.readFileSync(FACTS_FILE, 'utf8')); }
catch { factsDb = { facts: [] }; }

factsDb.facts = factsDb.facts || [];
const byId = new Map(factsDb.facts.map(f => [f.id, f]));

// Select candidates to process
let selected = store.candidates || [];
if (ID_ARG) {
  selected = selected.filter(c => c.id === ID_ARG);
} else if (KEY_ARG) {
  selected = selected.filter(c => c._meta?.entityKey === KEY_ARG || c.id.startsWith(KEY_ARG));
}

if (selected.length === 0) {
  console.log('\nNo matching candidates found in buffer.\n');
  process.exit(0);
}

const selectedIds = new Set(selected.map(c => c.id));
let promoted = 0, skipped = 0;
const keep = [];

console.log(`\nBeyond Paradise — Promote Facts${DRY ? ' [DRY RUN]' : ''}`);
console.log(`Candidates to review: ${selected.length}`);
if (KEY_ARG) console.log(`Filter: entity key = "${KEY_ARG}"`);
if (ID_ARG) console.log(`Filter: id = "${ID_ARG}"`);
console.log('');

for (const c of (store.candidates || [])) {
  if (!selectedIds.has(c.id)) { keep.push(c); continue; }

  const errs = gate(c);
  if (errs.length) {
    console.log(`  ✗ SKIP  ${c.id}`);
    errs.forEach(e => console.log(`         ${e}`));
    skipped++;
    keep.push(c);
    continue;
  }

  const entry = toFactsEntry(c);
  entry.promotedOn = today();
  entry.reviewedBy = reviewer;

  byId.set(entry.id, entry);
  const ownerCount = c._meta?.distinctOwners ?? '?';
  console.log(`  ✓ PROMOTE  [${c.status} ×${ownerCount}] ${c.id}`);
  console.log(`    claim: ${c.claim.slice(0, 90)}${c.claim.length > 90 ? '…' : ''}`);
  promoted++;
}

console.log(`\n${DRY ? '(DRY) ' : ''}promoted: ${promoted} | skipped (gate failures): ${skipped} | remaining in buffer: ${keep.length}`);

if (!DRY && promoted > 0) {
  factsDb.facts = [...byId.values()];
  factsDb.updated = today();
  store.candidates = keep;
  store.updated = today();

  fs.writeFileSync(FACTS_FILE, JSON.stringify(factsDb, null, 2) + '\n');
  fs.writeFileSync(CANDIDATES_FILE, JSON.stringify(store, null, 2) + '\n');
  console.log(`\n→ ${path.relative(ROOT, FACTS_FILE)} (${factsDb.facts.length} total facts)`);
  console.log(`→ ${path.relative(ROOT, CANDIDATES_FILE)} (${keep.length} remaining candidates)\n`);
}
