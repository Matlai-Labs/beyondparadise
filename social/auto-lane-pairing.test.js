import './test-env.js';
// C2: pairing inside prepareAutoPost (a fact only over footage that fits it, tested before the text checks), the clip-based alt text, and hand-written approved hooks in the lane.
// Everything injected: no network, no model, no real queue or library; the hooks file is a temporary one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareAutoPost, describeRefusal, MAX_IDEAS_PER_RUN, rehearse, supplyReport } from './auto-lane.js';
import { LIBRARY_FOOTAGE_LINE } from './fact-post.js';
import { TEST_ENV_DIR } from './test-env.js';
import { finalCheck, autoTextIntact, autoTextHash } from './lib.js';
import { claimsSha256 } from './auto-hooks.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-pair-'));
const NP = ['examplehotel']; const NOW = new Date('2026-11-17T09:00:00Z');
const claim = (text, n = 1) => ({ text, ruleId: `r${n}`, sourceDate: '2026-10-01' });
const idea = (n, animal, over = {}) => ({ id: `idea_${n}`, sourceId: `rule:r${n}`, kind: 'rule', topic: 'wildlife-ethics', title: `${animal} rule number ${n}`, claims: [claim(`The listed fee for item ${n} is ${n + 10} US dollars for most visitors.`, n)], link: '/destinations/tanzania/', score: 100 - n, ...over });
const clipEntry = (id, tags, over = {}) => ({ id, file: `${id}.mp4`, durationSec: 7, source: [{ videoId: `v-${id}`, startSec: 10, endSec: 17 }], subject: 'x', checks: { rendered: 'ok' }, flash: { flash: false, atSec: [] }, verified: { verdict: 'pass', by: 't', at: '2026-11-16T00:00:00Z', notes: '' }, shows: tags ? { tags, by: 't', at: '2026-11-17T00:00:00Z', notes: '' } : undefined, ...over });
const okCompose = (log) => async ({ clipFile, overlayPng, out }) => { log.push({ clipFile, out }); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, 'composed-bytes'); return { ok: true, problems: [], out, rendered: { ok: true, problems: [], durationSec: 7 }, qa: { ok: true, problems: [] } }; };
function kit(over = {}) {
  const dir = tmp(); const hooksFile = path.join(dir, 'auto-hooks.json'); fs.writeFileSync(hooksFile, over.hooksRaw ?? JSON.stringify({ hooks: over.hooks || [] }));
  const composeLog = []; const overlayLog = []; const lines = [];
  const input = { pool: [idea(1, 'Lion')], manifest: { version: 1, clips: [clipEntry('clip-a', ['lion'])] }, usage: [], history: [], config: {}, now: NOW, ...over.input };
  const deps = { outDir: path.join(dir, 'out'), libraryDir: path.join(dir, 'library'), exists: () => true, neverPromotePatterns: NP, say: (m) => lines.push(m), hooksFile,
    overlay: async ({ hook, out }) => { overlayLog.push(hook); fs.writeFileSync(out, 'png'); return { ok: true }; }, compose: okCompose(composeLog), ...over.deps };
  return { input, deps, composeLog, overlayLog, lines, hooksFile };
}
const approved = (i, hook, over = {}) => ({ ideaId: i.id, sourceId: i.sourceId, hook, claimsSha256: claimsSha256(i), approvedBy: 'owner', approvedAt: '2026-11-17T08:00:00Z', ...over });

// ── pairing ──────────────────────────────────────────────────────────────────────
test('pairing: an idea without a fitting clip is refused no-matching-clip, the next idea is tried; the clip chosen is the FIRST ELIGIBLE clip THAT FITS, not the first clip', async () => {
  const k = kit({ input: { pool: [idea(1, 'Zebra'), idea(2, 'Elephant'), idea(3, 'Lion')], manifest: { version: 1, clips: [clipEntry('clip-a', ['lion']), clipEntry('clip-b', ['zebra', 'bird']), clipEntry('clip-c', ['elephant']), clipEntry('clip-d', ['elephant'])] } } });
  const r = await prepareAutoPost(k.input, k.deps);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.draft.ideaId, 'idea_1'); assert.equal(r.clip.id, 'clip-b');
  const k2 = kit({ input: { pool: [idea(1, 'Giraffe'), idea(2, 'Elephant'), idea(3, 'Lion')], manifest: { version: 1, clips: [clipEntry('clip-a', ['lion']), clipEntry('clip-c', ['elephant']), clipEntry('clip-d', ['elephant'])] } } });
  const r2 = await prepareAutoPost(k2.input, k2.deps);
  assert.deepEqual([r2.draft.ideaId, r2.clip.id], ['idea_2', 'clip-c']); assert.deepEqual(r2.refused, [{ ideaId: 'idea_1', reason: 'no-matching-clip' }]); assert.equal(k2.composeLog.length, 1); assert.equal(path.basename(k2.composeLog[0].clipFile), 'clip-c.mp4');
});
test('pairing: an idea that names no animal is refused no-subject; the Tanzania visa fee never goes over zebras', async () => {
  const k = kit({ input: { pool: [idea(1, 'Tanzania tourist visa fee'), idea(2, 'Lion')], manifest: { version: 1, clips: [clipEntry('clip-z', ['zebra', 'hippo']), clipEntry('clip-l', ['lion'])] } } });
  const r = await prepareAutoPost(k.input, k.deps); assert.deepEqual([r.draft.ideaId, r.clip.id], ['idea_2', 'clip-l']); assert.deepEqual(r.refused, [{ ideaId: 'idea_1', reason: 'no-subject' }]);
  const only = kit({ input: { pool: [idea(1, 'Tanzania tourist visa fee')], manifest: { version: 1, clips: [clipEntry('clip-z', ['zebra', 'hippo'])] } } });
  const o = await prepareAutoPost(only.input, only.deps); assert.deepEqual([o.ok, o.reasons], [false, ['no-eligible-idea']]); assert.equal(describeRefusal(o), 'no-eligible-idea (no-subject x1)'); assert.equal(only.composeLog.length, 0);
});
test('pairing: a clip without reviewer tags fits nothing; the unreliable subject field and scene tags never make a match; no post is made', async () => {
  const k = kit({ input: { pool: [idea(1, 'Lion'), idea(2, 'Lion')], manifest: { version: 1, clips: [clipEntry('clip-a', null, { subject: 'lion' }), clipEntry('clip-b', ['savanna', 'landscape']), clipEntry('clip-c', ['lion'], { shows: { tags: ['lion'] } })] } } });
  const r = await prepareAutoPost(k.input, k.deps); assert.deepEqual([r.ok, r.reasons], [false, ['no-eligible-idea']]); assert.equal(describeRefusal(r), 'no-eligible-idea (no-matching-clip x2)'); assert.equal(k.composeLog.length, 0);
});
test('pairing: no eligible clip at all keeps today\'s no-eligible-clip', async () => {
  const k = kit({ input: { manifest: { version: 1, clips: [clipEntry('clip-a', ['lion'], { verified: null })] } } }); assert.deepEqual((await prepareAutoPost(k.input, k.deps)).reasons, ['no-eligible-clip']);
  const used = kit({ input: { usage: [{ clipId: 'clip-a' }] } }); assert.deepEqual((await prepareAutoPost(used.input, used.deps)).reasons, ['no-eligible-clip']);
});
test('pairing: MAX_IDEAS_PER_RUN counts only ideas that HAVE a fitting clip: 40 ideas without one do not use the cap up', async () => {
  const pool = [...Array.from({ length: 40 }, (_, i) => idea(i + 1, i % 2 ? 'Tanzania fee' : 'Giraffe', { score: 500 - i })), idea(99, 'Lion', { score: 1 })];
  const k = kit({ input: { pool } }); const r = await prepareAutoPost(k.input, k.deps); assert.equal(r.ok, true, JSON.stringify(r.refused.slice(-3))); assert.equal(r.draft.ideaId, 'idea_99'); assert.equal(r.refused.length, 40);
  const mixed = [...Array.from({ length: 10 }, (_, i) => idea(i + 1, 'Giraffe', { score: 500 - i })), ...Array.from({ length: 20 }, (_, i) => idea(i + 20, 'Lion', { title: `Lion ${'Q'.repeat(90)}`, score: 400 - i })), idea(99, 'Lion', { score: 1 })];
  const m = kit({ input: { pool: mixed } }); const rm = await prepareAutoPost(m.input, m.deps);
  assert.deepEqual([rm.ok, rm.reasons], [false, ['no-eligible-idea']]); assert.equal(rm.refused.filter((x) => x.reason === 'title-too-long').length, MAX_IDEAS_PER_RUN); assert.equal(rm.refused.filter((x) => x.reason === 'no-matching-clip').length, 10);
});
test('alt text: built from what the clip shows (a lion and elephants), carries the hook, goes through the same final check; the draft is intact for the final check right before publish', async () => {
  const k = kit({ input: { pool: [idea(1, 'Lions')], manifest: { version: 1, clips: [clipEntry('clip-a', ['lion', 'elephant', 'savanna'])] } } }); const r = await prepareAutoPost(k.input, k.deps); const d = r.draft;
  assert.equal(d.altText, `Short silent video of a lion, elephants and the savanna with the text: ${d.hook}`); assert.ok(!d.altText.includes('East African landscape or wildlife'));
  assert.equal(d.autoTextSha256, autoTextHash(d)); assert.equal(autoTextIntact(d), true);
  const fc = await finalCheck({ ...d, id: 'x' }, { neverPromotePatterns: NP }); assert.deepEqual([fc.ok, fc.ruleIds], [true, []]);
  const bad = kit({ input: { pool: [idea(1, 'Lions')], manifest: { version: 1, clips: [clipEntry('clip-a', ['lion'])] } }, deps: { check: async (x) => (x.id === 'alt' ? { ok: false, ruleIds: ['voice-lint'] } : finalCheck(x, { neverPromotePatterns: NP })) } });
  assert.equal((await prepareAutoPost(bad.input, bad.deps)).refused[0].reason, 'alt-text:voice-lint');
});
test('prepareAutoPost without hooks or pairing changes in the pool or manifest: the input objects are not mutated', async () => {
  const k = kit({ input: { pool: [idea(1, 'Giraffe'), idea(2, 'Lion')] } }); const before = JSON.stringify([k.input.pool, k.input.manifest, k.input.usage]); await prepareAutoPost(k.input, k.deps); assert.equal(JSON.stringify([k.input.pool, k.input.manifest, k.input.usage]), before);
});

// ── hand-written approved hooks in the lane ──────────────────────────────────────
test('hooks: an approved entry replaces the title hook in the text, hook, videoText, the overlay and the alt text; the title stays as ideaTitle', async () => {
  const i = idea(1, 'Lion'); const k = kit({ hooks: [approved(i, 'Lion fee in 11 US dollars')], input: { pool: [i] } }); const r = await prepareAutoPost(k.input, k.deps); const d = r.draft;
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(d.hook, 'Lion fee in 11 US dollars'); assert.equal(d.videoText, d.hook); assert.equal(d.text.split('\n')[0], d.hook); assert.deepEqual(k.overlayLog, [d.hook]);
  assert.ok(d.altText.endsWith(`with the text: ${d.hook}`)); assert.equal(d.ideaTitle, 'Lion rule number 1'); assert.ok(!d.text.includes('Lion rule number 1')); assert.equal(autoTextIntact(d), true);
});
test('hooks: an unapproved entry, a STALE entry (claims changed) and a STALE entry (title edited after approval) are ignored, the title hook is used; an entry with another idea\'s id but the same claims is not used', async () => {
  const i = idea(1, 'Lion');
  const un = kit({ hooks: [approved(i, 'Not yet', { approvedBy: null, approvedAt: null })], input: { pool: [i] } }); assert.equal((await prepareAutoPost(un.input, un.deps)).draft.hook, 'Lion rule number 1');
  const stale = kit({ hooks: [approved(i, 'Old claims', { claimsSha256: claimsSha256({ title: i.title, claims: [claim('Another sentence about 3 US dollars.')] }) })], input: { pool: [i] } }); assert.equal((await prepareAutoPost(stale.input, stale.deps)).draft.hook, 'Lion rule number 1');
  const renamed = kit({ hooks: [approved(i, 'Old title')], input: { pool: [{ ...i, title: 'Lion rule renamed' }] } }); assert.equal((await prepareAutoPost(renamed.input, renamed.deps)).draft.hook, 'Lion rule renamed', 'title edited after approval -> stale -> ignored');
  const other = kit({ hooks: [approved(i, 'Not for you', { ideaId: 'idea_other' })], input: { pool: [i] } }); assert.equal((await prepareAutoPost(other.input, other.deps)).draft.hook, 'Lion rule number 1', 'same claims and sourceId, another id: not used');
});
test('hooks: a malformed or missing hooks file is fail closed: named reason bad-hooks-file, nothing composed, titles are NOT silently used', async () => {
  for (const raw of ['{not json', '{"hooks":"x"}', '{"hooks":[{"ideaId":"a"}]}']) { const k = kit({ hooksRaw: raw }); const r = await prepareAutoPost(k.input, k.deps); assert.deepEqual([r.ok, r.reasons], [false, ['bad-hooks-file']], raw); assert.match(describeRefusal(r), /bad-hooks-file \(/); assert.equal(k.composeLog.length, 0); }
  const gone = kit({ deps: { hooksFile: path.join(tmp(), 'missing.json') } }); assert.deepEqual((await prepareAutoPost(gone.input, gone.deps)).reasons, ['bad-hooks-file']);
});
test('hooks: autoRequireApprovedHook true refuses an idea without a valid approved hook (no-approved-hook); absent or anything but boolean true is off', async () => {
  const a = idea(1, 'Lion'); const b = idea(2, 'Lion');
  const on = kit({ hooks: [approved(b, 'Second idea hook')], input: { pool: [a, b], config: { autoRequireApprovedHook: true } } }); const r = await prepareAutoPost(on.input, on.deps);
  assert.deepEqual([r.draft.ideaId, r.draft.hook], ['idea_2', 'Second idea hook']); assert.deepEqual(r.refused, [{ ideaId: 'idea_1', reason: 'no-approved-hook' }]);
  const none = kit({ input: { pool: [a, b], config: { autoRequireApprovedHook: true } } }); const n = await prepareAutoPost(none.input, none.deps); assert.deepEqual([n.ok, n.reasons], [false, ['no-eligible-idea']]); assert.equal(describeRefusal(n), 'no-eligible-idea (no-approved-hook x2)');
  const unapp = kit({ hooks: [approved(a, 'x', { approvedBy: null, approvedAt: null })], input: { pool: [a], config: { autoRequireApprovedHook: true } } }); assert.equal((await prepareAutoPost(unapp.input, unapp.deps)).ok, false);
  for (const v of [undefined, false]) { const off = kit({ input: { pool: [a], config: { autoRequireApprovedHook: v } } }); assert.equal((await prepareAutoPost(off.input, off.deps)).draft.hook, 'Lion rule number 1', String(v)); }
});
test('hooks: autoRequireApprovedHook is a RESTRICTION: any present value but boolean true or false (a typo) refuses the lane, bad-config:autoRequireApprovedHook, nothing composed', async () => {
  for (const v of ['true', 'false', 1, 0, null, 'yes', {}, [true]]) { const k = kit({ input: { config: { autoRequireApprovedHook: v } } }); const r = await prepareAutoPost(k.input, k.deps); assert.deepEqual({ ok: r.ok, reasons: r.reasons }, { ok: false, reasons: ['bad-config:autoRequireApprovedHook'] }, JSON.stringify(v)); assert.equal(k.composeLog.length, 0); }
  const k = kit({ input: { config: { autoRequireApprovedHook: true } } }); assert.deepEqual((await prepareAutoPost(k.input, k.deps)).reasons, ['no-eligible-idea']);
});
test('hooks: an approved hook is checked like any hook: a figure absent from the claims, a hook over HOOK_MAX, a rules or voice violation typed straight into the file are refused at lane time', async () => {
  const i = idea(1, 'Lion'); const next = idea(2, 'Lion');
  for (const [hook, why] of [['Lions pay 99 dollars', 'hook-number-not-in-claims'], ['L'.repeat(61), 'hook-too-long'], ['Book now to see lions', /^final-check:.*paid-link-wording/], ['Lions at examplehotel', /^final-check:/], ['Two\nlines', 'hook-invalid']]) {
    const k = kit({ hooks: [approved(i, hook)], input: { pool: [i, next] } }); const r = await prepareAutoPost(k.input, k.deps);
    assert.equal(r.ok, true); assert.equal(r.draft.ideaId, 'idea_2', hook); typeof why === 'string' ? assert.equal(r.refused[0].reason, why, hook) : assert.match(r.refused[0].reason, why, hook);
    assert.deepEqual(k.overlayLog, ['Lion rule number 2'], 'the refused hook was never drawn');
  }
});
test('hooks: a hook that names a different animal than the idea (Hippos on a lion idea) is refused hook-subject-mismatch; the same animal, or no animal, passes', async () => {
  const i = idea(1, 'Lion'); const next = idea(2, 'Lion');
  const bad = kit({ hooks: [approved(i, 'Hippos pay 11 US dollars')], input: { pool: [i, next] } }); const r = await prepareAutoPost(bad.input, bad.deps); assert.equal(r.refused[0].reason, 'hook-subject-mismatch'); assert.equal(r.draft.ideaId, 'idea_2');
  for (const h of ['Lions pay 11 US dollars', 'Park fee: 11 US dollars']) { const ok = kit({ hooks: [approved(i, h)], input: { pool: [i] } }); assert.equal((await prepareAutoPost(ok.input, ok.deps)).draft.hook, h, h); }
});
test('hooks + pairing: an approved hook does not widen pairing: the idea still needs a fitting clip', async () => {
  const i = idea(1, 'Zebra'); const k = kit({ hooks: [approved(i, 'Zebras')], input: { pool: [i] } }); const r = await prepareAutoPost(k.input, k.deps); assert.deepEqual([r.ok, r.reasons], [false, ['no-eligible-idea']]); assert.equal(r.refused[0].reason, 'no-matching-clip');
});

// ── switches and source-level guards ─────────────────────────────────────────────
test('config.json: autoPublish, ideaDrafts and autoRequireApprovedHook are all ABSENT (off); the README documents autoRequireApprovedHook', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')); for (const k of ['autoPublish', 'ideaDrafts', 'autoRequireApprovedHook']) assert.ok(!(k in cfg), k);
  assert.match(fs.readFileSync(path.join(HERE, 'README.md'), 'utf8'), /\| `autoRequireApprovedHook` \|/);
});
test('the new files never reach the network, a model or the worker, and carry no local absolute path', () => {
  for (const f of ['auto-pairing.js', 'auto-hooks.js', 'auto-lane.js']) { const s = fs.readFileSync(path.join(HERE, f), 'utf8').replace(/\/\/.*$/gm, ''); assert.doesNotMatch(s, /\bfetch\(|localAsk|askLocal|captionModel|judgeModel|from '\.\/worker\.js'/, f); assert.doesNotMatch(fs.readFileSync(path.join(HERE, f), 'utf8'), /\/Users\//, f); }
});

// ── the library footage line ─────────────────────────────────────────────────────
test('every automatic reel carries the exact line "Video: library footage." directly after the source line and before the hashtags; removing it breaks the text hash', async () => {
  assert.equal(LIBRARY_FOOTAGE_LINE, 'Video: library footage.');
  const k = kit(); const d = (await prepareAutoPost(k.input, k.deps)).draft; const lines = d.text.split('\n'); const at = lines.indexOf(LIBRARY_FOOTAGE_LINE);
  assert.ok(at > 0); assert.match(lines[at - 1], /^Source: /); assert.match(lines.at(-1), /^#/); assert.equal(lines.at(-2), ''); assert.equal(lines.filter((l) => l === LIBRARY_FOOTAGE_LINE).length, 1);
  assert.equal(autoTextIntact(d), true); assert.equal(autoTextIntact({ ...d, text: lines.filter((l) => l !== LIBRARY_FOOTAGE_LINE).join('\n') }), false, 'the hash covers the whole text');
  const fc = await finalCheck({ ...d, text: lines.filter((l) => l !== LIBRARY_FOOTAGE_LINE).join('\n') }, { neverPromotePatterns: NP }); assert.ok(fc.ruleIds.includes('auto-text-changed'));
});

// ── --include-unapproved (rehearsal only) ───────────────────────────────────────
test('preview: a current but unapproved entry is used ONLY when the caller passes previewUnapproved; ignored by default, by config keys of a similar name, and via ensureDailyAuto-style calls', async () => {
  const i = idea(1, 'Lion'); const un = approved(i, 'Preview hook', { approvedBy: null, approvedAt: null });
  const on = kit({ hooks: [un], input: { pool: [i] }, deps: { previewUnapproved: true } }); const r = await prepareAutoPost(on.input, on.deps); assert.equal(r.draft.hook, 'Preview hook'); assert.equal(r.previewHook, true); assert.equal('previewHook' in r.draft, false, 'never part of a queued item');
  const stale = kit({ hooks: [{ ...un, claimsSha256: 'a'.repeat(64) }], input: { pool: [i] }, deps: { previewUnapproved: true } }); assert.equal((await prepareAutoPost(stale.input, stale.deps)).draft.hook, 'Lion rule number 1');
  const config = { includeUnapproved: true, previewUnapproved: true, autoIncludeUnapproved: true, autoPreviewUnapproved: true, rehearseIncludeUnapproved: true };
  const off = kit({ hooks: [un], input: { pool: [i], config } }); const o = await prepareAutoPost(off.input, off.deps); assert.equal(o.draft.hook, 'Lion rule number 1'); assert.ok(!o.previewHook);
  const approvedOne = kit({ hooks: [approved(i, 'Real hook')], input: { pool: [i] }, deps: { previewUnapproved: true } }); assert.ok(!(await prepareAutoPost(approvedOne.input, approvedOne.deps)).previewHook, 'an approved hook is not a preview');
});

// ── rehearse --count and the supply numbers (injected pool, manifest, paths) ──────
const lsRec = (dir) => fs.readdirSync(dir, { recursive: true }).sort();
test('rehearse --count: two posts never share a clip or an idea; only the out folder is written (no queue, ledger or state file appears); the preview line leads each preview block', async () => {
  const dir = tmp(); const out = path.join(dir, 'out'); const before = lsRec(TEST_ENV_DIR); const lines = [];
  const pool = [idea(1, 'Lion'), idea(2, 'Lion'), idea(3, 'Elephant'), idea(4, 'Zebra')]; const manifest = { version: 1, clips: [clipEntry('clip-a', ['lion']), clipEntry('clip-b', ['lion', 'elephant']), clipEntry('clip-c', ['zebra'])] };
  const hooksFile = path.join(dir, 'auto-hooks.json'); fs.writeFileSync(hooksFile, JSON.stringify({ hooks: [approved(pool[0], 'Preview lion hook', { approvedBy: null, approvedAt: null })] }));
  const composeLog = []; const res = await rehearse({ pool, manifest, usage: [], history: [], config: {}, now: NOW, count: 3, out, libraryDir: path.join(dir, 'library'), includeUnapproved: true, log: (l) => lines.push(l) },
    { exists: () => true, neverPromotePatterns: NP, hooksFile, overlay: async ({ out: o }) => { fs.writeFileSync(o, 'png'); return { ok: true }; }, compose: okCompose(composeLog) });
  assert.equal(res.made, 3); const clips = res.posts.map((p) => p.clip.id); const ideas = res.posts.map((p) => p.idea.id);
  assert.equal(new Set(clips).size, 3); assert.equal(new Set(ideas).size, 3);
  assert.deepEqual(lsRec(out).filter((f) => f.endsWith('.mp4')).length, 3); assert.deepEqual(lsRec(out).filter((f) => f.endsWith('.txt')).length, 3);
  assert.deepEqual(lsRec(TEST_ENV_DIR), before, 'the test state folder (queue, ledger, state, log) gained nothing'); assert.deepEqual(lsRec(dir).filter((f) => !f.startsWith('out') && f !== 'auto-hooks.json'), [], 'nothing outside the out folder');
  const blocks = lines.join('\n').split('--- post ').slice(1); assert.equal(blocks.length, 3); assert.ok(blocks[0].split('\n')[1] === 'PREVIEW: hook not approved yet', blocks[0].slice(0, 80)); assert.ok(blocks.slice(1).every((b) => !b.includes('PREVIEW')));
  const none = await rehearse({ pool, manifest, usage: [], history: [], config: {}, now: NOW, count: 9, out: path.join(dir, 'o2'), libraryDir: path.join(dir, 'library'), includeUnapproved: false, log: () => {} },
    { exists: () => true, neverPromotePatterns: NP, hooksFile, overlay: async ({ out: o }) => { fs.writeFileSync(o, 'png'); return { ok: true }; }, compose: okCompose([]) }); assert.equal(none.made, 3, 'stops when no clip is left'); assert.ok(none.posts.every((p) => !p.previewHook));
});
test('supply numbers: surviving ideas, how many have a fitting unused clip, per clip its tags and fit count (injected pool and manifest)', async () => {
  const dir = tmp(); const lines = [];
  const pool = [idea(1, 'Lion'), idea(2, 'Elephant'), idea(3, 'Tanzania fee'), idea(4, 'Giraffe'), idea(5, 'Lion', { claims: [claim('x'.repeat(241))] })];
  const manifest = { version: 1, clips: [clipEntry('clip-a', ['lion', 'savanna']), clipEntry('clip-b', ['lion', 'elephant']), clipEntry('clip-c', null), clipEntry('clip-d', ['zebra'], { verified: null })] };
  const hooksFile = path.join(dir, 'auto-hooks.json'); fs.writeFileSync(hooksFile, '{"hooks":[]}');
  const r = await supplyReport({ ranked: pool, top: 10, manifest, usage: [], config: {}, now: NOW, libraryDir: path.join(dir, 'library'), kindsLabel: 'rule+fact', log: (l) => lines.push(l) }, { exists: () => true, hooksFile, neverPromotePatterns: NP });
  assert.equal(r.survivors, 4); assert.equal(r.fitting, 2); assert.deepEqual(r.perClip, [{ id: 'clip-a', tags: ['lion', 'savanna'], fits: 1 }, { id: 'clip-b', tags: ['lion', 'elephant'], fits: 2 }, { id: 'clip-c', tags: [], fits: 0 }]);
  assert.deepEqual(r.refusals, { 'claim-too-long': 1 }); const txt = lines.join('\n'); assert.match(txt, /4 survive/); assert.match(txt, /2 of 4 surviving ideas have a fitting unused clip \(3 eligible/); assert.match(txt, /clip-b\s+tags: lion, elephant\s+fits 2 surviving ideas/); assert.match(txt, /clip-c\s+tags: none recorded\s+fits 0/);
  assert.match(txt, /elephant x1/); assert.match(txt, /\(no animal named\) x1/);
});
test('title-claim-differ: refused before pairing, also with an approved hook; supply counts it', async () => {
  const bad = idea(1, 'Lion', { titleFromOtherField: true });
  const k = kit({ input: { pool: [bad] }, hooks: [approved(bad, 'Lion fee')] });
  const r = await prepareAutoPost(k.input, k.deps); assert.deepEqual([r.ok, r.reasons, r.refused], [false, ['no-eligible-idea'], [{ ideaId: 'idea_1', reason: 'title-claim-differ' }]]);
  const k2 = kit({ input: { pool: [bad, idea(2, 'Lion')] } }); const r2 = await prepareAutoPost(k2.input, k2.deps); assert.equal(r2.draft.ideaId, 'idea_2');
  const lines = []; await supplyReport({ ranked: [bad], top: 5, manifest: k.input.manifest, usage: [], config: {}, now: NOW, libraryDir: k.deps.libraryDir, log: (l) => lines.push(l) }, { hooksFile: k.hooksFile, exists: () => true, neverPromotePatterns: NP });
  assert.ok(lines.some((l) => /title-claim-differ/.test(l)), lines.join('\n'));
});
