import { test } from 'node:test'; import assert from 'node:assert/strict';
import { chooseFormat, igPostDraftAny, CONFIG } from './lib.js';
import { planCarousel } from './carousel.js';

const ig = (o) => ({ instagram: { format: 'reel', ...o } });
test('chooseFormat: per-kind override wins, else instagram.format, unknown values are ignored', () => {
  const cfg = ig({ formatByKind: { signal: 'carousel', outlook: 'reel' } });
  assert.equal(chooseFormat({ kind: 'signal' }, cfg), 'carousel');
  assert.equal(chooseFormat({ kind: 'outlook' }, cfg), 'reel');
  assert.equal(chooseFormat({ kind: 'other' }, cfg), 'reel');
  assert.equal(chooseFormat({ kind: 'signal' }, ig({ formatByKind: { signal: 'bogus' } })), 'reel');
  assert.equal(chooseFormat({ kind: 'signal' }, { instagram: {} }), 'image');
  assert.equal(chooseFormat({ kind: 'signal' }, ig({})), 'reel');
});
test('shipped config follows the policy: signal drafts carousel, outlook drafts reel, default reel', () => {
  assert.equal(CONFIG.instagram.format, 'reel');
  assert.equal(chooseFormat({ kind: 'signal' }), 'carousel');
  assert.equal(chooseFormat({ kind: 'outlook' }), 'reel');
});
test('thin carousel plan is flagged tooLittle (so the caller may fall back to a reel); gate rejections are not', async () => {
  const thin = await planCarousel({ id: 'x', kind: 'outlook', text: 'Only a title — 1 May 2026' }, { voice: async () => ({ ok: true }) });
  assert.equal(thin.tooLittle, true);
  const gate = await planCarousel({ id: 'y', kind: 'signal', sourceCount: 1, text: 'T — 1 May\n\nWhat changed: a. b. c.' }, { voice: async () => ({ ok: true }) });
  assert.match(gate.rejected, /sources/); assert.equal(gate.tooLittle, undefined);
});
test('igPostDraftAny: gate-blocked signal carousel throws and never falls back to a reel', async () => {
  const d = { id: 'Z', kind: 'signal', sourceCount: 1, sourceDate: '2026-01-01', text: 'T — 1 May\n\nWhat changed: a. b. c.' };
  await assert.rejects(igPostDraftAny(d), /carousel blocked: .*sources/);
});
