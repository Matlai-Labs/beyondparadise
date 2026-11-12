import { test } from 'node:test'; import assert from 'node:assert/strict';
import { claimGate, claimsIn } from './claim-gate.js';
const src = (host, n = 1) => ({ claim: 'x', source: `Site ${n}`, url: `https://${host}/p`, line: 'exact line quoted from the page' });
test('claimsIn finds numbers and place/direction claims, ignores hashtags and links', () => {
  assert.deepEqual(claimsIn('358 rooms on Muyuni Beach').sort(), ['358', 'Muyuni'].sort());
  assert.deepEqual(claimsIn('See https://example.com/2026/x #Zanzibar2026 hello'), []);
  assert.ok(claimsIn('on the south-east coast').length >= 1);
});
test('draft with a number or location claim and no recorded sources is refused', () => {
  assert.match(claimGate({ id: 'B1', text: 'A 358-room resort on Muyuni Beach' }), /no recorded source/);
});
test('one source is not enough; two sources on different hosts pass', () => {
  const t = 'A resort on Muyuni Beach';
  assert.match(claimGate({ text: t, claimSources: [src('a.com')] }), /2 independent/);
  assert.match(claimGate({ text: t, claimSources: [src('a.com'), src('a.com', 2)] }), /2 independent/);
  assert.equal(claimGate({ text: t, claimSources: [src('a.com'), src('b.com')] }), null);
});
test('a source entry without url or exact line does not count', () => {
  assert.match(claimGate({ text: 'Muyuni', claimSources: [src('a.com'), { source: 'b', url: 'https://b.com' }] }), /2 independent/);
});
test('draft with no numeric or location claim needs no sources', () => {
  assert.equal(claimGate({ text: 'We score a lodge only after a paid stay of our own.' }), null);
});
