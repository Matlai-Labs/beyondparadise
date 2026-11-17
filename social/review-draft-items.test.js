import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto';
import { buildDraftItems, NOTE_DRAFT_NO_PICTURE } from './review-draft-items.js';
import { buildItems, fileInfoOf, mediaIdFor } from './review-items.js';
import { nextSlots } from './lib.js';
import { sourcesRecord } from './claim-gate.js';
import { draftVersion } from './draft-version.js';
import { emptyApprovals } from './clip-approvals.js';

const NOW = new Date('2026-11-18T10:00:00Z'); const SECRET = 'test-secret';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-di-'));
const src = (host, n = 1) => ({ claim: `claim ${n}`, source: `Site ${n}`, url: `https://${host}/p`, line: `exact line ${n}` });
const draft = (id, extra = {}) => ({ id, status: 'pending_approval', kind: 'outlook', text: `Lions sleep most of the day on the plains (${id}).`, createdAt: '2026-11-15T08:00:00Z', ...extra });
function run(drafts, over = {}) {
  const calls = { check: 0 };
  const inp = { readQueue: () => ({ ok: true, q: { seq: 1, drafts } }), checkFor: async () => { calls.check++; return { ok: true }; }, stop: () => ({ stopped: false }), igOn: () => false, approveOn: () => true, approvedIds: new Set(), ttlDays: 7, now: NOW, autoDir: tmp(), info: fileInfoOf(), secret: SECRET, ...over };
  return buildDraftItems(inp).then((r) => ({ ...r, calls, inp }));
}
const one = async (d, over) => { const r = await run([d], over); assert.equal(r.items.length, 1, JSON.stringify(r.problems)); return { item: r.items[0], r }; };

test('1 a ready pending draft: waiting, three actions, the next free day, the expiry in words, complete sources only, no url', async () => {
  const T = 'A resort on Muyuni Beach'; const d = draft('B1', { text: T, ...sourcesRecord(T, [src('a.com'), src('b.org', 2)]) }); d.claimSources.push({ claim: 'half' }, 5, null);
  const { item } = await one(d);
  assert.equal(item.kind, 'draft'); assert.equal(item.id, 'B1'); assert.equal(item.version, draftVersion(d)); assert.equal(item.state, 'waiting'); assert.equal(item.reason, null); assert.deepEqual(item.actions, ['approve', 'skip', 'edit']); assert.equal(item.usableToday, false); assert.equal(item.decision, null);
  assert.equal(item.facts.nextSlot, nextSlots({ drafts: [] }, 1, NOW)[0]); assert.match(item.facts.nextSlot, /T09:00:00\+03:00$/);
  assert.equal(item.facts.expiresText, '22 Nov at 11:00 (East Africa time)'); assert.equal(item.facts.nextSlotText, '19 Nov at 09:00 (East Africa time)'); assert.equal(item.facts.text, T);
  assert.deepEqual(item.facts.sources, [{ claim: 'claim 1', source: 'Site 1', line: 'exact line 1' }, { claim: 'claim 2', source: 'Site 2', line: 'exact line 2' }]); assert.deepEqual(item.preview, { mediaId: null, note: NOTE_DRAFT_NO_PICTURE });
  assert.equal(item.title, T);
});
test('2 check-meta first; approve-off keeps it waiting without Approve; hidden characters; a heart emoji is fine', async () => {
  for (const d of [draft('B1', { metaUnknown: { at: 'x' }, text: 'Lions sleep​.' }), draft('B1')]) {
    const over = d.metaUnknown ? {} : { approvedIds: new Set(['B1']) }; const { item, r } = await one(d, { ...over, stop: () => ({ stopped: true }), checkFor: async () => ({ ok: false }) });
    assert.equal(item.reason, 'check-meta'); assert.equal(item.state, 'refused: check-meta'); assert.deepEqual(item.actions, ['skip']); assert.equal(r.calls.check, 0);
  }
  { const { item } = await one(draft('B1'), { approveOn: () => false }); assert.equal(item.state, 'waiting'); assert.equal(item.reason, 'approve-off'); assert.deepEqual(item.actions, ['skip', 'edit']); }
  for (const over of [{ text: 'Lions sleep​ here.' }, { videoText: 'Lions​' }]) { const { item } = await one(draft('B1', over)); assert.equal(item.reason, 'hidden-characters'); assert.equal(item.state, 'refused: hidden-characters'); assert.deepEqual(item.actions, ['skip', 'edit']); }
  { const { item } = await one(draft('B1', { text: 'Love the lions ❤️ on the plains.' })); assert.equal(item.reason, null); }
});
test('2b each refusal has its reason, state and actions', async () => {
  const T = 'A resort on Muyuni Beach';
  const cases = [
    [draft('B1', { text: T }), {}, 'sources-missing', ['skip', 'edit']],
    [draft('B1', { text: T, ...sourcesRecord('Other text on Paje', [src('a.com'), src('b.org', 2)]) }), {}, 'sources-outdated', ['skip', 'edit']],
    [(() => { const d = draft('B1', { text: T, ...sourcesRecord(T, [src('a.com'), src('b.org', 2)]) }); delete d.claimSourcesHash; return d; })(), {}, 'sources-old', ['skip', 'edit']],
    [draft('B1', { text: T, ...sourcesRecord(T, [src('a.com'), src('www.a.com', 2)]) }), {}, 'sources-too-few', ['skip', 'edit']],
    [draft('B1', { text: '   ' }), {}, 'text-missing', ['skip', 'edit']],
    [draft('B1'), { stop: () => ({ stopped: true }) }, 'stopped', ['skip', 'edit']],
    [draft('B1'), { checkFor: async () => ({ ok: false, ruleIds: ['x'] }) }, 'final-check', ['skip', 'edit']],
    [draft('B1', { createdAt: '2026-11-10T08:00:00Z' }), {}, 'expired', []],
  ];
  for (const [d, over, reason, actions] of cases) { const { item } = await one(d, over); assert.equal(item.reason, reason, reason); assert.equal(item.state, `refused: ${reason}`); assert.deepEqual(item.actions, actions, reason); }
});
test('3 priority: a source problem beats the final check; stopped beats the final check; checkFor is not called when an earlier reason applies', async () => {
  const T = 'A resort on Muyuni Beach'; const bad = async () => ({ ok: false });
  { const { item, r } = await one(draft('B1', { text: T }), { checkFor: bad }); assert.equal(item.reason, 'sources-missing'); assert.equal(r.calls.check, 0); }
  { const { item, r } = await one(draft('B1'), { checkFor: bad, stop: () => ({ stopped: true }) }); assert.equal(item.reason, 'stopped'); assert.equal(r.calls.check, 0); }
  { const { r } = await one(draft('B1')); assert.equal(r.calls.check, 1); }
});
test('4 blocked, scheduled (manual and automatic), skipped in and out of the window, posted, expired and failed are hidden', async () => {
  const r = await run([draft('B1', { status: 'blocked', blocked: { rules: ['sea-conditions', 'paid-link-wording'] } }), draft('B2', { status: 'scheduled', scheduledFor: '2026-11-19T09:00:00+03:00', decidedAt: '2026-11-17T10:00:00Z' }),
    draft('B3', { status: 'scheduled', auto: true, scheduledFor: '2026-11-19T09:00:00+03:00' }), draft('B4', { status: 'skipped', decidedAt: '2026-11-10T10:00:00Z' }), draft('B5', { status: 'skipped', decidedAt: '2026-09-01T10:00:00Z' }),
    draft('B6', { status: 'posted' }), draft('B7', { status: 'expired' }), draft('B8', { status: 'failed' })]);
  const by = Object.fromEntries(r.items.map((i) => [i.id, i])); assert.deepEqual(Object.keys(by).sort(), ['B1', 'B2', 'B3', 'B4']);
  assert.deepEqual({ s: by.B1.state, r: by.B1.reason, a: by.B1.actions }, { s: 'blocked', r: 'blocked', a: [] }); assert.deepEqual(by.B1.facts.blockedRules, ['sea-conditions', 'paid-link-wording']);
  assert.deepEqual({ s: by.B2.state, a: by.B2.actions, d: by.B2.decision }, { s: 'scheduled', a: [], d: { kind: 'scheduled', at: '2026-11-17T10:00:00Z' } }); assert.equal(by.B2.facts.whenText, '19 Nov at 09:00 (East Africa time)');
  assert.deepEqual({ s: by.B3.state, a: by.B3.actions, d: by.B3.decision, auto: by.B3.facts.auto }, { s: 'automatic', a: [], d: null, auto: true });
  assert.deepEqual({ s: by.B4.state, a: by.B4.actions, d: by.B4.decision }, { s: 'skipped', a: [], d: { kind: 'skipped', at: '2026-11-10T10:00:00Z' } });
});
test('5 a prepared post: a real file in the automatic folder shows a video; a changed file, a file outside, .., a link and a name with a space show none', async () => {
  const dir = tmp(); const f = path.join(dir, 'reel_1.mp4'); fs.writeFileSync(f, 'not really a video but real bytes'); const sha = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const auto = (extra) => draft('B1', { status: 'scheduled', auto: true, scheduledFor: '2026-11-19T09:00:00+03:00', readyFile: f, readyFileSha256: sha, ...extra });
  { const { item, r } = await one(auto(), { autoDir: dir }); const st = fs.lstatSync(f); assert.equal(item.reason, null); assert.equal(item.preview.mediaId, mediaIdFor(SECRET, 'B1', item.version)); assert.equal(r.media.size, 1);
    assert.deepEqual(r.media.get(item.preview.mediaId), { path: f, kind: 'prepared', size: st.size, mtimeMs: st.mtimeMs, ino: st.ino }); }
  { const { item, r } = await one(auto({ readyFileSha256: 'a'.repeat(64) }), { autoDir: dir }); assert.equal(item.reason, 'ready-file-changed'); assert.equal(item.preview.mediaId, null); assert.equal(r.media.size, 0); }
  const outside = path.join(tmp(), 'other.mp4'); fs.writeFileSync(outside, 'x'); const space = path.join(dir, 'my reel.mp4'); fs.writeFileSync(space, 'x'); const link = path.join(dir, 'link.mp4'); fs.symlinkSync(f, link);
  for (const readyFile of [outside, path.join(dir, '..', 'reel_1.mp4'), `${dir}/../${path.basename(dir)}/../x.mp4`, link, space, path.join(dir, 'missing.mp4'), 5, null]) {
    const { item, r } = await one(auto({ readyFile }), { autoDir: dir }); assert.equal(item.reason, 'video-missing', String(readyFile)); assert.equal(item.preview.mediaId, null); assert.equal(r.media.size, 0);
  }
});
test('6 hostile input never throws and nothing hostile is sent', async () => {
  const r = await run([null, 5, 'x', { id: 7, status: 'pending_approval' }, draft('__proto__'), draft('constructor', { claimSources: 'nope', claims: 'nope' }), draft('B3', { claimSources: [1, 'x', null, { claim: 5 }], text: 'Lions sleep.' }),
    draft('B4', { status: 'blocked', blocked: { rules: ['has space', 'x'.repeat(200), 5, 'ok-rule'] } }), draft('B5', { lastError: 'SECRET-ERROR-TEXT '.repeat(20) })]);
  assert.ok(r.items.length >= 4); assert.ok(!JSON.stringify(r.items).includes('SECRET-ERROR-TEXT'));
  assert.deepEqual(r.items.find((i) => i.id === 'B4').facts.blockedRules, ['ok-rule']); assert.equal(r.items.find((i) => i.id === 'B5').facts.lastTryFailed, true);
});
test('7 an unreadable queue: no items, one problem, no throw', async () => {
  for (const readQueue of [() => ({ ok: false, code: 'queue-unreadable' }), () => { throw new Error('x'); }]) { const r = await run([], { readQueue }); assert.deepEqual(r.items, []); assert.deepEqual(r.problems, ['queue-unreadable']); }
});
const hookBase = () => ({ readHooks: () => ({ ok: true, hooks: [] }), loadPool: () => ({ ok: true, ideas: [], sourceNames: {} }), readManifest: () => null, libraryDir: tmp(), info: fileInfoOf(), secret: SECRET, evaluate: async () => ({ ok: false }), now: NOW, readApprovals: () => ({ ok: true, data: emptyApprovals() }) });
test('8 buildItems: drafts first, counts.draft; without buildDrafts the old shape plus draft 0; a throwing buildDrafts adds one problem', async () => {
  const w = await buildItems({ ...hookBase(), buildDrafts: () => buildDraftItems({ readQueue: () => ({ ok: true, q: { drafts: [draft('B1')] } }), checkFor: async () => ({ ok: true }), stop: () => ({ stopped: false }), igOn: () => false, approveOn: () => true, ttlDays: 7, now: NOW, autoDir: tmp(), info: fileInfoOf(), secret: SECRET }) });
  assert.deepEqual(w.items.map((i) => i.kind), ['draft']); assert.deepEqual(w.counts, { all: 1, hook: 0, clip: 0, draft: 1 });
  const wo = await buildItems(hookBase()); assert.deepEqual(wo.counts, { all: 0, hook: 0, clip: 0, draft: 0 });
  const bad = await buildItems({ ...hookBase(), buildDrafts: () => { throw new Error('x'); } }); assert.ok(bad.problems.includes('queue-unreadable')); assert.equal(bad.counts.draft, 0);
});
test('8b caps: 20 sources, 300 per source field, 5000 characters of text, a title never splits an emoji, draftKind only when it looks like a word', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ claim: `c${i}`, source: 's', url: 'https://a.example/x', line: 'l' })); const long = { claim: 'c', source: 's', url: 'https://a.example/x', line: 'L'.repeat(10000) };
  const { item } = await one(draft('B1', { claimSources: [long, ...many], text: 'x'.repeat(9000) })); assert.equal(item.facts.sources.length, 20); assert.equal(item.facts.sources[0].line.length, 300); assert.equal(item.facts.text.length, 5000);
  const emoji = `${'a'.repeat(118)}\u{1F981}\u{1F981} rest`; const { item: e } = await one(draft('B2', { text: emoji })); assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(e.title), 'no lone surrogate'); assert.ok(Array.from(e.title).length <= 120); assert.ok(e.title.endsWith('…'));
  for (const kind of ['x'.repeat(50), 'a b', 5, '']) assert.equal((await one(draft('B3', { kind }))).item.facts.draftKind, null, String(kind)); assert.equal((await one(draft('B4', { kind: 'outlook' }))).item.facts.draftKind, 'outlook');
  const { item: v } = await one(draft('B5', { videoText: 'v'.repeat(9000) })); assert.equal(v.facts.videoText.length, 5000);
});
test('9 no item carries a url, an error text, a file path or a hash of the sources', async () => {
  const dir = tmp(); const f = path.join(dir, 'reel_1.mp4'); fs.writeFileSync(f, 'bytes'); const sha = crypto.createHash('sha256').update('bytes').digest('hex'); const T = 'A resort on Muyuni Beach';
  const r = await run([draft('B1', { text: T, ...sourcesRecord(T, [src('a.com'), src('b.org', 2)]), lastError: 'boom' }), draft('B2', { status: 'scheduled', auto: true, readyFile: f, readyFileSha256: sha })], { autoDir: dir });
  const json = JSON.stringify(r.items); for (const k of ['"url"', 'lastError', 'readyFile', 'claimSourcesHash']) assert.ok(!json.includes(k), k); assert.ok(!json.includes(dir));
});

// ── fix round R3: a text longer than the card can show is never approved or edited on the page ─────────────────────────
test('R3 a text over 5000 characters: reason text-too-long, only Skip, the final check never runs; exactly 5000 is still fine', async () => {
  const { item, r } = await one(draft('B1', { text: 'x'.repeat(5001) }));
  assert.equal(item.reason, 'text-too-long'); assert.equal(item.state, 'refused: text-too-long'); assert.deepEqual(item.actions, ['skip']); assert.equal(r.calls.check, 0);
  const ok = await one(draft('B1', { text: 'x'.repeat(5000) })); assert.equal(ok.item.reason, null); assert.deepEqual(ok.item.actions, ['approve', 'skip', 'edit']);
  const emoji = await one(draft('B1', { text: '😀'.repeat(5000) })); assert.equal(emoji.item.reason, null, 'counted by character, not by UTF-16 unit');
});

test('R6 a draft with an unreadable creation time shows the expired reason and no actions (as for any expired draft)', async () => {
  for (const createdAt of ['not a time', undefined]) { const { item, r } = await one(draft('B1', { createdAt })); assert.equal(item.reason, 'expired'); assert.deepEqual(item.actions, []); assert.equal(r.calls.check, 0); }
});
