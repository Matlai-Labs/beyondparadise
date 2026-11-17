#!/usr/bin/env node
// The automatic lane (B9b). ONE class of Instagram post may go out without a per-post approval: built only from an idea's own sourced claim sentences
// (word for word, fact-post.js), a clip from the checked private library with the hook laid over it (overlay.js), every check passed, at most one a day,
// a report to the owner, and `bpa stop` stops it. There is NO model on this path: no sentence is written by a model, so nothing is judged by one.
//
//   prepareAutoPost({ pool, manifest, usage, history, config, now }, deps) -> { ok:true, draft, clip, idea, refused, checks } | { ok:false, reasons, detail?, refused }
//   ensureDailyAuto(deps)    called by worker.js AFTER its existing work, only when config.autoPublish === true (this module is not even loaded otherwise)
//   afterAutoPublish(d, r)   called by worker.js after a SUCCESSFUL publish: usage ledger, status, one alert
//   node auto-lane.js --rehearse [--count 1] [--out <dir>] [--history-queue <queue.json>]   <count> full preparations (each its own clip and idea) against the real pool and library, nothing queued, hosted or posted
//   node auto-lane.js --supply [--top 30] [--history-queue <queue.json>]        how many of the top ideas survive the text checks, refusal reasons counted, and how many of them have a fitting clip
//
// PAIRING (auto-pairing.js): a fact goes only over footage that fits it. The animal the idea is about must be among the tags a reviewer recorded for the clip
// (clip-library.js --shows); the pairing test runs BEFORE the text checks, so MAX_IDEAS_PER_RUN counts only ideas that have a fitting, eligible, unused clip.
// An idea may carry a hand-written, approved hook (auto-hooks.js) that replaces the title hook; config.autoRequireApprovedHook === true refuses ideas without one.
//
// Publishing is NOT done here. The queued item (status scheduled, ig.status queued, auto:true, no Facebook leg) is published by the EXISTING worker path:
// stop check, final check, cap reservation, claim, host, publish (worker.js -> igPostDraftAny -> postReadyReel in lib.js).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CONFIG, QUEUE_PATH, STATUS, finalCheck, loadQueue, saveQueue, nextId, withQueueLock, whatsapp, log, igEnabled, autoDir, autoTextHash } from './lib.js';
import { stateDir, stopStatus } from './stop.js';
import { dailyCap, eatDay, reservationsOnDay } from './ledger.js';
import { verbatimDraft } from './fact-post.js';
import { subjectOf, clipFits, altTextFor } from './auto-pairing.js';
import { readHooks, approvedHookFor, defaultHooksPath } from './auto-hooks.js';
import { numberFidelity } from './caption.js';
import { deterministicChecks } from './judge.js';
import { eligibleClips, libraryDir as defaultLibraryDir, readManifest as readManifestReal } from './clip-library.js';
import { readUsage as readUsageReal, appendUsage, defaultUsagePath } from './reel-clip.js';
import { renderOverlay, composeClip } from './overlay.js';
import { historyFromQueue } from './ideas.js';

export const DEFAULT_KINDS = Object.freeze(['rule', 'fact']);
export const DEFAULT_SLOT_HOUR = 18;
export const MAX_IDEAS_PER_RUN = 15;
const DAY = 86400e3;

/** config.autoKinds: absent = rule and fact. Present but not a non-empty array of non-empty strings = refused (a typo must not widen the lane). */
export function autoKindsOf(config) {
  const k = config && config.autoKinds;
  if (k === undefined) return { ok: true, kinds: [...DEFAULT_KINDS] };
  if (Array.isArray(k) && k.length > 0 && k.every((x) => typeof x === 'string' && x.trim() !== '')) return { ok: true, kinds: [...k] };
  return { ok: false, reason: 'bad-config:autoKinds' };
}
/** config.autoSlotHourEAT: a whole number 0..23, else 18. */
export const autoSlotHour = (config) => { const h = config && config.autoSlotHourEAT; return Number.isInteger(h) && h >= 0 && h <= 23 ? h : DEFAULT_SLOT_HOUR; };
/** The queue slot (ISO, +03:00): `hour`:00 EAT of the East Africa day of `now`, or of the next day when that moment has passed. */
export function slotFor(now, hour, tz = CONFIG.timezone) {
  const ymd = eatDay(now, tz); const at = (d) => `${d}T${String(hour).padStart(2, '0')}:00:00+03:00`;
  if (Date.parse(at(ymd)) > now.getTime()) return at(ymd);
  return at(new Date(Date.parse(`${ymd}T00:00:00Z`) + DAY).toISOString().slice(0, 10));
}
/** One line for the owner: the reason names, then a detail, then the refusal reasons of the ideas counted. */
export function describeRefusal(res) {
  const counts = new Map(); for (const x of res.refused || []) counts.set(x.reason, (counts.get(x.reason) || 0) + 1);
  const list = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `${k} x${n}`).join(', ');
  return `${res.reasons.join(', ')}${res.detail ? ` (${res.detail})` : ''}${list ? ` (${list})` : ''}`.replace(/\s+/g, ' ').trim();
}

const inHistory = (idea, history, now, repeatDays) => {
  for (const h of Array.isArray(history) ? history : []) {
    if (!h || !((h.sourceId != null && (h.sourceId === idea.sourceId || h.sourceId === idea.id)) || (h.ideaId != null && h.ideaId === idea.id))) continue;
    const t = h.date ? Date.parse(h.date) : NaN;
    if (Number.isNaN(t) || now.getTime() - t <= repeatDays * DAY) return true; // an unreadable date counts as recent (fail closed), like the pool
  }
  return false;
};
const rankOf = (a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const inside = (dir, f) => { const rel = path.relative(path.resolve(dir), path.resolve(dir, f)); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };

/** The first eligible unused clip (library order) that fits the idea: { clip } | { reason: 'no-subject' | 'no-matching-clip' }. Cheap, no text check. */
export function pairingFor(idea, clips) {
  if (!subjectOf(idea)) return { reason: 'no-subject' };
  const clip = clips.find((c) => clipFits(idea, c)); return clip ? { clip } : { reason: 'no-matching-clip' };
}
/** The hook rule: an approved, current hand-written hook wins; else the title hook, unless config.autoRequireApprovedHook is exactly true. { hook } (undefined = the title) | { reason }. */
export function hookFor(idea, hooks, config) {
  const e = approvedHookFor(idea, hooks); if (e) return { hook: e.hook };
  return config && config.autoRequireApprovedHook === true ? { reason: 'no-approved-hook' } : { hook: undefined };
}

/** One idea through the text checks: verbatim draft, the real final check (voice + rules), the alt text, the deterministic judge checks. { ok, draft } | { ok:false, reason }.
 *  `hook`: an approved hand-written hook instead of the title (its figures must be claim figures, then it meets every check the title hook does); `clip`: the alt text then describes that footage. */
export async function evaluateIdea(idea, { now = new Date(), check = finalCheck, judgeChecks = deterministicChecks, verbatim = verbatimDraft, neverPromotePatterns, sourceNames, hook, clip } = {}) {
  const v = verbatim(idea, { now, sourceNames, hook }); if (!v.ok) return { ok: false, reason: v.reason };
  if (hook !== undefined && numberFidelity([v.draft.hook], v.draft.claims).length) return { ok: false, reason: 'hook-number-not-in-claims' };
  const draft = { ...v.draft, ideaTitle: String(idea.title ?? '') };
  const alt = clip ? altTextFor(clip, draft.hook) : null; if (alt) draft.altText = alt; // from what the reviewer recorded the clip as showing
  const opts = neverPromotePatterns !== undefined ? { neverPromotePatterns } : undefined;
  const fc = await check(draft, opts); if (!fc.ok) return { ok: false, reason: `final-check:${fc.ruleIds.join('+') || 'refused'}` };
  const altc = await check({ id: 'alt', text: draft.altText, claims: draft.claims }, opts); if (!altc.ok) return { ok: false, reason: `alt-text:${altc.ruleIds.join('+') || 'refused'}` };
  const j = await judgeChecks(draft, { check, ...(opts || {}) }); if (j.length) return { ok: false, reason: `judge:${j.map((x) => x.check).join('+')}` };
  return { ok: true, draft };
}

export async function prepareAutoPost({ pool, manifest, usage = [], history = [], config = {}, now = new Date() } = {}, deps = {}) {
  const { say = () => {}, outDir = autoDir(), libraryDir = defaultLibraryDir(), exists = fs.existsSync, overlay = renderOverlay, compose = composeClip, sourceNames, neverPromotePatterns, check = finalCheck, judgeChecks = deterministicChecks, hooksFile = defaultHooksPath() } = deps;
  const kinds = autoKindsOf(config); if (!kinds.ok) return { ok: false, reasons: [kinds.reason], refused: [] };
  const hooks = readHooks(hooksFile); if (!hooks.ok) return { ok: false, reasons: ['bad-hooks-file'], detail: hooks.reason, refused: [] }; // fail closed: never silently fall back to titles
  // the clips: those of the library that passed every check and are not in the usage ledger; there is NO fallback to other footage or a text-only reel
  const clips = eligibleClips(manifest, usage, { dir: libraryDir, exists }).filter((c) => inside(libraryDir, c.file));
  if (!clips.length) return { ok: false, reasons: ['no-eligible-clip'], refused: [] };
  const ideas = (Array.isArray(pool) ? pool : (pool && Array.isArray(pool.ideas) ? pool.ideas : [])).filter((i) => i && kinds.kinds.includes(i.kind)).sort(rankOf);
  const repeatDays = Number.isInteger(config.repeatDays) && config.repeatDays > 0 ? config.repeatDays : 120;
  const refused = []; let chosen = null; let tried = 0;
  const refuse = (idea, reason) => { refused.push({ ideaId: idea.id, reason }); say(`auto: idea ${idea.id} refused: ${reason}`); };
  for (const idea of ideas) {
    if (inHistory(idea, history, now, repeatDays)) { refuse(idea, 'in-history'); continue; }
    const fit = pairingFor(idea, clips); if (!fit.clip) { refuse(idea, fit.reason); continue; } // the cheap test first: only ideas WITH a fitting clip count against the cap
    const hk = hookFor(idea, hooks.hooks, config); if (hk.reason) { refuse(idea, hk.reason); continue; }
    if (tried >= MAX_IDEAS_PER_RUN) break; tried += 1;
    const r = await evaluateIdea(idea, { now, check, judgeChecks, neverPromotePatterns, sourceNames: sourceNames || (pool && pool.sourceNames), hook: hk.hook, clip: fit.clip });
    if (!r.ok) { refuse(idea, r.reason); continue; }
    chosen = { idea, draft: r.draft, clip: fit.clip }; break;
  }
  if (!chosen) return { ok: false, reasons: ['no-eligible-idea'], refused };
  const { idea, draft, clip } = chosen; const outFile = path.join(outDir, `auto-${idea.id}-${clip.id}.mp4`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-auto-ov-'));
  try {
    const ov = await overlay({ hook: draft.hook, out: path.join(work, 'overlay.png') });
    if (!ov.ok) return { ok: false, reasons: ['overlay-refused'], detail: ov.reason, refused };
    let c; try { c = await compose({ clipFile: path.join(libraryDir, clip.file), overlayPng: path.join(work, 'overlay.png'), out: outFile }); } catch (e) { c = { ok: false, problems: [String(e.message).split('\n')[0]] }; }
    if (!c.ok) { fs.rmSync(outFile, { force: true }); return { ok: false, reasons: ['compose-failed'], detail: (c.problems || []).join('; '), refused }; }
    const sha = crypto.createHash('sha256').update(fs.readFileSync(outFile)).digest('hex');
    return { ok: true, idea, clip, refused, checks: { rendered: c.rendered, qa: c.qa }, draft: { ...draft, auto: true, autoTextSha256: autoTextHash(draft), clipId: clip.id, clipSource: JSON.parse(JSON.stringify(clip.source || [])), readyFile: outFile, readyFileSha256: sha } };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

// ── once a day, from the worker ──────────────────────────────────────────────────────────────
export const defaultStatePath = (env = process.env) => path.join(stateDir(env), 'bpa-auto-state.json');
function writeAtomic(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); const tmp = `${p}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(obj)}\n`); fs.renameSync(tmp, p); }
const readState = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const oneLine = (s, n = 300) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);

export async function ensureDailyAuto(deps = {}) {
  const config = deps.config;
  if (!config || config.autoPublish !== true) return { ran: false, why: 'switch-off' }; // nothing below this line runs, reads or asks
  const { now = new Date(), queuePath = QUEUE_PATH, stopOpts, stop = () => stopStatus(stopOpts), igOn = igEnabled, notify = whatsapp, say = log, ledgerPath, statePath = defaultStatePath(), usagePath = defaultUsagePath(),
    loadPool, readManifest = readManifestReal, readUsage = readUsageReal, libraryDir = defaultLibraryDir(), outDir = autoDir(), prepare = prepareAutoPost, prepareDeps = {} } = deps;
  if (stop().stopped) return { ran: false, why: 'stopped' };
  if (dailyCap(config) === 0) return { ran: false, why: 'cap-zero' };
  const led = reservationsOnDay({ now, config, path: ledgerPath }); if (!led.ok) return { ran: false, why: 'ledger-unreadable' };
  if (led.count > 0) return { ran: false, why: 'cap-reserved-today' };
  if (!igOn()) return { ran: false, why: 'instagram-off' };
  const day = eatDay(now, config.timezone || CONFIG.timezone);
  const prev = readState(statePath); if (prev && prev.day === day) return { ran: false, why: 'already-today' };
  if (loadQueue(queuePath).drafts.some((d) => d.auto === true && (d.ig?.status === 'queued' || d.ig?.status === 'publishing'))) return { ran: false, why: 'auto-item-queued' };
  // the day is written BEFORE the work: a crash inside it cannot loop. A state file that cannot be written means nothing is prepared.
  try { writeAtomic(statePath, { day, startedAt: now.toISOString(), result: 'started' }); } catch { return { ran: false, why: 'state-unwritable' }; }
  const finish = (result, extra = {}) => { try { writeAtomic(statePath, { day, startedAt: now.toISOString(), finishedAt: new Date().toISOString(), result, ...extra }); } catch { /* the day is already recorded */ } };
  const fail = async (text) => { say(`auto: no automatic post today: ${oneLine(text)}`); try { await notify(`No automatic post today: ${oneLine(text)}.`); } catch { /* the log line stands */ } finish('refused', { reason: oneLine(text, 200) }); return { ran: true, queued: false, reason: oneLine(text) }; };
  try {
    const getPool = loadPool || (await import('./idea-drafts.js')).loadIdeaPool;
    const pool = await getPool({ queuePath, now }); if (!pool || !pool.ok) return await fail(`no-pool (${oneLine(pool?.reason ?? 'unknown', 120)})`);
    const res = await prepare({ pool, manifest: readManifest(libraryDir), usage: readUsage(usagePath), history: historyFromQueue(loadQueue(queuePath)), config, now }, { ...prepareDeps, libraryDir, outDir, sourceNames: pool.sourceNames, say });
    if (!res.ok) return await fail(describeRefusal(res));
    const at = slotFor(now, autoSlotHour(config), config.timezone || CONFIG.timezone); let id;
    // the same primitives the weekly drafts and the approval path use: the queue lock, loadQueue / nextId / saveQueue; the state is the one the worker publishes from
    await withQueueLock(async () => {
      const q = loadQueue(queuePath); id = nextId(q);
      q.drafts.push({ id, status: STATUS.SCHEDULED, ...res.draft, auto: true, format: 'reel', scheduledFor: at, decidedAt: now.toISOString(), decidedBy: 'auto-lane', ig: { status: 'queued', at } });
      saveQueue(q, queuePath);
    }, { lockPath: queuePath + '.lock' });
    say(`auto: ${id} queued for ${at} (idea ${res.draft.ideaId}, clip ${res.draft.clipId})`); finish('queued', { id, at });
    return { ran: true, queued: true, id, at };
  } catch (e) { return await fail(`error: ${oneLine(e && e.message || e, 160)}`); }
}

/** After a SUCCESSFUL publish only: the item is posted, the clip's source stretch goes into the usage ledger, one line to the owner. Never throws. */
export async function afterAutoPublish(d, r, { now = new Date(), usagePath = defaultUsagePath(), notify = whatsapp, say = log } = {}) {
  d.status = STATUS.POSTED; d.permalink = r?.permalink ?? null; d.postedAt = now.toISOString();
  try { appendUsage(usagePath, (d.clipSource || []).map((s) => ({ id: s.videoId, startSec: s.startSec, endSec: s.endSec })), now); }
  catch (e) { say(`auto: usage ledger not written (${e && (e.code || e.message)}): clip ${d.clipId} may be offered again`); }
  try { await notify(`Automatic post published: ${r?.permalink || r?.id}. Idea: ${oneLine(d.ideaTitle || d.hook || '', 120)}. Reply bpa stop to halt automatic posting.`); } catch { /* the log line stands */ }
}

// ── command line: rehearsal and supply count (read only: nothing is queued, hosted, posted or written to a ledger) ──────────
async function main(argv) {
  const a = { rehearse: false, supply: false, top: 30, count: 1, out: null, historyQueue: null };
  const val = (i) => { if (i + 1 >= argv.length) { console.error(`missing value for ${argv[i]}`); process.exit(2); } return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--rehearse') a.rehearse = true; else if (k === '--supply') a.supply = true;
    else if (k === '--out') { a.out = val(i); i++; } else if (k === '--top') { a.top = Number(val(i)); i++; } else if (k === '--count') { a.count = Number(val(i)); i++; } else if (k === '--history-queue') { a.historyQueue = val(i); i++; }
    else { console.error(`unknown argument ${k}`); process.exit(2); }
  }
  if (a.rehearse === a.supply || !Number.isInteger(a.top) || a.top < 1 || !Number.isInteger(a.count) || a.count < 1 || a.count > 50) { console.error('usage: auto-lane.js --rehearse [--count 1] [--out <dir>] [--history-queue <queue.json>] | --supply [--top 30] [--history-queue <queue.json>]'); process.exit(2); }
  const { loadIdeaPool } = await import('./idea-drafts.js'); const now = new Date(); const queuePath = a.historyQueue || QUEUE_PATH;
  const pool = loadIdeaPool({ queuePath, now }); if (!pool.ok) { console.error(`no pool: ${pool.reason}`); process.exit(3); }
  const hooks = readHooks(); if (!hooks.ok) { console.error(`bad-hooks-file: ${hooks.reason}`); process.exit(3); }
  const history = historyFromQueue(loadQueue(queuePath)); const kinds = autoKindsOf(CONFIG);
  const ranked = pool.ideas.filter((i) => kinds.kinds.includes(i.kind)).sort(rankOf);
  const libDir = defaultLibraryDir(); const manifest = readManifestReal(libDir); const usage = readUsageReal(defaultUsagePath());
  if (a.supply) {
    const top = ranked.slice(0, a.top); const counts = {}; const survivors = [];
    for (const idea of top) {
      const hk = hookFor(idea, hooks.hooks, CONFIG); const bump = (key) => { counts[key] = (counts[key] || 0) + 1; };
      if (hk.reason) { bump(hk.reason); continue; }
      const r = await evaluateIdea(idea, { now, sourceNames: pool.sourceNames, hook: hk.hook }); // without a clip: the alt text is clip-based later and does not change the verdict in practice
      if (r.ok) survivors.push(idea); else bump(r.reason.replace(/^(final-check|judge|alt-text):.*/, '$1:$&').replace(/^([^:]+):\1:/, '$1:'));
    }
    console.log(`top ${top.length} ideas of kinds ${kinds.kinds.join('+')} (of ${ranked.length}): ${survivors.length} survive verbatimDraft + final check + deterministic judge checks`);
    for (const [k, n] of Object.entries(counts).sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(3)}  ${k}`);
    const clips = eligibleClips(manifest, usage, { dir: libDir }).filter((c) => inside(libDir, c.file));
    const per = new Map(clips.map((c) => [c.id, 0])); const bySubject = {}; let fitting = 0;
    for (const idea of survivors) {
      const key = subjectOf(idea)?.key ?? '(no animal named)'; bySubject[key] = (bySubject[key] || 0) + 1;
      const fits = clips.filter((c) => clipFits(idea, c)); if (fits.length) fitting += 1; for (const c of fits) per.set(c.id, per.get(c.id) + 1);
    }
    console.log(`${fitting} of ${survivors.length} surviving ideas have a fitting unused clip (${clips.length} eligible unused clips)`);
    for (const c of clips) console.log(`  clip ${c.id}  tags: ${c.shows && Array.isArray(c.shows.tags) && c.shows.tags.length ? c.shows.tags.join(', ') : 'none recorded'}  fits ${per.get(c.id)} surviving ideas`);
    console.log(`surviving ideas by the animal they are about: ${Object.entries(bySubject).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} x${n}`).join(', ') || 'none'}`);
    return;
  }
  const out = path.resolve(a.out || path.join(os.tmpdir(), 'bpa-auto-rehearsal'));
  // prepareAutoPost writes no queue, state, ledger or log: its only output is the video in `out` (plus a caption file here); the real files are only read.
  // Several posts: each next run sees the earlier clips as used and the earlier ideas as history, in memory only.
  fs.mkdirSync(out, { recursive: true }); let used = [...usage]; let hist = [...history]; let made = 0;
  for (let n = 1; n <= a.count; n++) {
    const r = await prepareAutoPost({ pool, manifest, usage: used, history: hist, config: CONFIG, now }, { outDir: out, libraryDir: libDir });
    if (!r.ok) { console.log(`NOT PREPARED (post ${n} of ${a.count}): ${describeRefusal(r)}`); break; }
    made += 1; used = [...used, { clipId: r.clip.id }]; hist = [...hist, { ideaId: r.idea.id, sourceId: r.idea.sourceId ?? null }];
    const txt = path.join(out, `auto-${r.idea.id}-${r.clip.id}.txt`); fs.writeFileSync(txt, `${r.draft.text}\n`);
    console.log(`--- post ${n} of ${a.count}`);
    console.log(`idea chosen: ${r.idea.id} [${r.idea.kind}] topic ${r.idea.topic ?? 'none'}: ${r.idea.title}`);
    console.log(`clip: ${r.clip.id}  tags: ${r.clip.shows.tags.join(', ')}`);
    console.log(`hook: ${r.draft.hook}`);
    console.log(`rendered check: ${r.checks.rendered.ok ? 'ok' : `FAILED ${r.checks.rendered.problems.join('; ')}`} (${r.checks.rendered.durationSec} s)`);
    console.log(`qa check: ${r.checks.qa.ok ? 'ok' : `FAILED ${r.checks.qa.problems.join('; ')}`}`);
    console.log(`video: ${r.draft.readyFile}`); console.log(`caption file: ${txt}`); console.log(`alt text: ${r.draft.altText}`);
    console.log(`refusals on the way: ${describeRefusal({ reasons: [], refused: r.refused }) || 'none'}`);
    console.log(`caption text:\n${r.draft.text}`);
  }
  if (made < a.count) process.exitCode = made === 0 ? 1 : 0;
  console.log(`prepared ${made} of ${a.count}; folder: ${out}`);
}
const isMain = process.argv[1] && (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) await main(process.argv.slice(2));
