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
