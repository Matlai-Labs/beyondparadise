// bpa-social library: queue, BPI reading, drafting, voice gate, scheduling, publishing, WhatsApp.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const HERE = path.dirname(new URL(import.meta.url).pathname);
export const CONFIG = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
export const QUEUE_PATH = path.join(HERE, 'queue.json');
export const LOG_PATH = path.join(os.homedir(), 'Library', 'Logs', 'beyondparadise', 'social.log');
const VOICE_LINT = '/Users/tim/Desktop/AI_projects/shared_knowledge/scripts/voice-lint/voice-lint.mjs';
const META_PUBLISH = '/Users/tim/Desktop/AI_projects/shared_knowledge/scripts/meta-pages/publish.js';
const WA_TO = process.env.WHATSAPP_ALERT_TO || '+255772628833';
const BRIDGE = process.env.WHATSAPP_BRIDGE_URL || 'http://127.0.0.1:3002';

export function log(msg) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  try { if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 5e6) fs.renameSync(LOG_PATH, LOG_PATH + '.1'); } catch {}
  const line = `${new Date().toISOString()} ${msg}`; fs.appendFileSync(LOG_PATH, line + '\n'); if (process.env.BPA_QUIET !== '1') console.log(line);
}

// ── queue (JSON file, atomic write) ─────────────────────────────────────────
export function loadQueue(p = QUEUE_PATH) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { seq: 0, drafts: [] }; } }
export function saveQueue(q, p = QUEUE_PATH) { const tmp = p + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(q, null, 2)); fs.renameSync(tmp, p); }
export function nextId(q) { q.seq = (q.seq || 0) + 1; return `B${q.seq}`; }
export const STATUS = { PENDING: 'pending_approval', SCHEDULED: 'scheduled', POSTED: 'posted', SKIPPED: 'skipped', EXPIRED: 'expired', FAILED: 'failed' };

// ── BPI input ───────────────────────────────────────────────────────────────
export function readBriefs(dir = CONFIG.bpiOutDir, lookbackDays = CONFIG.lookbackDays, now = new Date()) {
  if (!fs.existsSync(dir)) return [];
  const cutoff = new Date(now.getTime() - lookbackDays * 86400e3).toISOString().slice(0, 10);
  return fs.readdirSync(dir).filter((f) => /^brief-\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(6, 16) >= cutoff).sort()
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } }).filter(Boolean);
}
export function pickItems(briefs, max = CONFIG.maxDraftsPerWeek) {
  const seen = new Map();
  for (const b of briefs) for (const it of b.items || []) {
    const id = it.signal?.id || `${b.date}:${it.signal?.subject}`; if (seen.has(id)) continue;
    seen.set(id, { ...it, date: b.date });
  }
  const score = (it) => (it.confidence ?? it.signal?.confidence ?? 0) * (Math.abs(it.signal?.magnitude ?? 1) || 1);
  return [...seen.values()].sort((a, b) => score(b) - score(a)).slice(0, max);
}
export function latestForecasts(briefs) { const b = briefs[briefs.length - 1]; return b ? { date: b.date, forecasts: b.forecasts || [] } : null; }

// ── drafting (deterministic, $0; the prose was already synthesized by BPI) ─────
const REGION_NAME = { zanzibar: 'Zanzibar', 'dar-es-salaam': 'Dar es Salaam' };
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
function hashtags(region) { const h = [...CONFIG.hashtags.always, ...(CONFIG.hashtags.byRegion[region] || [])]; return [...new Set(h)].slice(0, CONFIG.hashtags.max).join(' '); }
function longDate(iso) { return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); }
export function draftFromItem(it) {
  const region = it.signal?.region || 'zanzibar'; const where = REGION_NAME[region] || region;
  const lines = [
    `${clean(it.signal?.subject) || 'Tourism signal'} — ${where}, ${longDate(it.date)}`,
    '',
    `What changed: ${clean(it.signal?.summary)}`,
    `Why it matters: ${clean(it.whyItMatters)}`,
    `What I'd do: ${clean(it.whatToDo)}`,
    '',
    `Confidence ${Math.round((it.confidence ?? it.signal?.confidence ?? 0) * 100)}% from ${(it.sources || []).length || (it.signal?.sourceIds || []).length} independent sources. I publish only what clears the bar.`,
    `— ${CONFIG.author}, ${CONFIG.brand}`,
    '',
    hashtags(region),
  ];
  return { kind: 'signal', region, text: lines.join('\n'), sourceDate: it.date, sourceId: it.signal?.id || null };
}
export function draftFromForecast(fc) {
  if (!fc || !fc.forecasts?.length) return null;
  const parts = fc.forecasts.map((f) => {
    const where = REGION_NAME[f.region] || f.region; const dir = f.direction || f.outlook || 'steady';
    const conf = Math.round((f.confidence ?? 0) * 100); const drivers = (f.drivers || []).map((x) => clean(x).replace(/[.;]+$/, '')).filter(Boolean).slice(0, 2);
    return `${where}: ${dir}${conf ? ` (${conf}% confidence)` : ''}${drivers.length ? ` — ${drivers.join('; ')}` : ''}`;
  });
  const text = [
    `Demand outlook, next 8 weeks — ${longDate(fc.date)}`,
    '',
    ...parts,
    '',
    `This is what my intelligence engine reads from public data every morning. When the numbers move, I say so; when they don't, I say nothing.`,
    `— ${CONFIG.author}, ${CONFIG.brand}`,
    '',
    hashtags('zanzibar'),
  ].join('\n');
  return { kind: 'outlook', region: 'all', text, sourceDate: fc.date, sourceId: `outlook:${fc.date}` };
}
export function brandGuard(text) {
  if (/\bBeyond Paradise(?! Adventures)\b/.test(text)) return 'brand must be written in full: "Beyond Paradise Adventures"';
  if (!CONFIG.includeLinks && /https?:\/\//i.test(text)) return 'links are disabled until the site is live';
  if (text.length > 2000) return 'too long (>2000 chars)';
  return null;
}
export async function voiceGate(text) {
  const mod = await import(VOICE_LINT).catch(() => null);
  if (!mod?.lint) return { ok: false, reason: 'voice-lint unavailable (fail closed)' };
  const res = mod.lint(text); return { ok: !!res.ok, reason: res.ok ? null : JSON.stringify(res).slice(0, 300) };
}
export function outlookSignature(fc) {
  if (!fc) return null;
  return (fc.forecasts || []).map((f) => `${f.region}:${f.direction || f.outlook}:${(f.drivers || []).map((x) => clean(x).toLowerCase()).join('|')}`).sort().join(';');
}
export function outlookIsFresh(fc, existingDrafts, now = new Date(), minDays = 14) {
  const sig = outlookSignature(fc); if (!sig) return false;
  const prev = existingDrafts.filter((d) => d.kind === 'outlook');
  if (prev.some((d) => d.signature === sig)) return false; // same content already drafted (any status)
  const last = prev.map((d) => new Date(d.createdAt || 0).getTime()).sort().pop() || 0;
  return now.getTime() - last >= minDays * 86400e3;
}
export async function buildDrafts({ briefs, now = new Date(), existingDrafts = [] }) {
  const items = pickItems(briefs); const drafts = items.map(draftFromItem);
  if (drafts.length < CONFIG.maxDraftsPerWeek) { const lf = latestForecasts(briefs); const fc = draftFromForecast(lf); if (fc && outlookIsFresh(lf, existingDrafts, now)) drafts.push({ ...fc, signature: outlookSignature(lf) }); }
  const out = [];
  for (const d of drafts) {
    const bad = brandGuard(d.text); if (bad) { out.push({ ...d, rejected: bad }); continue; }
    const v = await voiceGate(d.text); if (!v.ok) { out.push({ ...d, rejected: 'voice-lint: ' + v.reason }); continue; }
    out.push({ ...d, createdAt: now.toISOString() });
  }
  return out;
}

// ── scheduling slots (one post per day at postHourLocal, skipping taken days) ──
export function nextSlots(q, count, now = new Date()) {
  const taken = new Set(q.drafts.filter((d) => d.status === STATUS.SCHEDULED && d.scheduledFor).map((d) => d.scheduledFor.slice(0, 10)));
  const slots = []; let day = new Date(now.getTime() + 86400e3);
  while (slots.length < count) {
    const ymd = day.toISOString().slice(0, 10);
    if (!taken.has(ymd)) { slots.push(`${ymd}T${String(CONFIG.postHourLocal).padStart(2, '0')}:00:00+03:00`); taken.add(ymd); }
    day = new Date(day.getTime() + 86400e3);
  }
  return slots;
}

// ── publishing (meta-pages) + WhatsApp ─────────────────────────────────────
export async function schedulePost(text, at) { const { createPost } = require(META_PUBLISH); return createPost(CONFIG.page, { message: text, at }); }
export async function publishNow(text) { const { createPost } = require(META_PUBLISH); return createPost(CONFIG.page, { message: text }); }
export async function postStatus(postId) { const { findPage } = require(META_PUBLISH); const p = findPage(CONFIG.page); const r = await fetch(`https://graph.facebook.com/v21.0/${postId}?fields=id,is_published,permalink_url,scheduled_publish_time&access_token=${p.token}`); return r.json(); }
export async function whatsapp(text) {
  try {
    const s = await fetch(`${BRIDGE}/status`, { signal: AbortSignal.timeout(2000) }); if (!(await s.json()).ready) { log('bridge not ready'); return false; }
    const r = await fetch(`${BRIDGE}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: WA_TO, text }), signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({})); if (!r.ok || j.ok === false) { log(`whatsapp failed ${r.status} ${j.error || ''}`); return false; }
    return true;
  } catch (e) { log(`whatsapp error ${e.message}`); return false; }
}

// ── command parsing for the `bpa` WhatsApp family ──────────────────────────
export function parseCommand(text) {
  const t = String(text || '').trim().replace(/^bpa\s*/i, '').trim();
  if (!t || /^list$/i.test(t)) return { cmd: 'list' };
  if (/^status$/i.test(t)) return { cmd: 'status' };
  if (/^help$/i.test(t)) return { cmd: 'help' };
  let m;
  if ((m = t.match(/^approve\s+((?:b\d+[\s,]*)+)$/i))) return { cmd: 'approve', ids: m[1].toUpperCase().match(/B\d+/g) };
  if ((m = t.match(/^skip\s+((?:b\d+[\s,]*)+)$/i))) return { cmd: 'skip', ids: m[1].toUpperCase().match(/B\d+/g) };
  if ((m = t.match(/^post\s+(b\d+)\s+now$/i))) return { cmd: 'postnow', ids: [m[1].toUpperCase()] };
  if ((m = t.match(/^edit\s+(b\d+)\s*:\s*([\s\S]+)$/i))) return { cmd: 'edit', ids: [m[1].toUpperCase()], text: m[2].trim() };
  return { cmd: 'unknown', raw: t };
}
export function renderList(q) {
  const pend = q.drafts.filter((d) => d.status === STATUS.PENDING);
  if (!pend.length) return '📭 No drafts waiting. Next drafting run: Monday 07:00.';
  const lines = [`📝 ${pend.length} draft(s) for ${CONFIG.page}:`];
  for (const d of pend) lines.push(`\n*${d.id}* (${d.kind}, ${d.sourceDate})\n${d.text.slice(0, 700)}${d.text.length > 700 ? '…' : ''}`);
  lines.push('\nReply: *bpa approve B1 B2* · *bpa skip B3* · *bpa edit B1: new text* · *bpa post B1 now*');
  return lines.join('\n');
}

// ── Instagram: branded card → hosted image → container → publish ─────────────
import { execFileSync } from 'node:child_process';
export function igEnabled() {
  if (!CONFIG.instagram?.enabled) return false;
  try { const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/meta-pages/tokens.json'), 'utf8')); return (s.user?.scopes || []).includes('instagram_content_publish') || !!s.user?.igPublishOk; } catch { return false; }
}
export function cardSpec(d) {
  const first = d.text.split('\n')[0]; const [headline, rest] = first.split(' — ');
  const body = d.text.split('\n').slice(2).filter((l) => l && !l.startsWith('—') && !l.startsWith('#') && !/^Confidence /.test(l) && !/^This is what/.test(l)).map((l) => l.replace(/^(What changed|Why it matters|What I'd do): /, (m) => m)).slice(0, 3);
  return { label: d.kind === 'outlook' ? 'Demand outlook · next 8 weeks' : 'What changed', headline: headline.trim(), tag: d.region === 'all' ? 'Zanzibar & Dar es Salaam' : (d.region === 'zanzibar' ? 'Zanzibar' : 'Dar es Salaam'), date: (rest || d.sourceDate || '').trim(), lines: body, brand: CONFIG.brand };
}
export function renderCard(d, outDir = path.join(HERE, 'cards')) {
  fs.mkdirSync(outDir, { recursive: true }); const spec = path.join(outDir, `${d.id}.json`); const png = path.join(outDir, `${d.id}.png`);
  fs.writeFileSync(spec, JSON.stringify(cardSpec(d))); execFileSync('python3', [path.join(HERE, 'card.py'), spec, png], { stdio: 'pipe' }); return png;
}
function wpCreds() {
  const env = {}; for (const line of fs.readFileSync('/Users/tim/Desktop/AI_projects/Padel_Revive/.env', 'utf8').split('\n')) { const m = line.trim().match(/^(WP_[A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, ''); }
  return { base: env.WP_BASE_URL.replace(/\/$/, ''), auth: 'Basic ' + Buffer.from(`${env.WP_USERNAME}:${env.WP_APP_PASSWORD}`).toString('base64') };
}
export async function hostImage(pngPath, name) {
  const { base, auth } = wpCreds(); const buf = fs.readFileSync(pngPath);
  const r = await fetch(`${base}/wp-json/wp/v2/media`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'image/png', 'Content-Disposition': `attachment; filename="${name}.png"` }, body: buf, signal: AbortSignal.timeout(60000) });
  const j = await r.json(); if (!r.ok) throw new Error(`media upload ${r.status}: ${JSON.stringify(j).slice(0, 160)}`); return { id: j.id, url: j.source_url };
}
export async function igPublish(caption, imageUrl, { dryContainerOnly = false } = {}) {
  const { findPage } = require(META_PUBLISH); const p = findPage(CONFIG.page); const ig = CONFIG.instagram.igUserId; const V = 'v21.0';
  const call = async (pth, params) => { const r = await fetch(`https://graph.facebook.com/${V}/${pth}`, { method: 'POST', body: new URLSearchParams({ ...params, access_token: p.token }), signal: AbortSignal.timeout(60000) }); const j = await r.json(); if (j.error) throw new Error(`${pth}: ${j.error.message}`); return j; };
  const c = await call(`${ig}/media`, { image_url: imageUrl, caption: caption.slice(0, 2200) });
  for (let i = 0; i < 20; i++) { const s = await (await fetch(`https://graph.facebook.com/${V}/${c.id}?fields=status_code,status&access_token=${p.token}`)).json(); if (s.status_code === 'FINISHED') break; if (s.status_code === 'ERROR') throw new Error(`container error: ${s.status}`); await new Promise((r) => setTimeout(r, 3000)); }
  if (dryContainerOnly) return { containerId: c.id, published: false };
  const pub = await call(`${ig}/media_publish`, { creation_id: c.id });
  const info = await (await fetch(`https://graph.facebook.com/${V}/${pub.id}?fields=id,permalink&access_token=${p.token}`)).json();
  return { id: pub.id, permalink: info.permalink, published: true };
}
export async function igPostDraft(d) {
  const png = renderCard(d); const hosted = await hostImage(png, `bpa-${d.id}-${d.sourceDate}`);
  const r = await igPublish(d.text, hosted.url); return { ...r, imageUrl: hosted.url, mediaId: hosted.id };
}
