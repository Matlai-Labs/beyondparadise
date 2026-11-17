// Clean stretches of the finished videos: where on-screen text is absent, and whether a small LOCAL vision
// model sees any text, mark or person in the sampled frames of that stretch. Node built-ins only.
//
//   node media-segments.js --run [--region east-africa] [--max-calls N] [--only <id>] [--frames-per-window N]
//   node media-segments.js --selftest [--spotcheck <path>]
//   node media-segments.js --summary
//
// Analysis layout this relies on (established from the files, see the README of the analysis step):
//   <root>/analysis/<folder>/<id>.onscreen.txt        one line per reading, "[12s] text", FIRST occurrence only
//   <root>/analysis/<folder>/frames/<id>/NNN.jpg      frame N is the sample at second (N-1)*2, 90 frames at most
//   Frames and stamps come from a working cut that starts at 0 and is at most 180 s long, so they share the
//   timeline of the original video.
//   Later parts of a longer video (optional, produced by the same local steps run on a later cut) sit beside it:
//   <root>/analysis/<folder>/parts/<offsetSec>/<id>.onscreen.txt and parts/<offsetSec>/frames/<id>/NNN.jpg. The folder
//   name IS the offset: stamps and frame numbers inside are local to the part (frame N = offset + (N-1)*2 s) and are
//   moved onto the original timeline here. A part counts only when the one before it is complete up to its offset.
//
// The model is the local one only. Every call goes through askLocal (local-model.js), the one guarded caller: it refuses any other
// host, a present stop flag, and a call over the per-run or per-day cap (fail closed). There is no request code and no code path
// to a cloud model in this file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic, assertOutsideRepo } from './media-catalog.js';
import { askLocal, defaultCounterFile } from './local-model.js';

export const FRAME_INTERVAL_SEC = 2;
export const MODEL = 'qwen2.5vl:3b';
export const MIN_WINDOW_SEC = 6;
export const DEFAULT_MAX_CALLS = 400;
export const DEFAULT_FRAMES_PER_WINDOW = 8;
export const PART_SEC = 180;

const finite = (x) => typeof x === 'number' && Number.isFinite(x);

// ---------------------------------------------------------------- windows

/** "[12s] text" lines -> the seconds, in file order. */
export function parseStamps(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\s*\[(\d+(?:\.\d+)?)s\]/.exec(line);
    if (m) out.push(Number(m[1]));
  }
  return [...new Set(out)];
}

/**
 * Stretches with no text reading. A reading at second t blocks [t - interval, t + interval] (text may have
 * appeared between two samples). Never beyond what the analysis covered. Shorter than minLenSec is dropped.
 */
export function findCleanWindows({ durationSec, textStamps, sampleIntervalSec = FRAME_INTERVAL_SEC, coveredUntilSec, minLenSec = MIN_WINDOW_SEC }) {
  if (!finite(durationSec) || durationSec <= 0) return [];
  const limit = finite(coveredUntilSec) ? Math.min(durationSec, coveredUntilSec) : durationSec;
  if (!(limit > 0)) return [];
  const I = finite(sampleIntervalSec) && sampleIntervalSec > 0 ? sampleIntervalSec : FRAME_INTERVAL_SEC;
  const blocks = (Array.isArray(textStamps) ? textStamps : []).filter(finite).sort((a, b) => a - b)
    .map((t) => [t - I, t + I]);
  const merged = [];
  for (const b of blocks) {
    const last = merged[merged.length - 1];
    if (last && b[0] <= last[1]) last[1] = Math.max(last[1], b[1]);
    else merged.push([...b]);
  }
  const out = [];
  let cursor = 0;
  const push = (a, b) => { const s = Math.max(0, a); const e = Math.min(limit, b); if (e - s >= minLenSec) out.push({ startSec: s, endSec: e }); };
  for (const [a, b] of merged) {
    if (a > cursor) push(cursor, a);
    cursor = Math.max(cursor, b);
  }
  if (cursor < limit) push(cursor, limit);
  return out;
}

/** Seconds (multiples of the interval) inside a window, thinned evenly to `max`, first and last kept. */
export function windowFrameSeconds(win, interval = FRAME_INTERVAL_SEC, max = DEFAULT_FRAMES_PER_WINDOW) {
  const all = [];
  for (let s = Math.ceil(win.startSec / interval) * interval; s <= win.endSec + 1e-9; s += interval) all.push(s);
  if (!(max >= 2) || all.length <= max) return all;
  const pick = [];
  for (let i = 0; i < max; i += 1) pick.push(all[Math.round((i * (all.length - 1)) / (max - 1))]);
  return [...new Set(pick)];
}

// ---------------------------------------------------------------- the frame check

export const PROMPT = 'Look at this image and answer with JSON only, no other text, in exactly this shape: '
  + '{"text": true or false, "person": true or false, "subject": "two words"}. '
  + '"text": true if any text, logo, watermark, caption, subtitle or channel mark is visible anywhere in the image, otherwise false. '
  + '"person": true if any human being is visible at all, even small, far away, partly hidden or seen from behind, otherwise false. '
  + '"subject": the main subject in two words; use one of: animal, landscape, beach, town, boat, food, building, people, other.';

function candidates(raw) {
  const out = [raw.trim()];
  for (let i = raw.indexOf('{'); i !== -1; i = raw.indexOf('{', i + 1)) {
    let depth = 0; let inStr = false; let esc = false;
    for (let j = i; j < raw.length; j += 1) {
      const c = raw[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth += 1;
      else if (c === '}') { depth -= 1; if (depth === 0) { out.push(raw.slice(i, j + 1)); break; } }
    }
  }
  return out;
}

/** Strict: a field is true/false only when the JSON holds exactly a boolean there; anything else is null. */
export function parseVerdict(raw) {
  const res = { text: null, person: null, label: null, raw: raw ?? null };
  if (typeof raw !== 'string') return res;
  for (const c of candidates(raw)) {
    let o;
    try { o = JSON.parse(c); } catch { continue; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
    if (typeof o.text === 'boolean') res.text = o.text;
    if (typeof o.person === 'boolean') res.person = o.person;
    if (typeof o.subject === 'string') {
      const s = o.subject.trim().toLowerCase();
      if (s && s.length <= 40) res.label = s;
    }
    return res;
  }
  return res;
}

/** One frame, three closed questions. A failed call is all null; a guard refusal is rethrown (it must stop the run). */
export async function checkFrame(file, { ask }) {
  let raw;
  try { raw = await ask(file, PROMPT); } catch (e) {
    if (e && e.guard) throw e;
    return { text: null, person: null, label: null, raw: null, error: e && e.message ? e.message : String(e) };
  }
  return parseVerdict(raw);
}

/** Clear only with >= 2 checked frames and EVERY frame text === false and person === false. */
export function judgeWindow(win, verdicts) {
  const v = Array.isArray(verdicts) ? verdicts : [];
  const reasons = [];
  if (v.length < 2) reasons.push(`fewer than 2 checked frames (${v.length})`);
  const n = (fn) => v.filter(fn).length;
  const textTrue = n((f) => f.text === true); const textUnk = n((f) => f.text !== true && f.text !== false);
  const perTrue = n((f) => f.person === true); const perUnk = n((f) => f.person !== true && f.person !== false);
  if (textTrue) reasons.push(`text seen in ${textTrue} frame(s)`);
  if (textUnk) reasons.push(`text answer unknown in ${textUnk} frame(s)`);
  if (perTrue) reasons.push(`person seen in ${perTrue} frame(s)`);
  if (perUnk) reasons.push(`person answer unknown in ${perUnk} frame(s)`);
  const counts = new Map();
  for (const f of v) if (f.label) counts.set(f.label, (counts.get(f.label) || 0) + 1);
  let label = null; let best = 0;
  for (const [k, c] of counts) if (c > best) { best = c; label = k; }
  return { startSec: win.startSec, endSec: win.endSec, frames: v.length, verdict: reasons.length === 0 ? 'clear' : 'not-clear', reasons, label };
}

// ---------------------------------------------------------------- the local model

const posInt = (x) => Number.isInteger(x) && x > 0;
const homeOf = (env) => env.HOME || os.homedir();

/**
 * The `ask(imagePath, prompt) -> string` the frame checks use. It only reads the image and calls askLocal (local-model.js),
 * the one guarded caller: host check, stop flags, per-run and per-day caps with the shared counter file. No request code lives here.
 * `askDeps` is passed straight to askLocal (baseUrl, fetchImpl, run, maxCalls, dailyCap, counterFile, stopOpts, now).
 */
export function makeLocalAsk({ model = MODEL, timeoutMs = 60_000, askDeps = {} } = {}) {
  const run = askDeps.run || { calls: 0 };
  const ask = async (imagePath, prompt) => {
    const image = fs.readFileSync(imagePath).toString('base64');
    return askLocal({ model, prompt, images: [image], format: 'json', temperature: 0, timeoutMs }, { ...askDeps, run });
  };
  ask.run = run;
  return ask;
}

// ---------------------------------------------------------------- catalogue

/** Returns a new catalogue with `segments` and the derived `hasClearSegment` set for the given ids. Nothing else changes. */
export function applySegments(catalog, byId) {
  const entries = (Array.isArray(catalog) ? catalog : (catalog && catalog.entries) || []).map((e) => {
    if (!Object.prototype.hasOwnProperty.call(byId, e.id)) return e;
    const segments = byId[e.id];
    return { ...e, segments, hasClearSegment: segments.some((s) => s.verdict === 'clear') };
  });
  return { ...(Array.isArray(catalog) ? {} : catalog), entries };
}

const pad = (n) => String(n).padStart(3, '0');
const analysisDir = (root, folder) => path.join(root, 'analysis', folder);
const frameIndex = (sec, I) => Math.round(sec / I) + 1;

function countFrames(dir) {
  try { return fs.readdirSync(dir).filter((f) => /^\d+\.jpg$/.test(f)).length; } catch { return 0; }
}

/**
 * Every analysed part of one video, on the original timeline. Part 0 is the original layout; later parts live in
 * parts/<offsetSec>/. A later part is used only when the part before it is complete (its frames reach the offset) and it
 * has both a stamp file and frames: a gap, or a part of unknown text, ends the coverage there (nothing beyond is claimed).
 * Stamps are moved onto the original timeline. The first sample of every later part also counts as a reading, because a
 * caption that began before the boundary and is still on screen would not be stamped again in a later cut that carries
 * its de-duplication over; the cost is at most one interval on each side of the boundary.
 */
export function loadCoverage(root, entry, interval = FRAME_INTERVAL_SEC) {
  const base = analysisDir(root, entry.folder);
  let text0;
  try { text0 = fs.readFileSync(path.join(base, `${entry.id}.onscreen.txt`), 'utf8'); } catch { return { skipped: 'no on-screen text file' }; }
  const dir0 = path.join(base, 'frames', entry.id);
  const count0 = countFrames(dir0);
  if (count0 === 0) return { skipped: 'no frames' };
  const parts = [{ offsetSec: 0, dir: dir0, count: count0 }];
  const stamps = parseStamps(text0);
  let covered = count0 * interval;
  let offsets = [];
  try { offsets = fs.readdirSync(path.join(base, 'parts')).filter((d) => /^\d+$/.test(d)).map(Number).sort((a, b) => a - b); } catch { /* no parts */ }
  for (const off of offsets) {
    if (off <= 0 || off > covered) break; // gap: the previous part does not reach this offset
    if (off < covered) continue; // overlaps what is already covered: not used, the earlier part wins
    const pdir = path.join(base, 'parts', String(off));
    let ptext;
    try { ptext = fs.readFileSync(path.join(pdir, `${entry.id}.onscreen.txt`), 'utf8'); } catch { break; }
    const dir = path.join(pdir, 'frames', entry.id);
    const count = countFrames(dir);
    if (count === 0) break;
    parts.push({ offsetSec: off, dir, count });
    for (const t of parseStamps(ptext)) stamps.push(off + t);
    stamps.push(off);
    covered = off + count * interval;
  }
  const frameFor = (sec) => {
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const p = parts[i];
      if (sec >= p.offsetSec) {
        const idx = frameIndex(sec - p.offsetSec, interval);
        return idx <= p.count ? path.join(p.dir, `${pad(idx)}.jpg`) : null;
      }
    }
    return null;
  };
  return { stamps: [...new Set(stamps)], covered, parts, frameFor };
}

/** The pieces of [a,b] not inside any of the `taken` ranges, each at least minLen long. */
export function subtractRanges(win, taken, minLen = MIN_WINDOW_SEC) {
  let pieces = [{ startSec: win.startSec, endSec: win.endSec }];
  for (const t of taken) {
    pieces = pieces.flatMap((p) => {
      if (t.endSec <= p.startSec || t.startSec >= p.endSec) return [p];
      const out = [];
      if (t.startSec > p.startSec) out.push({ startSec: p.startSec, endSec: t.startSec });
      if (t.endSec < p.endSec) out.push({ startSec: t.endSec, endSec: p.endSec });
      return out;
    });
  }
  return pieces.filter((p) => p.endSec - p.startSec >= minLen);
}

/**
 * Windows and verdicts for one video. `skipped` says why nothing was done; text of unknown extent is never treated as none.
 * Segments already in the catalogue are kept exactly as they are (times, verdicts, any later review) and are not asked about
 * again: only the parts of new windows that lie outside them are judged, and `segments` is the old ones plus the new ones.
 */
export async function processVideo({ entry, root, ask, interval = FRAME_INTERVAL_SEC, maxFramesPerWindow = DEFAULT_FRAMES_PER_WINDOW, minLenSec = MIN_WINDOW_SEC, model = MODEL, now = () => new Date() }) {
  const cov = loadCoverage(root, entry, interval);
  if (cov.skipped) return { segments: null, calls: 0, skipped: cov.skipped };
  if (!finite(entry.durationSec) || entry.durationSec <= 0) return { segments: null, calls: 0, skipped: 'duration unknown' };
  const covered = Math.min(entry.durationSec, cov.covered);
  const existing = Array.isArray(entry.segments) ? entry.segments : [];
  const windows = findCleanWindows({ durationSec: entry.durationSec, textStamps: cov.stamps, sampleIntervalSec: interval, coveredUntilSec: covered, minLenSec })
    .flatMap((w) => subtractRanges(w, existing, minLenSec));
  const segments = [];
  let calls = 0;
  for (const w of windows) {
    const verdicts = [];
    for (const s of windowFrameSeconds(w, interval, maxFramesPerWindow)) {
      const file = cov.frameFor(s);
      if (!file) continue;
      calls += 1;
      verdicts.push(await checkFrame(file, { ask }));
    }
    const j = judgeWindow(w, verdicts);
    segments.push({ startSec: j.startSec, endSec: j.endSec, frames: j.frames, verdict: j.verdict, reasons: j.reasons, label: j.label, checkedAt: now().toISOString(), model });
  }
  return { segments: [...existing, ...segments].sort((a, b) => a.startSec - b.startSec), calls, skipped: null };
}

// ---------------------------------------------------------------- selftest

const spread = (arr, n) => (arr.length <= n ? arr : Array.from({ length: n }, (_, i) => arr[Math.floor((i * arr.length) / n)]));

/** Round-robin over videos so the sample is not one video. */
function roundRobin(lists, n) {
  const out = []; const idx = lists.map(() => 0);
  while (out.length < n && lists.some((l, i) => idx[i] < l.length)) {
    lists.forEach((l, i) => { if (out.length < n && idx[i] < l.length) { out.push(l[idx[i]]); idx[i] += 1; } });
  }
  return out;
}

/** Positives: frames at seconds with a recorded text reading. Negatives: frames inside candidate clean windows. */
export async function selftest({ entries, root, ask, interval = FRAME_INTERVAL_SEC, perSet = 30, spotFalse = 8, spotTrue = 4, now = () => Date.now() }) {
  const pos = []; const neg = [];
  for (const e of entries) {
    const cov = loadCoverage(root, e, interval);
    if (cov.skipped || !finite(e.durationSec)) continue;
    const covered = Math.min(e.durationSec, cov.covered);
    const f = (s) => cov.frameFor(s);
    pos.push(spread(cov.stamps.map(f).filter(Boolean), perSet));
    const wins = findCleanWindows({ durationSec: e.durationSec, textStamps: cov.stamps, sampleIntervalSec: interval, coveredUntilSec: covered });
    neg.push(spread(wins.flatMap((w) => windowFrameSeconds(w, interval, 99)).map(f).filter(Boolean), perSet));
  }
  const posFiles = roundRobin(pos, perSet); const negFiles = roundRobin(neg, perSet);
  let calls = 0; let ms = 0;
  const run = async (file) => { const t = now(); const v = await checkFrame(file, { ask }); ms += now() - t; calls += 1; return { file, ...v }; };
  const posRes = []; for (const f of posFiles) posRes.push(await run(f));
  const negRes = []; for (const f of negFiles) negRes.push(await run(f));
  const tally = (arr, k) => ({ true: arr.filter((r) => r[k] === true).length, false: arr.filter((r) => r[k] === false).length, null: arr.filter((r) => r[k] === null).length });
  const all = [...posRes, ...negRes];
  const personFalse = spread(all.filter((r) => r.person === false), spotFalse);
  const personTrue = spread(all.filter((r) => r.person === true), spotTrue);
  return {
    knownText: { frames: posRes.length, ...tally(posRes, 'text') },
    windowFrames: { frames: negRes.length, ...tally(negRes, 'text') },
    unparsable: all.filter((r) => r.text === null).length,
    person: tally(all, 'person'),
    meanSecondsPerCall: calls ? ms / calls / 1000 : null,
    calls,
    spot: [...personFalse.map((r) => [r.file, 'person:false']), ...personTrue.map((r) => [r.file, 'person:true'])],
  };
}

// ---------------------------------------------------------------- command

function parseArgs(argv) {
  const a = { run: false, selftest: false, summary: false, region: 'east-africa', maxCalls: DEFAULT_MAX_CALLS, only: null, spotcheck: null, framesPerWindow: DEFAULT_FRAMES_PER_WINDOW, bad: null };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--run') a.run = true;
    else if (t === '--selftest') a.selftest = true;
    else if (t === '--summary') a.summary = true;
    else if (['--region', '--max-calls', '--only', '--spotcheck', '--frames-per-window'].includes(t)) {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) { a.bad = `${t} needs a value`; break; }
      i += 1;
      if (t === '--region') a.region = v;
      else if (t === '--only') a.only = v;
      else if (t === '--spotcheck') a.spotcheck = v;
      else {
        const n = Number(v);
        if (!posInt(n)) { a.bad = `${t} needs a positive whole number`; break; }
        if (t === '--max-calls') a.maxCalls = n; else a.framesPerWindow = n;
      }
    } else { a.bad = `unknown argument ${t}`; break; }
  }
  return a;
}

const asEntries = (c) => (Array.isArray(c) ? c : (c && c.entries) || []);
const usage = 'usage: media-segments.js --run [--region east-africa] [--max-calls N] [--only <id>] [--frames-per-window N] | --selftest [--spotcheck <path>] | --summary';

function summarise(catalog) {
  const lines = [];
  const labels = {}; let videos = 0; let withClear = 0; let totalClear = 0;
  for (const e of asEntries(catalog)) {
    if (!Array.isArray(e.segments)) continue;
    videos += 1;
    const clear = e.segments.filter((s) => s.verdict === 'clear');
    const secs = clear.reduce((m, s) => m + (s.endSec - s.startSec), 0);
    if (clear.length) withClear += 1;
    totalClear += secs;
    for (const s of clear) labels[s.label ?? 'none'] = (labels[s.label ?? 'none'] || 0) + 1;
    lines.push(`  ${e.id}: windows ${e.segments.length}, clear ${clear.length}, clear seconds ${Math.round(secs)}`);
  }
  return [`videos with segments: ${videos}`, `videos with a clear segment: ${withClear}`, `total clear seconds: ${Math.round(totalClear)}`,
    'per video:', ...lines, 'labels of clear windows:', ...Object.entries(labels).sort().map(([k, v]) => `  ${k}: ${v}`)].join('\n');
}

export async function main(argv, env = process.env, deps = {}) {
  const log = deps.log || ((s) => console.log(s));
  const error = deps.error || ((s) => console.error(s));
  const args = parseArgs(argv);
  if (args.bad || (!args.run && !args.selftest && !args.summary)) { error(`${args.bad ? `${args.bad}\n` : ''}${usage}`); return 2; }
  const home = homeOf(env);
  const root = env.BPA_MEDIA_ROOT || path.join(home, 'Movies', 'Beyond Paradise', 'youtube-archive');
  const catPath = path.resolve(env.BPA_MEDIA_CATALOG || path.join(home, '.matlai', 'bpa-media-catalog.json'));
  try { assertOutsideRepo(catPath, { repoRoot: deps.repoRoot, gitTopLevel: deps.gitTopLevel }); } catch (e) { error(e.message); return 3; }
  const readCat = () => JSON.parse(fs.readFileSync(catPath, 'utf8'));
  let catalog;
  try { catalog = readCat(); } catch (e) { error(`cannot read the catalogue: ${e.message}`); return 4; }

  if (args.summary) { log(summarise(catalog)); return 0; }

  const run = { calls: 0 };
  const ask = makeLocalAsk({ askDeps: {
    ...(deps.ollamaUrl ? { baseUrl: deps.ollamaUrl } : {}), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), run, maxCalls: args.maxCalls,
    counterFile: defaultCounterFile(env), stopOpts: { env }, ...(deps.now ? { now: deps.now } : {}),
  } });
  const candidates = asEntries(catalog).filter((e) => e && e.flags && e.flags.region === args.region && e.flags.otherPublisherMark !== true && !e.missing
    && (!args.only || e.id === args.only));

  if (args.selftest) {
    try {
      const r = await selftest({ entries: candidates, root, ask });
      log(`known-text frames: ${r.knownText.frames}`);
      log(`  called text: true: ${r.knownText.true}  false: ${r.knownText.false}  unparsable: ${r.knownText.null}`);
      log(`window frames: ${r.windowFrames.frames}`);
      log(`  called text: false: ${r.windowFrames.false}  true: ${r.windowFrames.true}  unparsable: ${r.windowFrames.null}`);
      log(`unparsable: ${r.unparsable}`);
      log(`person answers over all ${r.calls} frames: true ${r.person.true}, false ${r.person.false}, null ${r.person.null}`);
      log(`mean seconds per call: ${r.meanSecondsPerCall === null ? 'n/a' : r.meanSecondsPerCall.toFixed(2)}`);
      const spot = path.resolve(args.spotcheck || path.join(os.tmpdir(), 'segments-spotcheck.txt'));
      fs.writeFileSync(spot, r.spot.map(([f, v]) => `${f}\t${v}`).join('\n') + (r.spot.length ? '\n' : ''));
      log(`spot-check list: ${r.spot.length} paths written`);
      return 0;
    } catch (e) {
      error(e && e.guard ? `stopped by guard: ${e.message}` : `selftest failed: ${e.message}`);
      return e && e.guard ? 5 : 1;
    }
  }

  const started = Date.now();
  let done = 0;
  for (const e of candidates) {
    let r;
    try {
      r = await processVideo({ entry: e, root, ask, maxFramesPerWindow: args.framesPerWindow, now: deps.now });
    } catch (err) {
      error(err && err.guard ? `stopped by guard: ${err.message} (video ${e.id} not written)` : `video ${e.id} failed: ${err.message}`);
      return err && err.guard ? 5 : 1;
    }
    if (r.skipped) { log(`${e.id}: skipped (${r.skipped})`); continue; }
    const fresh = readCat();
    const next = applySegments(fresh, { [e.id]: r.segments });
    next.updatedAt = new Date().toISOString();
    writeFileAtomic(catPath, `${JSON.stringify(next, null, 2)}\n`);
    done += 1;
    const clear = r.segments.filter((s) => s.verdict === 'clear');
    log(`${e.id}: windows ${r.segments.length}, clear ${clear.length}, clear seconds ${Math.round(clear.reduce((m, s) => m + s.endSec - s.startSec, 0))}, calls ${r.calls}`);
  }
  log(`done: ${done} videos, ${run.calls} model calls, ${((Date.now() - started) / 1000).toFixed(0)} s`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
}
