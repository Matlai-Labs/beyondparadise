// Short silent clips cut from the finished videos, for an automatic reel lane. Node built-ins only,
// local ffmpeg/ffprobe only, no network, nothing is uploaded or posted from here.
//
//   node reel-clip.js --shots [--catalog <path>] [--root <path>]
//   node reel-clip.js --sample <n> --out <dir> [--catalog <path>] [--root <path>]
//
// Only the stretches the second look marked usable (secondLook.usable in the private catalogue) may be
// cut. Inside a stretch only shots the second look actually SAW are used: the look sampled one frame
// every 2 seconds, so a shot with fewer than two sampled instants may never have been seen at all.
// The source audio is dropped (-an): the music in the source is not cleared. Sources are only read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertOutsideRepo } from './media-catalog.js';

const execFileP = promisify(execFile);

export const SCENE_THRESHOLD = 0.3;
export const SAMPLE_EVERY_SEC = 2;
export const SHOT_TRIM_SEC = 0.3;
export const MIN_SHOT_SEC = 3;
/** THE lower length limit of a library clip: one shot of at least MIN_SHOT_SEC. Every duration check of a library clip (render check, composed-clip QA) reads this. A re-encode may land a frame or two short, hence the tolerance. */
export const LIBRARY_CLIP_MIN_SEC = MIN_SHOT_SEC;
export const DURATION_TOLERANCE_SEC = 0.1;
/** THE shortest duration of a library clip as the checks see it (--split, the composed-clip checks, the automatic lane's publish check): the minimum minus the re-encode tolerance. The weekly reels and --build keep their own floors. */
export const LIBRARY_CLIP_FLOOR_SEC = LIBRARY_CLIP_MIN_SEC - DURATION_TOLERANCE_SEC;
/** The floor of checkRendered when the caller gives none (--build, the clip tool): unchanged. */
export const RENDER_MIN_SEC = 5;
export const CLIP_MIN_SEC = 6;
export const CLIP_MAX_SEC = 9;
const MIN_PIECE_SEC = 2;
const EDGE_EPS = 0.05;
const EPS = 1e-6;
export const OUT_W = 1080;
export const OUT_H = 1920;
export const OUT_FPS = 30;
export const HOOK_LINE_CHARS = 22;
export const HOOK_MAX_LINES = 3;
/** First existing file wins: the faces card.py uses for its sans bold (drawtext needs ttf/otf, not woff2). */
export const FONT_CANDIDATES = [
  path.join('/Library/Fonts', 'Inter-SemiBold.ttf'),
  path.join('/System/Library/Fonts/Supplemental', 'Arial Bold.ttf'),
];

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const r2 = (x) => Math.round(x * 100) / 100;
const home = (env) => env.HOME || os.homedir();
export const defaultRoot = (env = process.env) => env.BPA_MEDIA_ROOT || path.join(home(env), 'Movies', 'Beyond Paradise', 'youtube-archive');
export const defaultCatalog = (env = process.env) => env.BPA_MEDIA_CATALOG || path.join(home(env), '.matlai', 'bpa-media-catalog.json');
export const defaultUsagePath = (env = process.env) => path.join(env.BPA_STATE_DIR || path.join(home(env), '.matlai'), 'bpa-clip-usage.jsonl');

// ---------------------------------------------------------------- 1. which stretches may be used

/** Every `{ id, file, startSec, endSec, subject }` from secondLook.usable. Nothing else is ever usable. */
export function usableStretches(catalog) {
  const entries = Array.isArray(catalog) ? catalog : (catalog && catalog.entries) || [];
  const out = [];
  for (const e of entries) {
    if (!e || e.missing || (e.flags && e.flags.otherPublisherMark === true)) continue;
    if (typeof e.id !== 'string' || typeof e.file !== 'string') continue;
    for (const s of e.segments || []) {
      const u = s && s.secondLook && s.secondLook.usable;
      if (!u || !finite(u.startSec) || !finite(u.endSec) || u.startSec < 0 || u.endSec <= u.startSec) continue;
      out.push({ id: e.id, file: e.file, startSec: u.startSec, endSec: u.endSec, subject: s.secondLook.subject ?? null });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 2. shot boundaries

/** Seconds (pts_time) of the frames showinfo reported. Only showinfo lines count. */
export function parseSceneTimes(stderr) {
  const out = [];
  for (const m of String(stderr ?? '').matchAll(/Parsed_showinfo[^\n]*?pts_time:\s*(-?\d+(?:\.\d+)?)/g)) out.push(Number(m[1]));
  return out;
}

const defaultRun = (cmd, args) => execFileP(cmd, args, { timeout: 300_000, maxBuffer: 64 << 20 });
const failText = (e) => `${e && e.message ? e.message : e}${e && e.stderr ? `\n${String(e.stderr).slice(-400)}` : ''}`;

/** Shots inside one stretch by ffmpeg scene detection. Returns [{ startSec, endSec }] on the original timeline. */
export async function detectShots({ file, startSec, endSec, root }, { run = defaultRun, threshold = SCENE_THRESHOLD, ffmpeg = 'ffmpeg' } = {}) {
  const src = root ? path.join(root, file) : file;
  const args = ['-nostdin', '-hide_banner', '-ss', String(startSec), '-t', String(r2(endSec - startSec)), '-i', src,
    '-an', '-vf', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'];
  const { stderr } = await run(ffmpeg, args);
  // with -ss before -i the output timeline restarts at 0, so a time found here is relative to startSec
  const cuts = [...new Set(parseSceneTimes(stderr).map((t) => r2(startSec + t)))]
    .filter((t) => t > startSec + EDGE_EPS && t < endSec - EDGE_EPS).sort((a, b) => a - b);
  const bounds = [startSec, ...cuts, endSec];
  const shots = [];
  for (let i = 0; i + 1 < bounds.length; i += 1) shots.push({ startSec: bounds[i], endSec: bounds[i + 1] });
  return shots;
}

// ---------------------------------------------------------------- 3. shots the second look really saw

/**
 * Keep shots holding at least TWO looked-at instants (sampleOffset + k * sampleEvery on the original
 * timeline; an instant belongs to [start, end) so a frame exactly on a cut counts for the shot that
 * starts there), then trim 0.3 s off both ends and apply the minimum length to the trimmed shot.
 * Returns { safe, dropped: [{ shot, reason }] }, reasons `not-seen-enough` | `too-short`.
 */
export function safeShots(shots, { sampleEverySec = SAMPLE_EVERY_SEC, sampleOffsetSec = 0, minLenSec = MIN_SHOT_SEC } = {}) {
  const safe = []; const dropped = [];
  for (const shot of shots) {
    let seen = 0;
    const first = Math.ceil((shot.startSec - sampleOffsetSec - EPS) / sampleEverySec);
    for (let k = first; ; k += 1) {
      const t = sampleOffsetSec + k * sampleEverySec;
      if (t >= shot.endSec - EPS) break;
      if (t >= shot.startSec - EPS) seen += 1;
    }
    if (seen < 2) { dropped.push({ shot, reason: 'not-seen-enough' }); continue; }
    const s = r2(shot.startSec + SHOT_TRIM_SEC); const e = r2(shot.endSec - SHOT_TRIM_SEC);
    if (e - s < minLenSec - EPS) { dropped.push({ shot, reason: 'too-short' }); continue; }
    safe.push({ startSec: s, endSec: e });
  }
  return { safe, dropped };
}

// ---------------------------------------------------------------- 4. planning one clip (pure)

export const shotKey = (s) => `${s.id}:${Number(s.startSec).toFixed(2)}-${Number(s.endSec).toFixed(2)}`;

function rng(seed) {
  let a = crypto.createHash('sha256').update(String(seed ?? '')).digest().readUInt32LE(0);
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const overlaps = (a, b) => Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec) > 0.1;

/**
 * Pure. `stretches`: [{ id, file, startSec, endSec, subject, shots: [safe shots] }]. Picks one clip of
 * 6 to 9 seconds: one shot if one is long enough, else the first 2 or 3 consecutive safe shots from the
 * SAME stretch. A shot overlapping a usage-ledger entry of the same video is never used.
 * Returns { ok: true, spans, durationSec, usedShots } or { ok: false, reason: 'nothing left' }.
 */
export function planClip(stretches, { targetSec, usedLedger = [], seed = '' } = {}) {
  const rand = rng(seed);
  const target = Math.min(CLIP_MAX_SEC, Math.max(CLIP_MIN_SEC, finite(targetSec) ? targetSec : CLIP_MIN_SEC + Math.floor(rand() * 4)));
  const free = (id, h) => !usedLedger.some((u) => u.id === id && overlaps(u, h));
  const singles = []; const groups = [];
  for (const st of stretches) {
    const shots = (st.shots || []).filter((h) => free(st.id, h));
    for (const h of shots) if (h.endSec - h.startSec >= CLIP_MIN_SEC - EPS) singles.push({ st, h });
    for (let i = 0; i < shots.length; i += 1) {
      let total = 0;
      for (let k = 1; k <= 3 && i + k <= shots.length; k += 1) {
        total += shots[i + k - 1].endSec - shots[i + k - 1].startSec;
        if (k < 2 || total < CLIP_MIN_SEC - EPS) continue;
        const firstSum = total - (shots[i + k - 1].endSec - shots[i + k - 1].startSec);
        const dur = Math.min(total, CLIP_MAX_SEC, Math.max(target, firstSum + MIN_PIECE_SEC));
        if (dur < CLIP_MIN_SEC - EPS || dur - firstSum < MIN_PIECE_SEC - EPS) break;
        groups.push({ st, list: shots.slice(i, i + k), dur });
        break; // the smallest number of shots that works
      }
    }
  }
  const span = (st, a, b) => ({ id: st.id, file: st.file, startSec: r2(a), endSec: r2(b) });
  if (singles.length) {
    const { st, h } = singles[Math.floor(rand() * singles.length)];
    const dur = Math.min(target, h.endSec - h.startSec);
    return { ok: true, spans: [span(st, h.startSec, h.startSec + dur)], durationSec: r2(dur), usedShots: [{ id: st.id, startSec: h.startSec, endSec: h.endSec }] };
  }
  if (groups.length) {
    const { st, list, dur } = groups[Math.floor(rand() * groups.length)];
    const spans = []; let left = dur;
    for (const h of list) {
      const len = Math.min(h.endSec - h.startSec, left);
      if (len <= EPS) break;
      spans.push(span(st, h.startSec, h.startSec + len));
      left -= len;
    }
    return { ok: true, spans, durationSec: r2(dur), usedShots: list.map((h) => ({ id: st.id, startSec: h.startSec, endSec: h.endSec })) };
  }
  return { ok: false, reason: 'nothing left' };
}

// ---------------------------------------------------------------- usage ledger (the caller reads it)

export function readUsage(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o && typeof o.id === 'string' && finite(o.startSec) && finite(o.endSec)) out.push(o); } catch { /* a torn line is skipped */ }
  }
  return out;
}

/** One write() with O_APPEND per call: lines this small are not interleaved by a concurrent writer. */
export function appendUsage(file, shots, now = new Date()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const data = shots.map((s) => `${JSON.stringify({ id: s.id, startSec: s.startSec, endSec: s.endSec, at: now.toISOString() })}\n`).join('');
  const fd = fs.openSync(file, 'a', 0o600);
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// ---------------------------------------------------------------- 5. render

/** At most 3 lines of about 22 characters, wrapped on words; a longer text ends in an ellipsis. */
export function wrapHook(text, width = HOOK_LINE_CHARS, maxLines = HOOK_MAX_LINES) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean).flatMap((w) => {
    const parts = []; let rest = w;
    while (rest.length > width) { parts.push(rest.slice(0, width)); rest = rest.slice(width); }
    return [...parts, rest];
  });
  const lines = []; let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ` ${w}`;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines.join('\n');
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  if (last.length > width - 1) last = last.slice(0, width - 1).trimEnd();
  kept[maxLines - 1] = `${last}…`;
  return kept.join('\n');
}

const escFilterValue = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/:/g, '\\:');

export function findFont(exists = fs.existsSync) {
  return FONT_CANDIDATES.find((f) => exists(f)) || null;
}

/**
 * The one ffmpeg argument list. Cuts from the ORIGINAL file(s) (one -ss/-t/-i per span), centre-crops
 * to 9:16, scales to 1080x1920, 30 fps, joins the spans, no audio. The hook goes through a temporary
 * text file (textfile=, expansion=none), never into the argument list. Returns { args, textFile }.
 */
export function buildRenderArgs(plan, { out, root = defaultRoot(), hook = null, fontFile = null } = {}) {
  const rootAbs = path.resolve(root);
  const args = ['-nostdin', '-hide_banner', '-y'];
  for (const s of plan.spans) {
    const src = path.resolve(rootAbs, s.file);
    if (path.relative(rootAbs, src).startsWith('..')) throw new Error(`source ${s.file} is outside the media root`);
    args.push('-ss', String(s.startSec), '-t', String(r2(s.endSec - s.startSec)), '-i', src);
  }
  const n = plan.spans.length;
  const parts = plan.spans.map((_, i) => `[${i}:v]crop=trunc(ih*9/16/2)*2:ih,scale=${OUT_W}:${OUT_H},setsar=1,fps=${OUT_FPS}[v${i}]`);
  parts.push(`${plan.spans.map((_, i) => `[v${i}]`).join('')}concat=n=${n}:v=1:a=0[cat]`);
  let textFile = null; let last = 'cat';
  if (hook) {
    const font = fontFile || findFont();
    if (!font) throw new Error('no font file found for the hook text (set one with fontFile)');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-hook-'));
    textFile = path.join(dir, 'hook.txt');
    fs.writeFileSync(textFile, wrapHook(hook), { mode: 0o600 });
    // upper third (y 0..640); the dark translucent box is drawtext's own
    parts.push(`[cat]drawtext=fontfile='${escFilterValue(font)}':textfile='${escFilterValue(textFile)}':expansion=none:`
      + `fontsize=60:fontcolor=white:line_spacing=14:x=(w-text_w)/2:y=300:box=1:boxcolor=black@0.55:boxborderw=28[txt]`);
    last = 'txt';
  }
  args.push('-filter_complex', parts.join(';'), '-map', `[${last}]`, '-an',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(OUT_FPS), '-movflags', '+faststart', out);
  return { args, textFile };
}

/** Render one clip. Output only outside the repository and outside the media root. */
export async function renderClip(plan, { out, hook = null, run = defaultRun, root = defaultRoot(), fontFile = null, ffmpeg = 'ffmpeg', repoRoot, gitTopLevel } = {}) {
  if (!plan || !plan.ok) throw new Error(`no clip to render: ${plan && plan.reason ? plan.reason : 'bad plan'}`);
  if (!out) throw new Error('renderClip needs an output path');
  out = path.resolve(out);
  assertOutsideRepo(out, { repoRoot, gitTopLevel });
  const rel = path.relative(path.resolve(root), out);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error('refusing to write inside the media root: the source videos must not be touched');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const { args, textFile } = buildRenderArgs(plan, { out, root, hook, fontFile });
  try {
    await run(ffmpeg, args);
  } catch (e) {
    const msg = failText(e);
    if (/No such filter: 'drawtext'/.test(msg)) throw new Error(`this ffmpeg has no drawtext filter (needs libfreetype); point BPA_FFMPEG at one that has it. ${msg}`);
    throw new Error(`ffmpeg failed: ${msg}`);
  } finally {
    if (textFile) fs.rmSync(path.dirname(textFile), { recursive: true, force: true });
  }
  return { file: out, durationSec: plan.durationSec, spans: plan.spans.map((s) => ({ id: s.id, file: s.file, startSec: s.startSec, endSec: s.endSec })) };
}

// ---------------------------------------------------------------- 6. check the result

export async function ffprobeJson(file) {
  const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,codec_name,width,height,r_frame_rate:format=duration', '-of', 'json', file], { timeout: 60_000, maxBuffer: 1 << 20 });
  return JSON.parse(stdout);
}

const parseRate = (r) => { const m = /^(\d+)\/(\d+)$/.exec(String(r ?? '')); return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : NaN; };

/** Duration `minSec` (default RENDER_MIN_SEC 5; the library passes LIBRARY_CLIP_FLOOR_SEC) to 10 s, 1080x1920, no audio stream, 30 fps. Deletes nothing; returns { ok, problems, durationSec }. */
export async function checkRendered(file, { probe = ffprobeJson, minSec = RENDER_MIN_SEC } = {}) {
  const problems = [];
  let p;
  try { p = await probe(file); } catch (e) { return { ok: false, problems: [`probe failed: ${e.message}`], durationSec: null }; }
  const streams = p.streams || [];
  const v = streams.find((s) => s.codec_type === 'video');
  const dur = Number(p.format && p.format.duration);
  if (!v) problems.push('no video stream');
  else {
    if (v.width !== OUT_W || v.height !== OUT_H) problems.push(`size ${v.width}x${v.height}, want ${OUT_W}x${OUT_H}`);
    const fps = parseRate(v.r_frame_rate);
    if (!(Math.abs(fps - OUT_FPS) < 0.01)) problems.push(`frame rate ${v.r_frame_rate}, want ${OUT_FPS}`);
  }
  if (streams.some((s) => s.codec_type === 'audio')) problems.push('has an audio stream, want none');
  if (!(dur >= minSec && dur <= 10)) problems.push(`duration ${Number.isFinite(dur) ? dur.toFixed(2) : 'unknown'} s, want ${minSec} to 10`);
  return { ok: problems.length === 0, problems, durationSec: Number.isFinite(dur) ? dur : null };
}

// ---------------------------------------------------------------- command line

function parseArgs(argv) {
  const a = { shots: false, sample: null, out: null, catalog: null, root: null, bad: null };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--shots') a.shots = true;
    else if (['--sample', '--out', '--catalog', '--root'].includes(t)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) { a.bad = `${t} needs a value`; break; }
      a[t.slice(2)] = argv[i + 1]; i += 1;
    } else { a.bad = `unknown argument ${t}`; break; }
  }
  if (!a.bad && a.sample !== null && !(Number.isInteger(Number(a.sample)) && Number(a.sample) >= 1 && Number(a.sample) <= 20)) a.bad = '--sample needs a whole number from 1 to 20';
  return a;
}

/** Stretches with their shots analysed: { ...stretch, found, shots (safe), dropped }. */
export async function analyseStretches(stretches, { run, root, ffmpeg }) {
  const out = [];
  for (const st of stretches) {
    const found = await detectShots({ ...st, root }, { run, ffmpeg });
    const { safe, dropped } = safeShots(found);
    out.push({ ...st, found, shots: safe, dropped });
  }
  return out;
}

/** How many clips the supply gives without reuse: plan until nothing is left (one greedy run, seeded). */
export function simulateSupply(analysed) {
  const ledger = []; let clips = 0; let sec = 0;
  for (let i = 0; i < 1000; i += 1) {
    const p = planClip(analysed, { usedLedger: ledger, seed: `supply-${i}` });
    if (!p.ok) break;
    clips += 1; sec += p.durationSec; ledger.push(...p.usedShots);
  }
  return { clips, sec: r2(sec) };
}

export async function main(argv, env = process.env, deps = {}) {
  const log = deps.log || ((s) => console.log(s));
  const error = deps.error || ((s) => console.error(s));
  const args = parseArgs(argv);
  if (args.bad || (!args.shots && args.sample === null) || (args.sample !== null && !args.out)) {
    error(`${args.bad ? `${args.bad}\n` : ''}usage: reel-clip.js --shots | --sample <n> --out <dir>   [--catalog <path>] [--root <path>]`);
    return 2;
  }
  const root = args.root || defaultRoot(env);
  const ffmpeg = env.BPA_FFMPEG || 'ffmpeg';
  let catalog;
  try { catalog = JSON.parse(fs.readFileSync(args.catalog || defaultCatalog(env), 'utf8')); } catch (e) { error(`cannot read the catalogue: ${e.message}`); return 4; }
  const stretches = usableStretches(catalog);
  const analysed = await analyseStretches(stretches, { run: deps.run, root, ffmpeg });
  if (args.shots) {
    let safeN = 0; let safeSec = 0; let tooLong = 0;
    for (const s of analysed) {
      const reasons = {}; for (const d of s.dropped) reasons[d.reason] = (reasons[d.reason] || 0) + 1;
      log(`${s.id} ${s.startSec}-${s.endSec}s: shots ${s.found.length}, safe ${s.shots.length}, dropped ${s.dropped.length} ${JSON.stringify(reasons)}`);
      for (const h of s.shots) { safeN += 1; safeSec += h.endSec - h.startSec; if (h.endSec - h.startSec >= CLIP_MIN_SEC) tooLong += 1; }
    }
    const sim = simulateSupply(analysed);
    log(`stretches ${analysed.length}; safe shots ${safeN}, ${r2(safeSec)} s in total; shots of 6 s or more ${tooLong}`);
    log(`clips of 6 to 9 s without reuse (one greedy plan run): ${sim.clips}, ${sim.sec} s`);
    return 0;
  }
  const outDir = path.resolve(args.out);
  const tmpLedger = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-clip-usage-')), 'usage.jsonl'); // never the real ledger
  const fontFile = env.BPA_CLIP_FONT || null;
  let bad = 0;
  for (let i = 1; i <= Number(args.sample); i += 1) {
    const plan = planClip(analysed, { usedLedger: readUsage(tmpLedger), seed: `sample-${i}` });
    if (!plan.ok) { log(`sample ${i}: ${plan.reason}`); break; }
    const r = await renderClip(plan, { out: path.join(outDir, `sample-${i}.mp4`), hook: 'Sample text, not for posting', root, ffmpeg: env.BPA_FFMPEG_RENDER || ffmpeg, fontFile, run: deps.run });
    appendUsage(tmpLedger, plan.usedShots);
    const q = await checkRendered(r.file, { probe: deps.probe });
    if (!q.ok) bad += 1;
    log(`sample ${i}: ${r.file} ${r.durationSec} s, check ${q.ok ? 'ok' : `FAILED: ${q.problems.join('; ')}`}`);
    log(`  spans: ${r.spans.map((s) => `${s.id} ${s.startSec}-${s.endSec}`).join(' | ')}`);
  }
  return bad ? 5 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e.message); process.exitCode = 1; });
}
