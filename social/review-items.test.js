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
import { eligibleClips } from './clip-library.js';
import { laneVerdictFor } from './auto-lane.js';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-rev-'));
const clip = (id, over = {}) => ({ id, file: `${id}.mp4`, durationSec: 7, source: [{ videoId: 'v1', startSec: 1, endSec: 8 }], checks: { rendered: 'ok' }, flash: { flash: false }, verified: { verdict: 'pass', singleSubject: 'yes', notes: 'a lion' }, shows: { tags: ['lion', 'savanna'], by: 't' }, ...over });
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
  assert.deepEqual(Object.keys(by.c1).sort(), ['actions', 'facts', 'id', 'kind', 'preview', 'reason', 'state', 'title', 'usableToday', 'version']); assert.equal(by.c1.kind, 'clip'); assert.equal(by.c1.title, 'c1');
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
const idea = (n, over = {}) => ({ id: `idea_${n}`, kind: 'rule', title: `Lion fact ${n}`, link: `/x/${n}/`, claims: [{ text: `Claim A${n}`, sourceDate: '2026-10-01' }, { text: `Claim B${n}`, sourceDate: '2026-10-02' }], ...over });
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

// ── truth of what the page says (fix round A) ────────────────────────────────────
const inside = (dir, f) => { const rel = path.relative(path.resolve(dir), path.resolve(dir, f)); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
test('A1: the clips shown as eligible are exactly the lane\'s set (verdict, subject, flash, superseded, missing file, ledger)', () => {
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
  const { items } = buildClipItems({ manifest, libraryDir: dir, info: fileInfoOf(), secret: 's', usage });
  assert.deepEqual(new Set(items.filter((i) => i.state === 'eligible').map((i) => i.id)), lane);
  assert.deepEqual(new Set(items.filter((i) => i.usableToday).map((i) => i.id)), lane);
  const by = Object.fromEntries(items.map((i) => [i.id, i])); assert.equal(by.used.state, 'already used in a post'); assert.equal(by.used.reason, 'already-used'); assert.equal(by.used.usableToday, false);
  assert.equal(by.gone.state, 'video missing'); assert.equal(by.gone.reason, 'video-missing'); assert.equal(by.badrender.reason, 'render-check-failed'); assert.equal(by.sup, undefined);
});
test('A1: the ledger also matches by source overlap, as the lane does', () => {
  const dir = mk(); fs.writeFileSync(path.join(dir, 'c1.mp4'), 'x'); const manifest = { clips: [clip('c1')] };
  const usage = [{ id: 'v1', startSec: 2, endSec: 6 }]; const lane = eligibleClips(manifest, usage, { dir, exists: fs.existsSync });
  assert.equal(lane.length, 0); assert.equal(buildClipItems({ manifest, libraryDir: dir, info: fileInfoOf(), secret: 's', usage }).items[0].state, 'already used in a post');
});
test('A1: an unreadable ledger (usage null) makes nothing eligible', () => {
  const dir = mk(); fs.writeFileSync(path.join(dir, 'c1.mp4'), 'x'); const it = buildClipItems({ manifest: { clips: [clip('c1')] }, libraryDir: dir, info: fileInfoOf(), secret: 's', usage: null }).items[0];
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
