import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { claimGate, claimsIn, textHash, registrableDomain, validateSources, sourcesRecord } from './claim-gate.js';
const src = (host, n = 1) => ({ claim: 'x', source: `Site ${n}`, url: `https://${host}/p`, line: 'exact line quoted from the page' });
// a draft whose sources were recorded properly for its current text
const rec = (text, list) => ({ text, ...sourcesRecord(text, list) });
test('claimsIn finds numbers and place/direction claims, ignores hashtags and links', () => {
  assert.deepEqual(claimsIn('358 rooms on Muyuni Beach').sort(), ['358', 'Muyuni'].sort());
  assert.deepEqual(claimsIn('See https://example.com/2026/x #Zanzibar2026 hello'), []);
  assert.ok(claimsIn('on the south-east coast').length >= 1);
});
test('claimsIn table: must-flag and must-pass', () => {
  const flag = ['20km from town', 'Leave at 9am', 'the 4th day', 'on 1st June', 'about 12.5 hours', 'ten thousand guests', 'Five stars',
    'a hundred rooms', 'two million tourists', 'fifteen percent off', 'Twenty minutes away', 'Unguja island', 'Jozani forest', 'Kiwengwa beach', 'Paje kite', 'Jambiani village',
    'Nungwi sunset', 'Kendwa party', 'Matemwe reef', 'Michamvi sunset', 'Bwejuu dunes', 'Stone Town walk', 'Pemba trip', 'Mafia island', 'Visit Zanzibar', 'zanzibar nights'];
  for (const s of flag) assert.ok(claimsIn(s).length >= 1, `should flag: ${s}`);
  const pass = ['We score a lodge only after a paid stay of our own.', 'Read more https://example.com/a/20km/9am #Zanzibar #Top10 #Paje2026', 'Honest notes, no fluff #Nungwi',
    'See https://stonetown.example/pemba-5-days now'];
  for (const s of pass) assert.deepEqual(claimsIn(s), [], `should pass: ${s}`);
});
test('registrableDomain compares last two labels, three for two-part suffixes', () => {
  assert.equal(registrableDomain('x.a.com'), 'a.com'); assert.equal(registrableDomain('a.com'), 'a.com');
  assert.equal(registrableDomain('www.bbc.co.uk'), 'bbc.co.uk'); assert.equal(registrableDomain('visit.example.co.tz'), 'example.co.tz'); assert.equal(registrableDomain('shop.example.com.au'), 'example.com.au'); assert.equal(registrableDomain('x.example.co.tz'), 'example.co.tz');
});
test('draft with a number or location claim and no recorded sources is refused', () => {
  assert.match(claimGate({ id: 'B1', text: 'A 358-room resort on Muyuni Beach' }), /no recorded source/);
});
test('one source is not enough; two sources on different sites pass', () => {
  const t = 'A resort on Muyuni Beach';
  assert.match(claimGate(rec(t, [src('a.com')])), /2 independent/);
  assert.match(claimGate(rec(t, [src('a.com'), src('a.com', 2)])), /2 independent/);
  assert.match(claimGate(rec(t, [src('a.com'), src('x.a.com', 2)])), /2 independent/);
  assert.equal(claimGate(rec(t, [src('a.com'), src('b.com')])), null);
});
test('B-H1: sources recorded for other text are refused (edit after record)', () => {
  const d = rec('A resort on Muyuni Beach', [src('a.com'), src('b.com')]);
  assert.equal(claimGate(d), null);
  assert.match(claimGate({ ...d, text: 'A 999-room resort on Muyuni Beach' }), /changed|record the sources again/i);
});
test('B-H1: missing hash (old-style record) is refused with record-again message', () => {
  const t = 'A resort on Muyuni Beach';
  assert.match(claimGate({ text: t, claimSources: [src('a.com'), src('b.com')] }), /record the sources again/);
  assert.match(claimGate({ text: t, claimSources: [src('a.com'), src('b.com')], claimSourcesHash: 'deadbeef' }), /record the sources again/);
});
test('B-H1: record validates list shape', () => {
  const t = 'Muyuni';
  const bad = [null, 'x', {}, [], [{ ...src('a.com'), claim: '' }], [{ ...src('a.com'), claim: '  ' }], [{ ...src('a.com'), line: '' }], [{ ...src('a.com'), source: undefined }],
    [{ ...src('a.com'), url: 'http://a.com/p' }], [{ ...src('a.com'), url: 'not a url' }], [{ ...src('a.com'), url: 'https://' }], [null]];
  for (const b of bad) { assert.ok(validateSources(b), `should reject ${JSON.stringify(b)}`); assert.throws(() => sourcesRecord(t, b)); }
  assert.equal(validateSources([src('a.com'), src('b.com')]), null);
  const r = sourcesRecord(t, [src('a.com'), src('b.com')]); assert.equal(r.claimSourcesHash, textHash(t)); assert.match(r.claimSourcesHash, /^[0-9a-f]{64}$/);
});
test('gate rejects malformed entries even if hash matches', () => {
  const t = 'Muyuni';
  const d = { text: t, claimSources: [src('a.com'), { ...src('b.com'), claim: '' }], claimSourcesHash: textHash(t) };
  assert.match(claimGate(d), /2 independent|invalid/);
});
test('B-M2: missing, non-string or blank text is refused', () => {
  for (const d of [{}, { text: undefined }, { text: null }, { text: 42 }, { text: {} }, { text: '' }, { text: '   \n' }]) assert.match(claimGate(d), /text/i);
  assert.match(claimGate(undefined), /text/i);
});
test('draft with no numeric or location claim needs no sources', () => {
  assert.equal(claimGate({ text: 'We score a lodge only after a paid stay of our own.' }), null);
});
