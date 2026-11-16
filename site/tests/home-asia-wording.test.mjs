// Home page must not imply Asia coverage that does not exist (audit 2026-11-16).
// East Africa is covered; Southeast Asia, starting with Vietnam, is in preparation. Wording only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(join(site, 'src', 'components', f), 'utf8');
const HOME = ['HeroSection.astro', 'Footer.astro', 'NewsletterCTA.astro', 'IntelligenceSection.astro'];
const NEW_SENTENCE = 'Southeast Asia, starting with Vietnam, is in preparation.';

test('hero label no longer lists Southeast Asia', () => {
  assert.doesNotMatch(src('HeroSection.astro'), /SOUTHEAST ASIA/i);
});

test('footer does not say "written by people who live there"', () => {
  const t = src('Footer.astro');
  assert.doesNotMatch(t, /people who live there/i);
  assert.match(t, /Written from Zanzibar, where we live/);
  assert.doesNotMatch(t, /for East Africa and Southeast Asia/);
});

test('newsletter promises no Asia content and no "directly from Vietnam"', () => {
  const t = src('NewsletterCTA.astro');
  assert.doesNotMatch(t, /Vietnam/i);
  assert.doesNotMatch(t, /Southeast Asia Report/i);
});

test('When to Go table has no Vietnam row text', () => {
  assert.doesNotMatch(src('IntelligenceSection.astro'), /Vietnam/i);
});

test('the "in preparation" sentence appears exactly once across the home page sources', () => {
  const n = HOME.map(src).join('\n').split(NEW_SENTENCE).length - 1;
  assert.equal(n, 1);
});

test('built dist/index.html (when present) has no Vietnam row and no "people who live there"', (t) => {
  const f = join(site, 'dist', 'index.html');
  if (!existsSync(f)) return t.skip('dist not built yet; scripts/check-home-asia.mjs runs after astro build');
  const html = readFileSync(f, 'utf8');
  assert.doesNotMatch(html, /people who live there/i);
  assert.doesNotMatch(html, /Zanzibar, Vietnam/);
  assert.doesNotMatch(html, /Directly from Zanzibar and Vietnam/);
});
