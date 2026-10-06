#!/usr/bin/env node
// shared-facts-check.mjs — does any post/page still state a value the shared Zanzibar facts
// file says is WRONG?  REPORT-ONLY by default (never fails the build).
//
// Source of truth: shared_knowledge/data/zanzibar-shared-facts.json, written by wildtosea's
// tools/export-shared-facts.mjs from its verified fact DB (curated by wildtosea
// tools/shared-facts.config.json). Never hand-copy a fact into this repo; to share one more,
// add its id to that config. Playbook: shared_knowledge/docs/shared-facts-single-source-playbook.md
//
// Each curated fact carries `staleRegex` rules (old wrong values). Match semantics, per sentence:
//   flag when  context matches AND pattern matches AND NOT unless matches   (flags default "iu")
//
// Scans SOURCE (what builds the site), not dist, so it needs no build:
//   site/src/{content,pages,data,components,layouts}, data/facts (BPA's own fact DB)
//
// Usage
//   node scripts/shared-facts-check.mjs            report (exit 0 always)
//   node scripts/shared-facts-check.mjs --all      no per-fact cap on the printed list
//   node scripts/shared-facts-check.mjs --json     machine-readable hits
//   node scripts/shared-facts-check.mjs --gate     exit 1 on any hit  (see "Flip to gate")
// Flip to gate: add "--gate" to the `build` script in site/package.json (vendored from matlai-site 2026-10-06). Env SHARED_FACTS_PATH overrides the file.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname;
export const DEFAULT_SHARED = '/Users/tim/Desktop/AI_projects/shared_knowledge/data/zanzibar-shared-facts.json';

export function loadShared(path) {
  try {
    if (!existsSync(path)) return null;
    const j = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(j?.facts) ? j : null;
  } catch { return null; }
}

const compile = (r) => {
  const f = r.flags || 'iu';
  return { pattern: new RegExp(r.pattern, f), context: r.context ? new RegExp(r.context, f) : null, unless: r.unless ? new RegExp(r.unless, f) : null };
};

const stripTags = (s) => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
const SENTENCES = /(?<=[.!?。])\s+|\n+/;

export function findStale(text, shared) {
  const out = [];
  const sentences = stripTags(String(text)).split(SENTENCES).filter(Boolean);
  for (const fact of shared.facts) {
    for (const rule of fact.staleRegex ?? []) {
      const { pattern, context, unless } = compile(rule);
      for (const s of sentences) {
        const m = s.match(pattern);
        if (!m || (context && !context.test(s)) || (unless && unless.test(s))) continue;
        out.push({ id: fact.id, key: fact.key, match: m[0], staleValue: rule.value, correct: fact.display ?? fact.value, sentence: s.slice(0, 160) });
      }
    }
  }
  return out;
}

// every string value in parsed JSON (post bodies are HTML inside JSON strings)
export function textBlocks(node, acc = []) {
  if (typeof node === 'string') { if (node.length > 12) acc.push(node); }
  else if (Array.isArray(node)) node.forEach((n) => textBlocks(n, acc));
  else if (node && typeof node === 'object') Object.values(node).forEach((n) => textBlocks(n, acc));
  return acc;
}

const LANGS = new Set(['en', 'de', 'es', 'fr', 'it', 'pl']);
function langOf(rel) {
  const parts = rel.split(sep);
  for (const p of parts) if (LANGS.has(p)) return p;
  return /i18n/.test(rel) ? 'multi' : 'en';
}

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) { if (n !== 'node_modules') yield* walk(p); }
    else if (/\.(json|md|astro|mjs|js)$/.test(n) && st.size < 4_000_000) yield p;
  }
}

export function scan(shared, root = ROOT) {
  const hits = [];
  for (const sub of ['site/src/content', 'site/src/pages', 'site/src/data', 'site/src/components', 'site/src/layouts', 'data/facts']) {
    for (const f of walk(join(root, sub))) {
      const raw = readFileSync(f, 'utf8');
      const blocks = f.endsWith('.json') ? (() => { try { return textBlocks(JSON.parse(raw)); } catch { return [raw]; } })() : [raw];
      const rel = relative(root, f);
      for (const b of blocks) for (const h of findStale(b, shared)) hits.push({ file: rel, lang: langOf(rel), ...h });
    }
  }
  return hits;
}

function main() {
  const args = process.argv.slice(2);
  const path = process.env.SHARED_FACTS_PATH || DEFAULT_SHARED;
  const shared = loadShared(path);
  if (!shared) { console.warn(`⚠ shared-facts-check: ${path} missing or unreadable — skipped (report-only, build unaffected)`); return 0; }
  const hits = scan(shared);
  // identical (file, fact, match) repeats inside one file collapse to one line with a count
  const uniq = new Map();
  for (const h of hits) { const k = `${h.file}|${h.id}|${h.match}`; uniq.set(k, { ...(uniq.get(k) ?? h), n: (uniq.get(k)?.n ?? 0) + 1 }); }
  const list = [...uniq.values()];
  if (args.includes('--json')) { console.log(JSON.stringify({ facts: shared.facts.length, hits: list }, null, 2)); return args.includes('--gate') && list.length ? 1 : 0; }
  console.log(`shared facts: ${shared.facts.length} curated facts (${shared._meta?.contentHash ?? '?'}) checked against source in ${new Set(list.map((h) => h.file)).size || 0} file(s) with hits`);
  if (!list.length) { console.log('✓ no source text states a value the shared facts mark as stale.'); return 0; }
  console.log(`⚠ ${list.length} stale value(s) — REPORT-ONLY (flip: SHARED_FACTS_GATE=1)\n`);
  const byFact = {};
  for (const h of list) (byFact[h.id] = byFact[h.id] || []).push(h);
  const cap = args.includes('--all') ? Infinity : 15;
  for (const [id, hs] of Object.entries(byFact).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`▸ ${id} — correct: ${hs[0].correct} — ${hs.length} hit(s)`);
    for (const h of hs.slice(0, cap)) console.log(`    [${h.lang}] ${h.file}  "${h.match}"${h.n > 1 ? ` ×${h.n}` : ''}\n      ${h.sentence}`);
    if (hs.length > cap) console.log(`    …and ${hs.length - cap} more (--all)`);
  }
  return args.includes('--gate') ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main());
