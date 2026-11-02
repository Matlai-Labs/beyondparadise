import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { planCarousel, carouselSpec, renderCarousel, MAX_CAROUSEL_IMAGES } from './carousel.js';
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
test('plan: long headline is cut to 8 words', async () => {
  const base = signal(); const d = { ...base, text: base.text.replace('Zanzibar tourism arrivals hit record 124,481 in August', 'Zanzibar tourism arrivals hit a brand new record of 124,481 visitors in August') };
  const { slides } = await planCarousel(d, { voice: okVoice }); assert.equal(slides[0].text.split(/\s+/).length, 8);
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
