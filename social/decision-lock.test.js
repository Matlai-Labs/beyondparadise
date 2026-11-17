import './test-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withDecisionLock, decisionLockPath } from './decision-lock.js';

const tmpEnv = () => ({ ...process.env, BPA_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-lock-')) });

test('decisionLockPath sits in the state folder', () => {
  const env = tmpEnv(); assert.equal(decisionLockPath(env), path.join(env.BPA_STATE_DIR, 'bpa-decisions.lock'));
});
test('the lane file lock: 20 concurrent read-modify-write cycles lose nothing', async () => {
  const env = tmpEnv(); const f = path.join(env.BPA_STATE_DIR, 'counter'); fs.writeFileSync(f, '0');
  await Promise.all(Array.from({ length: 20 }, () => withDecisionLock(async () => {
    const n = Number(fs.readFileSync(f, 'utf8')); await new Promise((r) => setTimeout(r, 2)); fs.writeFileSync(f, String(n + 1));
  }, { env })));
  assert.equal(fs.readFileSync(f, 'utf8'), '20'); assert.equal(fs.existsSync(decisionLockPath(env)), false, 'lock released');
});
test('a held lock times out with code lock-busy', async () => {
  const env = tmpEnv(); let release; const held = new Promise((r) => { release = r; }); let entered; const inside = new Promise((r) => { entered = r; });
  const first = withDecisionLock(async () => { entered(); await held; }, { env });
  await inside;
  await assert.rejects(withDecisionLock(async () => 1, { env, timeoutMs: 50 }), (e) => e.code === 'lock-busy' && e.message === 'lock-busy');
  release(); await first;
});
test('the function result and a thrown error pass through, the lock is released either way', async () => {
  const env = tmpEnv(); assert.equal(await withDecisionLock(async () => 7, { env }), 7);
  await assert.rejects(withDecisionLock(async () => { throw new Error('boom'); }, { env }), /boom/);
  assert.equal(fs.existsSync(decisionLockPath(env)), false);
});
