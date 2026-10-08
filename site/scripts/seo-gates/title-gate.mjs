#!/usr/bin/env node
// title-gate: <title> hygiene for built HTML and/or markdown frontmatter.
// Errors: >max, <min, exact duplicate. Warnings: >warnAt, AI-style phrasing, no keyword, near-duplicate (cannibalisation).
// Usage: node title-gate.mjs <distDir> [--md <dir>] [--limits limits.json] [--allow allow.json] [--strict] [--json]
//   limits.json: {"default":{"max":60,"min":30,"warnAt":55},"de":{"max":68,"warnAt":63}}
//   allow.json : {"/path":["too-long"],"/legal/*":"*"}
// Exit: 0 no errors, 1 errors (or any finding with --strict), 2 usage.
import fs from 'node:fs';
import path from 'node:path';
import { walk, expand, parseArgs, readJson, isMain } from './lib/fs.mjs';
import { parseHtml, fileToPath } from './lib/html.mjs';
import { stripAccents } from './lib/text.mjs';

export const DEFAULT_LIMITS = { max: 60, min: 30, warnAt: 55 };

const AI_PATTERNS = [
  [/\bultimate guide\b/i, 'Ultimate Guide'], [/\bcomprehensive\b/i, 'Comprehensive'], [/everything you (?:need|should|want) to know/i, 'Everything you need to know'],
  [/\bhonest(?:ly)?\b/i, 'Honest'], [/\bcomplete guide\b/i, 'Complete Guide'], [/: A /, '": A …" construction'],
  [/\b(?:which|what)\b.*\b(?:is|are) better\b/i, 'question-title "Which X is better"'],
  [/\bdelve\b|\btapestry\b|\bunlock(?:ing)?\b|\bnavigat(?:e|ing) the\b/i, 'AI vocabulary'],
  // other languages
  [/ultimativer leitfaden|umfassender (?:leitfaden|ratgeber)|alles,? was (?:sie|du) wissen (?:müssen|musst)|kompletter leitfaden/i, 'AI phrasing (de)'],
  [/guide complet|tout ce que vous devez savoir|guide ultime/i, 'AI phrasing (fr)'],
  [/guida completa|tutto quello che (?:devi|c'è da) sapere|guida definitiva/i, 'AI phrasing (it)'],
  [/gu[ií]a completa|todo lo que necesitas saber|gu[ií]a definitiva/i, 'AI phrasing (es)'],
  [/kompletny przewodnik|wszystko,? co musisz wiedzieć|ostateczny przewodnik/i, 'AI phrasing (pl)'],
];
const STOP = new Set('the and for with from that this your you are our what which into about near best how why when where und der die das mit von für ein eine les des une pour dans avec sur del della con per una los las para por una und dla oraz przez'.split(' '));
const BRAND = new Set(['matlai']);

const tokens = (s) => stripAccents(s.toLowerCase()).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3 && !STOP.has(t));
const stripBrand = (t) => t.replace(/\s[|–—-]\s[^|–—-]*$/, '');
const globRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

export function limitsFor(lang, limits = {}) {
  const base = { ...DEFAULT_LIMITS, ...(limits.default || {}) };
  const l = { ...base, ...(limits[lang] || {}) };
  if (!l.warnAt || l.warnAt > l.max) l.warnAt = l.max - 5;
  return l;
}

export function checkTitles(items, { limits = {}, allow = {}, nearThreshold = 0.5 } = {}) {
  const out = [];
  const add = (it, severity, rule, message, extra = {}) => out.push({ id: it.id, severity, rule, message, title: it.title, ...extra });
  for (const it of items) {
    const t = (it.title || '').trim();
    if (!t) { add(it, 'error', 'missing', 'no <title>'); continue; }
    const L = limitsFor(it.lang, limits); const len = [...t].length;
    if (len > L.max) add(it, 'error', 'too-long', `${len} chars > ${L.max}`);
    else if (len > L.warnAt) add(it, 'warn', 'near-limit', `${len} chars > ${L.warnAt}`);
    if (len < L.min) add(it, 'error', 'too-short', `${len} chars < ${L.min}`);
    const hit = AI_PATTERNS.find(([re]) => re.test(t));
    const seps = (t.match(/\s[|–—-]\s|:/g) || []).length;
    if (hit) add(it, 'warn', 'ai-style', `AI-style pattern: ${hit[1]}`);
    else if (seps > 2) add(it, 'warn', 'ai-style', `over-punctuated (${seps} separators)`);
    else if (t.includes('?') && t.includes(':')) add(it, 'warn', 'ai-style', '"?" and ":" in one title');
    if (it.id !== '/') {
      const src = new Set([...tokens((it.id || '').split('/').pop().replace(/\.[a-z]+$/, '')), ...tokens(it.h1 || '')]);
      const tt = tokens(stripBrand(t)).filter((x) => !BRAND.has(x));
      if (src.size && tt.length && !tt.some((x) => src.has(x) || [...src].some((s) => s.length >= 5 && x.length >= 5 && (s.startsWith(x.slice(0, 5)) || x.startsWith(s.slice(0, 5)))))) {
        add(it, 'warn', 'no-keyword', 'title shares no keyword with the URL slug or H1');
      }
    }
  }
  // duplicates / cannibalisation, per language
  const byLang = new Map();
  for (const it of items) if (it.title) (byLang.get(it.lang || '') || byLang.set(it.lang || '', []).get(it.lang || '')).push(it);
  for (const group of byLang.values()) {
    const norm = group.map((it) => ({ it, key: tokens(stripBrand(it.title)).filter((x) => !BRAND.has(x)) }));
    const exact = new Map();
    for (const n of norm) { const k = n.it.title.trim().toLowerCase(); (exact.get(k) || exact.set(k, []).get(k)).push(n.it.id); }
    for (const ids of exact.values()) if (ids.length > 1) for (const id of ids) out.push({ id, severity: 'error', rule: 'duplicate', message: `identical title on ${ids.filter((x) => x !== id).join(', ')}` });
    for (let i = 0; i < norm.length; i++) {
      let best = null;
      for (let j = 0; j < norm.length; j++) {
        if (i === j || norm[i].it.title.trim().toLowerCase() === norm[j].it.title.trim().toLowerCase()) continue;
        const a = new Set(norm[i].key); const b = new Set(norm[j].key);
        if (!a.size || !b.size) continue;
        let inter = 0; for (const x of a) if (b.has(x)) inter++;
        const jac = inter / (a.size + b.size - inter);
        if (jac >= nearThreshold && (!best || jac > best.jac)) best = { jac, other: norm[j].it.id };
      }
      if (best) out.push({ id: norm[i].it.id, severity: 'warn', rule: 'near-duplicate', message: `Jaccard ${best.jac.toFixed(2)} with ${best.other} (cannibalisation risk)`, title: norm[i].it.title });
    }
  }
  const rules = Object.entries(allow).map(([g, r]) => [globRe(g), r]);
  return out.filter((f) => !rules.some(([re, r]) => re.test(f.id) && (r === '*' || (Array.isArray(r) && r.includes(f.rule)))));
}

export function collectDist(distDir) {
  const items = [];
  for (const f of walk(distDir, ['.html', '.htm'])) {
    const p = fileToPath(distDir, f);
    if (/(^|\/)404$/.test(p)) continue;
    const info = parseHtml(fs.readFileSync(f, 'utf8'));
    if (info.noindex || info.refresh) continue;
    items.push({ id: p, title: info.title, lang: (info.lang || '').split('-')[0], h1: info.h1 });
  }
  return items;
}

export function collectMarkdown(dir) {
  const items = [];
  for (const f of expand([dir], ['.md', '.mdx'])) {
    const m = fs.readFileSync(f, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) continue;
    const fm = (k) => (m[1].match(new RegExp(`^${k}\\s*:\\s*["']?(.*?)["']?\\s*$`, 'mi')) || [, ''])[1];
    const title = fm('title'); if (!title) continue;
    const lang = fm('lang') || (f.match(/[\\/](de|fr|it|es|pl|en)[\\/]/) || [, 'en'])[1];
    items.push({ id: f, title, lang });
  }
  return items;
}

if (isMain(import.meta.url)) {
  const { positional, flags } = parseArgs(process.argv.slice(2), ['json', 'strict']);
  if (!positional[0] && !flags.md) { console.error('usage: title-gate.mjs <distDir> [--md dir] [--limits f.json] [--allow f.json] [--strict] [--json]'); process.exit(2); }
  const items = [...(positional[0] ? collectDist(positional[0]) : []), ...(flags.md ? collectMarkdown(flags.md) : [])];
  const r = checkTitles(items, { limits: flags.limits ? readJson(flags.limits) : {}, allow: flags.allow ? readJson(flags.allow) : {} });
  if (flags.json) console.log(JSON.stringify(r, null, 2));
  else {
    for (const f of r.slice(0, 300)) console.log(`${f.severity.toUpperCase().padEnd(5)} ${f.id}  [${f.rule}] ${f.message}${f.title ? `  «${f.title}»` : ''}`);
    const by = {}; for (const f of r) by[f.rule] = (by[f.rule] || 0) + 1;
    const e = r.filter((x) => x.severity === 'error').length;
    console.log(`title-gate: ${items.length} titles, ${r.length} findings (${e} errors, ${r.length - e} warnings) ${JSON.stringify(by)}`);
  }
  process.exitCode = r.some((x) => x.severity === 'error') || (flags.strict && r.length) ? 1 : 0;
}
