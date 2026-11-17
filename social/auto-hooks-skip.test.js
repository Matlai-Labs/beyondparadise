import './test-env.js';
// Step 2, task 2: the hook state "skipped", one shared choice of entry, one lock for every writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, hookState, approvedHookFor, shownEntry, readHooks, writeHooksAtomic, claimsSha256, REVIEW_BY } from './auto-hooks.js';
import { hookFor } from './auto-lane.js';
import { buildItems } from './review-items.js';
import { withDecisionLock } from './decision-lock.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = new Date('2026-11-17T09:00:00Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-hooks-skip-'));
const claim = (text) => ({ text, ruleId: 'r1', sourceDate: '2026-10-01' });
const idea = (n) => ({ id: `idea_${n}`, sourceId: `rule:r${n}`, kind: 'rule', topic: 'visa', title: `Lion rule number ${n}`, claims: [claim(`The listed fee for item ${n} is ${n + 10} US dollars for most visitors.`)], link: '/x/', score: 9 });
const entry = (n, over = {}) => ({ ideaId: `idea_${n}`, sourceId: null, hook: `Hook ${n}`, claimsSha256: claimsSha256(idea(n)), approvedBy: null, approvedAt: null, ...over });
const tmpFile = (obj) => { const f = path.join(tmp(), 'h.json'); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
let out = []; let err = [];
const run = (argv, deps) => { out = []; err = []; return main(argv, { now: () => NOW, log: out.push.bind(out), error: err.push.bind(err), ...deps }); };
const pool3 = () => ({ ok: true, ideas: [idea(1), idea(2), idea(3)], sourceNames: {} });
const SK = { by: 'review page', at: '2026-11-17T09:00:00Z' };
const APP = { approvedBy: 'review page', approvedAt: '2026-11-17T09:00:00Z' };

test('REVIEW_BY is the constant label', () => assert.equal(REVIEW_BY, 'review page'));
test('hookState: skipped beats approved and unapproved; stale beats skipped', () => { const sk = SK;
  assert.equal(hookState(entry(1, { skipped: sk }), idea(1)), 'skipped'); assert.equal(hookState(entry(1, { skipped: sk, approvedBy: 't', approvedAt: sk.at }), idea(1)), 'skipped');
  assert.equal(hookState(entry(1, { skipped: sk, claimsSha256: 'a'.repeat(64) }), idea(1)), 'stale'); assert.equal(hookState(entry(1, { skipped: sk }), null), 'stale');
  assert.equal(hookState(entry(1, { skipped: null }), idea(1)), 'unapproved'); });
test('a skipped entry is never taken by the lane, also not in the rehearsal preview', () => { const e = entry(1, { skipped: SK });
  assert.equal(approvedHookFor(idea(1), [e]), null); assert.equal(approvedHookFor(idea(1), [e], { includeUnapproved: true }), null);
  assert.deepEqual(hookFor(idea(1), [e], { autoRequireApprovedHook: true }), { reason: 'no-approved-hook' }); });
test('shownEntry: approved current entry first, else the last entry; none for an unknown idea', () => {
  const old = entry(1, { hook: 'old' }); const ok = entry(1, { hook: 'ok', ...APP }); const newer = entry(1, { hook: 'newer' });
  let r = shownEntry([old, ok, newer], idea(1)); assert.equal(r.entry.hook, 'ok'); assert.equal(r.others, 2);
  r = shownEntry([old, newer], idea(1)); assert.equal(r.entry.hook, 'newer'); assert.equal(r.others, 1);
  r = shownEntry([entry(2), old], idea(1)); assert.equal(r.entry.hook, 'old'); assert.equal(r.others, 0);
  assert.equal(shownEntry([], idea(1)), null); assert.equal(shownEntry([entry(2)], idea(1)), null);
});
test('--approve on a skipped entry is refused and leaves the file byte for byte', async () => {
  const f = tmpFile({ hooks: [entry(1, { skipped: SK })] }); const before = fs.readFileSync(f);
  const code = await run(['--approve', 'idea_1', '--by', 't', '--file', f], { loadPool: pool3 });
  assert.equal(code, 4); assert.ok(err.join('\n').includes('skipped on the review page; undo it there first')); assert.deepEqual(fs.readFileSync(f), before);
});
test('shownEntry agrees with the entry buildItems shows, over generated groups', async () => {
  let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let k = 0; k < 200; k++) {
    const n = 1 + Math.floor(rnd() * 4); const hooks = [];
    for (let j = 0; j < n; j++) hooks.push(entry(1, { hook: `H${k}_${j}`, ...(rnd() < 0.4 ? APP : {}), ...(rnd() < 0.3 ? { skipped: SK } : {}), ...(rnd() < 0.2 ? { claimsSha256: 'b'.repeat(64) } : {}) }));
    const r = await buildItems({ readHooks: () => ({ ok: true, hooks }), loadPool: () => ({ ok: true, ideas: [idea(1)], sourceNames: {} }), readManifest: () => ({ clips: [] }), libraryDir: '/x', info: () => null, secret: 's', evaluate: async (i, { hook }) => ({ ok: true, draft: { hook, caption: 'c' } }) });
    const approved = hooks.find((e) => e.approvedBy && !e.skipped && e.claimsSha256 === claimsSha256(idea(1)));
    const expected = (approved || hooks[hooks.length - 1]).hook; // an independent statement of the rule
    assert.equal(r.items[0].title, expected); assert.equal(shownEntry(hooks, idea(1)).entry.hook, expected);
  }
});
test('CLI --add and --approve take the lock and use the fresh file', async () => {
  const f = path.join(tmp(), 'h.json'); writeHooksAtomic(f, { hooks: [] });
  let gate; const wait = new Promise((r) => { gate = r; }); let started; const evalStarted = new Promise((r) => { started = r; });
  const p = run(['--add', 'idea_1', 'Lions and the fee', '--file', f], { loadPool: pool3, evaluate: async (i, hook) => { started(); await wait; return { ok: true, draft: { hook } }; } });
  await evalStarted;
  // a page write meanwhile, under the lock (the CLI is waiting inside its evaluate, before its own locked read-modify-write)
  await withDecisionLock(async () => { const c = readHooks(f); writeHooksAtomic(f, { hooks: [...c.hooks, entry(2)] }); });
  gate(); assert.equal(await p, 0, err.join('\n'));
  assert.deepEqual(readHooks(f).hooks.map((e) => e.ideaId).sort(), ['idea_1', 'idea_2']);
  // --approve keeps a concurrent page write too
  const p2 = run(['--approve', 'idea_1', '--by', 't', '--file', f], { loadPool: pool3 }); assert.equal(await p2, 0, err.join('\n'));
  assert.equal(readHooks(f).hooks.find((e) => e.ideaId === 'idea_1').approvedBy, 't'); assert.equal(readHooks(f).hooks.length, 2);
});
test('--add and --approve wait while another writer holds the lock', async () => {
  const f = path.join(tmp(), 'h.json'); writeHooksAtomic(f, { hooks: [entry(1)] });
  let release; const held = new Promise((r) => { release = r; }); let entered; const inside = new Promise((r) => { entered = r; });
  const holder = withDecisionLock(async () => { entered(); await held; }); await inside;
  let done = 0;
  const p1 = run(['--add', 'idea_2', 'Lions and the fee', '--file', f], { loadPool: pool3, evaluate: async (i, hook) => ({ ok: true, draft: { hook } }) }).then((c) => { done++; return c; });
  const p2 = run(['--approve', 'idea_1', '--by', 't', '--file', f], { loadPool: pool3 }).then((c) => { done++; return c; });
  await new Promise((r) => setTimeout(r, 150)); assert.equal(done, 0, 'both writers wait for the lock'); assert.equal(readHooks(f).hooks.length, 1);
  release(); await holder; assert.deepEqual([await p1, await p2], [0, 0]); assert.equal(readHooks(f).hooks.length, 2);
});
test('auto-lane.js still has exactly three readHooks( call sites (nothing added by this step)', () => {
  const lines = fs.readFileSync(path.join(HERE, 'auto-lane.js'), 'utf8').split('\n').filter((l) => l.includes('readHooks(') && !/^\s*import\b/.test(l));
  assert.equal(lines.length, 3);
});
