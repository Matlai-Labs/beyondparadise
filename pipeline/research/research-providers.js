'use strict';

const axios = require('axios');
const guard = require('./spend-guard');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const PERPLEXITY_MODEL = process.env.PERPLEXITY_MODEL || 'sonar';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:8b';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OPENROUTER_STRUCT_MODELS = (process.env.OPENROUTER_STRUCT_MODELS || [
  'google/gemini-2.5-flash-lite',
  'deepseek/deepseek-chat',
].join(',')).split(',').map(s => s.trim()).filter(Boolean);
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const OPENAI_STRUCT_MODEL = process.env.OPENAI_STRUCT_MODEL || 'gpt-4o-mini';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || process.env.MODEL_NAME || 'claude-haiku-4-5-20251001';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function domainOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); }
  catch { return (u || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '') || null; }
}

function parseJson(text) {
  let t = String(text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s !== -1 && e !== -1) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

async function callGemini(parts, grounded, json) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('no GEMINI_API_KEY');
  if (grounded) guard.checkAffordable(1);

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  const body = { contents: [{ parts }], generationConfig: { temperature: 0.2 } };
  if (grounded) body.tools = [{ google_search: {} }];
  if (json) body.generationConfig.responseMimeType = 'application/json';

  let r;
  for (let attempt = 0; attempt < 5; attempt++) {
    r = await axios.post(endpoint, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 120000,
      validateStatus: () => true,
    });
    if (r.status === 200) break;
    if (r.status === 429 || r.status >= 500) {
      const wait = 20000 * (attempt + 1);
      console.log(`  Gemini ${r.status} - waiting ${wait / 1000}s before retry...`);
      await sleep(wait);
      continue;
    }
    throw new Error(`Gemini HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  }
  if (r.status !== 200) throw new Error('Gemini rate-limited after 5 retries');
  if (grounded) guard.record(1);

  const cand = r.data.candidates?.[0];
  const text = (cand?.content?.parts || []).map(p => p.text).filter(Boolean).join('\n');
  const chunks = (cand?.groundingMetadata?.groundingChunks || [])
    .map(c => ({ domain: domainOf(c.web?.title) || c.web?.title, redirect: c.web?.uri }))
    .filter(c => c.domain);
  return { provider: grounded ? 'gemini-grounding' : 'gemini-json', text, chunks };
}

async function callPerplexity(prompt) {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) throw new Error('no PERPLEXITY_API_KEY');
  guard.checkAffordable(1);

  const r = await axios.post(
    'https://api.perplexity.ai/chat/completions',
    {
      model: PERPLEXITY_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'You are a careful web research assistant. Cite exact source names and URLs for every finding.' },
        { role: 'user', content: prompt },
      ],
    },
    {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      timeout: 120000,
    }
  );
  guard.record(1);

  const text = (r.data.choices?.[0]?.message?.content || '').trim();
  const urls = [
    ...(r.data.citations || []),
    ...(r.data.search_results || []).map(x => x.url).filter(Boolean),
  ];
  const chunks = [...new Set(urls)]
    .map(url => ({ domain: domainOf(url), redirect: url }))
    .filter(c => c.domain);
  return { provider: 'perplexity-sonar', text, chunks };
}

function queryFromPrompt(prompt) {
  const quoted = String(prompt).match(/Research\s+"([^"]+)"/i)?.[1];
  if (quoted) return `${quoted} official sources regulations evidence`;
  return String(prompt).replace(/\s+/g, ' ').slice(0, 280);
}

function snippetsToGroundedText(results) {
  return results.map((r, i) => [
    `SOURCE ${i + 1}: ${r.title || r.domain}`,
    `DOMAIN: ${r.domain}`,
    `URL: ${r.url}`,
    `SNIPPET: ${r.content || r.snippet || ''}`,
  ].join('\n')).join('\n\n');
}

async function callTavily(prompt) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('no TAVILY_API_KEY');
  const r = await axios.post(
    'https://api.tavily.com/search',
    {
      query: queryFromPrompt(prompt),
      max_results: 8,
      search_depth: 'advanced',
      include_answer: false,
    },
    {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    }
  );
  const results = (r.data.results || [])
    .map(x => ({
      title: x.title || '',
      url: x.url || '',
      domain: domainOf(x.url),
      content: x.content || '',
    }))
    .filter(x => x.url && x.domain);
  if (!results.length) throw new Error('Tavily returned no results');
  return {
    provider: 'tavily-search',
    text: snippetsToGroundedText(results),
    chunks: results.map(x => ({ domain: x.domain, redirect: x.url })),
  };
}

async function callBrave(prompt) {
  const key = process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY;
  if (!key) throw new Error('no BRAVE_API_KEY or BRAVE_SEARCH_API_KEY');
  const r = await axios.get(
    'https://api.search.brave.com/res/v1/web/search',
    {
      params: { q: queryFromPrompt(prompt), count: 8 },
      headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
      timeout: 30000,
    }
  );
  const results = (r.data.web?.results || [])
    .map(x => ({
      title: x.title || '',
      url: x.url || '',
      domain: domainOf(x.url),
      content: x.description || '',
    }))
    .filter(x => x.url && x.domain);
  if (!results.length) throw new Error('Brave returned no results');
  return {
    provider: 'brave-search',
    text: snippetsToGroundedText(results),
    chunks: results.map(x => ({ domain: x.domain, redirect: x.url })),
  };
}

async function groundedResearch(prompt) {
  const failures = [];
  if (process.env.RESEARCH_SKIP_GEMINI !== '1') {
    try { return await callGemini([{ text: prompt }], true, false); }
    catch (err) { failures.push(`Gemini: ${err.message}`); }
  }
  if (process.env.RESEARCH_USE_SEARCH_FALLBACK === '1' || process.env.RESEARCH_SKIP_GEMINI === '1') {
    try { return await callTavily(prompt); }
    catch (err) { failures.push(`Tavily: ${err.message}`); }
    try { return await callBrave(prompt); }
    catch (err) { failures.push(`Brave: ${err.message}`); }
  }
  try { return await callPerplexity(prompt); }
  catch (err) { failures.push(`Perplexity: ${err.message}`); }
  throw new Error(`All grounded research providers failed (${failures.join(' | ')})`);
}

async function callOllamaJson(prompt) {
  if (process.env.RESEARCH_USE_OLLAMA !== '1' && !process.env.OLLAMA_BASE_URL) throw new Error('Ollama not enabled');
  const r = await axios.post(
    `${OLLAMA_BASE_URL}/api/generate`,
    {
      model: OLLAMA_MODEL,
      prompt,
      stream: true,
      options: { temperature: 0, num_predict: 2200 },
    },
    { responseType: 'stream', timeout: 90000 }
  );

  let full = '';
  await new Promise((resolve, reject) => {
    r.data.on('data', chunk => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue;
        try { full += JSON.parse(line).response || ''; } catch { /* ignore partial stream fragments */ }
      }
    });
    r.data.on('end', resolve);
    r.data.on('error', reject);
  });
  if (!full.trim()) throw new Error('empty Ollama response');
  parseJson(full);
  return { provider: `ollama/${OLLAMA_MODEL}`, text: full };
}

async function callOpenRouterJson(model, prompt) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('no OPENROUTER_API_KEY');
  const r = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model,
      temperature: 0.1,
      max_tokens: 2200,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    },
    {
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://beyondparadiseadventures.local/research',
        'X-Title': 'Beyond Paradise Research',
      },
      timeout: 60000,
    }
  );
  const text = (r.data.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('empty OpenRouter response');
  parseJson(text);
  return { provider: `openrouter/${model}`, text };
}

async function callDeepSeekJson(prompt) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('no DEEPSEEK_API_KEY');
  const r = await axios.post(
    'https://api.deepseek.com/chat/completions',
    {
      model: DEEPSEEK_MODEL,
      temperature: 0.1,
      max_tokens: 2200,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    },
    {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      timeout: 60000,
    }
  );
  const text = (r.data.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('empty DeepSeek response');
  parseJson(text);
  return { provider: `deepseek/${DEEPSEEK_MODEL}`, text };
}

async function callOpenAIJson(prompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('no OPENAI_API_KEY');
  const r = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: OPENAI_STRUCT_MODEL,
      temperature: 0.1,
      max_tokens: 2200,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    },
    {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      timeout: 60000,
    }
  );
  const text = (r.data.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('empty OpenAI response');
  parseJson(text);
  return { provider: `openai/${OPENAI_STRUCT_MODEL}`, text };
}

async function callAnthropicJson(prompt) {
  const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!key) throw new Error('no ANTHROPIC_API_KEY or CLAUDE_API_KEY');
  const r = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: ANTHROPIC_MODEL,
      max_tokens: 2200,
      temperature: 0.1,
      messages: [{ role: 'user', content: prompt }],
    },
    {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 60000,
    }
  );
  const text = (r.data.content?.[0]?.text || '').trim();
  if (!text) throw new Error('empty Anthropic response');
  parseJson(text);
  return { provider: `anthropic/${ANTHROPIC_MODEL}`, text };
}

async function structureJson(prompt) {
  const failures = [];

  try { return await callOllamaJson(prompt); }
  catch (err) { failures.push(`Ollama: ${err.message}`); }

  if (process.env.RESEARCH_SKIP_GEMINI !== '1') {
    try { return await callGemini([{ text: prompt }], false, true); }
    catch (err) { failures.push(`Gemini: ${err.message}`); }
  }

  for (const model of OPENROUTER_STRUCT_MODELS) {
    try { return await callOpenRouterJson(model, prompt); }
    catch (err) { failures.push(`OpenRouter ${model}: ${err.message}`); }
  }

  try { return await callDeepSeekJson(prompt); }
  catch (err) { failures.push(`DeepSeek: ${err.message}`); }

  try { return await callOpenAIJson(prompt); }
  catch (err) { failures.push(`OpenAI: ${err.message}`); }

  try { return await callAnthropicJson(prompt); }
  catch (err) { failures.push(`Anthropic: ${err.message}`); }

  throw new Error(`All JSON structuring providers failed (${failures.join(' | ')})`);
}

module.exports = {
  domainOf,
  groundedResearch,
  structureJson,
};
