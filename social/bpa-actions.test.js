import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { stopPosting, startPosting, scheduledAtMetaNote } from './bpa-actions.js';
import { handle, scheduledAtMetaNote as reExported } from './approval-server.js'; import { saveQueue } from './lib.js';
const kit = (drafts = []) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-act-')); const queuePath = path.join(d, 'q.json'); saveQueue({ seq: 1, drafts }, queuePath); return { queuePath, stopOpts: { flagPath: path.join(d, 'f', 'stop'), fleetPath: path.join(d, 'fleet.flag') }, now: new Date('2026-11-17T09:00:00Z') }; };
const mask = (t) => t.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/, 'T');
const kits = [
  [], [{ id: 'B1', status: 'scheduled', scheduledFor: '2026-11-18T09:00:00+03:00' }],
  [{ id: 'B1', status: 'scheduled', scheduledFor: '2026-11-19T09:00:00+03:00' }, { id: 'B2', status: 'scheduled', scheduledFor: '2026-11-18T09:00:00+03:00' }],
];
test('stopPosting reply equals the WhatsApp stop reply, note separate', async () => {
  for (const drafts of kits) {
    const a = kit(drafts), b = kit(drafts);
    const r = stopPosting(a);
    assert.equal(mask(r.reply), mask(await handle('bpa stop', b)));
    assert.equal(r.note, scheduledAtMetaNote(b.queuePath, b.now));
    if (r.note) assert.ok(r.reply.endsWith(' ' + r.note)); else assert.ok(!r.reply.endsWith(' '));
    assert.equal(mask(stopPosting(a).reply), mask(await handle('bpa stop', b)));
  } });
test('startPosting reply equals the WhatsApp start reply (also with the fleet flag)', async () => {
  const a = kit(), b = kit();
  assert.equal(mask(startPosting(a).reply), mask(await handle('bpa start', b)));
  stopPosting(a); await handle('bpa stop', b);
  assert.equal(mask(startPosting(a).reply), mask(await handle('bpa start', b)));
  const c = kit(), d = kit(); for (const k of [c, d]) fs.writeFileSync(k.stopOpts.fleetPath, 'x');
  stopPosting(c); await handle('bpa stop', d);
  assert.equal(mask(startPosting(c).reply), mask(await handle('bpa start', d))); });
test('scheduledAtMetaNote is the same function approval-server re-exports', () => { assert.equal(scheduledAtMetaNote, reExported); });
