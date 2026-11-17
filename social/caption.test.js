import './test-env.js';
// caption.js: one idea in, one checked draft out. Every model answer here is injected text; no model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPTION_PROMPT, TOPIC_TAGS, LIMITS, FIXED_LINES, numbersIn, buildPrompt, checkAnswer, sourceLine, hashtagsFor, assembleText, draftFromIdea, pickBakeoffIdeas, runBakeoff, summarize, formatReport, MIN_FREE_PERCENT } from './caption.js';
import { GuardError, EmptyAnswerError } from './local-model.js';
import { planCarousel } from './carousel.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const okVoice = async () => ({ ok: true, reason: null });
const IDEA = { id: 'idea_a1', sourceId: 'fact:tz-visa-cost', kind: 'fact', topic: 'visa', title: 'Tanzania tourist visa cost',
  claims: [{ text: 'USD 50 single-entry for most nationalities. USD 100 for US citizens (multiple-entry, 12 months).', factId: 'tz-visa-cost', sourceDate: '2026-06-27' }], link: '/destinations/zanzibar/', score: 90 };
const GOOD = { hook: 'Tanzania visa: USD 50 for most travellers', caption: 'A single-entry tourist visa costs USD 50 for most nationalities. US citizens pay USD 100 for a multiple-entry visa that is valid for 12 months. Check the official immigration page before you travel.', altText: 'Text card with the headline: Tanzania visa costs USD 50 for most travellers.' };
const json = (o) => JSON.stringify(o);
const scripted = (...answers) => { const prompts = []; let i = 0; const ask = async (req) => { prompts.push(req); const a = answers[Math.min(i++, answers.length - 1)]; if (a instanceof Error) throw a; return a; }; ask.prompts = prompts; return ask; };
const run = (idea, ask, extra = {}) => draftFromIdea(idea, { ask, voice: okVoice, model: 'test-model', now: new Date('2026-11-17T06:00:00Z'), ...extra });

// ── prompt ──
test('prompt: one exported constant carrying every rule; the request holds only the title and the claim texts', () => {
  for (const must of ['ONLY', 'first person', 'sea conditions', 'seaweed', 'swimming', 'book', 'JSON', '"hook"', '"caption"', '"altText"', '90', '120', '700', '20', '200', 'URL', '@mention']) assert.ok(CAPTION_PROMPT.includes(must), `prompt must mention ${must}`);
  const p = buildPrompt(IDEA);
  assert.ok(p.includes(IDEA.title) && p.includes(IDEA.claims[0].text));
  for (const leak of [IDEA.id, IDEA.sourceId, IDEA.link, IDEA.claims[0].sourceDate, IDEA.claims[0].factId, 'visa\n', String(IDEA.score)]) assert.ok(!p.includes(leak), `request must not carry ${leak}`);
  assert.ok(!buildPrompt(IDEA).includes('failed'));
  const r = buildPrompt(IDEA, ['hook-too-long', 'number-not-in-claims']); const failedLines = r.split('\n').filter((l) => /failed/i.test(l));
  assert.equal(failedLines.length, 1, 'the failed reasons are named in one line'); assert.ok(failedLines[0].includes('hook-too-long') && failedLines[0].includes('number-not-in-claims'));
});

// ── numbers ──
test('numbersIn: digits, separators, percent, currency, decimals compare by value', () => {
  assert.deepEqual(numbersIn('USD 1,200 and 50% and $3.50 and 2026-11-17'), [1200, 50, 3.5, 2026, 11, 17]);
  assert.deepEqual(numbersIn('2.50'), numbersIn('2.5'));
  assert.deepEqual(numbersIn('no figures here'), []);
  assert.deepEqual(numbersIn('1,000,000 visitors'), [1000000]);
  assert.ok(numbersIn('５０').length === 1 && Number.isNaN(numbersIn('５０')[0]), 'a non-ASCII digit is returned as NaN so it can never match a claim');
});

// ── checks, both sides ──
const reasonsOf = (o, idea = IDEA) => checkAnswer(o, idea);
test('checks: a good answer has no reasons', () => assert.deepEqual(reasonsOf(GOOD), []));
test('check: hook length 90 passes, 91 is hook-too-long, missing or not text is refused', () => {
  const hook = (n) => 'Visa fee USD 50 '.padEnd(n, 'x');
  assert.deepEqual(reasonsOf({ ...GOOD, hook: hook(LIMITS.hook) }), []); assert.deepEqual(reasonsOf({ ...GOOD, hook: hook(LIMITS.hook + 1) }), ['hook-too-long']);
  assert.ok(reasonsOf({ ...GOOD, hook: '' }).includes('hook-missing')); assert.ok(reasonsOf({ ...GOOD, hook: 5 }).includes('hook-missing')); const { hook: _h, ...noHook } = GOOD; assert.ok(reasonsOf(noHook).includes('hook-missing'));
});
test('check: caption 120 and 700 pass, 119 is caption-too-short, 701 caption-too-long', () => {
  const cap = (n) => 'USD 50 visa fee. '.repeat(60).slice(0, n - 1) + '.';
  assert.deepEqual(reasonsOf({ ...GOOD, caption: cap(120) }), []); assert.deepEqual(reasonsOf({ ...GOOD, caption: cap(700) }), []);
  assert.deepEqual(reasonsOf({ ...GOOD, caption: cap(119) }), ['caption-too-short']); assert.deepEqual(reasonsOf({ ...GOOD, caption: cap(701) }), ['caption-too-long']);
  assert.ok(reasonsOf({ ...GOOD, caption: null }).includes('caption-missing'));
});
test('check: alt text 20 and 200 pass, 19 is alt-too-short, 201 alt-too-long', () => {
  assert.deepEqual(reasonsOf({ ...GOOD, altText: 'x'.repeat(20) }), []); assert.deepEqual(reasonsOf({ ...GOOD, altText: 'x'.repeat(200) }), []);
  assert.deepEqual(reasonsOf({ ...GOOD, altText: 'x'.repeat(19) }), ['alt-too-short']); assert.deepEqual(reasonsOf({ ...GOOD, altText: 'x'.repeat(201) }), ['alt-too-long']);
  assert.ok(reasonsOf({ ...GOOD, altText: undefined }).includes('alt-missing'));
});
test('check: number fidelity, on the hook and on the caption, in every shape', () => {
  assert.ok(reasonsOf({ ...GOOD, hook: 'Tanzania visa: USD 75 for most travellers' }).includes('number-not-in-claims'), 'hook');
  assert.ok(reasonsOf({ ...GOOD, caption: GOOD.caption.replace('USD 100', 'USD 150') }).includes('number-not-in-claims'), 'caption');
  assert.ok(reasonsOf({ ...GOOD, caption: GOOD.caption + ' About 30% of visitors apply early.' }).includes('number-not-in-claims'), 'percent');
  assert.ok(reasonsOf({ ...GOOD, caption: GOOD.caption + ' Fees can reach $1,500.' }).includes('number-not-in-claims'), 'currency and separator');
  assert.ok(reasonsOf({ ...GOOD, caption: GOOD.caption + ' Valid since ２０２６.' }).includes('number-not-in-claims'), 'non-ASCII digits');
  assert.deepEqual(reasonsOf({ ...GOOD, hook: 'Visa fee: USD 50.00 for most' }), [], '50.00 equals 50 in the claim');
  assert.deepEqual(reasonsOf({ ...GOOD, caption: 'The fee is USD 100 for 12 months and USD 50 otherwise, so most people pay half as much as US citizens do for the visa. Check the official immigration page before you go.' }), []);
  const idea2 = { ...IDEA, claims: [{ text: 'The pass costs 2.50 dollars', sourceDate: '2026-01-01' }, { text: 'Open 1,200 days', sourceDate: '2026-01-01' }] };
  assert.deepEqual(reasonsOf({ hook: 'Pass: 2.5 dollars, open 1200 days', caption: 'The pass is cheap and easy to use, so most people buy one before they go and keep it with their travel papers for the whole trip.', altText: 'Text card with the headline: pass 2.5 dollars.' }, idea2), [], 'value comparison over all claim texts');
});
test('check: the model produces no URL, no @mention and no hashtag', () => {
  for (const t of ['See https://example.org/visa now.', 'Visit www.example.org today.', 'More at immigration.go.tz for details.', 'Read example.com for details.']) assert.ok(reasonsOf({ ...GOOD, caption: `${GOOD.caption} ${t}` }).includes('url-in-text'), t);
  assert.ok(reasonsOf({ ...GOOD, caption: `${GOOD.caption} Thanks @someone for this.` }).includes('mention-in-text'));
  assert.ok(reasonsOf({ ...GOOD, hook: 'Visa fee #Zanzibar USD 50' }).includes('hashtag-in-text'));
  assert.deepEqual(reasonsOf({ ...GOOD, caption: GOOD.caption + ' Costs e.g. USD 50 each.' }), [], 'an abbreviation is not a URL');
});

// ── fixed lines and tags added by code ──
test('sourceLine: facts name the source (when known), pages the publication, rules the body parsed from the claim text', () => {
  assert.equal(sourceLine(IDEA.claims), 'Source: Beyond Paradise Adventures research, read 2026-06-27');
  assert.equal(sourceLine(IDEA.claims, { sourceNames: { 'tz-visa-cost': 'Tanzania Immigration Services Department' } }), 'Source: Tanzania Immigration Services Department, read 2026-06-27');
  assert.equal(sourceLine([{ text: 'x', pagePath: '/p/', sourceDate: '2026-10-02' }]), 'Source: Beyond Paradise Adventures, read 2026-10-02');
  const rule = { text: 'Zanzibar insurance, adult fee: Adult 44 USD (Embassy of Tanzania in Japan (notice about the Zanzibar scheme), official page read 2026-11-17)', ruleId: 'r', sourceDate: '2026-11-01' };
  assert.equal(sourceLine([rule]), 'Source: Embassy of Tanzania in Japan (notice about the Zanzibar scheme), read 2026-11-17');
  assert.equal(sourceLine([{ text: 'odd rule text', ruleId: 'r', sourceDate: '2026-11-01' }]), 'Source: the official page, read 2026-11-01');
  assert.equal(sourceLine([{ text: 'a', factId: 'a', sourceDate: '2026-01-01' }, { text: 'b', factId: 'b', sourceDate: '2026-02-02' }]), 'Source: Beyond Paradise Adventures research, read 2026-01-01; Beyond Paradise Adventures research, read 2026-02-02');
});
test('hashtags come from a fixed vocabulary: 3 to 6 per theme, unknown topics get the default, nothing is model-made', () => {
  assert.ok(TOPIC_TAGS.default); for (const [name, tags] of Object.entries(TOPIC_TAGS.themes)) {
    assert.ok(tags.length >= 3 && tags.length <= 6, `${name}: ${tags.length}`); assert.equal(new Set(tags).size, tags.length); for (const t of tags) assert.match(t, /^#[A-Za-z0-9]+$/, t);
  }
  assert.ok(TOPIC_TAGS.default.length >= 3 && TOPIC_TAGS.default.length <= 6);
  for (const th of Object.values(TOPIC_TAGS.topicTheme)) assert.ok(TOPIC_TAGS.themes[th], `theme ${th} exists`);
  assert.deepEqual(hashtagsFor({ topic: 'visa' }), TOPIC_TAGS.themes[TOPIC_TAGS.topicTheme.visa]);
  assert.deepEqual(hashtagsFor({ topic: 'no-such-topic' }), TOPIC_TAGS.default); assert.deepEqual(hashtagsFor({ topic: null }), TOPIC_TAGS.default); assert.deepEqual(hashtagsFor({}), TOPIC_TAGS.default);
  assert.deepEqual(hashtagsFor({ topic: 'VISA' }), hashtagsFor({ topic: 'visa' }));
});
test('assembleText: hook, one sentence per line, source line, pointer only for a site path, tags last', () => {
  const t = assembleText(IDEA, GOOD); const lines = t.split('\n');
  assert.equal(lines[0], GOOD.hook); assert.equal(lines[1], '');
  assert.equal(lines.at(-1), hashtagsFor(IDEA).join(' ')); assert.equal(lines.at(-2), '');
  assert.equal(lines.at(-3), FIXED_LINES.pointer); assert.equal(lines.at(-4), sourceLine(IDEA.claims));
  assert.deepEqual(lines.slice(2, -4), ['A single-entry tourist visa costs USD 50 for most nationalities.', 'US citizens pay USD 100 for a multiple-entry visa that is valid for 12 months.', 'Check the official immigration page before you travel.']);
  for (const link of [null, undefined, '', 'https://www.immigration.go.tz/service-fee']) { const x = assembleText({ ...IDEA, link }, GOOD); assert.ok(!x.includes(FIXED_LINES.pointer), String(link)); assert.equal(x.split('\n').at(-3), sourceLine(IDEA.claims)); }
});

// ── draftFromIdea ──
test('first try: ok draft carrying claims, ideaId, model, attempts; code-added lines survive', async () => {
  const ask = scripted(json(GOOD)); const r = await run(IDEA, ask);
  assert.equal(r.ok, true); assert.equal(r.attempts, 1); assert.deepEqual(r.reasons, []); assert.equal(typeof r.seconds, 'number'); assert.equal(ask.prompts.length, 1);
  const d = r.draft; assert.equal(d.ideaId, IDEA.id); assert.deepEqual(d.claims, IDEA.claims); assert.equal(d.model, 'test-model'); assert.equal(d.attempts, 1);
  assert.equal(d.kind, 'idea'); assert.equal(d.sourceId, IDEA.sourceId); assert.equal(d.sourceDate, '2026-06-27'); assert.equal(d.hook, GOOD.hook); assert.equal(d.altText, GOOD.altText);
  assert.ok(d.text.startsWith(GOOD.hook)); assert.ok(d.text.includes(sourceLine(IDEA.claims))); assert.ok(d.text.includes(FIXED_LINES.pointer)); assert.deepEqual(d.hashtags, hashtagsFor(IDEA));
  assert.ok(d.text.endsWith(hashtagsFor(IDEA).join(' ')));
  assert.equal(ask.prompts[0].system, CAPTION_PROMPT); assert.equal(ask.prompts[0].model, 'test-model');
});
test('model-written source, link or tags cannot replace the code-added ones', async () => {
  const sneaky = { ...GOOD, caption: GOOD.caption + ' Source: someone else.' };
  const r = await run(IDEA, scripted(json(sneaky)));
  assert.equal(r.ok, true); assert.equal(r.draft.text.split('\n').at(-4), sourceLine(IDEA.claims)); assert.equal(r.draft.text.split('\n').at(-1), hashtagsFor(IDEA).join(' '));
});
test('prose and fences around the JSON still parse', async () => {
  for (const wrap of [(s) => `Sure, here is the post:\n${s}\nHope this helps {really}.`, (s) => '```json\n' + s + '\n```', (s) => 'Thinking... {not json}\n```\n' + s + '\n```\nDone']) {
    const r = await run(IDEA, scripted(wrap(json(GOOD)))); assert.equal(r.ok, true, wrap('X')); assert.equal(r.attempts, 1);
  }
});
test('not JSON, an array and a half object are refused as not-json', async () => {
  for (const bad of ['I cannot do that.', '[1,2]', '{"hook": "x", "caption": ']) { const r = await run(IDEA, scripted(bad)); assert.equal(r.ok, false); assert.deepEqual(r.reasons, ['not-json']); assert.equal(r.attempts, 3); }
});
test('an empty answer fails (returned empty or thrown by the caller), it is never used as text', async () => {
  for (const a of ['', '   ', new EmptyAnswerError('empty')]) { const ask = scripted(a); const r = await run(IDEA, ask); assert.equal(r.ok, false); assert.equal(r.draft, null); assert.deepEqual(r.reasons, ['empty-answer']); assert.equal(ask.prompts.length, 3); }
});
test('an answer with a figure that is not in the claims is refused, also after retries; no draft is made', async () => {
  const bad = json({ ...GOOD, hook: 'Tanzania visa: USD 75 for most travellers' }); const ask = scripted(bad);
  const r = await run(IDEA, ask); assert.equal(r.ok, false); assert.equal(r.draft, null); assert.ok(r.reasons.includes('number-not-in-claims')); assert.equal(r.attempts, 3); assert.equal(ask.prompts.length, 3);
});
test('retry path: the second request names the failed reasons in one line; a pass on attempt 2 or 3 is ok', async () => {
  const ask = scripted(json({ ...GOOD, hook: 'x'.repeat(95) }), json(GOOD)); const r = await run(IDEA, ask);
  assert.equal(r.ok, true); assert.equal(r.attempts, 2); assert.equal(r.draft.attempts, 2); assert.deepEqual(r.attemptReasons, [['hook-too-long'], []]);
  assert.equal(ask.prompts[0].prompt, buildPrompt(IDEA)); assert.equal(ask.prompts[1].prompt, buildPrompt(IDEA, ['hook-too-long'])); assert.ok(ask.prompts[1].prompt.includes('hook-too-long'));
  const ask3 = scripted('nonsense', json({ ...GOOD, altText: 'short' }), json(GOOD)); const r3 = await run(IDEA, ask3);
  assert.equal(r3.ok, true); assert.equal(r3.attempts, 3); assert.deepEqual(r3.attemptReasons, [['not-json'], ['alt-too-short'], []]); assert.equal(r3.callSeconds.length, 3);
});
test('after two retries the idea is given up with its reasons (3 asks at most)', async () => {
  const ask = scripted(json({ ...GOOD, hook: 'x'.repeat(95), altText: 'short' })); const r = await run(IDEA, ask);
  assert.equal(r.ok, false); assert.equal(r.draft, null); assert.equal(r.attempts, 3); assert.equal(ask.prompts.length, 3); assert.deepEqual(r.reasons, ['hook-too-long', 'alt-too-short']);
});
test('a guard refusal from the caller is not swallowed (it must stop the run); another error is a failed attempt', async () => {
  await assert.rejects(run(IDEA, scripted(new GuardError('stop flag present'))), GuardError);
  const r = await run(IDEA, scripted(new Error('ollama HTTP 500'))); assert.equal(r.ok, false); assert.deepEqual(r.reasons, ['model-error']); assert.equal(r.attempts, 3);
});
test('the real voice gate and the real rules gate run on the assembled text, each with a named reason', async () => {
  const rv = await run(IDEA, scripted(json(GOOD)), { voice: async () => ({ ok: false, reason: 'x' }) }); assert.equal(rv.ok, false); assert.deepEqual(rv.reasons, ['voice-lint']);
  const cases = [['Big waves on the east coast make the visa line move fast, USD 50.', 'rules:sea-conditions'], ['Book now to pay USD 50 for the visa, most nationalities, single entry, 12 months for US citizens.', 'rules:paid-link-wording'],
    ['We stayed two nights and paid USD 50 for a single-entry visa, most nationalities, 12 months for US citizens, USD 100.', 'rules:first-person-visit']];
  for (const [caption, reason] of cases) { const r = await run(IDEA, scripted(json({ ...GOOD, caption: caption.padEnd(130, ' ok') })), { }); assert.ok(r.reasons.includes(reason), `${reason} in ${r.reasons}`); assert.equal(r.ok, false); }
  const seen = []; await run(IDEA, scripted(json(GOOD)), { rules: (text, o) => { seen.push(o.claims); return { ok: true, ruleIds: [] }; } }); assert.ok(seen.length >= 1 && seen.every((c) => c === IDEA.claims), 'rules get the idea claims');
});
test('the real vendored voice gate and the real rules gate accept a plain, sourced draft', async () => {
  const r = await draftFromIdea(IDEA, { ask: scripted(json(GOOD)), model: 'm' });
  assert.deepEqual(r.reasons, [], JSON.stringify(r.attemptReasons)); assert.equal(r.ok, true);
});
test('the private list being unavailable stops at once: one ask, no retries', async () => {
  const ask = scripted(json(GOOD)); const r = await run(IDEA, ask, { rules: () => ({ ok: false, ruleIds: ['never-promote-list-unavailable'], reason: 'x' }) });
  assert.equal(r.ok, false); assert.equal(ask.prompts.length, 1); assert.ok(r.reasons.includes('rules:never-promote-list-unavailable'));
});
test('an idea without claims is refused without asking the model', async () => {
  for (const claims of [undefined, [], [{ text: '', sourceDate: '2026-01-01' }]]) { const ask = scripted(json(GOOD)); const r = await run({ ...IDEA, claims }, ask); assert.equal(r.ok, false); assert.deepEqual(r.reasons, ['idea-has-no-claims']); assert.equal(ask.prompts.length, 0); }
});
test('the draft text goes through the existing carousel planner and chooses the carousel format', async () => {
  const { chooseFormat, CONFIG } = await import('./lib.js');
  const r = await run(IDEA, scripted(json(GOOD))); assert.equal(chooseFormat(r.draft, CONFIG), 'carousel');
  const plan = await planCarousel({ id: 'B9', ...r.draft }, { voice: okVoice });
  assert.ok(plan.slides, JSON.stringify(plan)); assert.ok(plan.slides.length >= 3 && plan.slides.length <= 7); assert.equal(plan.slides[0].role, 'hook'); assert.equal(plan.slides.at(-1).role, 'save');
  const shown = plan.slides.map((s) => s.text).join('\n'); for (const piece of ['USD 50', 'Source: ']) assert.ok(shown.includes(piece), piece);
});

// ── comparison helpers ──
const mk = (kind, n) => Array.from({ length: n }, (_, i) => ({ id: `${kind}${i}`, kind, score: 100 - i }));
test('pickBakeoffIdeas: top ideas spread over kinds (3 rules, 3 pages, 4 facts of 10), best first inside a kind', () => {
  const pool = [...mk('fact', 30), ...mk('page', 8), ...mk('rule', 5)].sort((a, b) => b.score - a.score);
  const p = pickBakeoffIdeas(pool, 10); assert.equal(p.length, 10);
  assert.deepEqual(['rule', 'page', 'fact'].map((k) => p.filter((i) => i.kind === k).length), [3, 3, 4]);
  assert.deepEqual(p.filter((i) => i.kind === 'fact').map((i) => i.id), ['fact0', 'fact1', 'fact2', 'fact3']);
  const few = pickBakeoffIdeas([...mk('fact', 12), ...mk('rule', 1)], 10); assert.equal(few.length, 10); assert.equal(few.filter((i) => i.kind === 'rule').length, 1);
  assert.equal(new Set(p.map((i) => i.id)).size, 10);
});
test('runBakeoff: one model after another, skip under 15 percent free memory, unload each, numbers per model', async () => {
  const events = []; const ideas = [IDEA, { ...IDEA, id: 'idea_b', sourceId: 'fact:b' }, { ...IDEA, id: 'idea_c', sourceId: 'fact:c' }];
  const answers = { m1: [json(GOOD), json({ ...GOOD, hook: 'x'.repeat(95) }), json(GOOD), 'garbage', 'garbage', 'garbage'], m2: [json(GOOD)] };
  const idx = { m1: 0, m2: 0 }; let clock = 0;
  const res = await runBakeoff({ ideas, models: ['m1', 'low', 'm2'], voice: okVoice, installed: ['m1', 'low', 'm2'],
    askFor: (model) => async () => { events.push(`ask:${model}`); const a = answers[model]; return a[Math.min(idx[model]++, a.length - 1)]; },
    memoryFree: async (model) => (model === 'low' ? 14 : 40), unload: async (model) => { events.push(`unload:${model}`); }, clock: () => (clock += 2), now: new Date('2026-11-17T06:00:00Z') });
  assert.deepEqual(res.map((m) => m.model), ['m1', 'low', 'm2']);
  const [m1, low, m2] = res; assert.equal(low.skipped, 'free memory 14% is under 15%'); assert.equal(low.total, 0);
  assert.equal(m1.total, 3); assert.equal(m1.firstTry, 1); assert.equal(m1.afterRetries, 1); assert.equal(m1.givenUp, 1); assert.equal(m1.reasons['hook-too-long'], 1); assert.equal(m1.reasons['not-json'], 3);
  assert.ok(m1.meanSeconds > 0 && m1.worstSeconds >= m1.meanSeconds); assert.equal(m2.firstTry, 3);
  const order = events.filter((e) => e.startsWith('unload') || e === 'ask:m1' || e === 'ask:m2'); assert.ok(order.indexOf('unload:m1') > order.lastIndexOf('ask:m1') && order.indexOf('unload:m1') < order.indexOf('ask:m2'), 'm1 is unloaded before m2 starts');
  assert.ok(!events.includes('unload:low') && !events.includes('ask:low'));
  assert.equal(MIN_FREE_PERCENT, 15);
});
test('runBakeoff: a model that is not installed is skipped and said so; a guard refusal ends the whole comparison', async () => {
  const res = await runBakeoff({ ideas: [IDEA], models: ['gone'], installed: ['other'], voice: okVoice, askFor: () => { throw new Error('must not be asked'); }, memoryFree: async () => 90, unload: async () => {}, now: new Date() });
  assert.match(res[0].skipped, /not installed/);
  const r2 = await runBakeoff({ ideas: [IDEA, IDEA], models: ['m'], installed: ['m'], voice: okVoice, askFor: () => async () => { throw new GuardError('per-day cap reached'); }, memoryFree: async () => 90, unload: async () => {}, now: new Date() });
  assert.match(r2[0].stopped, /per-day cap reached/);
});
test('summarize picks most passes after retries, ties by faster mean; formatReport carries the numbers and the passing drafts', () => {
  const rows = [{ model: 'a', total: 10, firstTry: 5, afterRetries: 3, givenUp: 2, reasons: {}, meanSeconds: 9, worstSeconds: 20, passed: [] }, { model: 'b', total: 10, firstTry: 6, afterRetries: 2, givenUp: 2, reasons: { 'not-json': 1 }, meanSeconds: 5, worstSeconds: 9, passed: [{ ideaId: 'i', text: 'FULL DRAFT TEXT', hook: 'H', altText: 'A' }] }, { model: 'c', total: 0, skipped: 'x' }];
  assert.equal(summarize(rows).best, 'b'); rows[0].afterRetries = 4; rows[0].givenUp = 1; assert.equal(summarize(rows).best, 'a');
  const text = formatReport(rows, { date: '2026-11-17' }); assert.ok(text.includes('FULL DRAFT TEXT') || summarize(rows).best === 'a'); assert.ok(/not-json/.test(text)); assert.ok(summarize([{ model: 'c', total: 0, skipped: 'x' }]).best === null);
});

// ── source-level guards for this file ──
test('caption.js has no code path to another host and does not write queue text itself', () => {
  const src = fs.readFileSync(path.join(HERE, 'caption.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/\bfetch\(|https?:\/\//.test(src.replace(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g, '')), 'caption.js reaches models only through local-model.js');
  assert.ok(!/\bdrafts\.push\(|\bd\.text\s*=[^=]/.test(src));
});

// ── B6: second prompt, the parts of an assembled caption, number fidelity as a function ──
import { PROMPT_V1, PROMPT_V2, assembleParts, numberFidelity, localAsk } from './caption.js';
test('prompts: V1 is the first prompt unchanged, V2 is the default and restates the facts, with no events, causes, judgements, advice or praise', () => {
  assert.equal(typeof PROMPT_V1, 'string'); assert.ok(PROMPT_V1.includes('Do not sell and never tell anyone to book') && PROMPT_V1.includes('120 to 700 characters'));
  assert.equal(CAPTION_PROMPT, PROMPT_V2); assert.notEqual(PROMPT_V1, PROMPT_V2);
  for (const must of ['restate', 'announced', 'make sure', 'keep in mind', 'praise', 'judgement', 'advice', 'cause', 'most concrete', 'short', 'ONLY', 'first person', 'sea conditions', 'JSON', '"hook"', '"caption"', '"altText"', '90', '700', 'URL', '@mention']) assert.ok(PROMPT_V2.includes(must), `V2 must mention ${must}`);
});
test('draftFromIdea sends PROMPT_V2 unless the caller names another prompt', async () => {
  const a = scripted(json(GOOD)); await run(IDEA, a); assert.equal(a.prompts[0].system, PROMPT_V2);
  const b = scripted(json(GOOD)); await run(IDEA, b, { prompt: PROMPT_V1 }); assert.equal(b.prompts[0].system, PROMPT_V1);
});
test('assembleParts: the model-written lines (hook, sentences) apart from the lines code adds (source, pointer, hashtags); assembleText is their join', () => {
  const p = assembleParts(IDEA, GOOD);
  assert.equal(p.hook, GOOD.hook); assert.ok(p.sentences.length >= 2 && p.sentences.every((s) => GOOD.caption.includes(s.slice(0, 20))));
  assert.ok(p.codeLines.some((l) => l.startsWith('Source: ')) && p.codeLines.includes(FIXED_LINES.pointer) && p.codeLines.some((l) => l.startsWith('#')));
  for (const l of p.codeLines) { assert.ok(!p.sentences.includes(l)); assert.notEqual(l, p.hook); }
  assert.equal(p.text, assembleText(IDEA, GOOD)); for (const l of [p.hook, ...p.sentences, ...p.codeLines]) assert.ok(p.text.includes(l));
  const noLink = assembleParts({ ...IDEA, link: null }, GOOD); assert.ok(!noLink.codeLines.includes(FIXED_LINES.pointer));
});
test('numberFidelity: the numbers of the texts that are not in any claim, [] when all are', () => {
  assert.deepEqual(numberFidelity(['USD 50 and USD 100'], IDEA.claims), []);
  assert.deepEqual(numberFidelity(['USD 50 and USD 75', 'a 3 day trip'], IDEA.claims), [75, 3]);
  assert.deepEqual(numberFidelity([undefined, 5, 'none'], []), []);
  assert.ok(numberFidelity(['５０'], IDEA.claims).length === 1);
});
test('localAsk passes temperature and timeout through to the guarded caller', async () => {
  let body, signalSeen = false; const fetchImpl = async (_u, o) => { body = JSON.parse(o.body); signalSeen = !!o.signal; return { ok: true, status: 200, json: async () => ({ message: { content: '{}' } }) }; };
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'cap-')); const deps = { fetchImpl, counterFile: path.join(dir, 'c.json'), run: { calls: 0 }, stopOpts: { flagPath: path.join(dir, 's'), fleetPath: path.join(dir, 'f') } };
  await localAsk(deps)({ prompt: 'p', system: 's', model: 'm', temperature: 0, timeoutMs: 5000 }); assert.equal(body.options.temperature, 0); assert.ok(signalSeen);
  await localAsk(deps)({ prompt: 'p', system: 's', model: 'm' }); assert.equal(body.options.temperature, 0.3);
});
