import './test-env.js';
// The ONE test that builds the real default actions (the real schedulePost behind the page's Approve) against the closed doors of test-env.js.
// It doubles as the deployed-shape proof: the real wiring, no stub, and nothing can leave the process because the Meta publisher module is not there.
import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createDefaultActions } from './review-routes.js';
import { runDecision } from './review-decide.js';
import { QUEUE_PATH, nextSlots } from './lib.js';
import { stateDir } from './stop.js';
import { draftVersion } from './draft-version.js';
import { approveSwitchPath } from './approve-switch.js';

// FIRST, before anything else: the three doors must be closed, and the state folder must be a temporary one.
function must() {
  for (const name of ['META_PUBLISH_PATH', 'META_TOKENS_PATH', 'WHATSAPP_ALERT_TO_FILE']) { const v = process.env[name]; assert.equal(typeof v, 'string', `${name} must be a string`); assert.ok(v.length > 0, `${name} must not be empty`); assert.equal(fs.existsSync(v), false, `${name} must not exist`); }
  const qp = process.env.BPA_QUEUE_PATH; assert.ok(typeof qp === 'string' && qp.length > 0, 'BPA_QUEUE_PATH must be a non-empty string'); assert.equal(QUEUE_PATH, qp);
  assert.equal(process.env.WHATSAPP_ALERT_TO, '');
  const sd = path.resolve(stateDir(process.env)); assert.ok(sd.startsWith(path.resolve(os.tmpdir()) + path.sep), `the state folder must be under the temp folder: ${sd}`); assert.ok(!sd.includes('.matlai'), 'never the owner state folder');
}
const draft = () => ({ id: 'B1', status: 'pending_approval', kind: 'outlook', text: 'Lions sleep most of the day on the plains.', createdAt: new Date().toISOString() });
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);

test('the real wiring: Approve reaches the real schedulePost, which cannot find the publisher module: schedule-failed, the draft is marked, a second Approve is check-meta; without the switch file it is cannot-decide', async () => {
  must();
  fs.writeFileSync(QUEUE_PATH, JSON.stringify({ seq: 1, drafts: [draft()] })); const recordFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-rw-')), 'rec.jsonl');
  const sw = approveSwitchPath(process.env); must(); fs.mkdirSync(path.dirname(sw), { recursive: true, mode: 0o700 }); fs.writeFileSync(sw, '', { mode: 0o600 }); fs.chmodSync(sw, 0o600);
  const actions = createDefaultActions(process.env); const q = () => JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
  const req = () => ({ kind: 'draft', id: 'B1', version: draftVersion(q().drafts[0]), action: 'approve', slot: nextSlots(q(), 1, new Date())[0] });
  const first = await runDecision(req(), { actions, recordFile, claimedLogin: 'owner@example.com' }); assert.deepEqual(first, { ok: false, code: 'schedule-failed' });
  assert.ok(q().drafts[0].metaUnknown, 'marked: the outcome is unknown'); assert.equal(q().drafts[0].status, 'pending_approval'); assert.equal(lines(recordFile).length, 1);
  const second = await runDecision(req(), { actions, recordFile, claimedLogin: 'owner@example.com' }); assert.deepEqual(second, { ok: false, code: 'check-meta' });
  fs.unlinkSync(sw); const before = lines(recordFile).length; fs.writeFileSync(QUEUE_PATH, JSON.stringify({ seq: 1, drafts: [draft()] }));
  const off = await runDecision(req(), { actions, recordFile, claimedLogin: 'owner@example.com' }); assert.deepEqual(off, { ok: false, code: 'cannot-decide' }); assert.equal(lines(recordFile).length, before);
});
