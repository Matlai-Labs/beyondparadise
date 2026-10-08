// Classify a visit as an AI-assistant referral. Same logic runs in the GTM snippet (gtm-ai-source.html).
// Reuses the matching approach of matlai-site/scripts/dashboard.mjs (AI_REFERRER_RE) but returns a clean label.
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync(new URL('./channel-group.json', import.meta.url), 'utf8'));
export const AI_SESSION_SOURCE_REGEX = cfg.channelGroup.channel.condition.regex;

// label -> host regex (hosts only, tested against referrer host and utm_source)
export const AI_SOURCES = [
  ['chatgpt', /(^|\.)(chatgpt\.com|chat\.openai\.com|openai\.com)$/],
  ['perplexity', /(^|\.)perplexity\.ai$/],
  ['claude', /(^|\.)claude\.ai$/],
  ['gemini', /(^|\.)gemini\.google\.com$/],
  ['copilot', /(^|\.)(copilot\.microsoft\.com|copilot\.com)$/],
  ['you', /(^|\.)you\.com$/], ['phind', /(^|\.)phind\.com$/], ['poe', /(^|\.)poe\.com$/], ['meta_ai', /(^|\.)meta\.ai$/],
  ['grok', /(^|\.)grok\.com$/], ['deepseek', /(^|\.)deepseek\.com$/], ['kagi', /(^|\.)kagi\.com$/],
];

/** @param {{referrer?:string, search?:string}} v  @returns {string|null} label or null */
export function classifyAiSource({ referrer = '', search = '' } = {}) {
  let utm = ''; try { utm = (new URLSearchParams(search).get('utm_source') || '').toLowerCase(); } catch {}
  let host = ''; let path = '';
  try { const u = new URL(referrer); host = u.hostname.toLowerCase(); path = u.pathname; } catch {}
  for (const probe of [utm, host]) {
    if (!probe) continue;
    for (const [label, re] of AI_SOURCES) if (re.test(probe)) return label;
  }
  if (/(^|\.)bing\.com$/.test(host) && /^\/chat/.test(path)) return 'copilot';
  return null;
}
