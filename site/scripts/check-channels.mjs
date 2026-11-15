#!/usr/bin/env node
// Build-time channel check. Run AFTER `astro build`. Exit 1 on any failure.
// Source of truth: src/lib/channels.mjs. For every built page that has a footer it requires:
//   - all channel links in the footer, with the exact URL and rel containing "me" and "noopener"
//   - an Organization JSON-LD block whose sameAs equals organizationSameAs() exactly
// and across ALL built HTML, no link to a channel host in a spelling the data file does not hold.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { channels, organizationSameAs } from '../src/lib/channels.mjs';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (!fs.existsSync(DIST)) { console.error('dist/ missing - run astro build first'); process.exit(2); }

const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    e.isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
};
const pages = walk(DIST).filter((f) => f.endsWith('.html'));
const known = new Set(channels.map((c) => c.url));
const hostRe = /^https?:\/\/(?:www\.)?(?:facebook\.com|instagram\.com|youtube\.com)\b/i;
const expectedSameAs = JSON.stringify(organizationSameAs());
const errors = [];
let withFooter = 0, withAll = 0, withOrg = 0;

for (const f of pages) {
  const rel = '/' + path.relative(DIST, f).replace(/index\.html$/, '');
  const html = fs.readFileSync(f, 'utf8');
  for (const m of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi)) {
    if (hostRe.test(m[1]) && !known.has(m[1])) errors.push(`${rel}: link ${m[1]} is not a spelling held in channels.mjs`);
  }
  const footer = html.match(/<footer\b[^>]*role="contentinfo"[\s\S]*?<\/footer>/i)?.[0];
  if (!footer) continue; // redirect stubs have no site footer (a page may hold other <footer> elements, e.g. a quote)
  withFooter++;
  const missing = [];
  for (const c of channels) {
    const a = [...footer.matchAll(/<a\b[^>]*>/gi)].map((x) => x[0]).find((t) => t.includes(`href="${c.url}"`));
    if (!a) { missing.push(c.id); continue; }
    const relAttr = a.match(/\brel="([^"]*)"/)?.[1] ?? '';
    if (!/\bme\b/.test(relAttr) || !/\bnoopener\b/.test(relAttr)) errors.push(`${rel}: ${c.id} link lacks rel="me noopener" (has "${relAttr}")`);
    if (!/\baria-label="[^"]+"/.test(a)) errors.push(`${rel}: ${c.id} link has no aria-label`);
  }
  if (missing.length) errors.push(`${rel}: footer missing ${missing.join(', ')}`); else withAll++;

  let orgOk = false;
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let j; try { j = JSON.parse(m[1]); } catch { continue; }
    if (j && j['@type'] === 'Organization' && j['@id']) {
      if (JSON.stringify(j.sameAs) === expectedSameAs) orgOk = true;
      else errors.push(`${rel}: Organization sameAs differs from channels.mjs: ${JSON.stringify(j.sameAs)}`);
    }
  }
  if (orgOk) withOrg++; else if (!errors.some((e) => e.startsWith(rel + ': Organization'))) errors.push(`${rel}: no Organization JSON-LD with sameAs`);
}

console.log(`check-channels: ${pages.length} html files, ${withFooter} with a footer, ${withAll} carry all ${channels.length} channel links, ${withOrg} carry the Organization sameAs`);
if (withFooter === 0) errors.push('no page with a footer found');
if (errors.length) { console.error(errors.slice(0, 30).join('\n')); console.error(`check-channels: FAIL (${errors.length} problem(s))`); process.exit(1); }
console.log('check-channels: ok');
