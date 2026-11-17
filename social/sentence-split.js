// The one sentence splitter (caption.js, carousel.js, video.js, judge.js used to carry four copies, and a full stop after "No." cut "Government Notice No. 256 of 2026" in two).
// JUDGE SAFETY comes first: the judge asks one question per sentence, so a wrongly SPLIT sentence is judged on its own (at worst refused) while a wrongly MERGED one can let an
// unsupported sentence pass behind a supported one. When in doubt: split. Decimals ("70.80") have no space after the dot and are never touched. A border is . ! ? plus white space, EXCEPT after a full stop when:
//  - the next word starts lowercase ("approx. 3 km"-style, "e.g. the north", "a.m. and"), or
//  - the word before is a title or abbreviation that takes a name or a lowercase word (Dr. Mr. Mrs. Ms. Prof. Mt. vs. approx. e.g. i.e.), or "St." (see below), or
//  - the next word starts with a digit or contains one ("No. 256", "No. ZNZ-44", "No. K5") or is "No." itself ("Ref. No. K5") AND the word before is a numbering abbreviation (no nos art fig ref est ca vol p pp tel approx st).
//    "Cost 50 USD. 30 children came." splits (USD is not an abbreviation), and so does "The answer was No. Zanzibar has" (no digit, plain capitalised word), or
//  - the word before is a lone capital initial ("J.") and the next word is NOT a plain capitalised word ("J. R. R." stays whole until the surname, which splits like "Ask J. Smith"; "Take Vitamin C. Zanzibar" and "Plan B. Zanzibar" split; "Ask J. Smith" splits too: undecidable, so split).
// "St." joins a following capitalised name ("St. Joseph's Cathedral") only when it is not a street suffix: if the word before it is a capitalised word that is not the first word of the sentence ("Main road is Kenyatta St. Guests park") it splits.
// Known limit: "Kenyatta St. Guests park" (street name as the very first words) is merged.
const TITLE = /^(dr|mr|mrs|ms|prof|mt|vs|approx|e\.g|i\.e)\.$/i;
const NUMBERING = /^(no|nos|art|fig|ref|est|ca|vol|p|pp|tel|approx|st)\.$/i;
const OPEN = /^[("'“‘[]+/;
const plainCapital = (w) => /^[A-Z][a-z'’]+[,;:.!?)]*$/.test(w);
export function splitSentences(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const piece of text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean)) {
    const prev = out.at(-1); const ws = prev ? prev.split(' ') : []; const tok = (ws.at(-1) || '').replace(OPEN, ''); const next = piece.split(' ')[0].replace(OPEN, '');
    let joins = false;
    if (prev && prev.endsWith('.')) {
      if (/^[a-z]/.test(piece) || TITLE.test(tok)) joins = true;
      else if (NUMBERING.test(tok) && (/\d/.test(next) || /^nos?\.$/i.test(next))) joins = true; // "Ref. No. K5": the first stop is followed by "No."
      else if (/^[A-Z]\.$/.test(tok)) joins = !plainCapital(next);
      else if (/^st\.$/i.test(tok)) { const before = ws.at(-2) || ''; joins = /^[A-Z]/.test(next) && !(ws.length > 2 && /^[A-Z]/.test(before)); }
    }
    if (joins) out[out.length - 1] = `${prev} ${piece}`; else out.push(piece);
  }
  return out;
}
