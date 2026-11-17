import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { plainTime, localParts } from './plain-time.js';
import { scheduledAtMetaNote } from './bpa-actions.js';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

test('plainTime: the sample moment in East Africa time', () => {
  assert.equal(plainTime('2026-11-17T21:06:42.521Z', 'Africa/Dar_es_Salaam'), '18 Nov at 00:06 (East Africa time)');
  assert.equal(plainTime(Date.parse('2026-11-17T21:06:42.521Z'), 'Africa/Dar_es_Salaam'), '18 Nov at 00:06 (East Africa time)');
});
test('plainTime: midnight rollover and the minute before the hour', () => {
  assert.equal(plainTime('2026-11-17T21:00:00Z', 'Africa/Dar_es_Salaam'), '18 Nov at 00:00 (East Africa time)');
  assert.match(plainTime('2026-11-18T08:59:59Z', 'Africa/Dar_es_Salaam'), /^18 Nov at 11:59 /);
});
test('plainTime: another zone names itself; garbage gives null', () => {
  const t = plainTime('2026-11-17T21:06:42.521Z', 'Europe/Amsterdam'); assert.match(t, /^17 Nov at 22:06 \(.+\)$/); assert.ok(!t.includes('East Africa'));
  for (const bad of ['nonsense', '', null, undefined, {}, NaN]) assert.equal(plainTime(bad), null, String(bad));
});
test('localParts gives day, month, hour, minute', () => {
  const p = localParts(Date.parse('2026-11-17T21:06:42.521Z'), 'Africa/Dar_es_Salaam'); assert.deepEqual({ day: p.day, month: p.month, hour: p.hour, minute: p.minute }, { day: '18', month: 'Nov', hour: '00', minute: '06' });
});
test('the Meta note text is unchanged by the shared formatter', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bpapt-')), 'queue.json');
  fs.writeFileSync(f, JSON.stringify({ drafts: [{ id: 'B1', status: 'scheduled', scheduledFor: '2026-11-18T09:00:00+03:00' }] }));
  assert.equal(scheduledAtMetaNote(f, new Date('2026-11-17T00:00:00Z'), 'Africa/Dar_es_Salaam'), '1 Facebook post is already scheduled at Meta for 18 Nov 09:00 and will still go out; cancel it in Meta if needed.');
});
