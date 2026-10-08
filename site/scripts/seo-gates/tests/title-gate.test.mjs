import test from 'node:test';
import assert from 'node:assert/strict';
import { checkTitles } from '../title-gate.mjs';

const T = (id, title, extra = {}) => ({ id, title, lang: 'en', ...extra });
const rules = (f) => f.map((x) => `${x.severity}:${x.rule}`);

test('length: >60 and <30 are errors, >55 warns', () => {
  const f = checkTitles([
    T('/long', 'Boutique Hotel Zanzibar Beachfront Villas With Private Chef | Matlai'),
    T('/short', 'Hotel Matlai'),
    T('/warn', 'Boutique Hotel Michamvi Zanzibar Beach Stay | Matlai Resort X'.slice(0, 57)),
  ]);
  assert.ok(rules(f.filter((x) => x.id === '/long')).includes('error:too-long'));
  assert.ok(rules(f.filter((x) => x.id === '/short')).includes('error:too-short'));
  assert.ok(rules(f.filter((x) => x.id === '/warn')).includes('warn:near-limit'));
});

test('per-language limits: German 70 chars passes with de limit, fails with default', () => {
  const t = 'Boutique-Hotel Sansibar Michamvi: Strandvilla mit Pool und Garten | Matlai';
  assert.ok(t.length > 60 && t.length <= 75, String(t.length));
  const opts = { limits: { de: { max: 75, warnAt: 70 } } };
  assert.ok(!checkTitles([{ id: '/d', title: t, lang: 'de' }], opts).some((x) => x.rule === 'too-long'));
  assert.ok(checkTitles([{ id: '/d', title: t, lang: 'fr' }], opts).some((x) => x.rule === 'too-long'));
});

test('AI-style patterns are flagged', () => {
  const bad = [
    'The Ultimate Guide to Zanzibar Beaches in 2026',
    'Comprehensive Zanzibar Travel Planning Overview',
    'Zanzibar Honeymoon: Everything You Need to Know',
    'An Honest Review of Michamvi Beach Hotels',
    'Zanzibar Complete Guide for First Timers',
    'Zanzibar: A Journey Through Spice and Sea',
    'Which Zanzibar Beach Is Better for Couples',
    'Zanzibar: Where to Stay? Best Areas: Compared',
    'Zanzibar - Hotels - Beaches - Food - Tours: Matlai',
  ];
  const f = checkTitles(bad.map((t, i) => T('/p' + i, t)));
  for (let i = 0; i < bad.length; i++) {
    assert.ok(f.some((x) => x.id === '/p' + i && x.rule === 'ai-style'), `missed: ${bad[i]}`);
  }
});

test('a clean title produces no ai-style finding', () => {
  const f = checkTitles([T('/ok', 'Boutique Hotel Zanzibar Beachfront | Matlai Michamvi', { h1: 'Boutique hotel Zanzibar' })]);
  assert.deepEqual(f, []);
});

test('exact duplicates error, near-duplicates (Jaccard>=0.5) warn as cannibalisation, per language', () => {
  const f = checkTitles([
    T('/a', 'Zanzibar Honeymoon Villa With Private Pool | Matlai'),
    T('/b', 'Zanzibar Honeymoon Villa With Private Pool | Matlai'),
    T('/c', 'Zanzibar Honeymoon Villa Private Pool Dinner | Matlai'),
    T('/d', 'Seaweed Farms and Tides at Michamvi Beach | Matlai'),
    { id: '/de-a', title: 'Zanzibar Honeymoon Villa With Private Pool | Matlai', lang: 'de' },
  ]);
  assert.ok(f.some((x) => x.rule === 'duplicate' && x.severity === 'error'));
  assert.ok(f.some((x) => x.rule === 'near-duplicate' && x.severity === 'warn'));
  assert.ok(!f.some((x) => x.id === '/d'));
  assert.ok(!f.some((x) => x.id === '/de-a'), 'different language must not collide');
});

test('keyword-less title: no overlap with slug or h1 warns', () => {
  const f = checkTitles([T('/seaweed-tides', 'Welcome to Paradise | Matlai Resort Experience', { h1: 'Seaweed and tides' })]);
  assert.ok(f.some((x) => x.rule === 'no-keyword'));
});

test('allowlist silences named rules for a path (and * for all)', () => {
  const items = [T('/long', 'Boutique Hotel Zanzibar Beachfront Villas With Private Chef | Matlai')];
  assert.ok(checkTitles(items, { allow: { '/long': ['too-long'] } }).every((x) => x.rule !== 'too-long'));
  assert.deepEqual(checkTitles(items, { allow: { '/lo*': '*' } }), []);
});
