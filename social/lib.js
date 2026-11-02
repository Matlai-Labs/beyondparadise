// bpa-social library: queue, BPI reading, drafting, voice gate, scheduling, publishing, WhatsApp.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { scoreDraft, renderScore } from './score.js';
import { modulePath, resourcePath, requireResource, graphCall } from './resources.js';
const require = createRequire(import.meta.url);
const HERE = path.dirname(modulePath(import.meta.url));
export const CONFIG = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
export const QUEUE_PATH = path.join(HERE, 'queue.json');
export const LOG_PATH = path.join(os.homedir(), 'Library', 'Logs', 'beyondparadise', 'social.log');
const BRIDGE = process.env.WHATSAPP_BRIDGE_URL || 'http://127.0.0.1:3002';
/** meta-pages is loaded lazily: it is outside this repo and only needed when actually publishing. */
const metaPublish = () => require(requireResource('metaPublish'));

export function log(msg) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  try { if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 5e6) fs.renameSync(LOG_PATH, LOG_PATH + '.1'); } catch {}
  const line = `${new Date().toISOString()} ${msg}`; fs.appendFileSync(LOG_PATH, line + '\n'); if (process.env.BPA_QUIET !== '1') console.log(line);
}

// ── queue (JSON file, atomic write) ─────────────────────────────────────────
export function loadQueue(p = QUEUE_PATH) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { seq: 0, drafts: [] }; } }
export function saveQueue(q, p = QUEUE_PATH) { const tmp = p + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(q, null, 2)); fs.renameSync(tmp, p); }

// ── queue lock + three-way merge (worker and approval server share queue.json) ──
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
export async function withQueueLock(fn, { lockPath = QUEUE_PATH + '.lock', staleMs = 20 * 60e3, timeoutMs = 5 * 60e3, pollMs = 25 } = {}) {
  const start = Date.now(); const token = `${process.pid}-${randomUUID()}`;
  for (;;) {
    try { const fd = fs.openSync(lockPath, 'wx'); try { fs.writeSync(fd, token); } finally { fs.closeSync(fd); } break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      breakStaleLock(lockPath, staleMs, token);
      if (Date.now() - start > timeoutMs) throw new Error('queue lock timeout');
      await sleepMs(pollMs);
    }
  }
  try { return await fn(); }
  finally { try { if (fs.readFileSync(lockPath, 'utf8') === token) fs.unlinkSync(lockPath); } catch {} } // release only our own lock
}
// Stale break via atomic rename: only one waiter can move the lock away. If what we moved turns
// out to be fresh (someone re-took the lock between our stat and rename), put it back.
function breakStaleLock(lockPath, staleMs, token) {
  let st; try { st = fs.statSync(lockPath); } catch { return; }
  if (Date.now() - st.mtimeMs <= staleMs) return;
  const moved = `${lockPath}.stale.${token}`;
  try { fs.renameSync(lockPath, moved); } catch { return; } // another waiter won the break
  try { if (Date.now() - fs.statSync(moved).mtimeMs <= staleMs) { try { fs.linkSync(moved, lockPath); } catch {} } } catch {}
  try { fs.unlinkSync(moved); } catch {}
}
/** Apply what `mine` changed relative to `base` onto `fresh` (the current file). On a field conflict the fresh (approval-server) value wins. */
export function mergeQueue(base, mine, fresh) {
  const j = JSON.stringify; const out = JSON.parse(j(fresh)); const byId = new Map(out.drafts.map((d) => [d.id, d]));
  const baseById = new Map((base.drafts || []).map((d) => [d.id, d])); const freshById = new Map(fresh.drafts.map((d) => [d.id, d]));
  for (const m of mine.drafts) {
    const b = baseById.get(m.id); const t = byId.get(m.id); const f = freshById.get(m.id);
    if (!b || !t) continue; // drafts are only created by draft.js; never resurrect a missing one
    for (const k of Object.keys(m)) {
      if (j(m[k]) === j(b[k])) continue; // worker did not touch this field
      if (j(f[k]) !== j(b[k])) continue; // someone else changed it meanwhile: theirs wins
      t[k] = m[k];
    }
  }
  const ms = mine.state || {}; const bs = base.state || {}; const fs_ = fresh.state || {}; out.state = out.state || {};
  for (const k of Object.keys(ms)) if (j(ms[k]) !== j(bs[k]) && j(fs_[k]) === j(bs[k])) out.state[k] = ms[k];
  return out;
}
/** Drafts stuck in IG 'publishing' for more than `minutes` that have NOT been alerted yet for THIS publish attempt (alert once, not every run; a re-claim re-arms it). */
export function stuckIgPublishes(q, now = new Date(), minutes = 30) {
  return q.drafts.filter((x) => x.ig?.status === 'publishing' && !(x.ig.stuckAlertedAt && new Date(x.ig.stuckAlertedAt) >= new Date(x.ig.publishingAt || 0)) && now.getTime() - new Date(x.ig.publishingAt || 0).getTime() > minutes * 60e3).map((x) => x.id);
}
/** Record that the stuck alert went out. Status stays 'publishing': a human checks Meta before any retry. */
export function markStuckAlerted(q, ids, now = new Date()) {
  for (const d of q.drafts) if (ids.includes(d.id) && d.ig) d.ig = { ...d.ig, stuckAlertedAt: now.toISOString() };
}
/** Atomically claim a queued IG publish: marks it 'publishing' on disk so an overlapping run or a crash cannot publish twice. */
export async function claimIgPublish(id, now = new Date(), p = QUEUE_PATH) {
  return withQueueLock(async () => {
    const q = loadQueue(p); const d = q.drafts.find((x) => x.id === id);
    if (!d || d.ig?.status !== 'queued') return null;
    d.ig = { ...d.ig, status: 'publishing', publishingAt: now.toISOString() }; saveQueue(q, p); return d.ig;
  }, { lockPath: p + '.lock' });
}
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
  return { kind: 'signal', region, text: lines.join('\n'), sourceDate: it.date, sourceId: it.signal?.id || null, sourceCount: (it.sources || []).length || (it.signal?.sourceIds || []).length };
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
/** CLAUDE.md rule: no number without >=2 independent sources. Signal drafts state a source count, so <2 is rejected. */
export function sourceGate(d) { return d.kind === 'signal' && !((d.sourceCount ?? 0) >= 2) ? 'fewer than 2 independent sources (>=2 required)' : null; }
export async function voiceGate(text) {
  const lintPath = resourcePath('voiceLint');
  const mod = await import(pathToFileURL(lintPath).href).catch(() => null);
  if (!mod?.lint) return { ok: false, reason: `voice-lint unavailable at ${lintPath} (fail closed; set VOICE_LINT_PATH)` };
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
    const bad = brandGuard(d.text) || sourceGate(d); if (bad) { out.push({ ...d, rejected: bad }); continue; }
    const v = await voiceGate(d.text); if (!v.ok) { out.push({ ...d, rejected: 'voice-lint: ' + v.reason }); continue; }
    out.push({ ...d, createdAt: now.toISOString() });
  }
  // advisory score (never blocks, never changes status); fail-open
  return out.map((d) => { try { return { ...d, score: scoreDraft(d) }; } catch { return d; } });
}

// ── scheduling slots (one post per day at postHourLocal, skipping taken days) ──
export function nextSlots(q, count, now = new Date(), tz = CONFIG.timezone) {
  const taken = new Set(q.drafts.filter((d) => d.status === STATUS.SCHEDULED && d.scheduledFor).map((d) => d.scheduledFor.slice(0, 10)));
  const slots = []; const localToday = now.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD in the slot timezone, not UTC
  let day = new Date(localToday + 'T00:00:00Z'); day = new Date(day.getTime() + 86400e3);
  while (slots.length < count) {
    const ymd = day.toISOString().slice(0, 10);
    if (!taken.has(ymd)) { slots.push(`${ymd}T${String(CONFIG.postHourLocal).padStart(2, '0')}:00:00+03:00`); taken.add(ymd); }
    day = new Date(day.getTime() + 86400e3);
  }
  return slots;
}

// ── publishing (meta-pages) + WhatsApp ─────────────────────────────────────
export async function schedulePost(text, at) { const { createPost } = metaPublish(); return createPost(CONFIG.page, { message: text, at }); }
export async function publishNow(text) { const { createPost } = metaPublish(); return createPost(CONFIG.page, { message: text }); }
export async function postStatus(postId) {
  const { findPage } = metaPublish(); const p = findPage(CONFIG.page);
  return graphCall(`${postId}?fields=id,is_published,permalink_url,scheduled_publish_time`, { token: p.token, throwOnError: false });
}
export async function whatsapp(text) {
  const WA_TO = process.env.WHATSAPP_ALERT_TO; // no default: a phone number must not live in the repo
  if (!WA_TO) { log('whatsapp skipped: WHATSAPP_ALERT_TO is not set (fail closed)'); return false; }
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
  for (const d of pend) lines.push(`\n*${d.id}* (${d.kind}, ${d.sourceDate})\n${d.text.slice(0, 700)}${d.text.length > 700 ? '…' : ''}${d.score ? `\n_${renderScore(d.score)}_` : ''}`);
  lines.push('\nReply: *bpa approve B1 B2* · *bpa skip B3* · *bpa edit B1: new text* · *bpa post B1 now*');
  return lines.join('\n');
}

// ── Instagram: branded card → hosted image → container → publish ─────────────
import { execFileSync } from 'node:child_process';
export function igEnabled() {
  if (!CONFIG.instagram?.enabled) return false;
  try { const s = JSON.parse(fs.readFileSync(resourcePath('metaTokens'), 'utf8')); return (s.user?.scopes || []).includes('instagram_content_publish') || !!s.user?.igPublishOk; } catch { return false; }
}
export function cardSpec(d) {
  const first = d.text.split('\n')[0]; const [headline, rest] = first.split(' — ');
  const body = d.text.split('\n').slice(2).filter((l) => l && !l.startsWith('—') && !l.startsWith('#') && !/^Confidence /.test(l) && !/^This is what/.test(l)).map((l) => l.replace(/^(What changed|Why it matters|What I'd do): /, (m) => m)).slice(0, 3);
  // Signal posts: the "What changed:" line IS the headline (the number is the hero);
  // the card body then carries why/what-to-do without repeating it.
  let head = headline.trim(); let lines = body;
  if (d.kind === 'signal') {
    const wc = body.find((l) => l.startsWith('What changed: '));
    if (wc) { head = wc.replace('What changed: ', ''); lines = body.filter((l) => l !== wc); }
  }
  // tagline: a PUBLISHED brand claim, so it lives in config.json where Tim can word it (audit finding 9)
  return { label: d.kind === 'outlook' ? 'Demand outlook · next 8 weeks' : 'What changed', headline: head, tag: d.region === 'all' ? 'Zanzibar & Dar es Salaam' : (d.region === 'zanzibar' ? 'Zanzibar' : 'Dar es Salaam'), date: (rest || d.sourceDate || '').trim(), lines, brand: CONFIG.brand, tagline: CONFIG.reelTagline };
}
export function renderCard(d, outDir = path.join(HERE, 'cards')) {
  fs.mkdirSync(outDir, { recursive: true }); const spec = path.join(outDir, `${d.id}.json`); const png = path.join(outDir, `${d.id}.png`);
  fs.writeFileSync(spec, JSON.stringify(cardSpec(d))); execFileSync('python3', [path.join(HERE, 'card.py'), spec, png], { stdio: 'pipe' }); return png;
}
function wpCreds() {
  const file = requireResource('mediaEnv');
  const env = {}; for (const line of fs.readFileSync(file, 'utf8').split('\n')) { const m = line.trim().match(/^(WP_[A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, ''); }
  for (const k of ['WP_BASE_URL', 'WP_USERNAME', 'WP_APP_PASSWORD']) if (!env[k]) throw new Error(`${k} missing from ${file} (set BPA_MEDIA_ENV_FILE to the right file)`);
  return { base: env.WP_BASE_URL.replace(/\/$/, ''), auth: 'Basic ' + Buffer.from(`${env.WP_USERNAME}:${env.WP_APP_PASSWORD}`).toString('base64') };
}
export async function hostImage(pngPath, name) {
  const { base, auth } = wpCreds(); const buf = fs.readFileSync(pngPath);
  const r = await fetch(`${base}/wp-json/wp/v2/media`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'image/png', 'Content-Disposition': `attachment; filename="${name}.png"` }, body: buf, signal: AbortSignal.timeout(60000) });
  const j = await r.json(); if (!r.ok) throw new Error(`media upload ${r.status}: ${JSON.stringify(j).slice(0, 160)}`); return { id: j.id, url: j.source_url };
}
export async function igPublish(caption, imageUrl, { dryContainerOnly = false } = {}) {
  const { findPage } = metaPublish(); const p = findPage(CONFIG.page); const ig = CONFIG.instagram.igUserId;
  const post = (pth, form) => graphCall(pth, { token: p.token, method: 'POST', form });
  const c = await post(`${ig}/media`, { image_url: imageUrl, caption: caption.slice(0, 2200) });
  for (let i = 0; i < 20; i++) { const s = await graphCall(`${c.id}?fields=status_code,status`, { token: p.token, throwOnError: false }); if (s.status_code === 'FINISHED') break; if (s.status_code === 'ERROR') throw new Error(`container error: ${s.status}`); await new Promise((r) => setTimeout(r, 3000)); }
  if (dryContainerOnly) return { containerId: c.id, published: false };
  const pub = await post(`${ig}/media_publish`, { creation_id: c.id });
  const info = await graphCall(`${pub.id}?fields=id,permalink`, { token: p.token, throwOnError: false });
  return { id: pub.id, permalink: info.permalink, published: true };
}
export async function igPostDraft(d) {
  const png = renderCard(d); const hosted = await hostImage(png, `bpa-${d.id}-${d.sourceDate}`);
  const r = await igPublish(d.text, hosted.url); return { ...r, imageUrl: hosted.url, mediaId: hosted.id };
}

// ── Instagram REELS (video) publish: container(REELS, video_url) → poll → publish ─────────
export async function igPublishReel(caption, videoUrl, { dryContainerOnly = false } = {}) {
  const { findPage } = metaPublish(); const p = findPage(CONFIG.page); const ig = CONFIG.instagram.igUserId;
  const post = (pth, form) => graphCall(pth, { token: p.token, method: 'POST', form });
  const c = await post(`${ig}/media`, { media_type: 'REELS', video_url: videoUrl, caption: caption.slice(0, 2200), share_to_feed: 'true' });
  // video containers transcode server-side: poll up to ~3 min
  for (let i = 0; i < 60; i++) { const s = await graphCall(`${c.id}?fields=status_code,status`, { token: p.token, throwOnError: false }); if (s.status_code === 'FINISHED') break; if (s.status_code === 'ERROR') throw new Error(`reel container error: ${s.status}`); await new Promise((r) => setTimeout(r, 3000)); }
  if (dryContainerOnly) return { containerId: c.id, published: false };
  const pub = await post(`${ig}/media_publish`, { creation_id: c.id });
  const info = await graphCall(`${pub.id}?fields=id,permalink`, { token: p.token, throwOnError: false });
  return { id: pub.id, permalink: info.permalink, published: true };
}
export async function hostVideo(mp4Path, name) {
  const { base, auth } = wpCreds(); const buf = fs.readFileSync(mp4Path);
  const r = await fetch(`${base}/wp-json/wp/v2/media`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'video/mp4', 'Content-Disposition': `attachment; filename="${name}.mp4"` }, body: buf, signal: AbortSignal.timeout(180000) });
  const j = await r.json(); if (!r.ok) throw new Error(`video upload ${r.status}: ${JSON.stringify(j).slice(0, 160)}`); return { id: j.id, url: j.source_url };
}
// ── Instagram CAROUSEL (2-10 images): child containers -> CAROUSEL parent -> media_publish ─────
// Flow per Meta "Content Publishing" docs (checked 2026-11-02): POST /{ig}/media image_url + is_carousel_item=true per child;
// POST /{ig}/media media_type=CAROUSEL children=<ids comma-joined> caption; POST /{ig}/media_publish creation_id=<parent>.
// Meta's docs now say up to 20 items; we deliberately cap at 10 (the long-standing limit; plans are 3-7). `post`/`status` are injectable for tests.
export async function igPublishCarousel(caption, imageUrls, { post, status, igUserId, sleep, info, dryContainerOnly = false } = {}) {
  if (!Array.isArray(imageUrls) || imageUrls.length < 2 || imageUrls.length > 10) throw new Error(`carousel needs 2-10 images, got ${imageUrls?.length ?? 0}`);
  const ig = igUserId || CONFIG.instagram.igUserId; let token;
  if (!post || !status || !info) { const { findPage } = metaPublish(); token = findPage(CONFIG.page).token; }
  post = post || ((pth, form) => graphCall(pth, { token, method: 'POST', form }));
  status = status || ((id) => graphCall(`${id}?fields=status_code,status`, { token, throwOnError: false }));
  info = info || ((id) => graphCall(`${id}?fields=id,permalink`, { token, throwOnError: false }));
  sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const wait = async (id, what) => { for (let i = 0; i < 20; i++) { const s = await status(id); if (s.status_code === 'FINISHED') return; if (s.status_code === 'ERROR') throw new Error(`${what} container error: ${s.status}`); await sleep(3000); } throw new Error(`${what} container not FINISHED in time`); };
  const children = [];
  for (const url of imageUrls) { const c = await post(`${ig}/media`, { image_url: url, is_carousel_item: 'true' }); await wait(c.id, 'child'); children.push(c.id); }
  const parent = await post(`${ig}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: caption.slice(0, 2200) });
  await wait(parent.id, 'carousel');
  if (dryContainerOnly) return { containerId: parent.id, children, published: false, format: 'carousel' };
  const pub = await post(`${ig}/media_publish`, { creation_id: parent.id });
  const i = await info(pub.id);
  return { id: pub.id, permalink: i.permalink, published: true, format: 'carousel', children };
}
/** Host N local PNGs, in order (WordPress media library, same as single cards). */
export async function hostImages(pngPaths, namePrefix) {
  const out = []; for (const [i, p] of pngPaths.entries()) out.push(await hostImage(p, `${namePrefix}-s${i + 1}`)); return out;
}
/** Post a draft to Instagram: Reel (video) when configured, else image card. */
export async function igPostDraftAny(d) {
  if (CONFIG.instagram?.format === 'carousel') {
    const { planCarousel, renderCarousel } = await import('./carousel.js');
    const plan = await planCarousel(d); if (plan.rejected) throw new Error(`carousel blocked: ${plan.rejected}`);
    const files = renderCarousel(d, plan.slides, path.join(HERE, 'cards', `${d.id}-carousel`));
    const hosted = await hostImages(files, `bpa-${d.id}-${d.sourceDate}`);
    const r = await igPublishCarousel(d.text, hosted.map((h) => h.url)); return { ...r, imageUrls: hosted.map((h) => h.url), format: 'carousel' };
  }
  if (CONFIG.instagram?.format === 'reel') {
    const { renderReel } = await import('./video.js');
    const mp4 = renderReel(d.id, cardSpec(d)); const hosted = await hostVideo(mp4, `bpa-${d.id}-${d.sourceDate}`);
    const r = await igPublishReel(d.text, hosted.url); return { ...r, videoUrl: hosted.url, mediaId: hosted.id, format: 'reel' };
  }
  return { ...(await igPostDraft(d)), format: 'image' };
}
