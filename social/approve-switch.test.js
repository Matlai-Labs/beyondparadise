import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { approveSwitchPath, approveSwitchOn } from './approve-switch.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-sw-'));
const envOf = (dir) => ({ ...process.env, BPA_STATE_DIR: dir });

test('the switch is a file in the state folder; absent is off', () => {
  const d = tmp(); const env = envOf(d); assert.equal(approveSwitchPath(env), path.join(d, 'bpa-page-approve-on')); assert.equal(approveSwitchOn(env), false);
});
test('a regular file with mode 600 is on; deleting it is off again on the next call (no cache)', () => {
  const d = tmp(); const env = envOf(d); const f = approveSwitchPath(env); fs.writeFileSync(f, '', { mode: 0o600 }); fs.chmodSync(f, 0o600);
  assert.equal(approveSwitchOn(env), true); fs.unlinkSync(f); assert.equal(approveSwitchOn(env), false);
});
test('readable by others (644, 640, 604) is off, a link to a good file is off, a folder is off', () => {
  const d = tmp(); const env = envOf(d); const f = approveSwitchPath(env);
  for (const mode of [0o644, 0o640, 0o604]) { fs.writeFileSync(f, ''); fs.chmodSync(f, mode); assert.equal(approveSwitchOn(env), false, mode.toString(8)); fs.unlinkSync(f); }
  const real = path.join(d, 'real'); fs.writeFileSync(real, '', { mode: 0o600 }); fs.chmodSync(real, 0o600); fs.symlinkSync(real, f); assert.equal(approveSwitchOn(env), false, 'link'); fs.unlinkSync(f);
  fs.mkdirSync(f, { mode: 0o700 }); assert.equal(approveSwitchOn(env), false, 'folder');
});
const sources = () => fs.readdirSync(HERE).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).map((f) => [f, fs.readFileSync(path.join(HERE, f), 'utf8').replace(/^\s*\/\/.*$/gm, '')]);
test('static: nothing writes the switch file; approve-on appears only in approve-switch.js, which only reads it with lstatSync', () => {
  for (const [f, s] of sources()) { if (f !== 'approve-switch.js') assert.ok(!s.includes('approve-on'), `${f} must not name the switch file`); }
  const own = sources().find(([f]) => f === 'approve-switch.js')[1];
  for (const w of ['writeFile', 'writeFileSync', 'openSync', 'open(', 'mkdir', 'rename', 'copyFile', 'symlink', 'appendFile', 'createWriteStream', 'unlink', 'chmod']) assert.ok(!own.includes(w), w);
  assert.match(own, /lstatSync/); assert.ok(!/[^l]statSync/.test(own), 'statSync would follow a link');
});
test('static: draft-decisions.js never calls approveSwitchOn (it receives approveOn as a parameter); the count of calls is pinned in review-step3-guards.test.js', () => {
  assert.ok(!sources().find(([f]) => f === 'draft-decisions.js')[1].includes('approveSwitchOn'));
});
