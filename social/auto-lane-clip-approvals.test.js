import './test-env.js';
// Task 4: the automatic lane obeys the clip decisions (skipped never, approved only once enforced). Everything injected: no network, no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { prepareAutoPost, rehearse, supplyReport } from './auto-lane.js';
import { clipVersion } from './clip-approvals.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-clipap-'));
const NP = ['examplehotel']; const NOW = new Date('2026-11-17T09:00:00Z');
const claim = (text, n = 1) => ({ text, ruleId: `r${n}`, sourceDate: '2026-10-01' });
const idea = (n, animal, over = {}) => ({ id: `idea_${n}`, sourceId: `rule:r${n}`, kind: 'rule', topic: 'wildlife-ethics', title: `${animal} rule number ${n}`, claims: [claim(`The listed fee for item ${n} is ${n + 10} US dollars for most visitors.`, n)], link: '/destinations/tanzania/', score: 100 - n, ...over });
const clipEntry = (id, tags, over = {}) => ({ id, file: `${id}.mp4`, durationSec: 7, source: [{ videoId: `v-${id}`, startSec: 10, endSec: 17 }], subject: 'x', checks: { rendered: 'ok' }, flash: { flash: false, atSec: [] }, verified: { verdict: 'pass', by: 't', at: '2026-11-16T00:00:00Z', notes: '', singleSubject: 'yes' }, shows: tags ? { tags, by: 't', at: '2026-11-17T00:00:00Z', notes: '' } : undefined, ...over });
const okCompose = (log) => async ({ clipFile, overlayPng, out }) => { log.push({ clipFile, out }); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, 'composed-bytes'); return { ok: true, problems: [], out, rendered: { ok: true, problems: [], durationSec: 7 }, qa: { ok: true, problems: [] } }; };
// the hash depends on the file name only here; a test that changes "bytes" changes the name it hashes
const hashClip = async (f) => crypto.createHash('sha256').update(path.basename(f)).digest('hex');
const sha = (id) => crypto.createHash('sha256').update(`${id}.mp4`).digest('hex');
function kit(over = {}) {
  const dir = tmp(); const hooksFile = path.join(dir, 'auto-hooks.json'); fs.writeFileSync(hooksFile, '{"hooks":[]}');
  const approvalsFile = path.join(dir, 'clip-approvals.json');
  if (over.approvalsRaw !== undefined) fs.writeFileSync(approvalsFile, over.approvalsRaw, { mode: 0o600 });
  else if (over.approvals) fs.writeFileSync(approvalsFile, JSON.stringify({ version: 1, enforcedAt: null, clips: {}, ...over.approvals }), { mode: 0o600 });
  const composeLog = [];
  const input = { pool: [idea(1, 'Lion')], manifest: { version: 1, clips: [clipEntry('clip-a', ['lion'])] }, usage: [], history: [], config: {}, now: NOW, ...over.input };
  const deps = { outDir: path.join(dir, 'out'), libraryDir: path.join(dir, 'library'), exists: () => true, neverPromotePatterns: NP, say: () => {}, hooksFile, approvalsFile, hashClip,
    overlay: async ({ out }) => { fs.writeFileSync(out, 'png'); return { ok: true }; }, compose: okCompose(composeLog), ...over.deps };
  return { input, deps, composeLog, dir, hooksFile, approvalsFile };
}
const dec = (id, state, tags, at = '2026-11-17T08:00:00Z') => ({ state, version: clipVersion(sha(id), tags), at, by: 'review page' });

test('no approvals file: behaviour as before (an undecided clip is used)', async () => {
  const k = kit(); const r = await prepareAutoPost(k.input, { ...k.deps, approvalsFile: path.join(tmp(), 'none.json') });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.clip.id, 'clip-a');
});
test('a skipped clip is never used, before or after enforcement', async () => {
  const k = kit({ approvals: { clips: { 'clip-a': dec('clip-a', 'skipped', ['lion']) } } });
  const r = await prepareAutoPost(k.input, k.deps); assert.deepEqual([r.ok, r.reasons], [false, ['no-eligible-clip']]); assert.equal(k.composeLog.length, 0);
  const k2 = kit({ approvals: { clips: { 'clip-a': dec('clip-a', 'skipped', ['lion']) } }, input: { manifest: { version: 1, clips: [clipEntry('clip-a', ['lion']), clipEntry('clip-b', ['lion'])] } } });
  const r2 = await prepareAutoPost(k2.input, k2.deps); assert.equal(r2.ok, true, JSON.stringify(r2)); assert.equal(r2.clip.id, 'clip-b');
  const k3 = kit({ approvals: { enforcedAt: '2026-11-17T08:30:00Z', clips: { 'clip-a': dec('clip-a', 'skipped', ['lion']) } } });
  const r3 = await prepareAutoPost(k3.input, k3.deps); assert.deepEqual(r3.reasons, ['no-eligible-clip']);
});
test('after enforcement only approved clips for the current file are used', async () => {
  const two = { manifest: { version: 1, clips: [clipEntry('clip-b', ['lion']), clipEntry('clip-a', ['lion'])] } };
  const k = kit({ approvals: { enforcedAt: '2026-11-17T08:30:00Z', clips: { 'clip-a': dec('clip-a', 'approved', ['lion']) } }, input: two });
  const r = await prepareAutoPost(k.input, k.deps); assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.clip.id, 'clip-a', 'undecided clip-b is never chosen even though it is listed first');
  // the file is replaced: the hash it gives is different, so the approval no longer matches
  const k2 = kit({ approvals: { enforcedAt: '2026-11-17T08:30:00Z', clips: { 'clip-a': dec('clip-a', 'approved', ['lion']) } } });
  const r2 = await prepareAutoPost(k2.input, { ...k2.deps, hashClip: async () => 'f'.repeat(64) }); assert.deepEqual([r2.ok, r2.reasons], [false, ['no-eligible-clip']]); assert.equal(k2.composeLog.length, 0);
});
test('a clip entry without shows does not throw in the lane and gets the same version the page computes', async () => {
  const k = kit({ approvals: { enforcedAt: '2026-11-17T08:30:00Z', clips: { 'clip-a': dec('clip-a', 'approved', []) } }, input: { manifest: { version: 1, clips: [clipEntry('clip-a', null)] }, pool: [idea(1, 'Lion', { title: 'Fee rule number 1' })] } });
  const r = await prepareAutoPost(k.input, k.deps);
  // a clip without tags fits no animal idea; the point is that nothing throws and the version path ran: the refusal is about the idea, not about the clip list
  assert.ok(!(r.reasons || []).includes('no-eligible-clip'), JSON.stringify(r)); assert.ok(!(r.reasons || []).includes('bad-approvals-file'));
});
test('a malformed approvals file refuses the lane and composes nothing', async () => {
  const k = kit({ approvalsRaw: '{nope' }); const r = await prepareAutoPost(k.input, k.deps);
  assert.equal(r.ok, false); assert.deepEqual(r.reasons, ['bad-approvals-file']); assert.equal(k.composeLog.length, 0);
});
test('supplyReport uses the same filter (a skipped clip is not counted as fitting)', async () => {
  const k = kit({ approvals: { clips: { 'clip-a': dec('clip-a', 'skipped', ['lion']) } } }); const lines = [];
  const r = await supplyReport({ ranked: [idea(1, 'Lion')], top: 5, manifest: k.input.manifest, usage: [], config: {}, now: NOW, libraryDir: k.deps.libraryDir, log: (l) => lines.push(l) }, { exists: () => true, hooksFile: k.hooksFile, approvalsFile: k.approvalsFile, hashClip, neverPromotePatterns: NP });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.fitting, 0); assert.deepEqual(r.perClip, []);
  const k2 = kit({ approvalsRaw: '{nope' });
  const r2 = await supplyReport({ ranked: [idea(1, 'Lion')], top: 5, manifest: k2.input.manifest, usage: [], config: {}, now: NOW, libraryDir: k2.deps.libraryDir, log: () => {} }, { exists: () => true, hooksFile: k2.hooksFile, approvalsFile: k2.approvalsFile, hashClip, neverPromotePatterns: NP });
  assert.equal(r2.ok, false); assert.match(r2.reason, /^bad-approvals-file/);
});
test('auto-lane.js reads the approvals at exactly two call sites, each checked for ok; readHooks( stays at exactly three', () => {
  const src = fs.readFileSync(path.join(HERE, 'auto-lane.js'), 'utf8').split('\n');
  const s = src.filter((l) => /readClipApprovals\(/.test(l) && !/^import/.test(l)); assert.equal(s.length, 2); for (const l of s) assert.match(l, /!ap\.ok/);
  assert.equal(src.filter((l) => /readHooks\(/.test(l) && !/^import/.test(l)).length, 3);
});
test('the rehearsal goes through prepareAutoPost, so it obeys the same filter', async () => {
  const k = kit({ approvals: { clips: { 'clip-a': dec('clip-a', 'skipped', ['lion']) } } }); const lines = [];
  const res = await rehearse({ pool: k.input.pool, manifest: k.input.manifest, usage: [], history: [], config: {}, now: NOW, count: 1, out: path.join(k.dir, 'rehearsal'), libraryDir: k.deps.libraryDir, log: (l) => lines.push(l) }, k.deps);
  assert.equal(res.made, 0); assert.ok(lines.some((l) => /NOT PREPARED/.test(l)));
});
