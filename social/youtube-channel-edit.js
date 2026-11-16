#!/usr/bin/env node
// Text clean-up + guarded write tool for the two Beyond Paradise Adventures YouTube channels.
// - Pure text functions (fixDescription, fixPlaylistDescription, keywordsString): no I/O.
// - buildPlan / `plan`: reads the live channels (GET only) and writes a plan. Nothing is written to YouTube.
// - applyPlan / `apply`: the ONLY code path that writes. Guarded: channel check, stale check, field whitelist,
//   ledger line BEFORE each write, full-part PUT, read-back verification, quota cap, Google-hosts-only.
// - undoLedger / `undo`: restores the "before" values from a ledger file, same guards.
// Node built-ins only. Sign-in files and client values live outside the repo (see youtube-channel.js); never printed.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, chmodSync, existsSync } from 'node:fs';
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
    if (!r.ok) throw new Error(`HTTP ${r.status} ${j?.error?.message || j?.error || ''} (${new URL(url).pathname})`.trim());
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
const ALLOWED = { video: ['description', 'categoryId'], playlist: ['description'], channel: ['description', 'keywords'] };
const clone = (o) => JSON.parse(JSON.stringify(o));
function partOf(kind, live) {
  if (kind === 'channel') return clone(live.brandingSettings || {});
  const sn = live.snippet || {}; const p = {};
  for (const k of SNIPPET_KEYS[kind]) if (k in sn) p[k] = clone(sn[k]);
  return p;
}
function fieldsOf(kind, part) {
  if (kind === 'channel') return { description: part.channel?.description ?? '', keywords: part.channel?.keywords ?? '' };
  return { description: part.description ?? '', categoryId: part.categoryId };
}
function withFields(kind, part, fields) {
  const p = clone(part);
  if (kind === 'channel') p.channel = { ...(p.channel || {}), ...fields }; else Object.assign(p, fields);
  return p;
}
const bodyOf = (kind, id, part) => (kind === 'channel' ? { id, brandingSettings: part } : { id, snippet: part });
const putUrl = (kind) => (kind === 'channel' ? `${API}/channels?part=brandingSettings` : `${API}/${kind}s?part=snippet`);
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
  if (!it) throw new Error(`${kind} ${id} not found on channel ${channel}`);
  if (it.snippet?.channelId !== CHANNELS[channel].id) throw new Error(`channel guard: ${kind} ${id} belongs to channel ${it.snippet?.channelId}, expected ${CHANNELS[channel].id}. Nothing written.`);
  return it;
}
function differences(kind, sent, changed, prevLive, newLive) {
  const out = []; const np = partOf(kind, newLive); const nf = fieldsOf(kind, np);
  const cmp = (label, a, b) => { if (canon(a) !== canon(b)) out.push(`${label}: expected ${trunc(a)}, got ${trunc(b)}`); };
  for (const k of Object.keys(changed)) cmp(k, changed[k], nf[k]);
  if (kind === 'channel') {
    for (const k of Object.keys(sent)) if (k !== 'channel') cmp(`brandingSettings.${k}`, sent[k], np[k]);
    for (const k of Object.keys(sent.channel || {})) if (!(k in changed)) cmp(`brandingSettings.channel.${k}`, sent.channel[k], np.channel?.[k]);
  } else {
    for (const k of Object.keys(sent)) if (!(k in changed)) cmp(k, sent[k], np[k]);
    cmp('status.privacyStatus', prevLive.status?.privacyStatus, newLive.status?.privacyStatus);
  }
  return out;
}

// Verify a write. YouTube's read right after a write can lag, so: (1) check the PUT response body, (2) read back up to 6 times, 5 s apart.
const READ_ATTEMPTS = 6, READ_GAP_MS = 5000;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function verifyWrite(s, op, merged, changed, prevLive, putResp) {
  const sleep = s.d.sleep || defaultSleep;
  const part = op.kind === 'channel' ? putResp?.brandingSettings : putResp?.snippet;
  if (part && typeof part === 'object') {
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

function validateOp(op) {
  if (!op || !ALLOWED[op.kind]) throw new Error(`plan refused: unknown op kind "${op?.kind}"`);
  if (!CHANNELS[op.channel]) throw new Error(`plan refused: unknown channel "${op.channel}"`);
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
}

// ---------------------------------------------------------------- ledger
const dayOf = (d) => (d.now || new Date()).toISOString().slice(0, 10);
function ledgerAppend(file, line) {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  appendFileSync(file, JSON.stringify(line) + '\n', { mode: 0o600 }); chmodSync(file, 0o600);
}

// ---------------------------------------------------------------- plan
export async function buildPlan(deps = {}) {
  const s = makeSession(deps); const d = s.d;
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
  const sk = plan.skipped || [];
  if (sk.length) { md.push(`## skipped: private (${sk.length})`, ...sk.map((o) => `- ${o.kind} ${o.channel} ${o.id} — ${o.title}`), ''); }
  for (const o of plan.ops) {
    md.push(`## ${o.kind} ${o.channel} ${o.id} — ${o.title}`, '```diff');
    for (const k of Object.keys(o.after)) md.push(...(o.before[k] === o.after[k] ? [] : lineDiff(`${k === 'description' ? '' : k + ': '}${o.before[k] ?? ''}`.replace(/^(?=.)/, ''), `${k === 'description' ? '' : k + ': '}${o.after[k] ?? ''}`)));
    md.push('```');
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
  const sum = { done: 0, stale: 0, alreadyApplied: 0, skipped: 0, failed: 0, units: 0, ledger: file, stoppedReason: null };
  const fin = () => { sum.units = s.units; return sum; };
  const log = (status, op, extra) => ledgerAppend(file, { ts: new Date().toISOString(), status, kind: op.kind, channel: op.channel, id: op.id, ...extra });
  for (const op of plan.ops) {
    if (only && !only.includes(op.id)) { sum.skipped++; continue; }
    if (canon(op.before) === canon(op.after)) { sum.skipped++; continue; }
    await s.ownChannelId(op.channel);
    const live = await readLive(s, op);
    const sent = partOf(op.kind, live); const cur = fieldsOf(op.kind, sent);
    if (Object.keys(op.after).every((k) => cur[k] === op.after[k])) { sum.alreadyApplied++; log('already-applied', op, { planned: op.after }); continue; }
    if (Object.keys(op.before).some((k) => cur[k] !== op.before[k])) { sum.stale++; continue; }
    if (s.units + 50 > s.maxUnits) { sum.stoppedReason = `stopped before writing ${op.kind} ${op.id}: the next write would pass maxUnits (${s.maxUnits}; ${s.units} used)`; return fin(); }
    log('pending', op, { before: sent, planned: op.after });
    const merged = withFields(op.kind, sent, op.after); let v;
    try {
      const resp = await s.call('PUT', putUrl(op.kind), op.channel, bodyOf(op.kind, op.kind === 'channel' ? live.id : op.id, merged));
      v = await verifyWrite(s, op, merged, op.after, live, resp);
    } catch (e) { sum.failed++; log('failed', op, { error: String(e.message || e) }); throw Object.assign(e, { summary: fin() }); }
    if (!v.ok) { log('mismatch', op, { differences: v.diffs, attempts: v.attempts, after: partOf(op.kind, v.live) }); throw Object.assign(new Error(`read-back mismatch for ${op.kind} ${op.id} after ${v.attempts} reads: ${v.diffs.join('; ')}. Run stopped.`), { summary: fin() }); }
    log('done', op, { before: sent, after: partOf(op.kind, v.live), planned: op.after, verified: true, attempts: v.attempts, via: v.via });
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
  for (const e of todo) {
    const op = { kind: e.kind, channel: e.channel, id: e.id };
    await s.ownChannelId(op.channel);
    const live = await readLive(s, op); const sent = partOf(op.kind, live); const cur = fieldsOf(op.kind, sent);
    const keys = Object.keys(e.planned); const bf = fieldsOf(op.kind, e.before);
    if (keys.every((k) => cur[k] === bf[k])) { sum['not-applied']++; out(`${e.kind} ${e.id}: not-applied (live text already equals the before text, nothing written)`); continue; }
    if (!keys.every((k) => cur[k] === e.planned[k])) { sum['changed-since']++; out(`skipped ${e.kind} ${e.id}: changed-since (live text equals neither the before text nor what this tool planned)`); continue; }
    if (s.units + 50 > s.maxUnits) { sum.stoppedReason = `stopped before undoing ${e.kind} ${e.id}: the next write would pass maxUnits (${s.maxUnits})`; break; }
    const restore = {}; for (const k of keys) restore[k] = bf[k];
    const merged = withFields(op.kind, sent, restore);
    const resp = await s.call('PUT', putUrl(op.kind), op.channel, bodyOf(op.kind, op.kind === 'channel' ? live.id : op.id, merged));
    const v = await verifyWrite(s, op, merged, restore, live, resp);
    if (!v.ok) { ledgerAppend(ledgerFile, { ts: new Date().toISOString(), status: 'mismatch', kind: e.kind, channel: e.channel, id: e.id, of: e.ts, differences: v.diffs, attempts: v.attempts }); throw new Error(`undo read-back mismatch for ${e.kind} ${e.id} after ${v.attempts} reads: ${v.diffs.join('; ')}. Run stopped.`); }
    const after = v.live;
    ledgerAppend(ledgerFile, { ts: new Date().toISOString(), status: 'undone', kind: e.kind, channel: e.channel, id: e.id, of: e.ts, after: partOf(op.kind, after), verified: true });
    sum.undone++;
  }
  sum.units = s.units; return sum;
}

// ---------------------------------------------------------------- CLI
const USAGE = 'usage: node youtube-channel-edit.js plan --out <dir>\n       node youtube-channel-edit.js apply --plan <plan.json> --ledger <dir> [--only id1,id2] [--max-units N]\n       node youtube-channel-edit.js undo --ledger <file> [--only id]';
export async function main(argv, deps = {}) {
  const out = deps.out || ((s) => console.log(s)); const err = deps.err || ((s) => console.error(s));
  const [cmd, ...rest] = argv;
  const val = (f) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };
  if (!['plan', 'apply', 'undo'].includes(cmd)) { err(USAGE); return 2; }
  try {
    if (cmd === 'plan') {
      const dir = val('--out'); if (!dir) { err(USAGE); return 2; }
      const plan = await buildPlan(deps); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan, null, 2)); writeFileSync(join(dir, 'plan.md'), planMarkdown(plan));
      out(`plan: ${plan.ops.length} ops (${plan.ops.filter((o) => o.warnings?.length).length} with warnings) written to ${join(dir, 'plan.json')} and plan.md`); return 0;
    }
    if (cmd === 'apply') {
      const pf = val('--plan'), ledgerDir = val('--ledger'); if (!pf || !ledgerDir) { err(USAGE); return 2; }
      const only = val('--only')?.split(',').filter(Boolean); const mu = val('--max-units');
      const r = await applyPlan(JSON.parse(readFileSync(pf, 'utf8')), { only, ledgerDir, ...(mu ? { maxUnits: Number(mu) } : {}) }, { ...deps, out });
      out(`done ${r.done} / already-applied ${r.alreadyApplied} / stale ${r.stale} / skipped ${r.skipped} / failed ${r.failed}; units ${r.units}; ledger ${r.ledger}${r.stoppedReason ? `\n${r.stoppedReason}` : ''}`); return 0;
    }
    const lf = val('--ledger'); if (!lf) { err(USAGE); return 2; }
    const r = await undoLedger(lf, { only: val('--only')?.split(',').filter(Boolean) }, { ...deps, out });
    out(`undone ${r.undone} / not-applied ${r['not-applied']} / changed-since ${r['changed-since']}; units ${r.units}; ledger ${r.ledger}${r.stoppedReason ? `\n${r.stoppedReason}` : ''}`); return 0;
  } catch (e) { err(`error: ${e.message}`); if (e.summary) err(`so far: done ${e.summary.done} / stale ${e.summary.stale} / failed ${e.summary.failed}; ledger ${e.summary.ledger}`); return 1; }
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
