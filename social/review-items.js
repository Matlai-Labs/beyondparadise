// Items for the review page: what waits for a look, in one shape. Pure with injected inputs (no log, no network, no model).
//   Item = { kind: 'hook'|'clip', id, version, title, preview: { mediaId, note }, facts, state, actions: [] }
// `version` is what a later approval will bind to (step 2): a clip's is the file's SHA-256 plus its reviewer tags, so a file replaced under the same id is a different version.
// Media ids are derived from a per-process secret, the item id and the version, so an id never outlives the thing it showed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hookState, approvedHookFor, shownEntry } from './auto-hooks.js';
import { eligibleClips } from './clip-library.js';
import { clipVersion, tagsOf, hashFile as hashFileStream, emptyApprovals, decisionOf, laneAllows, linkedOrNotFile } from './clip-approvals.js';
export { clipVersion };

export const NOTE_PENDING = 'video is being prepared';
const NOTE_MISSING = 'video missing';
export const NOTE_NO_EXAMPLE = 'no example video yet'; // a video text has no example video in this step (they come later); nothing is being prepared
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** File identity and hash cache. peek(abs) is a cheap lstat that never hashes: { size, mtimeMs, ino, key, sha256 | null (not hashed yet) }, or null for a missing file, a folder or a SYMBOLIC LINK.
 *  hash(abs, pk) hashes by stream (never a whole-file read) and caches under path, size, mtime and inode; two callers for one file share one run. prune(keep) drops entries of paths that left the manifest. */
export function fileInfoOf({ lstat = fs.lstatSync, hashFile = hashFileStream } = {}) {
  const shaByKey = new Map(); const keyByPath = new Map(); const inflight = new Map();
  const peek = (abs) => {
    let st; try { st = lstat(abs); } catch { return null; }
    if (!st || (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) || (typeof st.isFile === 'function' && !st.isFile())) return null;
    const key = `${abs}|${st.size}|${st.mtimeMs}|${st.ino}`;
    return { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, key, sha256: shaByKey.get(key) ?? null };
  };
  const hash = (abs, pk) => {
    const known = shaByKey.get(pk.key); if (known !== undefined) return Promise.resolve(known);
    if (inflight.has(pk.key)) return inflight.get(pk.key);
    const run = (async () => {
      try {
        const sha = await hashFile(abs); if (typeof sha !== 'string') throw new Error('bad hash');
        const old = keyByPath.get(abs); if (old && old !== pk.key) shaByKey.delete(old);
        shaByKey.set(pk.key, sha); keyByPath.set(abs, pk.key); return sha;
      } finally { inflight.delete(pk.key); }
    })();
    inflight.set(pk.key, run); return run;
  };
  const prune = (keep) => { for (const [abs, key] of [...keyByPath]) if (!keep.has(abs)) { shaByKey.delete(key); keyByPath.delete(abs); } };
  return { peek, hash, prune, size: () => shaByKey.size };
}

export const mediaIdFor = (secret, itemId, version) => `m_${crypto.createHmac('sha256', secret).update(`${itemId}|${version}`).digest('hex').slice(0, 32)}`;

const inside = (dir, f) => { const rel = path.relative(path.resolve(dir), path.resolve(dir, f)); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
const isSuperseded = (c) => Array.isArray(c.supersededBy) && c.supersededBy.length > 0;

/** Why a clip is NOT eligible (the lane decides eligibility; this only explains). { text, reason } */
function clipWhy(c) {
  if (!(c.checks && c.checks.rendered === 'ok')) return { text: 'render check failed', reason: 'render-check-failed' };
  if (!c.flash || typeof c.flash.flash !== 'boolean') return { text: 'flash not checked', reason: 'flash-not-checked' };
  if (c.flash.flash === true) return { text: 'flash detected', reason: 'flash-detected' };
  if (!c.verified || typeof c.verified !== 'object') return { text: 'no verdict', reason: 'no-verdict' };
  if (c.verified.verdict !== 'pass') return c.verified.verdict === 'fail' ? { text: 'verdict fail', reason: 'verdict-fail' } : { text: 'no verdict', reason: 'no-verdict' };
  if (c.verified.singleSubject !== 'yes') return { text: 'single-subject not yes', reason: 'single-subject-not-yes' };
  return { text: 'not usable', reason: 'not-usable' };
}
export const DECISION_WINDOW_MS = 30 * 86400e3;
export const CLIP_REASONS = Object.freeze(['skipped', 'not-approved', 'video-missing', 'already-used', 'usage-unreadable', 'render-check-failed', 'flash-not-checked', 'flash-detected', 'no-verdict', 'verdict-fail', 'single-subject-not-yes', 'not-usable']);
export const HOOK_REASONS = Object.freeze(['not-approved', 'stale', 'check-failed']);

/** `usage`: the ledger the lane reads (array), or null when it cannot be read (then nothing is eligible). "Eligible" is membership in the lane's own eligibleClips, never a second opinion. */
export function laneClipsOf(manifest, usage, libraryDir, exists = fs.existsSync, decisions = null) {
  const own = eligibleClips(manifest, usage, { dir: libraryDir, exists }).filter((c) => inside(libraryDir, c.file) && !linkedOrNotFile(path.resolve(libraryDir, c.file))); // a symbolic link is never usable (CR4)
  return decisions ? own.filter((c) => laneAllows(decisions.data, c.id, decisions.versionOf(c))) : own;
}
/** The clip version from the cache only (never hashes): null when the file is missing, a link, not hashed yet, or outside the library. */
export function clipVersionFromInfo(info, libraryDir, clip) {
  if (!clip || typeof clip.file !== 'string' || clip.file === '' || !inside(libraryDir, clip.file)) return null;
  const pk = info.peek(path.resolve(libraryDir, clip.file));
  return pk && pk.sha256 ? clipVersion(pk.sha256, tagsOf(clip)) : null;
}
const inWindow = (at, now, windowMs) => { const t = Date.parse(at); return Number.isNaN(t) || now.getTime() - t <= windowMs; };
/** The state and reason of one clip, from sets built once. Pure. */
function reasonFor(c, { hasFile, usageUnreadable, laneIds, freeIds }) {
  if (!hasFile) return { state: NOTE_MISSING, reason: 'video-missing' };
  if (usageUnreadable) return { state: 'not eligible: usage unreadable', reason: 'usage-unreadable' };
  if (laneIds.has(c.id)) return { state: 'eligible', reason: null };
  if (freeIds.has(c.id)) return { state: 'already used in a post', reason: 'already-used' };
  const w = clipWhy(c); return { state: `not eligible: ${w.text}`, reason: w.reason };
}
/** The state and reason of ONE clip (builds the sets itself). A missing file, a folder and a symbolic link are "video missing". `usage` null = ledger unreadable. */
export function clipReasonOf(manifest, usage, libraryDir, clip, { exists = fs.existsSync, info = null } = {}) {
  let hasFile = false;
  if (clip && typeof clip.file === 'string' && clip.file !== '' && inside(libraryDir, clip.file)) { const p = path.resolve(libraryDir, clip.file); hasFile = Boolean(exists(p) && (!info || info.peek(p))); }
  const laneIds = usage === null ? new Set() : new Set(laneClipsOf(manifest, usage, libraryDir, exists).map((c) => c.id));
  const freeIds = new Set(laneClipsOf(manifest, [], libraryDir, exists).map((c) => c.id));
  return reasonFor(clip, { hasFile, usageUnreadable: usage === null, laneIds, freeIds });
}
export const HASH_BUDGET = 4; // new files hashed per items build; the rest show "being prepared" and are done by the next request
export async function buildClipItems({ manifest, libraryDir, info, secret, exists = fs.existsSync, usage = [], hashBudget = HASH_BUDGET, approvals = { ok: true, data: emptyApprovals() }, now = new Date(), decisionWindowMs = DECISION_WINDOW_MS }) {
  const apOk = Boolean(approvals && approvals.ok && approvals.data);
  const clips = manifest && Array.isArray(manifest.clips) ? manifest.clips : [];
  const laneIds = usage === null ? new Set() : new Set(laneClipsOf(manifest, usage, libraryDir, exists).map((c) => c.id));
  const freeIds = new Set(laneClipsOf(manifest, [], libraryDir, exists).map((c) => c.id)); // eligible if the ledger were empty
  const rows = []; const keep = new Set();
  clips.forEach((c, index) => {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || c.id === '' || isSuperseded(c)) return;
    let abs = null; let pk = null;
    if (typeof c.file === 'string' && c.file !== '' && inside(libraryDir, c.file)) { const p = path.resolve(libraryDir, c.file); keep.add(p); if (exists(p)) { pk = info.peek(p); if (pk) abs = p; } }
    rows.push({ c, index, abs, pk });
  });
  // hash at most hashBudget files that are not cached yet, newest first (those are the ones the owner meets first)
  const todo = rows.filter((r) => r.pk && r.pk.sha256 === null).sort((a, b) => b.pk.mtimeMs - a.pk.mtimeMs).slice(0, Math.max(0, hashBudget));
  await Promise.all(todo.map(async (r) => { try { await info.hash(r.abs, r.pk); r.pk = info.peek(r.abs); } catch { r.abs = null; r.pk = null; } }));
  info.prune(keep);
  const media = new Map(); const built = [];
  for (const r of rows) {
    const { c, abs, pk } = r;
    const tags = tagsOf(c);
    const hashed = Boolean(abs && pk && pk.sha256);
    const version = hashed ? clipVersion(pk.sha256, tags) : (abs && pk ? sha(JSON.stringify(['pending', pk.size, pk.mtimeMs, tags])) : clipVersion('file-missing', tags));
    const mediaId = hashed ? mediaIdFor(secret, c.id, version) : null;
    const v = c.verified && typeof c.verified === 'object' ? c.verified : null;
    const base = reasonFor(c, { hasFile: Boolean(abs), usageUnreadable: usage === null, laneIds, freeIds });
    let { state, reason } = base; let usableToday = state === 'eligible'; let decision = null; let actions = [];
    const dec = apOk && hashed ? decisionOf(approvals.data, c.id, version) : 'undecided';
    if (dec !== 'undecided') { decision = { kind: dec, at: approvals.data.clips[c.id].at }; if (!inWindow(decision.at, now, decisionWindowMs)) continue; } // D12: out of the window = off the page
    if (!apOk) { usableToday = false; }
    else if (base.reason === null) {
      if (dec === 'skipped') { state = 'skipped by you'; reason = 'skipped'; usableToday = false; }
      else if (!laneAllows(approvals.data, c.id, hashed ? version : null)) { reason = 'not-approved'; usableToday = false; } // enforced and not approved yet
    }
    if (apOk && hashed) {
      if (dec !== 'undecided') actions = base.reason === 'already-used' ? [] : ['undo'];
      else actions = base.reason === null ? ['approve', 'skip'] : (base.reason === 'video-missing' || base.reason === 'already-used' || base.reason === 'usage-unreadable' ? [] : ['skip']);
    }
    const item = {
      kind: 'clip', id: c.id, version, title: c.id,
      preview: hashed ? { mediaId, note: null } : (abs ? { mediaId: null, note: NOTE_PENDING } : { mediaId: null, note: NOTE_MISSING }),
      facts: { durationSec: typeof c.durationSec === 'number' ? c.durationSec : null, verdict: v && (v.verdict === 'pass' || v.verdict === 'fail') ? v.verdict : null, singleSubject: v && (v.singleSubject === 'yes' || v.singleSubject === 'no') ? v.singleSubject : null,
        notes: v && typeof v.notes === 'string' ? v.notes : null, tags, flash: c.flash && typeof c.flash.flash === 'boolean' ? c.flash.flash : null,
        source: Array.isArray(c.source) ? c.source.map((s) => ({ videoId: s.videoId, startSec: s.startSec, endSec: s.endSec })) : [] },
      state, reason, usableToday, decision, actions,
    };
    built.push({ item, mtime: abs && pk ? pk.mtimeMs : -Infinity, index: r.index });
    // the identity a media request is checked against: a file that changed size, mtime or inode since this build is not served under this id
    if (hashed) media.set(mediaId, { path: abs, kind: 'clip', size: pk.size, mtimeMs: pk.mtimeMs, ino: pk.ino });
  }
  built.sort((a, b) => (b.mtime === a.mtime ? b.index - a.index : (b.mtime > a.mtime ? 1 : -1)));
  return { items: built.map((r) => r.item), media };
}

// the same match the lane uses for "already posted or queued" (bpa-actions.js has its own copy; this file cannot import it)
const inHistoryAny = (idea, history) => (Array.isArray(history) ? history : []).some((h) => h && ((h.sourceId != null && (h.sourceId === idea.sourceId || h.sourceId === idea.id)) || (h.ideaId != null && h.ideaId === idea.id)));
// ── hooks ────────────────────────────────────────────────────────────────────────
const NOTE_EXAMPLE = 'Example footage. The real post may use other footage that fits.';
/** What a hook approval will bind to: the hook text plus the idea's title and claim texts. */
export const hookVersion = (hook, idea) => sha(JSON.stringify([hook, idea.title, (Array.isArray(idea.claims) ? idea.claims : []).map((c) => c.text)]));

/** Never throws. A source that cannot be read adds a problem and the other kind is still built.
 *  Hook items also carry `usableToday` + `reason`: for an approved hook, whether the lane would take its idea today (laneVerdict = laneVerdictFor from auto-lane.js, injected). */
export async function buildItems({ readHooks, loadPool, readManifest, libraryDir, info, secret, evaluate, previewFor = () => null, now = new Date(), exists = fs.existsSync, readUsage = () => [], readHistory = () => [], readConfig = () => ({}), laneVerdict = () => ({ ok: true }), sourceFor = () => null, readApprovals = () => ({ ok: true, data: emptyApprovals() }), decisionWindowMs = DECISION_WINDOW_MS }) {
  const problems = []; const media = new Map(); const hookItems = [];
  let hooks = null; try { const h = readHooks(); if (h && h.ok && Array.isArray(h.hooks)) hooks = h.hooks; } catch { /* a problem below */ }
  if (!hooks) problems.push('hooks-unreadable');
  let pool = null; try { const p = loadPool(); if (p && p.ok && Array.isArray(p.ideas)) pool = p; } catch { /* a problem below */ }
  if (!pool) problems.push('ideas-unavailable');
  let manifest; let manifestOk = true; try { manifest = readManifest(); } catch { manifestOk = false; problems.push('library-unreadable'); }
  if (manifestOk && manifest == null) { problems.push('library-missing'); manifest = null; }
  let usage; try { usage = readUsage(); if (!Array.isArray(usage)) usage = null; } catch { usage = null; }
  if (usage === null) problems.push('usage-unreadable');
  let history = []; try { history = readHistory(); if (!Array.isArray(history)) history = []; } catch { problems.push('history-unreadable'); history = null; }
  let config = {}; try { config = readConfig() || {}; } catch { config = null; }
  let approvals; try { approvals = readApprovals(); } catch { approvals = null; }
  if (!approvals || !approvals.ok || !approvals.data) { approvals = { ok: false }; problems.push('approvals-unreadable'); }
  // clips first: the hook gate needs the file hashes this build fills in
  let clipItems = [];
  if (manifestOk && manifest) { try { const c = await buildClipItems({ manifest, libraryDir, info, secret, exists, usage, approvals, now, decisionWindowMs }); clipItems = c.items; for (const [k, v] of c.media) media.set(k, v); } catch { problems.push('library-unreadable'); } }
  // the lane's own clip set, decisions included; an unreadable approvals file fails closed like the lane's bad-approvals-file
  const laneClips = manifest && usage !== null && approvals.ok ? laneClipsOf(manifest, usage, libraryDir, exists, { data: approvals.data, versionOf: (c) => clipVersionFromInfo(info, libraryDir, c) }) : [];
  const gate = async (idea) => {
    if (usage === null) return { ok: false, reason: 'usage-unreadable' };
    if (history === null || config === null) return { ok: false, reason: 'check-failed' };
    try { return await laneVerdict(idea, { clips: laneClips, history, config, now }); } catch { return { ok: false, reason: 'check-failed' }; }
  };
  if (hooks && pool) {
    const ideas = new Map(pool.ideas.map((i) => [i.id, i]));
    // one item per idea: shownEntry (the entry the lane would take, else the newest entry); the others are only counted
    const chosen = []; const seen = new Set();
    for (const e of [...hooks].reverse()) {
      if (seen.has(e.ideaId)) continue; seen.add(e.ideaId);
      const idea = ideas.get(e.ideaId); const group = hooks.filter((x) => x.ideaId === e.ideaId);
      chosen.push(idea ? shownEntry(hooks, idea) : { entry: group[group.length - 1], others: group.length - 1 });
    }
    hookItems.push(...(await Promise.all(chosen.map(async ({ entry: e, others }) => {
      const idea = ideas.get(e.ideaId); const hs = hookState(e, idea);
      const version = hookVersion(e.hook, idea || { title: null, claims: [] });
      let state = hs; let facts = { hook: e.hook }; let usableToday = false; let reason = hs === 'stale' ? 'stale' : (hs === 'unapproved' ? 'not-approved' : null);
      if (hs !== 'stale') {
        let r; try { r = await evaluate(idea, { hook: e.hook, sourceNames: pool.sourceNames || {}, now }); } catch { r = { ok: false, reason: 'check-failed' }; }
        const draft = r && r.ok && r.draft ? r.draft : null;
        if (!draft) { if (hs !== 'skipped') { reason = r && r.reason ? r.reason : 'check-failed'; state = `refused: ${reason}`; } } // a skipped hook keeps its skipped state on the card
        else if (hs === 'approved') { const g = await gate(idea); usableToday = g.ok === true; reason = g.ok ? null : (g.reason || 'check-failed'); }
        const claims = []; for (const c of Array.isArray(idea.claims) ? idea.claims : []) { let src = null; try { src = await sourceFor(c, pool.sourceNames || {}); } catch { src = null; } claims.push({ text: c.text, sourceDate: c.sourceDate ?? null, ...(typeof src === 'string' && src ? { source: src } : {}) }); }
        facts = { hook: e.hook, caption: draft ? (draft.caption ?? draft.text ?? null) : null, claims, link: idea.link ?? null, exampleClip: null };
      }
      if (others > 0) facts = { ...facts, otherEntries: others };
      let preview = { mediaId: null, note: NOTE_NO_EXAMPLE };
      let previewMedia = null; let prev = null; try { prev = previewFor(e.ideaId, version); } catch { prev = null; }
      if (typeof prev === 'string' && prev !== '') { const mediaId = mediaIdFor(secret, e.ideaId, version); preview = { mediaId, note: NOTE_EXAMPLE }; previewMedia = [mediaId, { path: prev, kind: 'preview' }]; }
      let decision = null; if (hs === 'approved') decision = { kind: 'approved', at: e.approvedAt }; else if (hs === 'skipped') decision = { kind: 'skipped', at: e.skipped.at };
      let actions;
      if (hs === 'unapproved') actions = state.startsWith('refused') ? ['skip', 'edit'] : ['approve', 'skip', 'edit'];
      else if (hs === 'stale') actions = idea ? ['edit'] : []; // Skip on a stale entry always answers stale (CR1)
      else actions = history !== null && !inHistoryAny(idea, history) ? ['undo'] : []; // approved or skipped; a used or unverifiable one cannot be undone
      return { item: { kind: 'hook', id: e.ideaId, version, title: e.hook, preview, facts, state, reason, usableToday, decision, actions }, decision, previewMedia };
    }))).filter((r) => !r.decision || inWindow(r.decision.at, now, decisionWindowMs)).map((r) => { if (r.previewMedia) media.set(r.previewMedia[0], r.previewMedia[1]); return r.item; }));
  }
  const items = [...clipItems, ...hookItems]; // clips first: they have videos
  return { ok: true, items, counts: { all: items.length, hook: hookItems.length, clip: clipItems.length }, problems, media };
}
