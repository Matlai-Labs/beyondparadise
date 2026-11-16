#!/usr/bin/env node
// Post-idea pool for the Instagram pipeline (B4). Free, no model, no network: it only PROPOSES what the publication can stand behind.
//
//   buildIdeaPool({ facts, pages, rules, history, now, config })  -> { ideas, dropped }     (pure; everything injected)
//   node ideas.js --top 10 [--json] [--history-file <audit.json>] [--queue-file <queue.json>] [--never-file <path>] [--regions a,b] [--now <date>]
//   The command line reads the real inputs, prints the ranked ideas and WRITES NOTHING.
//
// Three kinds of idea:
//   fact  one record of data/facts/facts.json whose status is EXACTLY "confirmed" (same fields the site reads: value ?? claim,
//         sources, lastChecked || promotedOn || added, region, topic)
//   page  one published page (front matter of site/src/content/*, plus the intelligence pages)
//   rule  one entry of data/rules/official-rules.json with confidence "official-page" and expired not true
//
// Checks, in this order, for every candidate (the FIRST failing one is the reason recorded in `dropped`):
//   1 eligibility  fact: status "confirmed" | page: not draft, not retired | rule: official-page, not expired, has a figure
//   2 source date  a claim without a readable YYYY-MM-DD source date is dropped
//   3 region       default Tanzania and Zanzibar only; config.regions widens it (a region slug or its country both count)
//   4 text         title + claim texts: sea-condition words (REFUSAL_PATTERNS), config.neverPromotePatterns, first person ("we stayed")
//   5 repeat       source id (or idea id) in history within config.repeatDays (default 120), or the idea's link quoted in a history text.
//                  A history entry with an unreadable date counts as recent (fail closed).
//
// RANKING (deterministic):
//   score = (BASE + FRESH_MAX * max(0, 1 - ageDays / FRESH_DAYS) + (month match ? MONTH_BONUS : 0)) * topicWeight
//   BASE 50, FRESH_MAX 50, FRESH_DAYS 730 (a source dated today gets +50, a two-year-old one +0), MONTH_BONUS 5,
//   topicWeight = config.topicWeights[topic] ?? 1. A month match = a `months` / `month` / `season` / `best_months` field that contains
//   the month of `now`. Sorted by score descending, ties by idea id ascending. Input order never matters.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REFUSAL_PATTERNS, FIRST_PERSON_PATTERNS, refusalHits } from './rules-gate.js';

export const BASE = 50, FRESH_MAX = 50, FRESH_DAYS = 730, MONTH_BONUS = 5;
export const DEFAULT_REGIONS = ['tanzania', 'zanzibar'];
const DAY = 86400000;

// The sea-condition, seaweed-farming and first-person constants live in rules-gate.js (one source of truth); re-exported here.
export { REFUSAL_PATTERNS, FIRST_PERSON_PATTERNS, refusalHits };

// Region slugs used in facts.json -> country group. East-africa / global / unknown slugs map to null and are skipped by default.
const COUNTRY = {
  zanzibar: ['zanzibar', 'stone-town', 'pemba', 'menai-bay', 'mnemba-atoll'],
  tanzania: ['tanzania', 'serengeti', 'serengeti-western-corridor', 'mafia-island', 'selous-nyerere', 'ngorongoro', 'lake-manyara', 'tarangire', 'ruaha', 'kilimanjaro', 'ndutu'],
  kenya: ['kenya', 'masai-mara', 'amboseli', 'tsavo', 'laikipia', 'samburu'],
  rwanda: ['rwanda'],
  vietnam: ['vietnam', 'hanoi', 'hoi-an', 'hue', 'ha-long-bay', 'con-dao', 'phu-quoc', 'mekong-delta', 'ho-chi-minh-city', 'da-nang'],
};
const SLUG_COUNTRY = Object.fromEntries(Object.entries(COUNTRY).flatMap(([c, l]) => l.map((s) => [s, c])));
export const regionCountry = (slug) => SLUG_COUNTRY[String(slug || '').toLowerCase()] || null;

export const ideaId = (kind, sourceId) => 'idea_' + crypto.createHash('sha256').update(`${kind}:${sourceId}`).digest('hex').slice(0, 12);
const isoDay = (s) => { if (typeof s !== 'string') return null; const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(s.trim()); if (!m) return null; const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`); return d.toISOString().slice(0, 10) === `${m[1]}-${m[2]}-${m[3]}` ? `${m[1]}-${m[2]}-${m[3]}` : null; };
const toMs = (d) => (d instanceof Date ? d.getTime() : Date.parse(typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d + 'T00:00:00Z' : d));
const wholeWord = (text, w) => new RegExp(`(?:^|[^a-z0-9-])${String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9-])`, 'i').test(text);
const shorten = (s, n = 90) => { const t = String(s).replace(/\s+/g, ' ').trim(); if (t.length <= n) return t; const cut = t.slice(0, n).replace(/\s+\S*$/, '').replace(/[^\p{L}\p{N})\]]+$/u, ''); return cut + '…'; };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthIdx = (tok) => (typeof tok === 'number' ? tok : MONTHS.indexOf(String(tok).slice(0, 3).toLowerCase()) + 1);
/** Set of month numbers (1-12) a record names: months[] / month / best_months[] / season text ("June-October", "October to January"). */
export function monthsOf(o) {
  const out = new Set(); if (!o) return out;
  for (const v of [].concat(o.months ?? [], o.month ?? [], o.best_months ?? [], o.bestMonths ?? [])) { const n = monthIdx(v); if (n >= 1 && n <= 12) out.add(n); }
  if (typeof o.season === 'string') {
    const re = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi;
    let prev = null, m;
    while ((m = re.exec(o.season))) {
      const n = monthIdx(m[1]);
      if (prev && /^\s*(?:-|–|—|to|through|until)\s*$/i.test(o.season.slice(prev.end, m.index))) { for (let k = prev.n; ; k = k % 12 + 1) { out.add(k); if (k === n) break; } } else out.add(n);
      prev = { n, end: m.index + m[0].length };
    }
  }
  return out;
}

const compileNever = (list) => (Array.isArray(list) ? list : []).map((p) => (p instanceof RegExp ? p : new RegExp(String(p), 'i')));
const history12 = (history) => (Array.isArray(history) ? history : []);

/** Pure. See the header for the rules. */
export function buildIdeaPool({ facts = [], pages = [], rules = [], history = [], now = new Date(), config = {} } = {}) {
  const cfg = { regions: DEFAULT_REGIONS, repeatDays: 120, topicWeights: {}, neverPromotePatterns: [], ...config };
  const regions = new Set((cfg.regions || DEFAULT_REGIONS).map((r) => String(r).toLowerCase()));
  const never = compileNever(cfg.neverPromotePatterns);
  const nowMs = toMs(now); const nowMonth = new Date(nowMs).getUTCMonth() + 1;
  const ideas = [], dropped = [];
  const drop = (kind, sourceId, reason) => dropped.push({ kind, sourceId: String(sourceId), reason });
  const pageList = Array.isArray(pages) ? pages : [];
  const ruleList = Array.isArray(rules) ? rules : (rules && Array.isArray(rules.rules) ? rules.rules : []);
  const publishable = pageList.filter((p) => !p.draft && !p.retired);

  const regionOk = (slug) => { const s = String(slug || '').toLowerCase(); return regions.has(s) || regions.has(regionCountry(s)); };
  const textReason = (title, texts) => {
    const all = [title, ...texts].join('\n');
    const hits = refusalHits(all); if (hits.length) return `refusal:${hits.join('+')}`;
    const n = never.findIndex((re) => re.test(all)); if (n >= 0) return `never-promote:#${n}`;
    if (FIRST_PERSON_PATTERNS.some((re) => re.test(all))) return 'first-person';
    return null;
  };
  const repeatReason = (idea) => {
    const win = cfg.repeatDays * DAY;
    for (const h of history12(history)) {
      const same = (h.sourceId != null && (h.sourceId === idea.sourceId || h.sourceId === idea.id)) || (idea.link && typeof h.text === 'string' && h.text.includes(idea.link));
      if (!same) continue;
      const t = h.date ? toMs(h.date) : NaN;
      if (Number.isNaN(t) || nowMs - t <= win) return `repeat:${cfg.repeatDays}d`;
    }
    return null;
  };
  const finish = (kind, sourceId, idea, monthSet, topic) => {
    const age = Math.max(0, (nowMs - toMs(idea.claims[0].sourceDate)) / DAY);
    const fresh = FRESH_MAX * Math.max(0, 1 - age / FRESH_DAYS);
    const bonus = monthSet.has(nowMonth) ? MONTH_BONUS : 0;
    const weight = Number(cfg.topicWeights?.[topic] ?? 1);
    idea.score = Math.round((BASE + fresh + bonus) * weight * 1000) / 1000;
    idea.reasons = [`fresh: source dated ${idea.claims[0].sourceDate}, ${Math.floor(age)} days old (+${fresh.toFixed(1)})`];
    if (bonus) idea.reasons.push(`month match: ${nowMonth} is in the source's season (+${MONTH_BONUS})`);
    if (weight !== 1) idea.reasons.push(`topic weight ${topic} x${weight}`);
    const why = repeatReason(idea); if (why) return drop(kind, sourceId, why);
    ideas.push(idea);
  };

  for (const f of Array.isArray(facts) ? facts : []) {
    if (f.status !== 'confirmed') { drop('fact', f.id, `status:${f.status ?? 'none'}`); continue; }
    const sourceDate = isoDay(f.lastChecked) || isoDay(f.promotedOn) || isoDay(f.added);
    if (!sourceDate) { drop('fact', f.id, 'no-source-date'); continue; }
    if (!regionOk(f.region)) { drop('fact', f.id, `region:${f.region}`); continue; }
    const text = String(f.value ?? f.claim); const title = f.value != null ? String(f.claim) : shorten(f.claim);
    const bad = textReason(title, [text]); if (bad) { drop('fact', f.id, bad); continue; }
    const link = (publishable.find((p) => String(p.path).split('/').filter(Boolean).pop() === f.region) || {}).path ?? null;
    finish('fact', f.id, { id: ideaId('fact', f.id), sourceId: `fact:${f.id}`, kind: 'fact', topic: f.topic ?? null, title, claims: [{ text, factId: f.id, sourceDate }], link }, monthsOf(f), f.topic);
  }

  for (const p of pageList) {
    if (p.draft) { drop('page', p.path, 'draft'); continue; }
    if (p.retired) { drop('page', p.path, 'retired'); continue; }
    const sourceDate = isoDay(p.lastUpdated);
    if (!sourceDate) { drop('page', p.path, 'no-source-date'); continue; }
    const hasRegion = (p.region && [...regions].some((r) => wholeWord(p.region, r))) || (p.destinationId && regionOk(p.destinationId));
    if (!hasRegion) { drop('page', p.path, `region:${p.region ?? p.destinationId ?? 'unknown'}`); continue; }
    const bad = textReason(p.title, [p.description]); if (bad) { drop('page', p.path, bad); continue; }
    finish('page', p.path, { id: ideaId('page', p.path), sourceId: `page:${p.path}`, kind: 'page', topic: p.topic ?? p.collection ?? null, title: p.title, claims: [{ text: String(p.description), pagePath: p.path, sourceDate }], link: p.path }, monthsOf(p), p.topic ?? p.collection);
  }

  for (const r of ruleList) {
    if (r.confidence !== 'official-page') { drop('rule', r.id, `rule:confidence:${r.confidence}`); continue; }
    if (r.expired === true) { drop('rule', r.id, 'rule:expired'); continue; }
    if (!Array.isArray(r.figures) || r.figures.length === 0) { drop('rule', r.id, 'rule:no-figures'); continue; }
    const sourceDate = isoDay(r.date_on_page) || isoDay(r.read_on);
    if (!sourceDate) { drop('rule', r.id, 'no-source-date'); continue; }
    const fmt = (n) => (n % 1 ? n.toFixed(2) : n.toLocaleString('en-US'));
    const text = `${r.label}: ${r.figures.map((x) => `${x.label} ${fmt(x.amount)} ${x.currency ?? x.unit ?? ''}`.trim()).join('; ')} (${r.body}, official page read ${r.read_on})`;
    const bad = textReason(r.label, [text]); if (bad) { drop('rule', r.id, bad); continue; }
    finish('rule', r.id, { id: ideaId('rule', r.id), sourceId: `rule:${r.id}`, kind: 'rule', topic: r.topic ?? 'official-rules', title: r.label, claims: [{ text, ruleId: r.id, sourceDate }], link: r.address }, monthsOf(r), r.topic ?? 'official-rules');
  }

  ideas.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ideas, dropped };
}

// ── readers (used by the command line and the tests; they read, never write) ──────────────────
/** Tiny front-matter reader: top-level scalars, [a, b] lists, booleans. Nested blocks (faq) are skipped. */
export function parseFrontMatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src); const out = {}; if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line); if (!kv) continue;
    const [, k, raw] = kv; const v = raw.trim();
    if (v === '') out[k] = null;
    else if (v.startsWith('[') && v.endsWith(']')) out[k] = v.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean).map((x) => (/^-?\d+(\.\d+)?$/.test(x) ? Number(x) : x.replace(/^["']|["']$/g, '')));
    else if (v.startsWith('"')) { try { out[k] = JSON.parse(v); } catch { out[k] = v.replace(/^"|"$/g, ''); } }
    else if (v === 'true' || v === 'false') out[k] = v === 'true';
    else if (v === 'null') out[k] = null;
    else if (/^-?\d+(\.\d+)?$/.test(v)) out[k] = Number(v);
    else out[k] = v.replace(/^'|'$/g, '');
  }
  return out;
}
/** Retired URL paths (the redirect stub script's input: site/src/lib/retired-redirects.mjs). Read as text so no code is executed. */
export function loadRetired(root) {
  const f = path.join(root, 'site', 'src', 'lib', 'retired-redirects.mjs'); let s = '';
  try { s = fs.readFileSync(f, 'utf8'); } catch { return []; }
  const body = s.slice(s.indexOf('export const RETIRED')); const out = [];
  for (const m of body.matchAll(/^\s*'([^']+)'\s*:/gm)) out.push(`/excursions/${m[1]}/`);
  return out;
}
export function loadPages(root) {
  const content = path.join(root, 'site', 'src', 'content'); const retired = new Set(loadRetired(root)); const pages = [];
  for (const dir of ['wildlife', 'destinations', 'excursions']) {
    const d = path.join(content, dir); if (!fs.existsSync(d)) continue;
    for (const file of fs.readdirSync(d).filter((x) => x.endsWith('.md')).sort()) {
      const fm = parseFrontMatter(fs.readFileSync(path.join(d, file), 'utf8'));
      if (!fm.permalink || !fm.title) continue;
      pages.push({ path: fm.permalink, title: fm.title, description: fm.description ?? '', region: fm.region ?? null, destinationId: fm.destination_id ?? null, bestMonths: fm.best_months ?? [], lastUpdated: fm.last_updated ?? null, draft: fm.draft === true, retired: retired.has(fm.permalink), collection: dir });
    }
  }
  const intel = path.join(root, 'site', 'src', 'pages', 'intelligence');
  if (fs.existsSync(intel)) for (const dir of fs.readdirSync(intel).sort()) {
    const f = path.join(intel, dir, 'index.astro'); if (!fs.existsSync(f)) continue;
    const base = /<Base\b([\s\S]*?)>/.exec(fs.readFileSync(f, 'utf8'))?.[1] || '';
    const title = /\btitle="([^"]*)"/.exec(base)?.[1]; if (!title) continue;
    // These pages are built from facts.json at build time and carry no date of their own: they are dropped as no-source-date.
    pages.push({ path: `/intelligence/${dir}/`, title, description: /\bdescription="([^"]*)"/.exec(base)?.[1] ?? '', region: null, destinationId: null, bestMonths: [], lastUpdated: null, draft: false, retired: retired.has(`/intelligence/${dir}/`), collection: 'intelligence' });
  }
  return pages;
}
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } };
/** Posted or queued drafts of social/queue.json (expired and skipped ones were never published). */
export function historyFromQueue(q) {
  const drafts = q && Array.isArray(q.drafts) ? q.drafts : [];
  return drafts.filter((d) => d.status !== 'expired' && d.status !== 'skipped').map((d) => ({ sourceId: d.sourceId ?? null, date: d.postedAt || d.scheduledFor || d.createdAt || d.sourceDate || null, text: typeof d.text === 'string' ? d.text : undefined })).filter((h) => h.sourceId || h.text);
}
/** The Instagram audit export (optional input): one entry per published post. */
export function historyFromAudit(a) {
  const posts = a && Array.isArray(a.posts) ? a.posts : [];
  return posts.map((p) => ({ sourceId: p.id != null ? String(p.id) : null, date: p.utc ?? null, text: typeof p.hook === 'string' ? p.hook : undefined }));
}
export function loadNeverPatterns(file) {
  const j = readJson(file, null); if (j == null) return null;
  const list = Array.isArray(j) ? j : j.patterns; if (!Array.isArray(list)) throw new Error(`never-promote file ${file}: expected an array or { patterns: [] }`);
  return list.map(String);
}
export function loadInputs({ root, historyFile, queueFile, neverFile, regions } = {}) {
  const facts = readJson(path.join(root, 'data', 'facts', 'facts.json'), { facts: [] }).facts;
  const rules = readJson(path.join(root, 'data', 'rules', 'official-rules.json'), { rules: [] }).rules;
  const history = [...historyFromQueue(readJson(queueFile || path.join(root, 'social', 'queue.json'), null)), ...(historyFile ? historyFromAudit(readJson(historyFile, null)) : [])];
  const config = {}; if (regions) config.regions = regions;
  const never = neverFile ? loadNeverPatterns(neverFile) : null; if (never) config.neverPromotePatterns = never;
  return { facts, pages: loadPages(root), rules, history, config, neverFileFound: never !== null };
}

// ── command line ───────────────────────────────────────────────────────────────────────────────
function main(argv) {
  const a = { top: 10, json: false }; const val = (i) => { if (i + 1 >= argv.length) { console.error(`missing value for ${argv[i]}`); process.exit(2); } return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--json') a.json = true;
    else if (k === '--top') { a.top = Number(val(i)); i++; }
    else if (k === '--history-file') { a.historyFile = val(i); i++; }
    else if (k === '--queue-file') { a.queueFile = val(i); i++; }
    else if (k === '--never-file') { a.neverFile = val(i); i++; }
    else if (k === '--regions') { a.regions = val(i).split(',').map((s) => s.trim()).filter(Boolean); i++; }
    else if (k === '--now') { a.now = val(i); i++; }
    else { console.error(`unknown argument ${k}`); process.exit(2); }
  }
  if (!Number.isInteger(a.top) || a.top < 1) { console.error('--top needs a positive integer'); process.exit(2); }
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  // The never-promote list is private; it lives outside the repository. A missing file only warns, a broken one stops the run.
  const neverFile = a.neverFile || path.join(os.homedir(), '.matlai', 'bpa-never-promote.json');
  let inp;
  try { inp = loadInputs({ root, historyFile: a.historyFile, queueFile: a.queueFile, neverFile, regions: a.regions }); } catch (e) { console.error(`ideas: cannot read inputs: ${e.message}`); process.exit(2); }
  if (!inp.neverFileFound) console.error(`ideas: no never-promote file at ${neverFile} (no private refusal list applied)`);
  const now = a.now ? new Date(a.now + (/^\d{4}-\d{2}-\d{2}$/.test(a.now) ? 'T00:00:00Z' : '')) : new Date();
  const { ideas, dropped } = buildIdeaPool({ facts: inp.facts, pages: inp.pages, rules: inp.rules, history: inp.history, now, config: inp.config });
  const byKind = {}; for (const i of ideas) byKind[i.kind] = (byKind[i.kind] || 0) + 1;
  const droppedByReason = {}; for (const d of dropped) { const key = d.reason.startsWith(`${d.kind}:`) ? d.reason : `${d.kind}:${d.reason}`; droppedByReason[key] = (droppedByReason[key] || 0) + 1; }
  const top = ideas.slice(0, a.top);
  if (a.json) { console.log(JSON.stringify({ now: now.toISOString().slice(0, 10), counts: { total: ideas.length, byKind, dropped: dropped.length }, droppedByReason, ideas: top }, null, 2)); return; }
  top.forEach((i, n) => {
    console.log(`${n + 1}. [${i.kind}] score ${i.score}  ${i.title}`);
    console.log(`   topic: ${i.topic ?? '-'}   link: ${i.link ?? '-'}`);
    console.log(`   claim: ${shorten(i.claims[0].text, 150)} (source ${i.claims[0].sourceDate})`);
    console.log(`   why: ${i.reasons.join(' | ')}`);
  });
  console.log(`\n${ideas.length} ideas (${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(', ')}); ${dropped.length} candidates dropped:`);
  for (const [k, v] of Object.entries(droppedByReason).sort((x, y) => y[1] - x[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
