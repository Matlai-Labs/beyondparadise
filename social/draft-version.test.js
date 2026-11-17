import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { draftVersion, readQueueStrict, draftExpiresAt, DRAFT_REASONS } from './draft-version.js';
const base = () => ({ id: 'B1', text: 'Lions sleep.', videoText: 'Lions', slides: [{ text: 'a' }], readyFileSha256: 'ab'.repeat(32), claimSourcesHash: 'cd'.repeat(32), claimSources: [{ claim: 'c', source: 's', url: 'https://a.example/x', line: 'l' }], status: 'pending_approval' });
test('draftVersion: 64 hex; stable under key order and under fields that are not content', () => {
  const v = draftVersion(base()); assert.match(v, /^[0-9a-f]{64}$/);
  const { id, ...rest } = base(); assert.equal(draftVersion({ ...rest, id }), v);
  for (const over of [{ status: 'skipped' }, { decidedAt: 'x' }, { ig: { status: 'queued' } }, { lastError: 'boom' }, { scheduledFor: 'x' }, { score: 3 }, { hookAdvice: 'h' }]) assert.equal(draftVersion({ ...base(), ...over }), v, JSON.stringify(over));
});
test('draftVersion: changes with everything the owner sees or that goes out', () => {
  const v = draftVersion(base()); const seen = new Set([v]);
  const edits = [{ text: 'Lions nap.' }, { videoText: 'Cats' }, { slides: [{ text: 'b' }] }, { readyFileSha256: 'ef'.repeat(32) }, { claimSourcesHash: '00'.repeat(32) }, { claimSources: [{ claim: 'c', source: 's', url: 'https://a.example/x', line: 'other line' }] }, { id: 'B2' }];
  for (const e of edits) { const w = draftVersion({ ...base(), ...e }); assert.notEqual(w, v, JSON.stringify(e)); seen.add(w); } assert.equal(seen.size, edits.length + 1);
  assert.match(draftVersion({ id: 'B1', text: 'x', claimSources: 'nope' }), /^[0-9a-f]{64}$/);
});
test('readQueueStrict: only a valid queue is ok; nothing is ever repaired or written', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-dv-')); const f = path.join(d, 'q.json');
  fs.writeFileSync(f, '{"seq":1,"drafts":[]}'); assert.deepEqual(readQueueStrict(f), { ok: true, q: { seq: 1, drafts: [] } });
  assert.deepEqual(readQueueStrict(path.join(d, 'missing.json')), { ok: false, code: 'queue-unreadable' }); assert.ok(!fs.existsSync(path.join(d, 'missing.json')));
  for (const bad of ['{broken', '{"drafts":5}', '[]', 'null', '']) { fs.writeFileSync(f, bad); assert.deepEqual(readQueueStrict(f), { ok: false, code: 'queue-unreadable' }, bad); assert.equal(fs.readFileSync(f, 'utf8'), bad, 'bytes unchanged'); }
});
test('draftExpiresAt: createdAt plus the days, or null', () => {
  assert.equal(draftExpiresAt({ createdAt: '2026-11-10T00:00:00Z' }, 7), Date.parse('2026-11-17T00:00:00Z'));
  for (const d of [{}, { createdAt: 'nope' }, { createdAt: undefined }, null]) assert.equal(draftExpiresAt(d, 7), null);
});
test('DRAFT_REASONS is frozen and holds the agreed words', () => { assert.ok(Object.isFrozen(DRAFT_REASONS)); assert.equal(DRAFT_REASONS.length, 15); for (const w of ['stopped', 'check-meta', 'approve-off', 'ready-file-changed', 'sources-old']) assert.ok(DRAFT_REASONS.includes(w)); });
