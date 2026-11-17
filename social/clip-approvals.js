// Clip decisions: one private state file (mode 600), never the library manifest (the manifest is rewritten whole by the library code).
//   data.clips is a null-prototype map: clipId -> { state: 'approved'|'skipped', version, at, by }. Every lookup uses Object.hasOwn.
//   `enforcedAt` is a one-way switch: once every clip the lane could take had a decision, the lane takes approved clips only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { stateDir } from './stop.js';

export const defaultClipApprovalsPath = (env = process.env) => path.join(stateDir(env), 'bpa-clip-approvals.json');
export const emptyApprovals = () => ({ version: 1, enforcedAt: null, clips: Object.create(null) });
const BY = 'review page';
const HEX64 = /^[0-9a-f]{64}$/;
const isDate = (s) => typeof s === 'string' && s !== '' && !Number.isNaN(Date.parse(s));
const copyClips = (clips) => { const m = Object.create(null); for (const k of Object.keys(clips)) m[k] = { ...clips[k] }; return m; };
const has = (clips, id) => Object.hasOwn(clips, id);

export function readClipApprovals(file = defaultClipApprovalsPath()) {
  let st; try { st = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return { ok: true, data: emptyApprovals() }; return { ok: false, reason: 'cannot-read' }; }
  if (!st.isFile()) return { ok: false, reason: 'not-a-regular-file' };
  if ((st.mode & 0o077) !== 0) return { ok: false, reason: 'mode-not-private' };
  let j; try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { ok: false, reason: 'not-json' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j) || j.version !== 1) return { ok: false, reason: 'wrong-shape' };
  if (j.enforcedAt !== null && !isDate(j.enforcedAt)) return { ok: false, reason: 'wrong-shape' };
  if (!j.clips || typeof j.clips !== 'object' || Array.isArray(j.clips)) return { ok: false, reason: 'wrong-shape' };
  const clips = Object.create(null);
  for (const id of Object.keys(j.clips)) {
    const e = j.clips[id];
    if (!e || typeof e !== 'object' || (e.state !== 'approved' && e.state !== 'skipped') || typeof e.version !== 'string' || !HEX64.test(e.version) || !isDate(e.at)) return { ok: false, reason: 'bad-entry' };
    clips[id] = { state: e.state, version: e.version, at: e.at, by: typeof e.by === 'string' ? e.by : BY };
  }
  return { ok: true, data: { version: 1, enforcedAt: j.enforcedAt, clips } };
}

let tmpCounter = 0;
export function writeClipApprovals(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`;
  const plain = { version: 1, enforcedAt: data.enforcedAt, clips: Object.fromEntries(Object.keys(data.clips).map((k) => [k, data.clips[k]])) };
  // Object.fromEntries defines "__proto__" as an own property, so JSON.stringify keeps it
  try { fs.writeFileSync(tmp, `${JSON.stringify(plain, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(tmp, file); }
  catch (e) { try { fs.unlinkSync(tmp); } catch { /* nothing to remove */ } throw e; }
}

export const clipVersion = (fileSha256, tags) => crypto.createHash('sha256').update(JSON.stringify([fileSha256, [...tags].sort()])).digest('hex');
export function tagsOf(clip) { const t = clip && clip.shows && clip.shows.tags; return Array.isArray(t) ? t.filter((x) => typeof x === 'string') : []; }
export function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256'); const st = fs.createReadStream(file);
    st.on('data', (c) => h.update(c)); st.on('error', reject); st.on('end', () => resolve(h.digest('hex')));
  });
}

export function decisionOf(data, clipId, version) {
  if (!has(data.clips, clipId)) return 'undecided';
  const e = data.clips[clipId]; return e.version === version ? e.state : 'undecided';
}
export function setDecision(data, clipId, state, { version, at }) {
  const clips = copyClips(data.clips); clips[clipId] = { state, version, at, by: BY };
  return { version: 1, enforcedAt: data.enforcedAt, clips };
}
export function clearDecision(data, clipId) {
  const clips = copyClips(data.clips); delete clips[clipId];
  return { version: 1, enforcedAt: data.enforcedAt, clips };
}
export function maybeEnforce(data, currentClips, at) {
  const same = { version: 1, enforcedAt: data.enforcedAt, clips: copyClips(data.clips) };
  if (data.enforcedAt || !Array.isArray(currentClips) || currentClips.length === 0) return same;
  if (currentClips.every((c) => decisionOf(data, c.id, c.version) !== 'undecided')) same.enforcedAt = at;
  return same;
}
export function laneAllows(data, clipId, version) {
  if (version === null) return !data.enforcedAt && !has(data.clips, clipId);
  const d = decisionOf(data, clipId, version);
  if (d === 'skipped') return false;
  return data.enforcedAt ? d === 'approved' : true;
}
export async function clipsForLane(eligible, data, { dir, hash = hashFile }) {
  const out = [];
  for (const c of eligible) {
    if (!data.enforcedAt && !has(data.clips, c.id)) { if (laneAllows(data, c.id, null)) out.push(c); continue; }
    let version; try { version = clipVersion(await hash(path.resolve(dir, c.file)), tagsOf(c)); } catch { continue; } // fail closed
    if (laneAllows(data, c.id, version)) out.push(c);
  }
  return out;
}
export function stockRightsProblem(clip) {
  if (!clip || clip.stock === undefined || clip.stock === null) return null;
  const s = clip.stock; if (typeof s !== 'object') return 'rights-missing';
  for (const k of ['sourceUrl', 'author', 'licenceName', 'downloadedAt']) if (typeof s[k] !== 'string' || s[k].trim() === '') return 'rights-missing';
  return null;
}
