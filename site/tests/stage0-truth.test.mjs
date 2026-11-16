// Stage 0 truth guards: the site must not state income, paid links or visits that do not exist.
// 1. No present-tense claim of commission / affiliate income anywhere in site/src or site/public.
//    Matched: "earn(s) (an) (affiliate) commission", "We earn commission", "Affiliate links may appear",
//    "Affiliate revenue", and the named programmes GetYourGuide / Viator / Stay22.
//    NOT matched: future rules such as "we will label any paid link" and the denial
//    "plain link, not an affiliate link; earns nothing".
// 2. The editorial policy carries the exact no-income sentence.
// 3. The footer carries "No paid reviews. No hosted stays." and no affiliate line.
// 4. No review carries a score while its lodge is tim_visited:false (derived via lodge_id).
// 5. No operator is "verified" with a score context while no visit is recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(root, '..');

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

export const INCOME_CLAIM = /\bearns?\s+(an?\s+)?(affiliate\s+)?commission|we earn commission|affiliate links may appear|affiliate revenue|getyourguide|viator|stay22/i;

export function findIncomeClaims(files) {
  const hits = [];
  for (const f of files) {
    if (!/\.(astro|ts|js|mjs|md|mdx|txt|json|html|xml|svg)$/i.test(f)) continue;
    const m = readFileSync(f, 'utf8').match(INCOME_CLAIM);
    if (m) hits.push(`${f}: ${m[0]}`);
  }
  return hits;
}

export function frontMatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const fm = {};
  if (!m) return fm;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1');
  }
  return fm;
}

export function findUnvisitedScoredReviews(reviewsDir, lodges) {
  const bad = [];
  for (const f of walk(reviewsDir)) {
    if (!/\.mdx?$/.test(f)) continue;
    const fm = frontMatter(readFileSync(f, 'utf8'));
    const hasScore = fm.tim_score !== undefined && fm.tim_score !== '' && fm.tim_score !== 'null';
    const lodge = lodges.find((l) => l.id === fm.lodge_id);
    if (hasScore && (!lodge || lodge.tim_visited !== true)) bad.push(`${f}: score ${fm.tim_score}, lodge ${fm.lodge_id}`);
  }
  return bad;
}

export function findVerifiedWithoutVisit(operators) {
  return operators
    .filter((o) => o.status === 'verified' && o.tim_score_context != null && o.tim_score_context !== '' && o.tim_visited !== true)
    .map((o) => o.id);
}

test('no commission / affiliate income claim in site/src or site/public', () => {
  const files = [...walk(join(root, 'src')), ...walk(join(root, 'public'))];
  assert.deepEqual(findIncomeClaims(files), []);
});

test('income-claim pattern fires on a fixture and ignores a future rule', () => {
  const d = mkdtempSync(join(tmpdir(), 'bpa-'));
  try {
    writeFileSync(join(d, 'a.astro'), '<p>We earn commission on links.</p>');
    writeFileSync(join(d, 'b.astro'), '<p>If that ever changes, we will label every paid link.</p>');
    assert.equal(findIncomeClaims([join(d, 'a.astro'), join(d, 'b.astro')]).length, 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('editorial policy states that the site earns no money', () => {
  const t = readFileSync(join(root, 'src/pages/about/editorial-policy/index.astro'), 'utf8');
  assert.ok(t.includes('Today Beyond Paradise Adventures earns no money from this site. No page carries a paid link, and no lodge, operator or platform pays us.'));
  assert.ok(t.includes('Last updated: 17 November 2026'));
});

test('footer says no paid reviews, no hosted stays, and no affiliate line', () => {
  const t = readFileSync(join(root, 'src/components/Footer.astro'), 'utf8');
  assert.ok(t.includes('No paid reviews. No hosted stays.'));
  assert.ok(!t.includes('Affiliate links may appear'));
});

const lodges = JSON.parse(readFileSync(join(repo, 'data/lodges/lodges.json'), 'utf8')).lodges;
const operators = JSON.parse(readFileSync(join(repo, 'data/operators/operators.json'), 'utf8')).operators;

test('no review carries a score for a lodge nobody visited', () => {
  assert.deepEqual(findUnvisitedScoredReviews(join(root, 'src/content/reviews'), lodges), []);
});

test('unvisited-score check fires on a fixture review and passes a visited lodge', () => {
  const d = mkdtempSync(join(tmpdir(), 'bpa-'));
  try {
    writeFileSync(join(d, 'x.md'), '---\nlodge_id: "x"\ntim_score: 90\ndraft: true\n---\nbody');
    assert.equal(findUnvisitedScoredReviews(d, [{ id: 'x', tim_visited: false }]).length, 1);
    assert.equal(findUnvisitedScoredReviews(d, [{ id: 'x', tim_visited: true }]).length, 0);
    assert.equal(findUnvisitedScoredReviews(d, []).length, 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('no operator is verified with a score context and no recorded visit', () => {
  assert.deepEqual(findVerifiedWithoutVisit(operators), []);
});

test('operator check fires on a fixture', () => {
  assert.deepEqual(findVerifiedWithoutVisit([{ id: 'a', status: 'verified', tim_score_context: 90 }]), ['a']);
  assert.deepEqual(findVerifiedWithoutVisit([{ id: 'a', status: 'verified', tim_score_context: 90, tim_visited: true }]), []);
  assert.deepEqual(findVerifiedWithoutVisit([{ id: 'a', status: 'pending-verification' }]), []);
});

// 6. No operator names an on-site visit as a source, or carries a verified date, while no visit is recorded.
//    Matched: the word "visit" in verification_sources, or a non-empty verified_date, with tim_visited not true.
export function findVisitSourceWithoutVisit(operators) {
  return operators
    .filter((o) => o.tim_visited !== true)
    .filter((o) => (o.verification_sources || []).some((s) => /\bvisit/i.test(s)) || (o.verified_date != null && o.verified_date !== ''))
    .map((o) => o.id);
}

test('no operator claims a visit as a source or a verified date without a recorded visit', () => {
  assert.deepEqual(findVisitSourceWithoutVisit(operators), []);
});

test('visit-source check fires on a fixture', () => {
  assert.deepEqual(findVisitSourceWithoutVisit([{ id: 'a', verification_sources: ['On-site visit 2025'] }]), ['a']);
  assert.deepEqual(findVisitSourceWithoutVisit([{ id: 'a', verified_date: '2026-06-27', tim_visited: false }]), ['a']);
  assert.deepEqual(findVisitSourceWithoutVisit([{ id: 'a', verification_sources: ['On-site visit 2025'], verified_date: '2026-01-01', tim_visited: true }]), []);
  assert.deepEqual(findVisitSourceWithoutVisit([{ id: 'a', verification_sources: ['Annual report (public)'], verified_date: null }]), []);
});
