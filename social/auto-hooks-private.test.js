import './test-env.js';
// Hooks live in a private state file; --migrate copies proposals into it; writes are atomic and mode 600.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, readHooks, hookState, writeHooksAtomic, claimsSha256, defaultHooksPath } from './auto-hooks.js';
import { prepareAutoPost } from './auto-lane.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = new Date('2026-11-17T09:00:00Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-hooks-priv-'));
const claim = (text) => ({ text, ruleId: 'r1', sourceDate: '2026-10-01' });
const idea = (n) => ({ id: `idea_${n}`, sourceId: `rule:r${n}`, kind: 'rule', topic: 'visa', title: `Lion rule number ${n}`, claims: [claim(`The listed fee for item ${n} is ${n + 10} US dollars for most visitors.`)], link: '/x/', score: 9 });
const entry = (n, over = {}) => ({ ideaId: `idea_${n}`, sourceId: null, hook: `Hook ${n}`, claimsSha256: claimsSha256(idea(n)), approvedBy: null, approvedAt: null, ...over });
const tmpFile = (obj) => { const f = path.join(tmp(), 'h.json'); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };
let out = []; let err = [];
const run = (argv, deps) => { out = []; err = []; return main(argv, { now: () => NOW, log: out.push.bind(out), error: err.push.bind(err), ...deps }); };
const pool3 = () => ({ ok: true, ideas: [idea(1), idea(2), idea(3)], sourceNames: {} });
const okEval = async () => ({ ok: true, draft: { hook: 'x' } });

test('migrate copies approved, unapproved, stale and today-refused entries, mode 600, reporting each', async () => {
  const src = tmpFile({ hooks: [entry(1, { approvedBy: 't', approvedAt: '2026-11-17T09:00:00Z' }), entry(2), entry(9), entry(3)] }); const target = path.join(tmp(), 'sub', 'h.json');
  const code = await run(['--migrate', src, '--file', target], { loadPool: pool3, evaluate: async (i) => (i.id === 'idea_3' ? { ok: false, reason: 'hook-number-not-in-claims' } : { ok: true, draft: { hook: 'x' } }) });
  assert.equal(code, 0, err.join('\n')); assert.equal(fs.statSync(target).mode & 0o777, 0o600); assert.equal(readHooks(target).hooks.length, 4);
  assert.deepEqual(out, ['migrated idea_1 approved', 'migrated idea_2 unapproved', 'migrated idea_9 stale', 'migrated idea_3 REFUSED-TODAY: hook-number-not-in-claims']);
});
test('migrate never overwrites an entry for the same idea', async () => {
  const target = path.join(tmp(), 'h.json');
  assert.equal(await run(['--migrate', tmpFile({ hooks: [entry(1, { hook: 'first text' })] }), '--file', target], { loadPool: pool3, evaluate: okEval }), 0);
  assert.equal(await run(['--migrate', tmpFile({ hooks: [entry(1, { hook: 'other text' })] }), '--file', target], { loadPool: pool3, evaluate: okEval }), 0);
  assert.equal(readHooks(target).hooks[0].hook, 'first text'); assert.ok(out.includes('skipped idea_1: already in the private file')); assert.equal(readHooks(target).hooks.length, 1);
});
test('migrate refuses before writing: bad source, pool not ok, malformed existing target', async () => {
  const good = tmpFile({ hooks: [entry(1)] }); const newTarget = path.join(tmp(), 'new.json'); const badTarget = tmpFile('{broken');
  const codes = [
    await run(['--migrate', tmpFile('{broken'), '--file', newTarget], { loadPool: pool3, evaluate: okEval }),
    await run(['--migrate', good, '--file', newTarget], { loadPool: () => ({ ok: false, reason: 'no pool' }), evaluate: okEval }),
    await run(['--migrate', good, '--file', badTarget], { loadPool: pool3, evaluate: okEval }),
  ];
  for (const c of codes) assert.equal(c, 3); assert.equal(fs.existsSync(newTarget), false); assert.equal(fs.readFileSync(badTarget, 'utf8'), '{broken');
});
test('migrate is exclusive with the other commands', async () => {
  assert.equal(await run(['--migrate', 'x.json', '--list'], { loadPool: pool3 }), 2); assert.equal(await run(['--migrate', 'x.json', '--approve', 'idea_1', '--by', 't'], { loadPool: pool3 }), 2);
  assert.equal(await run(['--migrate'], { loadPool: pool3 }), 2);
});
test('skipped field: null, absent and {by,at} are readable; text is refused', () => {
  assert.equal(readHooks(tmpFile({ hooks: [entry(1, { skipped: { by: 't', at: '2026-11-17T09:00:00Z' } })] })).ok, true);
  assert.equal(readHooks(tmpFile({ hooks: [entry(1, { skipped: null }), entry(2)] })).ok, true);
  assert.equal(readHooks(tmpFile({ hooks: [entry(1, { skipped: 'yes' })] })).ok, false);
  assert.equal(hookState(entry(1, { skipped: { by: 't', at: '2026-11-17T09:00:00Z' } }), idea(1)), 'unapproved', 'step 1 does not change the lane states');
});
test('--add and --approve now write the private file with mode 600', async () => {
  const f = path.join(tmp(), 'sub', 'h.json'); writeHooksAtomic(f, { hooks: [] });
  assert.equal(await run(['--add', 'idea_1', 'Lions and the fee', '--file', f], { loadPool: pool3, evaluate: async (i, hook) => ({ ok: true, draft: { hook } }) }), 0, err.join('\n'));
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  fs.chmodSync(f, 0o644);
  assert.equal(await run(['--approve', 'idea_1', '--by', 'owner', '--file', f], { loadPool: pool3 }), 0, err.join('\n'));
  assert.equal(fs.statSync(f).mode & 0o777, 0o600, 'a rewrite goes through the atomic writer');
});
test('writeHooksAtomic: a reader never sees half a file (focus 3)', async () => {
  const f = path.join(tmp(), 'h.json'); writeHooksAtomic(f, { hooks: [] }); let bad = 0;
  const w = (async () => { for (let i = 0; i < 200; i++) writeHooksAtomic(f, { hooks: [entry(1 + (i % 5))] }); })();
  for (let i = 0; i < 400; i++) { if (!readHooks(f).ok) bad++; await new Promise((r) => setImmediate(r)); }
  await w; assert.equal(bad, 0); assert.deepEqual(fs.readdirSync(path.dirname(f)), ['h.json'], 'no tmp file left behind');
});
test('the lane refuses when the private file is missing (default path)', async () => {
  const dir = tmp();
  const r = await prepareAutoPost({ pool: [idea(1)], manifest: { version: 1, clips: [] }, usage: [], history: [], config: {}, now: NOW }, { outDir: path.join(dir, 'out'), libraryDir: path.join(dir, 'lib'), exists: () => true });
  assert.deepEqual(r.reasons, ['bad-hooks-file']);
});
test('auto-lane.js has three readHooks call sites, each checked for ok', () => {
  const s = fs.readFileSync(path.join(HERE, 'auto-lane.js'), 'utf8').split('\n').filter((l) => /readHooks\(/.test(l) && !/^import/.test(l));
  assert.equal(s.length, 3); for (const l of s) assert.match(l, /!hooks\.ok/);
});

test('E12: the DEFAULT hooks file is refused when group or others can read it, or when it is not a regular file; an explicit path keeps today\'s behaviour', async () => {
  const def = defaultHooksPath(); fs.mkdirSync(path.dirname(def), { recursive: true }); fs.rmSync(def, { force: true, recursive: true });
  writeHooksAtomic(def, { hooks: [entry(1)] }); assert.equal(readHooks(def).ok, true); assert.equal(readHooks().ok, true, 'no argument means the default path');
  for (const mode of [0o644, 0o640, 0o604, 0o666]) { fs.chmodSync(def, mode); const r = readHooks(def); assert.equal(r.ok, false, mode.toString(8)); assert.match(r.reason, /readable by others/); assert.equal(readHooks().ok, false); }
  const dir = tmp(); const dr = await prepareAutoPost({ pool: [idea(1)], manifest: { version: 1, clips: [] }, usage: [], history: [], config: {}, now: NOW }, { outDir: path.join(dir, 'out'), libraryDir: path.join(dir, 'lib'), exists: () => true }); assert.deepEqual(dr.reasons, ['bad-hooks-file'], 'the lane refuses too');
  fs.chmodSync(def, 0o600); fs.rmSync(def); const real = tmpFile({ hooks: [entry(2)] }); fs.symlinkSync(real, def); const l = readHooks(def); assert.equal(l.ok, false); assert.match(l.reason, /regular file/); fs.rmSync(def);
  fs.mkdirSync(def); assert.equal(readHooks(def).ok, false); fs.rmSync(def, { recursive: true });
  const explicit = tmpFile({ hooks: [entry(3)] }); fs.chmodSync(explicit, 0o644); assert.equal(readHooks(explicit).ok, true, 'an explicit --file path is not checked');
  assert.equal(readHooks(def).ok, false, 'missing is still a failure'); assert.match(readHooks(def).reason, /cannot read/);
});
test('E12: writeHooksAtomic removes its temp file when the rename fails', () => {
  const d = tmp(); const target = path.join(d, 'h.json'); fs.mkdirSync(path.join(target, 'x'), { recursive: true });
  assert.throws(() => writeHooksAtomic(target, { hooks: [] })); assert.deepEqual(fs.readdirSync(d), ['h.json'], 'no temp file is left behind');
});
