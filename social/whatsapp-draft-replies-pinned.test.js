import './test-env.js';
// Pins what the WhatsApp command route answers for skip, edit, approve and post now, BEFORE the code is moved (steps 3 extraction): exact strings, state changes, call counts.
import { test } from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { handle } from './approval-server.js'; import { saveQueue, loadQueue } from './lib.js'; import { claimGate } from './claim-gate.js'; import { StoppedError } from './stop.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-dpin-'));
const CLEAN = 'Lions sleep most of the day on the plains.';
const SEA = 'Book now for big waves today at the beach.'; // refused by the rules gate: sea-conditions, paid-link-wording
const VOICE_BAD = 'Let us delve into a rich tapestry of seamless synergy. It is a game-changer!';
const pend = (id = 'B1', extra = {}) => ({ id, status: 'pending_approval', kind: 'outlook', text: CLEAN, sourceDate: '2026-11-17', ...extra });
// Everything that leaves the process is injected and counted. igOn is not counted (the original asks twice; the extraction asks once).
function kit(drafts = [pend()], over = {}) {
  const d = tmp(); const queuePath = path.join(d, 'q.json'); saveQueue({ seq: 1, drafts }, queuePath);
  const calls = { schedule: [], publish: [], publishIg: 0, reserve: 0, release: 0, notify: [] };
  const deps = { queuePath, stopOpts: { flagPath: path.join(d, 'f', 'stop'), fleetPath: path.join(d, 'fleet.flag') }, igOn: () => false, neverPromotePatterns: ['examplehotel'], config: {}, ledgerPath: path.join(d, 'l.jsonl'), lastPostPath: path.join(d, 'lp.json'),
    schedule: async (text, at) => { calls.schedule.push({ text, at }); return { id: 'p1' }; }, publish: async (text) => { calls.publish.push(text); return { id: 'p1', permalink_url: 'https://example.invalid/p1' }; },
    publishIg: async () => { calls.publishIg++; return { permalink: 'https://example.invalid/i1' }; }, reserve: () => { calls.reserve++; return { ok: true }; }, release: () => { calls.release++; return { ok: true }; },
    notify: async (m) => { calls.notify.push(m); return true; }, ...over };
  return { d, calls, deps, queuePath, q: () => loadQueue(queuePath), draft: (id = 'B1') => loadQueue(queuePath).drafts.find((x) => x.id === id) };
}
const noExternal = (c) => { assert.equal(c.schedule.length, 0); assert.equal(c.publish.length, 0); assert.equal(c.publishIg, 0); assert.equal(c.reserve, 0); assert.equal(c.release, 0); };

test('pin skip: pending is skipped with decidedAt; a non-pending draft is only named; an unknown id is not found', async () => {
  const k = kit([pend('B1'), pend('B2', { status: 'scheduled' })]);
  assert.equal(await handle('bpa skip B1', k.deps), '🚫 B1 skipped'); assert.equal(k.draft().status, 'skipped'); assert.ok(!Number.isNaN(Date.parse(k.draft().decidedAt)));
  assert.equal(await handle('bpa skip B2', k.deps), '⚠️ B2 is scheduled'); assert.equal(k.draft('B2').status, 'scheduled');
  assert.equal(await handle('bpa skip B9', k.deps), '❌ B9: not found'); noExternal(k.calls); assert.equal(k.calls.notify.length, 0);
});
test('pin skip: two ids in one command answer two lines in order', async () => {
  const k = kit([pend('B1'), pend('B2')]); assert.equal(await handle('bpa skip B1 B2', k.deps), '🚫 B1 skipped\n🚫 B2 skipped'); noExternal(k.calls);
});
test('pin edit: success reply, new text, the claim fields gone, editedAt set, nothing sent', async () => {
  const k = kit([pend('B1', { claims: [{ text: 'x', sourceDate: '2026-11-01' }], claimSources: [{}], claimSourcesHash: 'h', claimSourcesAt: 't' })]); const text = 'Giraffes feed on tall acacia trees.';
  assert.equal(await handle(`bpa edit B1: ${text}`, k.deps), `✏️ B1 updated (${text.length} chars). Reply *bpa approve B1* to schedule.`);
  const d = k.draft(); assert.equal(d.text, text); assert.ok(!('claimSources' in d) && !('claimSourcesHash' in d) && !('claimSourcesAt' in d)); assert.ok(!Number.isNaN(Date.parse(d.editedAt))); assert.equal(d.status, 'pending_approval'); assert.ok(d.claims, 'claims stay'); noExternal(k.calls);
});
test('pin edit refusals: brand, voice, rules; the text is unchanged each time', async () => {
  const k = kit();
  assert.equal(await handle('bpa edit B1: Beyond Paradise is lovely.', k.deps), '❌ B1: brand must be written in full: "Beyond Paradise Adventures"');
  assert.ok((await handle(`bpa edit B1: ${VOICE_BAD}`, k.deps)).startsWith('❌ B1: voice-lint — '));
  assert.equal(await handle(`bpa edit B1: ${SEA}`, k.deps), '❌ B1: rules — sea-conditions, paid-link-wording');
  assert.equal(k.draft().text, CLEAN); assert.ok(!('editedAt' in k.draft())); noExternal(k.calls);
});
test('pin approve: scheduled on the Page; the slot, status, postId, decidedAt; no ig key', async () => {
  const k = kit(); const out = await handle('bpa approve B1', k.deps);
  assert.match(out, /^📅 B1 scheduled for \d{4}-\d{2}-\d{2}T09:00 on the Page \(p1\)$/); assert.equal(k.calls.schedule.length, 1); assert.equal(k.calls.schedule[0].text, CLEAN); assert.match(k.calls.schedule[0].at, /T09:00:00\+03:00$/);
  const d = k.draft(); assert.equal(d.status, 'scheduled'); assert.equal(d.postId, 'p1'); assert.equal(d.scheduledFor, k.calls.schedule[0].at); assert.ok(!Number.isNaN(Date.parse(d.decidedAt))); assert.ok(!('ig' in d));
  assert.equal(k.calls.publish.length, 0); assert.equal(k.calls.publishIg, 0); assert.equal(k.calls.reserve, 0); assert.equal(k.calls.notify.length, 0);
});
test('pin approve with Instagram on: Page + Instagram and the queued leg', async () => {
  const k = kit([pend()], { igOn: () => true }); const out = await handle('bpa approve B1', k.deps);
  assert.match(out, /^📅 B1 scheduled for \d{4}-\d{2}-\d{2}T09:00 on the Page \+ Instagram \(p1\)$/); assert.deepEqual(k.draft().ig, { status: 'queued', at: k.calls.schedule[0].at }); assert.equal(k.calls.schedule.length, 1); assert.equal(k.calls.publishIg, 0);
});
test('pin approve refusals call nothing at Meta: stop flag, claim gate, final check (blocked and alerted once)', async () => {
  const s = kit(); fs.mkdirSync(path.dirname(s.deps.stopOpts.flagPath), { recursive: true }); fs.writeFileSync(s.deps.stopOpts.flagPath, 'x');
  assert.match(await handle('bpa approve B1', s.deps), /^⏸ B1: stopped by flag since \S+\. Reply \*bpa start\* to resume\.$/); noExternal(s.calls); assert.equal(s.draft().status, 'pending_approval');
  const fig = 'The park fee is 25 USD per adult.'; const g = kit([pend('B1', { text: fig })]); const gate = claimGate({ text: fig });
  assert.match(gate, /^no recorded source line for claims \(.+\); record claimSources first$/); assert.equal(await handle('bpa approve B1', g.deps), `❌ B1: ${gate}`); noExternal(g.calls); assert.equal(g.draft().status, 'pending_approval');
  const b = kit([pend('B1', { text: SEA })]); assert.equal(await handle('bpa approve B1', b.deps), '🚫 B1 blocked: sea-conditions, paid-link-wording. Nothing was posted or scheduled; it will not be retried.');
  noExternal(b.calls); assert.equal(b.draft().status, 'blocked'); assert.equal(b.calls.notify.length, 1);
});
test('pin approve: a stop that arrives during the call, and an ordinary failure', async () => {
  const a = kit([pend()], { schedule: async () => { throw new StoppedError('stopped by flag since T1'); } });
  assert.equal(await handle('bpa approve B1', a.deps), '⏸ B1: stopped by flag since T1. Nothing was posted. Reply *bpa start* to resume.'); assert.equal(a.draft().status, 'pending_approval');
  const b = kit([pend()], { schedule: async () => { throw new Error('boom'); } }); assert.equal(await handle('bpa approve B1', b.deps), '❌ B1: boom'); assert.equal(b.draft().lastError, 'boom'); assert.equal(b.draft().status, 'pending_approval');
});
test('pin post now: posted at once on the Page, nothing scheduled', async () => {
  const k = kit(); assert.equal(await handle('bpa post B1 now', k.deps), '✅ B1 posted now on the Page: https://example.invalid/p1');
  assert.equal(k.draft().status, 'posted'); assert.equal(k.calls.publish.length, 1); assert.equal(k.calls.publish[0], CLEAN); assert.equal(k.calls.schedule.length, 0); assert.equal(k.calls.publishIg, 0); assert.equal(k.calls.reserve, 0);
});
test('pin: missing queue file answers not found', async () => {
  const d = tmp(); const k = kit(); const deps = { ...k.deps, queuePath: path.join(d, 'never-created.json') };
  assert.equal(await handle('bpa skip B1', deps), '❌ B1: not found'); noExternal(k.calls);
});
test('documents: an unreadable queue file answers not found AND is overwritten with an empty queue (the hazard the extraction fixes)', async () => {
  const k = kit(); fs.writeFileSync(k.queuePath, '{broken');
  assert.equal(await handle('bpa skip B1', k.deps), '❌ B1: not found'); assert.deepEqual(JSON.parse(fs.readFileSync(k.queuePath, 'utf8')), { seq: 0, drafts: [] }); noExternal(k.calls);
});
