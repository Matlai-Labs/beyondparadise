import { parseDates, toDate } from './dates.mjs';
import { wordRe } from './text.mjs';
import { STARTS_VERBS, FUTURE_TENSE, RATE_WORDS } from './lang.mjs';

const yearOf = (today) => toDate(today).getUTCFullYear();
const RATE_RE = wordRe(RATE_WORDS);
const FUTURE_RE = wordRe(FUTURE_TENSE);
const STARTS_RE = wordRe(STARTS_VERBS);

/**
 * Past-period findings for ONE sentence.
 *  past-period            season range ("2024/25", "2023-24") whose end year is before today's year
 *  stale-rate-year        a bare year < today's year in a sentence about rates/fees/prices (warn)
 *  past-year-future-tense a bare year < today's year with future-tense wording (error)
 *  past-start-date        "starts on <date>" where the date is already past (warn)
 */
export function findPastPeriods(sentence, today) {
  const ty = yearOf(today); const out = [];
  const seasonRe = /(?<![\d-])((?:19|20)\d\d)\s*[\/–-]\s*(\d{2}|(?:19|20)\d\d)(?![\d-])/g;
  let m; const covered = [];
  while ((m = seasonRe.exec(sentence))) {
    const a = +m[1]; const b = m[2].length === 2 ? +m[2] : +m[2] % 100;
    if ((a + 1) % 100 !== b || a < ty - 8) continue; // not a consecutive-season range (also kills ISO "2026-10")
    covered.push([m.index, m.index + m[0].length]);
    if (a + 1 < ty) out.push({ rule: 'past-period', severity: 'warn', excerpt: m[0], message: `period ${m[0]} ended before ${ty}` });
  }
  const inCovered = (i) => covered.some(([s, e]) => i >= s && i < e);
  const dates = parseDates(sentence);
  const isDatePart = (i) => dates.some((d) => i >= d.index && i < d.index + d.text.length);
  const yearRe = /(?<![\d./-])(19\d\d|20\d\d)(?![\d]|[./-]\d|\s*\/\s*\d)/g;
  while ((m = yearRe.exec(sentence))) {
    const y = +m[1];
    if (y >= ty || y < ty - 5 || inCovered(m.index)) continue;
    if (isDatePart(m.index)) continue; // dates are judged by the start-date rule
    if (FUTURE_RE.test(sentence)) out.push({ rule: 'past-year-future-tense', severity: 'error', excerpt: m[1], message: `${y} is in the past but the sentence uses future wording` });
    else if (RATE_RE.test(sentence) && y >= ty - 4) out.push({ rule: 'stale-rate-year', severity: 'warn', excerpt: m[1], message: `rates/fees sentence cites ${y}` });
  }
  const startG = new RegExp(STARTS_RE.source, 'giu');
  while ((m = startG.exec(sentence))) {
    const end = m.index + m[0].length;
    // the date must follow the start verb closely ("starts on 1 July 2025"), not merely appear in the same sentence
    for (const d of dates.filter((x) => x.index >= end && x.index - end <= 40)) {
      if (d.date < toDate(today)) out.push({ rule: 'past-start-date', severity: 'warn', excerpt: d.text, message: `start date ${d.text} has already passed` });
    }
  }
  return out;
}
