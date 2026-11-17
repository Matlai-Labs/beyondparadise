import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { handle } from './approval-server.js'; import { saveQueue } from './lib.js';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-pin-'));
const kit = (drafts = []) => { const d = tmp(); const queuePath = path.join(d, 'q.json'); saveQueue({ seq: 1, drafts }, queuePath); return { queuePath, stopOpts: { flagPath: path.join(d, 'f', 'stop'), fleetPath: path.join(d, 'fleet.flag') }, now: new Date('2026-11-17T09:00:00Z'), d }; };
test('pin: stop, stop again, start, start again (exact texts)', async () => {
  const k = kit();
  assert.equal(await handle('bpa stop', k), '🛑 Stopped. Nothing new will be published, scheduled or drafted until you reply *bpa start*.');
  assert.match(await handle('bpa stop', k), /^🛑 already stopped since 20\d\d-\d\d-\d\dT[\d:.]+Z\. Reply \*bpa start\* to resume\.$/);
  assert.equal(await handle('bpa start', k), '▶️ started. Publishing, scheduling and drafting are allowed again.');
  assert.equal(await handle('bpa start', k), 'ℹ️ it was not stopped.'); });
test('pin: start while the fleet-wide flag holds', async () => { const k = kit(); fs.writeFileSync(k.stopOpts.fleetPath, 'x'); await handle('bpa stop', k);
  assert.match(await handle('bpa start', k), /^▶️ bpa flag removed, but still stopped by fleet stop-all flag since 20\d\d-\d\d-\d\dT[\d:.]+Z\.$/); });
test('pin: stop names the posts scheduled at Meta (one, two) and a damaged queue adds nothing', async () => {
  const one = kit([{ id: 'B1', status: 'scheduled', scheduledFor: '2026-11-18T09:00:00+03:00' }]);
  assert.equal(await handle('bpa stop', one), '🛑 Stopped. Nothing new will be published, scheduled or drafted until you reply *bpa start*. 1 Facebook post is already scheduled at Meta for 18 Nov 09:00 and will still go out; cancel it in Meta if needed.');
  const two = kit([{ id: 'B1', status: 'scheduled', scheduledFor: '2026-11-19T09:00:00+03:00' }, { id: 'B2', status: 'scheduled', scheduledFor: '2026-11-18T09:00:00+03:00' }]);
  assert.ok((await handle('bpa stop', two)).endsWith('2 Facebook posts are already scheduled at Meta, the next for 18 Nov 09:00, and will still go out; cancel them in Meta if needed.'));
  const bad = kit(); fs.writeFileSync(bad.queuePath, '{broken'); assert.equal(await handle('bpa stop', bad), '🛑 Stopped. Nothing new will be published, scheduled or drafted until you reply *bpa start*.'); });
