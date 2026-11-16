// Guard for the Vietnam records (added 2026-11-16 after a two-reader check against official pages).
// Data-driven: reads data/facts/facts.json + sources.json. No network.
// What it stops from coming back:
//   1. a volatile visa / e-visa / health-declaration / arrival-card claim marked "confirmed" without two
//      sources of DIFFERENT owners (all Vietnamese government bodies, incl. the tourism authority, count as ONE owner;
//      sources with no tier = commercial visa agents / travel sellers do not count at all);
//   2. any record that cites kim-firsthand (no named, consenting person and no dated visit on record) holding a status
//      that lets it be used (only unverified / outdated / conflicting are blocked);
//   3. the label "EU countries" on the visa-exemption lists (Norway, Switzerland, UK, Belarus are not EU) and the old
//      e-visa portal address given as current.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'facts');
const FACTS = JSON.parse(readFileSync(join(DATA, 'facts.json'), 'utf8')).facts;
const SOURCES = JSON.parse(readFileSync(join(DATA, 'sources.json'), 'utf8')).sources;

const VN_REGIONS = new Set(['vietnam', 'hanoi', 'hoi-an', 'hue', 'ha-long-bay', 'con-dao', 'phu-quoc', 'mekong-delta']);
const VN = FACTS.filter(f => VN_REGIONS.has(f.region));
const text = f => `${f.claim ?? ''} ${f.value ?? ''}`;
const BLOCKED = new Set(['unverified', 'outdated', 'conflicting']);
const VOLATILE_RULE = /\b(visa|e-visa|evisa|health declaration|arrival card|pre-arrival)\b/i; // word-bounded: 'inadvisable' must not match

// A source is a registry id (string) or an inline {url, tier} object.
function resolve(s) {
  if (typeof s === 'string') return { id: s, ...(SOURCES[s] ?? {}) };
  return s;
}
function owner(url) {
  const host = String(url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase();
  if (!host) return null;
  // One government = one owner: *.gov.vn pages, the tourism authority (vietnam.travel) and the state news outlet.
  if (host.endsWith('.gov.vn') || host === 'gov.vn' || host === 'vietnam.travel' || host === 'vietnamnews.vn') return 'government-of-vietnam';
  const parts = host.split('.');
  const multi = ['co.uk', 'gov.uk', 'org.uk', 'com.au', 'co.nz'];
  return multi.includes(parts.slice(-2).join('.')) ? parts.slice(-3).join('.') : parts.slice(-2).join('.');
}
const countedOwners = f => new Set(
  (f.sources ?? []).map(resolve).filter(s => s && s.tier != null && s.tier <= 4 && s.url).map(s => owner(s.url))
);

test('there are Vietnam records to guard (guard is not vacuous)', () => {
  assert.ok(VN.length >= 60, `expected the Vietnam records, got ${VN.length}`);
});

test('volatile visa / health / arrival-card claims: "confirmed" needs two sources of different owners', () => {
  const bad = VN.filter(f => f.status === 'confirmed' && (f.volatile === true || VOLATILE_RULE.test(text(f))))
    .filter(f => countedOwners(f).size < 2)
    .map(f => `${f.id} (${countedOwners(f).size} owner)`);
  assert.deepEqual(bad, []);
});

test('records citing kim-firsthand are blocked (unverified/outdated/conflicting), not publishable', () => {
  const kim = FACTS.filter(f => (f.sources ?? []).some(s => (typeof s === 'string' ? s : s?.id) === 'kim-firsthand'));
  assert.ok(kim.length >= 7, `expected the 7 kim-firsthand records, found ${kim.length}`);
  const bad = kim.filter(f => !BLOCKED.has(f.status)).map(f => `${f.id} is ${f.status}`);
  assert.deepEqual(bad, []);
});

test('no Vietnam record calls the visa-exempt countries "EU countries", or gives the old portal as current', () => {
  const eu = VN.filter(f => /\bEU countries\b|\bEU\/UK\b|\bEU citizens\b|\bEU, US\b/i.test(text(f))).map(f => f.id);
  assert.deepEqual(eu, [], 'Norway, Switzerland, the UK and Belarus are not in the EU');
  const old = VN.filter(f => /evisa\.xuatnhapcanh\.gov\.vn/i.test(text(f))).map(f => f.id);
  assert.deepEqual(old, [], 'portal moved on 11 Nov 2024 to evisa.gov.vn / thithucdientu.gov.vn');
});

test('every registry source id used by a Vietnam record exists in sources.json', () => {
  const missing = VN.flatMap(f => (f.sources ?? []).filter(s => typeof s === 'string' && !SOURCES[s]).map(s => `${f.id}:${s}`));
  assert.deepEqual(missing, []);
});
