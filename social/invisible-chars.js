// The ONE definition of the hidden-character rule, used by the hook edit (bpa-actions.js) and the draft edit.
// Refuses every control, format, private-use and unassigned character, line and paragraph separators, every space except the plain U+0020, variation selectors, and the fillers that draw nothing.
export const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}︀-️\u{E0100}-\u{E01EF}͏ᅟᅠ⠀ㅤﾠ]|(?! )\p{Zs}/u;
/** True when the text holds a hidden character. A line feed is allowed (drafts have lines) and so is U+FE0F directly after a pictograph (a red heart); a joiner (U+200D) sequence is still hidden: a stated limitation. */
export function hiddenCharsIn(text, { allowLf = true, allowEmojiSelector = true } = {}) {
  let t = String(text);
  if (allowLf) t = t.replace(/\n/g, '');
  if (allowEmojiSelector) t = t.replace(/(\p{Extended_Pictographic})\uFE0F/gu, '$1');
  return INVISIBLE.test(t);
}
