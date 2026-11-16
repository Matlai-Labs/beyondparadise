// Schema check for the official rules file (the file post ideas of kind "rule" are built from).
import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'rules', 'official-rules.json');
const CONF = ['official-page', 'official-indirect', 'not-confirmed'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = (s) => typeof s === 'string' && ISO.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
/** Returns a list of problems; empty = valid. */
function checkRules(doc) {
  const bad = [];
  if (!doc || !Array.isArray(doc.rules) || doc.rules.length === 0) return ['rules must be a non-empty array'];
  const seen = new Set();
  for (const r of doc.rules) {
    const w = `rule ${r && r.id}`;
    if (typeof r.id !== 'string' || !r.id) bad.push(`${w}: id`); else if (seen.has(r.id)) bad.push(`${w}: duplicate id`); else seen.add(r.id);
    for (const k of ['body', 'label']) if (typeof r[k] !== 'string' || !r[k].trim()) bad.push(`${w}: ${k}`);
    if (typeof r.address !== 'string' || !r.address.startsWith('https://')) bad.push(`${w}: address must start with https://`);
    else { try { new URL(r.address); } catch { bad.push(`${w}: address not a URL`); } }
    if (!CONF.includes(r.confidence)) bad.push(`${w}: confidence ${r.confidence}`);
    if (!isoDate(r.read_on)) bad.push(`${w}: read_on not ISO`);
    if (!(r.date_on_page === null || isoDate(r.date_on_page))) bad.push(`${w}: date_on_page must be ISO or null`);
    if (typeof r.expired !== 'boolean') bad.push(`${w}: expired must be boolean`);
    if (!Array.isArray(r.figures)) bad.push(`${w}: figures array`);
    else {
      for (const f of r.figures) {
        if (typeof f.label !== 'string' || !f.label) bad.push(`${w}: figure label`);
        if (typeof f.amount !== 'number' || !Number.isFinite(f.amount)) bad.push(`${w}: figure amount`);
        const money = typeof f.currency === 'string' && /^[A-Z]{3}$/.test(f.currency);
        if (!money && !(f.currency === null && f.unit === 'days')) bad.push(`${w}: figure currency (ISO code, or null with unit days)`);
      }
      if (r.confidence !== 'not-confirmed' && r.figures.length === 0) bad.push(`${w}: a confirmed entry needs a figure`);
    }
    if (r.expired === true && !(typeof r.period === 'string' && r.period)) bad.push(`${w}: expired entry must record its period`);
  }
  return bad;
}
test('the real rules file passes the schema', () => {
  const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.deepEqual(checkRules(doc), []);
  assert.equal(doc.rules.every((r) => r.read_on === '2026-11-17'), true);
});
test('the schema check fires on each kind of fault', () => {
  const good = () => ({ rules: [{ id: 'a', label: 'l', body: 'b', address: 'https://x.go.tz/p', figures: [{ label: 'f', amount: 1, currency: 'USD' }], read_on: '2026-11-17', date_on_page: null, confidence: 'official-page', expired: false }] });
  assert.deepEqual(checkRules(good()), []);
  const mut = (fn) => { const d = good(); fn(d.rules[0]); return checkRules(d); };
  assert.ok(mut((r) => { r.confidence = 'official'; }).some((m) => /confidence/.test(m)));
  assert.ok(mut((r) => { r.address = 'http://x.go.tz'; }).some((m) => /https/.test(m)));
  assert.ok(mut((r) => { r.read_on = '17/11/2026'; }).some((m) => /read_on/.test(m)));
  assert.ok(mut((r) => { r.read_on = '2026-02-31'; }).some((m) => /read_on/.test(m)));
  assert.ok(mut((r) => { r.date_on_page = 'Sep 2024'; }).some((m) => /date_on_page/.test(m)));
  assert.ok(mut((r) => { r.figures[0].currency = 'dollars'; }).some((m) => /currency/.test(m)));
  assert.ok(mut((r) => { delete r.id; }).some((m) => /id/.test(m)));
  assert.ok(mut((r) => { r.expired = true; }).some((m) => /period/.test(m)));
  assert.ok(mut((r) => { r.figures = []; }).some((m) => /needs a figure/.test(m)));
  assert.ok(checkRules({ rules: [] }).length > 0);
});
test('no third-party host appears as an address', () => {
  const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  for (const r of doc.rules) assert.doesNotMatch(r.address, /hellosafe|jaynevy|traveldojo|expedia|safarifind|serengetipark|thecitizen|tourismupdate/i);
});
