import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { parseDecisionBody, parsePostingBody, runDecision, runPosting } from './review-decide.js';
import { readDecisions } from './review-decisions.js';
const V = 'a'.repeat(64);
const base = { kind: 'hook', id: 'idea-1', version: V, action: 'approve' };
const J = (o) => JSON.stringify(o);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-dec-'));

test('25 malformed bodies are refused', () => {
  const bad = [
    J({ ...base, extra: 1 }), J({ kind: 'hook', id: 'a', version: V }), J({ kind: 'hook', id: 'a', action: 'approve' }),
    J({ id: 'a', version: V, action: 'approve' }), J({ kind: 'hook', version: V, action: 'approve' }),
    J({ ...base, version: 'a'.repeat(63) }), J({ ...base, version: 'a'.repeat(65) }), J({ ...base, version: 'G'.repeat(64) }),
    J({ ...base, id: 'a\nb' }), J({ ...base, id: '' }), J({ ...base, id: 'x'.repeat(201) }), J({ ...base, id: 'a\u0000b' }), J({ ...base, id: 5 }),
    J({ ...base, action: 'skip', text: 'hello' }), J({ ...base, action: 'edit' }), J({ ...base, action: 'edit', text: '' }), J({ ...base, action: 'edit', text: 'x'.repeat(201) }),
    J({ ...base, action: 'edit', text: 5 }),
    J([base]), 'null', J('x'.repeat(3000)), '42', 'not json', '',
    '{"__proto__":{"x":1},"kind":"hook","id":"a","version":"' + V + '","action":"approve"}',
    '{"constructor":1,"kind":"hook","id":"a","version":"' + V + '","action":"approve"}',
    J({ kind: 'clip', id: 'c', version: V, action: 'edit', text: 'hi' }),
    J({ kind: 'video', id: 'c', version: V, action: 'approve' }), J({ ...base, action: 'toString' }), J({ ...base, kind: '__proto__' }),
  ];
  assert.ok(bad.length >= 25);
  for (const b of bad) assert.deepEqual(parseDecisionBody(b), { ok: false }, b.slice(0, 80));
  assert.deepEqual(parseDecisionBody(undefined), { ok: false });
});
test('valid bodies parse', () => {
  assert.deepEqual(parseDecisionBody(J(base)), { ok: true, req: base });
  assert.equal(parseDecisionBody(J({ ...base, kind: 'clip', action: 'skip' })).ok, true);
  assert.deepEqual(parseDecisionBody(J({ ...base, action: 'edit', text: 'Hello' })).req.text, 'Hello');
  assert.equal(parseDecisionBody(J({ ...base, action: 'undo' })).ok, true);
  for (const id of ['__proto__', 'constructor']) assert.equal(parseDecisionBody(J({ ...base, id })).req.id, id);
});
test('posting bodies', () => {
  assert.deepEqual(parsePostingBody('{"action":"stop"}'), { ok: true, action: 'stop' });
  assert.deepEqual(parsePostingBody('{"action":"start"}'), { ok: true, action: 'start' });
  for (const b of ['{"action":"x"}', '{}', '{"action":"stop","a":1}', '[]', 'null', 'zz', '{"action":"constructor"}']) assert.deepEqual(parsePostingBody(b), { ok: false });
});
test('runDecision takes the login from its argument and passes ctx', async () => {
  const d = tmp(); const recordFile = path.join(d, 'r.jsonl'); let seen;
  const actions = { approveHook: async (req, ctx) => { seen = { req, ctx }; const r = ctx.record({ kind: 'hook', id: req.id, version: req.version, decision: 'approve' }); return r.ok ? { ok: true, change: { kind: 'hook', id: req.id, decision: 'approved' } } : { ok: false, code: 'record-failed' }; } };
  const body = { ...base, claimedLogin: 'evil@example.com' };
  assert.equal(parseDecisionBody(J(body)).ok, false);
  const r = await runDecision({ ...parseDecisionBody(J(base)).req, claimedLogin: "evil@example.com" }, { actions, recordFile, claimedLogin: 'owner@example.com', now: () => new Date('2026-11-17T09:00:00Z') });
  assert.equal(r.ok, true); assert.equal(typeof seen.ctx.record, 'function'); assert.equal(typeof seen.ctx.voidRecord, 'function');
  const recs = readDecisions(recordFile).records; assert.equal(recs.length, 1); assert.equal(recs[0].claimedLogin, 'owner@example.com'); assert.equal(recs[0].at, '2026-11-17T09:00:00.000Z');
  const v = seen.ctx.voidRecord(1); assert.equal(v.ok, true);
  assert.equal(readDecisions(recordFile).records.length, 0);
});
test('runDecision maps kind and action to the right function', async () => {
  const calls = []; const mk = (n) => async () => { calls.push(n); return { ok: true, change: {} }; };
  const actions = { approveHook: mk('ah'), skipHook: mk('sh'), unapproveHook: mk('uh'), editHook: mk('eh'), approveClip: mk('ac'), skipClip: mk('sc'), unapproveClip: mk('uc') };
  const o = { actions, recordFile: '/nonexistent/x', claimedLogin: 'owner@example.com' };
  for (const [k, a] of [['hook', 'approve'], ['hook', 'skip'], ['hook', 'undo'], ['hook', 'edit'], ['clip', 'approve'], ['clip', 'skip'], ['clip', 'undo']]) await runDecision({ kind: k, id: 'i', version: V, action: a, ...(a === 'edit' ? { text: 't' } : {}) }, o);
  assert.deepEqual(calls, ['ah', 'sh', 'uh', 'eh', 'ac', 'sc', 'uc']);
  assert.deepEqual(await runDecision({ kind: 'clip', id: 'i', version: V, action: 'edit', text: 't' }, o), { ok: false, code: 'bad-request' });
});
test('a refusal code goes through the closed set', async () => {
  const actions = { approveHook: async () => ({ ok: false, code: 'Lions at dawn' }), skipHook: async () => ({ ok: false, code: 'stale' }) };
  const o = { actions, recordFile: '/x', claimedLogin: 'owner@example.com' };
  assert.deepEqual(await runDecision({ ...base }, o), { ok: false, code: 'check-failed' });
  assert.deepEqual(await runDecision({ ...base, action: 'skip' }, o), { ok: false, code: 'stale' });
});
const posting = () => { const d = tmp(); return { d, recordFile: path.join(d, 'r.jsonl'), claimedLogin: 'owner@example.com', now: () => new Date('2026-11-17T09:00:00Z'), queuePath: path.join(d, 'q.json'), stopOpts: { flagPath: path.join(d, 'f', 'stop'), fleetPath: path.join(d, 'fleet.flag') } }; };
test('stop still stops when the record file is a directory (D6)', async () => {
  const p = posting(); fs.mkdirSync(p.recordFile);
  const r = await runPosting('stop', p); assert.equal(r.ok, true);
  assert.equal(fs.existsSync(p.stopOpts.flagPath), true);
});
test('stop writes a record line after stopping', async () => {
  const p = posting(); const r = await runPosting('stop', p); assert.equal(r.ok, true);
  const recs = readDecisions(p.recordFile).records; assert.equal(recs.length, 1); assert.equal(recs[0].decision, 'stop'); assert.equal(recs[0].claimedLogin, 'owner@example.com');
});
test('stop answers could-not-stop when status says not stopped', async () => {
  const p = posting(); const r = await runPosting('stop', { ...p, stop: () => ({ reply: '' }), readStatus: () => ({ stop: { stopped: false } }) });
  assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: 'could-not-stop' });
});
test('start: record failure does not call start', async () => {
  const p = posting(); fs.mkdirSync(p.recordFile); let called = false;
  const r = await runPosting('start', { ...p, start: () => { called = true; return { reply: '' }; } });
  assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: 'record-failed' }); assert.equal(called, false);
});
test('start releases and records', async () => {
  const p = posting(); await runPosting('stop', p);
  const r = await runPosting('start', p); assert.equal(r.ok, true);
  assert.equal(fs.existsSync(p.stopOpts.flagPath), false);
  assert.deepEqual(readDecisions(p.recordFile).records.map((x) => x.decision), ['stop', 'start']);
});
test('start with the fleet flag held answers still-stopped', async () => {
  const p = posting(); fs.writeFileSync(p.stopOpts.fleetPath, 'x');
  const r = await runPosting('start', p); assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: 'still-stopped' });
});

// ── review fixes: CR3, the posting record is written under the decision lock ─────────────────────────────────────────
import { withDecisionLock } from './decision-lock.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test('CR3: a Stop record waits for the decision lock (the stop itself happens at once), and is written when the lock is free', async () => {
  const p = posting(); let release; const held = withDecisionLock(() => new Promise((r) => { release = r; })); await sleep(30);
  const run = runPosting('stop', p); await sleep(150);
  assert.equal(fs.existsSync(p.stopOpts.flagPath), true, 'the stop is not held back by the lock');
  assert.equal(fs.existsSync(p.recordFile), false, 'the record waits for the lock');
  release(); await held; const r = await run; assert.equal(r.ok, true);
  assert.deepEqual(readDecisions(p.recordFile).records.map((x) => x.decision), ['stop']);
});
test('CR3: a Start record also waits for the lock, and a lock that stays busy answers record-failed without releasing the stop', async () => {
  const p = posting(); await runPosting('stop', p); let release; const held = withDecisionLock(() => new Promise((r) => { release = r; })); await sleep(30);
  const r = await runPosting('start', { ...p, lockTimeoutMs: 60 }); assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: 'record-failed' });
  assert.equal(fs.existsSync(p.stopOpts.flagPath), true, 'still stopped'); release(); await held;
});
test('CR3: a Stop arriving while a clip decision commits gets its own number, after the clip decision and its void line, and survives the void', async () => {
  const p = posting(); let n1 = null;
  const actions = { approveClip: (req, ctx) => withDecisionLock(async () => { const r = ctx.record({ kind: 'clip', id: 'c1', version: V, decision: 'approve' }); n1 = r.n; await sleep(150); ctx.voidRecord(r.n); return { ok: false, code: 'write-failed' }; }) };
  const clip = runDecision({ kind: 'clip', id: 'c1', version: V, action: 'approve' }, { actions, recordFile: p.recordFile, claimedLogin: 'owner@example.com' });
  await sleep(40); const stop = runPosting('stop', p); const [a, b] = await Promise.all([clip, stop]);
  assert.equal(a.code, 'write-failed'); assert.equal(b.ok, true);
  const lines = fs.readFileSync(p.recordFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((x) => x.decision), ['approve', 'void', 'stop']); assert.deepEqual(lines.map((x) => x.n), [1, 2, 3]); assert.equal(lines[1].ref, n1);
  assert.deepEqual(readDecisions(p.recordFile).records.map((x) => x.decision), ['stop'], 'the stop is still in the audit list');
});

// ── review fixes: SR4, Start carries the stop the page saw ─────────────────────────────────────────────────────────────
import { stopStatus, engageStop, releaseStop } from './stop.js';
test('SR4: parsePostingBody: start may carry seen (a short single-line string), stop may not; a seen of the wrong type, length or with a control character is refused', () => {
  assert.deepEqual(parsePostingBody('{"action":"start","seen":"stopped by flag since 2026-11-17T09:00:00.000Z"}'), { ok: true, action: 'start', seen: 'stopped by flag since 2026-11-17T09:00:00.000Z' });
  assert.deepEqual(parsePostingBody('{"action":"start"}'), { ok: true, action: 'start' });
  for (const b of ['{"action":"stop","seen":"x"}', '{"action":"start","seen":5}', '{"action":"start","seen":null}', '{"action":"start","seen":""}', `{"action":"start","seen":"${'x'.repeat(301)}"}`, '{"action":"start","seen":"a\\nb"}', '{"action":"start","seen":"a","b":1}']) assert.deepEqual(parsePostingBody(b), { ok: false }, b);
});
test('SR4: Start with the stop the page saw releases it; a stop that changed between the two taps is refused with stop-changed, nothing is recorded and the stop stays', async () => {
  const p = posting(); await runPosting('stop', p); fs.utimesSync(p.stopOpts.flagPath, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
  const seen = stopStatus(p.stopOpts).reason; assert.match(seen, /^stopped by flag since /);
  releaseStop(p.stopOpts); engageStop({ flagPath: p.stopOpts.flagPath }); // WhatsApp: start, then stop again: a new stop with a new time
  const now = stopStatus(p.stopOpts).reason; assert.notEqual(now, seen);
  const before = readDecisions(p.recordFile).records.length;
  const r = await runPosting('start', { ...p, seen }); assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: 'stop-changed' });
  assert.equal(fs.existsSync(p.stopOpts.flagPath), true, 'still stopped'); assert.equal(readDecisions(p.recordFile).records.length, before, 'no record');
  const ok = await runPosting('start', { ...p, seen: now }); assert.equal(ok.ok, true); assert.equal(fs.existsSync(p.stopOpts.flagPath), false);
});
test('SR4: Start whose seen no longer matches but posting is not stopped at all is not refused (nothing to release, nothing to lose)', async () => {
  const p = posting(); const r = await runPosting('start', { ...p, seen: 'stopped by flag since 2020-01-01T00:00:00.000Z' }); assert.equal(r.ok, true);
});

// ── second fix round: Start re-checks the stop after its record call; one lock file; a lost Stop record is logged ─────────
test('SR4b: a Stop that arrives while the Start record waits for the lock is not released: the second comparison refuses with stop-changed, posting stays stopped, the record line is voided', async () => {
  const p = posting(); await runPosting('stop', p); fs.utimesSync(p.stopOpts.flagPath, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
  const seen = stopStatus(p.stopOpts).reason; let release; const held = withDecisionLock(() => new Promise((r) => { release = r; })); await sleep(30);
  let started = false; const run = runPosting('start', { ...p, seen, start: () => { started = true; return {}; } }); await sleep(60);
  releaseStop(p.stopOpts); engageStop({ flagPath: p.stopOpts.flagPath }); // the WhatsApp command (never takes the lock): start, then stop again, a new time
  assert.notEqual(stopStatus(p.stopOpts).reason, seen);
  release(); await held; const r = await run;
  assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: 'stop-changed' }); assert.equal(started, false, 'start() was not called');
  assert.equal(fs.existsSync(p.stopOpts.flagPath), true, 'still stopped');
  const lines = fs.readFileSync(p.recordFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((x) => x.decision), ['stop', 'start', 'void']); assert.equal(lines[2].ref, lines[1].n);
  assert.deepEqual(readDecisions(p.recordFile).records.map((x) => x.decision), ['stop'], 'the start is voided');
});
test('lock file: runPosting takes the lock of the env it is given (the same one the decisions use), not the default one', async () => {
  const p = posting(); const env2 = { ...process.env, BPA_STATE_DIR: path.join(p.d, 'other-state') }; await runPosting('stop', p);
  let release; const held = withDecisionLock(() => new Promise((r) => { release = r; }), { env: env2 }); await sleep(30);
  const busy = await runPosting('start', { ...p, env: env2, lockTimeoutMs: 60 }); assert.deepEqual({ ok: busy.ok, code: busy.code }, { ok: false, code: 'record-failed' }, 'contends for the lock of env2');
  release(); await held;
  const free = await runPosting('start', { ...p, env: env2 }); assert.equal(free.ok, true);
});
test('a Stop whose record cannot be written (lock busy, or the write fails) still stops, and one reason code is logged', async () => {
  const p = posting(); const logs = []; let release; const held = withDecisionLock(() => new Promise((r) => { release = r; })); await sleep(30);
  const a = await runPosting('stop', { ...p, lockTimeoutMs: 60, log: (m) => logs.push(m) }); release(); await held;
  assert.equal(a.ok, true); assert.equal(fs.existsSync(p.stopOpts.flagPath), true); assert.deepEqual(logs, ['review failed: stop-record-failed']);
  const q = posting(); fs.mkdirSync(q.recordFile); const logs2 = [];
  const b = await runPosting('stop', { ...q, log: (m) => logs2.push(m) }); assert.equal(b.ok, true); assert.equal(fs.existsSync(q.stopOpts.flagPath), true); assert.deepEqual(logs2, ['review failed: stop-record-failed']);
  const c = posting(); const logs3 = []; await runPosting('stop', { ...c, log: (m) => logs3.push(m) }); assert.deepEqual(logs3, [], 'nothing logged when the record is written');
});

// ── drafts (step 3) ──────────────────────────────────────────────────────────────────
const SLOT = '2026-11-19T09:00:00+03:00'; const draftBase = (o = {}) => ({ kind: 'draft', id: 'B26', version: V, action: 'approve', slot: SLOT, ...o });
test('draft: approve (with its slot), skip and edit parse; undo is not a draft decision', () => {
  assert.deepEqual(parseDecisionBody(J(draftBase())), { ok: true, req: { kind: 'draft', id: 'B26', version: V, action: 'approve', slot: SLOT } });
  assert.deepEqual(parseDecisionBody(J(draftBase({ action: 'skip', slot: undefined }))), { ok: true, req: { kind: 'draft', id: 'B26', version: V, action: 'skip' } });
  assert.deepEqual(parseDecisionBody(J(draftBase({ action: 'edit', slot: undefined, text: 'New text.' }))), { ok: true, req: { kind: 'draft', id: 'B26', version: V, action: 'edit', text: 'New text.' } });
  assert.deepEqual(parseDecisionBody(J(draftBase({ action: 'undo', slot: undefined }))), { ok: false });
});
test('draft: the slot is required for approve and allowed nowhere else', () => {
  assert.deepEqual(parseDecisionBody(J(draftBase({ slot: undefined }))), { ok: false });
  for (const b of [{ ...base, slot: SLOT }, { kind: 'clip', id: 'c1', version: V, action: 'approve', slot: SLOT }, draftBase({ action: 'skip' }), draftBase({ action: 'edit', text: 'x' })]) assert.deepEqual(parseDecisionBody(J(b)), { ok: false }, J(b).slice(0, 60));
  for (const slot of ['2026-11-19', '2026-11-19T09:00:00Z', '2026-11-19T09:00:00+03:00 ', 5, null, '2026-11-19T09:30:00+03:00']) assert.deepEqual(parseDecisionBody(J(draftBase({ slot }))), { ok: false }, String(slot));
  assert.equal(parseDecisionBody(J(draftBase({ slot: '2026-12-01T09:00:00+03:00' }))).ok, true);
});
test('draft: the id is B and 1 to 6 digits; the edit text is 1 to 2000 (hooks stay at 200); text on an approve is refused', () => {
  for (const id of ['B26', 'B1', 'B123456']) assert.equal(parseDecisionBody(J(draftBase({ id }))).ok, true, id);
  for (const id of ['b26', 'B', 'B1234567', '__proto__', 'B1\n', 'B1 ', 'X1']) assert.deepEqual(parseDecisionBody(J(draftBase({ id }))), { ok: false }, JSON.stringify(id));
  const ed = (text) => J(draftBase({ action: 'edit', slot: undefined, text }));
  assert.equal(parseDecisionBody(ed('x'.repeat(2000))).ok, true); assert.deepEqual(parseDecisionBody(ed('x'.repeat(2001))), { ok: false }); assert.deepEqual(parseDecisionBody(ed('')), { ok: false });
  assert.equal(parseDecisionBody(J({ kind: 'hook', id: 'idea-1', version: V, action: 'edit', text: 'h'.repeat(61) })).ok, true, 'a hook edit of 61 characters still parses at this layer');
  assert.deepEqual(parseDecisionBody(J({ kind: 'hook', id: 'idea-1', version: V, action: 'edit', text: 'h'.repeat(201) })), { ok: false });
  assert.deepEqual(parseDecisionBody(J(draftBase({ text: 'x' }))), { ok: false });
});
