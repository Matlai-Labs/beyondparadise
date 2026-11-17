import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { splitSentences } from './sentence-split.js';
import { assembleParts } from './caption.js';

const CLAIM = 'From 1 October 2026 foreign visitors entering Mainland Tanzania (subject to exemptions) must hold inbound travel insurance from the National Insurance Corporation (NIC) or a partner insurer, under Government Notice No. 256 of 2026 dated 4 September 2026. Zanzibar has its own scheme (ZIC); a visitor whose first point of entry is the Mainland does not buy a second policy for Zanzibar, and vice versa.';
test('the real insurance claim: "Government Notice No. 256 of 2026" stays on one line, two sentences come out', () => {
  const s = splitSentences(CLAIM); assert.equal(s.length, 2); assert.match(s[0], /Government Notice No\. 256 of 2026 dated 4 September 2026\.$/); assert.match(s[1], /^Zanzibar has its own scheme/);
});
test('assembleParts (the caption) keeps it whole too', () => {
  const parts = assembleParts({ kind: 'fact', link: '/x', claims: [] }, { hook: 'Insurance for visitors', caption: CLAIM }); assert.equal(parts.sentences.length, 2); assert.ok(parts.sentences[0].includes('No. 256 of 2026'));
});
test('abbreviations, decimals, initials and lowercase continuations stay whole', () => {
  for (const t of ['The fee is 70.80 USD per person.', 'It is approx. 3 km from the gate.', 'Climb Mt. Kilimanjaro in January.', "We visited St. Joseph's church.", 'Go to e.g. the north coast.', 'Go to i.e. the south coast.', 'Tours start at 9 a.m. and end at 2 p.m. on most days.', 'See Dr. Smith about it.', 'Art. 5 applies here.', 'Notice No. 256 applies here.', "We visited St. Joseph's Cathedral today.", 'See St. Joseph for details.', 'Under Licence No. ZNZ-44 the fee applies.', 'Ref. No. K5 applies here.', 'Quote No. P-12 is valid.', 'Tours start at 9 a.m. and p.m. is for the evening.'])
    assert.deepEqual(splitSentences(t), [t], t);
});
test('two real sentences and a sentence ending on a number still split', () => {
  assert.deepEqual(splitSentences('The rule starts in 2026. Zanzibar has its own scheme.'), ['The rule starts in 2026.', 'Zanzibar has its own scheme.']);
  assert.deepEqual(splitSentences('A ticket costs 50 USD. Children pay 25 USD.'), ['A ticket costs 50 USD.', 'Children pay 25 USD.']);
  assert.deepEqual(splitSentences('Is it open? Yes! Come at 9.'), ['Is it open?', 'Yes!', 'Come at 9.']);
  assert.deepEqual(splitSentences('Answer: No. Zanzibar has its own scheme.'), ['Answer: No.', 'Zanzibar has its own scheme.']);
});
test('non-strings and blanks give an empty list', () => { assert.deepEqual(splitSentences(undefined), []); assert.deepEqual(splitSentences('  '), []); });
test('judge safety: when in doubt SPLIT, so a second sentence is never merged into a first', () => {
  assert.deepEqual(splitSentences('Take Vitamin C. Zanzibar has no malaria risk.'), ['Take Vitamin C.', 'Zanzibar has no malaria risk.']);
  assert.deepEqual(splitSentences('Plan B. Zanzibar is closer.'), ['Plan B.', 'Zanzibar is closer.']);
  assert.deepEqual(splitSentences('Cost 50 USD. 30 children came.'), ['Cost 50 USD.', '30 children came.']);
  assert.deepEqual(splitSentences('Main road is Kenyatta St. Guests park there.'), ['Main road is Kenyatta St.', 'Guests park there.']);
  assert.deepEqual(splitSentences('The answer was No. Zanzibar has its own scheme.'), ['The answer was No.', 'Zanzibar has its own scheme.']);
  assert.deepEqual(splitSentences('Ask J. Smith about it.'), ['Ask J.', 'Smith about it.']); // a lone initial before a plain name: undecidable, so split
});
test('"No." never ends a piece when a token with a digit follows; "Dr." never ends one at all', () => {
  for (const t of ['Under Licence No. ZNZ-44 the fee applies.', 'Ref. No. K5 applies.', 'Form No. P-12 applies.', 'Ask Dr. Smith.']) for (const piece of splitSentences(`${t} Next sentence here.`)) assert.ok(!/\b(No|Dr)\.$/.test(piece), piece);
});
