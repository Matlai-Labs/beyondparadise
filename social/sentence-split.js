// The one sentence splitter (caption.js, carousel.js, video.js, judge.js used to carry four copies, and a full stop after "No." cut "Government Notice No. 256 of 2026" in two).
// A border is . ! ? plus white space, EXCEPT after a full stop when: the next word starts with a lowercase letter or a digit ("approx. 3 km", "e.g. the north", "a.m. to"),
// or the word before it is a title or abbreviation that takes a name after it (Dr. Mr. Mrs. Ms. Prof. St. Mt. vs. approx. e.g. i.e.), or a single capital initial (J.),
// "No. 256", "Art. 5", "Fig. 2" stay whole because a digit follows; "Answer: No. Zanzibar has" still splits (No is deliberately not in the always list).
// Two real sentences, and one that ends on a number ("costs 50 USD. Children pay 25 USD."), still split. Decimals ("70.80") have no space after the dot and are never touched.
const ALWAYS = /^(dr|mr|mrs|ms|prof|st|mt|vs|approx|e\.g|i\.e)\.$/i;
const OPEN = /^[("'“‘[]+/;
export function splitSentences(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const piece of text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean)) {
    const prev = out.at(-1); const tok = prev ? prev.split(' ').at(-1).replace(OPEN, '') : '';
    const joins = prev && prev.endsWith('.') && (/^[a-z0-9]/.test(piece) || ALWAYS.test(tok) || /^[A-Z]\.$/.test(tok));
    if (joins) out[out.length - 1] = `${prev} ${piece}`; else out.push(piece);
  }
  return out;
}
