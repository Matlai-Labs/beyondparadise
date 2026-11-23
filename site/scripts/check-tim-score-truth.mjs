// Post-build gate: built pages must not contain claims known to be false (owner does not own Matlai personally,
// no lodge has been stayed in and scored yet). Exit 1 on any finding.
// Usage: node scripts/check-tim-score-truth.mjs [distDir]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (!existsSync(dist)) { console.error('check-tim-score-truth: FAIL dist is missing (run after astro build)'); process.exit(1); }
const banned = ['I own Hotel Matlai', 'stayed in every lodge', 'undisclosable'];
const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.html') ? [join(d, e.name)] : []);
const problems = [];
for (const f of walk(dist)) {
  const html = readFileSync(f, 'utf8');
  for (const b of banned) if (html.includes(b)) problems.push(`${f.slice(dist.length)}: contains "${b}"`);
}
if (problems.length) { console.error(`check-tim-score-truth: FAIL\n - ${problems.join('\n - ')}`); process.exit(1); }
console.log('check-tim-score-truth: ok (no false ownership or stay claims in built pages)');
