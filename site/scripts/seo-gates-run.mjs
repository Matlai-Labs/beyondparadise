#!/usr/bin/env node
// Runs the vendored shared SEO/AI gates (scripts/seo-gates/) against dist/ - AFTER `astro build`, beside content-gate + check-links.
//   node scripts/seo-gates-run.mjs [--today YYYY-MM-DD]
// ERROR (exit 1): lib tests, title-gate (max 60), claim-clock, click-depth (max 3).  WARN (never fails): stale-page, data-freshness.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = path.join(SITE, 'scripts', 'seo-gates'), CFG = path.join(SITE, 'scripts', 'seo-gates-config'), DIST = path.join(SITE, 'dist');
const args = process.argv.slice(2);
const ti = args.indexOf('--today');
const today = ti >= 0 ? args[ti + 1] : new Date().toISOString().slice(0, 10);
const lib = (f, a) => spawnSync('node', [path.join(LIB, f), ...a], { cwd: SITE, encoding: 'utf8', maxBuffer: 1 << 28 });
const lines = (r, re) => (r.stdout + r.stderr).split('\n').filter(l => re.test(l));
const last = r => (r.stdout + r.stderr).trim().split('\n').pop();
const results = [];
const gate = (name, level, fn) => {
  let r; try { r = fn(); } catch (e) { r = { ok: false, detail: 'could not run: ' + e.message }; }
  results.push({ name, level, ...r });
  console.log(`\n=== ${name} [${level}] ${r.ok ? 'PASS' : level === 'WARN' ? 'WARN' : 'FAIL'}\n${r.detail}`);
};
if (!fs.existsSync(DIST)) { console.error('seo-gates-run: dist/ missing - run astro build first'); process.exit(2); }

gate('lib-tests', 'ERROR', () => {
  const r = spawnSync('node', ['--test', ...fs.readdirSync(path.join(LIB, 'tests')).filter(f => f.endsWith('.test.mjs')).map(f => path.join('scripts/seo-gates/tests', f))], { cwd: SITE, encoding: 'utf8' });
  return { ok: r.status === 0, detail: lines(r, /^ℹ (tests|pass|fail)/).join('\n') };
});
gate('title-gate', 'ERROR', () => {
  const r = lib('title-gate.mjs', [DIST, '--limits', path.join(CFG, 'title-limits.json')]);
  return { ok: r.status === 0, detail: [...lines(r, /^ERROR/).slice(0, 20), last(r)].join('\n') };
});
gate('claim-clock', 'ERROR', () => {
  const r = lib('claim-clock.mjs', [DIST, path.join(SITE, 'src', 'content'), '--claims', path.join(CFG, 'claims.json'), '--today', today]);
  return { ok: r.status === 0, detail: [...lines(r, /^(ERROR|WARN)/).slice(0, 12), last(r)].join('\n') };
});
gate('click-depth', 'ERROR', () => {
  const r = lib('click-depth.mjs', [DIST, '--max-depth', '3']);
  return { ok: r.status === 0, detail: r.stdout.trim().split('\n').slice(0, 12).join('\n') };
});
gate('stale-page', 'WARN', () => {
  const r = lib('stale-page.mjs', [DIST, '--today', today]);
  return { ok: !/^(ERROR|WARN)/m.test(r.stdout), detail: [...lines(r, /^(ERROR|WARN)/).slice(0, 10), last(r)].join('\n') };
});
gate('data-freshness', 'WARN', () => {
  const M = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const out = []; let stale = 0;
  for (const c of JSON.parse(fs.readFileSync(path.join(CFG, 'data-freshness.json'), 'utf8')).checks) {
    const raw = fs.readFileSync(path.join(SITE, c.file), 'utf8').replace(/<[^>]+>/g, ' ');
    const m = new RegExp(c.pattern, 'i').exec(raw);
    if (!m) { stale++; out.push(`WARN ${c.id}: pattern not found in ${c.file}`); continue; }
    const due = new Date(Date.UTC(+m[2], M.indexOf(m[1].toLowerCase()) + c.everyMonths, 1));
    const late = new Date(today) >= due; if (late) stale++;
    out.push(`${late ? 'WARN' : 'ok  '} ${c.id}: last verified ${m[1]} ${m[2]}, next refresh due ${due.toISOString().slice(0, 7)}`);
  }
  return { ok: stale === 0, detail: out.join('\n') };
});

console.log(`\nseo-gates summary (today ${today}): ${results.map(r => `${r.name}=${r.ok ? 'pass' : r.level === 'WARN' ? 'warn' : 'FAIL'}`).join(' ')}`);
process.exitCode = results.some(r => !r.ok && r.level === 'ERROR') ? 1 : 0;
