import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { claimGate, claimGateWhy, sourcesRecord } from './claim-gate.js';
const src = (host, n = 1) => ({ claim: 'x', source: `Site ${n}`, url: `https://${host}/p`, line: 'exact line quoted from the page' });
const rec = (text, list) => ({ text, ...sourcesRecord(text, list) });
const T = 'A resort on Muyuni Beach';
// each situation: the code, and the WhatsApp text stays exactly the message
const same = (d, code, message) => {
  const w = claimGateWhy(d); assert.equal(w.code, code); assert.equal(typeof w.message, 'string');
  if (message instanceof RegExp) assert.match(w.message, message); else assert.equal(w.message, message);
  assert.equal(claimGate(d), w.message, 'claimGate answers exactly the message');
};
test('why 1: no text or blank text', () => {
  for (const d of [null, {}, { text: '' }, { text: '   ' }, { text: 5 }]) same(d, 'text-missing', 'draft text is missing or blank; nothing to approve');
});
test('why 2: claims and no valid source entry', () => {
  same({ text: T }, 'sources-missing', /^no recorded source line for claims \(/);
  same({ text: T, claimSources: [{ claim: '' }] }, 'sources-missing', /^no recorded source line for claims \(/);
});
test('why 3: sources recorded without a hash', () => {
  const d = rec(T, [src('a.com'), src('b.org', 2)]); delete d.claimSourcesHash;
  same(d, 'sources-old', 'sources were recorded the old way (no text hash); record the sources again with record-claim-sources.js');
});
test('why 4: the text changed after the sources were recorded', () => {
  const d = rec(T, [src('a.com'), src('b.org', 2)]); d.text = 'A resort on Paje Beach';
  same(d, 'sources-outdated', 'the text changed after the sources were recorded; record the sources again');
});
test('why 5: fewer than two sites', () => {
  same(rec(T, [src('a.com'), src('www.a.com', 2)]), 'sources-too-few', 'claims need 2 independent recorded sources on different sites');
});
test('why 6: no claims, or good sources: null both ways', () => {
  const none = { text: 'Lions sleep most of the day.' }; assert.equal(claimGateWhy(none), null); assert.equal(claimGate(none), null);
  const ok = rec(T, [src('a.com'), src('b.org', 2)]); assert.equal(claimGateWhy(ok), null); assert.equal(claimGate(ok), null);
});
