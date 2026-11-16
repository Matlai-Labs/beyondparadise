import './test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadHookTypes, classifyHook, hookAdvice } from './hookpatterns.js';
import { validate } from './sync-hook-patterns.js';

const tmp = (content) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-hp-')), 'hook-patterns.json'); if (content !== undefined) fs.writeFileSync(f, content); return f; };
const GOOD = JSON.stringify({ schema: 1, patterns: [
  { hook_type: 'unknown', count: 20 }, { hook_type: 'question', count: 3 }, { hook_type: 'bold-claim', count: 5 }, { hook_type: 'bold-claim', count: 4 }, { hook_type: 'other', count: 9 },
] });

test('loadHookTypes sums by type, drops unknown/other, most frequent first', () => {
  assert.deepEqual(loadHookTypes(tmp(GOOD)), ['bold-claim', 'question']);
});

test('OPTIONAL: missing, malformed or wrong-shape file gives no types and no advice, and never throws', () => {
  for (const f of [path.join(os.tmpdir(), 'nope-bpa.json'), tmp('{ broken'), tmp('{"schema":1}'), tmp('null'), tmp('')]) {
    assert.deepEqual(loadHookTypes(f), []);
    assert.equal(hookAdvice('Why is Zanzibar quiet in May?', loadHookTypes(f)), '');
  }
});

test('classifyHook labels first lines with the store vocabulary', () => {
  assert.equal(classifyHook('How many nights do you need in Mafia Island?'), 'how-to');
  assert.equal(classifyHook('Is April really the worst month for Zanzibar?'), 'question');
  assert.equal(classifyHook('Stop booking Zanzibar in August'), 'warning-or-contrarian');
  assert.equal(classifyHook('We counted every arrival in August'), 'story');
  assert.equal(classifyHook('Zanzibar arrivals up 12% in August'), 'bold-claim');
  assert.equal(classifyHook('Iberostar Selection Zanzibar'), 'other');
  assert.equal(classifyHook(''), 'other');
  assert.equal(classifyHook('#tag #another'), 'other');
});

test('hookAdvice says whether the style is a top pattern', () => {
  const top = ['bold-claim', 'question'];
  assert.equal(hookAdvice('Zanzibar arrivals up 12% in August', top), 'hook style: bold-claim (a top pattern)');
  assert.equal(hookAdvice('Iberostar Selection Zanzibar', top), 'hook style: other (top patterns: bold-claim, question)');
});

test('sync validate accepts schema 1 only', () => {
  assert.ok(validate(GOOD));
  assert.throws(() => validate('{"schema":2,"patterns":[]}'), /schema-1/);
  assert.throws(() => validate('nope'));
});

test('the COMMITTED hook-patterns.json is an empty list and behaves exactly like an absent file', async () => {
  const { DEFAULT_FILE } = await import('./hookpatterns.js');
  const committed = JSON.parse(fs.readFileSync(DEFAULT_FILE, 'utf8'));
  assert.deepEqual(committed.patterns, []);
  const absent = path.join(os.tmpdir(), 'bpa-hp-definitely-absent.json');
  assert.deepEqual(loadHookTypes(DEFAULT_FILE), loadHookTypes(absent));
  assert.deepEqual(loadHookTypes(DEFAULT_FILE), []);
  for (const t of ['Zanzibar arrivals up 12% in August', 'Why is Zanzibar quiet in May?', 'Iberostar Selection Zanzibar']) {
    assert.equal(hookAdvice(t, loadHookTypes(DEFAULT_FILE)), hookAdvice(t, loadHookTypes(absent)));
    assert.equal(hookAdvice(t, loadHookTypes(DEFAULT_FILE)), '');
  }
  const txt = fs.readFileSync(DEFAULT_FILE, 'utf8');
  assert.doesNotMatch(txt, /instagram\.com|@\w/, 'no third-party handles or URLs in the public file');
});

// sync copy path: refuses a source that was not exported in reviewed mode (SOURCE/TARGET are read at import, so import fresh with the env set)
let importN = 0;
async function runSync(source, target, check = false) {
  process.env.HOOK_PATTERNS_SOURCE = source; process.env.HOOK_PATTERNS_FILE = target;
  try { const m = await import(`./sync-hook-patterns.js?run=${++importN}`); return m.sync({ check }); }
  finally { delete process.env.HOOK_PATTERNS_SOURCE; delete process.env.HOOK_PATTERNS_FILE; }
}
const REVIEWED = JSON.stringify({ schema: 1, generated_at: 'x', source_count: 1, reviewed_only: true, patterns: [] });

test('sync refuses a source that is not reviewed_only true and leaves an existing target byte-identical', async () => {
  const src = tmp(), dst = tmp(REVIEWED);
  for (const body of [{ schema: 1, source_count: 1, patterns: [] }, { schema: 1, source_count: 1, reviewed_only: false, patterns: [] }]) {
    fs.writeFileSync(src, JSON.stringify(body));
    await assert.rejects(() => runSync(src, dst), /reviewed mode/);
    assert.equal(fs.readFileSync(dst, 'utf8'), REVIEWED);
  }
});

test('sync copies a reviewed_only source, and --check still accepts the copy', async () => {
  const src = tmp(REVIEWED), dst = path.join(path.dirname(tmp()), 'out', 'hook-patterns.json');
  assert.match(await runSync(src, dst), /^copied /);
  assert.equal(fs.readFileSync(dst, 'utf8'), REVIEWED);
  assert.match(await runSync(src, dst, true), /^ok: /);
});

test('sync --check accepts a copy without reviewed_only (validate stays schema-only)', async () => {
  const dst = tmp(JSON.stringify({ schema: 1, patterns: [] }));
  assert.match(await runSync(tmp(), dst, true), /^ok: /);
});
