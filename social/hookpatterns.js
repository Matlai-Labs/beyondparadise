// Optional hook-pattern file (hook-patterns.json), copied in from the Agent OS reference-video store with `npm run sync-hook-patterns`.
// ADVISORY ONLY, like score.js: it labels the first line of a draft and says whether that style is among the top patterns.
// It never edits, blocks or re-orders a draft. Missing / unreadable / malformed file = no advice at all (behaviour unchanged).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FILE = path.join(HERE, 'hook-patterns.json');
const MAX_TOP = 4;

const firstLine = (t) => String(t || '').split('\n').map((l) => l.trim()).find(Boolean) || '';

// Top hook types, most frequent first. "unknown" and "other" carry no formula and are dropped. Never throws.
export function loadHookTypes(file = process.env.HOOK_PATTERNS_FILE || DEFAULT_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.patterns)) return [];
    const tally = new Map();
    for (const p of parsed.patterns) {
      const t = String(p && p.hook_type || '').trim();
      if (!t || t === 'unknown' || t === 'other') continue;
      tally.set(t, (tally.get(t) || 0) + (Number(p.count) || 0));
    }
    return [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_TOP).map(([t]) => t);
  } catch { return []; }
}

// Deterministic label of a draft's first line, using the store's vocabulary.
export function classifyHook(text) {
  const h = firstLine(text).replace(/#[\p{L}\p{N}_]+/gu, '').trim();
  if (!h) return 'other';
  if (/^how\b/i.test(h) || /^\d+\s+(ways|steps|tips|things|reasons)\b/i.test(h)) return 'how-to';
  if (h.includes('?') || /^(what|why|when|where|who|which|is|are|do|does|can|should)\b/i.test(h)) return 'question';
  if (/\b(stop|never|don't|do not|mistake|wrong|myth|avoid|warning|overrated)\b/i.test(h)) return 'warning-or-contrarian';
  if (/^(i|we|my|our)\b/i.test(h) || /\b(yesterday|last (week|month|night))\b/i.test(h)) return 'story';
  if (/\d/.test(h) || /\b(best|only|most|biggest|first|never|every)\b/i.test(h)) return 'bold-claim';
  return 'other';
}

// '' when there is nothing to say (no patterns file). Otherwise one short line.
export function hookAdvice(text, topTypes = loadHookTypes()) {
  if (!Array.isArray(topTypes) || topTypes.length === 0) return '';
  const style = classifyHook(text);
  return topTypes.includes(style)
    ? `hook style: ${style} (a top pattern)`
    : `hook style: ${style} (top patterns: ${topTypes.join(', ')})`;
}
