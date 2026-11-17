import './test-env.js';
// The one guarded caller for the local Ollama model (local-model.js). No network, no model: fetch is always a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { askLocal, assertLocalOllama, reserveCall, GuardError, EmptyAnswerError, DEFAULT_MAX_CALLS, DEFAULT_DAILY_CAP, DEFAULT_TIMEOUT_MS, DEFAULT_KEEP_ALIVE, defaultCounterFile } from './local-model.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-lm-'));
const reply = (content, extra = {}) => ({ ok: true, status: 200, json: async () => ({ message: { content, ...extra } }) });
function fixture(over = {}) {
  const dir = tmp(); const calls = [];
  const fetchImpl = over.fetchImpl || (async (url, init) => { calls.push({ url, init }); return reply(over.content ?? '{"ok":true}'); });
  const deps = { fetchImpl, counterFile: path.join(dir, 'counter.json'), stopOpts: { flagPath: path.join(dir, 'stop'), fleetPath: path.join(dir, 'fleet') }, run: { calls: 0 }, ...over.deps };
  return { dir, calls, deps };
}
const base = { model: 'qwen3:8b', prompt: 'hi' };

test('defaults: 120 calls per run, 1500 per day, 120 s per call, keep_alive 2m; the counter file is the shared segments one', () => {
  assert.equal(DEFAULT_MAX_CALLS, 120); assert.equal(DEFAULT_DAILY_CAP, 1500); assert.equal(DEFAULT_TIMEOUT_MS, 120_000); assert.equal(DEFAULT_KEEP_ALIVE, '2m');
  assert.equal(path.basename(defaultCounterFile({})), 'bpa-segments-calls.json');
  assert.equal(defaultCounterFile({ BPA_SEGMENTS_COUNTER: '/x/y.json' }), '/x/y.json');
});

test('host guard: only http://127.0.0.1:11434 and http://localhost:11434 pass', () => {
  assert.equal(assertLocalOllama('http://127.0.0.1:11434'), '127.0.0.1');
  assert.equal(assertLocalOllama('http://localhost:11434'), 'localhost');
  for (const bad of ['http://example.com:11434', 'http://127.0.0.1:8080', 'http://127.0.0.1', 'https://127.0.0.1:11434', 'http://127.0.0.1.evil.example:11434', 'http://0.0.0.0:11434',
    'http://[::1]:11434', 'http://192.168.1.5:11434', 'http://user:pw@127.0.0.1:11434', 'http://localhost.evil.example:11434', 'not a url', '', undefined, null, 'http://127.0.0.1:11434@evil.example']) {
    assert.throws(() => assertLocalOllama(bad), GuardError, String(bad));
  }
});

test('askLocal never sends a request to a host that is not local (fetch is not even called)', async () => {
  for (const baseUrl of ['http://example.com:11434', 'https://api.example.com', 'http://10.0.0.2:11434', 'http://127.0.0.1:9999']) {
    const { calls, deps } = fixture({ deps: { baseUrl } });
    await assert.rejects(askLocal(base, deps), GuardError);
    assert.equal(calls.length, 0, baseUrl);
    assert.equal(fs.existsSync(deps.counterFile), false, 'a refused host must not use up the budget');
  }
});

test('the only request goes to http://127.0.0.1:11434/api/chat, no redirects, with a timeout signal', async () => {
  const { calls, deps } = fixture();
  await askLocal(base, deps);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.redirect, 'error'); assert.ok(calls[0].init.signal instanceof AbortSignal);
  const src = fs.readFileSync(path.join(HERE, 'local-model.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.equal((src.match(/fetchImpl\(/g) || []).length, 1, 'exactly one place sends a request');
});

test('request body: model, stream off, short keep_alive, generous num_predict, system + user messages, images, format', async () => {
  const { calls, deps } = fixture();
  await askLocal({ model: 'gpt-oss:20b', prompt: 'P', system: 'S', format: 'json', images: ['QUJD'] }, deps);
  const b = JSON.parse(calls[0].init.body);
  assert.equal(b.model, 'gpt-oss:20b'); assert.equal(b.stream, false); assert.equal(b.keep_alive, '2m'); assert.equal(b.format, 'json');
  assert.ok(b.options.num_predict >= 2048, 'thinking models need room, an empty answer on a small budget is the known failure');
  assert.deepEqual(b.messages[0], { role: 'system', content: 'S' }); assert.deepEqual(b.messages[1], { role: 'user', content: 'P', images: ['QUJD'] });
  const c2 = fixture(); await askLocal({ ...base, keepAlive: 0 }, c2.deps); assert.equal(JSON.parse(c2.calls[0].init.body).keep_alive, 0);
  const c3 = fixture(); await askLocal(base, c3.deps); const b3 = JSON.parse(c3.calls[0].init.body); assert.equal(b3.messages.length, 1); assert.equal('format' in b3, false); assert.equal('images' in b3.messages[0], false);
});

test('an empty answer is a failure, not text (also whitespace, and a reply with thinking but no content)', async () => {
  for (const r of [reply(''), reply('  \n '), reply('', { thinking: 'long reasoning' }), { ok: true, status: 200, json: async () => ({ message: {} }) }, { ok: true, status: 200, json: async () => ({}) }, reply(null)]) {
    const { deps } = fixture({ fetchImpl: async () => r });
    await assert.rejects(askLocal(base, deps), (e) => e instanceof EmptyAnswerError && !(e instanceof GuardError));
  }
});

test('an HTTP error is an error; a call that never answers is cut off at timeoutMs', async () => {
  await assert.rejects(askLocal(base, fixture({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) }).deps), /HTTP 500/);
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const t0 = Date.now(); await assert.rejects(askLocal({ ...base, timeoutMs: 40 }, fixture({ fetchImpl: hang }).deps)); assert.ok(Date.now() - t0 < 2000);
});

test('stop flag (own, fleet-wide, or unreadable): refused before any request, no budget used', async () => {
  for (const mk of [(f) => fs.writeFileSync(f.deps.stopOpts.flagPath, 'x'), (f) => fs.writeFileSync(f.deps.stopOpts.fleetPath, 'x'),
    (f) => { f.deps.stopOpts = { ...f.deps.stopOpts, flagPath: path.join(f.dir, 'file', 'nested') }; fs.writeFileSync(path.join(f.dir, 'file'), 'x'); }]) {
    const f = fixture(); mk(f);
    await assert.rejects(askLocal(base, f.deps), (e) => e instanceof GuardError && /stop|stopped/.test(e.message));
    assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.deps.counterFile), false);
  }
});

test('per-run cap: the call after the cap is refused', async () => {
  const f = fixture({ deps: { maxCalls: 2 } });
  await askLocal(base, f.deps); await askLocal(base, f.deps);
  await assert.rejects(askLocal(base, f.deps), /per-run cap of 2/); assert.equal(f.calls.length, 2);
  await assert.rejects(askLocal(base, fixture({ deps: { maxCalls: 0 } }).deps), GuardError);
  await assert.rejects(askLocal(base, fixture({ deps: { maxCalls: 1.5 } }).deps), GuardError);
});

test('per-day cap: counted per East Africa day, reserved BEFORE the request, rolls over at 00:00 EAT', async () => {
  const day1 = new Date('2026-11-17T20:59:00Z'), day2 = new Date('2026-11-17T21:00:00Z'); // 23:59 and 00:00 EAT
  let now = day1; const f = fixture({ deps: { dailyCap: 2, now: () => now } });
  await askLocal(base, f.deps); await askLocal(base, f.deps);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.deps.counterFile, 'utf8')), { day: '2026-11-17', count: 2 });
  await assert.rejects(askLocal(base, f.deps), /per-day cap of 2/); assert.equal(f.calls.length, 2);
  now = day2; await askLocal(base, f.deps);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.deps.counterFile, 'utf8')), { day: '2026-11-18', count: 1 });
  // a request that fails still used its reservation
  const g = fixture({ fetchImpl: async () => { throw new Error('boom'); }, deps: { dailyCap: 5 } });
  await assert.rejects(askLocal(base, g.deps), /boom/); assert.equal(JSON.parse(fs.readFileSync(g.deps.counterFile, 'utf8')).count, 1);
});

test('an unreadable or odd counter refuses (fail closed) and nothing is sent', async () => {
  for (const content of ['{not json', '[]', '{"day":"2026-11-17"}', '{"day":"2026-11-17","count":-1}', '{"day":5,"count":1}', '{"day":"2026-11-17","count":"3"}', '']) {
    const f = fixture(); fs.writeFileSync(f.deps.counterFile, content);
    await assert.rejects(askLocal(base, f.deps), GuardError, content); assert.equal(f.calls.length, 0);
  }
  const d = fixture(); fs.mkdirSync(d.deps.counterFile); await assert.rejects(askLocal(base, d.deps), GuardError); assert.equal(d.calls.length, 0);
  const w = fixture(); fs.writeFileSync(path.join(w.dir, 'afile'), 'x'); w.deps.counterFile = path.join(w.dir, 'afile', 'sub', 'c.json');
  await assert.rejects(askLocal(base, w.deps), GuardError); assert.equal(w.calls.length, 0);
});

test('a busy counter lock refuses instead of guessing', () => {
  const dir = tmp(); const file = path.join(dir, 'c.json'); fs.writeFileSync(file + '.lock', 'someone');
  const r = reserveCall({ counterFile: file, dailyCap: 10, now: new Date(), lockTimeoutMs: 60 });
  assert.equal(r.ok, false); assert.match(r.reason, /lock/);
});

test('three processes run at the same time on one counter file: the cap holds exactly', async () => {
  const dir = tmp(); const file = path.join(dir, 'c.json');
  const code = `import { reserveCall } from ${JSON.stringify(path.join(HERE, 'local-model.js'))}; let ok = 0; for (let i = 0; i < 12; i++) { if (reserveCall({ counterFile: ${JSON.stringify(file)}, dailyCap: 20, now: new Date('2026-11-17T09:00:00Z'), lockTimeoutMs: 5000 }).ok) ok++; } console.log(ok);`;
  const env = { ...process.env, BPA_STATE_DIR: dir, BPA_LOG_PATH: path.join(dir, 'l.log') };
  const run = () => new Promise((resolve) => { const c = spawn(process.execPath, ['--input-type=module', '-e', code], { env }); let out = '', err = ''; c.stdout.on('data', (x) => { out += x; }); c.stderr.on('data', (x) => { err += x; }); c.on('close', (status) => resolve({ status, out, err })); });
  const runs = await Promise.all([run(), run(), run()]);
  for (const r of runs) assert.equal(r.status, 0, r.err);
  assert.equal(runs.reduce((n, r) => n + Number(r.out.trim()), 0), 20);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { day: '2026-11-17', count: 20 });
});
