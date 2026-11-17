import './test-env.js';
// C2: pairing inside prepareAutoPost (a fact only over footage that fits it, tested before the text checks), the clip-based alt text, and hand-written approved hooks in the lane.
// Everything injected: no network, no model, no real queue or library; the hooks file is a temporary one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareAutoPost, describeRefusal, MAX_IDEAS_PER_RUN } from './auto-lane.js';
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
test('hooks: an entry matched on sourceId works; an unapproved entry and a STALE entry (claims changed) are ignored, the title hook is used', async () => {
  const i = idea(1, 'Lion');
  const bySource = kit({ hooks: [approved(i, 'By source', { ideaId: 'other' })], input: { pool: [i] } }); assert.equal((await prepareAutoPost(bySource.input, bySource.deps)).draft.hook, 'By source');
  const un = kit({ hooks: [approved(i, 'Not yet', { approvedBy: null, approvedAt: null })], input: { pool: [i] } }); assert.equal((await prepareAutoPost(un.input, un.deps)).draft.hook, 'Lion rule number 1');
  const stale = kit({ hooks: [approved(i, 'Old claims', { claimsSha256: claimsSha256({ claims: [claim('Another sentence about 3 US dollars.')] }) })], input: { pool: [i] } }); assert.equal((await prepareAutoPost(stale.input, stale.deps)).draft.hook, 'Lion rule number 1');
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
  for (const v of [undefined, false, 'true', 1, 'yes', null, {}]) { const off = kit({ input: { pool: [a], config: { autoRequireApprovedHook: v } } }); assert.equal((await prepareAutoPost(off.input, off.deps)).draft.hook, 'Lion rule number 1', String(v)); }
});
test('hooks: an approved hook is checked like any hook: a figure absent from the claims, a hook over HOOK_MAX, a rules or voice violation typed straight into the file are refused at lane time', async () => {
  const i = idea(1, 'Lion'); const next = idea(2, 'Lion');
  for (const [hook, why] of [['Lions pay 99 dollars', 'hook-number-not-in-claims'], ['L'.repeat(61), 'hook-too-long'], ['Book now to see lions', /^final-check:.*paid-link-wording/], ['Lions at examplehotel', /^final-check:/], ['Two\nlines', 'hook-invalid']]) {
    const k = kit({ hooks: [approved(i, hook)], input: { pool: [i, next] } }); const r = await prepareAutoPost(k.input, k.deps);
    assert.equal(r.ok, true); assert.equal(r.draft.ideaId, 'idea_2', hook); typeof why === 'string' ? assert.equal(r.refused[0].reason, why, hook) : assert.match(r.refused[0].reason, why, hook);
    assert.deepEqual(k.overlayLog, ['Lion rule number 2'], 'the refused hook was never drawn');
  }
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
