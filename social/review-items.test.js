import './test-env.js';
// Review page items: clip items (versions, media ids, states) and hook items. Pure with injected inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildClipItems, listMedia, fileInfoOf, clipVersion, mediaIdFor, hookVersion, buildItems } from './review-items.js';
import { claimsSha256, readHooks } from './auto-hooks.js';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-rev-'));
const clip = (id, over = {}) => ({ id, file: `${id}.mp4`, durationSec: 7, source: [{ videoId: 'v1', startSec: 1, endSec: 8 }], checks: { rendered: 'ok' }, flash: { flash: false }, verified: { verdict: 'pass', singleSubject: 'yes', notes: 'a lion' }, shows: { tags: ['lion', 'savanna'] }, ...over });
test('clip items: shape, states, superseded left out, no paths', () => {
  const dir = mk(); for (const f of ['c1', 'c2', 'c3']) fs.writeFileSync(path.join(dir, `${f}.mp4`), f);
  const manifest = { clips: [clip('c1'), clip('c2', { verified: null }), clip('c3', { supersededBy: ['c3-s1'] }), clip('c4'), clip('c5', { file: '../escape.mp4' })] };
  const { items, media } = buildClipItems({ manifest, libraryDir: dir, info: fileInfoOf(), secret: 's' });
  assert.deepEqual(items.map((i) => i.id).sort(), ['c1', 'c2', 'c4', 'c5']);
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(by.c1.state, 'eligible'); assert.equal(by.c2.state, 'not eligible: no verdict'); assert.equal(by.c4.state, 'video missing'); assert.equal(by.c5.state, 'video missing');
  assert.deepEqual(by.c4.preview, { mediaId: null, note: 'video missing' }); assert.deepEqual(by.c1.actions, []);
  assert.deepEqual(by.c1.facts, { durationSec: 7, verdict: 'pass', singleSubject: 'yes', notes: 'a lion', tags: ['lion', 'savanna'], flash: false, source: [{ videoId: 'v1', startSec: 1, endSec: 8 }] });
  assert.match(by.c1.preview.mediaId, /^m_[0-9a-f]{32}$/); assert.equal(media.size, 2); assert.ok(!JSON.stringify(items).includes(dir));
  assert.deepEqual(Object.keys(by.c1).sort(), ['actions', 'facts', 'id', 'kind', 'preview', 'state', 'title', 'version']); assert.equal(by.c1.kind, 'clip'); assert.equal(by.c1.title, 'c1');
});
test('not-eligible reasons, first match wins', () => {
  const dir = mk(); const ids = ['r', 'f', 'v', 'x', 's']; for (const id of ids) fs.writeFileSync(path.join(dir, `${id}.mp4`), id);
  const manifest = { clips: [clip('r', { checks: { rendered: 'bad' } }), clip('f', { flash: { flash: true } }), clip('v', { verified: { verdict: 'fail', singleSubject: 'yes' } }), clip('x', { verified: { verdict: 'pass', singleSubject: 'no' } }), clip('s', { checks: { rendered: 'bad' }, flash: { flash: true } })] };
  const by = Object.fromEntries(buildClipItems({ manifest, libraryDir: dir, info: fileInfoOf(), secret: 's' }).items.map((i) => [i.id, i.state]));
  assert.deepEqual(by, { r: 'not eligible: render check failed', f: 'not eligible: flash detected', v: 'not eligible: verdict fail', x: 'not eligible: single-subject not yes', s: 'not eligible: render check failed' });
});
test('version changes when the file bytes change under the SAME id and size (focus 4); tags change it; tag order does not', () => {
  const dir = mk(); const f = path.join(dir, 'c1.mp4'); fs.writeFileSync(f, 'AAA'); const info = fileInfoOf(); const v = () => buildClipItems({ manifest: { clips: [clip('c1')] }, libraryDir: dir, info, secret: 's' }).items[0].version;
  const v1 = v(); fs.writeFileSync(f, 'BBB'); const t = new Date(Date.now() + 5000); fs.utimesSync(f, t, t); assert.notEqual(v1, v());
  assert.equal(clipVersion('x', ['b', 'a']), clipVersion('x', ['a', 'b'])); assert.notEqual(clipVersion('x', ['a']), clipVersion('x', ['a', 'b']));
  assert.equal(clipVersion('x', ['a']), crypto.createHash('sha256').update(JSON.stringify(['x', ['a']])).digest('hex'));
});
test('after the file is replaced, the old media id is not in listMedia (focus 1)', () => {
  const dir = mk(); const f = path.join(dir, 'c1.mp4'); fs.writeFileSync(f, 'AAA'); const info = fileInfoOf(); const args = { manifest: { clips: [clip('c1')] }, libraryDir: dir, info, secret: 's' };
  const oldId = buildClipItems(args).items[0].preview.mediaId; assert.equal(listMedia(args).has(oldId), true);
  fs.writeFileSync(f, 'BBB'); const t = new Date(Date.now() + 5000); fs.utimesSync(f, t, t);
  const newId = buildClipItems(args).items[0].preview.mediaId; assert.notEqual(oldId, newId); assert.equal(listMedia(args).has(oldId), false); assert.equal(listMedia(args).has(newId), true);
});
test('file bytes are hashed once while path, size and mtime are unchanged', () => {
  const fileA = path.join(mk(), 'a.mp4'); fs.writeFileSync(fileA, 'A'); let reads = 0; const info = fileInfoOf({ readFile: () => { reads++; return 'h'.repeat(64); } });
  const a = info(fileA); info(fileA); assert.equal(reads, 1); assert.equal(a.sha256, 'h'.repeat(64)); assert.equal(typeof a.mtimeMs, 'number');
  assert.equal(info(path.join(path.dirname(fileA), 'none.mp4')), null, 'unreadable is null'); assert.equal(info(path.dirname(fileA)), null, 'a folder is not a file');
});
test('the real hasher reads in chunks and matches sha256 of the bytes', () => {
  const f = path.join(mk(), 'big.mp4'); const buf = crypto.randomBytes(3 * 1024 * 1024 + 17); fs.writeFileSync(f, buf);
  assert.equal(fileInfoOf()(f).sha256, crypto.createHash('sha256').update(buf).digest('hex'));
});
test('newest file first', () => {
  const dir = mk(); for (const id of ['c1', 'c2']) fs.writeFileSync(path.join(dir, `${id}.mp4`), id); const t = new Date(Date.now() + 5000); fs.utimesSync(path.join(dir, 'c2.mp4'), t, t);
  assert.deepEqual(buildClipItems({ manifest: { clips: [clip('c1'), clip('c2'), clip('c9')] }, libraryDir: dir, info: fileInfoOf(), secret: 's' }).items.map((i) => i.id), ['c2', 'c1', 'c9'], 'missing files last');
});
test('mediaIdFor depends on secret, id and version', () => { const a = mediaIdFor('s', 'c1', 'v'); assert.match(a, /^m_[0-9a-f]{32}$/); for (const b of [mediaIdFor('t', 'c1', 'v'), mediaIdFor('s', 'c2', 'v'), mediaIdFor('s', 'c1', 'w')]) assert.notEqual(a, b); });
test('300 clips: built fast, response small (focus 5)', () => {
  const manifest = { clips: Array.from({ length: 300 }, (_, n) => clip(`c${n}`)) }; const t0 = Date.now();
  const { items } = buildClipItems({ manifest, libraryDir: '/x', info: () => ({ sha256: 'a'.repeat(64), mtimeMs: 1 }), secret: 's', exists: () => true });
  assert.equal(items.length, 300); assert.ok(Date.now() - t0 < 2000); assert.ok(JSON.stringify(items).length < 400000);
});

// ── hook items and buildItems ────────────────────────────────────────────────────
const idea = (n, over = {}) => ({ id: `idea_${n}`, title: `Lion fact ${n}`, link: `/x/${n}/`, claims: [{ text: `Claim A${n}`, sourceDate: '2026-10-01' }, { text: `Claim B${n}`, sourceDate: '2026-10-02' }], ...over });
const ent = (n, over = {}) => ({ ideaId: `idea_${n}`, sourceId: null, hook: `Hook ${n}`, claimsSha256: claimsSha256(idea(n)), approvedBy: null, approvedAt: null, ...over });
const base = (over = {}) => ({ readHooks: () => ({ ok: true, hooks: [ent(1, { approvedBy: 't', approvedAt: '2026-11-17T09:00:00Z' }), ent(2), ent(3, { claimsSha256: 'a'.repeat(64) }), ent(9), ent(4)] }), loadPool: () => ({ ok: true, ideas: [1, 2, 3, 4].map((n) => idea(n)), sourceNames: {} }), readManifest: () => ({ clips: [] }), libraryDir: '/x', info: () => null, secret: 's', evaluate: async (i, { hook }) => (i.id === 'idea_4' ? { ok: false, reason: 'hook-number-not-in-claims' } : { ok: true, draft: { hook, caption: `Cap ${i.id}` } }), ...over });
test('hook items: state per entry, newest (last in file) first', async () => { const r = await buildItems(base()); assert.deepEqual(r.items.map((i) => [i.id, i.state]), [['idea_4', 'refused: hook-number-not-in-claims'], ['idea_9', 'stale'], ['idea_3', 'stale'], ['idea_2', 'unapproved'], ['idea_1', 'approved']]); });
test('hook item facts, preview and actions', async () => {
  const r = await buildItems(base()); const h = r.items.find((i) => i.id === 'idea_1');
  assert.deepEqual(h.facts, { hook: 'Hook 1', caption: 'Cap idea_1', claims: [{ text: 'Claim A1', sourceDate: '2026-10-01' }, { text: 'Claim B1', sourceDate: '2026-10-02' }], link: '/x/1/', exampleClip: null });
  assert.deepEqual(h.preview, { mediaId: null, note: 'video is being prepared' }); assert.deepEqual(h.actions, []); assert.equal(h.kind, 'hook'); assert.equal(h.title, 'Hook 1'); assert.equal(h.version, hookVersion('Hook 1', idea(1)));
  assert.deepEqual(r.items.find((i) => i.id === 'idea_9').facts, { hook: 'Hook 9' }, 'a stale item shows the hook only');
  assert.deepEqual(r.items.find((i) => i.id === 'idea_3').facts, { hook: 'Hook 3' });
});
test('hookVersion pins the algorithm and changes with hook text, title and each claim', () => {
  const i = idea(1); assert.equal(hookVersion('H', i), crypto.createHash('sha256').update(JSON.stringify(['H', i.title, ['Claim A1', 'Claim B1']])).digest('hex'));
  for (const o of [hookVersion('H2', i), hookVersion('H', { ...i, title: 'T' }), hookVersion('H', { ...i, claims: [i.claims[1], i.claims[0]] }), hookVersion('H', { ...i, claims: [{ text: 'changed' }, i.claims[1]] })]) assert.notEqual(o, hookVersion('H', i));
});
test('unreadable hooks (truncated file, focus 3) degrade, clips remain, nothing throws', async () => {
  const dir = mk(); const f = path.join(dir, 'h.json'); fs.writeFileSync(f, '{"hooks": ['); fs.writeFileSync(path.join(dir, 'c1.mp4'), 'x');
  const r = await buildItems(base({ readHooks: () => readHooks(f), readManifest: () => ({ clips: [clip('c1')] }), libraryDir: dir, info: fileInfoOf() }));
  assert.ok(r.problems.includes('hooks-unreadable')); assert.deepEqual(r.items.map((i) => i.kind), ['clip']); assert.equal(r.ok, true);
  const r2 = await buildItems(base({ readHooks: () => { throw new Error('boom'); } })); assert.ok(r2.problems.includes('hooks-unreadable'), 'a throwing reader degrades too');
});
test('other problems: pool missing, library missing, library throws', async () => {
  assert.ok((await buildItems(base({ loadPool: () => ({ ok: false, reason: 'x' }) }))).problems.includes('ideas-unavailable'));
  assert.equal((await buildItems(base({ loadPool: () => ({ ok: false, reason: 'x' }) }))).items.length, 0, 'no pool, no hook items');
  assert.ok((await buildItems(base({ readManifest: () => null }))).problems.includes('library-missing'));
  assert.ok((await buildItems(base({ readManifest: () => { throw new Error('boom'); } }))).problems.includes('library-unreadable'));
  assert.equal((await buildItems(base({ readManifest: () => { throw new Error('boom'); } }))).items.length, 5, 'hooks still built');
});
test('a throwing evaluate does not throw out of buildItems; the item is refused', async () => {
  const r = await buildItems(base({ evaluate: async () => { throw new Error('boom'); } })); const h = r.items.find((i) => i.id === 'idea_1'); assert.match(h.state, /^refused: /);
});
test('counts per kind; a preview file turns into a media entry', async () => {
  const r = await buildItems(base({ previewFor: (id) => (id === 'idea_1' ? '/p/a.mp4' : null) })); assert.deepEqual(r.counts, { all: 5, hook: 5, clip: 0 });
  const h = r.items.find((i) => i.id === 'idea_1'); assert.match(h.preview.mediaId, /^m_/); assert.equal(h.preview.note, 'example clip; the lane may use another fitting clip'); assert.deepEqual(r.media.get(h.preview.mediaId), { path: '/p/a.mp4', kind: 'preview' });
});
test('hooks come before clips; the media map carries clip files', async () => {
  const dir = mk(); fs.writeFileSync(path.join(dir, 'c1.mp4'), 'x');
  const r = await buildItems(base({ readManifest: () => ({ clips: [clip('c1')] }), libraryDir: dir, info: fileInfoOf() }));
  assert.deepEqual(r.items.map((i) => i.kind), ['hook', 'hook', 'hook', 'hook', 'hook', 'clip']); assert.deepEqual(r.counts, { all: 6, hook: 5, clip: 1 }); assert.equal(r.media.size, 1);
});
