// Guards against fake-author signals (Google, 2026-10: warning about fabricated author profiles).
// 1. No author avatar may point at a stock-photo host.
// 2. Every author/about link in source must resolve to a real page (the old /about/kim/ was a 404).
// 3. Content front-matter authors must be a declared author.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const STOCK = /(unsplash\.com|pexels\.com|pixabay\.com|shutterstock\.com|istockphoto\.com|gettyimages\.|stock\.adobe\.com|picsum\.photos|randomuser\.me|pravatar\.cc|ui-avatars\.com|gravatar\.com|dummyimage\.com|placeholder\.com)/i;

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}
const files = walk(src).filter((f) => /\.(astro|ts|mjs|js|md)$/.test(f));

test('author avatars never use a stock-photo domain', () => {
  const bad = [];
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/\bavatar\w*\s*[:=]\s*['"`]([^'"`]+)['"`]/g)) {
      if (STOCK.test(m[1])) bad.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('AuthorBlock has no stock image anywhere in the file', () => {
  const s = readFileSync(join(src, 'components/AuthorBlock.astro'), 'utf8');
  assert.equal(STOCK.test(s.replace(/\/\/.*$/gm, '')), false);
});

test('every /about/<slug>/ link in source resolves to a real page (no 404 author links)', () => {
  const bad = [];
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/(?:beyondparadiseadventures\.com)?(\/about\/[a-z0-9-]+(?:\/[a-z0-9-]+)*)\/?(?=['"`\s)<])/g)) {
      const rel = m[1].replace(/^\//, '');
      const ok = existsSync(join(src, 'pages', rel, 'index.astro')) || existsSync(join(src, 'pages', rel + '.astro'));
      if (!ok) bad.push(`${f.replace(root, '')}: ${m[1]}/`);
    }
  }
  assert.deepEqual(bad, []);
});

test('content authors are limited to declared authors (no undeclared bylines)', () => {
  const cfg = readFileSync(join(src, 'content/config.ts'), 'utf8');
  const enums = [...cfg.matchAll(/author:\s*z\.enum\(\[([^\]]*)\]\)/g)].map((m) => m[1].replace(/\s/g, ''));
  assert.ok(enums.length > 0);
  for (const e of enums) assert.equal(e, "'tim'");
  for (const f of files.filter((x) => x.includes('/content/') && x.endsWith('.md'))) {
    const m = readFileSync(f, 'utf8').match(/^author:\s*["']?(\w+)["']?/m);
    if (m) assert.equal(m[1], 'tim', f);
  }
});
