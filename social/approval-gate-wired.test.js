import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs';
const s = fs.readFileSync(new URL('./approval-server.js', import.meta.url), 'utf8');
test('approval-server calls claimGate once, inside the approve/postnow branch before any publish', () => {
  assert.equal((s.match(/claimGate\(d\)/g) || []).length, 1);
  assert.ok(s.indexOf('claimGate(d)') < s.indexOf('schedule(d.text'));
  assert.ok(s.indexOf('claimGate(d)') < s.indexOf('publish(d.text'));
});
test('the edit (applyEdit in draft-actions.js) clears claimSources, the hash and the record time', () => {
  const da = fs.readFileSync(new URL('./draft-actions.js', import.meta.url), 'utf8');
  const edit = da.split('export function applyEdit')[1].split('export async function editDraft')[0];
  for (const k of ['claimSources', 'claimSourcesHash', 'claimSourcesAt']) assert.match(edit, new RegExp(`delete d\\.${k}\\b`));
  assert.ok(edit.indexOf('delete d.claimSourcesHash') < edit.indexOf('d.text = text') + 400);
  assert.match(s, /editDraft\(d, c\.text/, 'the WhatsApp edit goes through editDraft');
});
