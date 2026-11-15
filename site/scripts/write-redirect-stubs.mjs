#!/usr/bin/env node
// Writes the redirect stubs for retired URLs into dist/ AFTER the build and its gates have passed.
// GitHub Pages cannot send 301s, so each retired URL is a tiny page: canonical to the merged page,
// instant meta refresh + JS fallback. No noindex: it would block the page instead of passing it on. They are not Astro pages on purpose: they are not content
// (the build gates would count them as unlinked pages), and they must never be in the sitemap.
// Called by deploy.sh. Also runnable alone:  node scripts/write-redirect-stubs.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RETIRED } from '../src/lib/retired-redirects.mjs';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const SITE = 'https://beyondparadiseadventures.com';
if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.error('write-redirect-stubs: dist/ missing, run the build first'); process.exit(2); }
for (const [slug, to] of Object.entries(RETIRED)) {
  if (!fs.existsSync(path.join(DIST, to, 'index.html'))) { console.error(`write-redirect-stubs: target ${to} is not built`); process.exit(1); }
  const dir = path.join(DIST, 'excursions', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Page moved</title>
<link rel="canonical" href="${SITE}${to}">
<meta http-equiv="refresh" content="0; url=${to}">
<script>/* fallback only; the meta refresh above is the redirect */window.location.replace(${JSON.stringify(to)} + location.search + location.hash);</script>
</head>
<body>
<p>This page has moved to <a href="${to}">${SITE}${to}</a>.</p>
</body>
</html>
`);
}
console.log(`write-redirect-stubs: wrote ${Object.keys(RETIRED).length} stubs`);
