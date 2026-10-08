#!/usr/bin/env node
// click-depth: BFS from "/" over built HTML. Reports pages deeper than --max-depth, orphans (0 inlinks) and unreachable pages.
// Usage: node click-depth.mjs <distDir> [--max-depth 3] [--allow /thanks,/privacy*] [--json]
// Exit: 0 clean, 1 findings, 2 usage error.
import path from 'node:path';
import fs from 'node:fs';
import { walk, parseArgs, isMain } from './lib/fs.mjs';
import { parseHtml, fileToPath, resolveInternal, readText } from './lib/html.mjs';

const globToRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

export function analyzeClickDepth(distDir, { maxDepth = 3, allow = [], roots = null } = {}) {
  const allowRe = allow.map(globToRe);
  const isAllowed = (p) => allowRe.some((r) => r.test(p));
  const pages = new Map(); // path -> parsed
  for (const f of walk(distDir, ['.html', '.htm'])) {
    const p = fileToPath(distDir, f);
    if (p === '/404' || p.endsWith('/404')) continue;
    const info = parseHtml(readText(f));
    if (info.refresh) continue; // redirect stub
    if (pages.has(p)) continue;
    pages.set(p, info);
  }
  // origins: canonical origins seen on pages count as "self"
  const origins = new Set();
  for (const info of pages.values()) { try { if (info.canonical) origins.add(new URL(info.canonical).origin); } catch {} }
  const graph = new Map(); const inlinks = new Map();
  for (const [p, info] of pages) {
    const out = new Set();
    for (const h of info.links) {
      const t = resolveInternal(h, p, [...origins]);
      if (t && t !== p && pages.has(t)) out.add(t);
    }
    graph.set(p, out);
    for (const t of out) (inlinks.get(t) || inlinks.set(t, new Set()).get(t)).add(p);
  }
  const depth = {}; const via = {};
  // start at "/"; sites whose "/" is only a language redirect (no index page) start from the language roots (/en, /de ...)
  const startPaths = roots || (pages.has('/') ? ['/'] : [...pages.keys()].filter((p) => /^\/[a-z]{2}$/.test(p)));
  {
    const q = [];
    for (const r of startPaths) if (pages.has(r)) { depth[r] = 0; q.push(r); }
    while (q.length) {
      const cur = q.shift();
      for (const n of graph.get(cur) || []) if (!(n in depth)) { depth[n] = depth[cur] + 1; via[n] = cur; q.push(n); }
    }
  }
  const indexable = [...pages.keys()].filter((p) => !pages.get(p).noindex);
  const deep = Object.entries(depth).filter(([p, d]) => d > maxDepth && !pages.get(p).noindex && !isAllowed(p)).map(([p, d]) => ({ path: p, depth: d, via: via[p] })).sort((a, b) => b.depth - a.depth || a.path.localeCompare(b.path));
  const orphans = indexable.filter((p) => !startPaths.includes(p) && !(inlinks.get(p)?.size) && !isAllowed(p)).sort();
  const unreachable = indexable.filter((p) => !(p in depth) && !isAllowed(p)).sort();
  const hist = {}; for (const d of Object.values(depth)) hist[d] = (hist[d] || 0) + 1;
  return { roots: startPaths, pages: [...pages.keys()].sort(), indexable: indexable.length, depth, deep, orphans, unreachable, histogram: hist, maxDepth };
}

if (isMain(import.meta.url)) {
  const { positional, flags } = parseArgs(process.argv.slice(2), ['json']);
  if (!positional[0] || !fs.existsSync(positional[0])) { console.error('usage: click-depth.mjs <distDir> [--max-depth 3] [--allow a,b] [--root /en,/de] [--json]'); process.exit(2); }
  const r = analyzeClickDepth(positional[0], { maxDepth: flags['max-depth'] ? +flags['max-depth'] : 3, allow: flags.allow ? String(flags.allow).split(',') : [], roots: flags.root ? String(flags.root).split(',') : null });
  if (flags.json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`click-depth: ${r.pages.length} pages (${r.indexable} indexable), max-depth ${r.maxDepth}`);
    console.log('depth histogram:', JSON.stringify(r.histogram));
    console.log(`DEEP (> ${r.maxDepth} clicks): ${r.deep.length}`); r.deep.slice(0, 40).forEach((d) => console.log(`  depth ${d.depth}  ${d.path}  (via ${d.via})`));
    console.log(`ORPHANS (0 inlinks): ${r.orphans.length}`); r.orphans.slice(0, 40).forEach((p) => console.log('  ' + p));
    console.log(`UNREACHABLE from /: ${r.unreachable.length}`); r.unreachable.slice(0, 40).forEach((p) => console.log('  ' + p));
  }
  process.exitCode = r.deep.length || r.orphans.length || r.unreachable.length ? 1 : 0;
}
