import './test-env.js';
// Unit tests for the owner's content rules. Pure function, injected patterns, the real never-promote file is never read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { rulesGate, loadNeverPromote, neverPromoteFile, REFUSAL_PATTERNS, FIRST_PERSON_PATTERNS, PAID_LINK_PATTERNS } from './rules-gate.js';
import * as ideas from './ideas.js';

const NEVER = ['examplehotel', 'made up place'];
const rules = (text, o = {}) => rulesGate(text, { neverPromotePatterns: NEVER, claims: [], ...o });
const ids = (r) => r.violations.map((v) => v.rule);
const clean = 'The ferry from Dar es Salaam to Zanzibar takes about two hours. More on the site, link in profile.';

test('a harmless text passes with no violations', () => { assert.deepEqual(rules(clean), { ok: true, violations: [] }); });

// 1 sea-conditions
test('sea-conditions: seaweed, sea state, waves, swimming conditions are refused', () => {
  for (const t of ['Lots of seaweed on the beach today.', 'The sea state is calm.', 'Big waves this week.', 'Swim conditions look good.', 'Swimming conditions are fine.', 'Seaweed washed up near the pier.']) {
    assert.ok(ids(rules(t)).includes('sea-conditions'), t);
  }
});
test('sea-conditions: text without those words passes', () => { assert.ok(!ids(rules('The dhow leaves at nine and the market opens at ten.')).includes('sea-conditions')); });
test('sea-conditions: washed-up seaweed is refused even next to an allowed farming mention', () => {
  assert.ok(ids(rules('Seaweed farming in Paje is a local trade. Washed-up seaweed covered the beach.')).includes('sea-conditions'));
});
test('the pattern constants are one source of truth: ideas.js re-exports the same objects', () => {
  assert.equal(ideas.REFUSAL_PATTERNS, REFUSAL_PATTERNS); assert.equal(ideas.FIRST_PERSON_PATTERNS, FIRST_PERSON_PATTERNS);
});

// 2 seaweed-farming-place
test('seaweed-farming-place: farming named in Paje, Jambiani or Bwejuu passes (and is not a sea-condition)', () => {
  for (const t of ['Seaweed farming in Paje supports many families.', 'In Jambiani, seaweed farmers work at low tide.', 'Seaweed harvesting around Bwejuu is a daily routine.']) assert.deepEqual(ids(rules(t)), [], t);
});
test('seaweed-farming-place: no place, a place that is not allowed, or an allowed place plus a forbidden one, is refused', () => {
  for (const t of ['Seaweed farming is common on the east coast.', 'Seaweed farming in Michamvi is growing.', 'Seaweed farming in Paje and Pingwe is shown here.', 'Seaweed harvesting near Kae is a daily routine.', 'Seaweed farming in Paje, and in Kae too.']) {
    assert.ok(ids(rules(t)).includes('seaweed-farming-place'), t);
  }
});

// 3 first-person-visit
test('first-person-visit: claims of having been somewhere are refused', () => {
  for (const t of ['We stayed in a small lodge.', 'Our visit to the forest was short.', 'I visited the market.', 'We tried the octopus.', 'During our stay the market was busy.', 'When we were at the fort, it was quiet.', "We've been to the island twice.", 'My stay was calm.', 'I went there in March.']) {
    assert.ok(ids(rules(t)).includes('first-person-visit'), t);
  }
});
test('first-person-visit: ordinary we/our text passes', () => {
  for (const t of ['We publish what the official sources say.', 'Our guides explain the route.', 'Visitors stayed for two hours on average.']) assert.ok(!ids(rules(t)).includes('first-person-visit'), t);
});

// 4 never-promote
test('never-promote: whole word, case-insensitive, reports the INDEX not the text', () => {
  assert.deepEqual(rules('A night at ExampleHotel is an option.').violations, [{ rule: 'never-promote', match: '#0' }]);
  assert.deepEqual(rules('Try the MADE   UP place for lunch.').violations, [{ rule: 'never-promote', match: '#1' }]);
  assert.ok(!ids(rules('The examplehotels group is unrelated.')).includes('never-promote'), 'a longer word is not a whole-word match');
});
test('never-promote: regex characters in a pattern are literal, not code', () => {
  assert.ok(ids(rules('Visit a.b today', { neverPromotePatterns: ['a.b'] })).includes('never-promote'));
  assert.ok(!ids(rules('Visit axb today', { neverPromotePatterns: ['a.b'] })).includes('never-promote'));
  assert.doesNotThrow(() => rules('fine', { neverPromotePatterns: ['(['] }));
});
test('never-promote: a missing, empty or malformed list refuses EVERY text (fail closed)', () => {
  for (const bad of [undefined, null, [], 'examplehotel', [''], [1], [null], {}, ['ok', '  ']]) {
    const r = rulesGate(clean, { neverPromotePatterns: bad, claims: [] }); assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(ids(r).includes('never-promote-list-unavailable'), JSON.stringify(bad));
  }
});

// loader
function tmpFile(content) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-np-')); const f = path.join(d, 'np.json'); if (content !== undefined) fs.writeFileSync(f, content); return f; }
test('loader: reads { patterns: [...] }; BPA_NEVER_PROMOTE_FILE overrides the default under ~/.matlai', () => {
  assert.equal(neverPromoteFile({ BPA_NEVER_PROMOTE_FILE: '/x/np.json' }), '/x/np.json');
  assert.equal(neverPromoteFile({}), path.join(os.homedir(), '.matlai', 'bpa-never-promote.json'));
  assert.deepEqual(loadNeverPromote({ file: tmpFile(JSON.stringify({ patterns: ['examplehotel', ' other '] })) }), { ok: true, patterns: ['examplehotel', 'other'] });
});
test('loader: missing, unreadable, invalid JSON, wrong shape, empty list, non-string entries are all not ok, and the reason never echoes file content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-np-'));
  for (const f of [path.join(dir, 'nope.json'), dir, tmpFile('{not json secretword'), tmpFile('[]'), tmpFile('{"patterns":[]}'), tmpFile('{"patterns":"secretword"}'), tmpFile('{"patterns":["secretword", 3]}'), tmpFile('{"patterns":["  "]}'), tmpFile('')]) {
    const r = loadNeverPromote({ file: f }); assert.equal(r.ok, false, f); assert.ok(!/secretword/.test(r.reason), 'the reason must not echo file content');
  }
});

// 5 paid-link-wording
test('paid-link-wording: each phrase is refused', () => {
  for (const t of ['Book now before it fills up.', 'Book with us for the tour.', 'Link in bio to book your spot.', 'Use our link for a better rate.', 'Use this discount code today.', 'This is an affiliate link.', 'A sponsored post.', 'A partner offer for readers.', 'DM us to book.']) {
    assert.ok(ids(rules(t)).includes('paid-link-wording'), t);
  }
  assert.ok(PAID_LINK_PATTERNS.length >= 9);
});
test('paid-link-wording: a plain pointer to the site passes', () => {
  for (const t of ['More on the site, link in profile.', 'Read the full guide on the website, link in profile.']) assert.deepEqual(ids(rules(t)), [], t);
});

// 6 unsourced-figure
const claim = (text, sourceDate = '2026-11-01') => ({ text, sourceDate });
test('unsourced-figure: money amounts with no claims are refused', () => {
  for (const t of ['The entry fee is 25 USD.', 'Entry costs $25.', 'It is TZS 50,000 per person.', 'It is 50,000 shillings.', 'The price is 30 EUR.', '€30 for adults.', 'About 20 dollars.', 'The fee is 15 for adults.', 'A charge of 10 applies.', 'Prices start at 40.']) {
    assert.ok(ids(rules(t)).includes('unsourced-figure'), t);
  }
});
test('unsourced-figure: the figure must be in a claim that has a sourceDate', () => {
  const t = 'The entry fee is 25 USD.';
  assert.deepEqual(rules(t, { claims: [claim('Adults pay USD 25 at the gate.')] }).violations, []);
  assert.deepEqual(rules('It is TZS 50,000 per person.', { claims: [claim('Entry: 50000 TZS')] }).violations, [], 'thousands separators do not matter');
  assert.ok(ids(rules(t, { claims: [{ text: 'Adults pay USD 25 at the gate.' }] })).includes('unsourced-figure'), 'no sourceDate: not sourced');
  assert.ok(ids(rules(t, { claims: [claim('Adults pay USD 25 at the gate.', '')] })).includes('unsourced-figure'));
  assert.ok(ids(rules(t, { claims: [claim('Adults pay USD 35 at the gate.')] })).includes('unsourced-figure'), 'a different figure is not sourced');
  assert.ok(ids(rules(t, { claims: undefined })).includes('unsourced-figure'));
  assert.ok(ids(rules(t, { claims: [null, 'x', {}] })).includes('unsourced-figure'), 'malformed claims never throw and never source anything');
});
test('unsourced-figure: every figure must be sourced, one missing is enough', () => {
  assert.deepEqual(rules('Adults pay USD 25 and children pay USD 10.', { claims: [claim('Adults pay USD 25.')] }).violations, [{ rule: 'unsourced-figure', match: 'USD 10' }]);
});
test('unsourced-figure: years, dates, distances, animal counts and times are not figures', () => {
  for (const t of ['In 2026 the park added a trail.', 'It opened on 14 March 2024.', 'The trail is 12 km long and 300 m high.', 'About 40 monkeys live in the forest.', 'The ferry leaves at 9:30 and takes 2 hours.', 'Price list updated in 2026.', 'Open 7 days a week from 08:00.']) {
    assert.ok(!ids(rules(t)).includes('unsourced-figure'), t);
  }
});

test('hype wording is not part of this check', () => { assert.deepEqual(ids(rules('An absolutely incredible, unmissable, world-class trail.')), []); });
test('violations are deterministic and ordered by rule', () => {
  const t = 'We stayed at examplehotel. Big waves. Book now for USD 10.';
  const a = rules(t), b = rules(t); assert.deepEqual(a, b);
  assert.deepEqual(ids(a), ['sea-conditions', 'first-person-visit', 'never-promote', 'paid-link-wording', 'unsourced-figure']);
});
test('non-string input never throws', () => { for (const t of [undefined, null, 5, {}]) assert.doesNotThrow(() => rules(t)); });

// --check-queue (read-only, prints ids and rule ids, never text)
import { execFileSync } from 'node:child_process';
test('--check-queue: counts per state, ids and rule ids of unposted items that would be refused, no text, queue file untouched', () => {
  const f = tmpFile(JSON.stringify({ seq: 3, drafts: [
    { id: 'B1', status: 'posted', text: 'Big waves, book now.' },
    { id: 'B2', status: 'pending_approval', kind: 'outlook', text: 'Big waves this week, book now.' },
    { id: 'B3', status: 'scheduled', kind: 'outlook', text: 'Official guides explain how the trail works. More on the site, link in profile.' }] }));
  const before = fs.readFileSync(f, 'utf8');
  const out = execFileSync('node', [path.join(path.dirname(fileURLToPath(import.meta.url)), 'rules-gate.js'), '--check-queue', f], { encoding: 'utf8' });
  assert.match(out, /posted 1, pending_approval 1, scheduled 1/); assert.match(out, /B2 \[pending_approval\] would be refused: .*sea-conditions.*paid-link-wording/);
  assert.doesNotMatch(out, /B1 \[|B3 \[|Big waves|book now/i); assert.match(out, /not yet posted: 2; would be refused: 1/);
  assert.equal(fs.readFileSync(f, 'utf8'), before);
});
