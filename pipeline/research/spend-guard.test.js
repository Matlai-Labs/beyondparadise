'use strict';
// Run: node --test pipeline/research/spend-guard.test.js  (no network; axios is stubbed)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path'); const Module = require('module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
process.env.RESEARCH_LEDGER_PATH = path.join(tmp, 'ledger.json');
process.env.RESEARCH_KILL_PATH = path.join(tmp, 'kill');
for (const k of ['TAVILY', 'BRAVE', 'OPENROUTER', 'DEEPSEEK', 'OPENAI', 'ANTHROPIC']) process.env[`${k}_API_KEY`] = 'test-not-a-key';
process.env.RESEARCH_MAX_OPENAI_CALLS_DAY = '1';

let http = 0;
const okJson = { choices: [{ message: { content: '{"a":1}' } }], content: [{ text: '{"a":1}' }], results: [{ title: 't', url: 'https://x.org/a', content: 'c' }], web: { results: [{ title: 't', url: 'https://x.org/a', description: 'd' }] } };
let failNext = false;
const calls = [];                 // every stubbed request: { url, config }
let geminiStatuses = null;        // queue of HTTP statuses for the Gemini endpoint (validateStatus: () => true)
const reply = async (url, body, config) => {
  http++; calls.push({ url, config: config || body });
  if (geminiStatuses && String(url).includes('generativelanguage')) {
    const status = geminiStatuses.shift() ?? 200;
    return { status, data: status === 200 ? { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } : { error: 'retry' } };
  }
  if (failNext) { failNext = false; const e = new Error('HTTP 429'); e.response = { status: 429 }; throw e; }
  return { data: okJson };
};
const fakeAxios = { post: reply, get: (url, config) => reply(url, config, config) };
const origLoad = Module._load;
Module._load = function (req, ...a) { return req === 'axios' ? fakeAxios : origLoad.call(this, req, ...a); };

const guard = require('./spend-guard');
const prov = require('./research-providers');

test('kill switch: every non-Gemini provider refuses with 0 HTTP requests', async () => {
  fs.writeFileSync(process.env.RESEARCH_KILL_PATH, '');
  http = 0;
  const saved = { SKIP: process.env.RESEARCH_SKIP_GEMINI, FB: process.env.RESEARCH_USE_SEARCH_FALLBACK };
  process.env.RESEARCH_SKIP_GEMINI = '1'; process.env.RESEARCH_USE_SEARCH_FALLBACK = '1';
  delete process.env.PERPLEXITY_API_KEY;
  await assert.rejects(prov.groundedResearch('Research "x"'), /SPEND GUARD/);
  await assert.rejects(prov.structureJson('{}'), /SPEND GUARD/);
  assert.equal(http, 0, 'no HTTP request may be made while the kill switch exists');
  fs.rmSync(process.env.RESEARCH_KILL_PATH);
  Object.assign(process.env, { RESEARCH_SKIP_GEMINI: saved.SKIP ?? '', RESEARCH_USE_SEARCH_FALLBACK: saved.FB ?? '' });
});

test('per-provider daily cap: second OpenAI call is refused before HTTP', () => {
  guard.checkProvider('openai'); guard.recordProvider('openai');
  assert.throws(() => guard.checkProvider('openai'), /openai daily cap reached \(1\/1\)/);
  assert.doesNotThrow(() => guard.checkProvider('tavily'), 'other providers have their own counters');
});

test('providers record usage after a successful call', async () => {
  http = 0;
  const before = guard.providerToday('deepseek');
  // exercise via structureJson with Ollama disabled and Gemini skipped, OpenRouter key absent
  delete process.env.OPENROUTER_API_KEY; process.env.RESEARCH_SKIP_GEMINI = '1'; delete process.env.RESEARCH_USE_OLLAMA; delete process.env.OLLAMA_BASE_URL;
  const r = await prov.structureJson('{}');
  assert.match(r.provider, /deepseek/);
  assert.equal(guard.providerToday('deepseek'), before + 1);
  assert.equal(http, 1);
});

test('a failed (e.g. 429) provider call still counts toward the cap — caps bound attempts, not successes', async () => {
  http = 0; failNext = true;
  const before = guard.providerToday('deepseek');
  delete process.env.OPENROUTER_API_KEY; process.env.RESEARCH_SKIP_GEMINI = '1'; delete process.env.RESEARCH_USE_OLLAMA; delete process.env.OLLAMA_BASE_URL;
  const savedOpenai = process.env.OPENAI_API_KEY, savedAnth = process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(prov.structureJson('{}'));
  process.env.OPENAI_API_KEY = savedOpenai; process.env.ANTHROPIC_API_KEY = savedAnth;
  assert.equal(http, 1, 'one HTTP attempt was made');
  assert.equal(guard.providerToday('deepseek'), before + 1, 'the failed attempt is recorded');
});

test('corrupt ledger fails closed (counters are not silently reset); missing ledger is fine', () => {
  const L = process.env.RESEARCH_LEDGER_PATH; const good = fs.readFileSync(L, 'utf8');
  fs.writeFileSync(L, '{"2026-10-31": 5, trunc');
  assert.throws(() => guard.checkProvider('tavily'), /SPEND GUARD: ledger unreadable/);
  assert.throws(() => guard.checkAffordable(1), /SPEND GUARD: ledger unreadable/);
  assert.throws(() => guard.recordProvider('tavily'), /SPEND GUARD: ledger unreadable/, 'never overwrite a corrupt ledger with a fresh one');
  assert.equal(fs.readFileSync(L, 'utf8'), '{"2026-10-31": 5, trunc', 'corrupt ledger left in place for a human');
  fs.rmSync(L);
  assert.doesNotThrow(() => guard.checkProvider('tavily'), 'first run: no ledger yet');
  fs.writeFileSync(L, good);
});

test('ledger writes are atomic (no temp file left behind, valid JSON after write)', () => {
  guard.recordProvider('brave');
  const L = process.env.RESEARCH_LEDGER_PATH;
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(L, 'utf8')));
  assert.deepEqual(fs.readdirSync(path.dirname(L)).filter((f) => f.includes('.tmp')), []);
});

test('concurrent processes do not lose ledger increments (read-modify-write is locked)', async () => {
  const { spawn } = require('child_process');
  const L = path.join(tmp, 'concurrent-ledger.json');
  const child = () => new Promise((res, rej) => {
    const p = spawn(process.execPath, ['-e', "const g=require(process.argv[1]);for(let i=0;i<60;i++)g.recordProvider('race')", path.join(__dirname, 'spend-guard.js')],
      { env: { ...process.env, RESEARCH_LEDGER_PATH: L, RESEARCH_MAX_PROVIDER_CALLS_RUN: '1000' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(err))));
  });
  await Promise.all([child(), child(), child(), child()]);
  const o = JSON.parse(fs.readFileSync(L, 'utf8'));
  const day = Object.keys(o.providers)[0];
  assert.equal(o.providers[day].race, 240);
});

// ── round 3 ─────────────────────────────────────────────────────────────────

test('the Gemini API key travels in the x-goog-api-key header, never in the URL', async () => {
  // A key in a query string is written into every proxy and error log on the way, and axios puts
  // config.url into the error it throws. https://ai.google.dev/gemini-api/docs/generate-content/api-key
  const saved = { ...process.env };
  process.env.GEMINI_API_KEY = 'SECRET-KEY'; delete process.env.RESEARCH_SKIP_GEMINI;
  calls.length = 0; geminiStatuses = [200];
  await prov.groundedResearch('Research "x"');
  const g = calls.find((c) => String(c.url).includes('generativelanguage'));
  assert.ok(g, 'the Gemini endpoint was called');
  assert.doesNotMatch(g.url, /key=/, 'no key in the query string');
  assert.doesNotMatch(g.url, /SECRET-KEY/);
  assert.equal(g.config.headers['x-goog-api-key'], 'SECRET-KEY');
  geminiStatuses = null; Object.assign(process.env, saved);
});

test('a retried grounded call counts every HTTP attempt, not just the one logical call', async () => {
  const saved = { ...process.env };
  process.env.GEMINI_API_KEY = 'SECRET-KEY'; delete process.env.RESEARCH_SKIP_GEMINI;
  process.env.RESEARCH_RETRY_BASE_MS = '1'; // the real backoff is 20 s per attempt
  const before = guard.spentToday();
  http = 0; geminiStatuses = [429, 503, 200];
  await prov.groundedResearch('Research "x"');
  assert.equal(http, 3, 'two retries then success');
  assert.equal(guard.spentToday(), before + 3, 'the cap must bound HTTP calls, not logical ones');
  geminiStatuses = null; Object.assign(process.env, saved); delete process.env.RESEARCH_RETRY_BASE_MS;
});

test('reserveProvider checks and records inside one lock, so racing processes cannot overshoot', async () => {
  const { spawn } = require('child_process');
  const L = path.join(tmp, 'reserve-ledger.json');
  // 4 processes x 10 attempts each against a daily cap of 10: at most 10 may be granted.
  const child = () => new Promise((res) => {
    const p = spawn(process.execPath, ['-e', "const g=require(process.argv[1]);let n=0;for(let i=0;i<10;i++){try{g.reserveProvider('race');n++;}catch(e){}}process.stdout.write(String(n))", path.join(__dirname, 'spend-guard.js')],
      { env: { ...process.env, RESEARCH_LEDGER_PATH: L, RESEARCH_MAX_RACE_CALLS_DAY: '10', RESEARCH_MAX_RACE_CALLS_RUN: '1000' }, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; p.stdout.on('data', (d) => { out += d; });
    p.on('exit', () => res(Number(out)));
  });
  const granted = (await Promise.all([child(), child(), child(), child()])).reduce((a, b) => a + b, 0);
  const o = JSON.parse(fs.readFileSync(L, 'utf8'));
  const day = Object.keys(o.providers)[0];
  assert.equal(o.providers[day].race, 10, 'the ledger must never pass the cap');
  assert.equal(granted, 10, 'exactly as many calls granted as recorded');
});

test('a stale ledger lock is broken by exactly one waiter and leaves nothing behind', async () => {
  const { spawn } = require('child_process');
  const L = path.join(tmp, 'stalelock-ledger.json');
  fs.mkdirSync(path.dirname(L), { recursive: true });
  fs.mkdirSync(`${L}.lock`);                                        // abandoned lock from a dead run
  const old = new Date(Date.now() - 120000); fs.utimesSync(`${L}.lock`, old, old);
  const child = () => new Promise((res, rej) => {
    const p = spawn(process.execPath, ['-e', "const g=require(process.argv[1]);for(let i=0;i<20;i++)g.recordProvider('stale')", path.join(__dirname, 'spend-guard.js')],
      { env: { ...process.env, RESEARCH_LEDGER_PATH: L, RESEARCH_MAX_PROVIDER_CALLS_RUN: '1000' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(err))));
  });
  await Promise.all([child(), child(), child(), child()]);
  const o = JSON.parse(fs.readFileSync(L, 'utf8'));
  assert.equal(o.providers[Object.keys(o.providers)[0]].stale, 80, 'no increment lost while breaking the lock');
  assert.deepEqual(fs.readdirSync(path.dirname(L)).filter((f) => f.includes('.stale.')), [], 'no leftover broken-lock directories');
});

test('reserve() refuses at the cap without recording, and never half-applies', () => {
  const L = path.join(tmp, 'grounded-ledger.json');
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, ['-e', `
    const g = require(process.argv[1]);
    let ok = 0, refused = 0;
    for (let i = 0; i < 5; i++) { try { g.reserve(1); ok++; } catch (e) { if (!/SPEND GUARD/.test(e.message)) throw e; refused++; } }
    process.stdout.write(JSON.stringify({ ok, refused, spent: g.spentToday() }));
  `, path.join(__dirname, 'spend-guard.js')],
    { env: { ...process.env, RESEARCH_LEDGER_PATH: L, RESEARCH_MAX_CALLS_DAY: '3', RESEARCH_MAX_CALLS_RUN: '100' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ok: 3, refused: 2, spent: 3 }, 'a refused reserve must not leave a count behind');
});
