import './test-env.js';
// WIRING + BEHAVIOUR of the rules check: every path to the queue and every publish path runs it.
// Source-level counts in the style of voice-gate-wired.test.js, behaviour through handle() and runWorker() with injected dependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from './approval-server.js';
import { runWorker } from './worker.js';
import { buildDrafts, finalCheck, rulesCheck, saveQueue, loadQueue, renderList, STATUS, CONFIG } from './lib.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');
const count = (s, re) => (s.match(re) || []).length;
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, `marker not found: ${a}`); const j = b ? s.indexOf(b, i + a.length) : -1; return s.slice(i, j > i ? j : undefined); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-rg-'));
const CLEAN = 'The ferry from Dar es Salaam to Zanzibar takes about two hours. More on the site, link in profile.';
const NOCLAIM = 'Official guides explain how the trail works. More on the site, link in profile.'; // no number or place, so the claim gate has nothing to ask for
const BAD = 'Big waves this week, book now.';

// ── wiring (source level) ─────────────────────────────────────────────────────
test('queue path 1: buildDrafts runs the rules check right after the voice gate, once, and a violation rejects the draft', () => {
  const body = between(read('lib.js'), 'export async function buildDrafts', '// ── scheduling slots');
  assert.equal(count(body, /rulesCheck\(/g), 1);
  assert.ok(body.indexOf('await voiceGate(') < body.indexOf('rulesCheck('), 'rules check follows the voice gate');
  assert.ok(body.indexOf('rulesCheck(') < body.indexOf('createdAt: now.toISOString()'), 'and runs before the accepted draft is built');
  assert.match(body, /rejected: 'rules: '/);
});
test('queue path 2: checkEdit (draft-actions.js) runs the rules check after the voice gate, inside the check that runs before the text is assigned', () => {
  const check = between(read('draft-actions.js'), 'export async function checkEdit', 'export function applyEdit');
  assert.equal(count(check, /rulesCheck\(text/g), 1);
  assert.ok(check.indexOf('await voiceGate(text)') < check.indexOf('rulesCheck(text'));
});
test('queue path 3: planCarousel runs the rules check on every slide, inside the slide loop, after the voice gate', () => {
  const body = between(read('carousel.js'), 'export async function planCarousel', null);
  assert.match(body, /rules = rulesCheck/); assert.equal(count(body, /rules\(/g), 1);
  assert.ok(body.indexOf('await voice(') < body.indexOf('rules('));
  assert.ok(body.slice(0, body.indexOf('rules(')).includes('for ('));
});
test('publish path 1: the worker calls finalCheck once, after the stop check and BEFORE the cap reservation, the claim and the publisher', () => {
  const w = read('worker.js'); const body = between(w, 'async function runWorkerInner', 'const isMain');
  assert.equal(count(body, /await finalCheck\(|await check\(/g), 1);
  const at = body.search(/await finalCheck\(|await check\(/);
  for (const later of ['reserve({', 'claimIgPublish(', 'await publishIg(']) assert.ok(at < body.indexOf(later), `final check must precede ${later}`);
  assert.ok(body.lastIndexOf('stop()', at) > body.indexOf('igOn()'), 'after the stop check');
});
test('publish path 2: approveGuards (draft-actions.js) runs finalCheck once, after the stop check and the claim gate; the approval server calls approveGuards once, before scheduleDraft, publish() and publishIg()', () => {
  const g = between(read('draft-actions.js'), 'export async function approveGuards', 'export async function scheduleDraft');
  assert.equal(count(g, /await finalCheck\(/g), 1); assert.equal(count(g, /claimGateWhy\(/g), 1);
  assert.ok(g.indexOf('stop()') >= 0 && g.indexOf('stop()') < g.indexOf('claimGateWhy(') && g.indexOf('claimGateWhy(') < g.indexOf('await finalCheck('), 'stop, then claim gate, then final check');
  const sd = between(read('draft-actions.js'), 'export async function scheduleDraft', null);
  assert.equal(count(sd, /finalCheck/g), 0, 'scheduleDraft runs no check of its own: it needs a draft approveGuards let through'); assert.equal(count(sd, /await schedule\(d\.text/g), 1);
  const s = between(read('approval-server.js'), "if (c.cmd === 'approve' || c.cmd === 'postnow')", 'saveQueue(q, queuePath)');
  assert.equal(count(s, /await approveGuards\(/g), 1);
  const at = s.indexOf('await approveGuards(');
  for (const later of ['await publish(d.text)', 'await scheduleDraft(', 'await publishIg(d)', 'reserve({']) assert.ok(at < s.indexOf(later), `the guards must precede ${later}`);
});
test('every source file that reaches a publish function also runs finalCheck first (fails when a new publisher appears without it)', () => {
  const callers = [];
  for (const f of fs.readdirSync(HERE).filter((x) => x.endsWith('.js') && !x.endsWith('.test.js') && x !== 'lib.js')) {
    const s = read(f); const m = /\b(?:schedulePost|publishNow|igPostDraftAny|publishIg|publish|schedule|scheduleDraft)\(/.exec(s.replace(/\/\/.*$/gm, ''));
    if (m) callers.push(f); // ANY file that calls a publisher or receives one as a parameter and calls it
  }
  assert.deepEqual(callers.sort(), ['approval-server.js', 'draft-actions.js', 'worker.js'], 'the set of files that publish changed: each needs its guard');
  const guard = { 'approval-server.js': /await approveGuards\(/, 'draft-actions.js': /await finalCheck\(/, 'worker.js': /await check\(/ };
  for (const f of callers) assert.match(read(f), guard[f], `${f} publishes without its guard`);
});
test('finalCheck re-runs BOTH the voice gate and the rules check on every text that goes out', () => {
  const lib = read('lib.js'); const body = between(lib, 'async function outgoingTexts', 'export async function blockDraft');
  assert.match(body, /voice\(/); assert.match(body, /rulesGate\(|rulesCheck\(/);
  for (const part of ['d.text', 'slides', 'videoText']) assert.ok(body.includes(part), `finalCheck must cover ${part}`);
});

// ── finalCheck behaviour ──────────────────────────────────────────────────────
const okVoice = async () => ({ ok: true, reason: null });
const NP = ['examplehotel'];
test('finalCheck: a clean text passes; a refused caption, slide or video text blocks, each naming its rule', async () => {
  assert.deepEqual((await finalCheck({ id: 'B1', kind: 'x', text: CLEAN }, { neverPromotePatterns: NP, voice: okVoice })).ok, true);
  const r = await finalCheck({ id: 'B1', text: CLEAN, slides: [{ text: 'fine' }, 'Big waves today'], videoText: 'Book now' }, { neverPromotePatterns: NP, voice: okVoice });
  assert.equal(r.ok, false); assert.deepEqual([...r.ruleIds].sort(), ['paid-link-wording', 'sea-conditions']);
});
test('finalCheck: a voice-lint failure on the exact text blocks with rule id voice-lint', async () => {
  const r = await finalCheck({ id: 'B1', text: CLEAN }, { neverPromotePatterns: NP, voice: async () => ({ ok: false, reason: 'x' }) }); assert.deepEqual(r.ruleIds, ['voice-lint']);
});
test('finalCheck: draft claims source a figure; no claims and a figure blocks; old items without claims still pass when clean', async () => {
  const t = 'The park fee is 25 USD per adult.';
  assert.equal((await finalCheck({ id: 'B1', text: t, claims: [{ text: 'Fee: USD 25', sourceDate: '2026-11-01' }] }, { neverPromotePatterns: NP, voice: okVoice })).ok, true);
  assert.deepEqual((await finalCheck({ id: 'B1', text: t }, { neverPromotePatterns: NP, voice: okVoice })).ruleIds, ['unsourced-figure']);
});
test('finalCheck: with the never-promote file missing it refuses a harmless text (fail closed, through the real loader)', async () => {
  const keep = process.env.BPA_NEVER_PROMOTE_FILE; process.env.BPA_NEVER_PROMOTE_FILE = path.join(tmp(), 'missing.json');
  try { const r = await finalCheck({ id: 'B1', text: CLEAN }, { voice: okVoice }); assert.deepEqual(r.ruleIds, ['never-promote-list-unavailable']); assert.equal(rulesCheck(CLEAN).ok, false); }
  finally { process.env.BPA_NEVER_PROMOTE_FILE = keep; }
  assert.equal((await finalCheck({ id: 'B1', text: CLEAN }, { voice: okVoice })).ok, true, 'with the test-env list present the same text passes');
});
test('finalCheck never throws: a crashing voice gate is a blocking violation', async () => {
  const r = await finalCheck({ id: 'B1', text: CLEAN }, { neverPromotePatterns: NP, voice: async () => { throw new Error('boom'); } }); assert.equal(r.ok, false);
});

// ── queue paths, behaviour ────────────────────────────────────────────────────
const brief = { date: '2026-09-11', items: [{ signal: { id: 'x', subject: 'Sauti za Busara', region: 'zanzibar', summary: 'The festival dates were confirmed for February. Book now.', confidence: 0.9, magnitude: 1, sourceIds: ['a', 'b'] }, whyItMatters: 'Beds in Stone Town fill a month early.', whatToDo: 'Open February dates now.', sources: [{ id: 'a' }, { id: 'b' }] }] };
test('buildDrafts: a refused wording is rejected with the rule id, before it can reach the queue', async () => {
  const out = await buildDrafts({ briefs: [brief], now: new Date('2026-09-12T00:00:00Z'), existingDrafts: [], config: { ...CONFIG, tourismStatsDrafts: true } });
  const sig = out.find((d) => d.kind === 'signal'); assert.match(sig.rejected, /^rules: .*paid-link-wording/);
});
const pending = (text) => ({ id: 'B1', status: 'pending_approval', kind: 'outlook', text, sourceDate: '2026-11-17' });
function hfix(text, extra = {}) {
  const dir = tmp(); const queuePath = path.join(dir, 'q.json'); saveQueue({ seq: 1, drafts: [{ ...pending(text), ...extra }] }, queuePath);
  const calls = { schedule: 0, publish: 0, publishIg: 0, notify: [], lines: [] };
  const deps = { queuePath, stopOpts: { flagPath: path.join(dir, 's'), fleetPath: path.join(dir, 'f') }, igOn: () => true, config: {}, ledgerPath: path.join(dir, 'ledger.jsonl'), lastPostPath: path.join(dir, 'lp.json'),
    schedule: async () => { calls.schedule++; return { id: 'p1' }; }, publish: async () => { calls.publish++; return { id: 'p1', permalink_url: 'https://example.invalid/p1' }; }, publishIg: async () => { calls.publishIg++; return { permalink: 'https://example.invalid/i1' }; },
    notify: async (m) => { calls.notify.push(m); return true; } };
  return { dir, queuePath, deps, calls };
}
test('handle edit: a refused wording is refused with the rule ids and the text is not replaced', async () => {
  const f = hfix(CLEAN); const out = await handle(`bpa edit B1: ${BAD}`, f.deps);
  assert.match(out, /^❌ B1: rules — .*sea-conditions/); assert.equal(loadQueue(f.queuePath).drafts[0].text, CLEAN);
  const ok = await handle('bpa edit B1: The ferry takes about two hours. More on the site, link in profile.', f.deps); assert.match(ok, /^✏️ B1 updated/);
});
for (const cmd of ['bpa approve B1', 'bpa post B1 now']) {
  test(`handle "${cmd}": text edited in the queue file to a refused wording -> nothing scheduled or published, state blocked, one alert, no ledger slot`, async () => {
    const f = hfix(BAD); const out = await handle(cmd, f.deps);
    assert.deepEqual([f.calls.schedule, f.calls.publish, f.calls.publishIg], [0, 0, 0]);
    const d = loadQueue(f.queuePath).drafts[0]; assert.equal(d.status, STATUS.BLOCKED); assert.equal(STATUS.BLOCKED, 'blocked'); assert.ok(d.blocked.rules.includes('sea-conditions') && d.blocked.rules.includes('paid-link-wording'));
    assert.match(out, /^🚫 B1 blocked/); assert.match(out, /sea-conditions/);
    assert.equal(f.calls.notify.length, 1); assert.match(f.calls.notify[0], /B1/); assert.match(f.calls.notify[0], /sea-conditions/); assert.ok(!f.calls.notify[0].includes('Big waves'), 'the alert carries rule ids, not the text');
    assert.equal(fs.existsSync(f.deps.ledgerPath), false, 'the check runs before the cap reservation');
    // never retried: the item is no longer pending, so approving again does nothing
    const again = await handle(cmd, f.deps); assert.match(again, /B1 is blocked/); assert.equal(f.calls.notify.length, 1);
  });
}
test('handle: a clean pending item is still scheduled and posted (so the tests above can fail)', async () => {
  { const f = hfix(NOCLAIM); await handle('bpa approve B1', f.deps); assert.equal(f.calls.schedule, 1); assert.equal(f.calls.notify.length, 0); }
  { const f = hfix(NOCLAIM); await handle('bpa post B1 now', f.deps); assert.equal(f.calls.publish, 1); assert.equal(f.calls.publishIg, 1); }
});
test('handle: with no never-promote list the approval is blocked with never-promote-list-unavailable (fail closed)', async () => {
  const keep = process.env.BPA_NEVER_PROMOTE_FILE; process.env.BPA_NEVER_PROMOTE_FILE = path.join(tmp(), 'missing.json');
  try { const f = hfix(NOCLAIM); const out = await handle('bpa approve B1', f.deps); assert.equal(f.calls.schedule, 0); assert.match(out, /never-promote-list-unavailable/); }
  finally { process.env.BPA_NEVER_PROMOTE_FILE = keep; }
});
test('list and status show blocked items with their rule ids (no text)', async () => {
  const f = hfix(BAD); await handle('bpa approve B1', f.deps);
  const q = loadQueue(f.queuePath); const list = renderList(q); assert.match(list, /B1.*blocked.*sea-conditions/s); assert.ok(!list.includes('Big waves'));
  assert.match(await handle('bpa status', f.deps), /blocked 1/); assert.match(await handle('bpa', f.deps), /blocked/);
});

// ── the worker ────────────────────────────────────────────────────────────────
function wfix(text, extra = {}) {
  const dir = tmp(); const queuePath = path.join(dir, 'queue.json');
  saveQueue({ seq: 1, drafts: [{ id: 'B1', status: 'scheduled', kind: 'signal', text, sourceDate: '2026-11-01', postId: 'p1', scheduledFor: '2026-11-02T09:00:00+03:00', ig: { status: 'queued', at: '2026-11-02T09:00:00+03:00' }, ...extra }] }, queuePath);
  const calls = { ig: 0, notify: [], lines: [] };
  const deps = { now: new Date('2026-11-17T10:00:00Z'), queuePath, stopOpts: { flagPath: path.join(dir, 's'), fleetPath: path.join(dir, 'f') }, igOn: () => true, publishIg: async () => { calls.ig++; return { permalink: 'https://example.invalid/p/1' }; },
    postStatus: async () => ({ is_published: false }), notify: async (m) => { calls.notify.push(m); return true; }, say: (m) => calls.lines.push(m), approvalHealth: async () => ({ ok: true }),
    ledgerPath: path.join(dir, 'ledger.jsonl'), runStatePath: path.join(dir, 'run.json'), lastPostPath: path.join(dir, 'lastpost.json') };
  return { dir, queuePath, deps, calls };
}
test('worker: clean text is published once (control)', async () => { const f = wfix(CLEAN); await runWorker(f.deps); assert.equal(f.calls.ig, 1); assert.equal(loadQueue(f.queuePath).drafts[0].ig.status, 'posted'); });
test('worker: a queued item whose text was edited in queue.json to a refused wording is never published, set to blocked, one alert, no ledger slot, never retried', async () => {
  const f = wfix(CLEAN);
  const q = loadQueue(f.queuePath); q.drafts[0].text = BAD; saveQueue(q, f.queuePath); // the direct edit, after every gate had passed
  await runWorker(f.deps);
  assert.equal(f.calls.ig, 0, 'publisher must not be called');
  const d = loadQueue(f.queuePath).drafts[0]; assert.equal(d.status, 'blocked'); assert.equal(d.ig.status, 'blocked'); assert.ok(d.blocked.rules.includes('sea-conditions'));
  const alerts = f.calls.notify.filter((m) => /blocked/.test(m)); assert.equal(alerts.length, 1); assert.match(alerts[0], /sea-conditions/); assert.ok(!alerts[0].includes('Big waves'));
  assert.equal(f.calls.lines.filter((l) => /BLOCKED/.test(l)).length, 1, 'one log line');
  assert.equal(fs.existsSync(f.deps.ledgerPath), false, 'no ledger slot used');
  await runWorker({ ...f.deps, now: new Date('2026-11-17T10:15:00Z') }); assert.equal(f.calls.ig, 0); assert.equal(f.calls.notify.filter((m) => /blocked/.test(m)).length, 1, 'no second alert, no retry');
});
test('worker: a carousel-format item is checked on every slide text it carries', async () => {
  const f = wfix(CLEAN, { slides: [{ text: 'fine' }, { text: 'Use our link today' }] }); await runWorker(f.deps);
  assert.equal(f.calls.ig, 0); assert.equal(loadQueue(f.queuePath).drafts[0].status, 'blocked');
});
