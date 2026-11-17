import './test-env.js';
// A: the verbatim draft. No model: hook = the idea's title cut cleanly, body = the claim sentences byte for byte, then the lines code adds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verbatimDraft, hookFrom, HOOK_MAX, CLAIM_MAX, CLAIMS_MAX, ALT_PREFIX } from './fact-post.js';
import { sourceLine, hashtagsFor, FIXED_LINES, assembleParts } from './caption.js';

const NOW = new Date('2026-11-17T09:00:00Z');
const claim = (text, extra = {}) => ({ text, factId: 'f1', sourceDate: '2026-10-01', ...extra });
const idea = (over = {}) => ({ id: 'idea_abc', sourceId: 'fact:f1', kind: 'fact', topic: 'wildebeest-migration', title: 'Wildebeest cross the Mara river from July', claims: [claim('About 1.5 million wildebeest follow the rains through the Serengeti each year.')], link: '/wildlife/migration/', ...over });

test('limits are the briefed ones', () => { assert.deepEqual([HOOK_MAX, CLAIM_MAX, CLAIMS_MAX], [60, 240, 3]); });

test('the text contains every claim sentence byte for byte and carries claims, ideaId, lane and writer', () => {
  const i = idea({ claims: [claim('First sentence, with a comma: 12,500 units.'), claim('Second one  keeps  its  double  spaces.', { factId: 'f2' })] });
  const r = verbatimDraft(i, { now: NOW }); assert.equal(r.ok, true);
  for (const c of i.claims) assert.ok(r.draft.text.split('\n').includes(c.text), c.text);
  assert.deepEqual(r.draft.claims, i.claims); assert.equal(r.draft.ideaId, 'idea_abc'); assert.equal(r.draft.lane, 'auto'); assert.equal(r.draft.writer, 'verbatim');
  assert.equal(r.draft.sourceId, 'fact:f1'); assert.equal(r.draft.createdAt, NOW.toISOString());
});

test('nothing else but hook, claims and the lines code adds: the text is rebuilt from those parts', () => {
  for (const link of ['/wildlife/migration/', null, 'https://example.invalid/x']) {
    const i = idea({ link }); const r = verbatimDraft(i, { now: NOW }); assert.equal(r.ok, true);
    const codeLines = [sourceLine(i.claims)]; if (typeof link === 'string' && link.startsWith('/')) codeLines.push(FIXED_LINES.pointer);
    const rebuilt = [r.draft.hook, '', ...i.claims.map((c) => c.text), ...codeLines, '', hashtagsFor(i).join(' ')].join('\n');
    assert.equal(r.draft.text, rebuilt);
  }
});
test('the code-added lines are the very ones caption.js adds (same functions, not a copy)', () => {
  const i = idea(); const a = assembleParts(i, { hook: 'H', caption: 'One sentence.' }); const r = verbatimDraft(i, { now: NOW });
  const mine = r.draft.text.split('\n'); const theirs = a.text.split('\n');
  assert.deepEqual(mine.slice(-4), theirs.slice(-4)); // source, pointer, blank, tags
});

test('hook: a short title is used as it is; a long one is cut at a word boundary to at most 60 characters, no ellipsis', () => {
  assert.equal(hookFrom('Wildebeest cross the Mara river from July').hook, 'Wildebeest cross the Mara river from July');
  const h = hookFrom('Tourists need a valid passport and a visa before they arrive in the country'); assert.equal(h.ok, true);
  assert.ok([...h.hook].length <= 60); assert.ok(!/…|\.\.\./.test(h.hook)); assert.ok('Tourists need a valid passport and a visa before they arrive in the country'.startsWith(h.hook));
  assert.equal(h.hook, 'Tourists need a valid passport and a visa before they arrive'); // "in the country" does not fit; no dangling "in"
});
test('hook: a cut between two capitalised words (a name) is refused with title-too-long', () => {
  assert.deepEqual(hookFrom('Cost of a day permit to enter Ngorongoro Conservation Area Authority Gate Number 12'), { ok: false, reason: 'title-too-long' }); // cut falls between "Conservation" and "Area"
  assert.deepEqual(hookFrom('Entry requirements: Serengeti National Park Authority Visitor Information Page'), { ok: false, reason: 'title-too-long' });
});
test('hook: a cut between two numeric words, or before a bare symbol, is refused; one word longer than 60 is refused', () => {
  assert.deepEqual(hookFrom('Fee 1 200 TZS 2 500 TZS 3 800 TZS 4 100 TZS 5 000 TZS 6 100 TZS 7 000 TZS'), { ok: false, reason: 'title-too-long' });
  assert.deepEqual(hookFrom('Daily permit fee is listed as higher by about this much: 50 % for the non residents'), { ok: false, reason: 'title-too-long' });
  assert.deepEqual(hookFrom('A'.repeat(70)), { ok: false, reason: 'title-too-long' });
});
test('hook: a cut before a lower-case word is clean; the number before the cut stays whole', () => {
  assert.deepEqual(hookFrom('Fees at the gate are listed as USD 50,000 TZS per person for non residents'), { ok: true, hook: 'Fees at the gate are listed as USD 50,000 TZS per person' });
  assert.deepEqual(hookFrom('Park fees, in total, are listed for adults on the gate as TZS 50,000 per person'), { ok: true, hook: 'Park fees, in total, are listed for adults on the gate' });
});
test('hook: a title with an ellipsis inside the first 60 characters is refused', () => {
  assert.deepEqual(hookFrom('Wildebeest … and more of them every single year in the long rains season'), { ok: false, reason: 'title-too-long' });
});
test('hook: a bracket left open by the cut is never shown', () => {
  assert.deepEqual(hookFrom('Park entry for citizens of the member states of the community (EAC partner states only)'), { ok: true, hook: 'Park entry for citizens of the member states' });
  assert.deepEqual(hookFrom('Park entry for citizens of the member states of the community (EAC partner states) only'), { ok: true, hook: 'Park entry for citizens of the member states' });
});

test('refusals: title-too-long, claim-too-long (never shortened), claim-multiline, no claims, no title', () => {
  assert.deepEqual(verbatimDraft(idea({ title: 'B'.repeat(80) }), { now: NOW }), { ok: false, draft: null, reason: 'title-too-long' });
  const long = 'x'.repeat(CLAIM_MAX + 1); assert.deepEqual(verbatimDraft(idea({ claims: [claim(long)] }), { now: NOW }), { ok: false, draft: null, reason: 'claim-too-long' });
  assert.equal(verbatimDraft(idea({ claims: [claim('x'.repeat(CLAIM_MAX))] }), { now: NOW }).ok, true); // exactly 240 is allowed
  assert.equal(verbatimDraft(idea({ claims: [claim('Two\nlines.')] }), { now: NOW }).reason, 'claim-multiline');
  assert.equal(verbatimDraft(idea({ claims: [] }), { now: NOW }).reason, 'idea-has-no-claims');
  assert.equal(verbatimDraft(idea({ claims: [claim('  ')] }), { now: NOW }).reason, 'idea-has-no-claims');
  assert.equal(verbatimDraft(idea({ title: '  ' }), { now: NOW }).reason, 'title-missing');
  assert.equal(verbatimDraft(null, { now: NOW }).reason, 'idea-has-no-claims');
});
test('at most 3 claims are used; the draft carries exactly those', () => {
  const claims = [1, 2, 3, 4].map((n) => claim(`Claim number ${n}.`, { factId: `f${n}` })); const r = verbatimDraft(idea({ claims }), { now: NOW });
  assert.equal(r.draft.claims.length, 3); assert.ok(!r.draft.text.includes('Claim number 4.'));
});
test('alt text is built by code from the hook, the clip label is not used', () => {
  const r = verbatimDraft(idea(), { now: NOW }); assert.equal(r.draft.altText, `${ALT_PREFIX}${r.draft.hook}`);
  assert.equal(ALT_PREFIX, 'Short video of East African landscape or wildlife with the text: ');
  assert.equal(r.draft.videoText, r.draft.hook); // the final check sees the on-video text too
});
