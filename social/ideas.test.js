import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict';
import path from 'node:path'; import fs from 'node:fs'; import { fileURLToPath } from 'node:url'; import { spawnSync } from 'node:child_process';
import { buildIdeaPool, REFUSAL_PATTERNS, FIRST_PERSON_PATTERNS, DEFAULT_REGIONS, loadInputs, historyFromQueue, historyFromAudit, regionCountry, parseFrontMatter, ideaId } from './ideas.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const NOW = '2026-11-17';
const fact = (o = {}) => ({ id: 'f1', topic: 'safari', region: 'serengeti', claim: 'Serengeti park size', value: 'The Serengeti covers about 30,000 square kilometres.', sources: ['a', 'b'], status: 'confirmed', lastChecked: '2026-10-01', ...o });
const page = (o = {}) => ({ path: '/wildlife/x/', title: 'Whale sharks of Mafia', description: 'When and where to see them.', region: 'Mafia Island, Tanzania', bestMonths: [], lastUpdated: '2026-10-01', draft: false, retired: false, collection: 'wildlife', ...o });
const rule = (o = {}) => ({ id: 'r1', label: 'Visa fee', body: 'Immigration Dept', address: 'https://x.go.tz/fee', figures: [{ label: 'Ordinary Visa', amount: 50, currency: 'USD' }], read_on: '2026-11-17', date_on_page: null, confidence: 'official-page', expired: false, ...o });
const pool = (inp = {}) => buildIdeaPool({ facts: [], pages: [], rules: [], history: [], now: NOW, config: {}, ...inp });
const reasons = (p) => p.dropped.map((d) => d.reason);

test('shape: id is a stable hash of kind and source id; claims carry a source date', () => {
  const p = pool({ facts: [fact()] });
  assert.equal(p.ideas.length, 1);
  const i = p.ideas[0];
  assert.equal(i.kind, 'fact'); assert.equal(i.id, ideaId('fact', 'f1')); assert.notEqual(ideaId('fact', 'f1'), ideaId('page', 'f1'));
  assert.equal(pool({ facts: [fact()] }).ideas[0].id, i.id);
  assert.equal(i.topic, 'safari');
  assert.deepEqual(i.claims, [{ text: 'The Serengeti covers about 30,000 square kilometres.', factId: 'f1', sourceDate: '2026-10-01' }]);
  assert.equal(typeof i.score, 'number'); assert.ok(Array.isArray(i.reasons) && i.reasons.length > 0);
  assert.deepEqual(p.dropped, []);
});
test('only status exactly "confirmed" feeds an idea; every other status is dropped with its reason', () => {
  const statuses = ['confirmed', 'single-source', 'unverified', 'conflicting', 'outdated', 'single', 'authoritative', 'reported-unconfirmed', undefined];
  const facts = statuses.map((s, n) => fact({ id: `s${n}`, status: s }));
  const p = pool({ facts });
  assert.deepEqual(p.ideas.map((i) => i.claims[0].factId), ['s0']);
  assert.equal(p.dropped.length, 8);
  assert.ok(p.dropped.every((d) => d.kind === 'fact' && /^status:/.test(d.reason) && d.sourceId));
});
test('regions: Tanzania and Zanzibar only by default; others need config.regions', () => {
  assert.deepEqual(DEFAULT_REGIONS, ['tanzania', 'zanzibar']);
  const facts = ['serengeti', 'zanzibar', 'stone-town', 'mafia-island', 'hanoi', 'vietnam', 'masai-mara', 'rwanda', 'east-africa', 'global', 'nowhere-known'].map((r) => fact({ id: r, region: r }));
  const p = pool({ facts });
  assert.deepEqual(p.ideas.map((i) => i.claims[0].factId).sort(), ['mafia-island', 'serengeti', 'stone-town', 'zanzibar']);
  assert.ok(p.dropped.filter((d) => /^region:/.test(d.reason)).length === 7);
  const v = pool({ facts, config: { regions: ['vietnam'] } });
  assert.deepEqual(v.ideas.map((i) => i.claims[0].factId).sort(), ['hanoi', 'vietnam']);
  assert.equal(regionCountry('phu-quoc'), 'vietnam'); assert.equal(regionCountry('kenya'), 'kenya'); assert.equal(regionCountry('pemba'), 'zanzibar');
});
test('refusal: sea condition words are dropped (whole word), in the claim and in the title', () => {
  const bad = ['Seaweed is drying on the beach', 'The sea state was rough', 'Big waves at the reef', 'Swimming conditions were good', 'Check the swim conditions first', 'Swimming at the sandbank is fine'];
  for (const t of bad) {
    const p = pool({ facts: [fact({ value: t })] });
    assert.equal(p.ideas.length, 0, t); assert.match(reasons(p)[0], /^refusal:/, t);
  }
  const title = pool({ facts: [fact({ claim: 'Waves at Kendwa', value: 'Dolphin tours leave at six.' })] });
  assert.equal(title.ideas.length, 0); assert.match(reasons(title)[0], /^refusal:/);
  for (const t of ['A heatwave in March', 'Wavelength of light', 'Swimmingly done']) assert.equal(pool({ facts: [fact({ value: t })] }).ideas.length, 1, t);
  assert.ok(REFUSAL_PATTERNS && Object.keys(REFUSAL_PATTERNS).length >= 5);
});
test('refusal: seaweed farming is allowed only for Paje, Jambiani, Bwejuu and never with Michamvi, Pingwe or Kae', () => {
  const ok = pool({ facts: [fact({ value: 'Seaweed farming in Paje, Jambiani and parts of Bwejuu is a main income for local women.', region: 'zanzibar' })] });
  assert.equal(ok.ideas.length, 1);
  assert.equal(pool({ facts: [fact({ value: 'Seaweed farming in Paje is a main income.' })] }).ideas.length, 1);
  for (const t of ['Seaweed farming in Paje and Michamvi.', 'Seaweed farming in Jambiani, Pingwe and Bwejuu.', 'Seaweed farming in Bwejuu and Kae.', 'Seaweed farming in Nungwi.', 'Seaweed is on the beach in Paje.', 'Seaweed farming in Paje, but the waves are high.', 'Seaweed farming in Paje, swimming is hard.']) {
    assert.equal(pool({ facts: [fact({ value: t })] }).ideas.length, 0, t);
  }
  assert.equal(pool({ facts: [fact({ value: 'Seaweed farming in Kaelo and Paje.' })] }).ideas.length, 1, 'Kae is whole-word only');
});
test('refusal: a claim without a source date is dropped (fact, page, rule)', () => {
  const p = pool({ facts: [fact({ id: 'a', lastChecked: undefined }), fact({ id: 'b', lastChecked: 'last spring' }), fact({ id: 'c', lastChecked: undefined, promotedOn: '2026-09-09' })], pages: [page({ lastUpdated: null })], rules: [rule({ read_on: null, date_on_page: null })] });
  assert.deepEqual(p.ideas.map((i) => i.claims[0].factId), ['c']);
  assert.equal(p.dropped.filter((d) => d.reason === 'no-source-date').length, 4);
  assert.equal(pool({ facts: [fact({ lastChecked: undefined, promotedOn: undefined, added: '2026-08-01' })] }).ideas[0].claims[0].sourceDate, '2026-08-01');
});
test('refusal: injected neverPromotePatterns (strings or RegExp) drop an idea and say which', () => {
  const config = { neverPromotePatterns: ['blue banana', /^zz-secret/i] };
  const p = pool({ facts: [fact({ id: 'a', value: 'Try the Blue Banana lodge.' }), fact({ id: 'b', claim: 'ZZ-Secret place', value: 'Fine words.' }), fact({ id: 'c' })], config });
  assert.deepEqual(p.ideas.map((i) => i.claims[0].factId), ['c']);
  assert.ok(p.dropped.every((d) => /^never-promote:/.test(d.reason)));
  assert.equal(pool({ facts: [fact()], config: { neverPromotePatterns: [] } }).ideas.length, 1);
  assert.equal(pool({ pages: [page({ title: 'About the blue banana' })], config }).ideas.length, 0);
  assert.equal(pool({ rules: [rule({ label: 'The blue banana fee' })], config }).ideas.length, 0);
});
test('refusal: first person about having been somewhere is dropped', () => {
  const bad = ['We stayed at the lodge for three nights.', 'Our visit was in July.', 'I visited the park twice.', 'We tried the spice tour.', "We've been to Mafia.", 'I went to Jozani.', 'Our stay at the camp.'];
  for (const t of bad) { const p = pool({ facts: [fact({ value: t })] }); assert.equal(p.ideas.length, 0, t); assert.equal(reasons(p)[0], 'first-person', t); }
  for (const t of ['Visitors stayed an average of 8 days.', 'The tour visited three villages in 1990.', 'Guests tried to book early.']) assert.equal(pool({ facts: [fact({ value: t })] }).ideas.length, 1, t);
  assert.ok(FIRST_PERSON_PATTERNS.length >= 3);
  assert.equal(pool({ pages: [page({ description: 'We stayed here and loved it.' })] }).ideas.length, 0);
});
test('rules: only official-page and not expired become ideas; each other case is dropped with a reason', () => {
  const p = pool({ rules: [rule({ id: 'ok' }), rule({ id: 'ind', confidence: 'official-indirect' }), rule({ id: 'nc', confidence: 'not-confirmed', figures: [] }), rule({ id: 'exp', expired: true, period: 'FY 2023/2024' }), rule({ id: 'nofig', figures: [] })] });
  assert.deepEqual(p.ideas.map((i) => i.claims[0].ruleId), ['ok']);
  const m = Object.fromEntries(p.dropped.map((d) => [d.sourceId, d.reason]));
  assert.match(m.ind, /^rule:confidence/); assert.match(m.nc, /^rule:confidence/); assert.equal(m.exp, 'rule:expired'); assert.equal(m.nofig, 'rule:no-figures');
  const i = p.ideas[0];
  assert.equal(i.kind, 'rule'); assert.equal(i.link, 'https://x.go.tz/fee'); assert.match(i.claims[0].text, /Ordinary Visa 50 USD/); assert.equal(i.claims[0].sourceDate, '2026-11-17');
});
test('pages: drafts and retired pages are skipped; Kenya-only pages are skipped; missing region uses the destination', () => {
  const p = pool({ pages: [page({ path: '/a/' }), page({ path: '/d/', draft: true }), page({ path: '/r/', retired: true }), page({ path: '/k/', region: 'Masai Mara, Kenya' }), page({ path: '/w/', region: null, destinationId: 'zanzibar' }), page({ path: '/u/', region: null, destinationId: null })] });
  assert.deepEqual(p.ideas.map((i) => i.link).sort(), ['/a/', '/w/']);
  const m = Object.fromEntries(p.dropped.map((d) => [d.sourceId, d.reason]));
  assert.equal(m['/d/'], 'draft'); assert.equal(m['/r/'], 'retired'); assert.match(m['/k/'], /^region:/); assert.match(m['/u/'], /^region:/);
  const i = p.ideas.find((x) => x.link === '/a/');
  assert.equal(i.kind, 'page'); assert.equal(i.title, 'Whale sharks of Mafia'); assert.equal(i.claims[0].text, 'When and where to see them.'); assert.equal(i.claims[0].sourceDate, '2026-10-01');
});
test('history: an idea whose source id is in history within repeatDays is dropped; older is kept', () => {
  const facts = [fact({ id: 'a' }), fact({ id: 'b' }), fact({ id: 'c' })];
  const p = pool({ facts, history: [{ sourceId: 'fact:a', date: '2026-08-01' }, { sourceId: 'fact:b', date: '2026-07-01' }] });
  assert.deepEqual(p.ideas.map((i) => i.claims[0].factId).sort(), ['b', 'c']);
  assert.equal(p.dropped[0].reason, 'repeat:120d');
  const q = pool({ facts, history: [{ sourceId: 'fact:b', date: '2026-07-01' }], config: { repeatDays: 200 } });
  assert.deepEqual(q.ideas.map((i) => i.claims[0].factId).sort(), ['a', 'c']);
  const byId = pool({ facts: [fact()], history: [{ sourceId: ideaId('fact', 'f1'), date: '2026-11-01' }] });
  assert.equal(byId.ideas.length, 0);
  const byLink = pool({ pages: [page()], history: [{ sourceId: null, date: '2026-11-01', text: 'read more at /wildlife/x/' }] });
  assert.equal(byLink.ideas.length, 0);
  const noDate = pool({ facts: [fact()], history: [{ sourceId: 'fact:f1', date: 'bad' }] });
  assert.equal(noDate.ideas.length, 0, 'an unreadable history date counts as recent (fail closed)');
  assert.equal(pool({ facts: [fact()], history: [{ sourceId: 'fact:other', date: '2026-11-01' }] }).ideas.length, 1);
});
test('ranking: fresher first; topic weights multiply; month bonus; ties break by id; order does not depend on input order', () => {
  const facts = [fact({ id: 'old', lastChecked: '2025-12-01' }), fact({ id: 'new', lastChecked: '2026-11-10' }), fact({ id: 'mid', lastChecked: '2026-06-01' })];
  assert.deepEqual(pool({ facts }).ideas.map((i) => i.claims[0].factId), ['new', 'mid', 'old']);
  const w = pool({ facts: [fact({ id: 'x', topic: 'visa', lastChecked: '2026-09-01' }), fact({ id: 'y', topic: 'safari', lastChecked: '2026-11-10' })], config: { topicWeights: { visa: 3 } } });
  assert.equal(w.ideas[0].claims[0].factId, 'x'); assert.ok(w.ideas[0].reasons.some((r) => /topic weight/.test(r)));
  const base = pool({ facts: [fact({ id: 'x', topic: 'visa', lastChecked: '2026-09-01' })] }).ideas[0].score;
  assert.ok(Math.abs(w.ideas[0].score - base * 3) < 0.01);
  const m1 = pool({ pages: [page({ path: '/in/', bestMonths: [11, 12] }), page({ path: '/out/', bestMonths: [3] })] }).ideas;
  assert.equal(m1[0].link, '/in/'); assert.ok(m1[0].reasons.some((r) => /month/.test(r))); assert.ok(m1[0].score > m1[1].score);
  const f1 = pool({ facts: [fact({ id: 'm', months: [11] }), fact({ id: 'n', season: 'June-October' }), fact({ id: 'o', season: 'October to January' })] }).ideas;
  assert.deepEqual(f1.filter((i) => i.reasons.some((r) => /month/.test(r))).map((i) => i.claims[0].factId).sort(), ['m', 'o']);
  const ties = ['t3', 't1', 't2'].map((id) => fact({ id }));
  const a = pool({ facts: ties }).ideas.map((i) => i.id); const b = pool({ facts: [...ties].reverse() }).ideas.map((i) => i.id);
  assert.deepEqual(a, b);
  assert.deepEqual(a, [...a].sort((x, y) => x.localeCompare(y)), 'equal scores are ordered by id');
});
test('dropped entries always carry kind, sourceId, reason', () => {
  const p = pool({ facts: [fact({ id: 'a', status: 'outdated' })], pages: [page({ draft: true })], rules: [rule({ expired: true, period: 'x' })] });
  assert.equal(p.dropped.length, 3);
  for (const d of p.dropped) { assert.ok(['fact', 'page', 'rule'].includes(d.kind)); assert.ok(d.sourceId); assert.ok(d.reason); }
});
test('history readers: queue keeps posted and queued items only; audit export is optional and read as dated entries', () => {
  const q = { drafts: [{ id: 'B1', status: 'posted', sourceId: 's1', postedAt: '2026-09-15T06:12:23.148Z', sourceDate: '2026-09-13' }, { id: 'B2', status: 'expired', sourceId: 's2', createdAt: '2026-09-01T00:00:00Z' }, { id: 'B3', status: 'pending_approval', sourceId: 's3', createdAt: '2026-11-12T00:00:00Z' }, { id: 'B4', status: 'skipped', sourceId: 's4', createdAt: '2026-09-01T00:00:00Z' }] };
  assert.deepEqual(historyFromQueue(q).map((h) => h.sourceId), ['s1', 's3']);
  assert.deepEqual(historyFromQueue(null), []); assert.deepEqual(historyFromQueue({}), []);
  const h = historyFromAudit({ posts: [{ id: '1', utc: '2025-02-17T15:13:50.000Z', hook: 'Hello' }] });
  assert.deepEqual(h, [{ sourceId: '1', date: '2025-02-17T15:13:50.000Z', text: 'Hello' }]);
  assert.deepEqual(historyFromAudit(null), []);
  assert.doesNotThrow(() => pool({ facts: [fact()], history: undefined }));
});
test('front matter reader: scalars, numbers lists, booleans', () => {
  const fm = parseFrontMatter('---\ntitle: "A: b"\npermalink: "/x/"\nbest_months: [10, 11, 1]\ndraft: false\nfaq:\n  - q: "x"\n    a: "y"\n---\nbody');
  assert.deepEqual({ t: fm.title, p: fm.permalink, m: fm.best_months, d: fm.draft }, { t: 'A: b', p: '/x/', m: [10, 11, 1], d: false });
});

// ── real inputs: invariants only ─────────────────────────────────────────────────────────────
test('REAL data: facts.json + site pages + rules file give a non-empty pool that respects every refusal', () => {
  const inp = loadInputs({ root: ROOT });
  assert.ok(inp.facts.length > 100 && inp.pages.length >= 10 && inp.rules.length >= 5);
  const p = buildIdeaPool({ ...inp, now: NOW });
  assert.ok(p.ideas.length > 0, 'pool not empty');
  const byId = new Map(inp.facts.map((f) => [f.id, f]));
  const retired = new Set(inp.pages.filter((x) => x.retired || x.draft).map((x) => x.path));
  for (const i of p.ideas) {
    assert.ok(i.claims.length >= 1 && i.claims.every((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.sourceDate)), `source date: ${i.id}`);
    for (const c of i.claims) if (c.factId) assert.equal(byId.get(c.factId).status, 'confirmed');
    for (const c of i.claims) if (c.ruleId) { const r = inp.rules.find((x) => x.id === c.ruleId); assert.equal(r.confidence, 'official-page'); assert.notEqual(r.expired, true); }
    const text = [i.title, ...i.claims.map((c) => c.text)].join(' \n ');
    for (const [name, re] of Object.entries(REFUSAL_PATTERNS)) {
      if (name === 'seaweed' && /seaweed farming/i.test(text) && /\b(?:Paje|Jambiani|Bwejuu)\b/.test(text) && !/\b(?:Michamvi|Pingwe|Kae)\b/.test(text)) continue;
      assert.doesNotMatch(text, re, `${name}: ${i.title}`);
    }
    for (const re of FIRST_PERSON_PATTERNS) assert.doesNotMatch(text, re);
    if (i.kind === 'page') assert.ok(!retired.has(i.link));
  }
  assert.deepEqual([...new Set(p.ideas.map((i) => i.kind))].sort(), ['fact', 'page', 'rule']);
  assert.equal(new Set(p.ideas.map((i) => i.id)).size, p.ideas.length);
});
test('CLI: prints ranked ideas as JSON and writes nothing', () => {
  const snap = () => ['data', 'social'].flatMap((d) => fs.readdirSync(path.join(ROOT, d), { recursive: true }).map((f) => { const s = fs.statSync(path.join(ROOT, d, f)); return `${d}/${f}:${s.mtimeMs}:${s.size}`; })).sort().join('\n');
  const before = snap();
  const r = spawnSync(process.execPath, [path.join(HERE, 'ideas.js'), '--top', '3', '--json'], { encoding: 'utf8', env: { ...process.env, HOME: '/nonexistent-home' } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout); assert.equal(out.ideas.length, 3); assert.ok(out.counts && out.droppedByReason);
  assert.equal(snap(), before);
  const t = spawnSync(process.execPath, [path.join(HERE, 'ideas.js'), '--top', '2'], { encoding: 'utf8', env: { ...process.env, HOME: '/nonexistent-home' } });
  assert.equal(t.status, 0); assert.match(t.stdout, /score/);
});
test('retired list read as text equals what the redirect stub script imports', async () => {
  const { RETIRED } = await import(path.join(ROOT, 'site', 'src', 'lib', 'retired-redirects.mjs'));
  const { loadRetired } = await import('./ideas.js');
  assert.deepEqual(loadRetired(ROOT).sort(), Object.keys(RETIRED).map((s) => `/excursions/${s}/`).sort());
  assert.ok(loadRetired(ROOT).length >= 7);
  assert.deepEqual(loadRetired('/nonexistent-root'), []);
});
test('titleFromOtherField: title and claim text from different strings are marked with a reason; a cut of the same text is not', () => {
  const p = pool({ facts: [fact({ id: 'd', claim: 'The buffalo is listed as Least Concern.', value: 'Near Threatened (IUCN 2019)' }), fact({ id: 's', claim: 'The Serengeti  covers about 30,000 square kilometres.', value: 'the serengeti covers about 30,000 square kilometres.' }), fact({ id: 'n', value: undefined, claim: 'A long claim sentence about the park and its many resident animals that goes on and on past the cut.' })] });
  const by = (id) => p.ideas.find((i) => i.claims[0].factId === id);
  assert.equal(by('d').titleFromOtherField, true); assert.ok(by('d').reasons.some((r) => /different strings/.test(r)));
  assert.equal(by('s').titleFromOtherField, undefined); assert.equal(by('n').titleFromOtherField, undefined);
});
