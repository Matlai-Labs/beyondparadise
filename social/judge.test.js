import './test-env.js';
// judge.js: the draft judge. Every model answer is an injected function; no model, no network, no real queue or log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILLER_PHRASES, JUDGE_QUESTION, DEFECTS, DEFECT_TYPES, fillerHits, splitSentences, deterministicChecks, judgeDraft, JUDGE_CHECKS, swapFigures, casesFor, cachedAsk, calibrateModel, pickJudgeModel, pickCalibrationIdeas, formatCalibration, CALIBRATION_TIMEOUT_MS } from './judge.js';
import { assembleParts, FIXED_LINES } from './caption.js';
import { GuardError, EmptyAnswerError } from './local-model.js';
import { rulesGate } from './rules-gate.js';

const IDEA = { id: 'idea_j1', sourceId: 'rule:dep', kind: 'rule', topic: 'official-rules', title: 'Zanzibar international departure charges', link: '/destinations/zanzibar/',
  claims: [{ text: 'Zanzibar international departure charges: Airport services charge, international 40 USD; Safety fee, international 9 USD (Zanzibar Revenue Authority, official page read 2026-11-17)', ruleId: 'r1', sourceDate: '2026-11-17' }] };
const ANS = { hook: 'Zanzibar departure charges: 40 USD airport services', caption: 'The airport services charge for international departures is 40 USD. The safety fee for international departures is 9 USD.', altText: 'Text card with the Zanzibar international departure charges.' };
const mk = (over = {}, ans = ANS, idea = IDEA) => { const p = assembleParts(idea, ans); return { kind: 'idea', claims: idea.claims, hook: p.hook, caption: ans.caption, altText: ans.altText, text: p.text, ...over }; };
const okCheck = async () => ({ ok: true, ruleIds: [], violations: [] });
const yes = JSON.stringify({ supported: true, extra: '' });
const no = (extra = 'the new part') => JSON.stringify({ supported: false, extra });
const recorder = (answer) => { const calls = []; const ask = async (req) => { calls.push(req); const a = typeof answer === 'function' ? answer(req, calls.length) : answer; if (a instanceof Error) throw a; return a; }; ask.calls = calls; return ask; };
const J = (draft, ask, extra = {}) => judgeDraft(draft, { ask, model: 'judge-model', now: new Date('2026-11-17T06:00:00Z'), check: okCheck, ...extra });
const ids = (r) => r.reasons.map((x) => x.check);

// ── constants ──
test('the filler list is one exported constant with every phrase of the brief; the question text and the defect sentences are exported constants', () => {
  for (const p of ['beautiful destination', 'hidden gem', 'paradise', 'breathtaking', 'must-see', 'bucket list', 'unforgettable', 'stunning', 'magical', 'once in a lifetime', "don't miss", 'make sure to', 'keep in mind']) assert.ok(FILLER_PHRASES.includes(p), p);
  assert.ok(Array.isArray(FILLER_PHRASES) && Object.isFrozen(FILLER_PHRASES));
  assert.equal(typeof JUDGE_QUESTION, 'string'); for (const w of ['supported', 'extra', 'JSON', 'event', 'cause', 'judgement', 'recommendation', 'time', 'place']) assert.ok(JUDGE_QUESTION.includes(w), w);
  assert.deepEqual(Object.keys(DEFECTS).sort(), ['actor-place', 'cause', 'event', 'first-person', 'judgement', 'recommendation', 'sea-remark']);
  assert.deepEqual(JUDGE_CHECKS.sort(), ['filler', 'final-check', 'judge-error', 'judge-unparsable', 'no-claims', 'no-model-text', 'number-not-in-claims', 'unsupported-statement']);
});
test('the defect sentences pass every deterministic gate, so a calibration miss or catch is the model\'s doing (rules gate checked here; voice and the rest in the full check below)', async () => {
  for (const [k, s] of Object.entries(DEFECTS)) {
    assert.deepEqual(rulesGate(s, { neverPromotePatterns: ['examplehotel'], claims: IDEA.claims }).violations, [], k);
    assert.deepEqual(fillerHits(s), [], k);
    const r = await deterministicChecks(mk({}, { ...ANS, caption: `${ANS.caption} ${s}` }), { check: undefined }); assert.deepEqual(r.map((x) => x.check), [], `${k}: ${JSON.stringify(r)}`);
  }
});

// ── filler, both sides ──
test('fillerHits: every phrase is caught whole and in any case; a part of a word or a different phrase is not', () => {
  for (const p of FILLER_PHRASES) { assert.deepEqual(fillerHits(`A line with ${p.toUpperCase()} in it.`), [p], p); assert.deepEqual(fillerHits(`${p[0].toUpperCase()}${p.slice(1)}.`), [p], p); }
  for (const ok of ['Paradises are not mentioned here', 'a stunningly plain sentence', 'the beautiful place is not on the list', 'make sure', 'keep mind']) assert.deepEqual(fillerHits(ok), [], ok);
  assert.deepEqual(fillerHits('Beyond Paradise Adventures research'), ['paradise'], 'the brand name IS a hit, which is why only model-written text is examined');
  assert.deepEqual(fillerHits("Don\u2019t miss it"), ["don't miss"], 'a curly apostrophe counts');
  assert.deepEqual(fillerHits('Do not miss it. Do not forget.'), []);
});

// ── sentences ──
test('splitSentences: on . ! ? followed by a capital or digit; abbreviations with a number after them stay whole', () => {
  assert.deepEqual(splitSentences('One fact here. Another fact! Is it a third? Yes.'), ['One fact here.', 'Another fact!', 'Is it a third?', 'Yes.']);
  assert.deepEqual(splitSentences('Government Notice No. 256 of 2026 applies.'), ['Government Notice No. 256 of 2026 applies.']);
  assert.deepEqual(splitSentences('  no end punctuation '), ['no end punctuation']); assert.deepEqual(splitSentences(''), []); assert.deepEqual(splitSentences(null), []);
});

// ── deterministic checks, both sides ──
test('deterministic: a draft that is clean passes and the model is asked', async () => {
  const ask = recorder(yes); const r = await J(mk(), ask);
  assert.equal(r.verdict, 'pass'); assert.deepEqual(r.reasons, []); assert.equal(r.model, 'judge-model'); assert.equal(typeof r.seconds, 'number'); assert.ok(ask.calls.length >= 2);
});
test('deterministic: no claims fails (no-claims) and the model is never asked', async () => {
  for (const claims of [undefined, [], [{ text: '' }], 'x']) { const ask = recorder(yes); const r = await J(mk({ claims }), ask); assert.equal(r.verdict, 'fail'); assert.ok(ids(r).includes('no-claims')); assert.equal(ask.calls.length, 0); }
});
test('deterministic: model text missing fails (no-model-text), the model is never asked', async () => {
  for (const over of [{ hook: '' }, { caption: undefined }, { hook: 5 }]) { const ask = recorder(yes); const r = await J(mk(over), ask); assert.equal(r.verdict, 'fail'); assert.ok(ids(r).includes('no-model-text')); assert.equal(ask.calls.length, 0); }
});
test('deterministic: the final check (voice and rules) must pass; its rule ids are the detail; no model call after a fail', async () => {
  const ask = recorder(yes); const bad = async () => ({ ok: false, ruleIds: ['paid-link-wording', 'voice-lint'] });
  const r = await J(mk(), ask, { check: bad }); assert.equal(r.verdict, 'fail'); assert.deepEqual(ids(r), ['final-check']); assert.match(r.reasons[0].detail, /paid-link-wording/); assert.equal(ask.calls.length, 0);
  const thrown = await J(mk(), ask, { check: async () => { throw new Error('boom'); } }); assert.equal(thrown.verdict, 'fail'); assert.ok(ids(thrown).includes('final-check')); assert.equal(ask.calls.length, 0);
});
test('deterministic: the real final check refuses booking words', async () => {
  const ask = recorder(yes); const draft = mk({}, { ...ANS, caption: `${ANS.caption} Book now to secure your place.` });
  const r = await judgeDraft(draft, { ask, model: 'm', now: new Date() }); assert.equal(r.verdict, 'fail'); assert.ok(ids(r).includes('final-check')); assert.equal(ask.calls.length, 0);
});
test('deterministic: number fidelity: a figure in no claim fails (number-not-in-claims); figures that are in the claims pass', async () => {
  const ask = recorder(yes); const r = await J(mk({}, { ...ANS, caption: 'The airport services charge is 45 USD.' }), ask);
  assert.equal(r.verdict, 'fail'); assert.ok(ids(r).includes('number-not-in-claims')); assert.match(r.reasons.find((x) => x.check === 'number-not-in-claims').detail, /45/); assert.equal(ask.calls.length, 0);
  const alt = await J(mk({}, { ...ANS, altText: 'A card about 77 charges.' }), ask); assert.ok(ids(alt).includes('number-not-in-claims'));
  assert.equal((await J(mk(), recorder(yes))).verdict, 'pass');
});
test('deterministic: filler praise fails outright (filler) in the hook, caption or alt text, naming the phrase; the code-added brand line is not examined', async () => {
  for (const where of ['hook', 'caption', 'altText']) { const ask = recorder(yes); const ans = { ...ANS, [where]: `${ANS[where]} A beautiful destination.` }; const r = await J(mk({}, ans), ask); assert.equal(r.verdict, 'fail', where); assert.ok(ids(r).includes('filler')); assert.match(r.reasons.find((x) => x.check === 'filler').detail, /beautiful destination/); assert.equal(ask.calls.length, 0); }
  const withBrandSource = mk({}, ANS, { ...IDEA, claims: [{ text: 'A claim of 5 words.', sourceDate: '2026-11-17' }] });
  assert.ok(/Beyond Paradise Adventures research|Beyond Paradise Adventures, read/.test(withBrandSource.text)); assert.deepEqual(await deterministicChecks({ ...withBrandSource, hook: 'A claim of 5 words', caption: 'A claim of 5 words.', altText: 'Text card about a claim.' }, { check: okCheck }), []);
});
test('deterministic problems are all reported together (several reasons), still no model call', async () => {
  const ask = recorder(yes); const r = await J(mk({}, { ...ANS, caption: 'A stunning 99 USD charge.' }), ask, { check: async () => ({ ok: false, ruleIds: ['x'] }) });
  assert.deepEqual(ids(r).sort(), ['filler', 'final-check', 'number-not-in-claims']); assert.equal(ask.calls.length, 0);
});

// ── the model step ──
test('model: one closed question per model-written sentence (hook and caption), claim texts as the facts, temperature 0, the judge model, the question constant as the system text', async () => {
  const ask = recorder(yes); const d = mk(); await J(d, ask);
  const wanted = [...splitSentences(d.hook), ...splitSentences(d.caption)].filter((s, i, a) => a.indexOf(s) === i);
  assert.equal(ask.calls.length, wanted.length);
  for (const [i, c] of ask.calls.entries()) { assert.equal(c.system, JUDGE_QUESTION); assert.equal(c.model, 'judge-model'); assert.equal(c.temperature, 0); assert.ok(c.prompt.includes(IDEA.claims[0].text)); assert.ok(c.prompt.includes(wanted[i])); }
});
test('model: the lines code adds (source, pointer, hashtags) are never sent to the model', async () => {
  const ask = recorder(yes); const d = mk(); const parts = assembleParts(IDEA, ANS); assert.ok(parts.codeLines.length >= 3);
  await J(d, ask);
  for (const c of ask.calls) { for (const code of parts.codeLines) assert.ok(!c.prompt.includes(code) && !c.system.includes(code), `sent code line ${code}`); assert.ok(!c.prompt.includes(FIXED_LINES.pointer)); assert.ok(!/#\w/.test(c.prompt.split('Sentence:')[1] || '')); assert.ok(!(c.prompt.split('Sentence:')[1] || '').includes('Source:')); }
  assert.ok(ask.calls.length > 0);
});
test('model: a sentence the model calls unsupported fails the draft (unsupported-statement) with the sentence and the extra part; later sentences are not asked', async () => {
  const d = mk(); const sents = [...splitSentences(d.hook), ...splitSentences(d.caption)];
  const ask = recorder((req) => (req.prompt.includes(sents[1]) ? no('the safety fee') : yes)); const r = await J(d, ask);
  assert.equal(r.verdict, 'fail'); assert.deepEqual(ids(r), ['unsupported-statement']); assert.match(r.reasons[0].detail, /safety fee/); assert.ok(r.reasons[0].detail.includes(sents[1].slice(0, 30)));
  assert.equal(ask.calls.length, 2, 'the third sentence was not asked: a fail stops later model calls');
});
test('model: supported:false with an empty extra still fails', async () => { const r = await J(mk(), recorder(JSON.stringify({ supported: false, extra: '' }))); assert.equal(r.verdict, 'fail'); assert.deepEqual(ids(r), ['unsupported-statement']); });
test('model: unparsable, empty or odd answers fail closed (judge-unparsable) and stop the run of questions', async () => {
  for (const bad of ['not json at all', '', '   ', '{}', '{"supported":"yes"}', '{"supported":1}', '{"supported":null}', '[]', '"true"', 'true', null, undefined, 42]) {
    const ask = recorder(bad); const r = await J(mk(), ask); assert.equal(r.verdict, 'fail', String(bad)); assert.deepEqual(ids(r), ['judge-unparsable'], String(bad)); assert.equal(ask.calls.length, 1);
  }
});
test('model: JSON inside a code fence or after prose is read (the vendored loose parser)', async () => { assert.equal((await J(mk(), recorder('Here: ```json\n{"supported": true, "extra": ""}\n```'))).verdict, 'pass'); });
test('model: a caller error fails closed (judge-error); a guard refusal too, flagged, and no further question is asked', async () => {
  let ask = recorder(new Error('ollama HTTP 500')); let r = await J(mk(), ask); assert.deepEqual(ids(r), ['judge-error']); assert.match(r.reasons[0].detail, /500/); assert.equal(ask.calls.length, 1);
  ask = recorder(new EmptyAnswerError('empty')); r = await J(mk(), ask); assert.deepEqual(ids(r), ['judge-error']);
  ask = recorder(new GuardError('per-run cap of 120 calls reached')); r = await J(mk(), ask); assert.deepEqual(ids(r), ['judge-error']); assert.equal(r.reasons[0].guard, true); assert.equal(ask.calls.length, 1);
});
test('model: a missing ask function fails closed instead of passing', async () => { const r = await judgeDraft(mk(), { model: 'm', now: new Date(), check: okCheck }); assert.equal(r.verdict, 'fail'); assert.deepEqual(ids(r), ['judge-error']); });
test('result shape: verdict, reasons [{check, detail}], model, seconds (from the injected clock), at', async () => {
  let t = 0; const r = await J(mk(), recorder(yes), { clock: () => (t += 1.5) });
  assert.deepEqual(Object.keys(r).sort(), ['at', 'model', 'reasons', 'seconds', 'verdict']); assert.equal(r.seconds, 1.5); assert.equal(r.at, '2026-11-17T06:00:00.000Z');
  const f = await J(mk({ claims: [] }), recorder(yes)); for (const x of f.reasons) { assert.equal(typeof x.check, 'string'); assert.equal(typeof x.detail, 'string'); }
});

// ── the calibration set and its numbers ──
test('swapFigures: swaps the first two different figures, leaves dates alone, null when there are not two', () => {
  assert.equal(swapFigures('Airport charge 40 USD; safety fee 9 USD (read 2026-11-17)'), 'Airport charge 9 USD; safety fee 40 USD (read 2026-11-17)');
  assert.equal(swapFigures('USD 50 single entry (90 days)'), 'USD 90 single entry (50 days)');
  assert.equal(swapFigures('Only 40 USD, twice 40 USD'), null); assert.equal(swapFigures('No figures'), null); assert.equal(swapFigures('Read 2026-11-17 with 5 USD'), null);
});
test('casesFor: a good case of the verbatim claim sentences, one bad case per defect type, each bad case differs from the good one by exactly the defect', () => {
  const c = casesFor(IDEA); assert.equal(c.good.expected, 'pass'); const claim = `${IDEA.claims[0].text}.`; assert.equal(c.good.draft.caption, claim);
  assert.deepEqual(c.bad.map((b) => b.defect).sort(), [...DEFECT_TYPES].sort());
  for (const b of c.bad) { assert.equal(b.expected, 'fail'); if (b.defect !== 'number-swap') assert.equal(b.draft.caption, `${claim} ${DEFECTS[b.defect]}`); }
  const sw = c.bad.find((b) => b.defect === 'number-swap'); assert.match(sw.draft.caption, /40 USD; Safety fee, international 9 USD|9 USD; Safety fee, international 40 USD/); assert.notEqual(sw.draft.caption, claim);
  const noNum = casesFor({ ...IDEA, claims: [{ text: 'Mafia Island whale shark season and the marine park fee.', sourceDate: '2026-11-15' }] }); assert.ok(!noNum.bad.some((b) => b.defect === 'number-swap'), 'no two figures: no swap case');
  assert.equal(casesFor({ ...IDEA, claims: [] }), null);
  for (const x of [c.good, ...c.bad]) assert.ok(x.draft.text.includes('Source: ') && x.draft.hook && x.draft.altText);
});
test('every bad case of a real-shaped idea clears the deterministic step (the judge, not a regex, is what is measured)', async () => {
  const c = casesFor(IDEA); for (const x of [c.good, ...c.bad]) assert.deepEqual(await deterministicChecks(x.draft, { check: undefined }), [], x.defect || 'good');
});
test('pickCalibrationIdeas: takes ideas per kind in pool order, leaves out one whose good case fails the deterministic step, names it', async () => {
  const mkIdea = (i, kind, text) => ({ ...IDEA, id: `i${i}`, kind, claims: [{ text, sourceDate: '2026-11-17' }] });
  const ideas = [mkIdea(1, 'rule', 'Visa 50 USD; multiple 100 USD.'), mkIdea(2, 'rule', 'A stunning place.'), mkIdea(3, 'page', 'Page about reefs.'), mkIdea(4, 'fact', 'Kendwa is near Nungwi.')];
  const r = await pickCalibrationIdeas(ideas, { total: 14, check: okCheck }); assert.deepEqual(r.chosen.map((x) => x.idea.id), ['i1', 'i3', 'i4']); assert.deepEqual(r.skipped.map((x) => x.ideaId), ['i2']); assert.ok(r.skipped[0].why.includes('filler'));
});
test('cachedAsk: an identical question is answered once, real calls are counted and timed, an error text is logged and rethrown, the timeout is raised to 180 s', async () => {
  const seen = []; const errs = []; let n = 0; const inner = async (req) => { seen.push(req); n++; if (req.prompt === 'boom') throw new Error('ollama HTTP 500'); return yes; };
  let t = 0; const ask = cachedAsk(inner, { clock: () => (t += 2), logError: (m) => errs.push(m) });
  await ask({ model: 'm', system: 's', prompt: 'a' }); await ask({ model: 'm', system: 's', prompt: 'a' }); await ask({ model: 'm', system: 's', prompt: 'b' });
  await assert.rejects(ask({ model: 'm', system: 's', prompt: 'boom' }), /500/); await assert.rejects(ask({ model: 'm', system: 's', prompt: 'boom' }), /500/);
  assert.equal(n, 4); assert.equal(ask.stats.real, 4); assert.equal(ask.stats.hits, 1); assert.deepEqual(errs, ['ollama HTTP 500', 'ollama HTTP 500']); assert.deepEqual(ask.stats.errors, errs);
  assert.ok(seen.every((r) => r.timeoutMs === CALIBRATION_TIMEOUT_MS && CALIBRATION_TIMEOUT_MS === 180000)); assert.equal(ask.stats.seconds[0], 2);
});
test('calibrateModel: counts good passed, bad failed per defect type with the layer that caught them, misses with the judged sentence, unparsable and error counts', async () => {
  const picked = (await pickCalibrationIdeas([IDEA], { check: okCheck })).chosen;
  const answer = (req) => (/Operators in Arusha/.test(req.prompt) ? 'garbage' : /rough that morning/.test(req.prompt) ? yes : /announced/.test(req.prompt) ? no('announced') : /good value/.test(req.prompt) ? new Error('ollama HTTP 500') : /Safety fee, international 40/.test(req.prompt) ? yes : /rising demand|plan this well|Having seen/.test(req.prompt) ? no() : yes);
  const row = await calibrateModel({ model: 'm', picked, askFor: () => async (req) => { const a = answer(req); if (a instanceof Error) throw a; return a; }, check: okCheck });
  assert.equal(row.good.passed, 1); assert.equal(row.falseRefusals, 0);
  assert.equal(row.bad.event.byModel, 1); assert.equal(row.bad['actor-place'].failedClosed, 1); assert.equal(row.bad.judgement.failedClosed, 1); assert.equal(row.unparsable, 1); assert.equal(row.errors, 1);
  assert.equal(row.bad['sea-remark'].failed, 0); assert.deepEqual(row.bad['sea-remark'].misses.map((m) => m.sentence), [DEFECTS['sea-remark']]);
  assert.equal(row.bad['number-swap'].failed, 0); assert.equal(row.bad.cause.failed, 1);
  assert.equal(row.badTotal, 8); assert.equal(row.misses, row.badTotal - row.badFailed); assert.equal(row.misses, 2); assert.deepEqual(row.errorTexts, ['ollama HTTP 500']);
  assert.ok(row.calls.real > 0 && row.calls.cacheHits > 0);
});
test('pickJudgeModel: fewest misses, then fewest false refusals, then speed; skipped models never win', () => {
  const r = (model, misses, falseRefusals, s) => ({ model, misses, falseRefusals, meanSecondsPerGoodDraft: s, badTotal: 10 });
  assert.equal(pickJudgeModel([r('a', 3, 0, 1), r('b', 1, 5, 9), r('c', 1, 2, 9), { model: 'd', skipped: 'x' }]), 'c');
  assert.equal(pickJudgeModel([r('a', 1, 1, 5), r('b', 1, 1, 2)]), 'b'); assert.equal(pickJudgeModel([{ model: 'd', skipped: 'x' }]), null);
});
test('formatCalibration: says plainly at the top when the best model misses more than 1 bad case in 10, and lists every miss and every error text', async () => {
  const picked = (await pickCalibrationIdeas([IDEA], { check: okCheck })).chosen;
  const row = await calibrateModel({ model: 'm', picked, askFor: () => async () => yes, check: okCheck });
  const rep = formatCalibration([row, { model: 'z', skipped: 'free memory 9% is under 15%' }], { date: '2026-11-17', picked });
  assert.match(rep.split('\n').slice(0, 3).join('\n'), /STILL MISSES MORE THAN 1 BAD CASE IN 10: 8 of 8/); assert.ok(rep.includes(DEFECTS.event) && rep.includes('skipped: free memory 9%')); assert.ok(rep.includes('Caller error texts, m (0)'));
  const good = await calibrateModel({ model: 'm', picked, askFor: () => async (req) => (/Sentence: The |Sentence: This |Sentence: Operators|Sentence: Travellers|Sentence: Having|international 9 USD; Safety fee, international 40/.test(req.prompt) ? no() : yes), check: okCheck });
  assert.ok(!formatCalibration([good], { picked }).includes('STILL MISSES'));
});
