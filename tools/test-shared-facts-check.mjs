// Unit test for scripts/shared-facts-check.mjs (report-only stale-value check against the
// shared Zanzibar facts file). Run: node scripts/test-shared-facts-check.mjs
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadShared, findStale, textBlocks } from './shared-facts-check.mjs';

const shared = { facts: [
  { id: 'zic-validity', key: 'zic.validity', display: '92 days from arrival', staleRegex: [
    { value: '90 days', pattern: '\\b90[- ]?days?\\b', flags: 'iu', context: 'insurance|ZIC', unless: 'visa', note: null }] },
  { id: 'no-rules', key: 'x', display: 'y', staleRegex: [] },
] };
let n = 0; const ok = (name, cond) => { assert.ok(cond, name); n++; console.log('✓ ' + name); };

const hits = findStale('The ZIC insurance is valid for 90 days. The visa is valid 90 days.', shared);
ok('flags a stale value in an insurance sentence', hits.length === 1);
ok('hit carries the matched text, the correct value and the fact id', hits[0].match === '90 days' && hits[0].correct === '92 days from arrival' && hits[0].id === 'zic-validity');
ok('sentence about the visa is not flagged (unless)', findStale('The visa is valid 90 days.', shared).length === 0);
ok('correct value is not flagged', findStale('The ZIC insurance is valid for 92 days.', shared).length === 0);
ok('HTML tags are stripped before matching', findStale('<p>ZIC insurance: <strong>90 days</strong></p>', shared).length === 1);
ok('JSON string walk finds nested strings', textBlocks({ a: { b: ['x', 'ZIC insurance 90 days'] }, n: 5 }).some((s) => /90 days/.test(s)));

const dir = mkdtempSync(join(tmpdir(), 'sf-'));
const p = join(dir, 's.json'); writeFileSync(p, JSON.stringify(shared));
ok('loadShared reads a valid file', loadShared(p).facts.length === 2);
ok('missing file = null (warn, never fail)', loadShared(join(dir, 'nope.json')) === null);
writeFileSync(join(dir, 'bad.json'), '{not json');
ok('corrupt file = null (warn, never fail)', loadShared(join(dir, 'bad.json')) === null);
console.log(`✓ shared-facts-check tests passed (${n})`);
