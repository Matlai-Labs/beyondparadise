import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scanPaths, flipReport, effectiveStatus, loadClaims } from '../claim-clock.mjs';

const FIX = new URL('./fixtures/incidents/', import.meta.url).pathname;
const claims = loadClaims(new URL('../claims.json', import.meta.url).pathname);
const today = '2026-10-08';
const scan = (f) => scanPaths([FIX + f], { claims, today });

test('seed registry is valid: every claim has id, dates, status, sources', () => {
  for (const c of claims) {
    assert.ok(c.id && c.status, c.id);
    assert.ok(c.valid_from || c.verify === true, c.id + ' needs valid_from or verify:true');
    assert.ok(['announced', 'operating', 'ended'].includes(c.status), c.id);
    assert.ok(Array.isArray(c.sources) && c.sources.length, c.id);
  }
  for (const id of ['ba-lgw-jro-znz', 'at-lgw', 'tui-lgw-znz']) assert.ok(claims.some((c) => c.id === id), id);
});

test('INCIDENT 1: UK ad claiming Air Tanzania Gatwick non-stop -> ERROR with file:line', () => {
  const h = scan('uk-ad.json');
  const errs = h.filter((x) => x.severity === 'error' && x.claim === 'at-lgw');
  assert.ok(errs.length >= 2, JSON.stringify(h));
  assert.ok(errs[0].line > 0 && errs[0].file.endsWith('uk-ad.json'));
  assert.match(errs[0].suggestion, /1 July 2027/);
});

test('INCIDENT 2: Compass post listing British Airways as flying -> ERROR', () => {
  const h = scan('compass-post.md');
  const errs = h.filter((x) => x.severity === 'error' && x.claim === 'ba-lgw-jro-znz');
  assert.ok(errs.length >= 1, JSON.stringify(h));
  assert.ok(errs.some((e) => e.line === 9 || e.line === 12), 'points at BA line: ' + errs.map((e) => e.line));
});

test('INCIDENT 3: "2024/25 rates" -> WARN stale period', () => {
  const h = scan('fees.md');
  assert.ok(h.some((x) => x.rule === 'stale-period' && x.severity === 'warn'), JSON.stringify(h));
});

test('correctly dated / hedged wording is NOT flagged; Condor (operating) is fine', () => {
  assert.deepEqual(scan('safe.md').filter((x) => x.severity === 'error'), []);
});

test('multilingual present-tense claims (de/fr/it/es/pl) all error', () => {
  const h = scan('multilingual.md').filter((x) => x.severity === 'error');
  assert.deepEqual([...new Set(h.map((x) => x.line))].sort(), [1, 2, 3, 4, 5]);
});

test('announced fact stated without a date -> WARN announced-undated', () => {
  const h = scan('undated.md');
  assert.ok(h.some((x) => x.rule === 'announced-undated'), JSON.stringify(h));
  assert.ok(!h.some((x) => x.severity === 'error'));
});

test('scan date is injectable: after 2027-07-01 the Air Tanzania ad is no longer an error', () => {
  const h = scanPaths([FIX + 'uk-ad.json'], { claims, today: '2027-07-02' });
  assert.deepEqual(h.filter((x) => x.severity === 'error' && x.claim === 'at-lgw'), []);
});

test('effectiveStatus follows dates, and "ended" in registry wins', () => {
  const c = { valid_from: '2027-05-29', valid_until: '2027-10-31', status: 'announced' };
  assert.equal(effectiveStatus(c, '2026-10-08'), 'announced');
  assert.equal(effectiveStatus(c, '2027-06-01'), 'operating');
  assert.equal(effectiveStatus(c, '2027-11-01'), 'ended');
  assert.equal(effectiveStatus({ ...c, status: 'ended' }, '2027-06-01'), 'ended');
});

test('flip report lists claims whose valid_from passed but registry still says announced', () => {
  const r = flipReport(claims, '2027-05-30');
  assert.ok(r.nowOperating.some((c) => c.id === 'ba-lgw-jro-znz'));
  assert.ok(!r.nowOperating.some((c) => c.id === 'at-lgw'));
  const soon = flipReport(claims, '2027-05-01', { soonDays: 60 });
  assert.ok(soon.soon.some((c) => c.id === 'ba-lgw-jro-znz'));
  const ended = flipReport(claims, '2027-11-02');
  assert.ok(ended.nowEnded.some((c) => c.id === 'ba-lgw-jro-znz'));
});

test('INCIDENT 2b (the real Compass wording): "Common Airlines: Top choices include ... British Airways" in a Zanzibar doc -> ERROR', () => {
  const h = scan('compass-sentence.md').filter((x) => x.severity === 'error' && x.claim === 'ba-lgw-jro-znz');
  assert.equal(h.length, 1, JSON.stringify(scan('compass-sentence.md')));
  assert.equal(h[0].line, 5);
});

test('BA mentioned in a doc that is NOT about Zanzibar/London is not flagged (document-scope object)', async () => {
  const { makeSite } = await import('./helpers.mjs');
  const dir = makeSite({ 'x.md': 'Top choices include Qatar Airways and British Airways for flights to Lisbon.\n' });
  assert.deepEqual(scanPaths([dir], { claims, today }), []);
});
