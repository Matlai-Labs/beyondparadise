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
export async function buildDrafts({ briefs, now = new Date() }) {
  const items = pickItems(briefs); const drafts = items.map(draftFromItem);
  if (drafts.length < CONFIG.maxDraftsPerWeek) { const fc = draftFromForecast(latestForecasts(briefs)); if (fc) drafts.push(fc); }
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
