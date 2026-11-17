import './test-env.js';
// The decision record: append only, private, no text, claimed login.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendDecision, readDecisions, decisionsFilePath } from './review-decisions.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-decrec-'));
const rec = (o = {}) => ({ kind: 'hook', id: 'h1', version: 'v1', decision: 'approve', claimedLogin: 'owner@example.com', at: '2026-11-17T09:00:00Z', ...o });
const mode = (f) => fs.statSync(f).mode & 0o777;

test('default path is inside the state folder', () => {
  assert.equal(path.basename(decisionsFilePath()), 'bpa-review-decisions.jsonl');
  assert.equal(path.dirname(decisionsFilePath()), process.env.BPA_STATE_DIR);
});

test('append writes lines n 1 and 2, mode 600, and reads them back', () => {
  const f = path.join(tmp(), 'd.jsonl');
  assert.deepEqual(appendDecision(f, rec()), { ok: true, n: 1 });
  assert.deepEqual(appendDecision(f, rec({ id: 'h2', decision: 'skip' })), { ok: true, n: 2 });
  assert.equal(mode(f), 0o600);
  const r = readDecisions(f);
  assert.equal(r.ok, true);
  assert.deepEqual(r.records.map((x) => [x.n, x.id, x.decision]), [[1, 'h1', 'approve'], [2, 'h2', 'skip']]);
});

test('a void line removes its target in readDecisions', () => {
  const f = path.join(tmp(), 'd.jsonl');
  appendDecision(f, rec()); appendDecision(f, rec({ id: 'h2' }));
  assert.equal(appendDecision(f, rec({ id: 'h1', decision: 'void', ref: 1 })).ok, true);
  const r = readDecisions(f);
  assert.deepEqual(r.records.map((x) => x.id), ['h2']);
});

test('sinceMs keeps only records inside the window', () => {
  const f = path.join(tmp(), 'd.jsonl'); const now = Date.parse('2026-11-17T12:00:00Z');
  appendDecision(f, rec({ id: 'old', at: '2026-10-01T00:00:00Z' }));
  appendDecision(f, rec({ id: 'new', at: '2026-11-17T09:00:00Z' }));
  assert.deepEqual(readDecisions(f, { sinceMs: 30 * 86400000, nowMs: now }).records.map((x) => x.id), ['new']);
  assert.equal(readDecisions(f).records.length, 2);
});

test('a missing file reads as empty', () => {
  assert.deepEqual(readDecisions(path.join(tmp(), 'none.jsonl')), { ok: true, records: [] });
});

test('a folder in the file place gives record-failed', () => {
  const f = path.join(tmp(), 'd.jsonl'); fs.mkdirSync(f);
  assert.deepEqual(appendDecision(f, rec()), { ok: false, reason: 'record-failed' });
});

test('a mode 644 file gives record-failed and its bytes stay', () => {
  const f = path.join(tmp(), 'd.jsonl'); fs.writeFileSync(f, '', { mode: 0o600 });
  appendDecision(f, rec()); fs.chmodSync(f, 0o644);
  const before = fs.readFileSync(f);
  assert.deepEqual(appendDecision(f, rec({ id: 'h2' })), { ok: false, reason: 'record-failed' });
  assert.deepEqual(fs.readFileSync(f), before);
});

test('an unreadable last line is refused and bytes stay', () => {
  const f = path.join(tmp(), 'd.jsonl'); fs.writeFileSync(f, '{broken\n', { mode: 0o600 });
  const before = fs.readFileSync(f);
  assert.deepEqual(appendDecision(f, rec()), { ok: false, reason: 'record-failed' });
  assert.deepEqual(fs.readFileSync(f), before);
});

test('keys outside the whitelist (text, login) give record-failed and nothing is written', () => {
  const f = path.join(tmp(), 'd.jsonl');
  for (const extra of [{ text: 'hello' }, { login: 'owner@example.com' }, { n: 5 }, { caption: 'x' }]) {
    assert.deepEqual(appendDecision(f, { ...rec(), ...extra }), { ok: false, reason: 'record-failed' });
  }
  assert.equal(fs.existsSync(f), false);
});

test('bad shapes are refused', () => {
  const f = path.join(tmp(), 'd.jsonl');
  for (const bad of [rec({ kind: 'other' }), rec({ decision: 'maybe' }), rec({ id: 5 }), rec({ claimedLogin: '' }), rec({ at: 'nope' }), rec({ version: 7 }), null, 'x']) {
    assert.equal(appendDecision(f, bad).ok, false);
  }
  assert.equal(fs.existsSync(f), false);
});

test('200 sequential appends read back in order', () => {
  const f = path.join(tmp(), 'd.jsonl');
  for (let i = 1; i <= 200; i++) assert.equal(appendDecision(f, rec({ id: `h${i}` })).n, i);
  assert.deepEqual(readDecisions(f).records.map((x) => x.n), Array.from({ length: 200 }, (_, i) => i + 1));
});

test('the file holds claimedLogin, never the key login, never text', () => {
  const f = path.join(tmp(), 'd.jsonl');
  appendDecision(f, rec({ decision: 'edit' }));
  appendDecision(f, { ...rec(), text: 'secret words' });
  const s = fs.readFileSync(f, 'utf8');
  assert.match(s, /"claimedLogin"/);
  assert.doesNotMatch(s, /"login"/);
  assert.doesNotMatch(s, /text/);
  assert.doesNotMatch(s, /secret words/);
});

test('an id __proto__ is stored and read back as an ordinary string', () => {
  const f = path.join(tmp(), 'd.jsonl');
  assert.equal(appendDecision(f, rec({ id: '__proto__' })).ok, true);
  const r = readDecisions(f).records[0];
  assert.equal(r.id, '__proto__'); assert.equal(Object.getPrototypeOf(r), Object.prototype);
});

test('a null version is allowed (posting records)', () => {
  const f = path.join(tmp(), 'd.jsonl');
  assert.equal(appendDecision(f, rec({ kind: 'posting', id: 'posting', version: null, decision: 'stop' })).ok, true);
});
