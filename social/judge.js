#!/usr/bin/env node
// The draft judge (B6): may a caption written by the small local model go out? It must say nothing the sourced facts do not say.
//
//   judgeDraft(draft, { ask, model, now, check, clock }) -> { verdict: 'pass'|'fail', reasons: [{ check, detail }], model, seconds, at }
//   node judge.js --calibrate --models qwen3:8b,hermes3:8b,gpt-oss:20b [--ideas 14] [--out <file>] [--now <date>]
//
// Order (cheap first, a fail anywhere stops the later steps; a fail is never a retry):
//   1 deterministic, no model: the draft has claims and model text; the final check (voice + rules) passes; number fidelity (every figure
//     of the hook, caption and alt text is in a claim); no empty praise or filler (FILLER_PHRASES, whole phrase, any case)
//   2 by model, one closed question per model-written sentence (the hook and the caption, never the lines code added: the source line,
//     the pointer, the hashtags): does the sentence state anything the claims do not? supported:false, an unparsable or empty answer, or any
//     caller error FAILS the draft. `ask({ prompt, system, model, temperature })` is injected; the real one is caption.js localAsk (askLocal).
// This is a measured filter, not proof: `--calibrate` runs it on cases built from real ideas with one injected defect each (see DEFECTS).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonLoose } from './vendor/json-loose/json-loose.mjs';
import { finalCheck } from './lib.js';
import { numberFidelity, assembleParts, localAsk, readFreeMemoryPercent, listInstalledModels, unloadModel, MIN_FREE_PERCENT } from './caption.js';

export const CALIBRATION_TIMEOUT_MS = 180_000;

/** Empty praise and filler, refused outright. Whole phrase, case-insensitive. One constant. */
export const FILLER_PHRASES = Object.freeze(['beautiful destination', 'hidden gem', 'paradise', 'breathtaking', 'must-see', 'bucket list', 'unforgettable', 'stunning', 'magical', 'once in a lifetime', "don't miss", 'make sure to', 'keep in mind']);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FILLER_RES = FILLER_PHRASES.map((p) => [p, new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(p).replace(/'/g, "['’]")}(?![\\p{L}\\p{N}])`, 'iu')]);
/** The filler phrases found in a text, in list order. */
export const fillerHits = (text) => FILLER_RES.filter(([, re]) => re.test(String(text ?? ''))).map(([p]) => p);

/** The one closed question, the system text of every judge request. */
export const JUDGE_QUESTION = [
  'You check ONE sentence of an Instagram post against the facts it must be based on. Answer with JSON only, exactly this shape and nothing else: {"supported": true or false, "extra": "..."}.',
  'supported is true only if everything the sentence states is also stated in the facts, in the same or plainer words. Restating the facts in other words is fine.',
  'supported is false if the sentence states anything the facts do not state: a new event (something announced, opened, changed or done), a cause or reason, a judgement (good, bad, cheap, worth it, popular), a recommendation or advice, a time, a place, a person or organisation that acts, a feeling, or a personal experience of having been there. A figure the facts attach to a different thing is also not supported.',
  'extra: the part of the sentence that the facts do not state, or an empty string when supported is true.',
].join('\n');

/**
 * The fixed defect sentences of the calibration (one per defect type; the figure swap is built from the idea's own claim). Each passes the
 * voice gate and the rules gate on purpose, so a catch or a miss in the calibration is the judge's doing, not a regex's.
 */
export const DEFECTS = Object.freeze({
  event: 'The change was announced this week.',
  judgement: 'This is good value for most visitors.',
  recommendation: 'Travellers should plan this well ahead.',
  cause: 'This is because of rising demand.',
  'actor-place': 'Operators in Arusha asked for this.',
  'first-person': 'Having seen it up close, the place felt calm.',
  'sea-remark': 'The water was rough that morning.',
});
export const DEFECT_TYPES = Object.freeze(['event', 'judgement', 'recommendation', 'cause', 'number-swap', 'actor-place', 'first-person', 'sea-remark']);
export const JUDGE_CHECKS = ['no-claims', 'no-model-text', 'final-check', 'number-not-in-claims', 'filler', 'unsupported-statement', 'judge-unparsable', 'judge-error'];

/** Sentences of a model-written text: split after . ! ? before a capital letter or a quote; "No. 256" stays whole. */
export function splitSentences(text) {
  if (typeof text !== 'string') return [];
  return text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[A-Z"'“‘])/).map((s) => s.trim()).filter((s) => s.length > 1);
}
const hasText = (v) => typeof v === 'string' && v.trim() !== '';
const claimTexts = (d) => (Array.isArray(d?.claims) ? d.claims.map((c) => c && c.text).filter(hasText) : []);
const defaultClock = () => Number(process.hrtime.bigint()) / 1e9;

/** Step 1, no model. Returns every reason found: [{ check, detail }] ([] = clean). Never throws. */
export async function deterministicChecks(draft, { check = finalCheck, neverPromotePatterns } = {}) {
  const out = [];
  if (!claimTexts(draft).length) out.push({ check: 'no-claims', detail: 'the draft carries no claim text to be judged against' });
  if (!hasText(draft?.hook) || !hasText(draft?.caption)) out.push({ check: 'no-model-text', detail: 'the draft has no hook or no caption text' });
  try {
    const f = await check(draft, neverPromotePatterns !== undefined ? { neverPromotePatterns } : undefined);
    if (!f || !f.ok) out.push({ check: 'final-check', detail: `voice or rules refused: ${f && Array.isArray(f.ruleIds) && f.ruleIds.length ? f.ruleIds.join(', ') : 'no rule id'}` });
  } catch (e) { out.push({ check: 'final-check', detail: `the final check could not run (${e && e.message ? e.message : 'error'})` }); }
  const written = [draft?.hook, draft?.caption, draft?.altText];
  const bad = numberFidelity(written, draft?.claims); if (bad.length) out.push({ check: 'number-not-in-claims', detail: `figures not in any claim: ${[...new Set(bad.map((n) => (Number.isNaN(n) ? 'non-ASCII digit' : n)))].join(', ')}` });
  const filler = [...new Set(written.flatMap((t) => fillerHits(t)))]; if (filler.length) out.push({ check: 'filler', detail: `empty praise or filler: ${filler.join(', ')}` });
  return out;
}

const factsBlock = (draft) => ['Facts:', ...claimTexts(draft).map((t) => `- ${t.replace(/\s+/g, ' ').trim()}`)].join('\n');
const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function judgeDraft(draft, { ask, model, now = new Date(), check = finalCheck, neverPromotePatterns, clock = defaultClock } = {}) {
  const t0 = clock();
  const done = (verdict, reasons) => ({ verdict, reasons, model: model ?? null, seconds: clock() - t0, at: now.toISOString() });
  const det = await deterministicChecks(draft, { check, neverPromotePatterns });
  if (det.length) return done('fail', det);
  if (typeof ask !== 'function' || !hasText(model)) return done('fail', [{ check: 'judge-error', detail: 'no judge function or no judge model: the draft cannot be judged' }]);
  const sentences = [...new Set([...splitSentences(draft.hook), ...splitSentences(draft.caption)])];
  const facts = factsBlock(draft);
  for (const sentence of sentences) {
    let raw;
    try { raw = await ask({ prompt: `${facts}\n\nSentence: ${sentence}`, system: JUDGE_QUESTION, model, temperature: 0 }); }
    catch (e) { return done('fail', [{ check: 'judge-error', detail: `${e && e.message ? e.message : 'the judge call failed'}`, ...(e && e.guard ? { guard: true } : {}) }]); }
    const ans = typeof raw === 'string' && raw.trim() ? parseJsonLoose(raw) : null;
    if (!ans || typeof ans !== 'object' || Array.isArray(ans) || typeof ans.supported !== 'boolean') return done('fail', [{ check: 'judge-unparsable', detail: `no usable answer for: ${clip(sentence, 80)}` }]);
    if (!ans.supported) return done('fail', [{ check: 'unsupported-statement', detail: `${clip(sentence)}${typeof ans.extra === 'string' && ans.extra.trim() ? ` -- not in the facts: ${clip(ans.extra.trim(), 120)}` : ''}` }]);
  }
  return done('pass', []);
}

// ── the calibration ──
const NUMBER_TOKEN = /\d{4}-\d{2}-\d{2}|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
/** Swap the first two different figures of a sentence (dates are not figures). null when the sentence has fewer than two different ones. */
export function swapFigures(sentence) {
  const toks = [...String(sentence).matchAll(NUMBER_TOKEN)].filter((m) => !/^\d{4}-/.test(m[0]));
  const a = toks[0]; const b = a && toks.find((m) => m[0] !== a[0] && m.index > a.index); if (!a || !b) return null;
  return sentence.slice(0, a.index) + b[0] + sentence.slice(a.index + a[0].length, b.index) + a[0] + sentence.slice(b.index + b[0].length);
}

function draftOf(idea, hook, caption, sourceNames) {
  const ans = { hook, caption, altText: hook };
  const parts = assembleParts(idea, ans, { sourceNames });
  return { kind: 'idea', ideaKind: idea.kind, topic: idea.topic ?? null, hook: parts.hook, caption, altText: hook, text: parts.text, claims: idea.claims, link: idea.link ?? null, ideaId: idea.id, sourceId: idea.sourceId };
}
/** The good case (verbatim claim sentences, nothing added) and the bad cases (one injected defect each) of one idea. */
export function casesFor(idea, { sourceNames } = {}) {
  // A claim has no closing full stop (rule claims end in a bracket); one is added so that the sentence after it is a sentence of its own.
  const stop = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);
  const sentences = idea.claims.flatMap((c) => splitSentences(c.text)).map(stop); if (!sentences.length) return null;
  const mk = (list, extra = []) => draftOf(idea, list[0], [...list, ...extra].join(' '), sourceNames);
  const good = { ideaId: idea.id, kind: idea.kind, expected: 'pass', defect: null, draft: mk(sentences), judged: sentences };
  const bad = [];
  for (const [defect, text] of Object.entries(DEFECTS)) bad.push({ ideaId: idea.id, kind: idea.kind, expected: 'fail', defect, draft: mk(sentences, [text]), judged: [text] });
  const i = sentences.findIndex((s) => swapFigures(s) !== null);
  if (i >= 0) { const swapped = sentences.map((s, k) => (k === i ? swapFigures(s) : s)); bad.push({ ideaId: idea.id, kind: idea.kind, expected: 'fail', defect: 'number-swap', draft: mk(swapped), judged: [swapped[i]] }); }
  return { good, bad };
}

/** Real ideas: up to `per` of each kind in pool order, whose good case clears the deterministic step (so a false refusal is the judge's). */
export async function pickCalibrationIdeas(ideas, { total = 14, per = { rule: 6, page: 5, fact: 6 }, check = finalCheck, sourceNames } = {}) {
  const chosen = []; const skipped = [];
  for (const kind of Object.keys(per)) {
    let n = 0;
    for (const idea of ideas.filter((i) => i.kind === kind)) {
      if (n >= per[kind] || chosen.length >= total) break;
      const c = casesFor(idea, { sourceNames }); if (!c) continue;
      const det = await deterministicChecks(c.good.draft, { check });
      if (det.length) { skipped.push({ ideaId: idea.id, kind, why: det.map((x) => x.check) }); continue; }
      chosen.push({ idea, cases: c }); n++;
    }
  }
  return { chosen, skipped };
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
/** Cache of identical questions at temperature 0 within one model run: the bad cases repeat the good case's sentences. Real calls are counted and timed. */
export function cachedAsk(inner, { clock = defaultClock, logError = () => {} } = {}) {
  const cache = new Map(); const stats = { real: 0, hits: 0, seconds: [], errors: [] };
  const ask = async (req) => {
    const key = JSON.stringify([req.model, req.system, req.prompt]); if (cache.has(key)) { stats.hits++; return cache.get(key); }
    const t = clock(); stats.real++;
    try { const a = await inner({ ...req, timeoutMs: CALIBRATION_TIMEOUT_MS }); stats.seconds.push(clock() - t); cache.set(key, a); return a; }
    catch (e) { stats.seconds.push(clock() - t); const msg = e && e.message ? e.message : String(e); stats.errors.push(msg); logError(msg); throw e; }
  };
  ask.stats = stats; return ask;
}

/** Run every case through the judge with one model. Returns the row of the report. */
export async function calibrateModel({ model, picked, askFor, check = finalCheck, clock = defaultClock, now = new Date(), logError = () => {} }) {
  const ask = cachedAsk(askFor(model), { clock, logError });
  const row = { model, ideas: picked.length, good: { total: 0, passed: 0, refused: [], seconds: [] }, bad: Object.fromEntries(DEFECT_TYPES.map((t) => [t, { total: 0, failed: 0, byModel: 0, byDeterministic: 0, failedClosed: 0, misses: [] }])), unparsable: 0, errors: 0 };
  const tally = (r) => { for (const x of r.reasons) { if (x.check === 'judge-unparsable') row.unparsable++; if (x.check === 'judge-error') row.errors++; } };
  for (const { cases } of picked) {
    const g = await judgeDraft(cases.good.draft, { ask, model, now, check, clock }); tally(g);
    row.good.total++; row.good.seconds.push(g.seconds); if (g.verdict === 'pass') row.good.passed++; else row.good.refused.push({ ideaId: cases.good.ideaId, kind: cases.good.kind, reasons: g.reasons });
    for (const b of cases.bad) {
      const r = await judgeDraft(b.draft, { ask, model, now, check, clock }); tally(r); const d = row.bad[b.defect]; d.total++;
      if (r.verdict === 'fail') { d.failed++; const c = r.reasons.map((x) => x.check); if (c.includes('unsupported-statement')) d.byModel++; else if (c.some((x) => x === 'judge-error' || x === 'judge-unparsable')) d.failedClosed++; else d.byDeterministic++; }
      else d.misses.push({ defect: b.defect, ideaId: b.ideaId, kind: b.kind, sentence: b.judged.join(' ') });
    }
  }
  row.calls = { real: ask.stats.real, cacheHits: ask.stats.hits, meanSeconds: mean(ask.stats.seconds), worstSeconds: ask.stats.seconds.length ? Math.max(...ask.stats.seconds) : 0 };
  row.errorTexts = ask.stats.errors; row.meanSecondsPerGoodDraft = mean(row.good.seconds); row.worstSecondsPerGoodDraft = row.good.seconds.length ? Math.max(...row.good.seconds) : 0;
  row.badTotal = Object.values(row.bad).reduce((a, d) => a + d.total, 0); row.badFailed = Object.values(row.bad).reduce((a, d) => a + d.failed, 0); row.misses = row.badTotal - row.badFailed;
  row.falseRefusals = row.good.total - row.good.passed;
  return row;
}

/** Fewest misses; ties: fewest false refusals, then the lower mean seconds per good draft. */
export function pickJudgeModel(rows) {
  const ran = rows.filter((r) => !r.skipped && r.badTotal > 0).sort((a, b) => a.misses - b.misses || a.falseRefusals - b.falseRefusals || a.meanSecondsPerGoodDraft - b.meanSecondsPerGoodDraft);
  return ran.length ? ran[0].model : null;
}

export function formatCalibration(rows, { date = '', picked = [], skippedIdeas = [], memoryNotes = [] } = {}) {
  const f1 = (x) => (typeof x === 'number' ? x.toFixed(1) : '-'); const best = pickJudgeModel(rows); const top = rows.find((r) => r.model === best);
  const out = [`# Judge calibration ${date}`, ''];
  if (top) {
    const rate = top.misses / top.badTotal;
    out.push(rate > 0.1 ? `**THE BEST MODEL (${best}) STILL MISSES MORE THAN 1 BAD CASE IN 10: ${top.misses} of ${top.badTotal} injected defects passed the judge. It is not safe to publish on this judge alone.**` : `Best model ${best}: ${top.misses} of ${top.badTotal} injected defects passed (${(rate * 100).toFixed(1)}%), ${top.falseRefusals} of ${top.good.total} verbatim good cases wrongly refused.`, '');
  } else out.push('**No model ran.**', '');
  out.push(`Cases: ${picked.length} real ideas (${['rule', 'page', 'fact'].map((k) => `${picked.filter((p) => p.idea.kind === k).length} ${k}`).join(', ')}); per idea one good case (the claim sentences, verbatim) and one bad case per defect type (an added sentence, or for number-swap the first two figures swapped). Labels come from construction, not from a person: no hand-labelled set. The good cases are verbatim, so they show false refusals of plain restatements only; paraphrased real drafts are judged separately (see the prompt comparison).`, '');
  for (const n of memoryNotes) out.push(`- ${n}`); if (memoryNotes.length) out.push('');
  out.push('| model | good passed | bad failed | misses | unparsable | caller errors | mean s/draft (good) | worst s/draft (good) | real calls | mean s/call | worst s/call |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) { if (r.skipped) { out.push(`| ${r.model} | skipped: ${r.skipped} | | | | | | | | | |`); continue; } out.push(`| ${r.model} | ${r.good.passed}/${r.good.total} | ${r.badFailed}/${r.badTotal} | ${r.misses} | ${r.unparsable} | ${r.errors} | ${f1(r.meanSecondsPerGoodDraft)} | ${f1(r.worstSecondsPerGoodDraft)} | ${r.calls.real} (+${r.calls.cacheHits} repeated sentences answered from the first answer) | ${f1(r.calls.meanSeconds)} | ${f1(r.calls.worstSeconds)} |`); }
  out.push('', '## Bad cases failed, per defect type (failed / total; of the failed: by the model, by a deterministic check, failed closed on an error or unparsable answer)', '', `| model | ${DEFECT_TYPES.join(' | ')} |`, `|---|${DEFECT_TYPES.map(() => '---').join('|')}|`);
  for (const r of rows) if (!r.skipped) out.push(`| ${r.model} | ${DEFECT_TYPES.map((t) => { const d = r.bad[t]; return `${d.failed}/${d.total} (${d.byModel}/${d.byDeterministic}/${d.failedClosed})`; }).join(' | ')} |`);
  for (const r of rows) {
    if (r.skipped) continue;
    out.push('', `## Misses, ${r.model} (${r.misses})`); if (!r.misses) out.push('none');
    for (const t of DEFECT_TYPES) for (const m of r.bad[t].misses) out.push(`- ${m.defect} (${m.kind} ${m.ideaId}): judged sentence: ${m.sentence}`);
    out.push('', `### False refusals, ${r.model} (${r.falseRefusals})`); if (!r.falseRefusals) out.push('none'); for (const x of r.good.refused) out.push(`- ${x.kind} ${x.ideaId}: ${x.reasons.map((y) => `${y.check}: ${y.detail}`).join(' | ')}`);
    out.push('', `### Caller error texts, ${r.model} (${r.errorTexts.length})`); if (!r.errorTexts.length) out.push('none'); for (const e of r.errorTexts) out.push(`- ${e}`);
  }
  if (skippedIdeas.length) { out.push('', '## Ideas left out (their verbatim good case did not clear the deterministic step)'); for (const s of skippedIdeas) out.push(`- ${s.kind} ${s.ideaId}: ${s.why.join(', ')}`); }
  out.push('', `Model with the fewest misses (ties: fewest false refusals, then speed): ${best ?? 'none'}`);
  return out.join('\n') + '\n';
}

// ── command line ──
async function main(argv) {
  const a = { models: ['qwen3:8b', 'hermes3:8b', 'gpt-oss:20b'], ideas: 14 }; const val = (i) => { if (i + 1 >= argv.length) { console.error(`missing value for ${argv[i]}`); process.exit(2); } return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--calibrate') a.calibrate = true; else if (k === '--models') { a.models = val(i).split(',').map((s) => s.trim()).filter(Boolean); i++; } else if (k === '--ideas') { a.ideas = Number(val(i)); i++; }
    else if (k === '--out') { a.out = val(i); i++; } else if (k === '--now') { a.now = val(i); i++; } else { console.error(`unknown argument ${k}`); process.exit(2); }
  }
  if (!a.calibrate) { console.error('usage: node judge.js --calibrate --models qwen3:8b,hermes3:8b,gpt-oss:20b [--ideas 14] [--out <file>] [--now <date>]'); process.exit(2); }
  if (!Number.isInteger(a.ideas) || a.ideas < 12) { console.error('--ideas needs a whole number of at least 12'); process.exit(2); }
  const { loadIdeaPool } = await import('./idea-drafts.js'); const now = a.now ? new Date(a.now + (/^\d{4}-\d{2}-\d{2}$/.test(a.now) ? 'T00:00:00Z' : '')) : new Date();
  const pool = loadIdeaPool({ now }); if (!pool.ok) { console.error(`calibration not run: ${pool.reason}`); process.exit(2); }
  const { chosen, skipped } = await pickCalibrationIdeas(pool.ideas, { total: a.ideas, sourceNames: pool.sourceNames });
  if (chosen.length < 12) { console.error(`calibration not run: only ${chosen.length} usable real ideas (12 needed)`); process.exit(2); }
  const installed = await listInstalledModels(); const rows = []; const memoryNotes = []; const run = { calls: 0 };
  for (const model of a.models) {
    if (!installed.includes(model)) { rows.push({ model, skipped: 'not installed' }); memoryNotes.push(`${model}: not installed, skipped`); continue; }
    const free = await readFreeMemoryPercent();
    if (!(free >= MIN_FREE_PERCENT)) { rows.push({ model, skipped: `free memory ${free}% is under ${MIN_FREE_PERCENT}%` }); memoryNotes.push(`${model}: skipped, free memory ${free}% is under ${MIN_FREE_PERCENT}%`); continue; }
    memoryNotes.push(`${model}: free memory ${free}% before the run`);
    try {
      rows.push(await calibrateModel({ model, picked: chosen, askFor: () => localAsk({ run, maxCalls: 1000 }), now, logError: (m) => console.error(`caller error (${model}): ${m}`) }));
      const r = rows.at(-1); console.error(`${model}: good ${r.good.passed}/${r.good.total}, bad failed ${r.badFailed}/${r.badTotal}, misses ${r.misses}, real calls ${r.calls.real}`);
    } catch (e) { rows.push({ model, skipped: `stopped: ${e && e.message}` }); memoryNotes.push(`${model}: stopped (${e && e.message})`); if (e && e.guard) break; }
    finally { try { await unloadModel(model); } catch { /* best effort */ } }
  }
  const report = formatCalibration(rows, { date: now.toISOString().slice(0, 10), picked: chosen, skippedIdeas: skipped, memoryNotes });
  if (a.out) { fs.mkdirSync(path.dirname(a.out), { recursive: true }); fs.writeFileSync(a.out, report); console.log(`written ${a.out}`); } else console.log(report);
  console.log(JSON.stringify({ best: pickJudgeModel(rows), models: rows.map((r) => (r.skipped ? r : { model: r.model, goodPassed: `${r.good.passed}/${r.good.total}`, badFailed: `${r.badFailed}/${r.badTotal}`, misses: r.misses })) }));
}
const isMain = process.argv[1] && (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) main(process.argv.slice(2)).catch((e) => { console.error(`judge: ${e && e.guard ? 'stopped by guard: ' : ''}${e.message}`); process.exitCode = 1; });
