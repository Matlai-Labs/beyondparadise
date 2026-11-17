import './test-env.js';
// Clip decisions: a private file, one-way enforcement, the same version on the lane and on the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readClipApprovals, writeClipApprovals, emptyApprovals, clipVersion, tagsOf, hashFile, decisionOf, setDecision, clearDecision, maybeEnforce, laneAllows, clipsForLane, stockRightsProblem } from './clip-approvals.js';
import { buildClipItems, fileInfoOf } from './review-items.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V = (n) => String(n).repeat(64).slice(0, 64); const AT = '2026-11-17T09:00:00Z';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-clipappr-'));
const put = (f, obj, mode = 0o600) => { fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); fs.chmodSync(f, mode); return f; };

test('read: missing file is empty; wrong mode, directory, bad JSON, bad entry all refuse', () => {
  assert.deepEqual(readClipApprovals(path.join(tmp(), 'none.json')), { ok: true, data: emptyApprovals() });
  const d = tmp(); const good = { version: 1, enforcedAt: null, clips: { c1: { state: 'approved', version: V(1), at: AT, by: 'review page' } } };
  assert.equal(readClipApprovals(put(path.join(d, 'a.json'), good)).ok, true);
  assert.equal(readClipApprovals(put(path.join(d, 'b.json'), good, 0o644)).ok, false, 'mode');
  fs.mkdirSync(path.join(d, 'dir.json')); assert.equal(readClipApprovals(path.join(d, 'dir.json')).ok, false, 'directory');
  assert.equal(readClipApprovals(put(path.join(d, 'c.json'), '{broken')).ok, false, 'json');
  for (const [i, bad] of [{ ...good, clips: { c1: { ...good.clips.c1, state: 'maybe' } } }, { ...good, clips: { c1: { ...good.clips.c1, version: 'zz' } } }, { ...good, clips: { c1: { ...good.clips.c1, at: 'not a date' } } }, { version: 1, clips: [] }, [], { ...good, enforcedAt: 5 }].entries()) assert.equal(readClipApprovals(put(path.join(d, `e${i}.json`), bad)).ok, false, `bad ${i}`);
});
test('write is atomic and mode 600; a reader never sees half a file', async () => {
  const f = path.join(tmp(), 'sub', 'a.json'); let bad = 0;
  writeClipApprovals(f, setDecision(emptyApprovals(), 'c0', 'approved', { version: V(1), at: AT }));
  const w = (async () => { for (let i = 0; i < 200; i++) writeClipApprovals(f, setDecision(emptyApprovals(), `c${i % 5}`, 'skipped', { version: V(2), at: AT })); })();
  for (let i = 0; i < 400; i++) { if (!readClipApprovals(f).ok) bad++; await new Promise((r) => setImmediate(r)); }
  await w; assert.equal(bad, 0); assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});
test('clipVersion keeps the step 1 algorithm', () => { assert.equal(clipVersion('x', ['b', 'a']), crypto.createHash('sha256').update(JSON.stringify(['x', ['a', 'b']])).digest('hex')); });
test('tagsOf: strings only; a clip without shows, with shows but no tags, or with tags that is not a list gives []; never throws', () => {
  assert.deepEqual(tagsOf({ shows: { tags: ['a', 3, 'b'] } }), ['a', 'b']);
  for (const c of [{}, { shows: null }, { shows: {} }, { shows: { tags: 'x' } }, null]) assert.deepEqual(tagsOf(c), []);
});
test('a clip without shows gets the SAME version from the lane (clipsForLane) and from the page (buildClipItems)', async () => {
  const dir = tmp(); fs.writeFileSync(path.join(dir, 'c.mp4'), Buffer.alloc(1000, 7)); const sha = await hashFile(path.join(dir, 'c.mp4'));
  const clip = { id: 'c1', file: 'c.mp4', durationSec: 5 };
  const data = maybeEnforce(setDecision(emptyApprovals(), 'c1', 'approved', { version: clipVersion(sha, []), at: AT }), [{ id: 'c1', version: clipVersion(sha, []) }], AT);
  assert.ok(data.enforcedAt);
  assert.deepEqual((await clipsForLane([clip], data, { dir })).map((c) => c.id), ['c1']);
  const built = await buildClipItems({ manifest: { clips: [clip] }, libraryDir: dir, info: fileInfoOf(), secret: 's' });
  assert.equal(built.items[0].version, clipVersion(sha, []));
});
test('decisionOf: approved, skipped, undecided; a changed version is undecided', () => {
  let d = setDecision(emptyApprovals(), 'c1', 'approved', { version: V(1), at: AT });
  assert.equal(decisionOf(d, 'c1', V(1)), 'approved'); assert.equal(decisionOf(d, 'c1', V(2)), 'undecided'); assert.equal(decisionOf(d, 'c2', V(1)), 'undecided');
  d = setDecision(d, 'c1', 'skipped', { version: V(1), at: AT }); assert.equal(decisionOf(d, 'c1', V(1)), 'skipped');
  assert.equal(decisionOf(clearDecision(d, 'c1'), 'c1', V(1)), 'undecided');
});
test('ids __proto__ and constructor are ordinary ids: set, read back from disk, decide, clear; no prototype is touched; a missing entry never returns an inherited value', () => {
  for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(decisionOf(emptyApprovals(), id, V(1)), 'undecided'); assert.equal(laneAllows(emptyApprovals(), id, V(1)), true);
    const d = setDecision(emptyApprovals(), id, 'skipped', { version: V(1), at: AT }); assert.equal(decisionOf(d, id, V(1)), 'skipped');
    const f = path.join(tmp(), 'a.json'); writeClipApprovals(f, d); const back = readClipApprovals(f); assert.equal(back.ok, true); assert.equal(decisionOf(back.data, id, V(1)), 'skipped');
    assert.equal(Object.getPrototypeOf(back.data.clips), null);
    assert.equal(decisionOf(clearDecision(d, id), id, V(1)), 'undecided'); assert.equal(({}).polluted, undefined); assert.equal(Object.getPrototypeOf(d.clips), null);
    assert.equal(Object.getPrototypeOf(clearDecision(d, id).clips), null);
  }
});
test('maybeEnforce: only when every current clip is decided for its version; one way; empty list never', () => {
  const cur = [{ id: 'c1', version: V(1) }, { id: 'c2', version: V(2) }]; let d = setDecision(emptyApprovals(), 'c1', 'approved', { version: V(1), at: AT });
  assert.equal(maybeEnforce(d, cur, AT).enforcedAt, null); d = setDecision(d, 'c2', 'skipped', { version: V(2), at: AT }); const e = maybeEnforce(d, cur, AT); assert.equal(e.enforcedAt, AT);
  assert.equal(maybeEnforce(clearDecision(e, 'c1'), cur, '2026-11-18T00:00:00Z').enforcedAt, AT, 'undo does not switch it off'); assert.equal(maybeEnforce(emptyApprovals(), [], AT).enforcedAt, null);
});
test('laneAllows: skipped never; before enforcement undecided is allowed; after it only approved for the current version; an unknown version (null) is allowed only before enforcement and only for a clip with no entry', () => {
  const free = emptyApprovals(); const enf = { ...emptyApprovals(), enforcedAt: AT };
  const sk = (d) => setDecision(d, 'c', 'skipped', { version: V(1), at: AT }); const ap = (d) => setDecision(d, 'c', 'approved', { version: V(1), at: AT });
  assert.equal(laneAllows(free, 'c', V(1)), true, 'free undecided');
  assert.equal(laneAllows(sk(free), 'c', V(1)), false, 'free skipped');
  assert.equal(laneAllows(ap(free), 'c', V(1)), true, 'free approved');
  assert.equal(laneAllows(enf, 'c', V(1)), false, 'enforced undecided');
  assert.equal(laneAllows(sk(enf), 'c', V(1)), false, 'enforced skipped');
  assert.equal(laneAllows(ap(enf), 'c', V(1)), true, 'enforced approved');
  assert.equal(laneAllows(ap(enf), 'c', V(2)), false, 'enforced approved, other version');
  assert.equal(laneAllows(free, 'c', null), true, 'null version, free, no entry');
  assert.equal(laneAllows(ap(free), 'c', null), false, 'null version, free, has entry');
  assert.equal(laneAllows(enf, 'c', null), false, 'null version, enforced');
});
test('clipsForLane: not enforced and no entry: no hashing at all; enforced: only approved with matching hash; a replaced file (other hash) drops; hash error drops', async () => {
  const mk = (id) => ({ id, file: `${id}.mp4`, shows: { tags: ['t'] } }); const clips = [mk('a'), mk('b')]; let calls = 0;
  const hash = async (abs) => { calls++; return path.basename(abs).startsWith('a') ? 'AAA' : 'BBB'; };
  assert.deepEqual((await clipsForLane(clips, emptyApprovals(), { dir: '/x', hash })).map((c) => c.id), ['a', 'b']); assert.equal(calls, 0);
  const va = clipVersion('AAA', ['t']);
  let d = setDecision(emptyApprovals(), 'a', 'approved', { version: va, at: AT }); d = { ...d, enforcedAt: AT };
  assert.deepEqual((await clipsForLane(clips, d, { dir: '/x', hash })).map((c) => c.id), ['a']);
  assert.deepEqual((await clipsForLane(clips, d, { dir: '/x', hash: async () => 'CHANGED' })).map((c) => c.id), [], 'replaced');
  assert.deepEqual((await clipsForLane(clips, d, { dir: '/x', hash: async () => { throw new Error('x'); } })).map((c) => c.id), [], 'hash error');
  // not enforced, one skipped entry: only that clip is hashed, and it is dropped
  calls = 0; const s = setDecision(emptyApprovals(), 'b', 'skipped', { version: clipVersion('BBB', ['t']), at: AT });
  assert.deepEqual((await clipsForLane(clips, s, { dir: '/x', hash })).map((c) => c.id), ['a']); assert.equal(calls, 1);
});
test('stockRightsProblem: own clips none; a stock clip needs all four fields', () => {
  assert.equal(stockRightsProblem({ id: 'c' }), null);
  const ok = { sourceUrl: 'https://example.com/v/1', author: 'A', licenceName: 'CC0', downloadedAt: '2026-11-17' }; assert.equal(stockRightsProblem({ id: 's', stock: ok }), null);
  for (const k of Object.keys(ok)) { assert.equal(stockRightsProblem({ id: 's', stock: { ...ok, [k]: '' } }), 'rights-missing', k); assert.equal(stockRightsProblem({ id: 's', stock: { ...ok, [k]: undefined } }), 'rights-missing', k); }
});
test('no module in this step writes the clip approvals file except clip-approvals.js and bpa-actions.js; clip-library.js never mentions it (F6)', () => {
  const files = fs.readdirSync(HERE).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
  for (const f of files) { const src = fs.readFileSync(path.join(HERE, f), 'utf8'); if (/writeClipApprovals\(/.test(src)) assert.ok(['clip-approvals.js', 'bpa-actions.js'].includes(f), `${f} writes the clip approvals file`); }
  assert.equal(/clip-approvals/.test(fs.readFileSync(path.join(HERE, 'clip-library.js'), 'utf8')), false);
});
