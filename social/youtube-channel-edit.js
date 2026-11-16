#!/usr/bin/env node
// Text clean-up + guarded write tool for the two Beyond Paradise Adventures YouTube channels.
// - Pure text functions (fixDescription, fixPlaylistDescription, keywordsString): no I/O.
// - buildPlan / `plan`: reads the live channels (GET only) and writes a plan. Nothing is written to YouTube.
//   With `plan --decisions <file>` the plan is built ONLY from explicit decisions (titles, playlist privacy, new playlists); the text rules are not run.
// - applyPlan / `apply`: the ONLY code path that writes. Guarded: channel check, stale check, field whitelist,
//   ledger line BEFORE each write, full-part PUT, read-back verification, quota cap, Google-hosts-only.
// - undoLedger / `undo`: restores the "before" values from a ledger file, same guards.
// Node built-ins only. Sign-in files and client values live outside the repo (see youtube-channel.js); never printed.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { accessToken, channelInfo, listVideos, listPlaylists } from './youtube-channel.js';
import { CHANNELS } from './youtube-login.js';

const API = 'https://www.googleapis.com/youtube/v3';
const NEW_SITE = 'https://beyondparadiseadventures.com/';
const CANON = `Beyond Paradise Adventures: ${NEW_SITE}`;
const INSTAGRAM = 'https://www.instagram.com/beyondparadiseadventures/';
const OTHER_CHANNEL_LINE = {
  asia: 'Africa channel: https://www.youtube.com/@bpa-africa',
  africa: 'Asia channel: https://www.youtube.com/@beyondparadiseadventures',
};
const HOSTS = new Set(['www.googleapis.com', 'oauth2.googleapis.com']);

// ---------------------------------------------------------------- text rules
const ADDR = /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|co)\b)/i;
const OLD_SITE = /(?<![\w.@-])(?:https?:\/\/)?(?:www\.)?beyondparadiseadventures\.net(?![a-z])(?:\/+(?![\w-]))?!?(?:\.(?!\w))?/gi;
const SHOP = /shop\.beyondparadiseadventures\.net/i;
const strip = (l) => l.replace(/^[^\p{L}\p{N}]+/u, '');

function tidyLines(lines) {
  const out = [];
  for (const raw of lines) {
    const l = raw.replace(/\s+$/u, '');
    if (l === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(l);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}
const toLines = (text) => String(text ?? '').replace(/\r\n?/g, '\n').split('\n');

const GLUED = /(?<=\S)(?=(?:Shop Travel Gear|Instagram|TikTok|Twitter|Website):)/g;
function rule1(text) {
  return text.replace(OLD_SITE, (m, offset, whole) => (whole[offset + m.length] === '/' ? NEW_SITE.slice(0, -1) : NEW_SITE))
    .replace(/(https:\/\/beyondparadiseadventures\.com\/)\.(?!\w)/g, '$1')
    .replace(/([^\s:\/]):(?=https?:\/\/)/g, '$1: ');
}
// A lead-in line ending with ":" that the edit left with nothing under it is removed (only when something stood under it before).
function dropOrphanLeads(before, after) {
  let cur = after.slice();
  for (;;) {
    let p = 0; const drop = new Set();
    cur.forEach((l, i) => {
      const j = before.indexOf(l, p); if (j < 0) return; p = j + 1;
      if (i > 0 && /:$/.test(l.trim()) && (i === cur.length - 1 || !cur[i + 1].trim()) && before[j + 1] !== undefined && before[j + 1].trim()) drop.add(i);
    });
    if (!drop.size) return cur;
    cur = cur.filter((_, i) => !drop.has(i));
  }
}
const EMOJI_ONLY = /^[\s\p{Extended_Pictographic}\uFE0F\u200D\u2190-\u21FF]+$/u;
function dropEmptyPlaceholders(lines) {
  return lines.filter((l, i) => !(i > 1 && l.trim() && EMOJI_ONLY.test(l) && /:$/.test(lines[i - 1].trim())));
}
function rule2(lines) {
  const del = new Set();
  lines.forEach((l, i) => {
    if (!SHOP.test(l)) return;
    del.add(i);
    const p = lines[i - 1];
    if (p !== undefined && p.trim() && !del.has(i - 1) && /gear|shop|essentials|accessories/i.test(p) && !ADDR.test(p)) del.add(i - 1);
  });
  return lines.filter((_, i) => !del.has(i));
}
const isChannelLine = (l) => l.length <= 160 && (/youtube\.com\/channel\/UC[\w-]+/i.test(l) || /\bBPA\s*-\s*(?:Asia|Africa)\b/i.test(l) || /\bBeyond Paradise\s+(?:Adv\w*\s+)?(?:Asia|Africa)\b/i.test(l));
function isChannelLead(l) {
  const s = l.trim();
  return !!s && !ADDR.test(s) && /\b(?:subscribe|channels?)\b/i.test(s) && (/:$/.test(s) || /\bchannels?$/i.test(s));
}
function rule5(lines, channel) {
  const out = []; let i = 0;
  while (i < lines.length) {
    if (!isChannelLine(lines[i])) { out.push(lines[i++]); continue; }
    let j = i; while (j < lines.length && isChannelLine(lines[j])) j++;
    if (j - i === 1 && lines[i].trim() === OTHER_CHANNEL_LINE[channel]) { out.push(lines[i]); i = j; continue; }
    if (out.length && isChannelLead(out[out.length - 1])) out.pop();
    out.push(OTHER_CHANNEL_LINE[channel]); i = j;
  }
  return out;
}

const LEAD_WORDS = /\b(?:plan|book|visit|website|site|blog|flights?|hotels?|shop|gear|essentials|accessories|tickets?|explore|bookings?|travel guides?)\b/i;
const TERMINATED = /[.!?:][^\p{L}\p{N}]*$/u;
function sentences(text) {
  const out = [];
  for (const m of text.matchAll(/.*?(?:[.!?]+(?![\p{L}\p{N}\/@])[^\p{L}\p{N}@#]*|$)/gsu)) if (m[0].length) out.push(m[0]);
  return out;
}
const isPromo = (s) => (/beyondparadiseadventures\.com/i.test(s) && !/^\W*Website\s*:\s*\S+\s*$/i.test(s.trim())) || /\bget your tickets\b/i.test(s) || /\bhotel\s*&\s*flight bookings\b/i.test(s);
function isLeadIn(s) {
  const t = s.trim(); if (!t) return true;
  if ((/:$/.test(t) || /\b(?:at|from|on|via)$/i.test(t)) && LEAD_WORDS.test(t)) return true;
  if (/^\W*(?:ready to|want to)\b/i.test(t) && /\?$/.test(t)) return true;
  if (/^\W*for more\b/i.test(t) && !TERMINATED.test(t)) return true;
  if (/^\W*(?:plan|book|start planning)\b/i.test(t) && !TERMINATED.test(t)) return true;
  return false;
}
function stripLeadIns(text) {
  const ss = sentences(text);
  while (ss.length && isLeadIn(ss[ss.length - 1])) ss.pop();
  return ss.join('').trimEnd();
}
const hasWords = (s) => /[\p{L}\p{N}]/u.test(s);

function rule6(lines, lo = 1) {
  // units: soft-wrapped lines (next line starts lowercase, this one has no end punctuation) are one unit. Line 1 is never touched.
  const units = [];
  lines.forEach((l, i) => {
    const t = l.trim();
    if (i > 0 && t && /^[a-z]/.test(t) && !/^(?:https?:|www\.)/i.test(t)) {
      let k = units.length - 1, blanks = 0;
      while (k >= 0 && !units[k].text.trim()) { k--; blanks++; }
      if (k >= lo && !TERMINATED.test(units[k].text)) { units.length = k + 1; units[k].text += '\n'.repeat(blanks + 1) + l; return; }
    }
    units.push({ idx: i, text: l });
  });
  const out = [];
  const sweepUp = () => {
    for (let k = out.length - 1; k >= lo; k--) {
      if (!out[k].trim()) continue;
      const left = stripLeadIns(out[k]);
      if (left === out[k].trimEnd()) return;
      out[k] = left;
      if (hasWords(left)) return;
      out[k] = '\u0000';
    }
  };
  for (const u of units) {
    if ((lo === 1 && u.idx === 0) || !u.text.trim()) { out.push(u.text); continue; }
    const ss = sentences(u.text);
    if (!ss.some(isPromo)) { out.push(u.text); continue; }
    let left = stripLeadIns(ss.filter((s) => !isPromo(s)).join(''));
    if (hasWords(left)) { out.push(left); continue; }
    sweepUp();
  }
  return out.filter((l) => l !== '\u0000').join('\n').split('\n');
}
function promoWarnings(lines, lo = 1) {
  const w = [];
  lines.forEach((l, i) => {
    if (i < lo || l === CANON) return;
    const t = l.trim();
    if (((/:$/.test(t) || /\b(?:at|from)$/i.test(t)) && /\b(?:plan|book|tickets?)\b/i.test(t) && !(/:$/.test(t) && (lines[i + 1] || '').trim())) ||
        /\bbook(?:ing)?s?\b[^.!?\n]*\b(?:tours?|flights?|tickets?|trips?|adventures?)\b/i.test(t) || /\b(?:our website|travel blog)\b/i.test(t)) w.push(`line ${i + 1}: promo wording left (cannot be removed cleanly): "${t.slice(0, 90)}"`);
  });
  return w;
}

function runRules(text, { channel, playlist }) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n').replace(GLUED, '\n');
  const original = tidyLines(raw.split('\n')).filter((l) => l.trim() !== CANON);
  let lines = tidyLines(rule1(raw).split('\n')).filter((l) => l.trim() !== CANON);
  lines = rule2(lines);
  lines = lines.filter((l, i) => (!playlist && i === 0) || !/^[^\p{L}\p{N}]*(?:TikTok|Twitter)\s*:/iu.test(l)); // rule 3
  lines = lines.map((l) => l.replace(/Instagram:\s*@beyondparadiseadventures\b/gi, `Instagram: ${INSTAGRAM}`)); // rule 4
  if (!playlist) lines = rule5(lines, channel);
  lines = rule6(lines, playlist ? 0 : 1);
  lines = dropEmptyPlaceholders(tidyLines(lines));
  lines = tidyLines(dropOrphanLeads(original, lines));
  return lines;
}
export function fixDescription(text, { channel } = {}) {
  if (!OTHER_CHANNEL_LINE[channel]) throw new Error(`fixDescription: channel must be "asia" or "africa", got "${channel}"`);
  let lines = runRules(text, { channel });
  if (lines.length === 0) lines = [CANON]; else lines.splice(1, 0, CANON); // rule 7
  lines = tidyLines(lines);
  return { text: lines.join('\n'), warnings: promoWarnings(lines) };
}
export function fixPlaylistDescription(text) {
  if (!String(text ?? '').trim()) return { text: '', warnings: [] };
  const lines = runRules(text, { playlist: true });
  if (!lines.some((l) => l.includes(NEW_SITE))) lines.push(CANON);
  return { text: lines.join('\n'), warnings: promoWarnings(lines, 0) };
}
export const keywordsString = (list) => list.map((k) => (/\s/.test(k) ? `"${k}"` : k)).join(' ');

// ---------------------------------------------------------------- network guard + session
function assertGoogleUrl(url) {
  let u; try { u = new URL(String(url)); } catch { throw new Error(`refused request: bad address`); }
  if (u.protocol !== 'https:') throw new Error(`refused request: host ${u.host} must use https`);
  if (!HOSTS.has(u.hostname)) throw new Error(`refused request to host "${u.host}" (only www.googleapis.com and oauth2.googleapis.com are allowed)`);
}
export function guardedFetch(inner) {
  return async (url, opts) => { assertGoogleUrl(url); return inner(url, opts); };
}
const qs = (o) => new URLSearchParams(o).toString();
export function makeSession(deps = {}, maxUnits = 3000) {
  const d = { ...deps, fetch: guardedFetch(deps.fetch || globalThis.fetch) };
  const s = { d, units: 0, maxUnits, tokens: {}, own: {} };
  s.token = async (ch) => (s.tokens[ch] ??= await accessToken(ch, d));
  s.call = async (method, url, ch, body) => {
    assertGoogleUrl(url); // checked before anything is sent, not only inside the fetch wrapper
    const t = await s.token(ch);
    s.units += method === 'GET' ? 1 : 50;
    const r = await d.fetch(url, { method, headers: { Authorization: `Bearer ${t}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} ${j?.error?.message || j?.error || ''} (${new URL(url).pathname})`.trim()), { http: r.status, reasons: (j?.error?.errors || []).map((x) => String(x?.reason ?? '')) });
    return j;
  };
  s.ownChannelId = async (ch) => {
    if (!s.own[ch]) s.own[ch] = (await s.call('GET', `${API}/channels?${qs({ part: 'id', mine: 'true' })}`, ch)).items?.[0]?.id;
    if (s.own[ch] !== CHANNELS[ch].id) throw new Error(`channel guard: the "${ch}" sign-in belongs to channel ${s.own[ch]}, expected ${CHANNELS[ch].id}. Nothing written.`);
    return s.own[ch];
  };
  return s;
}

// ---------------------------------------------------------------- parts
const SNIPPET_KEYS = { video: ['title', 'description', 'tags', 'categoryId', 'defaultLanguage', 'defaultAudioLanguage'], playlist: ['title', 'description', 'tags', 'defaultLanguage'] };
// The ONE place that lists what may be written, per kind. A video's privacy and any delete are deliberately absent.
// 'playlist-create' is the pseudo-kind of a new playlist (playlists.insert); its items are playlistItems.insert.
export const ALLOWED = {
  video: ['description', 'categoryId', 'title'],
  playlist: ['description', 'title', 'privacyStatus'],
  channel: ['description', 'keywords', 'title'],
  'playlist-create': ['title', 'description', 'privacyStatus'],
};
const clone = (o) => JSON.parse(JSON.stringify(o));
function partOf(kind, live) {
  if (kind === 'channel') return clone(live.brandingSettings || {});
  const sn = live.snippet || {}; const p = {};
  for (const k of SNIPPET_KEYS[kind]) if (k in sn) p[k] = clone(sn[k]);
  return p;
}
// partOf + the privacy that lives in the status part (video/playlist). This is what the ledger records as "before".
function stateOf(kind, live) {
  const p = partOf(kind, live);
  if (kind !== 'channel') p.privacyStatus = live.status?.privacyStatus;
  return p;
}
function fieldsOf(kind, part) {
  if (kind === 'channel') return { title: part.channel?.title ?? '', description: part.channel?.description ?? '', keywords: part.channel?.keywords ?? '' };
  return { title: part.title ?? '', description: part.description ?? '', categoryId: part.categoryId, privacyStatus: part.privacyStatus };
}
// privacyStatus is not a snippet field: it is sent in the status part (see putSpec), never merged into the snippet.
function withFields(kind, part, fields) {
  const p = clone(part);
  if (kind === 'channel') p.channel = { ...(p.channel || {}), ...fields };
  else for (const k of Object.keys(fields)) if (k !== 'privacyStatus') p[k] = fields[k];
  return p;
}
// url + body of an update: channel -> brandingSettings; video/playlist -> snippet and/or status, in ONE call.
function putSpec(kind, id, merged, changed) {
  if (kind === 'channel') return { url: `${API}/channels?part=brandingSettings`, body: { id, brandingSettings: merged } };
  const sn = Object.keys(changed).some((k) => k !== 'privacyStatus'); const st = 'privacyStatus' in changed;
  const body = { id }; if (sn) body.snippet = merged; if (st) body.status = { privacyStatus: changed.privacyStatus };
  return { url: `${API}/${kind}s?part=${[sn && 'snippet', st && 'status'].filter(Boolean).join(',')}`, body };
}
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((q) => [q, x[q]])) : x));
const trunc = (v) => { const t = typeof v === 'string' ? v : canon(v); return JSON.stringify((t ?? 'undefined').slice(0, 80)); };

async function readLive(s, op) {
  const { kind, channel, id } = op;
  if (kind === 'channel') {
    const it = (await s.call('GET', `${API}/channels?${qs({ part: 'brandingSettings,id', mine: 'true' })}`, channel)).items?.[0];
    if (!it || it.id !== CHANNELS[channel].id) throw new Error(`channel guard: live channel ${it?.id} is not the expected ${CHANNELS[channel].id}`);
    return it;
  }
  const plural = kind === 'video' ? 'videos' : 'playlists';
  const it = (await s.call('GET', `${API}/${plural}?${qs({ part: 'snippet,status', id })}`, channel)).items?.[0];
  if (!it) throw Object.assign(new Error(`${kind} ${id} not found on channel ${channel}`), { notFound: true });
  if (it.snippet?.channelId !== CHANNELS[channel].id) throw new Error(`channel guard: ${kind} ${id} belongs to channel ${it.snippet?.channelId}, expected ${CHANNELS[channel].id}. Nothing written.`);
  return it;
}
function differences(kind, sent, changed, prevLive, newLive) {
  const out = []; const np = partOf(kind, newLive); const nf = fieldsOf(kind, stateOf(kind, newLive));
  const cmp = (label, a, b) => { if (canon(a) !== canon(b)) out.push(`${label}: expected ${trunc(a)}, got ${trunc(b)}`); };
  for (const k of Object.keys(changed)) cmp(k, changed[k], nf[k]);
  if (kind === 'channel') {
    for (const k of Object.keys(sent)) if (k !== 'channel') cmp(`brandingSettings.${k}`, sent[k], np[k]);
    for (const k of Object.keys(sent.channel || {})) if (!(k in changed)) cmp(`brandingSettings.channel.${k}`, sent.channel[k], np.channel?.[k]);
  } else {
    for (const k of Object.keys(sent)) if (!(k in changed)) cmp(k, sent[k], np[k]);
    if (!('privacyStatus' in changed)) cmp('status.privacyStatus', prevLive.status?.privacyStatus, newLive.status?.privacyStatus); // a privacy change is checked as a changed field above
  }
  return out;
}

// Which refusals of a channel RENAME let the run continue: YouTube said no to this title (400, or a 403 with a title-specific reason).
// Auth, quota, rate-limit and plain "forbidden" answers (401, 429, wrong channel) always stop the run.
export function renameRefusalContinues(e) {
  if (e.http !== 400 && e.http !== 403) return false;
  const text = `${(e.reasons || []).join(' ')} ${e.message}`;
  if (/quota|ratelimit|limitexceeded|autherror|insufficientpermissions|unauthori[sz]ed/i.test(text)) return false;
  if ((e.reasons || []).some((r) => r.toLowerCase() === 'forbidden')) return false;
  return true;
}

// Verify a write. YouTube's read right after a write can lag, so: (1) check the PUT response body, (2) read back up to 6 times, 5 s apart.
const READ_ATTEMPTS = 6, READ_GAP_MS = 5000;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function verifyWrite(s, op, merged, changed, prevLive, putResp) {
  const sleep = s.d.sleep || defaultSleep;
  const part = op.kind === 'channel' ? putResp?.brandingSettings : putResp?.snippet;
  const trustAnswer = !(op.kind === 'channel' && 'title' in changed); // a channel title is only believed after a live read
  if (trustAnswer && part && typeof part === 'object') {
    const fromPut = op.kind === 'channel' ? { ...putResp, id: prevLive.id } : { ...putResp, status: putResp.status || prevLive.status };
    if (!differences(op.kind, merged, changed, prevLive, fromPut).length) return { ok: true, attempts: 0, via: 'put-response', live: fromPut };
  }
  let diffs = [], live;
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(READ_GAP_MS);
    live = await readLive(s, op);
    diffs = differences(op.kind, merged, changed, prevLive, live);
    if (!diffs.length) return { ok: true, attempts: attempt, via: 'read-back', live };
  }
  return { ok: false, attempts: READ_ATTEMPTS, diffs, live };
}

// ---------------------------------------------------------------- content rules for explicit decisions
// Fields a decisions file may set (a subset of ALLOWED: no categoryId, keywords, channel description).
const DECISION_FIELDS = { video: ['title', 'description'], playlist: ['title', 'description', 'privacyStatus'], channel: ['title'], 'playlist-create': ['title', 'description', 'privacyStatus'] };
for (const [k, fields] of Object.entries(DECISION_FIELDS)) for (const f of fields) if (!ALLOWED[k].includes(f)) throw new Error(`internal: decision field ${k}.${f} is not in ALLOWED`);
const LIMITS = { video: { title: 100, description: 5000 }, playlist: { title: 150, description: 5000 }, 'playlist-create': { title: 150, description: 5000 }, channel: { title: 100 } };
const OK_HOSTS = new Set(['beyondparadiseadventures.com', 'www.instagram.com', 'www.youtube.com', 'www.facebook.com']);
const TLDS = 'com|net|org|io|co|info|app|me|tv|ly|be|de|vn|tz|uk|us|eu|biz|xyz|site|online|shop|blog|travel|ae|fr|nl|asia|africa';
// A web address is: anything with a scheme, anything starting with www., or a dotted word whose part after the last dot is a LOWERCASE
// (or ALL-CAPS) known top-level domain followed by "/", end of text, whitespace or punctuation. "Great.Be careful", "Day 1.Co-op" are not addresses.
const URLISH = /https?:\/\/[^\s<>"')\]]+|(?<![\w.@-])www\.[^\s<>"')\]]+/gi;
const BARE = new RegExp(`\\b(?:[A-Za-z0-9-]+\\.)+(?:${TLDS})(?![A-Za-z0-9-])(?:\\/[^\\s<>"')\\]]*)?`, 'g');
const BARE_UP = new RegExp(`\\b(?:[A-Z0-9-]+\\.)+(?:${TLDS.toUpperCase()})(?![A-Za-z0-9-])(?:\\/[^\\s<>"')\\]]*)?`, 'g');
function addressTokens(v) {
  const out = []; const rest = v.replace(URLISH, (m) => { out.push(m); return ' '; });
  for (const re of [BARE, BARE_UP]) for (const m of rest.matchAll(re)) out.push(m[0]);
  return out;
}
function hostOf(token) {
  const t = token.replace(/[.,;:!?)\]]+$/, '');
  try { return new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`).hostname.toLowerCase(); } catch { return null; }
}
// Problems with the values of one object (field -> text). Empty list = fine. Used at plan time AND again at apply time.
function contentProblems(kind, set) {
  const out = [];
  for (const [k, v] of Object.entries(set)) {
    if (typeof v !== 'string') { out.push(`${k} must be text`); continue; }
    if (k === 'privacyStatus') {
      if (kind !== 'playlist' && kind !== 'playlist-create') out.push(`privacyStatus of a ${kind} can never be set by this tool`);
      else if (v !== 'private' && v !== 'public') out.push(`privacyStatus must be "private" or "public", got "${v}"`);
      continue;
    }
    if (k !== 'title' && k !== 'description') continue;
    if (k === 'title' && !v.trim()) out.push('title is empty');
    const max = LIMITS[kind]?.[k]; // what YouTube counts: a description in UTF-8 bytes, a title in characters (code points)
    if (max) { const n = k === 'description' ? Buffer.byteLength(v, 'utf8') : [...v].length; if (n > max) out.push(`${k} is ${n} ${k === 'description' ? 'bytes' : 'characters'}, the limit is ${max}`); }
    if (/[<>]/.test(v)) out.push(`${k} contains "<" or ">"`);
    if (/beyondparadiseadventures\.net/i.test(v)) out.push(`${k} contains the old address beyondparadiseadventures.net`);
    const bad = new Set();
    for (const tok of addressTokens(v)) { const h = hostOf(tok); if (!h || !OK_HOSTS.has(h)) bad.add(h || tok); }
    for (const h of bad) out.push(`${k} contains the address host "${h}" (allowed: ${[...OK_HOSTS].join(', ')})`);
  }
  return out;
}
const TEXT_FIELDS = new Set(['title', 'privacyStatus']);
// Ops that carry the new fields, or come from a decisions plan, get the full content check again when applied (a plan.json can be edited by hand).
const needsContentCheck = (op) => op.kind === 'playlist-create' || op.source === 'decisions' || Object.keys(op.after || {}).some((k) => TEXT_FIELDS.has(k) || k === 'description');

function validateCreate(op) {
  if (typeof op.id !== 'string' || !op.id || op.key !== op.id) throw new Error('plan refused: playlist-create without a key (id must equal key)');
  if (!Array.isArray(op.items) || op.items.some((i) => typeof i !== 'string' || !i)) throw new Error(`plan refused: playlist-create ${op.id}: items must be a list of video ids`);
  if (!op.after || typeof op.after !== 'object') throw new Error(`plan refused: op ${op.id} has no after`);
  for (const k of Object.keys(op.after)) if (!ALLOWED['playlist-create'].includes(k)) throw new Error(`plan refused: playlist-create ${op.id} would set "${k}" (only ${ALLOWED['playlist-create'].join(', ')} may be set)`);
  for (const k of ['title', 'privacyStatus']) if (typeof op.after[k] !== 'string') throw new Error(`plan refused: playlist-create ${op.id} has no ${k}`);
  const bad = contentProblems('playlist-create', op.after); if (bad.length) throw new Error(`plan refused: playlist-create ${op.id}: ${bad.join('; ')}`);
}
function validateOp(op) {
  if (!op || !ALLOWED[op.kind]) throw new Error(`plan refused: unknown op kind "${op?.kind}"`);
  if (!CHANNELS[op.channel]) throw new Error(`plan refused: unknown channel "${op.channel}"`);
  if (op.kind === 'playlist-create') return validateCreate(op);
  if (typeof op.id !== 'string' || !op.id) throw new Error('plan refused: op without id');
  if (op.kind === 'channel' && op.id !== CHANNELS[op.channel].id) throw new Error(`plan refused: channel op id ${op.id} is not the ${op.channel} channel`);
  for (const side of ['before', 'after']) {
    if (!op[side] || typeof op[side] !== 'object') throw new Error(`plan refused: op ${op.id} has no ${side}`);
    for (const k of Object.keys(op[side])) {
      if (!ALLOWED[op.kind].includes(k)) throw new Error(`plan refused: op ${op.kind} ${op.id} would change "${k}" (only ${ALLOWED[op.kind].join(', ')} may change)`);
      if (typeof op[side][k] !== 'string') throw new Error(`plan refused: op ${op.id} ${side}.${k} is not text`);
    }
  }
  for (const k of Object.keys(op.after)) if (!(k in op.before)) throw new Error(`plan refused: op ${op.id} after.${k} has no before value`);
  if (needsContentCheck(op)) { const bad = contentProblems(op.kind, op.after); if (bad.length) throw new Error(`plan refused: ${op.kind} ${op.id}: ${bad.join('; ')}`); }
}

// ---------------------------------------------------------------- ledger
const dayOf = (d) => (d.now || new Date()).toISOString().slice(0, 10);
function ledgerAppend(file, line) {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  appendFileSync(file, JSON.stringify(line) + '\n', { mode: 0o600 }); chmodSync(file, 0o600);
}

// ---------------------------------------------------------------- plan: explicit decisions (--decisions <file.json>)
const OP_KEYS = { video: ['channel', 'kind', 'id', 'set'], playlist: ['channel', 'kind', 'id', 'set'], channel: ['channel', 'kind', 'id', 'set'], 'playlist-create': ['channel', 'kind', 'key', 'set', 'items'] };
const normTitle = (t) => String(t ?? '').trim().toLowerCase();
const opLabel = (i, o) => `decisions op #${i + 1} (${o?.kind} ${o?.id ?? o?.key ?? '?'}, channel ${o?.channel})`;
// Everything that can be checked without the network. Returns a list of "<label>: <problem>" strings.
function checkDecisions(dec) {
  if (!dec || typeof dec !== 'object' || Array.isArray(dec) || !Array.isArray(dec.ops)) throw new Error('decisions refused: the file must be {"ops": [...]}');
  for (const k of Object.keys(dec)) if (k !== 'ops') throw new Error(`decisions refused: unknown top-level key "${k}" (only "ops")`);
  if (!dec.ops.length) throw new Error('decisions refused: "ops" is empty');
  const errors = []; const seen = new Set(); const titles = new Set(); const keys = new Set();
  dec.ops.forEach((o, i) => {
    const bad = (m) => errors.push(`${opLabel(i, o)}: ${m}`);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return bad('not an object');
    if (!OP_KEYS[o.kind]) return bad(`unknown op kind "${o.kind}" (allowed: ${Object.keys(OP_KEYS).join(', ')}; there is no delete)`);
    for (const k of Object.keys(o)) if (!OP_KEYS[o.kind].includes(k)) bad(`unknown key "${k}"`);
    if (!CHANNELS[o.channel]) return bad(`unknown channel "${o.channel}"`);
    if (!o.set || typeof o.set !== 'object' || Array.isArray(o.set) || !Object.keys(o.set).length) return bad('"set" must be an object with something to set');
    const create = o.kind === 'playlist-create';
    for (const f of Object.keys(o.set)) {
      if (DECISION_FIELDS[o.kind].includes(f)) continue;
      bad(f === 'privacyStatus' ? `privacyStatus of a ${o.kind} can never be set by this tool` : `field "${f}" is not allowed for ${o.kind} (allowed: ${DECISION_FIELDS[o.kind].join(', ')})`);
    }
    for (const m of contentProblems(o.kind, Object.fromEntries(Object.entries(o.set).filter(([f]) => DECISION_FIELDS[o.kind].includes(f))))) bad(m);
    if (create) {
      if (typeof o.key !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/i.test(o.key)) bad('a playlist-create needs a "key" (letters, digits, dashes)');
      else if (keys.has(o.key)) bad(`key "${o.key}" is used twice`); else keys.add(o.key);
      if (typeof o.set.title !== 'string') bad('title is required'); if (typeof o.set.privacyStatus !== 'string') bad('privacyStatus is required ("private" or "public")');
      if (!Array.isArray(o.items) || o.items.some((x) => typeof x !== 'string' || !x)) bad('"items" must be a list of video ids');
      else if (new Set(o.items).size !== o.items.length) bad('an item is listed twice');
      const t = `${o.channel}|${normTitle(o.set.title)}`; if (titles.has(t)) bad('another playlist-create has the same title on this channel'); titles.add(t);
    } else {
      if (typeof o.id !== 'string' || !o.id) bad('"id" is required');
      else if (o.kind === 'channel' && o.id !== CHANNELS[o.channel].id) bad(`channel id ${o.id} is not the ${o.channel} channel`);
      const t = `${o.kind}|${o.channel}|${o.id}`; if (seen.has(t)) bad('the same object is named by two ops'); seen.add(t);
    }
  });
  return errors;
}
async function ownPlaylists(s, channel) {
  const out = []; let page;
  do {
    const p = { part: 'snippet,status', mine: 'true', maxResults: '50' }; if (page) p.pageToken = page;
    const j = await s.call('GET', `${API}/playlists?${qs(p)}`, channel);
    out.push(...(j.items || [])); page = j.nextPageToken;
  } while (page);
  return out;
}
// Problems with the videos a new playlist would hold: each must exist, belong to this channel and be public.
async function itemProblems(s, channel, items) {
  const found = {}; const out = [];
  for (let i = 0; i < items.length; i += 50) for (const v of (await s.call('GET', `${API}/videos?${qs({ part: 'snippet,status', id: items.slice(i, i + 50).join(',') })}`, channel)).items || []) found[v.id] = v;
  for (const id of items) {
    const v = found[id];
    if (!v) out.push(`item ${id} not found`);
    else if (v.snippet?.channelId !== CHANNELS[channel].id) out.push(`item ${id} belongs to another channel`);
    else if (v.status?.privacyStatus !== 'public') out.push(`item ${id} is ${v.status?.privacyStatus}, only public videos may be added`);
  }
  return out;
}
// The items a playlist holds right now: [{ id (playlistItem id), videoId }].
async function ownItems(s, channel, playlistId) {
  const out = []; let page;
  do {
    const p = { part: 'snippet', playlistId, maxResults: '50' }; if (page) p.pageToken = page;
    const j = await s.call('GET', `${API}/playlistItems?${qs(p)}`, channel);
    for (const it of j.items || []) out.push({ id: it.id, videoId: it.snippet?.resourceId?.videoId });
    page = j.nextPageToken;
  } while (page);
  return out;
}
// Every parsable line of every changes-*.jsonl in the ledger directory ("this ledger" for resume decisions).
function allLedgerLines(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => /^changes-.*\.jsonl$/.test(n)).sort().flatMap((n) => readFileSync(join(dir, n), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
}
async function buildDecisionsPlan(s, deps) {
  const dec = deps.decisions; const errors = checkDecisions(dec);
  if (errors.length) throw new Error(`plan refused (nothing written):\n- ${errors.join('\n- ')}`);
  const ops = []; const skipped = []; const lists = {};
  for (const [i, o] of dec.ops.entries()) {
    const bad = (m) => errors.push(`${opLabel(i, o)}: ${m}`);
    try {
      await s.ownChannelId(o.channel);
      if (o.kind === 'playlist-create') {
        const existing = (lists[o.channel] ??= await ownPlaylists(s, o.channel));
        if (existing.some((p) => normTitle(p.snippet?.title) === normTitle(o.set.title))) { skipped.push({ kind: o.kind, channel: o.channel, id: o.key, title: o.set.title, reason: 'already-exists' }); continue; }
        const probs = await itemProblems(s, o.channel, o.items); if (probs.length) { probs.forEach(bad); continue; }
        ops.push({ kind: o.kind, channel: o.channel, id: o.key, key: o.key, title: o.set.title, before: {}, after: { title: o.set.title, description: o.set.description ?? '', privacyStatus: o.set.privacyStatus }, items: [...o.items], source: 'decisions', warnings: [] });
        continue;
      }
      const live = await readLive(s, o);
      const label = o.kind === 'channel' ? (live.brandingSettings?.channel?.title ?? '') : (live.snippet?.title ?? '');
      if (o.kind === 'video' && live.status?.privacyStatus === 'private') { skipped.push({ kind: o.kind, channel: o.channel, id: o.id, title: label, reason: 'private' }); continue; }
      const cur = fieldsOf(o.kind, stateOf(o.kind, live)); const before = {}; const after = {};
      for (const k of Object.keys(o.set)) if (cur[k] !== o.set[k]) { before[k] = cur[k] ?? ''; after[k] = o.set[k]; }
      if (!Object.keys(after).length) { skipped.push({ kind: o.kind, channel: o.channel, id: o.id, title: label, reason: 'already-applied' }); continue; }
      ops.push({ kind: o.kind, channel: o.channel, id: o.id, title: label, before, after, source: 'decisions', warnings: [] });
    } catch (e) { bad(String(e.message || e)); }
  }
  if (errors.length) throw new Error(`plan refused (nothing written):\n- ${errors.join('\n- ')}`);
  ops.forEach(validateOp); // the plan must be one that apply would accept
  return { createdAt: (deps.now || new Date()).toISOString(), source: 'decisions', ops, skipped };
}

// ---------------------------------------------------------------- plan
export async function buildPlan(deps = {}) {
  const s = makeSession(deps); const d = s.d;
  if (deps.decisions !== undefined) return buildDecisionsPlan(s, deps); // decisions only: the text rules below are never run (a null/empty file is refused, never "no decisions = rules")
  const texts = deps.texts || JSON.parse(readFileSync(new URL('./youtube-channel-texts.json', import.meta.url), 'utf8'));
  const ops = []; const skipped = [];
  for (const channel of Object.keys(CHANNELS)) {
    const info = await channelInfo(channel, d);
    if (!info || info.id !== CHANNELS[channel].id) throw new Error(`channel guard: the "${channel}" sign-in belongs to ${info?.id}, expected ${CHANNELS[channel].id}`);
    const bc = info.brandingSettings?.channel || {};
    const before = { description: bc.description ?? '', keywords: bc.keywords ?? '' };
    const after = { description: texts[channel].description, keywords: keywordsString(texts[channel].keywords) };
    if (canon(before) !== canon(after)) ops.push({ kind: 'channel', channel, id: info.id, title: info.snippet?.title ?? bc.title ?? '', before, after });
    for (const v of await listVideos(channel, d)) {
      const sn = v.snippet || {};
      if (v.status?.privacyStatus === 'private') { skipped.push({ kind: 'video', channel, id: v.id, title: sn.title ?? '', reason: 'private' }); continue; }
      const fixed = fixDescription(sn.description ?? '', { channel });
      const cat = channel === 'africa' && sn.categoryId === '22' ? '19' : sn.categoryId;
      const b = { description: sn.description ?? '', categoryId: sn.categoryId }; const a = { description: fixed.text, categoryId: cat };
      if (canon(a) !== canon(b)) ops.push({ kind: 'video', channel, id: v.id, title: sn.title ?? '', before: b, after: a, warnings: fixed.warnings });
    }
    for (const p of await listPlaylists(channel, d)) {
      const fixed = fixPlaylistDescription(p.snippet?.description ?? '');
      const b = { description: p.snippet?.description ?? '' }; const a = { description: fixed.text };
      if (canon(a) !== canon(b)) ops.push({ kind: 'playlist', channel, id: p.id, title: p.snippet?.title ?? '', before: b, after: a, warnings: fixed.warnings });
    }
  }
  const rank = (o) => ['video', 'playlist', 'channel'].indexOf(o.kind) * 2 + (o.channel === 'africa' ? 0 : 1);
  ops.sort((x, y) => rank(x) - rank(y)); // stable: videos, playlists, channels last; Africa before Asia
  return { createdAt: (deps.now || new Date()).toISOString(), ops, skipped };
}

function lineDiff(a, b) {
  const x = a.split('\n'), y = b.split('\n'); const n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { i++; j++; }
    else if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) { if (x[i].trim()) out.push('- ' + x[i]); i++; }
    else { if (y[j].trim()) out.push('+ ' + y[j]); j++; }
  }
  return out;
}
export function planMarkdown(plan) {
  const rows = {}; for (const o of plan.ops) { const k = `${o.kind}|${o.channel}`; rows[k] ??= { ops: 0, warn: 0 }; rows[k].ops++; if (o.warnings?.length) rows[k].warn++; }
  const md = [`# YouTube channel edit plan (${plan.createdAt})`, '', '| kind | channel | ops | with warnings |', '|---|---|---|---|'];
  for (const k of Object.keys(rows).sort()) { const [kind, ch] = k.split('|'); md.push(`| ${kind} | ${ch} | ${rows[k].ops} | ${rows[k].warn} |`); }
  md.push(`| total | | ${plan.ops.length} | ${plan.ops.filter((o) => o.warnings?.length).length} |`, '');
  const byReason = {}; for (const o of plan.skipped || []) (byReason[o.reason || 'private'] ??= []).push(o);
  for (const [reason, list] of Object.entries(byReason)) md.push(`## skipped: ${reason} (${list.length})`, ...list.map((o) => `- ${o.kind} ${o.channel} ${o.id} — ${o.title}`), '');
  for (const o of plan.ops) {
    md.push(`## ${o.kind} ${o.channel} ${o.id} — ${o.title}`, '```diff');
    for (const k of Object.keys(o.after)) md.push(...(o.before[k] === o.after[k] ? [] : lineDiff(`${k === 'description' ? '' : k + ': '}${o.before[k] ?? ''}`.replace(/^(?=.)/, ''), `${k === 'description' ? '' : k + ': '}${o.after[k] ?? ''}`)));
    md.push('```');
    if (o.items) md.push(`items (${o.items.length}): ${o.items.join(', ')}`);
    for (const w of o.warnings || []) md.push(`WARNING: ${w}`);
    md.push('');
  }
  return md.join('\n');
}

// ---------------------------------------------------------------- apply
export async function applyPlan(plan, { only, maxUnits = 3000, ledgerDir } = {}, deps = {}) {
  if (!plan || !Array.isArray(plan.ops)) throw new Error('plan refused: no ops list');
  if (!ledgerDir) throw new Error('ledgerDir is required');
  for (const op of plan.ops) validateOp(op); // everything is checked before the first request
  const s = makeSession(deps, maxUnits); const d = s.d;
  const file = join(ledgerDir, `changes-${dayOf(deps)}.jsonl`);
  const sum = { done: 0, stale: 0, alreadyApplied: 0, skipped: 0, failed: 0, refused: 0, units: 0, ledger: file, stoppedReason: null };
  const fin = () => { sum.units = s.units; return sum; };
  const log = (status, op, extra) => { const line = { ts: new Date().toISOString(), status, kind: op.kind, channel: op.channel, id: op.id, ...extra }; ledgerAppend(file, line); return line; };
  const fail = (op, e, extra) => { sum.failed++; log('failed', op, { error: String(e.message || e), ...extra }); return Object.assign(e, { summary: fin() }); };

  // A new playlist is ALWAYS inserted private, so a half-built one is never visible. Order: pending line, playlists.insert (private), "created" line
  // with the new id, one playlistItems.insert per item (own line each), and only then the requested privacy (own pending/result lines, read back), done.
  // Re-run: a done line for the key = already-applied; a created line of this ledger without done = RESUME (insert only the missing items, then privacy);
  // a same-title playlist this ledger did not create = playlist-exists-not-ours (never adopted, never deleted).
  const wantPublic = (op) => op.after.privacyStatus !== 'private';
  const sameChannelPlaylist = (op, it) => it?.snippet?.title === op.after.title && (it.snippet.description ?? '') === (op.after.description ?? '') && (it.snippet.channelId === undefined || it.snippet.channelId === CHANNELS[op.channel].id);
  async function readBackPlaylist(op, playlistId, ok, extra) {
    let good = false, attempts = 0;
    for (let a = 1; a <= READ_ATTEMPTS && !good; a++) {
      if (a > 1) await (s.d.sleep || defaultSleep)(READ_GAP_MS);
      attempts = a;
      try { good = ok(await readLive(s, { kind: 'playlist', channel: op.channel, id: playlistId })); } catch (e) { if (!e.notFound) throw fail(op, e, { playlistId, ...extra }); }
    }
    return { good, attempts };
  }
  async function setPrivacy(op, playlistId, pendingTs) {
    const want = op.after.privacyStatus;
    log('privacy-pending', op, { of: pendingTs, playlistId, before: { privacyStatus: 'private' }, planned: { privacyStatus: want } });
    let resp;
    try { resp = await s.call('PUT', `${API}/playlists?part=status`, op.channel, { id: playlistId, status: { privacyStatus: want } }); }
    catch (e) { throw fail(op, e, { playlistId, step: 'privacy' }); }
    const ok = (it) => it?.status?.privacyStatus === want && it?.snippet?.title === op.after.title;
    let good = resp?.status?.privacyStatus === want && resp?.snippet?.title === op.after.title, attempts = 0;
    if (!good) ({ good, attempts } = await readBackPlaylist(op, playlistId, ok, { step: 'privacy' }));
    if (!good) { log('mismatch', op, { of: pendingTs, playlistId, step: 'privacy', differences: [`privacyStatus: expected "${want}"`], attempts }); throw Object.assign(new Error(`read-back mismatch for the privacy of new playlist ${playlistId} (${op.id}) after ${attempts} reads. It stays private; run again to finish, or undo to delete it. Run stopped.`), { summary: fin() }); }
    log('privacy-done', op, { of: pendingTs, playlistId, planned: { privacyStatus: want }, verified: true, attempts });
  }
  async function insertItems(op, playlistId, pendingTs, videoIds, itemIds) {
    for (const videoId of videoIds) {
      let r;
      try { r = await s.call('POST', `${API}/playlistItems?part=snippet`, op.channel, { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } }); }
      catch (e) { throw fail(op, e, { playlistId, videoId, itemsDone: itemIds.length }); }
      if (typeof r?.id !== 'string' || !r.id || (r.snippet?.resourceId?.videoId && r.snippet.resourceId.videoId !== videoId)) throw fail(op, new Error(`the playlist item insert for ${videoId} did not answer with a matching item`), { playlistId, videoId, itemsDone: itemIds.length });
      itemIds.push(r.id); log('item-created', op, { of: pendingTs, playlistId, videoId, playlistItemId: r.id });
    }
  }
  const notOurs = (op, id, why) => fail(op, new Error(`playlist-exists-not-ours: ${why} (playlist id ${id}, channel ${op.channel}, title "${op.after.title}"). It was not created by this ledger, so it is NOT adopted and NOT changed or deleted. Open YouTube Studio, look at it, and rename or delete it yourself (or change the decision), then run again.`), { code: 'playlist-exists-not-ours', playlistId: id });
  async function applyCreate(op) {
    await s.ownChannelId(op.channel);
    const prior = allLedgerLines(ledgerDir).filter((l) => l.kind === 'playlist-create' && l.id === op.id && l.channel === op.channel);
    const found = (await ownPlaylists(s, op.channel)).filter((p) => normTitle(p.snippet?.title) === normTitle(op.after.title));
    if (found.length) {
      const createdIds = new Set(prior.filter((l) => l.status === 'created' && l.playlistId).map((l) => l.playlistId));
      const mine = found.find((p) => createdIds.has(p.id));
      if (!mine) throw notOurs(op, found[0].id, 'a playlist with this title already exists');
      if (prior.some((l) => l.status === 'done' && l.playlistId === mine.id)) { sum.alreadyApplied++; log('already-applied', op, { planned: op.after, playlistId: mine.id }); return; }
      // ---- resume ----
      const known = new Set(prior.filter((l) => (l.status === 'item-created' || l.status === 'item-present') && l.playlistId === mine.id).map((l) => l.playlistItemId));
      const live = await ownItems(s, op.channel, mine.id);
      const foreign = live.filter((i) => !known.has(i.id));
      if (foreign.length) throw notOurs(op, mine.id, `it holds ${foreign.length} item(s) this ledger did not insert (${foreign.map((i) => i.videoId).join(', ')})`);
      const have = new Set(live.map((i) => i.videoId)); const missing = op.items.filter((v) => !have.has(v));
      const needPrivacy = wantPublic(op) && (await readLive(s, { kind: 'playlist', channel: op.channel, id: mine.id })).status?.privacyStatus !== op.after.privacyStatus;
      if ((await itemProblems(s, op.channel, missing)).length) { sum.stale++; return; }
      const cost = 50 * (missing.length + (needPrivacy ? 1 : 0));
      if (s.units + cost > s.maxUnits) { sum.stoppedReason = `stopped before resuming playlist ${op.id}: it needs ${cost} units (${missing.length} missing items${needPrivacy ? ' + 1 privacy update' : ''}) and would pass maxUnits (${s.maxUnits}; ${s.units} used)`; return 'stop'; }
      const pending = log('pending', op, { before: {}, planned: op.after, items: op.items, resume: true, playlistId: mine.id });
      log('created', op, { of: pending.ts, playlistId: mine.id, resumed: true });
      for (const i of live) log('item-present', op, { of: pending.ts, playlistId: mine.id, videoId: i.videoId, playlistItemId: i.id });
      const itemIds = live.map((i) => i.id);
      await insertItems(op, mine.id, pending.ts, missing, itemIds);
      if (needPrivacy) await setPrivacy(op, mine.id, pending.ts);
      log('done', op, { of: pending.ts, playlistId: mine.id, itemIds, planned: op.after, verified: true, resumed: true });
      sum.done++; return;
    }
    if ((await itemProblems(s, op.channel, op.items)).length) { sum.stale++; return; } // an item is no longer a public video of this channel
    const cost = 50 * (1 + op.items.length + (wantPublic(op) ? 1 : 0));
    if (s.units + cost > s.maxUnits) { sum.stoppedReason = `stopped before creating playlist ${op.id}: it needs ${cost} units (1 insert + ${op.items.length} items${wantPublic(op) ? ' + 1 privacy update' : ''}) and would pass maxUnits (${s.maxUnits}; ${s.units} used)`; return 'stop'; }
    const pending = log('pending', op, { before: {}, planned: op.after, items: op.items });
    let resp;
    try { resp = await s.call('POST', `${API}/playlists?part=snippet,status`, op.channel, { snippet: { title: op.after.title, description: op.after.description ?? '' }, status: { privacyStatus: 'private' } }); }
    catch (e) { throw fail(op, e); }
    const newId = resp?.id;
    if (typeof newId !== 'string' || !newId) throw fail(op, new Error('the insert answered without a playlist id; the playlist (if it exists) is private: check YouTube Studio for a playlist titled "' + op.after.title + '"'));
    log('created', op, { of: pending.ts, playlistId: newId });
    const okNew = (it) => sameChannelPlaylist(op, it) && it.status?.privacyStatus === 'private';
    let good = okNew(resp), attempts = 0;
    if (!good) ({ good, attempts } = await readBackPlaylist(op, newId, okNew));
    if (!good) { log('mismatch', op, { playlistId: newId, attempts }); throw Object.assign(new Error(`read-back mismatch for new playlist ${newId} (${op.id}) after ${attempts} reads. Run stopped; undo deletes it.`), { summary: fin() }); }
    const itemIds = [];
    await insertItems(op, newId, pending.ts, op.items, itemIds);
    if (wantPublic(op)) await setPrivacy(op, newId, pending.ts);
    log('done', op, { of: pending.ts, playlistId: newId, itemIds, planned: op.after, verified: true, attempts });
    sum.done++;
  }

  for (const op of plan.ops) {
    if (only && !only.includes(op.id)) { sum.skipped++; continue; }
    if (op.kind === 'playlist-create') { if (await applyCreate(op) === 'stop') return fin(); continue; }
    if (canon(op.before) === canon(op.after)) { sum.skipped++; continue; }
    await s.ownChannelId(op.channel);
    const live = await readLive(s, op);
    const sent = partOf(op.kind, live); const state = stateOf(op.kind, live); const cur = fieldsOf(op.kind, state);
    if (Object.keys(op.after).every((k) => cur[k] === op.after[k])) { sum.alreadyApplied++; log('already-applied', op, { planned: op.after }); continue; }
    if (Object.keys(op.before).some((k) => cur[k] !== op.before[k])) { sum.stale++; continue; }
    if (s.units + 50 > s.maxUnits) { sum.stoppedReason = `stopped before writing ${op.kind} ${op.id}: the next write would pass maxUnits (${s.maxUnits}; ${s.units} used)`; return fin(); }
    log('pending', op, { before: state, planned: op.after });
    const merged = withFields(op.kind, sent, op.after); let v, resp;
    const titleOp = op.kind === 'channel' && 'title' in op.after; // a channel rename can be refused by YouTube; that must not strand the rest of the run
    const refuse = (error) => { sum.refused++; log('refused-by-youtube', op, { error, before: state, planned: op.after }); };
    const spec = putSpec(op.kind, op.kind === 'channel' ? live.id : op.id, merged, op.after);
    try { resp = await s.call('PUT', spec.url, op.channel, spec.body); }
    catch (e) { if (titleOp && renameRefusalContinues(e)) { refuse(String(e.message || e)); continue; } throw fail(op, e); }
    try { v = await verifyWrite(s, op, merged, op.after, live, resp); }
    catch (e) { throw fail(op, e); }
    if (!v.ok) {
      if (titleOp && v.diffs.length === 1 && v.diffs[0].startsWith('title:') && partOf('channel', v.live).channel?.title === op.before.title) { refuse(`YouTube kept the old title after ${v.attempts} reads`); continue; }
      log('mismatch', op, { differences: v.diffs, attempts: v.attempts, after: stateOf(op.kind, v.live) }); throw Object.assign(new Error(`read-back mismatch for ${op.kind} ${op.id} after ${v.attempts} reads: ${v.diffs.join('; ')}. Run stopped.`), { summary: fin() });
    }
    log('done', op, { before: state, after: stateOf(op.kind, v.live), planned: op.after, verified: true, attempts: v.attempts, via: v.via });
    sum.done++;
  }
  return fin();
}

// ---------------------------------------------------------------- undo
export async function undoLedger(ledgerFile, { only, maxUnits = 3000 } = {}, deps = {}) {
  const lines = readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // Every write attempt starts with a pending line, so every pending line is restorable (done, failed, mismatch or nothing after it),
  // unless a later undone line already points at it.
  const undone = new Set(lines.filter((l) => l.status === 'undone').map((l) => `${l.id}|${l.of}`));
  const todo = lines.filter((l) => l.status === 'pending' && !undone.has(`${l.id}|${l.ts}`) && (!only || only.includes(l.id))).reverse();
  const s = makeSession(deps, maxUnits); const out = deps.out || (() => {});
  const sum = { undone: 0, 'changed-since': 0, 'not-applied': 0, units: 0, ledger: ledgerFile, stoppedReason: null };
  // A created playlist may only be deleted when THIS ledger file recorded its id as created for exactly this attempt and channel.
  const createdIdOf = (e) => lines.find((l) => l.status === 'created' && l.kind === 'playlist-create' && l.of === e.ts && l.id === e.id && l.channel === e.channel && typeof l.playlistId === 'string' && l.playlistId)?.playlistId;
  const undoCreate = async (e) => {
    const playlistId = createdIdOf(e);
    if (!playlistId) { sum['not-applied']++; out(`playlist-create ${e.id}: nothing undone (this ledger has no created playlist id for it, so the insert response was never recorded). If the insert did go through, a playlist titled "${e.planned?.title}" may exist on the ${e.channel} channel: look and delete it by hand.`); return; }
    await s.ownChannelId(e.channel);
    const op = { kind: 'playlist', channel: e.channel, id: playlistId };
    let live; try { live = await readLive(s, op); } catch (err) { if (err.notFound) { sum['not-applied']++; out(`playlist-create ${e.id}: not-applied (playlist ${playlistId} is already gone, nothing written)`); return; } throw err; }
    if (live.snippet?.title !== e.planned?.title) { sum['changed-since']++; out(`skipped playlist-create ${e.id}: changed-since (playlist ${playlistId} no longer has the title this tool gave it, so it is not deleted)`); return; }
    const ours = new Set(lines.filter((l) => (l.status === 'item-created' || l.status === 'item-present') && l.playlistId === playlistId).map((l) => l.playlistItemId));
    const foreign = (await ownItems(s, e.channel, playlistId)).filter((i) => !ours.has(i.id));
    if (foreign.length) { sum['changed-since']++; out(`skipped playlist-create ${e.id}: changed-since (playlist ${playlistId} holds ${foreign.length} item(s) this ledger did not insert, so it is not deleted)`); return; }
    const pv = live.status?.privacyStatus;
    if (pv !== 'private' && pv !== e.planned?.privacyStatus) { sum['changed-since']++; out(`skipped playlist-create ${e.id}: changed-since (playlist ${playlistId} is "${pv}", neither private nor the planned "${e.planned?.privacyStatus}")`); return; }
    if (s.units + 50 > s.maxUnits) { sum.stoppedReason = `stopped before undoing playlist-create ${e.id}: the next write would pass maxUnits (${s.maxUnits})`; return 'stop'; }
    await s.call('DELETE', `${API}/playlists?${qs({ id: playlistId })}`, e.channel);
    const sleep = s.d.sleep || defaultSleep; let gone = false;
    for (let a = 1; a <= READ_ATTEMPTS && !gone; a++) { if (a > 1) await sleep(READ_GAP_MS); try { await readLive(s, op); } catch (err) { if (err.notFound) gone = true; else throw err; } }
    if (!gone) { ledgerAppend(ledgerFile, { ts: new Date().toISOString(), status: 'mismatch', kind: e.kind, channel: e.channel, id: e.id, of: e.ts, playlistId, differences: ['playlist still exists after delete'], attempts: READ_ATTEMPTS }); throw new Error(`undo: playlist ${playlistId} still exists after delete (${READ_ATTEMPTS} reads). Run stopped.`); }
    ledgerAppend(ledgerFile, { ts: new Date().toISOString(), status: 'undone', kind: e.kind, channel: e.channel, id: e.id, of: e.ts, playlistId, deleted: true, verified: true });
    sum.undone++;
  };
  for (const e of todo) {
    if (!ALLOWED[e.kind]) throw new Error(`undo refused: ledger line for ${e.id} has unknown kind "${e.kind}". Nothing written.`);
    if (e.kind === 'playlist-create') { if (await undoCreate(e) === 'stop') break; continue; }
    const op = { kind: e.kind, channel: e.channel, id: e.id };
    const keys = Object.keys(e.planned);
    for (const k of keys) if (!ALLOWED[e.kind].includes(k)) throw new Error(`undo refused: ledger line for ${e.kind} ${e.id} lists field "${k}", which is not writable (only ${ALLOWED[e.kind].join(', ')}). Nothing written.`);
    await s.ownChannelId(op.channel);
    const live = await readLive(s, op); const sent = partOf(op.kind, live); const cur = fieldsOf(op.kind, stateOf(op.kind, live));
    const bf = fieldsOf(op.kind, e.before);
    if (keys.every((k) => cur[k] === bf[k])) { sum['not-applied']++; out(`${e.kind} ${e.id}: not-applied (live text already equals the before text, nothing written)`); continue; }
    if (!keys.every((k) => cur[k] === e.planned[k])) { sum['changed-since']++; out(`skipped ${e.kind} ${e.id}: changed-since (live text equals neither the before text nor what this tool planned)`); continue; }
    if (s.units + 50 > s.maxUnits) { sum.stoppedReason = `stopped before undoing ${e.kind} ${e.id}: the next write would pass maxUnits (${s.maxUnits})`; break; }
    const restore = {}; for (const k of keys) { if (k === 'privacyStatus' && bf[k] === undefined) throw new Error(`undo refused: ledger line for ${e.kind} ${e.id} has no before value for "${k}". Nothing written.`); restore[k] = bf[k]; }
    const merged = withFields(op.kind, sent, restore);
    const spec = putSpec(op.kind, op.kind === 'channel' ? live.id : op.id, merged, restore);
    const resp = await s.call('PUT', spec.url, op.channel, spec.body);
    const v = await verifyWrite(s, op, merged, restore, live, resp);
    if (!v.ok) { ledgerAppend(ledgerFile, { ts: new Date().toISOString(), status: 'mismatch', kind: e.kind, channel: e.channel, id: e.id, of: e.ts, differences: v.diffs, attempts: v.attempts }); throw new Error(`undo read-back mismatch for ${e.kind} ${e.id} after ${v.attempts} reads: ${v.diffs.join('; ')}. Run stopped.`); }
    const after = v.live;
    ledgerAppend(ledgerFile, { ts: new Date().toISOString(), status: 'undone', kind: e.kind, channel: e.channel, id: e.id, of: e.ts, after: stateOf(op.kind, after), verified: true });
    sum.undone++;
  }
  sum.units = s.units; return sum;
}

// ---------------------------------------------------------------- CLI
const USAGE = 'usage: node youtube-channel-edit.js plan --out <dir> [--decisions <file.json>]   (with --decisions the plan is built ONLY from that file; the text rules are not run)\n       node youtube-channel-edit.js apply --plan <plan.json> --ledger <dir> [--only id1,id2] [--max-units N]\n       node youtube-channel-edit.js undo --ledger <file> [--only id]';
export async function main(argv, deps = {}) {
  const out = deps.out || ((s) => console.log(s)); const err = deps.err || ((s) => console.error(s));
  const [cmd, ...rest] = argv;
  const val = (f) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };
  if (!['plan', 'apply', 'undo'].includes(cmd)) { err(USAGE); return 2; }
  try {
    if (cmd === 'plan') {
      const dir = val('--out'); if (!dir) { err(USAGE); return 2; }
      const df = val('--decisions'); if (rest.includes('--decisions') && !df) { err(USAGE); return 2; }
      let decisions; // read and parsed BEFORE any network call
      if (df) { try { decisions = JSON.parse(readFileSync(df, 'utf8')); } catch (e) { throw new Error(`decisions refused: cannot read ${df} as JSON (${e.message})`); } }
      const plan = await buildPlan(df ? { ...deps, decisions } : deps); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan, null, 2)); writeFileSync(join(dir, 'plan.md'), planMarkdown(plan));
      out(`plan: ${plan.ops.length} ops (${plan.ops.filter((o) => o.warnings?.length).length} with warnings) written to ${join(dir, 'plan.json')} and plan.md${plan.source === 'decisions' ? `; ${plan.skipped.length} dropped with a note (${[...new Set(plan.skipped.map((o) => o.reason))].join(', ') || 'none'})` : ''}`); return 0;
    }
    if (cmd === 'apply') {
      const pf = val('--plan'), ledgerDir = val('--ledger'); if (!pf || !ledgerDir) { err(USAGE); return 2; }
      const only = val('--only')?.split(',').filter(Boolean); const mu = val('--max-units');
      const r = await applyPlan(JSON.parse(readFileSync(pf, 'utf8')), { only, ledgerDir, ...(mu ? { maxUnits: Number(mu) } : {}) }, { ...deps, out });
      out(`done ${r.done} / already-applied ${r.alreadyApplied} / stale ${r.stale} / skipped ${r.skipped} / failed ${r.failed}${r.refused ? ` / refused-by-youtube ${r.refused}` : ''}; units ${r.units}; ledger ${r.ledger}${r.stoppedReason ? `\n${r.stoppedReason}` : ''}`); return 0;
    }
    const lf = val('--ledger'); if (!lf) { err(USAGE); return 2; }
    const r = await undoLedger(lf, { only: val('--only')?.split(',').filter(Boolean) }, { ...deps, out });
    out(`undone ${r.undone} / not-applied ${r['not-applied']} / changed-since ${r['changed-since']}; units ${r.units}; ledger ${r.ledger}${r.stoppedReason ? `\n${r.stoppedReason}` : ''}`); return 0;
  } catch (e) { err(`error: ${e.message}`); if (e.summary) err(`so far: done ${e.summary.done} / stale ${e.summary.stale} / failed ${e.summary.failed}; ledger ${e.summary.ledger}`); return 1; }
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
