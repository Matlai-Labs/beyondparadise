import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { INVISIBLE, hiddenCharsIn } from './invisible-chars.js';
import { BAD_CHARS, GOOD_TEXTS, EMOJI_OK_TEXTS, EMOJI_BAD_TEXTS } from './review-test-chars.js';
test('every character of BAD_CHARS is hidden (a lone U+FE0F follows nothing, so it is hidden too)', () => { for (const c of BAD_CHARS) assert.equal(hiddenCharsIn(c), true, 'U+' + c.codePointAt(0).toString(16)); });
test('line feed is allowed; CR, U+0085, U+2028 and U+2029 are hidden', () => {
  assert.equal(hiddenCharsIn('one\ntwo\n\nthree'), false); assert.equal(hiddenCharsIn('one\ntwo', { allowLf: false }), true);
  for (const c of ['\r', '\u0085', '\u2028', '\u2029']) assert.equal(hiddenCharsIn('a' + c + 'b'), true);
});
test('a red heart with its emoji selector is allowed; a letter followed by the selector, a selector at the start and a lone selector are hidden', () => {
  assert.equal(hiddenCharsIn('\u2764\uFE0F'), false); assert.equal(hiddenCharsIn('\u2764\uFE0F', { allowEmojiSelector: false }), true);
  assert.equal(hiddenCharsIn('a\uFE0F'), true); assert.equal(hiddenCharsIn('\uFE0Fa'), true); assert.equal(hiddenCharsIn('\uFE0F'), true);
});
test('stated limitation: a zero width joiner emoji sequence is still hidden (U+200D is a format character)', () => { assert.equal(hiddenCharsIn('\u{1F469}\u200D\u{1F469}'), true); });
test('ordinary texts pass; the emoji lists behave as named', () => {
  for (const t of GOOD_TEXTS) assert.equal(hiddenCharsIn(t), false, t); for (const t of EMOJI_OK_TEXTS) assert.equal(hiddenCharsIn(t), false, t); for (const t of EMOJI_BAD_TEXTS) assert.equal(hiddenCharsIn(t), true, t);
});
test('INVISIBLE is the one regex bpa-actions.js uses', async () => { assert.ok(INVISIBLE instanceof RegExp); const src = (await import('node:fs')).readFileSync(new URL('./bpa-actions.js', import.meta.url), 'utf8'); assert.match(src, /import \{ INVISIBLE \} from '\.\/invisible-chars\.js'/); assert.ok(!/const INVISIBLE =/.test(src)); });
