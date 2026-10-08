#!/usr/bin/env node
// Build gate for <title> / meta description quality, run AFTER `astro build` against dist/.
// Fails (exit 1) on: title > 60 chars, AI-style title phrasing, duplicate titles,
// description > 155 chars, description truncated mid-sentence (ellipsis / no terminal punctuation),
// missing description. Warns on title < 30 chars.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const TITLE_MAX = 60, DESC_MAX = 155;
const AI_PHRASES = [
  /what to know before you go/i, /everything you need to know/i, /\bcomplete guide\b/i,
  /\bultimate guide\b/i, /\bdelve\b/i, /\bunlock(ing)? the\b/i, /\bin today'?s\b/i,
  /\bnavigating the\b/i, /\bdive (deep )?into\b/i, /\btapestry\b/i,
];
function walk(d, o = []) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p, o) : o.push(p); } return o; }
const decode = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

const errors = [], warns = [], titles = new Map();
let n = 0;
for (const f of walk(DIST).filter(f => f.endsWith('.html'))) {
  const url = '/' + path.relative(DIST, f).replace(/index\.html$/, '');
  const html = fs.readFileSync(f, 'utf8');
  if (/<meta[^>]+http-equiv="refresh"/i.test(html)) continue; // redirect stub
  n++;
  const t = html.match(/<title>([\s\S]*?)<\/title>/i);
  const d = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
  if (!t) { errors.push(`${url}: missing <title>`); continue; }
  const title = decode(t[1]).trim();
  if (title.length > TITLE_MAX) errors.push(`${url}: title ${title.length} > ${TITLE_MAX}: "${title}"`);
  if (title.length < 30) warns.push(`${url}: title only ${title.length} chars`);
  for (const re of AI_PHRASES) if (re.test(title)) errors.push(`${url}: AI-style phrase /${re.source}/ in title: "${title}"`);
  if (titles.has(title)) errors.push(`${url}: duplicate title with ${titles.get(title)}: "${title}"`);
  titles.set(title, url);
  if (!d) { errors.push(`${url}: missing meta description`); continue; }
  const desc = decode(d[1]).trim();
  if (desc.length > DESC_MAX) errors.push(`${url}: description ${desc.length} > ${DESC_MAX}`);
  if (/…|\.\.\./.test(desc)) errors.push(`${url}: description contains an ellipsis (truncated): "${desc}"`);
  if (!/[.!?]$/.test(desc)) errors.push(`${url}: description does not end in sentence punctuation: "...${desc.slice(-40)}"`);
  if (desc.length < 70) warns.push(`${url}: description only ${desc.length} chars`);
}
console.log(`content-gate: ${n} pages checked (title <= ${TITLE_MAX}, description <= ${DESC_MAX})`);
for (const w of warns) console.log('  warn  ' + w);
for (const e of errors) console.log('  ERROR ' + e);
console.log(errors.length ? `content-gate: FAIL (${errors.length} errors)` : 'content-gate: PASS');
process.exit(errors.length ? 1 : 0);
