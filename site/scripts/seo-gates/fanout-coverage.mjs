#!/usr/bin/env node
// fan-out coverage map: which sub-questions of a hub topic are answered by an H2/H3/FAQ on the hub or its spokes?
// Deterministic keyword + synonym matching on headings only (no embeddings). Output = gap table.
// Usage: node fanout-coverage.mjs <distDir> <fanout.json> [--hub honeymoon] [--json] [--strict]
// Exit: 0 ok (gaps are reported, not failed) / 1 with --strict and gaps / 2 usage.
import fs from 'node:fs';
import path from 'node:path';
import { walk, parseArgs, readJson, isMain } from './lib/fs.mjs';
import { parseHtml, fileToPath } from './lib/html.mjs';
import { stripAccents } from './lib/text.mjs';

const norm = (s) => stripAccents(s.toLowerCase()).replace(/[’']/g, "'");
const termRe = (t) => new RegExp('(?<![\\p{L}\\p{N}])' + norm(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'u');

function loadPages(distDir, hub) {
  const want = new Set([...(hub.pages || []), ...(String(hub.hub).startsWith('/') ? [hub.hub] : []), ...(hub.spokes || [])]);
  const prefixes = hub.prefixes || [];
  const pages = [];
  for (const f of walk(distDir, ['.html'])) {
    const p = fileToPath(distDir, f);
    if (!(want.has(p) || prefixes.some((x) => p.startsWith(x)))) continue;
    const info = parseHtml(fs.readFileSync(f, 'utf8'));
    const surfaces = [...info.headings.filter((h) => h.level === 2 || h.level === 3).map((h) => h.text), ...info.summaries, ...info.ldQuestions];
    pages.push({ path: p, surfaces: surfaces.map(norm) });
  }
  // hub page first so `where` prefers the hub
  return pages.sort((a, b) => (want.has(b.path) ? 1 : 0) - (want.has(a.path) ? 1 : 0) || a.path.localeCompare(b.path));
}

export function coverage(hub, distDir) {
  const pages = loadPages(distDir, hub);
  const rows = hub.questions.map((q) => {
    const terms = [...(q.keywords || []), ...(q.synonyms || [])].map(termRe);
    for (const pg of pages) {
      const s = pg.surfaces.find((t) => terms.some((re) => re.test(t)));
      if (s) return { id: q.id, q: q.q, covered: true, where: pg.path, matched: s };
    }
    return { id: q.id, q: q.q, covered: false, where: null, matched: null };
  });
  const missingPages = [...(hub.pages || []), ...(String(hub.hub).startsWith('/') ? [hub.hub] : []), ...(hub.spokes || [])].filter((p) => !pages.some((x) => x.path === p));
  return { hub: hub.hub, pagesScanned: pages.length, missingPages, rows, gaps: rows.filter((r) => !r.covered), coveredCount: rows.filter((r) => r.covered).length };
}

export function renderGapTable(...results) {
  const out = [];
  for (const r of results) {
    out.push(`### ${r.hub}: ${r.coveredCount}/${r.rows.length} sub-questions answered (${r.pagesScanned} pages scanned)${r.missingPages.length ? ' - MISSING PAGES: ' + r.missingPages.join(', ') : ''}`);
    out.push('| Sub-question | Status | Answered on |', '|---|---|---|');
    for (const x of r.rows) out.push(`| ${x.id}: ${x.q} | ${x.covered ? 'covered' : '**GAP**'} | ${x.where || '-'} |`);
    out.push('');
  }
  return out.join('\n');
}

if (isMain(import.meta.url)) {
  const { positional, flags } = parseArgs(process.argv.slice(2), ['json', 'strict']);
  if (positional.length < 2) { console.error('usage: fanout-coverage.mjs <distDir> <fanout.json> [--hub name] [--json] [--strict]'); process.exit(2); }
  const cfg = readJson(positional[1]);
  const results = cfg.hubs.filter((h) => !flags.hub || h.hub === flags.hub).map((h) => coverage(h, positional[0]));
  if (flags.json) console.log(JSON.stringify(results, null, 2)); else console.log(renderGapTable(...results));
  const gaps = results.reduce((n, r) => n + r.gaps.length, 0), total = results.reduce((n, r) => n + r.rows.length, 0);
  console.log(`fanout-coverage: ${total - gaps}/${total} sub-questions covered, ${gaps} gaps`);
  process.exitCode = flags.strict && gaps ? 1 : 0;
}
