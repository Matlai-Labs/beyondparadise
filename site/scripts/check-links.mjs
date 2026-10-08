#!/usr/bin/env node
// Build-time internal link checker. Run AFTER `astro build`.
//   node scripts/check-links.mjs            -> exit 1 on any broken internal link/asset/anchor,
//                                              orphan page, or page deeper than 2 clicks from home
// Scans every dist/**/*.html, resolves each internal href/src against dist/,
// and builds the click graph from "/" to report orphans and depth.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const SITE = 'https://beyondparadiseadventures.com';
const MAX_DEPTH = 2;

if (!fs.existsSync(DIST)) { console.error('dist/ missing - run astro build first'); process.exit(2); }

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    e.isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}
const files = walk(DIST);
const htmlFiles = files.filter(f => f.endsWith('.html'));
const urlOf = f => '/' + path.relative(DIST, f).replace(/index\.html$/, '').replace(/\\/g, '/');

function resolveTarget(pathname) {
  const p = decodeURIComponent(pathname);
  const direct = path.join(DIST, p);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  const idx = path.join(DIST, p, 'index.html');
  if (fs.existsSync(idx)) return idx;
  return null;
}

const attrRe = /<(a|link|img|script|source|meta)\b[^>]*>/gi;
const valRe = /\b(href|src|content)\s*=\s*("([^"]*)"|'([^']*)')/gi;

const pages = new Map(); // url -> { links:Set, ids:Set }
const broken = [];
for (const f of htmlFiles) {
  const html = fs.readFileSync(f, 'utf8');
  const url = urlOf(f);
  const ids = new Set([...html.matchAll(/\bid\s*=\s*"([^"]+)"/g)].map(m => m[1]));
  pages.set(url, { links: new Set(), ids, html, file: f });
}

for (const [url, page] of pages) {
  for (const tag of page.html.matchAll(attrRe)) {
    const t = tag[0];
    const isMeta = /^<meta/i.test(t);
    const isA = /^<a\b/i.test(t);
    if (isMeta && !/(?:property|name)="(?:og:image|twitter:image|og:url)"/i.test(t)) continue;
    for (const m of t.matchAll(valRe)) {
      const attr = m[1].toLowerCase();
      if (isMeta && attr !== 'content') continue;
      if (!isMeta && attr === 'content') continue;
      let v = (m[3] ?? m[4] ?? '').trim();
      if (!v || /^(mailto:|tel:|javascript:|data:)/i.test(v)) continue;
      if (/^https?:\/\//i.test(v)) {
        if (!v.startsWith(SITE)) continue; // external - not checked here
        v = v.slice(SITE.length) || '/';
      } else if (v.startsWith('//')) continue;
      let pathname, hash = '';
      if (v.startsWith('#')) { pathname = url; hash = v.slice(1); }
      else {
        const hi = v.indexOf('#'); if (hi >= 0) { hash = v.slice(hi + 1); v = v.slice(0, hi); }
        v = v.split('?')[0];
        pathname = v.startsWith('/') ? v : new URL(v, 'http://x' + url).pathname;
      }
      const target = resolveTarget(pathname);
      if (!target) { broken.push(`${url} -> ${pathname}${hash ? '#' + hash : ''}  (404)`); continue; }
      if (isA && target.endsWith('.html')) {
        const tu = urlOf(target);
        if (tu !== url) page.links.add(tu);
        if (hash) {
          const tp = pages.get(tu);
          if (tp && !tp.ids.has(hash)) broken.push(`${url} -> ${pathname}#${hash}  (anchor missing)`);
        }
      }
    }
  }
}

// click depth from home
const depth = new Map([['/', 0]]);
const queue = ['/'];
while (queue.length) {
  const u = queue.shift();
  for (const l of pages.get(u)?.links ?? []) {
    if (!depth.has(l)) { depth.set(l, depth.get(u) + 1); queue.push(l); }
  }
}
const unreachable = [...pages.keys()].filter(u => !depth.has(u) && u !== '/404.html' && !/^\/404\//.test(u));
const tooDeep = [...depth].filter(([, d]) => d > MAX_DEPTH);
const inbound = new Map([...pages.keys()].map(u => [u, 0]));
for (const [u, p] of pages) for (const l of p.links) inbound.set(l, (inbound.get(l) ?? 0) + 1);
const orphans = [...inbound].filter(([u, n]) => n === 0 && u !== '/' && !/^\/404/.test(u)).map(([u]) => u);

console.log(`check-links: ${pages.size} pages scanned`);
const byTarget = new Map();
for (const b of new Set(broken)) {
  const [src, rest] = b.split(' -> ');
  const e = byTarget.get(rest) ?? []; e.push(src); byTarget.set(rest, e);
}
console.log(`  broken internal links/assets/anchors: ${new Set(broken).size} (${byTarget.size} distinct targets)`);
for (const [t, srcs] of byTarget) console.log(`    ${t}  <- ${srcs.length} page(s), e.g. ${srcs[0]}`);
console.log(`  orphan pages (0 inbound links): ${orphans.length}`);
for (const o of orphans) console.log('    ' + o);
console.log(`  pages not reachable from home by links: ${unreachable.length}`);
for (const o of unreachable) console.log('    ' + o);
console.log(`  pages deeper than ${MAX_DEPTH} clicks from home: ${tooDeep.length}`);
for (const [u, d] of tooDeep) console.log(`    ${u} (depth ${d})`);
const maxD = Math.max(...depth.values());
console.log(`  max click depth: ${maxD}`);
const fail = broken.length || orphans.length || unreachable.length || tooDeep.length;
console.log(fail ? 'check-links: FAIL' : 'check-links: PASS');
process.exit(fail ? 1 : 0);
