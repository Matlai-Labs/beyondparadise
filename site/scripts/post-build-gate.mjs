#!/usr/bin/env node
// Post-build, pre-publish gate. deploy.sh runs it after the build and the redirect stubs, before pushing.
// Fails closed (exit 1) when the built dist/ is not what the live site must be:
//   - the Google or Bing verification tag is missing from dist/index.html (they come from the git-ignored site/.env,
//     so a fresh clone / other machine / worktree silently drops them)
//   - any retired-URL stub is missing, lacks its canonical to the merged page or its meta refresh, or carries noindex
// Usage: node scripts/post-build-gate.mjs [distDir]      |      node scripts/post-build-gate.mjs --self-test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RETIRED } from '../src/lib/retired-redirects.mjs';

const SITE = 'https://beyondparadiseadventures.com';
export function check(dist) {
  const errors = [];
  const read = f => { try { return fs.readFileSync(path.join(dist, f), 'utf8'); } catch { return null; } };
  const home = read('index.html');
  if (home === null) return ['dist/index.html missing'];
  if (!/<meta[^>]+name="google-site-verification"[^>]+content="[^"]+"/i.test(home)) errors.push('Google verification tag missing from index.html (PUBLIC_GSC_VERIFICATION not set in site/.env?)');
  if (!/<meta[^>]+name="msvalidate\.01"[^>]+content="[^"]+"/i.test(home)) errors.push('Bing verification tag missing from index.html (PUBLIC_BING_VERIFICATION not set in site/.env?)');
  for (const [slug, to] of Object.entries(RETIRED)) {
    const h = read(`excursions/${slug}/index.html`);
    if (h === null) { errors.push(`stub missing: /excursions/${slug}/`); continue; }
    if (!h.includes(`<link rel="canonical" href="${SITE}${to}">`)) errors.push(`stub ${slug}: canonical to ${to} missing`);
    if (!new RegExp(`<meta http-equiv="refresh" content="0; url=${to.replace(/[/.]/g, '\\$&')}">`).test(h)) errors.push(`stub ${slug}: instant meta refresh to ${to} missing`);
    if (/noindex/i.test(h)) errors.push(`stub ${slug}: carries noindex (must not)`);
  }
  return errors;
}

function selfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbg-'));
  const mk = (name, mut) => {
    const d = path.join(tmp, name);
    fs.mkdirSync(d, { recursive: true });
    let home = '<html><head><meta name="google-site-verification" content="g"><meta name="msvalidate.01" content="b"></head></html>';
    fs.writeFileSync(path.join(d, 'index.html'), home);
    for (const [slug, to] of Object.entries(RETIRED)) {
      fs.mkdirSync(path.join(d, 'excursions', slug), { recursive: true });
      fs.writeFileSync(path.join(d, 'excursions', slug, 'index.html'), `<head><link rel="canonical" href="${SITE}${to}"><meta http-equiv="refresh" content="0; url=${to}"></head>`);
    }
    mut?.(d);
    return d;
  };
  const first = Object.keys(RETIRED)[0];
  const stub = d => path.join(d, 'excursions', first, 'index.html');
  const cases = [
    ['good build passes', null, true],
    ['no google tag', d => fs.writeFileSync(path.join(d, 'index.html'), '<meta name="msvalidate.01" content="b">'), false],
    ['no bing tag', d => fs.writeFileSync(path.join(d, 'index.html'), '<meta name="google-site-verification" content="g">'), false],
    ['stub file missing', d => fs.rmSync(path.join(d, 'excursions', first), { recursive: true }), false],
    ['stub without canonical', d => fs.writeFileSync(stub(d), `<meta http-equiv="refresh" content="0; url=${RETIRED[first]}">`), false],
    ['stub without refresh', d => fs.writeFileSync(stub(d), `<link rel="canonical" href="${SITE}${RETIRED[first]}">`), false],
    ['stub with noindex', d => fs.appendFileSync(stub(d), '<meta name="robots" content="noindex">'), false],
  ];
  let bad = 0;
  for (const [name, mut, shouldPass] of cases) {
    const errs = check(mk(name.replace(/\W+/g, '-'), mut));
    const ok = shouldPass ? errs.length === 0 : errs.length > 0;
    if (!ok) bad++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} self-test: ${name} -> ${errs.length ? 'rejected' : 'passed'}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(bad ? `post-build-gate self-test: FAIL (${bad})` : `post-build-gate self-test: PASS (${cases.length} cases)`);
  process.exit(bad ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--self-test') selfTest();
  const dist = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
  const errs = check(dist);
  errs.forEach(e => console.error('  ERROR ' + e));
  console.log(errs.length ? `post-build-gate: FAIL (${errs.length})` : 'post-build-gate: PASS (verification tags + 7 redirect stubs)');
  process.exit(errs.length ? 1 : 0);
}
