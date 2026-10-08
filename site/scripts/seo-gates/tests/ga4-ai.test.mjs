import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyAiSource, AI_SESSION_SOURCE_REGEX } from '../ga4-ai-assistants/ai-source.mjs';

const cfg = JSON.parse(fs.readFileSync(new URL('../ga4-ai-assistants/channel-group.json', import.meta.url), 'utf8'));

test('channel group config names the group and carries the sessionSource regex', () => {
  assert.equal(cfg.channelGroup.name, 'AI Assistants');
  const re = new RegExp(cfg.channelGroup.channel.condition.regex);
  for (const s of ['chatgpt.com', 'chat.openai.com', 'perplexity.ai', 'claude.ai', 'gemini.google.com', 'copilot.microsoft.com', 'you.com', 'phind.com', 'poe.com', 'meta.ai', 'grok.com', 'deepseek.com', 'kagi.com']) {
    assert.ok(re.test(s), s);
  }
  for (const s of ['google', 'bing', 'facebook.com', 'tripadvisor.com', 'duckduckgo.com', 'youtube.com']) {
    assert.ok(!re.test(s), `false positive: ${s}`);
  }
  assert.equal(AI_SESSION_SOURCE_REGEX, cfg.channelGroup.channel.condition.regex);
});

test('classifyAiSource: referrer, utm_source and non-AI', () => {
  assert.equal(classifyAiSource({ referrer: 'https://chatgpt.com/' }), 'chatgpt');
  assert.equal(classifyAiSource({ referrer: '', search: '?utm_source=chatgpt.com' }), 'chatgpt');
  assert.equal(classifyAiSource({ referrer: 'https://www.perplexity.ai/search/x' }), 'perplexity');
  assert.equal(classifyAiSource({ referrer: 'https://claude.ai/chat/1' }), 'claude');
  assert.equal(classifyAiSource({ referrer: 'https://gemini.google.com/app' }), 'gemini');
  assert.equal(classifyAiSource({ referrer: 'https://www.bing.com/chat?q=x' }), 'copilot');
  assert.equal(classifyAiSource({ referrer: 'https://www.google.com/search?q=x' }), null);
  assert.equal(classifyAiSource({ referrer: 'https://bing.com/search?q=x' }), null);
  assert.equal(classifyAiSource({}), null);
});

test('GTM snippet embeds every source from the shared table', () => {
  const snip = fs.readFileSync(new URL('../ga4-ai-assistants/gtm-ai-source.html', import.meta.url), 'utf8');
  assert.ok(snip.includes('ai_source') && snip.includes('dataLayer'));
  for (const host of ['chatgpt.com', 'perplexity.ai', 'claude.ai', 'gemini.google.com', 'kagi.com']) assert.ok(snip.includes(host), host);
});
