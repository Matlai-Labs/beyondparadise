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

// ── review fixes: SR3, a torn last line, all bytes written, no link followed ───────────────────────────────────────────
import { LOG_PATH } from './lib.js';
const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => l !== '');
test('SR3: a torn (unterminated, unparsable) last line after good records: the next record goes on a fresh line, numbering continues from the last good line, a code is logged, the fragment is kept aside, and the whole file reads back', () => {
  const f = path.join(tmp(), 'd.jsonl'); appendDecision(f, rec()); appendDecision(f, rec({ id: 'h2' }));
  fs.appendFileSync(f, '{"n":3,"kind":"hook","id":"h3","ver'); const was = fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8').length : 0;
  assert.deepEqual(appendDecision(f, rec({ id: 'h4' })), { ok: true, n: 3 });
  assert.deepEqual(lines(f).map((l) => JSON.parse(l).n), [1, 2, 3]); assert.equal(JSON.parse(lines(f)[2]).id, 'h4'); assert.equal(fs.readFileSync(f, 'utf8').endsWith('\n'), true);
  assert.deepEqual(readDecisions(f).records.map((r) => r.id), ['h1', 'h2', 'h4']); assert.equal(mode(f), 0o600);
  assert.equal(fs.readFileSync(`${f}.torn`, 'utf8').trim(), '{"n":3,"kind":"hook","id":"h3","ver'); assert.equal(mode(`${f}.torn`), 0o600);
  const added = fs.readFileSync(LOG_PATH, 'utf8').slice(was).split('\n').filter((l) => l.includes('decision-record-torn')); assert.equal(added.length, 1); assert.match(added[0], /review failed: decision-record-torn$/);
  assert.deepEqual(appendDecision(f, rec({ id: 'h5' })), { ok: true, n: 4 }, 'and the next one after that works as well');
});
test('SR3: a last line that parses but has no newline (the newline was lost): the next record starts on a fresh line and nothing is lost', () => {
  const f = path.join(tmp(), 'd.jsonl'); appendDecision(f, rec()); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').trimEnd(), { mode: 0o600 });
  assert.deepEqual(appendDecision(f, rec({ id: 'h2' })), { ok: true, n: 2 }); assert.deepEqual(lines(f).map((l) => JSON.parse(l).id), ['h1', 'h2']); assert.equal(fs.existsSync(`${f}.torn`), false);
});
test('SR3: a damaged line in the MIDDLE still fails closed when the last line is also unusable, and a file that holds nothing but one terminated garbage line stays refused (bytes unchanged)', () => {
  const f = path.join(tmp(), 'd.jsonl'); fs.writeFileSync(f, '{"n":1,"kind":"hook"\n{broken\n{"torn', { mode: 0o600 }); const before = fs.readFileSync(f);
  assert.deepEqual(appendDecision(f, rec()), { ok: false, reason: 'record-failed' }); assert.deepEqual(fs.readFileSync(f), before);
  const g = path.join(tmp(), 'g.jsonl'); fs.writeFileSync(g, '{broken\n', { mode: 0o600 }); assert.deepEqual(appendDecision(g, rec()), { ok: false, reason: 'record-failed' });
});
test('SR3: writeSync is looped until every byte is written (a write that takes 5 bytes at a time still writes the whole line)', () => {
  const real = fs.writeSync; const f = path.join(tmp(), 'd.jsonl'); let calls = 0;
  fs.writeSync = (fd, buf, ...rest) => { calls += 1; if (typeof buf === 'string') return real(fd, buf.slice(0, 5)) ; const off = rest[0] ?? 0; const len = rest[1] ?? buf.length - off; return real(fd, buf, off, Math.min(5, len)); };
  try { assert.deepEqual(appendDecision(f, rec()), { ok: true, n: 1 }); } finally { fs.writeSync = real; }
  assert.ok(calls > 5, `${calls} writes`); const l = lines(f); assert.equal(l.length, 1); assert.equal(JSON.parse(l[0]).n, 1);
});
test('SR3: the file is opened with O_NOFOLLOW: a symbolic link in the file place is refused and its target is not written', () => {
  const d = tmp(); const target = path.join(d, 'target.jsonl'); fs.writeFileSync(target, '', { mode: 0o600 }); const f = path.join(d, 'link.jsonl'); fs.symlinkSync(target, f);
  assert.deepEqual(appendDecision(f, rec()), { ok: false, reason: 'record-failed' }); assert.equal(fs.readFileSync(target, 'utf8'), '');
  assert.ok(/O_NOFOLLOW/.test(fs.readFileSync(new URL('./review-decisions.js', import.meta.url), 'utf8')), 'the flag is in the code');
});

test('record kind draft: approve, skip, edit and void are accepted; kind drafts is still refused', () => {
  const f = path.join(tmp(), 'd.jsonl');
  for (const decision of ['approve', 'skip', 'edit', 'void']) assert.equal(appendDecision(f, rec({ kind: 'draft', id: 'B1', version: 'v', decision })).ok, true, decision);
  assert.equal(appendDecision(f, rec({ kind: 'drafts' })).ok, false);
});
