// Items for the review page: what waits for a look, in one shape. Pure with injected inputs (no log, no network, no model).
//   Item = { kind: 'hook'|'clip', id, version, title, preview: { mediaId, note }, facts, state, actions: [] }
// `version` is what a later approval will bind to (step 2): a clip's is the file's SHA-256 plus its reviewer tags, so a file replaced under the same id is a different version.
// Media ids are derived from a per-process secret, the item id and the version, so an id never outlives the thing it showed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hookState } from './auto-hooks.js';

export const NOTE_PENDING = 'video is being prepared';
const NOTE_MISSING = 'video missing';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashFileSync(file) {
  const h = crypto.createHash('sha256'); const buf = Buffer.allocUnsafe(1 << 20); const fd = fs.openSync(file, 'r');
  try { for (;;) { const n = fs.readSync(fd, buf, 0, buf.length, null); if (n === 0) break; h.update(buf.subarray(0, n)); } } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/** (absPath) => { sha256, mtimeMs } | null. The hash is cached by path, size, mtime and inode: bytes are read again only when one of them changes. */
export function fileInfoOf({ stat = fs.statSync, readFile = hashFileSync } = {}) {
  const cache = new Map();
  return (abs) => {
    let st; try { st = stat(abs); } catch { return null; }
    if (!st || (typeof st.isFile === 'function' && !st.isFile())) return null;
    const key = `${abs}|${st.size}|${st.mtimeMs}|${st.ino}`;
    let sha256 = cache.get(key);
    if (sha256 === undefined) { try { sha256 = readFile(abs); } catch { return null; } if (typeof sha256 !== 'string') return null; cache.set(key, sha256); }
    return { sha256, mtimeMs: st.mtimeMs };
  };
}

export const clipVersion = (fileSha256, tags) => sha(JSON.stringify([fileSha256, [...tags].sort()]));
export const mediaIdFor = (secret, itemId, version) => `m_${crypto.createHmac('sha256', secret).update(`${itemId}|${version}`).digest('hex').slice(0, 32)}`;

const inside = (dir, f) => { const rel = path.relative(path.resolve(dir), path.resolve(dir, f)); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
const isSuperseded = (c) => Array.isArray(c.supersededBy) && c.supersededBy.length > 0;

function clipState(c) {
  if (!(c.checks && c.checks.rendered === 'ok')) return 'not eligible: render check failed';
  if (!c.flash || typeof c.flash.flash !== 'boolean') return 'not eligible: flash not checked';
  if (c.flash.flash === true) return 'not eligible: flash detected';
  if (!c.verified || typeof c.verified !== 'object') return 'not eligible: no verdict';
  if (c.verified.verdict !== 'pass') return c.verified.verdict === 'fail' ? 'not eligible: verdict fail' : 'not eligible: no verdict';
  if (c.verified.singleSubject !== 'yes') return 'not eligible: single-subject not yes';
  return 'eligible';
}

export function buildClipItems({ manifest, libraryDir, info, secret, exists = fs.existsSync }) {
  const clips = manifest && Array.isArray(manifest.clips) ? manifest.clips : [];
  const rows = [];
  clips.forEach((c, index) => {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || c.id === '' || isSuperseded(c)) return;
    const tags = Array.isArray(c.shows && c.shows.tags) ? c.shows.tags.filter((t) => typeof t === 'string') : [];
    let abs = null; let fi = null;
    if (typeof c.file === 'string' && c.file !== '' && inside(libraryDir, c.file)) { const p = path.resolve(libraryDir, c.file); if (exists(p)) { fi = info(p); if (fi) abs = p; } }
    const version = clipVersion(fi ? fi.sha256 : 'file-missing', tags);
    const mediaId = abs ? mediaIdFor(secret, c.id, version) : null;
    const v = c.verified && typeof c.verified === 'object' ? c.verified : null;
    const item = {
      kind: 'clip', id: c.id, version, title: c.id,
      preview: abs ? { mediaId, note: null } : { mediaId: null, note: NOTE_MISSING },
      facts: { durationSec: typeof c.durationSec === 'number' ? c.durationSec : null, verdict: v && (v.verdict === 'pass' || v.verdict === 'fail') ? v.verdict : null, singleSubject: v && (v.singleSubject === 'yes' || v.singleSubject === 'no') ? v.singleSubject : null,
        notes: v && typeof v.notes === 'string' ? v.notes : null, tags, flash: c.flash && typeof c.flash.flash === 'boolean' ? c.flash.flash : null,
        source: Array.isArray(c.source) ? c.source.map((s) => ({ videoId: s.videoId, startSec: s.startSec, endSec: s.endSec })) : [] },
      state: abs ? clipState(c) : NOTE_MISSING, actions: [],
    };
    rows.push({ item, abs, mtime: fi ? fi.mtimeMs : -Infinity, index, mediaId });
  });
  rows.sort((a, b) => (b.mtime === a.mtime ? b.index - a.index : (b.mtime > a.mtime ? 1 : -1)));
  const media = new Map();
  for (const r of rows) if (r.abs) media.set(r.mediaId, { path: r.abs, kind: 'clip' });
  return { items: rows.map((r) => r.item), media };
}

/** The media route uses this alone: it is computed fresh per request, so an id for something that left the list or changed is simply absent. */
export function listMedia(args) { return buildClipItems(args).media; }

// ── hooks ────────────────────────────────────────────────────────────────────────
const NOTE_EXAMPLE = 'example clip; the lane may use another fitting clip';
/** What a hook approval will bind to: the hook text plus the idea's title and claim texts. */
export const hookVersion = (hook, idea) => sha(JSON.stringify([hook, idea.title, (Array.isArray(idea.claims) ? idea.claims : []).map((c) => c.text)]));

/** Never throws. A source that cannot be read adds a problem and the other kind is still built. */
export async function buildItems({ readHooks, loadPool, readManifest, libraryDir, info, secret, evaluate, previewFor = () => null, now = new Date(), exists = fs.existsSync }) {
  const problems = []; const media = new Map(); const hookItems = [];
  let hooks = null; try { const h = readHooks(); if (h && h.ok && Array.isArray(h.hooks)) hooks = h.hooks; } catch { /* a problem below */ }
  if (!hooks) problems.push('hooks-unreadable');
  let pool = null; try { const p = loadPool(); if (p && p.ok && Array.isArray(p.ideas)) pool = p; } catch { /* a problem below */ }
  if (!pool) problems.push('ideas-unavailable');
  if (hooks && pool) {
    const ideas = new Map(pool.ideas.map((i) => [i.id, i]));
    for (const e of [...hooks].reverse()) {
      const idea = ideas.get(e.ideaId); const hs = hookState(e, idea);
      const version = hookVersion(e.hook, idea || { title: null, claims: [] });
      let state = hs; let facts = { hook: e.hook };
      if (hs !== 'stale') {
        let r; try { r = await evaluate(idea, { hook: e.hook, sourceNames: pool.sourceNames || {}, now }); } catch { r = { ok: false, reason: 'check-failed' }; }
        const draft = r && r.ok && r.draft ? r.draft : null;
        if (!draft) state = `refused: ${r && r.reason ? r.reason : 'check-failed'}`;
        facts = { hook: e.hook, caption: draft ? (draft.caption ?? draft.text ?? null) : null, claims: (Array.isArray(idea.claims) ? idea.claims : []).map((c) => ({ text: c.text, sourceDate: c.sourceDate ?? null })), link: idea.link ?? null, exampleClip: null };
      }
      let preview = { mediaId: null, note: NOTE_PENDING };
      let prev = null; try { prev = previewFor(e.ideaId, version); } catch { prev = null; }
      if (typeof prev === 'string' && prev !== '') { const mediaId = mediaIdFor(secret, e.ideaId, version); preview = { mediaId, note: NOTE_EXAMPLE }; media.set(mediaId, { path: prev, kind: 'preview' }); }
      hookItems.push({ kind: 'hook', id: e.ideaId, version, title: e.hook, preview, facts, state, actions: [] });
    }
  }
  let clipItems = [];
  let manifest; let manifestOk = true; try { manifest = readManifest(); } catch { manifestOk = false; problems.push('library-unreadable'); }
  if (manifestOk && manifest == null) problems.push('library-missing');
  else if (manifestOk) { try { const c = buildClipItems({ manifest, libraryDir, info, secret, exists }); clipItems = c.items; for (const [k, v] of c.media) media.set(k, v); } catch { problems.push('library-unreadable'); } }
  const items = [...hookItems, ...clipItems];
  return { ok: true, items, counts: { all: items.length, hook: hookItems.length, clip: clipItems.length }, problems, media };
}
