#!/usr/bin/env node
// stale-page: pages whose "last updated" signal is older than N days, and sentences about periods that are already over.
// Usage: node stale-page.mjs <dir|file>... [--today 2026-10-08] [--max-age 180] [--json]
// Exit: 0 no errors (warnings allowed), 1 errors (or any finding with --strict).
import path from 'node:path';
import fs from 'node:fs';
import { expand, parseArgs, isMain } from './lib/fs.mjs';
import { parseHtml } from './lib/html.mjs';
import { maskTags, splitSentences, wordRe } from './lib/text.mjs';
import { parseDates, daysBetween, iso, toDate } from './lib/dates.mjs';
import { findPastPeriods } from './lib/periods.mjs';
import { UPDATED_LABELS } from './lib/lang.mjs';

const LABEL_RE = new RegExp(`(?<![\\p{L}])(?:${UPDATED_LABELS.join('|')})\\s*[:\\-–]?\\s*([^\\n<]{0,40})`, 'giu');

function frontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { fm: {}, body: md, offset: 0 };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) { const k = line.match(/^([A-Za-z_]+)\s*:\s*(.*)$/); if (k) fm[k[1].toLowerCase()] = k[2].replace(/^["']|["']$/g, ''); }
  return { fm, body: md, offset: m[0].length };
}

/** Latest "last updated" signal in a document: {date, source} | null. */
function lastUpdated(doc) {
  const cands = [];
  if (doc.kind === 'md') {
    const { fm } = frontmatter(doc.content);
    for (const k of ['updated', 'lastmod', 'datemodified', 'modified', 'last_updated']) if (fm[k]) { const d = parseDates(fm[k])[0]?.date || (isNaN(toDate(fm[k])) ? null : toDate(fm[k])); if (d) cands.push({ date: d, source: 'frontmatter.' + k }); }
  } else {
    const info = parseHtml(doc.content);
    for (const s of info.ldDates) { const d = toDate(s); if (!isNaN(d)) cands.push({ date: d, source: 'dateModified' }); }
  }
  const text = doc.kind === 'html' ? maskTags(doc.content, { keepJsonLd: false }) : doc.content;
  for (const m of text.matchAll(LABEL_RE)) { const d = parseDates(m[1])[0]; if (d) cands.push({ date: d.date, source: 'visible label' }); }
  return cands.sort((a, b) => b.date - a.date)[0] || null;
}

export function analyzeDoc(doc, { today, maxAgeDays = 180 } = {}) {
  const out = [];
  const lu = lastUpdated(doc);
  if (lu && daysBetween(lu.date, today) > maxAgeDays) {
    out.push({ id: doc.id, line: 0, severity: 'warn', rule: 'stale-date', message: `last updated ${iso(lu.date)} (${daysBetween(lu.date, today)} days ago, via ${lu.source})`, excerpt: iso(lu.date) });
  }
  const body = doc.kind === 'html' ? maskTags(doc.content, { keepJsonLd: false }) : doc.content;
  for (const s of splitSentences(body)) {
    for (const f of findPastPeriods(s.text, today)) out.push({ id: doc.id, line: s.line, severity: f.severity, rule: f.rule, message: f.message, excerpt: f.excerpt, sentence: s.text.slice(0, 200) });
  }
  return out;
}

export function analyzeStale(paths, opts) {
  const out = [];
  for (const f of expand(paths, ['.html', '.htm', '.md', '.mdx'])) {
    const kind = /\.html?$/i.test(f) ? 'html' : 'md';
    out.push(...analyzeDoc({ id: f, kind, content: fs.readFileSync(f, 'utf8') }, opts));
  }
  return out;
}

if (isMain(import.meta.url)) {
  const { positional, flags } = parseArgs(process.argv.slice(2), ['json', 'strict']);
  if (!positional.length) { console.error('usage: stale-page.mjs <dir|file>... [--today YYYY-MM-DD] [--max-age 180] [--json] [--strict]'); process.exit(2); }
  const today = flags.today || iso(new Date());
  const r = analyzeStale(positional, { today, maxAgeDays: +(flags['max-age'] || 180) });
  if (flags.json) console.log(JSON.stringify(r, null, 2));
  else {
    for (const f of r.slice(0, 200)) console.log(`${f.severity.toUpperCase().padEnd(5)} ${f.id}${f.line ? ':' + f.line : ''}  [${f.rule}] ${f.message}`);
    const e = r.filter((x) => x.severity === 'error').length;
    console.log(`stale-page (today ${today}): ${r.length} findings, ${e} errors, ${r.length - e} warnings`);
  }
  process.exitCode = r.some((x) => x.severity === 'error') || (flags.strict && r.length) ? 1 : 0;
}
