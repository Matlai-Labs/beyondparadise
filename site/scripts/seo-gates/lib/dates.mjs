import { stripAccents } from './text.mjs';

// month tokens (accent-stripped, lowercase) -> 1..12, for en/de/fr/it/es/pl
const MONTHS = {
  1: 'january jan januar janvier janv gennaio gen enero ene stycznia styczen',
  2: 'february feb februar fevrier fevr febbraio febrero febr lutego luty',
  3: 'march mar marz mars marzo marca marzec',
  4: 'april apr avril aprile abril kwietnia kwiecien',
  5: 'may mai maggio mayo maja maj',
  6: 'june jun juni juin giugno junio czerwca czerwiec',
  7: 'july jul juli juillet juil luglio julio lipca lipiec',
  8: 'august aug agosto aout sierpnia sierpien',
  9: 'september sep sept septembre settembre septiembre setiembre wrzesnia wrzesien',
  10: 'october oct okt oktober octobre ottobre octubre pazdziernika pazdziernik',
  11: 'november nov novembre noviembre listopada listopad',
  12: 'december dec dez dezember decembre dic dicembre diciembre grudnia grudzien',
};
const MONTH_MAP = {};
for (const [n, list] of Object.entries(MONTHS)) for (const w of list.split(' ')) MONTH_MAP[w] = +n;
const MONTH_ALT = Object.keys(MONTH_MAP).sort((a, b) => b.length - a.length).join('|');

const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
export const toDate = (s) => (s instanceof Date ? s : new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00Z' : s));
export const iso = (d) => d.toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.floor((toDate(b) - toDate(a)) / 86400000);

/**
 * Find dates in free text. Returns [{date:Date, precision:'day'|'month', index, text}].
 * Month-precision dates resolve to the LAST day of the month (so "June 2026" is never "past" during June 2026).
 */
export function parseDates(raw) {
  const text = stripAccents(raw.toLowerCase());
  const found = [];
  const add = (index, t, y, m, d, precision) => {
    if (m < 1 || m > 12 || y < 1990 || y > 2100) return;
    const day = precision === 'month' ? new Date(Date.UTC(y, m, 0)).getUTCDate() : d;
    if (day < 1 || day > 31) return;
    found.push({ date: utc(y, m, day), precision, index, text: raw.substr(index, t.length) });
  };
  let m;
  const iso_ = /\b(20\d\d)-(\d{2})-(\d{2})\b/g;
  while ((m = iso_.exec(text))) add(m.index, m[0], +m[1], +m[2], +m[3], 'day');
  const eu = /\b(\d{1,2})[./](\d{1,2})[./](20\d\d)\b/g;
  while ((m = eu.exec(text))) add(m.index, m[0], +m[3], +m[2], +m[1], 'day');
  // 1 July 2027 / 1st July 2027 / 1. Juli 2027 / 1er juillet 2027 / 1 de julio de 2027
  const dmy = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th|er|\\.)?\\s+(?:de\\s+|of\\s+)?(${MONTH_ALT})\\.?,?\\s+(?:de\\s+)?(20\\d\\d)\\b`, 'g');
  while ((m = dmy.exec(text))) add(m.index, m[0], +m[3], MONTH_MAP[m[2]], +m[1], 'day');
  // July 1, 2027
  const mdy = new RegExp(`\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d\\d)\\b`, 'g');
  while ((m = mdy.exec(text))) add(m.index, m[0], +m[3], MONTH_MAP[m[1]], +m[2], 'day');
  // July 2027 / juillet 2027 (month precision) — skip if already part of a day-precision hit
  const my = new RegExp(`\\b(${MONTH_ALT})\\.?\\s+(?:de\\s+)?(20\\d\\d)\\b`, 'g');
  while ((m = my.exec(text))) {
    if (found.some((f) => m.index >= f.index && m.index < f.index + f.text.length)) continue;
    add(m.index, m[0], +m[2], MONTH_MAP[m[1]], 1, 'month');
  }
  return found.sort((a, b) => a.index - b.index);
}
