#!/usr/bin/env node
// CLAIM CLOCK — time-bound-claim sentinel. Registry (claims.json) + scanner + "what flips today" report.
// Born from 3 incidents: UK ads said Air Tanzania flies Gatwick non-stop (starts 1 Jul 2027); a Compass post listed British Airways
// (starts 29 May 2027); WildToSea cited "2024/25" fees and a poller checked a 2023/24 PDF.
// Usage: node claim-clock.mjs <dir|file>... [--claims claims.json] [--today 2026-10-08] [--flips] [--json] [--strict]
// Exit: 0 no errors, 1 errors (or any finding with --strict), 2 usage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expand, parseArgs, readJson, isMain } from './lib/fs.mjs';
import { maskTags, splitSentences, wordRe } from './lib/text.mjs';
import { parseDates, toDate, iso } from './lib/dates.mjs';
import { findPastPeriods } from './lib/periods.mjs';

const EXTS = ['.md', '.mdx', '.json', '.html', '.htm', '.astro', '.txt'];
const MAX_BYTES = 3_000_000;

// Present-tense / "is operating" wording, en de fr it es pl. (`\p{L}*` = any word ending.)
const OPERATING = wordRe([
  'fl(?:y|ies|ying|ew)', 'operat(?:es|ing|ed by)', 'non-?stop', 'direct flights?', 'fly direct', 'common airlines?', 'served by', 'serves', 'flights? (?:from|to|with)', 'flies direct', 'airlines? (?:serving|flying|to)', 'carriers?', 'airlines?', 'fluggesellschaften', 'compagnies? aériennes?', 'compagnie aeree', 'aerolíneas', 'linie lotnicze', 'przewoźnik\\p{L}*', 'top choices include', 'options include', 'airlines? (?:include|such as)', 'fly(?:ing)? with', 'book with',
  'fliegt', 'fliegen', 'bedient', 'direktflug\\p{L}*', 'direkt(?:flüge)?', 'ohne zwischenlandung', 'nonstop',
  'vole', 'volent', 'dessert', 'exploite', 'vols? directs?', 'sans escale', 'en direct',
  'vola', 'volano', 'opera', 'collega', 'voli? dirett\\p{L}*', 'senza scalo',
  'vuela', 'vuelan', 'vuelos? directos?', 'sin escalas', 'compañías aéreas',
  'lata', 'latają', 'obsługuje', 'bezpośredni\\p{L}*', 'loty? bezpośredni\\p{L}*', 'bez przesiadek', 'linie lotnicze',
]);
// "this is in the future" wording
const HEDGE = wordRe([
  'will', 'planned', 'plans?', 'planning', 'announced', 'announces', 'starting', 'starts?', 'begins?', 'beginning', 'launch(?:es|ing)?', 'expected', 'set to', 'scheduled', 'upcoming', 'inaugural', 'new route', 'from next', 'coming', 'proposed', 'intends?',
  'wird', 'werden', 'ab dem', 'geplant', 'angekündigt', 'startet', 'beginnt', 'neu ab', 'künftig',
  'sera', 'seront', 'à partir du', 'dès', 'prévu\\p{L}*', 'annoncé\\p{L}*', 'débute', 'commence', 'bientôt',
  'sarà', 'saranno', 'dal', 'a partire dal', 'previst\\p{L}*', 'annunciat\\p{L}*', 'inizia',
  'será', 'serán', 'a partir del', 'desde el', 'previst\\p{L}*', 'anunciad\\p{L}*', 'comienza', 'empieza',
  'będzie', 'będą', 'od dnia', 'planowan\\p{L}*', 'ogłoszon\\p{L}*', 'rozpocznie', 'startuje',
]);
const PAST = wordRe(['used to', 'until', 'was', 'were', 'former(?:ly)?', 'ended', 'discontinued', 'no longer', 'suspended', 'bis', 'früher', 'ehemals', "jusqu'à", 'anciennement', 'fino al', 'ex', 'hasta', 'antes', 'do dnia', 'dawniej']);
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s/;

export function loadClaims(file) {
  const j = readJson(file);
  return j.claims.map((c) => ({
    ...c,
    _subject: (c.match?.subject || []).map((r) => new RegExp(r, 'iu')),
    _object: (c.match?.object || []).map((r) => new RegExp(r, 'iu')),
  }));
}
const compile = (c) => (c._subject ? c : { ...c, _subject: (c.match?.subject || []).map((r) => new RegExp(r, 'iu')), _object: (c.match?.object || []).map((r) => new RegExp(r, 'iu')) });

export function effectiveStatus(c, today) {
  const t = toDate(today);
  if (c.status === 'ended') return 'ended';
  if (c.valid_until && t > toDate(c.valid_until)) return 'ended';
  if (!c.valid_from) return 'unknown';
  if (t < toDate(c.valid_from)) return 'announced';
  return 'operating';
}

const fmtDate = (d) => toDate(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

function scanText(file, raw, claims, today) {
  const hits = [];
  const docText = raw;
  const isMarkup = /\.(html?|astro)$/i.test(file);
  const text = isMarkup ? maskTags(raw) : raw;
  const lines = text.split('\n');
  const add = (h) => { if (!hits.some((x) => x.line === h.line && x.claim === h.claim && x.rule === h.rule)) hits.push({ file, ...h }); };
  const periodLines = new Set();
  for (const s of splitSentences(text)) {
    const isFragment = LIST_ITEM.test(lines[s.line - 1] || '') || s.text.length < 60;
    const win = isFragment ? lines.slice(Math.max(0, s.line - 4), s.line - 1).join(' ') : '';
    const dates = parseDates(s.text);
    for (const c of claims) {
      if (!c._subject.some((r) => r.test(s.text))) continue;
      const scope = c.match?.object_scope;
      const objText = scope === 'document' ? docText : scope === 'window' ? s.text + ' ' + win : s.text;
      if (c._object.length && !c._object.some((r) => r.test(objText))) continue;
      const st = effectiveStatus(c, today);
      const base = { claim: c.id, sentence: s.text.slice(0, 220), line: s.line, suggestion: c.safe_wording, status: st };
      if (c.kind === 'period') {
        if (st === 'ended' && !PAST.test(s.text)) { add({ ...base, severity: 'warn', rule: 'stale-period', message: `${c.subject} ended ${c.valid_until}` }); periodLines.add(s.line); }
        continue;
      }
      // route claims
      const opWording = OPERATING.test(s.text) || (isFragment && OPERATING.test(win));
      const futureYear = [...s.text.matchAll(/\b(20\d\d)\b/g)].some((m) => c.valid_from && +m[1] >= toDate(c.valid_from).getUTCFullYear());
      const hedged = HEDGE.test(s.text) || (isFragment && HEDGE.test(win)) || futureYear || dates.some((d) => c.valid_from && d.date >= toDate(c.valid_from));
      if (st === 'unknown') { if (opWording) add({ ...base, severity: 'warn', rule: 'unverified-claim', message: `${c.subject}: ${c.predicate}` }); continue; }
      if (st === 'announced') {
        if (opWording && !hedged) add({ ...base, severity: 'error', rule: 'claim-not-operating', message: `${c.subject} (${c.predicate}) is NOT operating until ${c.valid_from}, but the copy states it as current` });
        else if (!dates.length && !futureYear) add({ ...base, severity: 'warn', rule: 'announced-undated', message: `${c.subject} is only announced (from ${c.valid_from}) - state the start date` });
      } else if (st === 'ended') {
        if (opWording && !PAST.test(s.text)) add({ ...base, severity: 'error', rule: 'claim-ended', message: `${c.subject} (${c.predicate}) ended ${c.valid_until || ''}` });
      }
    }
    // generic stale-period wording (rates/fees/etc.) not already covered by a registry period claim
    if (!periodLines.has(s.line)) {
      for (const f of findPastPeriods(s.text, today)) {
        if (f.rule === 'past-year-future-tense' || f.rule === 'past-start-date') continue; // stale-page.mjs owns those
        add({ claim: null, sentence: s.text.slice(0, 220), line: s.line, severity: 'warn', rule: 'stale-period', message: f.message, suggestion: 'Replace with the current period or remove the year.', status: 'ended' });
      }
    }
  }
  return hits;
}

export function scanPaths(paths, { claims, today }) {
  const cs = claims.map(compile); const out = [];
  for (const f of expand(paths, EXTS)) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (st.size > MAX_BYTES) continue;
    out.push(...scanText(f, fs.readFileSync(f, 'utf8'), cs, today));
  }
  return out;
}

export function flipReport(claims, today, { soonDays = 45 } = {}) {
  const t = toDate(today); const day = 86400000;
  const slim = (c) => ({ id: c.id, subject: c.subject, predicate: c.predicate, valid_from: c.valid_from, valid_until: c.valid_until, status: c.status });
  const nowOperating = claims.filter((c) => c.kind !== 'period' && c.status === 'announced' && c.valid_from && toDate(c.valid_from) <= t && !(c.valid_until && toDate(c.valid_until) < t)).map(slim);
  const nowEnded = claims.filter((c) => c.status !== 'ended' && c.valid_until && toDate(c.valid_until) < t).map(slim);
  const soon = claims.filter((c) => c.valid_from && toDate(c.valid_from) > t && toDate(c.valid_from) - t <= soonDays * day).map(slim);
  const endingSoon = claims.filter((c) => c.valid_until && toDate(c.valid_until) >= t && toDate(c.valid_until) - t <= soonDays * day).map(slim);
  const unverified = claims.filter((c) => c.verify).map(slim);
  return { today: iso(t), nowOperating, nowEnded, soon, endingSoon, unverified };
}

if (isMain(import.meta.url)) {
  const { positional, flags } = parseArgs(process.argv.slice(2), ['json', 'strict', 'flips']);
  const claimsFile = flags.claims || path.join(path.dirname(fileURLToPath(import.meta.url)), 'claims.json');
  const today = flags.today || iso(new Date());
  const claims = loadClaims(claimsFile);
  if (flags.flips) {
    const r = flipReport(claims, today);
    if (flags.json) console.log(JSON.stringify(r, null, 2));
    else {
      const sec = (title, l, msg) => { console.log(`\n${title} (${l.length})`); l.forEach((c) => console.log(`  - ${c.id}: ${c.subject} ${c.predicate} [${c.valid_from || '?'} -> ${c.valid_until || 'open'}] ${msg}`)); };
      console.log(`CLAIM CLOCK flip report for ${r.today}`);
      sec('NOW OPERATING - verify, set status=operating, update copy to present tense', r.nowOperating, '');
      sec('ENDED - remove or put in past tense', r.nowEnded, '');
      sec('FLIPS SOON (45d) - prepare copy', r.soon, '');
      sec('ENDING SOON (45d)', r.endingSoon, '');
      sec('UNVERIFIED - verify against the airline timetable', r.unverified, '');
    }
    if (!positional.length) process.exit(0);
  }
  if (!positional.length) { console.error('usage: claim-clock.mjs <dir|file>... [--claims f] [--today YYYY-MM-DD] [--flips] [--json] [--strict]'); process.exit(2); }
  const hits = scanPaths(positional, { claims, today });
  if (flags.json) console.log(JSON.stringify(hits, null, 2));
  else {
    for (const h of hits) console.log(`${h.severity.toUpperCase().padEnd(5)} ${h.file}:${h.line}  [${h.rule}] ${h.message}\n        «${h.sentence}»\n        suggest: ${h.suggestion}`);
    const e = hits.filter((x) => x.severity === 'error').length;
    const by = {}; for (const h of hits) by[h.rule] = (by[h.rule] || 0) + 1;
    console.log(`claim-clock (today ${today}): ${hits.length} findings, ${e} errors, ${hits.length - e} warnings ${JSON.stringify(by)}`);
  }
  process.exitCode = hits.some((x) => x.severity === 'error') || (flags.strict && hits.length) ? 1 : 0;
}
