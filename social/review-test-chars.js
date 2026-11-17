// One list of test characters for the edit box, used by the server test (bpa-actions.test.js) AND the page test (review-page.test.js),
// so the page and the server cannot drift. Not a test file itself. Every entry is a one-character string given by code point.
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => String.fromCodePoint(a + i));
const pts = (...cps) => cps.map((c) => String.fromCodePoint(c));
/** Line breaks: the server answers bad-request for these (a different, earlier rule); the page refuses them too. */
export const LINEBREAK_CHARS = pts(0x0A, 0x0D, 0x85, 0x2028, 0x2029);
/** Refused with bad-characters. Categories: Cc, Cf, Co, Cn, Zl/Zp (above), every Zs but the plain space, variation selectors, fillers. */
export const BAD_CHARS = [
  ...range(0x00, 0x09), ...range(0x0B, 0x0C), ...range(0x0E, 0x1F), ...pts(0x7F), ...range(0x80, 0x9F).filter((c) => c !== '\u0085'), // Cc
  ...pts(0xAD, 0x061C, 0x0600, 0x070F, 0x180E, 0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0xFEFF, 0x110BD), // Cf
  ...range(0xE0000, 0xE007F), // tag characters (Cf and Cn)
  ...pts(0xE000, 0xF8FF, 0xF0000), // Co, private use
  ...pts(0x0378, 0x2065, 0xFFFE, 0xE0080), // Cn, unassigned
  ...pts(0x00A0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x202F, 0x205F, 0x3000), // Zs but not U+0020
  ...range(0xFE00, 0xFE0F), ...range(0xE0100, 0xE01EF), // variation selectors
  ...pts(0x034F, 0x115F, 0x1160, 0x2800, 0x3164, 0xFFA0), // fillers that draw nothing
];
/** Ordinary text that must still pass: plain space, accents in composed form, a German umlaut, digits, normal punctuation, a curly apostrophe. */
export const GOOD_TEXTS = [
  'Lions sleep up to 20 hours a day',
  'Café naïve à la carte',
  'Größe Männer über den Flüssen',
  'It’s the lion’s share: 3, 4 or 5.',
  '“Quoted” text – with a dash; (brackets) and a question?',
];

/** Emoji that must pass the draft rule: a pictograph followed by the emoji selector U+FE0F (a red heart, a warning sign). */
export const EMOJI_OK_TEXTS = ['Love it \u2764\uFE0F', '\u26A0\uFE0F Check the ferry times', 'Sun \u2600\uFE0F and sea \u{1F30A}'];
/** Still refused for a draft: a selector after a letter or at the start, a lone selector, and a zero width joiner sequence (U+200D is a format character; stated limitation). */
export const EMOJI_BAD_TEXTS = ['a\uFE0Fb', '\uFE0Fstart', 'lone \uFE0F selector', '\u{1F469}\u200D\u{1F469}'];
