'use strict';

// ============================================================
// kb-status.js — knowledge base health check
//
// Quick audit of facts.json and facts.candidates.json.
// Run before/after any research session to see where you stand.
//
//   node kb-status.js
//   node kb-status.js --verbose
// ============================================================

const fs = require('fs');
const path = require('path');
const guard = require('./spend-guard');

const cliArgs = process.argv.slice(2);
const VERBOSE = cliArgs.includes('--verbose') || cliArgs.includes('-v');

const ROOT = path.join(__dirname, '..', '..');
const DATA_FACTS = path.join(ROOT, 'data', 'facts');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_FACTS, file), 'utf8')); }
  catch { return null; }
}

const factsDb = readJson('facts.json') || { facts: [] };
const candidates = readJson('facts.candidates.json') || { candidates: [] };
const taxonomy = readJson('taxonomy.json') || { topics: [], regions: {} };

const facts = factsDb.facts || [];
const pending = candidates.candidates || [];

const byStatus = facts.reduce((acc, f) => {
  acc[f.status] = (acc[f.status] || 0) + 1; return acc;
}, {});

const byTopic = facts.reduce((acc, f) => {
  acc[f.topic] = (acc[f.topic] || 0) + 1; return acc;
}, {});

const byRegion = facts.reduce((acc, f) => {
  acc[f.region] = (acc[f.region] || 0) + 1; return acc;
}, {});

const pendingByKey = pending.reduce((acc, c) => {
  const k = c._meta?.entityKey || 'unknown';
  acc[k] = (acc[k] || 0) + 1; return acc;
}, {});

console.log('\n═══════════════════════════════════════');
console.log('  Beyond Paradise — Knowledge Base Status');
console.log('═══════════════════════════════════════\n');

console.log(`CURATED FACTS (facts.json)`);
console.log(`  Total: ${facts.length}`);
Object.entries(byStatus).sort((a, b) => b[1] - a[1]).forEach(([s, n]) => {
  const badge = s === 'confirmed' ? '✓' : s === 'single-source' ? '~' : '✗';
  console.log(`  ${badge} ${s}: ${n}`);
});

if (VERBOSE) {
  console.log(`\n  By topic:`);
  Object.entries(byTopic).sort((a, b) => b[1] - a[1]).forEach(([t, n]) => console.log(`    ${t}: ${n}`));
  console.log(`\n  By region:`);
  Object.entries(byRegion).sort((a, b) => b[1] - a[1]).forEach(([r, n]) => console.log(`    ${r}: ${n}`));
}

console.log(`\nCANDIDATES AWAITING REVIEW (facts.candidates.json)`);
if (pending.length === 0) {
  console.log('  (empty — run gather-facts.js to research a topic)');
} else {
  console.log(`  Total: ${pending.length}`);
  const pendingByStatus = pending.reduce((acc, c) => {
    acc[c.status] = (acc[c.status] || 0) + 1; return acc;
  }, {});
  Object.entries(pendingByStatus).sort((a, b) => b[1] - a[1]).forEach(([s, n]) => {
    const badge = s === 'confirmed' ? '✓' : s === 'single-source' ? '~' : '✗';
    console.log(`  ${badge} ${s}: ${n}`);
  });
  if (VERBOSE || Object.keys(pendingByKey).length <= 10) {
    console.log('  By entity:');
    Object.entries(pendingByKey).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`    ${k}: ${n}`));
  }
}

console.log(`\nSPEND GUARD`);
console.log(`  Grounded calls today: ${guard.spentToday()} / ${guard.DAILY}`);
const pct = Math.round((guard.spentToday() / guard.DAILY) * 100);
const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));
console.log(`  [${bar}] ${pct}%`);

console.log(`\nQUICK ACTIONS`);
console.log(`  Research wildlife: node gather-facts.js --type=wildlife --key=<slug> --name="..." --topic=<topic> --region=<region>`);
console.log(`  Research lodge:    node gather-facts.js --type=lodge --key=<slug> --name="..." --topic=lodge-review --region=<region>`);
console.log(`  Review candidates: node promote-fact.js --all --dry`);
console.log(`  Promote a key:     node promote-fact.js --key=<entityKey>`);
console.log('');
