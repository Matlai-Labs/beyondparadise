import { test } from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs';
test('approval-server calls claimGate once, inside the approve/postnow branch before any publish', () => {
  const s = fs.readFileSync(new URL('./approval-server.js', import.meta.url), 'utf8');
  assert.equal((s.match(/claimGate\(d\)/g) || []).length, 1);
  assert.ok(s.indexOf('claimGate(d)') < s.indexOf('schedulePost(d.text'));
  assert.ok(s.indexOf('claimGate(d)') < s.indexOf('publishNow(d.text'));
});
