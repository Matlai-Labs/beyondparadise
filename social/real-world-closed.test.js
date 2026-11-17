import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import { execFileSync } from 'node:child_process';
import { QUEUE_PATH, schedulePost, publishNow, igPublish, alertNumber, whatsapp } from './lib.js';
import { StoppedError } from './stop.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Run at the start of EVERY test, before any call: an unset variable must fail here, not reach a real function.
function must() {
  for (const name of ['META_PUBLISH_PATH', 'META_TOKENS_PATH', 'WHATSAPP_ALERT_TO_FILE']) {
    const v = process.env[name]; assert.equal(typeof v, 'string', `${name} must be a string`); assert.ok(v.length > 0, `${name} must not be empty`); assert.equal(fs.existsSync(v), false, `${name} must not exist`);
  }
  const q = process.env.BPA_QUEUE_PATH; assert.ok(typeof q === 'string' && q.length > 0, 'BPA_QUEUE_PATH must be a non-empty string');
  assert.equal(QUEUE_PATH, q, 'QUEUE_PATH follows BPA_QUEUE_PATH'); assert.ok(path.relative(HERE, QUEUE_PATH).startsWith('..'), 'the queue is outside social/');
  assert.equal(process.env.WHATSAPP_ALERT_TO, '', 'no alert number in the environment');
}

test('QUEUE_PATH follows BPA_QUEUE_PATH in a child process, and defaults to social/queue.json without it', () => {
  const run = (env) => execFileSync(process.execPath, ['--input-type=module', '-e', "import('./lib.js').then((m) => console.log(m.QUEUE_PATH))"], { cwd: HERE, env, encoding: 'utf8' }).trim();
  const base = { ...process.env }; delete base.BPA_QUEUE_PATH;
  assert.equal(run({ ...base, BPA_QUEUE_PATH: '/tmp/example-queue.json' }), '/tmp/example-queue.json');
  assert.ok(run(base).endsWith(path.join('social', 'queue.json')));
});
test('the publishers cannot reach Meta: the publisher module is not there', async () => {
  must();
  await assert.rejects(schedulePost('x', '2026-11-19T09:00:00+03:00'), /cannot find the meta-pages publish module/);
  await assert.rejects(publishNow('x'), /cannot find the meta-pages publish module/);
  await assert.rejects(igPublish('c', 'https://example.invalid/x.jpg'), /cannot find the meta-pages publish module/);
});
test('no alert number: whatsapp sends nothing and logs why', async () => {
  must(); assert.equal(alertNumber(), null);
  assert.equal(await whatsapp('x'), false); assert.match(fs.readFileSync(process.env.BPA_LOG_PATH, 'utf8'), /whatsapp skipped: no alert number/);
});
test('with the stop flag engaged the publishers reject with StoppedError', async () => {
  must(); const flag = process.env.BPA_STOP_FLAG; fs.mkdirSync(path.dirname(flag), { recursive: true }); fs.writeFileSync(flag, 'x');
  try { for (const call of [() => schedulePost('x', '2026-11-19T09:00:00+03:00'), () => publishNow('x'), () => igPublish('c', 'https://example.invalid/x.jpg')]) await assert.rejects(Promise.resolve().then(call), (e) => e instanceof StoppedError); }
  finally { fs.unlinkSync(flag); }
});
test('static: a child process in any test keeps the environment (the closed doors travel with it)', () => {
  const bad = [];
  for (const f of fs.readdirSync(HERE).filter((n) => n.endsWith('.test.js') && n !== 'real-world-closed.test.js')) {
    const src = fs.readFileSync(path.join(HERE, f), 'utf8');
    for (const m of src.matchAll(/\b(execFile|execFileSync|spawn|spawnSync|exec|execSync|fork)\(/g)) {
      const call = src.slice(m.index, m.index + 600).split(/\n\s*\n/)[0]; const env = call.match(/\benv:\s*([^\n]{0,120})/);
      if (env && !/\.\.\.process\.env/.test(env[1])) bad.push(`${f}: ${m[0]} ${env[0].slice(0, 80)}`);
    }
  }
  assert.deepEqual(bad, [], `child processes with an environment that drops process.env:\n${bad.join('\n')}`);
});
