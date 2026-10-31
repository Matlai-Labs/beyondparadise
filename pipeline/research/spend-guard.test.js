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
const fakeAxios = { post: async () => { http++; return { data: okJson }; }, get: async () => { http++; return { data: okJson }; } };
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
