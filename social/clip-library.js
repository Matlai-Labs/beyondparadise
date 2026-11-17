// A FIXED set of short silent vertical clips, rendered once, looked at densely, and only the ones that pass
// enter a private library. Clips are NOT cut on the fly for posting. Node built-ins only, local ffmpeg
// only, no network, nothing is uploaded or posted from here. Sources are only read.
//
//   node clip-library.js --build [--catalog <path>] [--root <path>]
//   node clip-library.js --summary
//   node clip-library.js --verdict <id> pass|fail --by <text> [--notes <text>]
//   node clip-library.js --shows <id> <tag,tag,...> --by <text> [--notes <text>]   what the clip shows (fixed vocabulary), recorded by the reviewer
//
// Why: reel-clip.js checks stretches one frame every 2 s and its shot detection misses dissolves, wipes
// and a white flash, so a clip can contain a short scene nobody looked at. Here every rendered clip is
// looked at at 4 frames a second by a reviewer, and the verdict is recorded in the manifest.
// The library folder and the manifest live OUTSIDE every repository (default ~/Movies/Beyond Paradise/clip-library,
// override BPA_CLIP_LIBRARY). No text is ever drawn on these clips.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertOutsideRepo, writeFileAtomic } from './media-catalog.js';
import {
  usableStretches, analyseStretches, planClip, renderClip, checkRendered, readUsage, defaultRoot, defaultCatalog, defaultUsagePath,
} from './reel-clip.js';

const execFileP = promisify(execFile);
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const home = (env) => env.HOME || os.homedir();

/** Average luma (0..255) above / below which a frame counts as white-out / black-out. */
export const FLASH_HIGH_LUMA = 230;
export const FLASH_LOW_LUMA = 12;
export const FLASH_MIN_FRAMES = 2;
const FLASH_MERGE_SEC = 0.25;
const OVERLAP_SEC = 0.1; // the same threshold reel-clip.js uses for its ledger

export const libraryDir = (env = process.env) => env.BPA_CLIP_LIBRARY || path.join(home(env), 'Movies', 'Beyond Paradise', 'clip-library');
export const manifestPath = (dir) => path.join(dir, 'manifest.json');

const defaultRun = (cmd, args) => execFileP(cmd, args, { timeout: 600_000, maxBuffer: 64 << 20 });

// ---------------------------------------------------------------- 1. plan every clip the supply gives

/**
 * Plan ALL clips the usable stretches give without reuse: planClip with an in-memory ledger until
 * "nothing left". Async because the shots of each stretch are detected with ffmpeg (pass `analysed` to skip that).
 * Returns [{ ok, id, spans, durationSec, subject, source }] sorted by id.
 */
export async function buildPlan(catalog, { seed = 'clip-library', run, root, ffmpeg = 'ffmpeg', analysed = null } = {}) {
  const stretches = usableStretches(catalog);
  const all = analysed || await analyseStretches(stretches, { run, root, ffmpeg });
  const subjectOf = (span) => {
    const st = all.find((s) => s.id === span.id && span.startSec >= s.startSec - 0.05 && span.endSec <= s.endSec + 0.05);
    return st ? st.subject : null;
  };
  const ledger = []; const plan = [];
  for (let i = 0; i < 1000; i += 1) {
    const p = planClip(all, { usedLedger: ledger, seed: `${seed}-${i}` });
    if (!p.ok) break;
    ledger.push(...p.usedShots);
    const first = p.spans[0];
    plan.push({
      ok: true,
      id: `clip-${first.id}-${Math.round(first.startSec * 10)}`,
      spans: p.spans.map((s) => ({ id: s.id, file: s.file, startSec: s.startSec, endSec: s.endSec })),
      durationSec: p.durationSec,
      subject: subjectOf(first),
      source: p.spans.map((s) => ({ videoId: s.id, startSec: s.startSec, endSec: s.endSec })),
    });
  }
  return plan.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------- 2. render + manifest

export function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function writeManifest(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(manifestPath(dir), `${JSON.stringify(manifest, null, 2)}\n`);
}

const sameSource = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && a.every((s, i) => s.videoId === b[i].videoId && s.startSec === b[i].startSec && s.endSec === b[i].endSec);

/**
 * Render every planned clip WITHOUT text into `dir`, check each, and write `manifest.json` (atomic, 0600).
 * A clip whose id, file and source spans are unchanged and whose file is present is kept as it is (not
 * re-rendered) with its `verified` and `flash`; a changed or missing one is rendered again and both reset to null.
 * Clips of an earlier manifest that are no longer planned leave the manifest; their files are never deleted.
 */
export async function renderLibrary(plan, { dir = libraryDir(), run = defaultRun, probe, root = defaultRoot(), ffmpeg = 'ffmpeg', repoRoot, gitTopLevel, now = () => new Date() } = {}) {
  dir = path.resolve(dir);
  try { assertOutsideRepo(dir, { repoRoot, gitTopLevel }); } catch (e) { throw new Error(`the clip library folder must be outside every repository: ${e.message}`); }
  const rel = path.relative(path.resolve(root), dir);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error('refusing to put the clip library inside the media root: the source videos must not be touched');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const old = readManifest(dir);
  const oldById = new Map(((old && old.clips) || []).map((c) => [c.id, c]));
  const clips = []; const counts = { planned: plan.length, rendered: 0, kept: 0, renderFailed: 0, droppedFromManifest: 0 };
  for (const p of plan) {
    const file = `${p.id}.mp4`; const out = path.join(dir, file);
    const source = p.source || p.spans.map((s) => ({ videoId: s.id, startSec: s.startSec, endSec: s.endSec }));
    const prev = oldById.get(p.id);
    if (prev && prev.file === file && sameSource(prev.source, source) && fs.existsSync(out)) {
      clips.push({ ...prev, durationSec: p.durationSec, subject: p.subject ?? prev.subject ?? null });
      counts.kept += 1;
      continue;
    }
    let checks; let durationSec = p.durationSec;
    try {
      await renderClip(p, { out, hook: null, run, root, ffmpeg, repoRoot, gitTopLevel });
      const q = await checkRendered(out, { probe });
      checks = q.ok ? 'ok' : q.problems;
      if (q.durationSec !== null) durationSec = r2(q.durationSec);
    } catch (e) {
      checks = [`render failed: ${String(e.message).split('\n')[0]}`];
    }
    if (checks !== 'ok') counts.renderFailed += 1;
    counts.rendered += 1;
    clips.push({ id: p.id, file, durationSec, source, subject: p.subject ?? null, renderedAt: now().toISOString(), checks: { rendered: checks }, flash: null, verified: null });
  }
  counts.droppedFromManifest = [...oldById.keys()].filter((id) => !plan.some((p) => p.id === id)).length;
  const manifest = { version: 1, updatedAt: now().toISOString(), clips };
  writeManifest(dir, manifest);
  return { manifest, counts, dir };
}

// ---------------------------------------------------------------- 3. flash check

/** `[{ t, y }]` from `metadata=print` output: a `pts_time:` line followed by `lavfi.signalstats.YAVG=`. */
export function parseLumaFrames(text) {
  const out = []; let t = null;
  for (const line of String(text ?? '').split('\n')) {
    const m = /pts_time:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (m) { t = Number(m[1]); continue; }
    const y = /lavfi\.signalstats\.YAVG=\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (y && t !== null) { out.push({ t, y: Number(y[1]) }); t = null; }
  }
  return out;
}

export function parseBlackIntervals(stderr) {
  const out = [];
  for (const m of String(stderr ?? '').matchAll(/blackdetect[^\n]*?black_start:\s*(-?\d+(?:\.\d+)?)\s+black_end:\s*(-?\d+(?:\.\d+)?)/g)) out.push({ start: Number(m[1]), end: Number(m[2]) });
  return out;
}

/** Seconds where a run of at least 2 frames is above the high or below the low luma, plus blackdetect intervals; near ones merge. */
export function findFlashes(frames, black = [], { high = FLASH_HIGH_LUMA, low = FLASH_LOW_LUMA, minFrames = FLASH_MIN_FRAMES } = {}) {
  const at = [];
  let runStart = null; let runLen = 0; let runKind = null;
  const close = () => { if (runLen >= minFrames) at.push(runStart); runStart = null; runLen = 0; runKind = null; };
  for (const f of frames) {
    const kind = f.y > high ? 'white' : f.y < low ? 'black' : null;
    if (kind && kind === runKind) { runLen += 1; continue; }
    close();
    if (kind) { runKind = kind; runStart = f.t; runLen = 1; }
  }
  close();
  for (const b of black) at.push(b.start);
  const merged = [];
  for (const t of at.sort((a, b) => a - b)) if (!merged.length || t - merged[merged.length - 1] > FLASH_MERGE_SEC) merged.push(t);
  return merged.map(r3);
}

/** `{ flash, atSec }` for one rendered file: signalstats YAVG per frame plus blackdetect. No frames at all is an error. */
export async function detectFlash(file, { run = defaultRun, ffmpeg = 'ffmpeg' } = {}) {
  const args = ['-nostdin', '-hide_banner', '-i', file, '-an',
    '-vf', 'blackdetect=d=0.06:pix_th=0.1,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'];
  const { stdout, stderr } = await run(ffmpeg, args);
  const frames = parseLumaFrames(stdout);
  if (!frames.length) throw new Error(`no frames measured in ${path.basename(file)}`);
  const atSec = findFlashes(frames, parseBlackIntervals(stderr));
  return { flash: atSec.length > 0, atSec };
}

// ---------------------------------------------------------------- 4. who may be used

const overlaps = (a, b) => Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec) > OVERLAP_SEC;
const inLedger = (clip, usage) => (usage || []).some((u) => u && (
  (typeof u.clipId === 'string' && u.clipId === clip.id)
  || (typeof u.id === 'string' && finite(u.startSec) && finite(u.endSec) && (clip.source || []).some((s) => s.videoId === u.id && overlaps(s, u)))));

/** Only clips rendered ok, flash.flash === false, verified.verdict === "pass", file present, not in the usage ledger. */
export function eligibleClips(manifest, usage = [], { dir = libraryDir(), exists = fs.existsSync } = {}) {
  const clips = manifest && Array.isArray(manifest.clips) ? manifest.clips : [];
  return clips.filter((c) => c
    && c.checks && c.checks.rendered === 'ok'
    && c.flash && c.flash.flash === false
    && c.verified && c.verified.verdict === 'pass'
    && typeof c.file === 'string' && c.file !== '' && exists(path.join(dir, c.file))
    && !inLedger(c, usage));
}

// ---------------------------------------------------------------- 5. verdicts

/** Words that would describe a person. Deliberately blunt: "person at 3.5 s" is what a note should look like. */
const PERSON_WORDS = /\b(man|men|woman|women|boy|girl|child|children|kid|kids|lady|guy|male|female|young|elderly|wearing|wears|shirt|dress|hat|hair|skin|face|beard|bald|blonde)\b/i;

/** The only way a verdict is written. Returns a NEW manifest; the input is not changed. */
export function setVerdict(manifest, id, { verdict, by, at = new Date().toISOString(), notes = '' } = {}) {
  const clips = manifest && Array.isArray(manifest.clips) ? manifest.clips : [];
  if (!clips.some((c) => c.id === id)) throw new Error(`unknown clip ${id}`);
  if (verdict !== 'pass' && verdict !== 'fail') throw new Error('verdict must be exactly "pass" or "fail"');
  if (typeof by !== 'string' || !by.trim()) throw new Error('a verdict needs "by" (who looked, how)');
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) throw new Error('"at" must be a date');
  if (typeof notes !== 'string' || notes.length > 300) throw new Error('notes must be text of at most 300 characters');
  if (PERSON_WORDS.test(notes)) throw new Error('notes may not describe a person: write the reason only, like "person at 3.5 s"');
  return { ...manifest, clips: clips.map((c) => (c.id === id ? { ...c, verified: { verdict, by: by.trim(), at, notes } } : c)) };
}

// ---------------------------------------------------------------- what a clip shows

/** What a reviewer may record a clip as showing: lowercase, singular, fixed. Animal tags are the ones a fact can be paired on (auto-pairing.js); scene tags are descriptive only. */
export const ANIMAL_TAGS = Object.freeze(['lion', 'elephant', 'buffalo', 'zebra', 'hippo', 'wildebeest', 'crocodile', 'bird', 'giraffe', 'cheetah', 'leopard', 'hyena', 'rhino', 'wild-dog']);
export const SCENE_TAGS = Object.freeze(['savanna', 'wetland', 'river', 'river-crossing', 'volcano', 'landscape']);
export const SHOW_TAGS = Object.freeze([...ANIMAL_TAGS, ...SCENE_TAGS]);

/** The only way `shows` is written (the `subject` field of the manifest is unreliable and is never used for pairing). Returns a NEW manifest. Errors carry code 'unknown-clip' or 'bad-shows'. */
export function setShows(manifest, id, { tags, by, at = new Date().toISOString(), notes = '' } = {}) {
  const fail = (code, msg) => Object.assign(new Error(msg), { code });
  const clips = manifest && Array.isArray(manifest.clips) ? manifest.clips : [];
  if (!clips.some((c) => c.id === id)) throw fail('unknown-clip', `unknown clip ${id}`);
  if (!Array.isArray(tags) || tags.length === 0) throw fail('bad-shows', 'give at least one tag');
  const bad = tags.filter((t) => typeof t !== 'string' || !SHOW_TAGS.includes(t)); if (bad.length) throw fail('bad-shows', `unknown tag ${bad.map((t) => JSON.stringify(t)).join(', ')} (allowed: ${SHOW_TAGS.join(', ')})`);
  if (typeof by !== 'string' || !by.trim()) throw fail('bad-shows', 'a record of what a clip shows needs "by" (who looked, how)');
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) throw fail('bad-shows', '"at" must be a date');
  if (typeof notes !== 'string' || notes.length > 300) throw fail('bad-shows', 'notes must be text of at most 300 characters');
  if (PERSON_WORDS.test(notes)) throw fail('bad-shows', 'notes may not describe a person');
  return { ...manifest, clips: clips.map((c) => (c.id === id ? { ...c, shows: { tags: [...new Set(tags)], by: by.trim(), at, notes } } : c)) };
}

// ---------------------------------------------------------------- summary

export function summarise(manifest, usage = [], opts = {}) {
  const clips = manifest && Array.isArray(manifest.clips) ? manifest.clips : [];
  const eligible = eligibleClips(manifest, usage, opts);
  const count = (f) => clips.filter(f).length;
  return {
    total: clips.length,
    renderOk: count((c) => c.checks && c.checks.rendered === 'ok'),
    renderFailed: count((c) => !(c.checks && c.checks.rendered === 'ok')),
    flash: count((c) => c.flash && c.flash.flash === true),
    flashChecked: count((c) => c.flash && typeof c.flash.flash === 'boolean'),
    pass: count((c) => c.verified && c.verified.verdict === 'pass'),
    fail: count((c) => c.verified && c.verified.verdict === 'fail'),
    unverified: count((c) => !c.verified),
    eligible: eligible.length,
    eligibleSec: r2(eligible.reduce((a, c) => a + (finite(c.durationSec) ? c.durationSec : 0), 0)),
  };
}

// ---------------------------------------------------------------- command line

function parseArgs(argv) {
  const a = { build: false, summary: false, verdict: null, word: null, shows: null, tagList: null, by: null, notes: '', catalog: null, root: null, bad: null };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--build') a.build = true;
    else if (t === '--summary') a.summary = true;
    else if (t === '--verdict') {
      if (!argv[i + 1] || !argv[i + 2] || argv[i + 1].startsWith('--') || argv[i + 2].startsWith('--')) { a.bad = '--verdict needs <id> pass|fail'; break; }
      a.verdict = argv[i + 1]; a.word = argv[i + 2]; i += 2;
    } else if (t === '--shows') {
      if (!argv[i + 1] || !argv[i + 2] || argv[i + 1].startsWith('--') || argv[i + 2].startsWith('--')) { a.bad = '--shows needs <id> <tag,tag,...>'; break; }
      a.shows = argv[i + 1]; a.tagList = argv[i + 2]; i += 2;
    } else if (['--by', '--notes', '--catalog', '--root'].includes(t)) {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) { a.bad = `${t} needs a value`; break; }
      a[t.slice(2)] = argv[i + 1]; i += 1;
    } else { a.bad = `unknown argument ${t}`; break; }
  }
  if (!a.bad && [a.build, a.summary, a.verdict !== null, a.shows !== null].filter(Boolean).length !== 1) a.bad = 'give exactly one of --build, --summary, --verdict, --shows';
  return a;
}

export async function main(argv, env = process.env, deps = {}) {
  const log = deps.log || ((s) => console.log(s));
  const error = deps.error || ((s) => console.error(s));
  const args = parseArgs(argv);
  if (args.bad) {
    error(`${args.bad}\nusage: clip-library.js --build [--catalog <path>] [--root <path>] | --summary | --verdict <id> pass|fail --by <text> [--notes <text>] | --shows <id> <tag,tag,...> --by <text> [--notes <text>]`);
    return 2;
  }
  const dir = path.resolve(libraryDir(env));
  const usageFile = defaultUsagePath(env);
  if (args.build) {
    const root = args.root || defaultRoot(env);
    let catalog;
    try { catalog = JSON.parse(fs.readFileSync(args.catalog || defaultCatalog(env), 'utf8')); } catch (e) { error(`cannot read the catalogue: ${e.message}`); return 4; }
    const ffmpeg = env.BPA_FFMPEG || 'ffmpeg';
    const renderBin = env.BPA_FFMPEG_RENDER || ffmpeg;
    const plan = await buildPlan(catalog, { seed: 'clip-library', run: deps.run, root, ffmpeg });
    let result;
    try {
      result = await renderLibrary(plan, { dir, run: deps.run, probe: deps.probe, root, ffmpeg: renderBin, repoRoot: deps.repoRoot, gitTopLevel: deps.gitTopLevel });
    } catch (e) { error(e.message); return 3; }
    let flashErrors = 0;
    for (const c of result.manifest.clips) {
      if (c.checks.rendered !== 'ok' || c.flash !== null) continue;
      try { c.flash = await detectFlash(path.join(dir, c.file), { run: deps.run, ffmpeg }); } catch (e) { flashErrors += 1; error(`flash check failed for ${c.id}: ${e.message}`); }
    }
    result.manifest.updatedAt = new Date().toISOString();
    writeManifest(dir, result.manifest);
    const flashed = result.manifest.clips.filter((c) => c.flash && c.flash.flash);
    log(`planned ${result.counts.planned}, rendered ${result.counts.rendered}, kept ${result.counts.kept}, render check failed ${result.counts.renderFailed}, flash ${flashed.length}, flash check errors ${flashErrors}`);
    for (const c of flashed) log(`  flash ${c.id} at ${c.flash.atSec.join(', ')} s`);
    log(`library: ${dir}`);
    return result.counts.renderFailed || flashErrors ? 5 : 0;
  }
  const manifest = readManifest(dir);
  if (!manifest) { error(`no manifest in ${dir}: run --build first`); return 4; }
  if (args.summary) {
    const s = summarise(manifest, readUsage(usageFile), { dir });
    log(`clips ${s.total}; render ok ${s.renderOk}, failed ${s.renderFailed}; flash ${s.flash} (checked ${s.flashChecked}); verdict pass ${s.pass}, fail ${s.fail}, none ${s.unverified}; eligible ${s.eligible} (${s.eligibleSec} s)`);
    for (const c of manifest.clips || []) { const t = c && c.shows && Array.isArray(c.shows.tags) && c.shows.tags.length ? c.shows.tags.join(', ') : null; log(`  ${c.id}  ${t ? `shows: ${t}` : 'no tags'}`); }
    return 0;
  }
  if (args.shows !== null) {
    if (typeof args.by !== 'string' || !args.by.trim()) { error('--shows needs --by <text>'); return 2; } // refused before anything is read for writing
    try {
      const next = setShows(manifest, args.shows, { tags: args.tagList.split(',').map((x) => x.trim()).filter(Boolean), by: args.by, notes: args.notes });
      next.updatedAt = new Date().toISOString();
      writeManifest(dir, next);
    } catch (e) { error(e.message); return e.code === 'unknown-clip' ? 4 : 2; }
    log(`shows: ${args.shows} ${args.tagList}`);
    return 0;
  }
  try {
    const next = setVerdict(manifest, args.verdict, { verdict: args.word, by: args.by ?? '', notes: args.notes });
    next.updatedAt = new Date().toISOString();
    writeManifest(dir, next);
  } catch (e) { error(e.message); return 4; }
  log(`${args.verdict}: ${args.word}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e.message); process.exitCode = 1; });
}
