// CLAUDE.md: the brand is "Beyond Paradise Adventures" in full, never shortened — an unrelated
// 2015 film/TV show already holds "Beyond Paradise" as an exact name on Wikidata (Q27959555), so
// the short form costs us the entity match. Audit 2026-11 finding 16 found the short form sitting
// in data/facts/sources.json. It was unrendered, but data/ feeds the pages, so this guards the
// source rather than the output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHORT = /Beyond Paradise(?! Adventures)(?![_\w])/g;

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== 'node_modules' && e !== 'dist' && e !== '.astro') walk(p, out); }
    else out.push(p);
  }
  return out;
}

test('the brand name is never shortened in data/ or site source', () => {
  const files = [...walk(join(root, 'data')), ...walk(join(root, 'site', 'src'))]
    .filter((f) => /\.(json|astro|mjs|js|md|ts)$/.test(f));
  const offenders = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(SHORT)) {
      const line = text.slice(0, m.index).split('\n').length;
      offenders.push(`${relative(root, f)}:${line}`);
    }
  }
  assert.deepEqual(offenders, [], 'write "Beyond Paradise Adventures" in full');
});
