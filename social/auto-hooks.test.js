import './test-env.js';
// D: hand-written, approved hooks (auto-hooks.json + auto-hooks.js). Added unapproved, approved by a named person, stale when the claims change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, readHooks, claimsSha256, hookState, approvedHookFor, defaultHooksPath } from './auto-hooks.js';
import { HOOK_MAX } from './fact-post.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-hooks-'));
const claim = (text) => ({ text, ruleId: 'r1', sourceDate: '2026-10-01' });
const IDEA = { id: 'idea_1', sourceId: 'rule:r1', kind: 'rule', topic: 'visa', title: 'Lion rule number 1', claims: [claim('The listed fee for item 1 is 11 US dollars for most visitors.'), claim('Lions are listed in the park guide.')], link: '/x/', score: 9 };
const NOW = new Date('2026-11-17T09:00:00Z');
function setup(ideas = [IDEA]) {
  const dir = tmp(); const file = path.join(dir, 'auto-hooks.json'); fs.writeFileSync(file, JSON.stringify({ hooks: [] }));
  const out = []; const err = []; const deps = { file, loadPool: () => ({ ok: true, ideas, sourceNames: {} }), now: () => NOW, log: (s) => out.push(s), error: (s) => err.push(s) };
  return { file, out, err, deps, run: (argv, over = {}) => main(argv, { ...deps, ...over }), read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('the committed file starts EMPTY and is valid', () => {
  const r = readHooks(defaultHooksPath()); assert.deepEqual(r, { ok: true, hooks: [] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(HERE, 'auto-hooks.json'), 'utf8')), { hooks: [] });
});
test('claimsSha256 covers the claim texts in order: a changed, added, removed or reordered claim changes it; other fields do not', () => {
  const h = claimsSha256(IDEA); assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(claimsSha256({ ...IDEA, title: 'other', score: 1, claims: IDEA.claims.map((c) => ({ ...c, sourceDate: 'x' })) }), h);
  assert.notEqual(claimsSha256({ ...IDEA, claims: [claim('The listed fee for item 1 is 12 US dollars for most visitors.'), IDEA.claims[1]] }), h);
  assert.notEqual(claimsSha256({ ...IDEA, claims: [IDEA.claims[0]] }), h); assert.notEqual(claimsSha256({ ...IDEA, claims: [...IDEA.claims].reverse() }), h);
});
test('--add: writes the entry UNAPPROVED with the claims hash, sourceId and a hook; --list says unapproved', async () => {
  const s = setup(); assert.equal(await s.run(['--add', 'idea_1', 'Lions and the park fee']), 0, s.err.join('\n'));
  assert.deepEqual(s.read().hooks, [{ ideaId: 'idea_1', sourceId: 'rule:r1', hook: 'Lions and the park fee', claimsSha256: claimsSha256(IDEA), approvedBy: null, approvedAt: null }]);
  assert.equal(await s.run(['--list']), 0); assert.match(s.out.join('\n'), /idea_1.*unapproved.*Lions and the park fee/);
});
test('--add refuses: unknown idea, a hook over HOOK_MAX, a figure not in the claims, a failing final check, an empty hook; nothing is written', async () => {
  const s = setup(); const before = fs.readFileSync(s.file, 'utf8');
  for (const [argv, why] of [[['--add', 'idea_nope', 'Lions'], /unknown idea/], [['--add', 'idea_1', 'L'.repeat(HOOK_MAX + 1)], /hook-too-long/], [['--add', 'idea_1', 'Lions pay 99 dollars'], /hook-number-not-in-claims/],
    [['--add', 'idea_1', 'Book now to see lions'], /final-check/], [['--add', 'idea_1', 'Seeing lions at examplehotel'], /final-check/], [['--add', 'idea_1', '   '], /hook/], [['--add', 'idea_1', 'Two\nlines'], /hook/]]) {
    s.err.length = 0; assert.equal(await s.run(argv), 4, JSON.stringify(argv)); assert.match(s.err.join('\n'), why, JSON.stringify(argv)); assert.equal(fs.readFileSync(s.file, 'utf8'), before, JSON.stringify(argv));
  }
  assert.equal(await s.run(['--add', 'idea_1']), 2); assert.equal(await s.run(['--wat']), 2); assert.equal(await s.run([]), 2);
  assert.equal(await s.run(['--add', 'idea_1', 'Lions'], { loadPool: () => ({ ok: false, reason: 'no pool' }) }), 3); assert.equal(fs.readFileSync(s.file, 'utf8'), before);
});
test('--add of a hook with a figure that IS in the claims is accepted', async () => {
  const s = setup(); assert.equal(await s.run(['--add', 'idea_1', 'Lions: 11 US dollars']), 0, s.err.join('\n'));
});
test('--approve sets approvedBy and approvedAt; needs --by; an unknown entry and a stale entry are refused', async () => {
  const s = setup(); await s.run(['--add', 'idea_1', 'Lions and the park fee']); const before = fs.readFileSync(s.file, 'utf8');
  assert.equal(await s.run(['--approve', 'idea_1']), 2); assert.equal(await s.run(['--approve', 'idea_1', '--by', ' ']), 2); assert.equal(await s.run(['--approve', 'idea_nope', '--by', 'owner']), 4); assert.equal(fs.readFileSync(s.file, 'utf8'), before);
  const changed = { ...IDEA, claims: [claim('The listed fee for item 1 is 12 US dollars for most visitors.')] };
  assert.equal(await s.run(['--approve', 'idea_1', '--by', 'owner'], { loadPool: () => ({ ok: true, ideas: [changed], sourceNames: {} }) }), 4); assert.equal(fs.readFileSync(s.file, 'utf8'), before, 'stale: not approved');
  assert.equal(await s.run(['--approve', 'idea_1', '--by', 'owner']), 0, s.err.join('\n')); const e = s.read().hooks[0]; assert.equal(e.approvedBy, 'owner'); assert.equal(e.approvedAt, NOW.toISOString());
  assert.equal(await s.run(['--list']), 0); assert.match(s.out.join('\n'), /idea_1.*\bapproved\b/);
});
test('hookState and approvedHookFor: approved only with a name, a date and a matching hash; unapproved and stale are ignored; ideaId first, then sourceId', () => {
  const e = { ideaId: 'idea_1', sourceId: 'rule:r1', hook: 'H', claimsSha256: claimsSha256(IDEA), approvedBy: 'o', approvedAt: NOW.toISOString() };
  assert.equal(hookState(e, IDEA), 'approved'); assert.equal(hookState({ ...e, approvedBy: null, approvedAt: null }, IDEA), 'unapproved'); assert.equal(hookState({ ...e, claimsSha256: 'a'.repeat(64) }, IDEA), 'stale');
  assert.equal(approvedHookFor(IDEA, [e]).hook, 'H'); assert.equal(approvedHookFor(IDEA, [{ ...e, approvedBy: null, approvedAt: null }]), null); assert.equal(approvedHookFor(IDEA, [{ ...e, claimsSha256: 'a'.repeat(64) }]), null);
  assert.equal(approvedHookFor(IDEA, [{ ...e, ideaId: 'other' }]).hook, 'H', 'matches on sourceId when no ideaId matches'); assert.equal(approvedHookFor(IDEA, [{ ...e, ideaId: 'other', sourceId: 'zzz' }]), null);
  assert.equal(approvedHookFor(IDEA, [{ ...e, hook: 'by source', ideaId: 'other' }, { ...e, hook: 'by id' }]).hook, 'by id', 'an ideaId match is preferred');
  assert.equal(approvedHookFor(IDEA, []), null);
});
test('readHooks fails closed: missing file, bad JSON, wrong shape, malformed entries', () => {
  const dir = tmp(); const f = path.join(dir, 'h.json'); const put = (v) => fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v));
  assert.equal(readHooks(path.join(dir, 'nope.json')).ok, false); put('{not json'); assert.equal(readHooks(f).ok, false);
  const E = { ideaId: 'a', sourceId: null, hook: 'H', claimsSha256: 'a'.repeat(64), approvedBy: null, approvedAt: null };
  for (const bad of [[], { hooks: 'x' }, { hooks: [null] }, { hooks: [{}] }, { hooks: [{ ...E, hook: '' }] }, { hooks: [{ ...E, claimsSha256: 'short' }] }, { hooks: [{ ...E, approvedBy: 'o' }] },
    { hooks: [{ ...E, approvedBy: '', approvedAt: 'x' }] }, { hooks: [{ ...E, ideaId: 7 }] }, { hooks: [{ ...E, approvedBy: 'o', approvedAt: 'not a date' }] }]) {
    put(bad); const r = readHooks(f); assert.equal(r.ok, false, JSON.stringify(bad)); assert.ok(r.reason);
  }
  put({ hooks: [E] }); assert.equal(readHooks(f).ok, true);
});
test('--list on a malformed file refuses (exit 3) rather than printing nothing; the source never calls the network or a model', async () => {
  const s = setup(); fs.writeFileSync(s.file, '{bad'); assert.equal(await s.run(['--list']), 3);
  const src = fs.readFileSync(path.join(HERE, 'auto-hooks.js'), 'utf8').replace(/\/\/.*$/gm, ''); assert.doesNotMatch(src, /\bfetch\(|localAsk|askLocal|captionModel|judgeModel/);
});
