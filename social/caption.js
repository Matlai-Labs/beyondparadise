#!/usr/bin/env node
// One post idea in, one checked draft out (B5). The model writes only { hook, caption, altText } from the idea's title and claim
// texts; everything else in the post is added by code: the source line, the neutral pointer to the site, the hashtags.
//
//   draftFromIdea(idea, { ask, voice, rules, now, config, model, sourceNames, clock }) -> { ok, draft|null, attempts, reasons, seconds, ... }
//   node caption.js --bakeoff --ideas 10 --models gpt-oss:20b,qwen3:8b,hermes3:8b [--out <file>] [--now <date>]
//
// `ask({ prompt, system, model }) -> string` is injected; the real one is askLocal (local-model.js: local Ollama only, stop flag, caps).
// Checks after each answer, each with a named reason: not-json (vendored extractor), field lengths, number fidelity (every number
// in the model's text must occur in a claim text), no URL / @mention / hashtag from the model, then the real voice gate and the
// real rules gate (with the idea's claims) on the assembled text. Up to 2 retries; the next request names the failed reasons in one line.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseJsonLoose } from './vendor/json-loose/json-loose.mjs';
import { CONFIG, voiceGate, rulesCheck } from './lib.js';
import { askLocal, GuardError, EmptyAnswerError } from './local-model.js';

const execFileP = promisify(execFile);
export const LIMITS = { hook: 90, captionMin: 120, captionMax: 700, altMin: 20, altMax: 200, retries: 2 };
export const MIN_FREE_PERCENT = 15;
export const BRAND = 'Beyond Paradise Adventures';
export const FIXED_LINES = { pointer: 'More on the site, link in profile.' };

/** The first system text (B5), kept unchanged for the comparison with the second. */
export const PROMPT_V1 = [
  'You write one short Instagram post for a travel information account about Tanzania and Zanzibar.',
  'You get a title and one or more claims. Use ONLY the title and the claims. Add no other fact, number, name, date or place.',
  'Never write in the first person about having been there (no "we", no "I", no "our visit").',
  'Say nothing about sea conditions, seaweed, waves or swimming conditions.',
  'Do not sell and never tell anyone to book. Plain, short sentences. No hype words.',
  'No URL, no @mention, no hashtag, no emoji.',
  'Return JSON only, exactly this shape and nothing before or after it: {"hook": "...", "caption": "...", "altText": "..."}.',
  'hook: at most 90 characters, states the point.',
  'caption: 120 to 700 characters, two to five short sentences.',
  'altText: 20 to 200 characters, one sentence that describes the plain text card showing the hook.',
].join('\n');

/** The second system text (B6): every sentence restates a given claim; no added events, causes, judgements, advice or praise. */
export const PROMPT_V2 = [
  'You write one short Instagram post for a travel information account about Tanzania and Zanzibar.',
  'You get a title and one or more claims. Use ONLY the title and the claims. Add no other fact, number, name, date or place.',
  'Every sentence must restate one of the given claims in plain words. A sentence that restates no claim is not allowed.',
  'Add no events, no causes, no judgements, no advice and no praise. Never write "announced", "make sure" or "keep in mind". Never call anything beautiful, stunning or a gem.',
  'The hook starts with the most concrete fact or figure from the claims.',
  'If the claims are few, keep the caption short: two plain sentences are enough. Do not pad it.',
  'Never write in the first person about having been there (no "we", no "I", no "our visit").',
  'Say nothing about sea conditions, seaweed, waves or swimming conditions.',
  'Do not sell and never tell anyone to book. Plain, short sentences. No hype words.',
  'No URL, no @mention, no hashtag, no emoji.',
  'Return JSON only, exactly this shape and nothing before or after it: {"hook": "...", "caption": "...", "altText": "..."}.',
  'hook: at most 90 characters, states the point.',
  'caption: 120 to 700 characters, two to five short sentences.',
  'altText: 20 to 200 characters, one sentence that describes the plain text card showing the hook.',
].join('\n');

/** The system text of every request unless the caller names another: the second prompt. The model sees nothing else about the account. */
export const CAPTION_PROMPT = PROMPT_V2;

// Fixed hashtag vocabulary: a topic maps to a theme, a theme to 3 to 6 tags. The model never invents a tag.
export const TOPIC_TAGS = {
  themes: {
    wildlife: ['#BeyondParadiseAdventures', '#Wildlife', '#Safari', '#Tanzania', '#EastAfrica'],
    marine: ['#BeyondParadiseAdventures', '#Zanzibar', '#MarineLife', '#IndianOcean', '#Tanzania'],
    conservation: ['#BeyondParadiseAdventures', '#Conservation', '#Wildlife', '#Tanzania', '#ResponsibleTravel'],
    planning: ['#BeyondParadiseAdventures', '#TravelTips', '#Tanzania', '#Zanzibar', '#TravelPlanning'],
    places: ['#BeyondParadiseAdventures', '#Zanzibar', '#Tanzania', '#TravelAfrica', '#EastAfrica'],
  },
  default: ['#BeyondParadiseAdventures', '#Tanzania', '#Zanzibar', '#TravelAfrica'],
  topicTheme: {
    'african-lion': 'wildlife', 'wildebeest-migration': 'wildlife', 'wildebeest-calving': 'wildlife', 'big-cats': 'wildlife', 'african-wild-dog': 'wildlife', 'african-elephant': 'wildlife',
    'african-leopard': 'wildlife', 'african-cheetah': 'wildlife', 'african-buffalo': 'wildlife', 'black-rhino': 'wildlife', 'great-migration': 'wildlife', 'big-five': 'wildlife', birds: 'wildlife',
    'night-drive': 'wildlife', 'walking-safari': 'wildlife', 'boat-safari': 'wildlife', safari: 'wildlife', 'gorilla-trekking': 'wildlife', 'migration-calendar': 'wildlife', 'private-conservancy': 'wildlife',
    'national-park': 'wildlife', wildlife: 'wildlife', photography: 'wildlife',
    'whale-sharks': 'marine', dolphins: 'marine', 'sea-turtles': 'marine', 'coral-reefs': 'marine', 'humpback-whales': 'marine', 'scuba-diving': 'marine', snorkelling: 'marine', kitesurfing: 'marine',
    'marine-park': 'marine', 'marine-conservation': 'marine',
    conservation: 'conservation', 'wildlife-ethics': 'conservation', 'anti-poaching': 'conservation', sustainability: 'conservation',
    entry: 'planning', 'entry-requirements': 'planning', visa: 'planning', health: 'planning', 'getting-there': 'planning', transfers: 'planning', prices: 'planning', seasons: 'planning', value: 'planning',
    'food-and-beverage': 'planning', 'official-rules': 'planning', 'guide-quality': 'planning',
    destinations: 'places', excursions: 'places', 'lodge-review': 'places', exclusivity: 'places',
  },
};
export const hashtagsFor = (idea) => {
  const theme = TOPIC_TAGS.topicTheme[String(idea?.topic ?? '').toLowerCase()];
  return [...(theme ? TOPIC_TAGS.themes[theme] : TOPIC_TAGS.default)];
};

const REASON_HINTS = {
  'not-json': 'return only the JSON object', 'empty-answer': 'answer with the JSON object', 'model-error': 'answer with the JSON object',
  'hook-missing': 'give a text hook', 'caption-missing': 'give a text caption', 'alt-missing': 'give a text altText',
  'hook-too-long': 'hook at most 90 characters', 'caption-too-short': 'caption at least 120 characters', 'caption-too-long': 'caption at most 700 characters',
  'alt-too-short': 'altText at least 20 characters', 'alt-too-long': 'altText at most 200 characters',
  'number-not-in-claims': 'use only numbers that appear in the claims', 'url-in-text': 'no URL or web address', 'mention-in-text': 'no @mention', 'hashtag-in-text': 'no hashtag',
  'voice-lint': 'plainer words, no hype or filler', 'rules:sea-conditions': 'say nothing about the sea, waves, seaweed or swimming', 'rules:first-person-visit': 'no first person about having been there',
  'rules:paid-link-wording': 'no selling or booking words', 'rules:unsourced-figure': 'use only figures from the claims', 'rules:seaweed-farming-place': 'say nothing about seaweed',
};

/** The request text: the title and the claim texts, nothing else. `failed` (reason names of the last answer) adds ONE line. */
export function buildPrompt(idea, failed = []) {
  const lines = [`Title: ${String(idea.title ?? '').replace(/\s+/g, ' ').trim()}`, 'Claims:', ...idea.claims.map((c) => `- ${String(c.text).replace(/\s+/g, ' ').trim()}`)];
  if (failed.length) lines.push(`Your last answer failed: ${failed.map((r) => (REASON_HINTS[r] ? `${r} (${REASON_HINTS[r]})` : r)).join('; ')}. Return the JSON again.`);
  return lines.join('\n');
}

// ── numbers ──
const NUM_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
/** Every number in a text, by value (1,200 = 1200, 2.50 = 2.5). A digit outside 0-9 (full-width, Arabic-Indic ...) comes back as NaN: it can never equal a claim number. */
export function numbersIn(text) {
  const t = String(text ?? ''); const out = [...t.matchAll(NUM_RE)].map((m) => Number(m[0].replace(/,/g, '')));
  const odd = t.match(/(?![0-9])\p{Nd}+/gu); if (odd) out.push(...odd.map(() => NaN));
  return out;
}

const TLDS = 'com|net|org|io|co|tz|ke|de|uk|eu|info|app|travel|xyz|me|ly|tv|ae|fr|nl|biz|edu|gov|asia|africa|site|online|shop|blog|vn|us';
const URL_RE = new RegExp(String.raw`https?://|\bwww\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:${TLDS})\b`, 'i');
const len = (s) => [...s].length;
const text = (v) => typeof v === 'string' && v.trim() !== '';

/** The numbers in `texts` (strings; anything else is ignored) that occur in no claim text, in order. [] = every figure is a claim figure. */
export function numberFidelity(texts, claims) {
  const allowed = new Set((Array.isArray(claims) ? claims : []).flatMap((c) => numbersIn(c && c.text)));
  return (texts || []).filter((t) => typeof t === 'string').flatMap((t) => numbersIn(t)).filter((n) => !allowed.has(n));
}

/** Structural, number and no-URL/mention/hashtag checks on the model's { hook, caption, altText }. Returns reason names (no gates here). */
export function checkAnswer(ans, idea) {
  const r = []; const a = ans && typeof ans === 'object' ? ans : {};
  if (!text(a.hook)) r.push('hook-missing'); else if (len(a.hook.trim()) > LIMITS.hook) r.push('hook-too-long');
  if (!text(a.caption)) r.push('caption-missing'); else { const n = len(a.caption.trim()); if (n < LIMITS.captionMin) r.push('caption-too-short'); else if (n > LIMITS.captionMax) r.push('caption-too-long'); }
  if (!text(a.altText)) r.push('alt-missing'); else { const n = len(a.altText.trim()); if (n < LIMITS.altMin) r.push('alt-too-short'); else if (n > LIMITS.altMax) r.push('alt-too-long'); }
  const fields = [a.hook, a.caption, a.altText].filter(text);
  if (numberFidelity(fields, idea.claims).length) r.push('number-not-in-claims');
  if (fields.some((f) => URL_RE.test(f))) r.push('url-in-text');
  if (fields.some((f) => /@\w/.test(f))) r.push('mention-in-text');
  if (fields.some((f) => /#\w/.test(f))) r.push('hashtag-in-text');
  return r;
}

// ── lines added by code ──
function ruleSource(t) {
  const s = String(t).trimEnd(); if (!s.endsWith(')')) return null;
  let depth = 0, open = -1;
  for (let i = s.length - 1; i >= 0; i--) { if (s[i] === ')') depth++; else if (s[i] === '(') { depth--; if (depth === 0) { open = i; break; } } }
  if (open < 0) return null;
  const m = /^(.+), official page read (\d{4}-\d{2}-\d{2})$/s.exec(s.slice(open + 1, -1)); return m ? { body: m[1].trim(), readOn: m[2] } : null;
}
/** "Source: <who>, read <date>". Facts: the named source when known, else the publication's own research; pages: the publication; rules: the body printed in the claim text. */
export function sourceLine(claims, { sourceNames } = {}) {
  const parts = [];
  for (const c of claims) {
    let who, date = c.sourceDate;
    if (c.ruleId) { const p = ruleSource(c.text); who = p ? p.body : 'the official page'; if (p) date = p.readOn; }
    else if (c.factId) who = sourceNames?.[c.factId] || `${BRAND} research`;
    else who = BRAND;
    const part = `${who}, read ${date}`; if (!parts.includes(part)) parts.push(part);
  }
  return `Source: ${parts.join('; ')}`;
}
/** Hook, one sentence per line (the carousel planner turns each line into a slide), source line, pointer (only for a path on our own site), tags. */
export function assembleParts(idea, ans, opts = {}) {
  const hook = ans.hook.replace(/\s+/g, ' ').trim();
  const sentences = ans.caption.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  const codeLines = [sourceLine(idea.claims, opts)];
  if (typeof idea.link === 'string' && idea.link.startsWith('/')) codeLines.push(FIXED_LINES.pointer);
  const tags = hashtagsFor(idea).join(' '); codeLines.push(tags);
  const lines = [hook, '', ...sentences, ...codeLines.slice(0, -1), '', tags];
  return { hook, sentences, codeLines, text: lines.join('\n') };
}
/** The assembled post text. The model wrote `hook` and `sentences` (assembleParts); code added `codeLines`. */
export const assembleText = (idea, ans, opts = {}) => assembleParts(idea, ans, opts).text;

const defaultClock = () => Number(process.hrtime.bigint()) / 1e9;
const uniq = (a) => [...new Set(a)];

/** Gates on the assembled text and the alt text. Returns reason names. */
async function gateReasons(idea, full, ans, { voice, rules }) {
  const out = [];
  let voiceBad = false;
  for (const t of [full, ans.altText.trim()]) { const v = await voice(t); if (!v || !v.ok) voiceBad = true; }
  if (voiceBad) out.push('voice-lint');
  for (const t of [full, ans.altText.trim()]) { const rc = await rules(t, { claims: idea.claims }); if (!rc || !rc.ok) for (const id of (rc && rc.ruleIds && rc.ruleIds.length ? rc.ruleIds : ['check-error'])) out.push(`rules:${id}`); }
  return uniq(out);
}

export async function draftFromIdea(idea, { ask, voice = voiceGate, rules = rulesCheck, now = new Date(), config = CONFIG, model = config.captionModel, sourceNames, clock = defaultClock, prompt = CAPTION_PROMPT } = {}) {
  const t0 = clock(); const attemptReasons = []; const callSeconds = [];
  const done = (extra) => ({ attempts: attemptReasons.length, attemptReasons, callSeconds, seconds: clock() - t0, ...extra });
  const good = Array.isArray(idea?.claims) && idea.claims.length > 0 && idea.claims.every((c) => c && text(c.text));
  if (!good) return done({ ok: false, draft: null, reasons: ['idea-has-no-claims'], attempts: 0 });
  let failed = [];
  for (let attempt = 1; attempt <= 1 + LIMITS.retries; attempt++) {
    const c0 = clock(); let raw; let reasons = [];
    try { raw = await ask({ prompt: buildPrompt(idea, failed), system: prompt, model }); }
    catch (e) { if (e && e.guard) throw e; reasons = [e instanceof EmptyAnswerError ? 'empty-answer' : 'model-error']; }
    callSeconds.push(clock() - c0);
    let ans = null;
    if (!reasons.length) {
      if (typeof raw !== 'string' || !raw.trim()) reasons = ['empty-answer'];
      else { ans = parseJsonLoose(raw); if (!ans) reasons = ['not-json']; }
    }
    if (ans) {
      reasons = checkAnswer(ans, idea);
      if (text(ans.hook) && text(ans.caption) && text(ans.altText)) reasons = uniq([...reasons, ...await gateReasons(idea, assembleText(idea, ans, { sourceNames }), ans, { voice, rules })]);
    }
    attemptReasons.push(reasons);
    if (!reasons.length) {
      const hook = ans.hook.replace(/\s+/g, ' ').trim();
      const draft = { kind: 'idea', ideaKind: idea.kind, topic: idea.topic ?? null, region: 'all', text: assembleText(idea, ans, { sourceNames }), hook, caption: ans.caption.trim(), altText: ans.altText.trim(),
        hashtags: hashtagsFor(idea), sourceDate: idea.claims.map((c) => c.sourceDate).filter(Boolean).sort().at(-1) ?? null, sourceId: idea.sourceId, ideaId: idea.id, link: idea.link ?? null,
        claims: idea.claims, model, attempts: attempt, createdAt: now.toISOString() };
      return done({ ok: true, draft, reasons: [] });
    }
    failed = reasons;
    if (reasons.includes('rules:never-promote-list-unavailable')) break; // not the model's fault: asking again cannot help
  }
  return done({ ok: false, draft: null, reasons: failed });
}

// ── the comparison ──
/** Top ideas spread over kinds: about 30% rules, 30% pages, the rest facts; a short kind is filled from the others in rank order. */
export function pickBakeoffIdeas(ideas, n = 10) {
  const quota = { rule: Math.round(n * 0.3), page: Math.round(n * 0.3) }; quota.fact = n - quota.rule - quota.page;
  const chosen = new Set();
  for (const [kind, q] of Object.entries(quota)) for (const i of ideas.filter((x) => x.kind === kind).slice(0, q)) chosen.add(i);
  for (const i of ideas) { if (chosen.size >= n) break; chosen.add(i); }
  return ideas.filter((i) => chosen.has(i));
}

export async function runBakeoff({ ideas, models, installed, askFor, voice = voiceGate, rules = rulesCheck, memoryFree, unload, clock = defaultClock, now = new Date(), config = CONFIG, sourceNames }) {
  const rows = [];
  for (const model of models) {
    if (!installed.includes(model)) { rows.push({ model, total: 0, skipped: 'not installed' }); continue; }
    const free = await memoryFree(model);
    if (!(free >= MIN_FREE_PERCENT)) { rows.push({ model, total: 0, skipped: `free memory ${free}% is under ${MIN_FREE_PERCENT}%` }); continue; }
    const row = { model, total: 0, firstTry: 0, afterRetries: 0, givenUp: 0, reasons: {}, passed: [], failedIdeas: [], calls: [] };
    rows.push(row); let stopped = false;
    try {
      for (const idea of ideas) {
        let r;
        try { r = await draftFromIdea(idea, { ask: askFor(model), voice, rules, now, config, model, sourceNames, clock }); }
        catch (e) { if (e && e.guard) { row.stopped = e.message; stopped = true; break; } throw e; }
        row.total++; row.calls.push(...r.callSeconds);
        for (const rs of r.attemptReasons) for (const name of rs) row.reasons[name] = (row.reasons[name] || 0) + 1;
        if (r.ok) { if (r.attempts === 1) row.firstTry++; else row.afterRetries++; row.passed.push({ ideaId: idea.id, kind: idea.kind, attempts: r.attempts, hook: r.draft.hook, altText: r.draft.altText, text: r.draft.text }); }
        else { row.givenUp++; row.failedIdeas.push({ ideaId: idea.id, kind: idea.kind, reasons: r.reasons }); }
      }
    } finally { try { await unload(model); } catch { /* the unload is best effort */ } }
    row.meanSeconds = row.calls.length ? row.calls.reduce((a, b) => a + b, 0) / row.calls.length : 0; row.worstSeconds = row.calls.length ? Math.max(...row.calls) : 0;
    if (stopped) break;
  }
  return rows;
}

/** Most passes (first try plus after retries); ties by the lower mean seconds per call. */
export function summarize(rows) {
  const ran = rows.filter((r) => r.total > 0 && !r.skipped).map((r) => ({ model: r.model, passes: r.firstTry + r.afterRetries, mean: r.meanSeconds }));
  ran.sort((a, b) => b.passes - a.passes || a.mean - b.mean);
  return { best: ran.length ? ran[0].model : null, ranking: ran };
}

export function formatReport(rows, { date = '', ideas = [] } = {}) {
  const f = (x) => (typeof x === 'number' ? x.toFixed(1) : '-'); const { best, ranking } = summarize(rows);
  const out = [`# Caption comparison ${date}`, '', `Ideas: ${ideas.length ? ideas.map((i) => `${i.kind}:${i.id}`).join(', ') : '(see rows)'}`, '',
    '| model | ideas | first try | after retries | given up | mean s/call | worst s/call | failure reasons (all failed attempts) |', '|---|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    if (r.skipped) { out.push(`| ${r.model} | skipped: ${r.skipped} | | | | | | |`); continue; }
    out.push(`| ${r.model} | ${r.total} | ${r.firstTry} | ${r.afterRetries} | ${r.givenUp} | ${f(r.meanSeconds)} | ${f(r.worstSeconds)} | ${Object.entries(r.reasons || {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}${r.stopped ? ` (STOPPED by guard: ${r.stopped})` : ''} |`);
  }
  out.push('', `Most passes after retries, ties by speed: ${best ?? 'none ran'}${ranking.length ? ` (${ranking.map((x) => `${x.model} ${x.passes}`).join(', ')})` : ''}`);
  const top = rows.find((r) => r.model === best);
  if (top) { out.push('', `## Passing drafts of ${best}`); for (const p of top.passed) out.push('', `### ${p.kind} ${p.ideaId} (attempts ${p.attempts})`, `hook: ${p.hook}`, `alt text: ${p.altText}`, '```', p.text, '```'); }
  for (const r of rows) if (r.failedIdeas && r.failedIdeas.length) { out.push('', `## Given up, ${r.model}`); for (const x of r.failedIdeas) out.push(`- ${x.kind} ${x.ideaId}: ${x.reasons.join(', ')}`); }
  return out.join('\n') + '\n';
}

// ── real helpers for the command line ──
export async function readFreeMemoryPercent() {
  const { stdout } = await execFileP('memory_pressure', []); const m = /free percentage:\s*(\d+)%/.exec(stdout.trim().split('\n').at(-1)); return m ? Number(m[1]) : 0; // unreadable = 0 = skip (fail closed)
}
export async function listInstalledModels() {
  const { stdout } = await execFileP('ollama', ['list']); return stdout.split('\n').slice(1).map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
}
export const unloadModel = (model) => execFileP('ollama', ['stop', model]);
/** The real ask: one guarded request to the local model (local-model.js). */
export const localAsk = (deps = {}) => async ({ prompt, system, model, temperature, timeoutMs }) => askLocal({ model, prompt, system, format: 'json', ...(temperature !== undefined ? { temperature } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) }, deps);

async function main(argv) {
  const a = { ideas: 10, models: ['gpt-oss:20b', 'qwen3:8b', 'hermes3:8b'] }; const val = (i) => { if (i + 1 >= argv.length) { console.error(`missing value for ${argv[i]}`); process.exit(2); } return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--bakeoff') a.bakeoff = true; else if (k === '--ideas') { a.ideas = Number(val(i)); i++; } else if (k === '--models') { a.models = val(i).split(',').map((s) => s.trim()).filter(Boolean); i++; }
    else if (k === '--out') { a.out = val(i); i++; } else if (k === '--now') { a.now = val(i); i++; } else { console.error(`unknown argument ${k}`); process.exit(2); }
  }
  if (!a.bakeoff) { console.error('usage: node caption.js --bakeoff --ideas 10 --models gpt-oss:20b,qwen3:8b,hermes3:8b [--out <file>]'); process.exit(2); }
  if (!Number.isInteger(a.ideas) || a.ideas < 1) { console.error('--ideas needs a positive integer'); process.exit(2); }
  const { loadIdeaPool } = await import('./idea-drafts.js'); const now = a.now ? new Date(a.now + (/^\d{4}-\d{2}-\d{2}$/.test(a.now) ? 'T00:00:00Z' : '')) : new Date();
  const pool = loadIdeaPool({ now }); if (!pool.ok) { console.error(`comparison not run: ${pool.reason}`); process.exit(2); }
  const ideas = pickBakeoffIdeas(pool.ideas, a.ideas); const run = { calls: 0 };
  const rows = await runBakeoff({ ideas, models: a.models, installed: await listInstalledModels(), askFor: () => localAsk({ run }), memoryFree: readFreeMemoryPercent, unload: unloadModel, now, sourceNames: pool.sourceNames });
  const report = formatReport(rows, { date: now.toISOString().slice(0, 10), ideas }); if (a.out) { fs.mkdirSync(path.dirname(a.out), { recursive: true }); fs.writeFileSync(a.out, report); console.log(`written ${a.out}`); } else console.log(report);
  console.log(JSON.stringify({ best: summarize(rows).best, rows: rows.map(({ passed, calls, failedIdeas, ...r }) => r) }, null, 1));
}
const isMain = process.argv[1] && (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) main(process.argv.slice(2)).catch((e) => { console.error(`caption: ${e && e.guard ? 'stopped by guard: ' : ''}${e.message}`); process.exitCode = 1; });
