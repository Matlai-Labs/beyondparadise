// Instagram CAROUSEL format: slide plan (pure, deterministic, $0) + local Pillow render.
// Every hook/fact slide is a verbatim slice of the draft's own text — nothing is invented, no number is added.
// Publishing lives in lib.js (igPublishCarousel); config.instagram.format stays Tim's call.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG, brandGuard, sourceGate, voiceGate, rulesCheck } from './lib.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Instagram's long-standing carousel cap. The current docs say 20, but we plan 3-7 and refuse >10 on purpose. */
export const MAX_CAROUSEL_IMAGES = 10;
export const MIN_SLIDES = 3; export const MAX_SLIDES = 7;
const HOOK_WORDS = 8; const FACT_MAX_WORDS = 34;
const words = (s) => s.split(/\s+/).filter(Boolean);
const sentences = (s) => s.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
const labelled = (lines, label) => { const l = lines.find((x) => x.startsWith(label + ': ')); return l ? l.slice(label.length + 2).trim() : null; };

const HOOK_WHOLE_WORDS = 16; // a "What changed" statement this short is the hook as written, on one slide
const key = (t) => t.toLowerCase().replace(/\s+/g, ' ').replace(/[\s,;:–—]+$/, '').replace(/\.$/, '').replace(/[\s,;:–—]+$/, '');
const ABBR = /^(dr|mr|mrs|ms|prof|st|mt|no|vs|approx|est|e\.g|i\.e|etc|a\.m|p\.m)\.$/i;
/** Sentence split for signal sections: like sentences(), but a full stop after an abbreviation, an initial or a number like 2.5,
 *  or before a lowercase letter or digit, is not a border (a slide must never end on "Dr."). */
const signalSentences = (s) => {
  const out = [];
  for (const piece of sentences(s)) {
    const prev = out.at(-1);
    const tok = prev ? prev.split(/\s+/).at(-1) : '';
    const joins = prev && /[.]$/.test(prev) && (ABBR.test(tok) || /^[A-Z]\.$/.test(tok) || /^\d+\.\d+\.$/.test(tok) || /^[a-z0-9]/.test(piece));
    if (joins) out[out.length - 1] = `${prev} ${piece}`; else out.push(piece);
  }
  return out;
};
const TOO_LONG = 'a sentence is too long for a slide; the draft goes out as a short video instead';
const NO_FIT = 'the section text does not fit on 5 slides; the draft goes out as a short video instead';
/** Split one section's sentences into slide texts, never leaving a sentence out: the whole section if <= FACT_MAX_WORDS,
 *  else runs of consecutive whole sentences. Returns null when one sentence alone is too long for a slide. */
function sectionChunks(sents) {
  if (!sents.length) return [];
  if (sents.some((x) => words(x).length > FACT_MAX_WORDS)) return null;
  if (words(sents.join(' ')).length <= FACT_MAX_WORDS) return [sents.join(' ')];
  const runs = []; let cur = [];
  for (const x of sents) {
    if (cur.length && words([...cur, x].join(' ')).length > FACT_MAX_WORDS) { runs.push(cur); cur = []; }
    cur.push(x);
  }
  runs.push(cur);
  // a slide of one sentence under 6 words is folded into a neighbour when that stays within the limit; otherwise it stands alone
  for (let i = 0; i < runs.length; i++) {
    if (runs[i].length !== 1 || words(runs[i][0]).length >= 6) continue;
    if (i > 0 && words([...runs[i - 1], ...runs[i]].join(' ')).length <= FACT_MAX_WORDS) { runs[i - 1].push(...runs[i]); runs.splice(i, 1); i = -1; }
    else if (i + 1 < runs.length && words([...runs[i], ...runs[i + 1]].join(' ')).length <= FACT_MAX_WORDS) { runs[i].push(...runs[i + 1]); runs.splice(i + 1, 1); i = -1; }
  }
  return runs.map((r) => r.join(' '));
}

/** Pure: draft -> { slides:[{role,text,label?}] } or { reason } when the draft has too little to carry a carousel. */
export function slidePlan(d) {
  const lines = d.text.split('\n'); const first = lines[0]; const headline = first.split(' — ')[0].trim();
  const body = lines.slice(2).map((l) => l.trim()).filter((l) => l && !l.startsWith('—') && !l.startsWith('#'));
  let hookSrc = headline; let hookFrom = headline; let hookLabel; const sections = []; // sections: [{label, chunks[]}]
  const clean = (t) => t.replace(/[,;:–—\s]+$/, ''); // never end a slide on a dangling mark
  let hookText = null;
  if (d.kind === 'signal') {
    const wc = labelled(body, 'What changed');
    if (wc) {
      hookSrc = wc; hookLabel = 'What changed';
      if (words(wc).length <= HOOK_WHOLE_WORDS) hookText = clean(wc); // else the headline is the hook (hookFrom)
      else sections.push({ label: 'What changed', sents: signalSentences(wc) }); // headline hooks; the full statement follows
    }
    hookLabel = hookLabel || 'What changed';
    // Order is what changed -> why it matters -> what I'd do -> confidence, each section kept together.
    // Interleaving why/do sentences was tried first; a reader looked at all seven slides on 16 Nov 2026 and refused them
    // (single sentences stood alone without context, and slide 2 repeated slide 1).
    sections.push({ label: 'Why it matters', sents: signalSentences(labelled(body, 'Why it matters') || '') });
    sections.push({ label: "What I'd do", sents: signalSentences(labelled(body, "What I'd do") || '') });
    const conf = body.find((l) => /^Confidence /.test(l)); const confS = conf ? sentences(conf)[0] : null;
    if (confS) { if (words(confS).length > FACT_MAX_WORDS) return { reason: TOO_LONG }; sections.push({ label: 'Confidence', chunks: [confS] }); }
  } else {
    const chunks = []; for (const l of body) { if (/^This is what/.test(l)) continue; chunks.push(l.split(';')[0].trim()); }
    hookFrom = hookSrc; const hw = words(hookSrc); // if the hook was cut, the full statement still deserves a slide of its own
    if (hw.length > HOOK_WORDS && hw.length <= FACT_MAX_WORDS) chunks.unshift(hookSrc);
    sections.push({ label: undefined, chunks, legacy: true });
  }
  const hook = hookText ?? clean(words(hookFrom).slice(0, HOOK_WORDS).join(' '));
  const seen = new Set([key(hook)]);
  for (const sec of sections) if (!sec.chunks) { sec.chunks = sectionChunks(sec.sents); if (!sec.chunks) return { reason: TOO_LONG }; }
  // a chunk that repeats a slide already shown is not shown twice
  for (const sec of sections) sec.chunks = sec.chunks.filter((c) => { const k = key(c); if (!c || (sec.legacy && words(c).length > FACT_MAX_WORDS) || seen.has(k)) return false; seen.add(k); return true; });
  // every chunk of every section, Confidence included, must fit under the cap, else no carousel (nothing shown is left out silently)
  const room = MAX_SLIDES - 2; const total = sections.reduce((n, sec) => n + sec.chunks.length, 0);
  if (total > room && !sections.some((sec) => sec.legacy)) return { reason: NO_FIT };
  const picked = sections.flatMap((sec) => sec.chunks.slice(0, room).map((text) => ({ role: 'fact', text, ...(sec.label ? { label: sec.label } : {}) }))).slice(0, room);
  if (!hook || picked.length < MIN_SLIDES - 2) return { reason: 'too little content in the draft for a carousel (need a hook and at least 1 fact)' };
  const save = { role: 'save', text: `Save this for later.\n— ${CONFIG.author}, ${CONFIG.brand}`, recap: d.kind === 'signal' ? headline : hookSrc };
  const hookSlide = { role: 'hook', text: hook, ...(d.kind === 'signal' ? { label: hookLabel } : {}) };
  return { slides: [hookSlide, ...picked, save] };
}

/** slidePlan + the same gates drafts pass (brandGuard, sourceGate, voice-lint on EVERY slide). Fails closed via `rejected`. */
export async function planCarousel(d, { voice = voiceGate, rules = rulesCheck } = {}) {
  const bad = brandGuard(d.text) || sourceGate(d); if (bad) return { rejected: bad };
  const plan = slidePlan(d); if (plan.reason) return { rejected: plan.reason, tooLittle: true };
  for (const [i, s] of plan.slides.entries()) {
    const slideText = s.recap ? `${s.text}\n${s.recap}` : s.text;
    const b = brandGuard(slideText); if (b) return { rejected: `slide ${i + 1}: ${b}` };
    const v = await voice(slideText); if (!v.ok) return { rejected: `voice-lint (slide ${i + 1}): ${v.reason}` };
    const rg = rules(slideText, { claims: d.claims }); if (!rg.ok) return { rejected: `rules (slide ${i + 1}): ${rg.reason}` };
  }
  const last = plan.slides.at(-1); if (!/Beyond Paradise Adventures/.test(last.text) || /https?:|www\./i.test(last.text)) return { rejected: 'last slide must carry the full brand and no link' };
  return { slides: plan.slides };
}

const TAGS = { zanzibar: 'Zanzibar', 'dar-es-salaam': 'Dar es Salaam', all: 'Zanzibar & Dar es Salaam' };
export function carouselSpec(d, slides) {
  const n = slides.length;
  return { brand: CONFIG.brand, tag: TAGS[d.region] || '', date: d.sourceDate || '', label: d.kind === 'outlook' ? 'Demand outlook' : 'What changed',
    slides: slides.map((s, i) => ({ ...s, counter: `${i + 1}/${n}` })) };
}
/** Render N PNGs (1080x1350) with card.py --slides. Returns the file paths in slide order. */
export function renderCarousel(d, slides, outDir) {
  if (slides.length < 2 || slides.length > MAX_CAROUSEL_IMAGES) throw new Error(`carousel needs 2-${MAX_CAROUSEL_IMAGES} slides, got ${slides.length}`);
  fs.mkdirSync(outDir, { recursive: true }); const spec = path.join(outDir, 'spec.json');
  fs.writeFileSync(spec, JSON.stringify(carouselSpec(d, slides)));
  execFileSync('python3', [path.join(HERE, 'card.py'), '--slides', spec, outDir], { stdio: 'pipe' });
  return slides.map((_, i) => path.join(outDir, `slide-${i + 1}.png`));
}
