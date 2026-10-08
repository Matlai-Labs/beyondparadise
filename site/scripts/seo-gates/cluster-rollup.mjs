#!/usr/bin/env node
// cluster-rollup: roll a GSC page-level export (+ generative-AI report + GA4 AI-referral sessions) up to content clusters,
// with period-over-period (quarter-over-quarter) deltas. Deterministic, no network.
// Usage: node cluster-rollup.mjs --clusters defs.json --gsc cur.csv [--gsc-prev prev.csv] [--ai cur-ai.csv] [--ai-prev prev-ai.csv]
//          [--sessions cur.json] [--sessions-prev prev.json] [--out dir] [--json]
//   defs.json: {"clusters":[{"name":"honeymoon","match":["/honeymoon*","re:^/de/hochzeit"]}]}   (glob, or "re:" regex)
//          or the matlai_wix engine format {"clusters":{"name":{"pillar":"/x","spokes":["/y"]}}}
//   sessions : JSON [{path,sessions}] or CSV "page,sessions" — GA4 sessions from AI Assistants channel by landing page.
// Exit: 0 ok, 2 usage.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, readJson, isMain } from './lib/fs.mjs';
import { parseGscPages, parseGenerativeAiCsv, parseCsv, toPath } from './lib/gsc.mjs';

const globToRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
const LANGS = /^\/(de|fr|it|es|pl|en)(?=\/|$)/;

export function loadClusterDefs(raw) {
  const list = Array.isArray(raw.clusters)
    ? raw.clusters
    : Object.entries(raw.clusters).map(([name, c]) => ({ name, match: c.match || [c.pillar, c.pillar && c.pillar + '/*', ...(c.spokes || [])].filter(Boolean) }));
  return list.map((c) => ({ name: c.name, tests: c.match.map((m) => (m.startsWith('re:') ? new RegExp(m.slice(3)) : globToRe(m))) }));
}

const cluster = (defs, p) => {
  const variants = [p, p.replace(LANGS, '') || '/'];
  for (const d of defs) if (d.tests.some((re) => variants.some((v) => re.test(v)))) return d.name;
  return '(unclustered)';
};

function aggregate(defs, pages = [], ai = [], sessions = []) {
  const m = new Map();
  const get = (n) => m.get(n) || m.set(n, { name: n, clicks: 0, impressions: 0, posW: 0, pages: 0, aiImpressions: 0, aiSessions: 0 }).get(n);
  for (const r of pages) { const c = get(cluster(defs, r.path)); c.clicks += r.clicks; c.impressions += r.impressions; c.posW += r.position * r.impressions; c.pages++; }
  for (const r of ai) get(cluster(defs, toPath(r.key))).aiImpressions += r.impressions;
  for (const r of sessions) get(cluster(defs, toPath(r.path))).aiSessions += r.sessions;
  return m;
}
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const METRICS = ['clicks', 'impressions', 'ctr', 'position', 'aiImpressions', 'aiSessions'];
const finish = (c) => ({ ...c, ctr: c.impressions ? round(c.clicks / c.impressions, 4) : 0, position: c.impressions ? round(c.posW / c.impressions) : 0 });

export function rollup({ defs, current = [], previous = null, aiCurrent = [], aiPrevious = [], sessions = [], sessionsPrevious = [] }) {
  const cur = aggregate(defs, current, aiCurrent, sessions);
  const prev = previous ? aggregate(defs, previous, aiPrevious, sessionsPrevious) : null;
  const names = new Set([...cur.keys(), ...(prev ? prev.keys() : [])]);
  const clusters = [...names].map((n) => {
    const c = finish(cur.get(n) || { name: n, clicks: 0, impressions: 0, posW: 0, pages: 0, aiImpressions: 0, aiSessions: 0 });
    delete c.posW;
    if (prev) {
      const p = finish(prev.get(n) || { name: n, clicks: 0, impressions: 0, posW: 0, pages: 0, aiImpressions: 0, aiSessions: 0 });
      c.previous = Object.fromEntries(METRICS.map((k) => [k, p[k]]));
      c.delta = Object.fromEntries(METRICS.map((k) => [k, { abs: round(c[k] - p[k], 4), pct: p[k] ? round(((c[k] - p[k]) / p[k]) * 100, 1) : null }]));
    }
    return c;
  }).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
  const total = finish({ name: 'TOTAL', ...clusters.reduce((t, c) => ({ clicks: t.clicks + c.clicks, impressions: t.impressions + c.impressions, posW: t.posW + c.position * c.impressions, pages: t.pages + c.pages, aiImpressions: t.aiImpressions + c.aiImpressions, aiSessions: t.aiSessions + c.aiSessions }), { clicks: 0, impressions: 0, posW: 0, pages: 0, aiImpressions: 0, aiSessions: 0 }) });
  delete total.posW;
  return { generatedFrom: 'seo-gates/cluster-rollup', hasComparison: !!prev, clusters, total };
}

export function renderMarkdown(r) {
  const d = (c, k) => (c.delta ? ` (${c.delta[k].abs >= 0 ? '+' : ''}${c.delta[k].abs}${c.delta[k].pct !== null ? ', ' + (c.delta[k].pct >= 0 ? '+' : '') + c.delta[k].pct + '%' : ''})` : '');
  const lines = ['| Cluster | Pages | Clicks | Impr. | CTR | Avg pos | AI impr. | AI sessions |', '|---|---:|---:|---:|---:|---:|---:|---:|'];
  for (const c of [...r.clusters, r.total]) lines.push(`| ${c.name === 'TOTAL' ? '**TOTAL**' : c.name} | ${c.pages} | ${c.clicks}${c.delta ? d(c, 'clicks') : ''} | ${c.impressions}${c.delta ? d(c, 'impressions') : ''} | ${(c.ctr * 100).toFixed(2)}% | ${c.position}${c.delta ? d(c, 'position') : ''} | ${c.aiImpressions}${c.delta ? d(c, 'aiImpressions') : ''} | ${c.aiSessions}${c.delta ? d(c, 'aiSessions') : ''} |`);
  return lines.join('\n') + '\n' + (r.hasComparison ? '\nDeltas are current minus previous period; for position a NEGATIVE delta is an improvement.\n' : '');
}

const readSessions = (f) => {
  const t = fs.readFileSync(f, 'utf8').trim();
  if (t.startsWith('[') || t.startsWith('{')) { const j = JSON.parse(t); return (Array.isArray(j) ? j : j.rows || []).map((r) => ({ path: r.path || r.page || (r.keys && r.keys[0]), sessions: +r.sessions || 0 })); }
  return parseCsv(t).slice(1).filter((r) => r[0]).map((r) => ({ path: r[0], sessions: +String(r[1]).replace(/[, ]/g, '') || 0 }));
};

if (isMain(import.meta.url)) {
  const { flags } = parseArgs(process.argv.slice(2), ['json']);
  if (!flags.clusters || !flags.gsc) { console.error('usage: cluster-rollup.mjs --clusters defs.json --gsc cur.csv [--gsc-prev ..] [--ai ..] [--ai-prev ..] [--sessions ..] [--sessions-prev ..] [--out dir] [--json]'); process.exit(2); }
  const rd = (f) => fs.readFileSync(f, 'utf8');
  const r = rollup({
    defs: loadClusterDefs(readJson(flags.clusters)), current: parseGscPages(rd(flags.gsc)), previous: flags['gsc-prev'] ? parseGscPages(rd(flags['gsc-prev'])) : null,
    aiCurrent: flags.ai ? parseGenerativeAiCsv(rd(flags.ai)).rows : [], aiPrevious: flags['ai-prev'] ? parseGenerativeAiCsv(rd(flags['ai-prev'])).rows : [],
    sessions: flags.sessions ? readSessions(flags.sessions) : [], sessionsPrevious: flags['sessions-prev'] ? readSessions(flags['sessions-prev']) : [],
  });
  if (flags.out) { fs.mkdirSync(flags.out, { recursive: true }); fs.writeFileSync(path.join(flags.out, 'cluster-rollup.json'), JSON.stringify(r, null, 2)); fs.writeFileSync(path.join(flags.out, 'cluster-rollup.md'), renderMarkdown(r)); console.log('wrote', flags.out); }
  else console.log(flags.json ? JSON.stringify(r, null, 2) : renderMarkdown(r));
}
