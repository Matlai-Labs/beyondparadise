// Post-build gate: the built home page must not claim Asia coverage the site does not have.
// Runs AFTER `astro build` (a pre-build test would read a stale dist). Exit 1 on any finding.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(site, 'dist', 'index.html');
if (!existsSync(file)) { console.error('check-home-asia: FAIL dist/index.html is missing (run after astro build)'); process.exit(1); }
const html = readFileSync(file, 'utf8');

const problems = [];
const banned = [
  [/people who live there/i, '"people who live there" (the site is written from Zanzibar)'],
  [/Zanzibar,\s*Vietnam/, 'a "Zanzibar, Vietnam" table row (there is no Vietnam page)'],
  [/EAST AFRICA\s*·\s*SOUTHEAST ASIA/i, 'the hero label lists Southeast Asia'],
  [/from Zanzibar and Vietnam/i, 'the newsletter text promises content from Vietnam'],
];
for (const [re, what] of banned) if (re.test(html)) problems.push(what);
const prep = (html.match(/starting with Vietnam, is in preparation/g) || []).length;
if (prep !== 1) problems.push(`the "in preparation" sentence appears ${prep} times, expected exactly 1`);

if (problems.length) { console.error(`check-home-asia: FAIL\n - ${problems.join('\n - ')}`); process.exit(1); }
console.log('check-home-asia: ok (home page claims East Africa only; Southeast Asia marked as in preparation once)');
