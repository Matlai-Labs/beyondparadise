import './test-env.js';
// Review page items: clip items (versions, media ids, states) and hook items. Pure with injected inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildClipItems, clipReasonOf, fileInfoOf, clipVersion, mediaIdFor, hookVersion, buildItems, NOTE_PENDING } from './review-items.js';
import { claimsSha256, readHooks } from './auto-hooks.js';
import { eligibleClips } from './clip-library.js';
import { laneVerdictFor } from './auto-lane.js';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-rev-'));
const clip = (id, over = {}) => ({ id, file: `${id}.mp4`, durationSec: 7, source: [{ videoId: 'v1', startSec: 1, endSec: 8 }], checks: { rendered: 'ok' }, flash: { flash: false }, verified: { verdict: 'pass', singleSubject: 'yes', notes: 'a lion' }, shows: { tags: ['lion', 'savanna'], by: 't' }, ...over });
// a counting hasher: the real stream hasher, or a stub
const counting = () => { const calls = []; const info = fileInfoOf({ hashFile: async (f) => { calls.push(f); return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } }); return { info, calls }; };
const bump = (f) => { const t = new Date(Date.now() + 5000 + Math.floor(Math.random() * 1000)); fs.utimesSync(f, t, t); };
test('clip items: shape, states, superseded left out, no paths', async () => {
  const dir = mk(); for (const f of ['c1', 'c2', 'c3']) fs.writeFileSync(path.join(dir, `${f}.mp4`), f);
  const manifest = { clips: [clip('c1'), clip('c2', { verified: null }), clip('c3', { supersededBy: ['c3-s1'] }), clip('c4'), clip('c5', { file: '../escape.mp4' })] };
  const { items, media } = await buildClipItems({ manifest, libraryDir: dir, info: fileInfoOf(), secret: 's' });
  assert.deepEqual(items.map((i) => i.id).sort(), ['c1', 'c2', 'c4', 'c5']);
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(by.c1.state, 'eligible'); assert.equal(by.c2.state, 'not eligible: no verdict'); assert.equal(by.c4.state, 'video missing'); assert.equal(by.c5.state, 'video missing');
  assert.deepEqual(by.c4.preview, { mediaId: null, note: 'video missing' }); assert.deepEqual(by.c1.actions, ['approve', 'skip']);
  assert.deepEqual(by.c1.facts, { durationSec: 7, verdict: 'pass', singleSubject: 'yes', notes: 'a lion', tags: ['lion', 'savanna'], flash: false, source: [{ videoId: 'v1', startSec: 1, endSec: 8 }] });
  assert.match(by.c1.preview.mediaId, /^m_[0-9a-f]{32}$/); assert.equal(media.size, 2); assert.ok(!JSON.stringify(items).includes(dir));
  assert.deepEqual(Object.keys(by.c1).sort(), ['actions', 'decision', 'facts', 'id', 'kind', 'preview', 'reason', 'state', 'title', 'usableToday', 'version']); assert.equal(by.c1.kind, 'clip'); assert.equal(by.c1.title, 'c1');
  const e = media.get(by.c1.preview.mediaId); assert.equal(e.kind, 'clip'); assert.equal(e.path, path.join(dir, 'c1.mp4')); assert.equal(typeof e.size, 'number'); assert.equal(typeof e.mtimeMs, 'number'); assert.equal(typeof e.ino, 'number');
});
test('not-eligible reasons, first match wins', async () => {
  const dir = mk(); const ids = ['r', 'f', 'v', 'x', 's']; for (const id of ids) fs.writeFileSync(path.join(dir, `${id}.mp4`), id);
  const manifest = { clips: [clip('r', { checks: { rendered: 'bad' } }), clip('f', { flash: { flash: true } }), clip('v', { verified: { verdict: 'fail', singleSubject: 'yes' } }), clip('x', { verified: { verdict: 'pass', singleSubject: 'no' } }), clip('s', { checks: { rendered: 'bad' }, flash: { flash: true } })] };
  const by = Object.fromEntries((await buildClipItems({ manifest, libraryDir: dir, info: fileInfoOf(), secret: 's' })).items.map((i) => [i.id, i.state]));
  assert.deepEqual(by, { r: 'not eligible: render check failed', f: 'not eligible: flash detected', v: 'not eligible: verdict fail', x: 'not eligible: single-subject not yes', s: 'not eligible: render check failed' });
});
test('version changes when the file bytes change under the SAME id and size (focus 4); tags change it; tag order does not', async () => {
  const dir = mk(); const f = path.join(dir, 'c1.mp4'); fs.writeFileSync(f, 'AAA'); const info = fileInfoOf(); const v = async () => (await buildClipItems({ manifest: { clips: [clip('c1')] }, libraryDir: dir, info, secret: 's' })).items[0].version;
  const v1 = await v(); fs.writeFileSync(f, 'BBB'); bump(f); assert.notEqual(v1, await v());
  assert.equal(clipVersion('x', ['b', 'a']), clipVersion('x', ['a', 'b'])); assert.notEqual(clipVersion('x', ['a']), clipVersion('x', ['a', 'b']));
  assert.equal(clipVersion('x', ['a']), crypto.createHash('sha256').update(JSON.stringify(['x', ['a']])).digest('hex'));
});
test('after the file is replaced the old media id is gone from the next build and the map entry carries the identity (focus 1)', async () => {
  const dir = mk(); const f = path.join(dir, 'c1.mp4'); fs.writeFileSync(f, 'AAA'); const info = fileInfoOf(); const args = { manifest: { clips: [clip('c1')] }, libraryDir: dir, info, secret: 's' };
  const r1 = await buildClipItems(args); const oldId = r1.items[0].preview.mediaId; assert.equal(r1.media.has(oldId), true); const oldSize = r1.media.get(oldId).size;
  fs.writeFileSync(f, 'BBBB'); bump(f);
  const r2 = await buildClipItems(args); const newId = r2.items[0].preview.mediaId; assert.notEqual(oldId, newId); assert.equal(r2.media.has(oldId), false); assert.equal(r2.media.has(newId), true); assert.notEqual(r2.media.get(newId).size, oldSize);
});
test('D7: file bytes are hashed once while path, size, mtime and inode are unchanged; async stream; a folder, a missing file and a symlink are null', async () => {
  const d = mk(); const fileA = path.join(d, 'a.mp4'); fs.writeFileSync(fileA, 'A'); let reads = 0; const info = fileInfoOf({ hashFile: async () => { reads++; return 'h'.repeat(64); } });
  const pk = info.peek(fileA); assert.equal(pk.sha256, null, 'not hashed yet: peek never hashes'); assert.equal(reads, 0);
  assert.equal(await info.hash(fileA, pk), 'h'.repeat(64)); assert.equal(info.peek(fileA).sha256, 'h'.repeat(64)); await info.hash(fileA, info.peek(fileA)); assert.equal(reads, 1);
  assert.equal(info.peek(path.join(d, 'none.mp4')), null); assert.equal(info.peek(d), null, 'a folder is not a file');
  fs.symlinkSync(fileA, path.join(d, 'link.mp4')); assert.equal(info.peek(path.join(d, 'link.mp4')), null, 'E11: a link is never a file here');
});
test('D7: two requests for the same unhashed file share one hashing run', async () => {
  const d = mk(); const f = path.join(d, 'a.mp4'); fs.writeFileSync(f, 'A'); let reads = 0; const info = fileInfoOf({ hashFile: async () => { reads++; await new Promise((r) => setTimeout(r, 20)); return 'h'.repeat(64); } });
  const pk = info.peek(f); await Promise.all([info.hash(f, pk), info.hash(f, pk)]); assert.equal(reads, 1);
});
test('D7: the real hasher streams and matches sha256 of the bytes', async () => {
  const f = path.join(mk(), 'big.mp4'); const buf = crypto.randomBytes(3 * 1024 * 1024 + 17); fs.writeFileSync(f, buf);
  const info = fileInfoOf(); assert.equal(await info.hash(f, info.peek(f)), crypto.createHash('sha256').update(buf).digest('hex'));
  const both = ['./review-items.js', './clip-approvals.js'].map((f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n'); // the hasher moved to clip-approvals.js
  assert.ok(/createReadStream/.test(fs.readFileSync(new URL('./clip-approvals.js', import.meta.url), 'utf8')) && !/readFileSync\(file\)|readFileSync\(abs\)/.test(both), 'streams, no whole-file read');
});
test('D7: at most 4 new files are hashed per request; the rest are "being prepared" and filled in by the next request', async () => {
  const dir = mk(); const ids = ['a', 'b', 'c', 'd', 'e', 'f']; for (const id of ids) fs.writeFileSync(path.join(dir, `${id}.mp4`), id); const { info, calls } = counting();
  const args = { manifest: { clips: ids.map((id) => clip(id)) }, libraryDir: dir, info, secret: 's' };
  const r1 = await buildClipItems(args); assert.equal(calls.length, 4); const pending = r1.items.filter((i) => i.preview.note === 'video is being prepared'); assert.equal(pending.length, 2);
  for (const p of pending) { assert.equal(p.preview.mediaId, null); assert.equal(p.state, 'eligible', 'the state does not wait for the hash'); } assert.equal(r1.media.size, 4);
  const r2 = await buildClipItems(args); assert.equal(calls.length, 6, 'only the two new ones'); assert.equal(r2.media.size, 6); assert.equal(r2.items.filter((i) => i.preview.note === 'video is being prepared').length, 0);
  await buildClipItems(args); assert.equal(calls.length, 6, 'nothing is hashed again');
});
test('D7: cache entries for files that left the manifest are dropped', async () => {
  const dir = mk(); for (const id of ['a', 'b']) fs.writeFileSync(path.join(dir, `${id}.mp4`), id); const { info } = counting();
  await buildClipItems({ manifest: { clips: [clip('a'), clip('b')] }, libraryDir: dir, info, secret: 's' }); assert.equal(info.size(), 2);
  await buildClipItems({ manifest: { clips: [clip('a')] }, libraryDir: dir, info, secret: 's' }); assert.equal(info.size(), 1);
});
test('E11: a symlinked clip file gets no media id, shows "video missing" and is never hashed', async () => {
  const dir = mk(); const outside = path.join(mk(), 'o.mp4'); fs.writeFileSync(outside, 'secret'); fs.symlinkSync(outside, path.join(dir, 'c1.mp4')); const { info, calls } = counting();
  const r = await buildClipItems({ manifest: { clips: [clip('c1')] }, libraryDir: dir, info, secret: 's' }); const it = r.items[0];
  assert.deepEqual([it.state, it.preview.mediaId, it.preview.note, it.reason], ['video missing', null, 'video missing', 'video-missing']); assert.equal(r.media.size, 0); assert.equal(calls.length, 0);
});
test('newest file first', async () => {
  const dir = mk(); for (const id of ['c1', 'c2']) fs.writeFileSync(path.join(dir, `${id}.mp4`), id); const t = new Date(Date.now() + 5000); fs.utimesSync(path.join(dir, 'c2.mp4'), t, t);
  assert.deepEqual((await buildClipItems({ manifest: { clips: [clip('c1'), clip('c2'), clip('c9')] }, libraryDir: dir, info: fileInfoOf(), secret: 's' })).items.map((i) => i.id), ['c2', 'c1', 'c9'], 'missing files last');
});
test('mediaIdFor depends on secret, id and version', () => { const a = mediaIdFor('s', 'c1', 'v'); assert.match(a, /^m_[0-9a-f]{32}$/); for (const b of [mediaIdFor('t', 'c1', 'v'), mediaIdFor('s', 'c2', 'v'), mediaIdFor('s', 'c1', 'w')]) assert.notEqual(a, b); });
test('300 clips: built fast, response small (focus 5)', async () => {
  const manifest = { clips: Array.from({ length: 300 }, (_, n) => clip(`c${n}`)) }; const t0 = Date.now();
  const info = { peek: () => ({ size: 1, mtimeMs: 1, ino: 1, key: 'k', sha256: 'a'.repeat(64) }), hash: async () => 'a'.repeat(64), prune() {}, size: () => 0 };
  const { items } = await buildClipItems({ manifest, libraryDir: '/x', info, secret: 's', exists: () => true });
  assert.equal(items.length, 300); assert.ok(Date.now() - t0 < 2000); assert.ok(JSON.stringify(items).length < 400000);
});

// ── hook items and buildItems ────────────────────────────────────────────────────
const idea = (n, over = {}) => ({ id: `idea_${n}`, kind: 'rule', title: `Lion fact ${n}`, link: `/x/${n}/`, claims: [{ text: `Claim A${n}`, sourceDate: '2026-10-01' }, { text: `Claim B${n}`, sourceDate: '2026-10-02' }], ...over });
const ent = (n, over = {}) => ({ ideaId: `idea_${n}`, sourceId: null, hook: `Hook ${n}`, claimsSha256: claimsSha256(idea(n)), approvedBy: null, approvedAt: null, ...over });
const base = (over = {}) => ({ readHooks: () => ({ ok: true, hooks: [ent(1, { approvedBy: 't', approvedAt: '2026-11-17T09:00:00Z' }), ent(2), ent(3, { claimsSha256: 'a'.repeat(64) }), ent(9), ent(4)] }), loadPool: () => ({ ok: true, ideas: [1, 2, 3, 4].map((n) => idea(n)), sourceNames: {} }), readManifest: () => ({ clips: [] }), libraryDir: '/x', info: () => null, secret: 's', evaluate: async (i, { hook }) => (i.id === 'idea_4' ? { ok: false, reason: 'hook-number-not-in-claims' } : { ok: true, draft: { hook, caption: `Cap ${i.id}` } }), ...over });
test('hook items: state per entry, newest (last in file) first', async () => { const r = await buildItems(base()); assert.deepEqual(r.items.map((i) => [i.id, i.state]), [['idea_4', 'refused: hook-number-not-in-claims'], ['idea_9', 'stale'], ['idea_3', 'stale'], ['idea_2', 'unapproved'], ['idea_1', 'approved']]); });
test('hook item facts, preview and actions', async () => {
  const r = await buildItems(base()); const h = r.items.find((i) => i.id === 'idea_1');
  assert.deepEqual(h.facts, { hook: 'Hook 1', caption: 'Cap idea_1', claims: [{ text: 'Claim A1', sourceDate: '2026-10-01' }, { text: 'Claim B1', sourceDate: '2026-10-02' }], link: '/x/1/', exampleClip: null });
  assert.deepEqual(h.preview, { mediaId: null, note: 'no example video yet' }); assert.deepEqual(h.actions, ['undo']); assert.equal(h.kind, 'hook'); assert.equal(h.title, 'Hook 1'); assert.equal(h.version, hookVersion('Hook 1', idea(1)));
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
  const h = r.items.find((i) => i.id === 'idea_1'); assert.match(h.preview.mediaId, /^m_/); assert.equal(h.preview.note, 'Example footage. The real post may use other footage that fits.'); assert.deepEqual(r.media.get(h.preview.mediaId), { path: '/p/a.mp4', kind: 'preview' });
});
test('clips come before hooks (clips have videos); the media map carries clip files', async () => {
  const dir = mk(); fs.writeFileSync(path.join(dir, 'c1.mp4'), 'x');
  const r = await buildItems(base({ readManifest: () => ({ clips: [clip('c1')] }), libraryDir: dir, info: fileInfoOf() }));
  assert.deepEqual(r.items.map((i) => i.kind), ['clip', 'hook', 'hook', 'hook', 'hook', 'hook']); assert.deepEqual(r.counts, { all: 6, hook: 5, clip: 1 }); assert.equal(r.media.size, 1);
});

// ── truth of what the page says (fix round A) ────────────────────────────────────
const inside = (dir, f) => { const rel = path.relative(path.resolve(dir), path.resolve(dir, f)); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
test('A1: the clips shown as eligible are exactly the lane\'s set (verdict, subject, flash, superseded, missing file, ledger)', async () => {
  const dir = mk(); const ids = [];
  const defs = [];
  for (const verdict of ['pass', 'fail', null]) for (const subj of ['yes', 'no', undefined]) for (const flash of [true, false, undefined]) {
    const id = `m${defs.length}`; defs.push(clip(id, { verified: verdict === null ? null : { verdict, singleSubject: subj, notes: '' }, flash: flash === undefined ? undefined : { flash } })); ids.push(id);
  }
  defs.push(clip('sup', { supersededBy: ['x'] }), clip('gone'), clip('esc', { file: '../esc.mp4' }), clip('used'), clip('badrender', { checks: { rendered: 'bad' } }));
  for (const c of defs) if (!['gone'].includes(c.id) && c.id !== 'esc') fs.writeFileSync(path.join(dir, `${c.id}.mp4`), c.id);
  const manifest = { clips: defs }; const usage = [{ clipId: 'used' }];
  const lane = new Set(eligibleClips(manifest, usage, { dir, exists: fs.existsSync }).filter((c) => inside(dir, c.file)).map((c) => c.id));
  assert.ok(lane.size >= 1 && lane.size < defs.length, 'the matrix has both kinds');
  const { items } = await buildClipItems({ manifest, libraryDir: dir, info: fileInfoOf(), secret: 's', usage });
  assert.deepEqual(new Set(items.filter((i) => i.state === 'eligible').map((i) => i.id)), lane);
  assert.deepEqual(new Set(items.filter((i) => i.usableToday).map((i) => i.id)), lane);
  const by = Object.fromEntries(items.map((i) => [i.id, i])); assert.equal(by.used.state, 'already used in a post'); assert.equal(by.used.reason, 'already-used'); assert.equal(by.used.usableToday, false);
  assert.equal(by.gone.state, 'video missing'); assert.equal(by.gone.reason, 'video-missing'); assert.equal(by.badrender.reason, 'render-check-failed'); assert.equal(by.sup, undefined);
});
test('A1: the ledger also matches by source overlap, as the lane does', async () => {
  const dir = mk(); fs.writeFileSync(path.join(dir, 'c1.mp4'), 'x'); const manifest = { clips: [clip('c1')] };
  const usage = [{ id: 'v1', startSec: 2, endSec: 6 }]; const lane = eligibleClips(manifest, usage, { dir, exists: fs.existsSync });
  assert.equal(lane.length, 0); assert.equal((await buildClipItems({ manifest, libraryDir: dir, info: fileInfoOf(), secret: 's', usage })).items[0].state, 'already used in a post');
});
test('A1: an unreadable ledger (usage null) makes nothing eligible', async () => {
  const dir = mk(); fs.writeFileSync(path.join(dir, 'c1.mp4'), 'x'); const it = (await buildClipItems({ manifest: { clips: [clip('c1')] }, libraryDir: dir, info: fileInfoOf(), secret: 's', usage: null })).items[0];
  assert.equal(it.usableToday, false); assert.equal(it.reason, 'usage-unreadable');
});
const NOW = new Date('2026-11-17T09:00:00Z');
const withLane = (over = {}) => base({ laneVerdict: laneVerdictFor, readHistory: () => [], readConfig: () => ({}), readUsage: () => [], now: NOW, readManifest: () => ({ clips: [clip('c1')] }), libraryDir: dirForLane(), info: fileInfoOf(), ...over });
let laneDir = null; const dirForLane = () => { if (!laneDir) { laneDir = mk(); fs.writeFileSync(path.join(laneDir, 'c1.mp4'), 'x'); } return laneDir; };
const approvedHooks = (...ns) => () => ({ ok: true, hooks: ns.map((n) => ent(n, { approvedBy: 't', approvedAt: '2026-11-17T09:00:00Z' })) });
const ev = async (i, { hook }) => ({ ok: true, draft: { hook, caption: 'Cap' } });
test('A2: an approved hook the lane would use is usableToday with no reason', async () => {
  const r = await buildItems(withLane({ readHooks: approvedHooks(1), evaluate: ev })); const h = r.items.find((i) => i.id === 'idea_1'); assert.equal(h.state, 'approved'); assert.equal(h.usableToday, true); assert.equal(h.reason, null);
});
test('A2: each reason the lane refuses an approved hook shows up (in-history, title-claim-differ, wrong-kind, no-matching-clip, no-subject)', async () => {
  const run = async (over, ideaOver = {}) => { const r = await buildItems(withLane({ readHooks: approvedHooks(1), evaluate: ev, loadPool: () => ({ ok: true, ideas: [idea(1, ideaOver)], sourceNames: {} }), ...over })); return r.items.find((i) => i.id === 'idea_1'); };
  let h = await run({ readHistory: () => [{ ideaId: 'idea_1', date: '2026-11-01T00:00:00Z' }] }); assert.deepEqual([h.state, h.usableToday, h.reason], ['approved', false, 'in-history']);
  h = await run({ readHistory: () => [{ ideaId: 'idea_1', date: '2026-01-01T00:00:00Z' }] }); assert.equal(h.usableToday, true, 'older than repeatDays is fine');
  h = await run({ readHistory: () => [{ ideaId: 'idea_1', date: '2026-10-20T00:00:00Z' }], readConfig: () => ({ repeatDays: 10 }) }); assert.equal(h.usableToday, true, 'repeatDays from config');
  h = await run({}, { titleFromOtherField: true }); assert.equal(h.reason, 'title-claim-differ');
  h = await run({}, { kind: 'page' }); assert.equal(h.reason, 'wrong-kind');
  h = await run({ readConfig: () => ({ autoKinds: ['fact'] }) }, { kind: 'rule' }); assert.equal(h.reason, 'wrong-kind');
  h = await run({ readManifest: () => ({ clips: [clip('c1', { shows: { tags: ['zebra'], by: 't' } })] }) }); assert.equal(h.reason, 'no-matching-clip');
  h = await run({ readManifest: () => ({ clips: [] }) }); assert.equal(h.reason, 'no-matching-clip');
  const t2 = { title: 'A fact with no animal' }; h = await run({ readHooks: () => ({ ok: true, hooks: [ent(1, { claimsSha256: claimsSha256(idea(1, t2)), approvedBy: 't', approvedAt: '2026-11-17T09:00:00Z' })] }) }, t2); assert.equal(h.reason, 'no-subject');
  h = await run({ readUsage: () => [{ clipId: 'c1' }] }); assert.equal(h.reason, 'no-matching-clip', 'the only clip is used');
});
test('A2: unapproved, stale and refused hooks are not usable, with their own reason', async () => {
  const r = await buildItems(withLane({ evaluate: async (i, { hook }) => (i.id === 'idea_4' ? { ok: false, reason: 'hook-number-not-in-claims' } : { ok: true, draft: { hook, caption: 'c' } }) }));
  const by = Object.fromEntries(r.items.map((i) => [i.id, i])); assert.deepEqual([by.idea_2.usableToday, by.idea_2.reason], [false, 'not-approved']); assert.deepEqual([by.idea_9.usableToday, by.idea_9.reason], [false, 'stale']); assert.deepEqual([by.idea_3.usableToday, by.idea_3.reason], [false, 'stale']);
  assert.deepEqual([by.idea_4.usableToday, by.idea_4.reason], [false, 'hook-number-not-in-claims']);
});
test('A2: two entries for one idea: only the one the lane would take is shown, with a note about the other', async () => {
  const a = ent(1, { hook: 'Old hook', approvedBy: null, approvedAt: null }); const b = ent(1, { hook: 'Approved hook', approvedBy: 't', approvedAt: '2026-11-17T09:00:00Z' });
  for (const order of [[a, b], [b, a]]) {
    const r = await buildItems(withLane({ readHooks: () => ({ ok: true, hooks: order }), evaluate: ev })); const hs = r.items.filter((i) => i.kind === 'hook' && i.id === 'idea_1');
    assert.equal(hs.length, 1); assert.equal(hs[0].title, 'Approved hook'); assert.equal(hs[0].facts.otherEntries, 1); assert.equal(hs[0].usableToday, true);
  }
  const r2 = await buildItems(withLane({ readHooks: () => ({ ok: true, hooks: [ent(1, { hook: 'First' }), ent(1, { hook: 'Second' })] }), evaluate: ev })); assert.deepEqual(r2.items.filter((i) => i.kind === 'hook').map((i) => i.title), ['Second'], 'none approved: the newest');
});
test('A2: the lane helper is the one prepareAutoPost uses (same verdicts)', () => {
  const clips = [clip('c1')]; const i1 = idea(1, { kind: 'rule' });
  assert.deepEqual(laneVerdictFor(i1, { clips, history: [], config: {}, now: NOW }).ok, true);
  assert.equal(laneVerdictFor(i1, { clips: [], history: [], config: {}, now: NOW }).reason, 'no-matching-clip');
  assert.equal(laneVerdictFor(i1, { clips, history: [], config: { autoKinds: [] }, now: NOW }).reason, 'bad-config:autoKinds');
});

test('B4: a claim carries the lane\'s own source line when a source name exists', async () => {
  const r = await buildItems(base({ sourceFor: async (c) => `Park service, read ${c.sourceDate}` })); const h = r.items.find((i) => i.id === 'idea_1');
  assert.deepEqual(h.facts.claims[0], { text: 'Claim A1', sourceDate: '2026-10-01', source: 'Park service, read 2026-10-01' });
  const r2 = await buildItems(base({ sourceFor: async () => { throw new Error('x'); } })); assert.deepEqual(r2.items.find((i) => i.id === 'idea_1').facts.claims[0], { text: 'Claim A1', sourceDate: '2026-10-01' }, 'a failing lookup leaves the name out');
});
test('D7: the hook checks run together, not one after the other', async () => {
  let running = 0; let peak = 0; const slow = async (i, { hook }) => { running += 1; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 15)); running -= 1; return { ok: true, draft: { hook, caption: 'c' } }; };
  const t0 = Date.now(); const r = await buildItems(base({ evaluate: slow })); assert.ok(r.items.length >= 4); assert.ok(peak >= 3, `peak ${peak}`);
  assert.deepEqual(r.items.map((i) => i.id), ['idea_4', 'idea_9', 'idea_3', 'idea_2', 'idea_1'], 'the order is kept'); assert.ok(Date.now() - t0 < 70);
});

test('change 1: a video text with no example video says so with its own note, not the clip note', async () => {
  const r = await buildItems(base()); for (const h of r.items.filter((i) => i.kind === 'hook')) { assert.equal(h.preview.note, 'no example video yet'); assert.notEqual(h.preview.note, NOTE_PENDING); assert.equal(NOTE_PENDING, 'video is being prepared', 'the clip note keeps its value'); }
});
test('change 2: within each kind the order is kept (clips by file time, texts newest first)', async () => {
  const dir = mk(); for (const f of ['c1', 'c2']) fs.writeFileSync(path.join(dir, `${f}.mp4`), 'x'); const t = new Date(Date.now() + 9000); fs.utimesSync(path.join(dir, 'c2.mp4'), t, t);
  const r = await buildItems(base({ readManifest: () => ({ clips: [clip('c1'), clip('c2')] }), libraryDir: dir, info: fileInfoOf() }));
  assert.deepEqual(r.items.map((i) => i.id), ['c2', 'c1', 'idea_4', 'idea_9', 'idea_3', 'idea_2', 'idea_1']);
});

test('clipReasonOf gives the same state and reason as buildClipItems for every clip of a matrix manifest', async () => {
  const dir = mk(); const mkf = (id) => fs.writeFileSync(path.join(dir, `${id}.mp4`), id);
  for (const id of ['ok', 'used', 'nov', 'fail', 'flash', 'noflash', 'render', 'sub', 'sup', 'real']) mkf(id);
  fs.symlinkSync(path.join(dir, 'real.mp4'), path.join(dir, 'link.mp4'));
  const manifest = { clips: [clip('ok'), clip('used'), clip('nov', { verified: null }), clip('fail', { verified: { verdict: 'fail', singleSubject: 'yes' } }), clip('flash', { flash: { flash: true } }), clip('noflash', { flash: undefined }),
    clip('render', { checks: { rendered: 'bad' } }), clip('gone'), clip('link'), clip('sup', { supersededBy: ['x'] }), clip('sub', { verified: { verdict: 'pass', singleSubject: 'no' } }), clip('real')] };
  assert.equal(manifest.clips.length, 12);
  for (const usage of [[{ clipId: 'used' }], null]) {
    const info = fileInfoOf(); const { items } = await buildClipItems({ manifest, libraryDir: dir, info, secret: 's', usage });
    assert.equal(items.length, 11); assert.ok(!items.some((i) => i.id === 'sup'));
    for (const it of items) {
      const c = manifest.clips.find((x) => x.id === it.id);
      assert.deepEqual(clipReasonOf(manifest, usage, dir, c, { info }), { state: it.state, reason: it.reason }, it.id);
    }
  }
  assert.equal(clipReasonOf(manifest, [], dir, manifest.clips.find((c) => c.id === 'link'), { info: fileInfoOf() }).reason, 'video-missing');
});

// ── task 7: decisions and allowed actions ────────────────────────────────────────
import { prepareAutoPost } from './auto-lane.js';
import { emptyApprovals, setDecision, clipsForLane } from './clip-approvals.js';
const T7_NOW = new Date('2026-11-17T09:00:00Z');
const shaOf = (s) => crypto.createHash('sha256').update(s).digest('hex');
const t7dir = (ids) => { const d = mk(); for (const id of ids) fs.writeFileSync(path.join(d, `${id}.mp4`), id); return d; };
const verOf = (id, tags = ['lion', 'savanna']) => clipVersion(shaOf(id), tags);
const appr = (clips = {}, enforcedAt = null) => { let d = emptyApprovals(); for (const [id, [state, version, at]] of Object.entries(clips)) d = setDecision(d, id, state, { version, at: at || '2026-11-17T08:00:00Z' }); return { ok: true, data: { ...d, enforcedAt } }; };
const t7base = (dir, over = {}) => base({ laneVerdict: laneVerdictFor, readHistory: () => [], readConfig: () => ({}), readUsage: () => [], now: T7_NOW, readManifest: () => ({ clips: [clip('c1')] }), libraryDir: dir, info: fileInfoOf(), readApprovals: () => appr(), evaluate: ev, ...over });
const byId = (r) => Object.fromEntries(r.items.map((i) => [i.id, i]));

test('actions per state: hook unapproved, refused, stale, approved, skipped; clip eligible, not eligible, decided, pending hash', async () => {
  const dir = t7dir(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
  const old = new Date(Date.now() - 86400e3); fs.utimesSync(path.join(dir, 'c4.mp4'), old, old); const fresh = new Date(Date.now() + 60000); for (const f of ['c1', 'c2', 'c3']) fs.utimesSync(path.join(dir, f + '.mp4'), fresh, fresh); // the oldest file is hashed last: with a budget of 4 new files it stays pending
  const hooks = [ent(1, { approvedBy: 't', approvedAt: '2026-11-17T08:00:00Z' }), ent(2), ent(3, { claimsSha256: 'a'.repeat(64) }), ent(4), ent(5, { skipped: { by: 't', at: '2026-11-17T08:00:00Z' } }), ent(9)];
  const ideas = [1, 2, 3, 4, 5].map((n) => idea(n));
  const clips = [clip('c1'), clip('c2', { verified: null }), clip('c3'), clip('c4'), clip('c5'), clip('c6'), clip('c7')];
  const approvals = appr({ c3: ['approved', verOf('c3')] });
  const r = await buildItems(t7base(dir, { readHooks: () => ({ ok: true, hooks }), loadPool: () => ({ ok: true, ideas, sourceNames: {} }), readManifest: () => ({ clips }), readApprovals: () => approvals, evaluate: async (i, { hook }) => (i.id === 'idea_4' ? { ok: false, reason: 'hook-number-not-in-claims' } : { ok: true, draft: { hook, caption: 'c' } }) }));
  const by = byId(r);
  assert.deepEqual(by.idea_1.actions, ['undo']); assert.deepEqual(by.idea_2.actions, ['approve', 'skip', 'edit']); assert.deepEqual(by.idea_4.actions, ['skip', 'edit']);
  assert.deepEqual(by.idea_3.actions, ['skip', 'edit'], 'stale with the idea present'); assert.deepEqual(by.idea_9.actions, [], 'stale, idea gone'); assert.deepEqual(by.idea_5.actions, ['undo']);
  assert.deepEqual(by.c1.actions, ['approve', 'skip']); assert.deepEqual(by.c2.actions, ['skip']); assert.deepEqual(by.c3.actions, ['undo']);
  assert.equal(by.c4.preview.note, NOTE_PENDING); assert.deepEqual(by.c4.actions, [], 'hash pending');
});
test('decision: hook approved and skipped carry kind and at; clip decision matches only for the same version', async () => {
  const dir = t7dir(['c1']);
  const hooks = [ent(1, { approvedBy: 't', approvedAt: '2026-11-17T08:00:00Z' }), ent(2, { skipped: { by: 't', at: '2026-11-17T07:00:00Z' } }), ent(3)];
  let r = await buildItems(t7base(dir, { readHooks: () => ({ ok: true, hooks }), readApprovals: () => appr({ c1: ['approved', verOf('c1')] }) })); let by = byId(r);
  assert.deepEqual(by.idea_1.decision, { kind: 'approved', at: '2026-11-17T08:00:00Z' }); assert.deepEqual(by.idea_2.decision, { kind: 'skipped', at: '2026-11-17T07:00:00Z' }); assert.equal(by.idea_3.decision, null);
  assert.deepEqual(by.c1.decision, { kind: 'approved', at: '2026-11-17T08:00:00Z' });
  r = await buildItems(t7base(dir, { readApprovals: () => appr({ c1: ['approved', verOf('c1', ['other'])] }) })); by = byId(r);
  assert.equal(by.c1.decision, null); assert.deepEqual(by.c1.actions, ['approve', 'skip']);
});
const f1 = (clipDecision, enforcedAt, over = {}) => { const dir = t7dir(['c1']); return { dir, args: t7base(dir, { readHooks: approvedHooks(1), readApprovals: () => appr(clipDecision ? { c1: [clipDecision, verOf('c1')] } : {}, enforcedAt), ...over }) }; };
test('F1: after enforcement with the only fitting clip skipped, the hook item is NOT usable today and the clip item does not say eligible (state skipped by you, reason skipped)', async () => {
  const { dir, args } = f1('skipped', '2026-11-17T08:30:00Z'); const by = byId(await buildItems(args));
  assert.equal(by.idea_1.usableToday, false); assert.notEqual(by.c1.state, 'eligible'); assert.deepEqual([by.c1.state, by.c1.reason, by.c1.usableToday], ['skipped by you', 'skipped', false]);
  const ap = path.join(mk(), 'a.json'); fs.writeFileSync(ap, JSON.stringify({ version: 1, enforcedAt: '2026-11-17T08:30:00Z', clips: { c1: { state: 'skipped', version: verOf('c1'), at: '2026-11-17T08:00:00Z', by: 'review page' } } }), { mode: 0o600 });
  const hf = path.join(mk(), 'h.json'); fs.writeFileSync(hf, '{"hooks":[]}');
  const lane = await prepareAutoPost({ pool: [idea(1, { kind: 'rule' })], manifest: { version: 1, clips: [clip('c1')] }, usage: [], history: [], config: {}, now: T7_NOW }, { outDir: mk(), libraryDir: dir, exists: () => true, neverPromotePatterns: ['examplehotel'], say: () => {}, hooksFile: hf, approvalsFile: ap, hashClip: async (f) => shaOf(path.basename(f, '.mp4')) });
  assert.deepEqual([lane.ok, lane.reasons], [false, ['no-eligible-clip']]);
});
test('F1: after enforcement an undecided eligible clip is eligible but not usable today (reason not-approved) and the hook that needs it is not usable; approving it flips both', async () => {
  let { args } = f1(null, '2026-11-17T08:30:00Z'); let by = byId(await buildItems(args));
  assert.deepEqual([by.c1.state, by.c1.usableToday, by.c1.reason], ['eligible', false, 'not-approved']); assert.equal(by.idea_1.usableToday, false); assert.deepEqual(by.c1.actions, ['approve', 'skip']);
  ({ args } = f1('approved', '2026-11-17T08:30:00Z')); by = byId(await buildItems(args));
  assert.deepEqual([by.c1.state, by.c1.usableToday, by.c1.reason], ['eligible', true, null]); assert.equal(by.idea_1.usableToday, true);
});
test('F1: before enforcement an undecided clip still makes a hook usable (step 1 behaviour kept); a skipped one never does', async () => {
  let { args } = f1(null, null); let by = byId(await buildItems(args)); assert.equal(by.c1.usableToday, true); assert.equal(by.idea_1.usableToday, true);
  ({ args } = f1('skipped', null)); by = byId(await buildItems(args)); assert.equal(by.c1.usableToday, false); assert.equal(by.idea_1.usableToday, false); assert.equal(by.c1.reason, 'skipped');
});
test('the page and the lane agree on which clips are usable (clipsForLane over the same data)', async () => {
  const dir = t7dir(['c1', 'c2', 'c3']); const manifest = { clips: [clip('c1'), clip('c2'), clip('c3')] };
  const approvals = appr({ c1: ['approved', verOf('c1')], c2: ['skipped', verOf('c2')] }, '2026-11-17T08:30:00Z');
  const by = byId(await buildItems(t7base(dir, { readManifest: () => manifest, readApprovals: () => approvals })));
  const lane = await clipsForLane(eligibleClips(manifest, [], { dir, exists: fs.existsSync }), approvals.data, { dir, hash: async (f) => shaOf(path.basename(f, '.mp4')) });
  assert.deepEqual(['c1', 'c2', 'c3'].filter((id) => by[id].usableToday), lane.map((c) => c.id).sort());
});
test('an item decided 31 days ago is gone from items and from media; 29 days ago stays (D12)', async () => {
  const dir = t7dir(['c1', 'c2']); const day = 86400e3; const ago = (n) => new Date(T7_NOW.getTime() - n * day).toISOString();
  const hooks = [ent(1, { approvedBy: 't', approvedAt: ago(31) }), ent(2, { approvedBy: 't', approvedAt: ago(29) }), ent(3, { skipped: { by: 't', at: ago(31) } })];
  const r = await buildItems(t7base(dir, { readHooks: () => ({ ok: true, hooks }), readManifest: () => ({ clips: [clip('c1'), clip('c2')] }), readApprovals: () => appr({ c1: ['approved', verOf('c1'), ago(31)], c2: ['skipped', verOf('c2'), ago(29)] }) }));
  const ids = r.items.map((i) => i.id).sort(); assert.deepEqual(ids, ['c2', 'idea_2']); assert.deepEqual(r.counts, { all: 2, hook: 1, clip: 1 });
  const c2 = byId(r).c2; assert.equal(r.media.has(c2.preview.mediaId), true); assert.equal(r.media.size, 1, 'the 31-day clip is not in media');
});
test('unreadable approvals: clips get no actions, laneClips is empty (hooks are not usable today), and the problem approvals-unreadable is listed; hooks still carry their actions', async () => {
  const dir = t7dir(['c1']); const r = await buildItems(t7base(dir, { readHooks: () => ({ ok: true, hooks: [ent(1, { approvedBy: 't', approvedAt: '2026-11-17T08:00:00Z' }), ent(2)] }), readApprovals: () => ({ ok: false, reason: 'not-json' }) }));
  const by = byId(r); assert.ok(r.problems.includes('approvals-unreadable')); assert.deepEqual(by.c1.actions, []); assert.equal(by.c1.usableToday, false);
  assert.equal(by.idea_1.usableToday, false); assert.deepEqual(by.idea_2.actions, ['approve', 'skip', 'edit']); assert.deepEqual(by.idea_1.actions, ['undo']);
  const r2 = await buildItems(t7base(dir, { readApprovals: () => { throw new Error('x'); } })); assert.ok(r2.problems.includes('approvals-unreadable'));
});
test('used hook or clip: undo is not offered', async () => {
  const dir = t7dir(['c1']); const hooks = [ent(1, { approvedBy: 't', approvedAt: '2026-11-17T08:00:00Z' }), ent(2, { skipped: { by: 't', at: '2026-11-17T08:00:00Z' } })];
  const r = await buildItems(t7base(dir, { readHooks: () => ({ ok: true, hooks }), readHistory: () => [{ ideaId: 'idea_1', date: '2026-11-01T00:00:00Z' }], readUsage: () => [{ clipId: 'c1' }], readApprovals: () => appr({ c1: ['approved', verOf('c1')] }) }));
  const by = byId(r); assert.deepEqual(by.idea_1.actions, []); assert.deepEqual(by.idea_2.actions, ['undo']); assert.deepEqual([by.c1.reason, by.c1.actions], ['already-used', []]);
});
test('a clip without shows: page version === lane version (F2)', async () => {
  const dir = t7dir(['c1']); const r = await buildItems(t7base(dir, { readManifest: () => ({ clips: [clip('c1', { shows: undefined })] }) }));
  assert.equal(byId(r).c1.version, clipVersion(shaOf('c1'), []));
});
test('step 1 shape is kept: every item has exactly the keys kind, id, version, title, preview, facts, state, reason, usableToday, decision, actions', async () => {
  const dir = t7dir(['c1']); const r = await buildItems(t7base(dir)); assert.ok(r.items.length > 1);
  for (const i of r.items) assert.deepEqual(Object.keys(i), ['kind', 'id', 'version', 'title', 'preview', 'facts', 'state', 'reason', 'usableToday', 'decision', 'actions']);
});
test('ids __proto__ and constructor as clip or hook ids do not break the build and are never found as someone else\'s decision', async () => {
  const dir = t7dir(['__proto__', 'constructor', 'c1']);
  const r = await buildItems(t7base(dir, { readManifest: () => ({ clips: [clip('__proto__'), clip('constructor'), clip('c1')] }), readApprovals: () => appr({ c1: ['approved', verOf('c1')] }) }));
  const by = Object.fromEntries(r.items.filter((i) => i.kind === 'clip').map((i) => [i.id, i]));
  for (const id of ['__proto__', 'constructor']) { assert.equal(by[id].decision, null); assert.deepEqual(by[id].actions, ['approve', 'skip']); }
  assert.deepEqual(by.c1.decision, { kind: 'approved', at: '2026-11-17T08:00:00Z' });
});
