import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { stopPosting, startPosting, scheduledAtMetaNote } from './bpa-actions.js';
import { handle, scheduledAtMetaNote as reExported } from './approval-server.js'; import { saveQueue } from './lib.js';
const kit = (drafts = []) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-act-')); const queuePath = path.join(d, 'q.json'); saveQueue({ seq: 1, drafts }, queuePath); return { queuePath, stopOpts: { flagPath: path.join(d, 'f', 'stop'), fleetPath: path.join(d, 'fleet.flag') }, now: new Date('2026-11-17T09:00:00Z') }; };
const mask = (t) => t.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/, 'T');
const kits = [
  [], [{ id: 'B1', status: 'scheduled', scheduledFor: '2026-11-18T09:00:00+03:00' }],
  [{ id: 'B1', status: 'scheduled', scheduledFor: '2026-11-19T09:00:00+03:00' }, { id: 'B2', status: 'scheduled', scheduledFor: '2026-11-18T09:00:00+03:00' }],
];
test('stopPosting reply equals the WhatsApp stop reply, note separate', async () => {
  for (const drafts of kits) {
    const a = kit(drafts), b = kit(drafts);
    const r = stopPosting(a);
    assert.equal(mask(r.reply), mask(await handle('bpa stop', b)));
    assert.equal(r.note, scheduledAtMetaNote(b.queuePath, b.now));
    if (r.note) assert.ok(r.reply.endsWith(' ' + r.note)); else assert.ok(!r.reply.endsWith(' '));
    assert.equal(mask(stopPosting(a).reply), mask(await handle('bpa stop', b)));
  } });
test('startPosting reply equals the WhatsApp start reply (also with the fleet flag)', async () => {
  const a = kit(), b = kit();
  assert.equal(mask(startPosting(a).reply), mask(await handle('bpa start', b)));
  stopPosting(a); await handle('bpa stop', b);
  assert.equal(mask(startPosting(a).reply), mask(await handle('bpa start', b)));
  const c = kit(), d = kit(); for (const k of [c, d]) fs.writeFileSync(k.stopOpts.fleetPath, 'x');
  stopPosting(c); await handle('bpa stop', d);
  assert.equal(mask(startPosting(c).reply), mask(await handle('bpa start', d))); });
test('scheduledAtMetaNote is the same function approval-server re-exports', () => { assert.equal(scheduledAtMetaNote, reExported); });

// ── step 2, task 6: the shared decision functions ─────────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createActions, publicCode, ACTION_CODES, EVAL_REASONS } from './bpa-actions.js';
import { appendDecision, readDecisions } from './review-decisions.js';
import { readHooks, writeHooksAtomic, claimsSha256, hookState } from './auto-hooks.js';
import { hookVersion, fileInfoOf, clipVersion } from './review-items.js';
import { readClipApprovals } from './clip-approvals.js';
import { withDecisionLock } from './decision-lock.js';
import { LOG_PATH } from './lib.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = new Date('2026-11-17T09:00:00Z');
const LOGIN = 'owner@example.com';
const ideaOf = (n) => ({ id: `idea_${n}`, sourceId: `s${n}`, kind: 'fact', title: `Title ${n}`, claims: [{ text: `Claim ${n} says 20 hours.` }] });
const entryOf = (idea, over = {}) => ({ ideaId: idea.id, sourceId: idea.sourceId, hook: `Hook for ${idea.id}`, claimsSha256: claimsSha256(idea), approvedBy: null, approvedAt: null, ...over });
const clipOf = (id, over = {}) => ({ id, file: `${id}.mp4`, durationSec: 7, source: [{ videoId: `v_${id}`, startSec: 1, endSec: 8 }], checks: { rendered: 'ok' }, flash: { flash: false }, verified: { verdict: 'pass', singleSubject: 'yes', notes: 'a lion' }, shows: { tags: ['lion'], by: 't' }, ...over });
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const bumpT = (f) => { const t = new Date(Date.now() + 5000 + Math.floor(Math.random() * 1000)); fs.utimesSync(f, t, t); };
const BIG = (c) => Buffer.alloc(1000, c);

function akit(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-act6-'));
  const hooksDir = path.join(dir, 'h'); const apprDir = path.join(dir, 'a'); fs.mkdirSync(hooksDir); fs.mkdirSync(apprDir); const lib = path.join(dir, 'lib'); fs.mkdirSync(lib);
  const hooksFile = path.join(hooksDir, 'hooks.json'); const approvalsFile = path.join(apprDir, 'approvals.json'); const recordFile = o.recordFile || path.join(dir, 'rec.jsonl');
  const ideas = [ideaOf(1), ideaOf(2), ideaOf(3)];
  const hooks = o.hooks || [entryOf(ideas[0]), entryOf(ideas[1]), entryOf(ideas[2], { claimsSha256: 'f'.repeat(64) })];
  writeHooksAtomic(hooksFile, { hooks });
  const clips = o.clips || [clipOf('c1'), clipOf('c2')];
  clips.forEach((c, i) => { if (!o.noFiles && typeof c.file === 'string') fs.writeFileSync(path.join(lib, c.file), BIG(65 + i)); });
  const state = { usage: o.usage === undefined ? [] : o.usage, history: o.history || [], manifest: { clips }, calls: [], gate: null };
  const info = o.info || fileInfoOf();
  const records = []; let last = null;
  const ctx = {
    record: (rec) => { const r = appendDecision(recordFile, { ...rec, claimedLogin: LOGIN, at: NOW.toISOString() }); if (r.ok) { records.push(rec); last = rec; } return r; },
    voidRecord: o.voidFails ? () => ({ ok: false }) : (n) => appendDecision(recordFile, { kind: last.kind, id: last.id, version: null, decision: 'void', claimedLogin: LOGIN, at: NOW.toISOString(), ref: n }),
  };
  const evaluate = o.evaluate || (async (idea, opts) => { state.calls.push(opts.hook); if (state.gate && opts.hook === state.gate.hook) await state.gate.wait; return { ok: true, draft: { hook: opts.hook } }; });
  const actions = createActions({ now: () => NOW, hooksFile, approvalsFile, lockTimeoutMs: o.lockTimeoutMs ?? 2000, loadPool: () => ({ ok: true, ideas, sourceNames: {} }), evaluate,
    readManifest: () => state.manifest, libraryDir: lib, info, readUsage: () => state.usage, readHistory: () => state.history });
  const hv = (n, hook) => hookVersion(hook ?? `Hook for idea_${n}`, ideas[n - 1]);
  const cv = (id, tags = ['lion']) => clipVersion(sha256(fs.readFileSync(path.join(lib, `${id}.mp4`))), tags);
  return { dir, lib, hooksFile, approvalsFile, recordFile, ideas, state, actions, ctx, records, hv, cv, info, evaluate,
    hooksBytes: () => fs.readFileSync(hooksFile, 'utf8'), apprBytes: () => (fs.existsSync(approvalsFile) ? fs.readFileSync(approvalsFile, 'utf8') : null) };
}
const V64 = 'a'.repeat(64);

test('approveHook: writes approvedBy review page and a record line; second call is already-approved with no second record', async () => {
  const k = akit(); const res = await k.actions.approveHook({ id: 'idea_1', version: k.hv(1) }, k.ctx);
  assert.deepEqual(res, { ok: true, change: { kind: 'hook', id: 'idea_1', decision: 'approved' } });
  const e = readHooks(k.hooksFile).hooks[0]; assert.equal(e.approvedBy, 'review page'); assert.equal(e.approvedAt, NOW.toISOString());
  assert.equal(k.records.length, 1); assert.deepEqual(k.records[0], { kind: 'hook', id: 'idea_1', version: k.hv(1), decision: 'approve' });
  assert.deepEqual(await k.actions.approveHook({ id: 'idea_1', version: k.hv(1) }, k.ctx), { ok: false, code: 'already-approved' }); assert.equal(k.records.length, 1);
});
test('approveHook refuses a changed version, a stale entry, a skipped entry, and an idea that now fails its checks (D7); each leaves the hooks file byte for byte', async () => {
  const k = akit(); const before = k.hooksBytes();
  assert.deepEqual(await k.actions.approveHook({ id: 'idea_1', version: hookVersion('Hook for idea_1', ideaOf(9)) }, k.ctx), { ok: false, code: 'version-changed' });
  assert.deepEqual(await k.actions.approveHook({ id: 'idea_3', version: k.hv(3) }, k.ctx), { ok: false, code: 'stale' });
  const bad = akit({ evaluate: async () => ({ ok: false, reason: 'hook-number-not-in-claims' }) }); const b2 = bad.hooksBytes();
  assert.deepEqual(await bad.actions.approveHook({ id: 'idea_1', version: bad.hv(1) }, bad.ctx), { ok: false, code: 'hook-number-not-in-claims' });
  assert.equal(k.hooksBytes(), before); assert.equal(bad.hooksBytes(), b2); assert.equal(k.records.length + bad.records.length, 0);
  assert.equal((await k.actions.skipHook({ id: 'idea_1', version: k.hv(1) }, k.ctx)).ok, true);
  const b3 = k.hooksBytes(); assert.deepEqual(await k.actions.approveHook({ id: 'idea_1', version: k.hv(1) }, k.ctx), { ok: false, code: 'already-skipped' }); assert.equal(k.hooksBytes(), b3);
});
test('skipHook clears an approval and sets skipped; unapproveHook undoes both; used idea is already-used', async () => {
  const k = akit(); const v = k.hv(1);
  assert.equal((await k.actions.approveHook({ id: 'idea_1', version: v }, k.ctx)).ok, true);
  assert.equal((await k.actions.skipHook({ id: 'idea_1', version: v }, k.ctx)).change.decision, 'skipped');
  let e = readHooks(k.hooksFile).hooks[0]; assert.equal(e.approvedBy, null); assert.equal(e.skipped.by, 'review page'); assert.equal(hookState(e, k.ideas[0]), 'skipped');
  assert.deepEqual(await k.actions.skipHook({ id: 'idea_1', version: v }, k.ctx), { ok: false, code: 'already-skipped' });
  assert.deepEqual(await k.actions.unapproveHook({ id: 'idea_1', version: v }, k.ctx), { ok: true, change: { kind: 'hook', id: 'idea_1', decision: 'undone' } });
  e = readHooks(k.hooksFile).hooks[0]; assert.equal(hookState(e, k.ideas[0]), 'unapproved');
  assert.deepEqual(await k.actions.unapproveHook({ id: 'idea_1', version: v }, k.ctx), { ok: false, code: 'not-decided' });
  await k.actions.approveHook({ id: 'idea_1', version: v }, k.ctx); assert.equal((await k.actions.unapproveHook({ id: 'idea_1', version: v }, k.ctx)).ok, true);
  await k.actions.approveHook({ id: 'idea_1', version: v }, k.ctx); k.state.history = [{ ideaId: 'idea_1' }];
  const b = k.hooksBytes(); assert.deepEqual(await k.actions.unapproveHook({ id: 'idea_1', version: v }, k.ctx), { ok: false, code: 'already-used' }); assert.equal(k.hooksBytes(), b);
});
test('editHook: a passing text replaces the entry and is approved in the same call; the record holds the new version hash and no text', async () => {
  const k = akit(); const text = 'Lions sleep long hours';
  const res = await k.actions.editHook({ id: 'idea_1', version: k.hv(1), text }, k.ctx);
  assert.deepEqual(res, { ok: true, change: { kind: 'hook', id: 'idea_1', decision: 'edited' } });
  const hs = readHooks(k.hooksFile).hooks; const e = hs.find((x) => x.ideaId === 'idea_1'); assert.equal(hs.filter((x) => x.ideaId === 'idea_1').length, 1);
  assert.equal(e.hook, text); assert.equal(e.approvedBy, 'review page'); assert.equal(e.claimsSha256, claimsSha256(k.ideas[0])); assert.equal(hookState(e, k.ideas[0]), 'approved');
  assert.equal(k.records[0].version, hookVersion(text, k.ideas[0])); assert.equal(k.records[0].decision, 'edit'); assert.ok(!JSON.stringify(k.records).includes(text));
  assert.ok(!fs.readFileSync(k.recordFile, 'utf8').includes(text));
});
test('editHook refuses (hooks file unchanged): empty, spaces only, line break, same text, over 60 characters, number not in the facts', async () => {
  const ev = async (idea, o) => (o.hook.length > 60 ? { ok: false, reason: 'hook-too-long' } : /\b99\b/.test(o.hook) ? { ok: false, reason: 'hook-number-not-in-claims' } : { ok: true, draft: { hook: o.hook } });
  const k = akit({ evaluate: ev }); const before = k.hooksBytes();
  const table = [['', 'bad-request'], ['   ', 'bad-request'], ['two\nlines', 'bad-request'], ['a\u2028b', 'bad-request'], ['Hook for idea_1', 'no-change'], ['x'.repeat(61), 'hook-too-long'], ['Lions 99 hours', 'hook-number-not-in-claims']];
  for (const [text, code] of table) assert.deepEqual(await k.actions.editHook({ id: 'idea_1', version: k.hv(1), text }, k.ctx), { ok: false, code }, JSON.stringify(text));
  assert.equal(k.hooksBytes(), before); assert.equal(k.records.length, 0);
});
test('editHook refuses zero-width and direction-control characters with bad-characters, hooks file byte for byte unchanged', async () => {
  const k = akit(); const before = k.hooksBytes();
  for (const ch of ['\u200B', '\u200D', '\u2060', '\uFEFF', '\u202E', '\u2066', '\u2069', '\u200F', '\u061C', '\u0007']) {
    assert.deepEqual(await k.actions.editHook({ id: 'idea_1', version: k.hv(1), text: `Lions at${ch} dawn` }, k.ctx), { ok: false, code: 'bad-characters' }, JSON.stringify(ch));
  }
  assert.equal(k.state.calls.length, 0, 'evaluate never called'); assert.equal(k.hooksBytes(), before);
});
test('editHook stores the text byte for byte as the checks saw it: the stub records its input, the stored hook equals it; a stub that returns a different draft.hook is refused check-failed and nothing is written', async () => {
  const k = akit(); assert.equal((await k.actions.editHook({ id: 'idea_1', version: k.hv(1), text: '  Lions at dawn!  ' }, k.ctx)).ok, true);
  assert.deepEqual(k.state.calls, ['Lions at dawn!']); assert.equal(readHooks(k.hooksFile).hooks.find((x) => x.ideaId === 'idea_1').hook, k.state.calls[0]);
  const d = akit({ evaluate: async (i, o) => ({ ok: true, draft: { hook: `${o.hook}.` } }) }); const before = d.hooksBytes();
  assert.deepEqual(await d.actions.editHook({ id: 'idea_1', version: d.hv(1), text: 'Lions at dawn' }, d.ctx), { ok: false, code: 'check-failed' }); assert.equal(d.hooksBytes(), before); assert.equal(d.records.length, 0);
});
test('editHook: the slow check does not hold the lock; another decision finishes meanwhile, and a decision that changed the entry during the check makes the edit version-changed with nothing written', async () => {
  const k = akit(); let release; k.state.gate = { hook: 'Slow text', wait: new Promise((r) => { release = r; }) };
  const slow = k.actions.editHook({ id: 'idea_1', version: k.hv(1), text: 'Slow text' }, k.ctx);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await k.actions.skipHook({ id: 'idea_2', version: k.hv(2) }, k.ctx)).ok, true, 'no lock-busy while the check runs');
  release(); assert.equal((await slow).ok, true);
  const j = akit(); let rel2; j.state.gate = { hook: 'Slow text', wait: new Promise((r) => { rel2 = r; }) };
  const slow2 = j.actions.editHook({ id: 'idea_1', version: j.hv(1), text: 'Slow text' }, j.ctx);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await j.actions.approveHook({ id: 'idea_1', version: j.hv(1) }, j.ctx)).ok, true);
  const afterApprove = j.hooksBytes(); rel2();
  assert.deepEqual(await slow2, { ok: false, code: 'version-changed' }); assert.equal(j.hooksBytes(), afterApprove); assert.equal(j.records.length, 1);
  assert.equal(readHooks(j.hooksFile).hooks.find((x) => x.ideaId === 'idea_1').hook, 'Hook for idea_1');
});
test('editHook on a stale entry works and makes it current', async () => {
  const k = akit(); const stale = readHooks(k.hooksFile).hooks[2]; assert.equal(hookState(stale, k.ideas[2]), 'stale');
  const res = await k.actions.editHook({ id: 'idea_3', version: k.hv(3), text: 'Fresh wording' }, k.ctx); assert.equal(res.ok, true);
  const e = readHooks(k.hooksFile).hooks.find((x) => x.ideaId === 'idea_3'); assert.equal(hookState(e, k.ideas[2]), 'approved');
});
test('approveClip: eligible clip approved; a not-eligible one returns the reason; a used one (ledger) is refused; a replaced file is version-changed; a stock clip without a licence is rights-missing', async () => {
  const k = akit({ clips: [clipOf('c1'), clipOf('c2', { verified: null }), clipOf('c3'), clipOf('c4'), clipOf('c5', { stock: { sourceUrl: 'https://example.com/x', author: 'A', licenceName: '', downloadedAt: '2026-11-01' } })], usage: [{ clipId: 'c3' }] });
  const ok = await k.actions.approveClip({ id: 'c1', version: k.cv('c1') }, k.ctx); assert.equal(ok.ok, true); assert.deepEqual(ok.change, { kind: 'clip', id: 'c1', decision: 'approved' });
  assert.equal(readClipApprovals(k.approvalsFile).data.clips.c1.state, 'approved');
  assert.deepEqual(await k.actions.approveClip({ id: 'c2', version: k.cv('c2') }, k.ctx), { ok: false, code: 'no-verdict' });
  assert.deepEqual(await k.actions.approveClip({ id: 'c3', version: k.cv('c3') }, k.ctx), { ok: false, code: 'already-used' });
  assert.deepEqual(await k.actions.approveClip({ id: 'c5', version: k.cv('c5') }, k.ctx), { ok: false, code: 'rights-missing' });
  const old = k.cv('c4'); const f = path.join(k.lib, 'c4.mp4'); fs.writeFileSync(f, BIG(99)); bumpT(f);
  assert.deepEqual(await k.actions.approveClip({ id: 'c4', version: old }, k.ctx), { ok: false, code: 'version-changed' });
  assert.equal(readClipApprovals(k.approvalsFile).data.clips.c4, undefined); assert.deepEqual(await k.actions.approveClip({ id: 'c1', version: k.cv('c1') }, k.ctx), { ok: false, code: 'already-approved' });
});
test('approveClip: a missing file, a folder and a symbolic link in the clip path give video-missing and never a hash (info.hash not called); an unhashable file gives version-pending', async () => {
  let hashCalls = 0; const real = fileInfoOf(); const info = { peek: real.peek, prune: real.prune, hash: (...a) => { hashCalls += 1; return real.hash(...a); } };
  const k = akit({ info, clips: [clipOf('gone'), clipOf('dir'), clipOf('link'), clipOf('real')], noFiles: true });
  fs.mkdirSync(path.join(k.lib, 'dir.mp4')); fs.writeFileSync(path.join(k.lib, 'real.mp4'), BIG(70)); fs.symlinkSync(path.join(k.lib, 'real.mp4'), path.join(k.lib, 'link.mp4'));
  for (const id of ['gone', 'dir', 'link']) { assert.deepEqual(await k.actions.approveClip({ id, version: V64 }, k.ctx), { ok: false, code: 'video-missing' }, id); assert.deepEqual(await k.actions.skipClip({ id, version: V64 }, k.ctx), { ok: false, code: 'video-missing' }, id); }
  assert.equal(hashCalls, 0); assert.equal(k.apprBytes(), null);
  const bad = fileInfoOf({ hashFile: async () => { throw new Error('boom'); } }); const b = akit({ info: bad });
  assert.deepEqual(await b.actions.approveClip({ id: 'c1', version: V64 }, b.ctx), { ok: false, code: 'version-pending' });
});
test('approveClip sets enforcedAt exactly when the last current clip gets a decision, and says enforced: true once', async () => {
  const k = akit(); const a1 = await k.actions.approveClip({ id: 'c1', version: k.cv('c1') }, k.ctx);
  assert.equal(a1.ok, true); assert.ok(!a1.enforced); assert.equal(readClipApprovals(k.approvalsFile).data.enforcedAt, null);
  const a2 = await k.actions.approveClip({ id: 'c2', version: k.cv('c2') }, k.ctx); assert.equal(a2.enforced, true); const at = readClipApprovals(k.approvalsFile).data.enforcedAt; assert.equal(at, NOW.toISOString());
  assert.equal((await k.actions.unapproveClip({ id: 'c2', version: k.cv('c2') }, k.ctx)).ok, true);
  const a3 = await k.actions.approveClip({ id: 'c2', version: k.cv('c2') }, k.ctx); assert.equal(a3.ok, true); assert.notEqual(a3.enforced, true); assert.equal(readClipApprovals(k.approvalsFile).data.enforcedAt, at);
});
test('skipClip works for a clip that is not eligible; unapproveClip refuses a used clip; undo keeps enforcedAt', async () => {
  const k = akit({ clips: [clipOf('c1'), clipOf('c2', { verified: null })] });
  assert.equal((await k.actions.skipClip({ id: 'c2', version: k.cv('c2') }, k.ctx)).change.decision, 'skipped'); assert.equal(readClipApprovals(k.approvalsFile).data.clips.c2.state, 'skipped');
  assert.deepEqual(await k.actions.skipClip({ id: 'c2', version: k.cv('c2') }, k.ctx), { ok: false, code: 'already-skipped' });
  assert.deepEqual(await k.actions.unapproveClip({ id: 'c1', version: k.cv('c1') }, k.ctx), { ok: false, code: 'not-decided' });
  assert.equal((await k.actions.approveClip({ id: 'c1', version: k.cv('c1') }, k.ctx)).enforced, true);
  assert.equal((await k.actions.skipClip({ id: 'c1', version: k.cv('c1') }, k.ctx)).ok, true, 'skip replaces an approval');
  assert.equal((await k.actions.unapproveClip({ id: 'c1', version: k.cv('c1') }, k.ctx)).ok, true); const d = readClipApprovals(k.approvalsFile).data; assert.equal(d.clips.c1, undefined); assert.equal(d.enforcedAt, NOW.toISOString());
  assert.equal((await k.actions.approveClip({ id: 'c1', version: k.cv('c1') }, k.ctx)).ok, true); k.state.usage = [{ clipId: 'c1' }]; const b = k.apprBytes();
  assert.deepEqual(await k.actions.unapproveClip({ id: 'c1', version: k.cv('c1') }, k.ctx), { ok: false, code: 'already-used' }); assert.equal(k.apprBytes(), b);
});
test('record failure: a directory in the record file path gives record-failed and the state files are byte for byte unchanged (hooks and approvals)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-act6-rec-')); const k = akit({ recordFile: path.join(dir, 'rec.jsonl') }); fs.mkdirSync(k.recordFile);
  const h = k.hooksBytes();
  assert.deepEqual(await k.actions.approveHook({ id: 'idea_1', version: k.hv(1) }, k.ctx), { ok: false, code: 'record-failed' });
  assert.deepEqual(await k.actions.editHook({ id: 'idea_1', version: k.hv(1), text: 'New words' }, k.ctx), { ok: false, code: 'record-failed' });
  assert.equal(k.hooksBytes(), h);
  assert.deepEqual(await k.actions.approveClip({ id: 'c1', version: k.cv('c1') }, k.ctx), { ok: false, code: 'record-failed' }); assert.equal(k.apprBytes(), null);
});
test('state write failure after a good record: write-failed, a void record follows, readDecisions drops the voided line', async () => {
  const k = akit(); const hb = k.hooksBytes(); fs.chmodSync(path.dirname(k.hooksFile), 0o500);
  try { assert.deepEqual(await k.actions.approveHook({ id: 'idea_1', version: k.hv(1) }, k.ctx), { ok: false, code: 'write-failed' }); } finally { fs.chmodSync(path.dirname(k.hooksFile), 0o700); }
  assert.equal(k.hooksBytes(), hb);
  fs.chmodSync(path.dirname(k.approvalsFile), 0o500);
  try { assert.deepEqual(await k.actions.approveClip({ id: 'c1', version: k.cv('c1') }, k.ctx), { ok: false, code: 'write-failed' }); } finally { fs.chmodSync(path.dirname(k.approvalsFile), 0o700); }
  const raw = fs.readFileSync(k.recordFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); assert.deepEqual(raw.map((r) => r.decision), ['approve', 'void', 'approve', 'void']); assert.equal(raw[1].ref, raw[0].n);
  assert.deepEqual(readDecisions(k.recordFile), { ok: true, records: [] });
});
test('state write failure AND void failure: still write-failed, and one log line holds only the code void-record-failed (no id, no text)', async () => {
  const k = akit({ voidFails: true }); const was = fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8').length : 0; fs.chmodSync(path.dirname(k.hooksFile), 0o500);
  try { assert.deepEqual(await k.actions.approveHook({ id: 'idea_1', version: k.hv(1) }, k.ctx), { ok: false, code: 'write-failed' }); } finally { fs.chmodSync(path.dirname(k.hooksFile), 0o700); }
  const added = fs.readFileSync(LOG_PATH, 'utf8').slice(was).trim().split('\n').filter((l) => l.includes('void-record-failed'));
  assert.equal(added.length, 1); assert.match(added[0], /review failed: void-record-failed$/); assert.ok(!added[0].includes('idea_1') && !added[0].includes('Hook for'));
});
test('two calls at once (Promise.all of approveHook twice): exactly one ok, one already-approved, one record line', async () => {
  const k = akit(); const rs = await Promise.all([k.actions.approveHook({ id: 'idea_1', version: k.hv(1) }, k.ctx), k.actions.approveHook({ id: 'idea_1', version: k.hv(1) }, k.ctx)]);
  assert.deepEqual(rs.map((r) => r.ok || r.code).sort(), [true, 'already-approved'].sort()); assert.equal(k.records.length, 1);
});
test('a held lock answers lock-busy within the timeout', async () => {
  const k = akit({ lockTimeoutMs: 50 }); let release; const held = withDecisionLock(() => new Promise((r) => { release = r; }));
  await new Promise((r) => setTimeout(r, 30)); const t0 = Date.now();
  try { assert.deepEqual(await k.actions.approveHook({ id: 'idea_1', version: k.hv(1) }, k.ctx), { ok: false, code: 'lock-busy' }); assert.ok(Date.now() - t0 < 1500); } finally { release(); await held; }
});
test('closed set of codes (C1): an evaluate stub whose reason contains the hook text, a ledger path or any text outside the set gives check-failed; neither the answer nor the log contains that text; a reason final-check:rule-9 is answered final-check', async () => {
  const secret = 'Hook for idea_1 /var/ledger/ledger.json'; const was = fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8').length : 0;
  const k = akit({ evaluate: async () => ({ ok: false, reason: secret }) }); const res = await k.actions.approveHook({ id: 'idea_1', version: k.hv(1) }, k.ctx);
  assert.deepEqual(res, { ok: false, code: 'check-failed' }); assert.ok(!JSON.stringify(res).includes('ledger')); assert.ok(!(fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8').slice(was) : '').includes('ledger'));
  const f = akit({ evaluate: async () => ({ ok: false, reason: 'final-check:rule-9' }) }); assert.deepEqual(await f.actions.approveHook({ id: 'idea_1', version: f.hv(1) }, f.ctx), { ok: false, code: 'final-check' });
  const table = [['Lions at dawn', 'check-failed'], ['a'.repeat(61), 'check-failed'], ['x\ny', 'check-failed'], ['hook-too-long', 'hook-too-long'], ['final-check:rule-9', 'final-check'], ['__proto__', 'check-failed'], ['', 'check-failed'], [undefined, 'check-failed'], ['no-verdict', 'no-verdict'], ['stale', 'stale'], ['bad-config:autoKinds', 'check-failed'], ['bad-config:x', 'bad-config'], ['version-changed', 'version-changed']];
  for (const [i, o] of table) assert.equal(publicCode(i), o, String(i));
  assert.ok(Object.isFrozen(ACTION_CODES) && Object.isFrozen(EVAL_REASONS));
});
test('every reason literal in the checking code is in EVAL_REASONS', () => {
  const found = new Set();
  for (const f of ['auto-lane.js', 'fact-post.js', 'lib.js']) {
    const src = fs.readFileSync(path.join(HERE, f), 'utf8');
    for (const m of src.matchAll(/reason: '([a-z0-9:_-]+)'/g)) found.add(m[1]);
    if (f === 'fact-post.js') for (const m of src.matchAll(/fail\('([a-z0-9:_-]+)'\)/g)) found.add(m[1]);
  }
  assert.ok(found.size >= 10, `found ${found.size}`);
  for (const lit of found) assert.ok(EVAL_REASONS.includes(lit.split(':')[0]), `${lit} is not in EVAL_REASONS`);
  for (const base of ['final-check', 'alt-text', 'judge']) assert.ok(EVAL_REASONS.includes(base), base);
});
test('ids __proto__ and constructor: every action answers not-found, nothing is written, Object.prototype is untouched', async () => {
  const k = akit(); const hb = k.hooksBytes(); const keys = Object.getOwnPropertyNames(Object.prototype).sort().join();
  for (const id of ['__proto__', 'constructor']) for (const fn of ['approveHook', 'skipHook', 'unapproveHook', 'approveClip', 'skipClip', 'unapproveClip']) assert.deepEqual(await k.actions[fn]({ id, version: V64 }, k.ctx), { ok: false, code: 'not-found' }, `${fn} ${id}`);
  for (const id of ['__proto__', 'constructor']) assert.deepEqual(await k.actions.editHook({ id, version: V64, text: 'Some words' }, k.ctx), { ok: false, code: 'not-found' });
  assert.equal(k.hooksBytes(), hb); assert.equal(k.apprBytes(), null); assert.equal(k.records.length, 0); assert.equal(Object.getOwnPropertyNames(Object.prototype).sort().join(), keys); assert.equal({}.polluted, undefined);
});
test('no action function touches config.json or mentions autoPublish', () => {
  for (const f of ['bpa-actions.js', 'clip-approvals.js']) { const s = fs.readFileSync(path.join(HERE, f), 'utf8'); assert.ok(!s.includes('config.json'), f); assert.ok(!s.includes('autoPublish'), f); }
});

// ── review fixes: CR2 / SR2 (the shared list of test characters, also used by the page test) ─────────────────────────
import { BAD_CHARS, LINEBREAK_CHARS, GOOD_TEXTS } from './review-test-chars.js';
test('CR2/SR2: every character of the shared list is refused with bad-characters, in the middle of an edit; evaluate is never called and nothing is written', async () => {
  const k = akit(); const before = k.hooksBytes(); const missed = [];
  for (const ch of BAD_CHARS) { const r = await k.actions.editHook({ id: 'idea_1', version: k.hv(1), text: `Lions at${ch}dawn` }, k.ctx); if (r.ok !== false || r.code !== 'bad-characters') missed.push(`U+${ch.codePointAt(0).toString(16).toUpperCase()}`); }
  assert.deepEqual(missed, []); assert.ok(BAD_CHARS.length > 300, `the shared list has ${BAD_CHARS.length} characters`);
  assert.equal(k.state.calls.length, 0); assert.equal(k.hooksBytes(), before); assert.equal(k.records.length, 0);
});
test('CR2/SR2: line breaks stay bad-request; ordinary text (space, composed accents, umlaut, digits, curly apostrophe, punctuation) still passes', async () => {
  const k = akit();
  for (const ch of LINEBREAK_CHARS) assert.deepEqual(await k.actions.editHook({ id: 'idea_1', version: k.hv(1), text: `Lions${ch}dawn` }, k.ctx), { ok: false, code: 'bad-request' }, JSON.stringify(ch));
  for (const text of GOOD_TEXTS) { const r = await k.actions.editHook({ id: 'idea_1', version: k.hv(1), text }, k.ctx); assert.equal(r.ok, true, JSON.stringify(text)); assert.equal(readHooks(k.hooksFile).hooks.find((x) => x.ideaId === 'idea_1').hook, text); assert.equal(k.state.calls.at(-1), text); const e = readHooks(k.hooksFile).hooks.find((x) => x.ideaId === 'idea_1'); assert.equal(e.hook, text); k.hv = (n, hook) => hookVersion(hook ?? text, k.ideas[n - 1]); }
});

// ── review fixes: CR4, a linked clip must not block the one-way switch ───────────────────────────────────────────────
test('CR4: a clip whose file is a real symbolic link does not keep the lane open: deciding the only real clip flips the one-way switch', async () => {
  const k = akit(); const linked = path.join(k.lib, 'c1.mp4'); const outside = path.join(k.dir, 'outside.mp4'); fs.writeFileSync(outside, 'x'.repeat(1000));
  fs.rmSync(linked); fs.symlinkSync(outside, linked);
  const res = await k.actions.approveClip({ id: 'c2', version: k.cv('c2') }, k.ctx);
  assert.deepEqual(res, { ok: true, change: { kind: 'clip', id: 'c2', decision: 'approved' }, enforced: true });
  assert.ok(readClipApprovals(k.approvalsFile).data.enforcedAt, 'the switch is set');
});

// ── review fixes: CR5, Approve runs its check outside the lock ─────────────────────────────────────────────────────────
test('CR5: a slow check on one Approve does not make another decision lock-busy; the slow one still approves, with its check seen before and the state rules applied again under the lock', async () => {
  const k = akit({ lockTimeoutMs: 80 }); let release; k.state.gate = { hook: 'Hook for idea_1', wait: new Promise((r) => { release = r; }) };
  const slow = k.actions.approveHook({ id: 'idea_1', version: k.hv(1) }, k.ctx); await new Promise((r) => setTimeout(r, 40));
  const other = await k.actions.skipHook({ id: 'idea_2', version: k.hv(2) }, k.ctx); assert.equal(other.ok, true, JSON.stringify(other));
  await new Promise((r) => setTimeout(r, 120)); // longer than the lock timeout
  const clip = await k.actions.approveClip({ id: 'c1', version: k.cv('c1') }, k.ctx); assert.equal(clip.ok, true, JSON.stringify(clip));
  release(); assert.deepEqual(await slow, { ok: true, change: { kind: 'hook', id: 'idea_1', decision: 'approved' } });
  assert.equal(readHooks(k.hooksFile).hooks[0].approvedBy, 'review page'); assert.equal(readHooks(k.hooksFile).hooks[1].skipped.by, 'review page');
});
test('CR5: the claims changed while the check ran: nothing is approved (the entry is now stale), nothing recorded', async () => {
  const k = akit(); let release; k.state.gate = { hook: 'Hook for idea_1', wait: new Promise((r) => { release = r; }) };
  const slow = k.actions.approveHook({ id: 'idea_1', version: k.hv(1) }, k.ctx); await new Promise((r) => setTimeout(r, 30));
  k.ideas[0].claims = [{ text: 'Claim 1 now says 99 hours.' }]; release();
  assert.deepEqual(await slow, { ok: false, code: 'stale' }); assert.equal(k.records.length, 0); assert.equal(readHooks(k.hooksFile).hooks[0].approvedBy, null);
});
test('CR5: two Skips and an Approve of the same hook while the check runs: the Skip wins, the Approve answers already-skipped', async () => {
  const k = akit(); let release; k.state.gate = { hook: 'Hook for idea_1', wait: new Promise((r) => { release = r; }) };
  const slow = k.actions.approveHook({ id: 'idea_1', version: k.hv(1) }, k.ctx); await new Promise((r) => setTimeout(r, 30));
  assert.equal((await k.actions.skipHook({ id: 'idea_1', version: k.hv(1) }, k.ctx)).ok, true); release();
  assert.deepEqual(await slow, { ok: false, code: 'already-skipped' }); assert.equal(k.records.length, 1);
});

test('low: editHook of an idea already used in a post answers already-used (like undo), history unreadable answers history-unreadable; nothing is checked or written', async () => {
  const k = akit({ history: [{ ideaId: 'idea_1' }] }); const before = k.hooksBytes();
  assert.deepEqual(await k.actions.editHook({ id: 'idea_1', version: k.hv(1), text: 'Lions at dawn' }, k.ctx), { ok: false, code: 'already-used' });
  assert.equal(k.state.calls.length, 0); assert.equal(k.hooksBytes(), before); assert.equal(k.records.length, 0);
  assert.equal((await k.actions.editHook({ id: 'idea_2', version: k.hv(2), text: 'Lions at dusk' }, k.ctx)).ok, true, 'an unused idea is still editable');
  k.state.history = null; assert.deepEqual(await k.actions.editHook({ id: 'idea_1', version: k.hv(1), text: 'Lions at noon' }, k.ctx), { ok: false, code: 'history-unreadable' });
});
