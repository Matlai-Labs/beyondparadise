import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { planCarousel, slidePlan, carouselSpec, renderCarousel, MAX_CAROUSEL_IMAGES } from './carousel.js';
import { igPublishCarousel, draftFromItem, CONFIG } from './lib.js';

const okVoice = async () => ({ ok: true, reason: null });
const item = { signal: { id: 's1', subject: 'Zanzibar August 2026 arrivals', region: 'zanzibar', summary: 'Zanzibar tourism arrivals hit record 124,481 in August', confidence: 0.86, sourceIds: ['a', 'b', 'c'] },
  whyItMatters: "Zanzibar's August arrivals hit a record, signaling demand beyond peak-season expectations. This puts pressure on accommodation and transport across the island. Operators pricing on old benchmarks risk underselling.",
  whatToDo: 'Hotels should revisit August rate positioning now. Tour operators should confirm supplier capacity early.', confidence: 0.86, sources: [{}, {}, {}], date: '2026-09-14' };
const signal = () => ({ id: 'B9', ...draftFromItem(item) });
const norm = (s) => s.replace(/\s+/g, ' ').toLowerCase();

test('plan: 3-7 slides, hook first (<=8 words), brand-in-full last, no link', async () => {
  const d = signal(); const { slides, rejected } = await planCarousel(d, { voice: okVoice });
  assert.equal(rejected, undefined); assert.ok(slides.length >= 3 && slides.length <= 7, `n=${slides.length}`);
  assert.equal(slides[0].role, 'hook'); assert.ok(slides[0].text.split(/\s+/).length <= 8);
  const last = slides.at(-1); assert.equal(last.role, 'save'); assert.match(last.text, /Beyond Paradise Adventures/); assert.doesNotMatch(last.text, /https?:|www\./);
  for (const s of slides) assert.doesNotMatch(s.text, /Beyond Paradise(?! Adventures)/);
});
test('plan: every hook/fact slide text comes from the draft text; no invented numbers', async () => {
  const d = signal(); const { slides } = await planCarousel(d, { voice: okVoice }); const src = norm(d.text);
  for (const s of slides.filter((x) => x.role !== 'save')) assert.ok(src.includes(norm(s.text)), `not in source: ${s.text}`);
  const srcNums = new Set(d.text.match(/\d[\d,.]*/g));
  for (const s of slides) for (const n of s.text.match(/\d[\d,.]*/g) || []) assert.ok(srcNums.has(n), `invented number ${n}`);
});
test('plan: outlook draft works (one fact per region line)', async () => {
  const d = { id: 'B1', kind: 'outlook', region: 'all', sourceDate: '2026-09-13', text: "Demand outlook, next 8 weeks — 13 September 2026\n\nDar es Salaam: rising (82% confidence) — Peak dry season over the next ~8 weeks (Sep→Oct→Nov); Affordability backdrop: EUR ≈ 3,069.1 TZS\nZanzibar: rising (82% confidence) — Peak dry season over the next ~8 weeks (Sep→Oct→Nov)\n\nThis is what my intelligence engine reads from public data every morning. When the numbers move, I say so; when they don't, I say nothing.\n— Tim, Beyond Paradise Adventures\n\n#BeyondParadiseAdventures" };
  const { slides, rejected } = await planCarousel(d, { voice: okVoice }); assert.equal(rejected, undefined);
  assert.ok(slides.length >= 3); assert.equal(slides[0].text, 'Demand outlook, next 8 weeks');
  assert.ok(slides.some((s) => /^Zanzibar: rising/.test(s.text)));
  const src = norm(d.text); for (const s of slides.filter((x) => x.role !== 'save')) assert.ok(src.includes(norm(s.text)), `not in source: ${s.text}`);
});
test('plan: a 13-word What changed is the whole hook (was cut to 8 before 16 Nov 2026)', async () => {
  const base = signal(); const d = { ...base, text: base.text.replace('Zanzibar tourism arrivals hit record 124,481 in August', 'Zanzibar tourism arrivals hit a brand new record of 124,481 visitors in August') };
  const { slides } = await planCarousel(d, { voice: okVoice }); assert.equal(slides[0].text, 'Zanzibar tourism arrivals hit a brand new record of 124,481 visitors in August');
});
test('plan: voice-lint failure blocks (fail closed), as does lint unavailable', async () => {
  const r = await planCarousel(signal(), { voice: async (t) => ({ ok: !/record/.test(t), reason: 'slop' }) }); assert.match(r.rejected, /voice-lint/); assert.equal(r.slides, undefined);
  const r2 = await planCarousel(signal(), { voice: async () => ({ ok: false, reason: 'voice-lint unavailable' }) }); assert.match(r2.rejected, /voice-lint/);
});
test('plan: voice-lint runs on every slide, not just the whole draft', async () => {
  const seen = []; await planCarousel(signal(), { voice: async (t) => { seen.push(t); return { ok: true }; } });
  assert.ok(seen.length >= 3); assert.ok(seen.some((t) => /Beyond Paradise Adventures/.test(t)));
});
test('plan: brandGuard and sourceGate block; draft with too little content is rejected', async () => {
  const base = signal(); const bad = { ...base, text: base.text.replace('— Tim, Beyond Paradise Adventures', '— Tim, Beyond Paradise') };
  assert.match((await planCarousel(bad, { voice: okVoice })).rejected, /brand/);
  assert.match((await planCarousel({ ...base, sourceCount: 1 }, { voice: okVoice })).rejected, /sources/);
  assert.match((await planCarousel({ id: 'x', kind: 'outlook', text: 'Only a title — 1 May 2026' }, { voice: okVoice })).rejected, /too little/);
});
test('carousel cap is 10 and config stays on reel', () => { assert.equal(MAX_CAROUSEL_IMAGES, 10); assert.equal(CONFIG.instagram.format, 'reel'); });

test('render: N PNGs of 1080x1350 with slide counter in spec', async () => {
  const d = signal(); const { slides } = await planCarousel(d, { voice: okVoice });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-car-')); const files = renderCarousel(d, slides, out);
  assert.equal(files.length, slides.length); assert.equal(carouselSpec(d, slides).slides[1].counter, `2/${slides.length}`);
  for (const f of files) { assert.ok(fs.existsSync(f)); const sz = execFileSync('python3', ['-c', 'import sys;from PIL import Image;print(*Image.open(sys.argv[1]).size)', f]).toString().trim(); assert.equal(sz, '1080 1350'); }
  fs.rmSync(out, { recursive: true, force: true });
});

test('publish: children -> parent -> media_publish, in order, correct params', async () => {
  const calls = []; let n = 0;
  const post = async (p, form) => { calls.push({ p, form }); return { id: `id${++n}` }; };
  const r = await igPublishCarousel('cap', ['https://x/1.png', 'https://x/2.png', 'https://x/3.png'], { post, status: async () => ({ status_code: 'FINISHED' }), igUserId: 'IG', sleep: async () => {}, info: async () => ({ permalink: 'pl' }) });
  assert.deepEqual(calls.map((c) => c.p), ['IG/media', 'IG/media', 'IG/media', 'IG/media', 'IG/media_publish']);
  calls.slice(0, 3).forEach((c, i) => { assert.equal(c.form.is_carousel_item, 'true'); assert.equal(c.form.image_url, `https://x/${i + 1}.png`); assert.equal(c.form.caption, undefined); });
  assert.equal(calls[3].form.media_type, 'CAROUSEL'); assert.equal(calls[3].form.children, 'id1,id2,id3'); assert.equal(calls[3].form.caption, 'cap');
  assert.deepEqual(calls[4].form, { creation_id: 'id4' }); assert.equal(r.published, true); assert.equal(r.format, 'carousel'); assert.equal(r.permalink, 'pl');
});
test('publish: refuses >10 and <2 images before any call; child ERROR aborts before parent', async () => {
  const calls = []; const post = async (p) => { calls.push(p); return { id: 'i' + calls.length }; };
  await assert.rejects(igPublishCarousel('c', Array.from({ length: 11 }, (_, i) => `https://x/${i}.png`), { post, igUserId: 'IG' }), /2-10/);
  await assert.rejects(igPublishCarousel('c', ['https://x/1.png'], { post, igUserId: 'IG' }), /2-10/); assert.equal(calls.length, 0);
  await assert.rejects(igPublishCarousel('c', ['https://x/1.png', 'https://x/2.png'], { post, igUserId: 'IG', sleep: async () => {}, status: async () => ({ status_code: 'ERROR', status: 'bad' }) }), /child container error/);
  assert.ok(!calls.includes('IG/media_publish')); assert.equal(calls.length, 1);
});

// --- hook slide never ends on dangling punctuation (B25 regression) ---
const b25Text = (changed) => `Iberostar Selection Zanzibar — Zanzibar\n\nWhat changed: ${changed}\nWhy it matters: The resort sits in the far north of Zanzibar, near Matemwe, with views of Mnemba Island. Iberostar has announced the opening.\nWhat I'd do: Treat it as new and unscored. We score a lodge only after a paid stay of our own.\n\nHow we choose where to stay: https://beyondparadiseadventures.com/about/tim-score/\n\n— Tim, Beyond Paradise Adventures\n\n#BeyondParadiseAdventures #Zanzibar #Tanzania`;
const b25 = (changed = "Iberostar Selection Zanzibar has opened on Muyuni Beach, the group's first hotel in Tanzania") => ({ id: 'B25', kind: 'signal', region: 'zanzibar', sourceDate: '2026-11-10', sourceCount: 2, text: b25Text(changed) });
test('plan: hook slide does not end on dangling punctuation (B25)', async () => {
  const { slides, rejected } = await planCarousel(b25(), { voice: okVoice }); assert.equal(rejected, undefined);
  assert.doesNotMatch(slides[0].text, /[,;:–—\s]$/); assert.equal(slides[0].text, "Iberostar Selection Zanzibar has opened on Muyuni Beach, the group's first hotel in Tanzania");
});
test('plan: a trailing , ; : – — on the hook is stripped', async () => {
  for (const p of [';', ':', ' –', ' —', ' ,']) {
    const { slides } = await planCarousel(b25(`Iberostar Selection Zanzibar has opened on Muyuni Beach${p}`), { voice: okVoice });
    assert.equal(slides[0].text, 'Iberostar Selection Zanzibar has opened on Muyuni Beach', `p=${p}`);
  }
});
test('plan: hook that ends with a full stop is unchanged', async () => {
  const { slides } = await planCarousel(b25('The new resort opened on Muyuni Beach today.'), { voice: okVoice });
  assert.equal(slides[0].text, 'The new resort opened on Muyuni Beach today.');
});

// --- section-aware signal plan (a reader refused the interleaved slides on 16 Nov 2026) ---
const fixture = { id: 'B25', kind: 'signal', region: 'zanzibar', sourceDate: '2026-11-07', sourceCount: 2, text: b25Text("Iberostar Selection Zanzibar has opened on Muyuni Beach, the group's first hotel in Tanzania") };
const sigText = (wc, why, todo, conf = '') => `Headline Place — Zanzibar\n\nWhat changed: ${wc}\nWhy it matters: ${why}\nWhat I'd do: ${todo}\n${conf ? `\n${conf}\n` : ''}\n— Tim, Beyond Paradise Adventures\n\n#BeyondParadiseAdventures`;
const sig = (wc, why, todo, conf) => ({ id: 'S', kind: 'signal', region: 'zanzibar', sourceDate: '2026-11-07', sourceCount: 3, text: sigText(wc, why, todo, conf) });
const wordsN = (n, p = 'w') => Array.from({ length: n }, (_, i) => `${p}${i + 1}`).join(' ');

test('sections: B25 fixture gives 4 slides, in section order, each with its own label', () => {
  const { slides } = slidePlan(fixture);
  assert.deepEqual(slides.map((s) => [s.role, s.label, s.text]), [
    ['hook', 'What changed', "Iberostar Selection Zanzibar has opened on Muyuni Beach, the group's first hotel in Tanzania"],
    ['fact', 'Why it matters', 'The resort sits in the far north of Zanzibar, near Matemwe, with views of Mnemba Island. Iberostar has announced the opening.'],
    ['fact', "What I'd do", 'Treat it as new and unscored. We score a lodge only after a paid stay of our own.'],
    ['save', undefined, 'Save this for later.\n— Tim, Beyond Paradise Adventures'],
  ]);
});
test('sections: long What changed (>16 words) -> headline hook, then full statement slide labelled What changed', () => {
  const wc = 'Iberostar Selection Zanzibar has opened on Muyuni Beach as the group first hotel in Tanzania and the first of its kind on the island';
  assert.ok(wc.split(' ').length > 16);
  const { slides } = slidePlan(sig(wc, 'It sits in the north of the island. It has a pool.', 'Wait and see. Do not book yet please.'));
  assert.equal(slides[0].text, 'Headline Place'); assert.equal(slides[0].label, 'What changed');
  assert.deepEqual([slides[1].text, slides[1].label], [wc, 'What changed']);
  assert.equal(slides[2].label, 'Why it matters'); assert.equal(slides[3].label, "What I'd do");
});
test('sections: exactly 16 words is still a whole hook; trailing dangling marks stripped', () => {
  const wc = wordsN(15) + ' last;'; const { slides } = slidePlan(sig(wc, 'It is quiet here today. Nothing else.', 'Wait and see. Do not book yet.'));
  assert.equal(slides[0].text, wordsN(15) + ' last'); assert.ok(!slides.slice(1).some((s) => s.text.includes('last')));
});
test('sections: a section over 34 words splits into runs of whole sentences of <=34 words', () => {
  const s1 = wordsN(20, 'a') + '.'; const s2 = wordsN(20, 'b') + '.'; const s3 = wordsN(10, 'c') + '.';
  const { slides } = slidePlan(sig('Something happened here today', `${s1} ${s2} ${s3}`, 'Do this now please. Then do that later.'));
  const why = slides.filter((s) => s.label === 'Why it matters').map((s) => s.text);
  assert.deepEqual(why, [s1, `${s2} ${s3}`]);
  for (const t of why) assert.ok(t.split(' ').length <= 34);
});
test('sections: one sentence over 34 words is dropped; no lone sentence under 6 words unless it is the whole section', () => {
  const long = wordsN(40) + '.'; const a = wordsN(30, 'a') + '.'; const tiny = 'Yes.';
  const { slides } = slidePlan(sig('Something happened here today', `${a} ${tiny} ${long}`, 'Do this now please. Then do that later.'));
  const why = slides.filter((s) => s.label === 'Why it matters').map((s) => s.text);
  assert.ok(!why.some((t) => t.includes('w40'))); assert.ok(!why.includes(tiny));
  const only = slidePlan(sig('Something happened here today', 'Short one.', 'Do this now please. Then do that later.'));
  assert.ok(only.slides.some((s) => s.text === 'Short one.'));
});
test('sections: confidence slide is the first sentence of the Confidence line, after the do slide', () => {
  const { slides } = slidePlan(sig('Something happened here today', 'It sits in the north of the island.', 'Wait and see what happens next.', 'Confidence 86% from 3 independent sources. I publish only what clears the bar.'));
  assert.deepEqual(slides.map((s) => s.label), ['What changed', 'Why it matters', "What I'd do", 'Confidence', undefined]);
  assert.equal(slides[3].text, 'Confidence 86% from 3 independent sources.');
});
test('sections: never a duplicate slide text, even when Why repeats What changed', () => {
  const wc = 'Iberostar has opened a new hotel on the north coast';
  const { slides } = slidePlan(sig(wc, `${wc}.`, 'Wait and see what happens next.', 'Confidence 86% from 3 sources.'));
  const keys = slides.filter((s) => s.role !== 'save').map((s) => s.text.toLowerCase().replace(/[\s.,;:]+$/, ''));
  assert.equal(new Set(keys).size, keys.length);
  const k2 = slidePlan(sig(wc, `${wc}.`, `${wc}.`)).slides?.map((s) => s.text);
  if (k2) assert.equal(new Set(k2).size, k2.length);
});
test('sections: over the limit, every present section gets a slide before any gets a second', () => {
  const big = (p) => [0, 1, 2, 3].map((i) => wordsN(30, `${p}${i}x`) + '.').join(' '); // 4 slides each
  const wc = wordsN(30, 'wc') + '.';
  const { slides } = slidePlan(sig(wc, big('y'), big('z'), 'Confidence 86% from 3 sources. More.'));
  assert.ok(slides.length <= 7);
  const labels = slides.map((s) => s.label);
  for (const l of ['What changed', 'Why it matters', "What I'd do", 'Confidence']) assert.ok(labels.includes(l), l);
  assert.equal(slides.at(-1).role, 'save');
});
test('sections: too little content still returns a reason', () => {
  assert.match(slidePlan(sig('Short statement here today', '', '')).reason, /too little/);
});
test('sections: planCarousel on the fixture passes and carouselSpec passes labels through', async () => {
  const { slides, rejected } = await planCarousel(fixture, { voice: okVoice }); assert.equal(rejected, undefined); assert.equal(slides.length, 4);
  const spec = carouselSpec(fixture, slides); assert.deepEqual(spec.slides.map((s) => s.label), ['What changed', 'Why it matters', "What I'd do", undefined]);
  assert.equal(spec.label, 'What changed');
});
test('non-signal plan is unchanged (snapshot taken before the change)', () => {
  const d = { id: 'B1', kind: 'outlook', region: 'all', sourceDate: '2026-09-13', text: "Demand outlook, next 8 weeks — 13 September 2026\n\nDar es Salaam: rising (82% confidence) — Peak dry season over the next ~8 weeks (Sep→Oct→Nov); Affordability backdrop: EUR ≈ 3,069.1 TZS\nZanzibar: rising (82% confidence) — Peak dry season over the next ~8 weeks (Sep→Oct→Nov)\n\nThis is what my intelligence engine reads from public data every morning. When the numbers move, I say so; when they don't, I say nothing.\n— Tim, Beyond Paradise Adventures\n\n#BeyondParadiseAdventures" };
  assert.equal(JSON.stringify(slidePlan(d)), '{"slides":[{"role":"hook","text":"Demand outlook, next 8 weeks"},{"role":"fact","text":"Dar es Salaam: rising (82% confidence) — Peak dry season over the next ~8 weeks (Sep→Oct→Nov)"},{"role":"fact","text":"Zanzibar: rising (82% confidence) — Peak dry season over the next ~8 weeks (Sep→Oct→Nov)"},{"role":"save","text":"Save this for later.\\n— Tim, Beyond Paradise Adventures","recap":"Demand outlook, next 8 weeks"}]}');
  assert.ok(carouselSpec(d, slidePlan(d).slides).slides.every((s) => !('label' in s)));
});
test('render: card.py --slides with per-slide labels writes N PNGs of 1080x1350 and honours slide label', async (t) => {
  try { execFileSync('python3', ['-c', 'import PIL'], { stdio: 'pipe' }); } catch { return t.skip('Pillow is not installed: python3 -c "import PIL" failed'); }
  const { slides } = await planCarousel(fixture, { voice: okVoice }); const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-lab-'));
  const files = renderCarousel(fixture, slides, out); assert.equal(files.length, 4);
  for (const f of files) assert.equal(execFileSync('python3', ['-c', 'import sys;from PIL import Image;print(*Image.open(sys.argv[1]).size)', f]).toString().trim(), '1080 1350');
  assert.match(fs.readFileSync(path.join(import.meta.dirname, 'card.py'), 'utf8'), /s\.get\("label"\)/);
  fs.rmSync(out, { recursive: true, force: true });
});
