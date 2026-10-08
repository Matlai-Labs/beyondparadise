#!/usr/bin/env node
// IndexNow submission (free; Bing, Yandex, Seznam, Naver). Run AFTER deploy.
//   node scripts/indexnow-submit.mjs            dry run: prints what would be sent
//   node scripts/indexnow-submit.mjs --send     verifies the live key file, then POSTs the sitemap URLs
// The key is the 32-hex file name in public/ (<key>.txt, containing the key). It is a public
// verification token, not a secret. Google does not use IndexNow; use Search Console for Google.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'beyondparadiseadventures.com';
const SEND = process.argv.includes('--send');

const keyFile = fs.readdirSync(path.join(ROOT, 'public')).find(f => /^[a-f0-9]{32}\.txt$/.test(f));
if (!keyFile) { console.error('No IndexNow key file (<32 hex>.txt) in public/'); process.exit(2); }
const key = keyFile.replace('.txt', '');
if (fs.readFileSync(path.join(ROOT, 'public', keyFile), 'utf8').trim() !== key) { console.error('Key file content does not match its name'); process.exit(2); }

const sitemap = path.join(ROOT, 'dist', 'sitemap-0.xml');
if (!fs.existsSync(sitemap)) { console.error('dist/sitemap-0.xml missing - run the build first'); process.exit(2); }
const urls = [...fs.readFileSync(sitemap, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
const keyLocation = `https://${HOST}/${keyFile}`;
console.log(`IndexNow: ${urls.length} URLs, key ${key}, keyLocation ${keyLocation}`);

if (!SEND) { console.log('dry run (pass --send to submit). First 3 URLs:\n  ' + urls.slice(0, 3).join('\n  ')); process.exit(0); }

const live = await fetch(keyLocation).then(r => (r.ok ? r.text() : null)).catch(() => null);
if (!live || live.trim() !== key) { console.error(`Key file is not live at ${keyLocation} yet - deploy first. Not sending.`); process.exit(1); }
const res = await fetch('https://api.indexnow.org/IndexNow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: HOST, key, keyLocation, urlList: urls }),
});
console.log(`IndexNow response: HTTP ${res.status} (200/202 = accepted)`);
process.exit(res.status === 200 || res.status === 202 ? 0 : 1);
