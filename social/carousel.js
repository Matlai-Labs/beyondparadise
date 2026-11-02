// Instagram CAROUSEL format: slide plan (pure, deterministic, $0) + local Pillow render.
// Every hook/fact slide is a verbatim slice of the draft's own text — nothing is invented, no number is added.
// Publishing lives in lib.js (igPublishCarousel); config.instagram.format stays Tim's call.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG, brandGuard, sourceGate, voiceGate } from './lib.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Instagram's long-standing carousel cap. The current docs say 20, but we plan 3-7 and refuse >10 on purpose. */
export const MAX_CAROUSEL_IMAGES = 10;
export const MIN_SLIDES = 3; export const MAX_SLIDES = 7;
const HOOK_WORDS = 8; const FACT_MAX_WORDS = 34;
const words = (s) => s.split(/\s+/).filter(Boolean);
const sentences = (s) => s.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
const labelled = (lines, label) => { const l = lines.find((x) => x.startsWith(label + ': ')); return l ? l.slice(label.length + 2).trim() : null; };

/** Pure: draft -> { slides:[{role,text}] } or { reason } when the draft has too little to carry a carousel. */
export function slidePlan(d) {
  const lines = d.text.split('\n'); const first = lines[0]; const headline = first.split(' — ')[0].trim();
  const body = lines.slice(2).map((l) => l.trim()).filter((l) => l && !l.startsWith('—') && !l.startsWith('#'));
  let hookSrc = headline; const pool = [];
  if (d.kind === 'signal') {
    const wc = labelled(body, 'What changed'); if (wc) hookSrc = wc;
    const why = sentences(labelled(body, 'Why it matters') || ''); const todo = sentences(labelled(body, "What I'd do") || '');
    const conf = body.find((l) => /^Confidence /.test(l)); const confS = conf ? sentences(conf)[0] : null;
    // interleave sections so the carousel reads why -> do -> why ...
    for (let i = 0; i < Math.max(why.length, todo.length); i++) { if (why[i]) pool.push(why[i]); if (todo[i]) pool.push(todo[i]); }
    if (confS) pool.push(confS);
  } else {
    for (const l of body) { if (/^This is what/.test(l)) continue; pool.push(l.split(';')[0].trim()); }
  }
  const hookW = words(hookSrc); const hook = hookW.slice(0, HOOK_WORDS).join(' ');
  // if the hook was cut, the full statement still deserves a slide of its own
  if (hookW.length > HOOK_WORDS && hookW.length <= FACT_MAX_WORDS) pool.unshift(hookSrc);
  const seen = new Set(); const facts = [];
  for (const f of pool) { if (!f || words(f).length > FACT_MAX_WORDS || seen.has(f)) continue; seen.add(f); facts.push(f); }
  const picked = facts.slice(0, MAX_SLIDES - 2);
  if (!hook || picked.length < MIN_SLIDES - 2) return { reason: 'too little content in the draft for a carousel (need a hook and at least 1 fact)' };
  const save = { role: 'save', text: `Save this for later.\n— ${CONFIG.author}, ${CONFIG.brand}`, recap: hookSrc };
  return { slides: [{ role: 'hook', text: hook }, ...picked.map((text) => ({ role: 'fact', text })), save] };
}

/** slidePlan + the same gates drafts pass (brandGuard, sourceGate, voice-lint on EVERY slide). Fails closed via `rejected`. */
export async function planCarousel(d, { voice = voiceGate } = {}) {
  const bad = brandGuard(d.text) || sourceGate(d); if (bad) return { rejected: bad };
  const plan = slidePlan(d); if (plan.reason) return { rejected: plan.reason, tooLittle: true };
  for (const [i, s] of plan.slides.entries()) {
    const slideText = s.recap ? `${s.text}\n${s.recap}` : s.text;
    const b = brandGuard(slideText); if (b) return { rejected: `slide ${i + 1}: ${b}` };
    const v = await voice(slideText); if (!v.ok) return { rejected: `voice-lint (slide ${i + 1}): ${v.reason}` };
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
