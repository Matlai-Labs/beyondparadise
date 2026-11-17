// Our own Instagram results, read back (READ ONLY: HTTP GET to the Graph API host, nothing is ever written to Instagram or the Facebook Page).
//   node insights.js --fetch [--force]   one real fetch per East Africa day (a second one the same day is skipped unless --force)
//   node insights.js --summary           counts and median reach by product type, weekday, month; ten best and ten weakest (permalink + figures, never caption text)
// State: <state folder>/bpa-ig-insights.json (mode 600, written atomically). It holds no caption text (only its sha256) and never a token.
// An API error writes NOTHING (the older state file stays) and gives a named reason; a metric the API refuses for one media is recorded as absent.
// Metrics checked live 2026-11-17 (reels and images): reach, saved, shares, total_interactions, views; the 17-21 Feb 2025 posts refuse them (code 100).
import fs from 'node:fs'; import path from 'node:path'; import { createHash } from 'node:crypto'; import { fileURLToPath } from 'node:url';
import { graphRequestSpec } from './resources.js';
import { stateDir } from './stop.js';

export const INSIGHT_METRICS = ['reach', 'saved', 'shares', 'total_interactions', 'views'];
export const RUN_DEADLINE_MS = 300000, MAX_STATE_BYTES = 5 * 1024 * 1024; // total time for one whole run; a state file bigger than this is treated as missing
export const isApiId = (x) => /^\d+$/.test(String(x ?? '')); // media, comment and account ids are digits; anything else never goes into a request path
export const PAGE_LIMIT = 50, TIMEOUT_MS = 20000, GRAPH_HOST = 'https://graph.facebook.com/'; // the host resources.js uses; anything else is refused
export const defaultInsightsPath = (env = process.env) => path.join(stateDir(env), 'bpa-ig-insights.json');
export class InsightsError extends Error { constructor(reason) { super(`instagram read failed: ${reason}`); this.name = 'InsightsError'; this.reason = reason; } }

/** The reason for an API error: code, subcode, type. Never the API's message (it can echo a request) and never a URL. */
export const apiReason = (e) => { const code = Number(e?.code), sub = Number(e?.error_subcode); return `api-error code=${Number.isFinite(code) ? code : '?'}${Number.isFinite(sub) && sub ? `/${sub}` : ''}${e?.type ? ` type=${String(e.type).replace(/[^\w]/g, '')}` : ''}`; };
/** The read-only guard: nothing but a GET without a body to the Graph API host leaves this module. */
export function assertReadOnlySpec(spec) { if (!spec || spec.method !== 'GET' || spec.body !== undefined || !String(spec.url).startsWith(GRAPH_HOST)) throw new InsightsError('refused: not a plain GET to the Graph API host'); }
/** One GET to the Graph API (the host is checked; a timeout is always set). Returns the parsed JSON, which may hold .error. Network failures become named reasons. */
export async function graphGet(fetchFn, pathAndQuery, token, timeoutMs = TIMEOUT_MS) {
  const spec = graphRequestSpec(pathAndQuery, { token });
  assertReadOnlySpec(spec);
  let r;
  try { r = await fetchFn(spec.url, { method: 'GET', headers: spec.headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); } // redirect: error, the token is in the query string
  catch (e) { if (e instanceof InsightsError) throw e; throw new InsightsError(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : `network:${String(e?.name || 'error').replace(/[^\w]/g, '')}`); }
  let j; try { j = await r.json(); } catch { throw new InsightsError(r.ok ? `bad-json http=${Number(r.status) || '?'}` : `http-error status=${Number(r.status) || '?'}`); }
  if (!j || typeof j !== 'object') throw new InsightsError('unexpected-response');
  if (!r.ok && !j.error) throw new InsightsError(`http-error status=${Number(r.status) || '?'}`); // a 5xx or proxy answer with a body like {} is an error, not an empty result
  return j;
}
/** Wraps a fetch function with a total deadline for the whole run: past it no further request is sent (reason "deadline"), and each request is also cut off at the remaining time. */
export function deadlineFetch(fetchFn, { deadlineMs = RUN_DEADLINE_MS, clock = Date.now } = {}) {
  const end = clock() + deadlineMs;
  return async (url, opts = {}) => { const left = end - clock(); if (left <= 0) throw new InsightsError('deadline'); return fetchFn(url, { ...opts, signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(left)]) : AbortSignal.timeout(left) }); };
}
/** The newest `maxMedia` media of the account, at most PAGE_LIMIT per request. paging.next is never followed (it carries the token): we page with our own cursor. */
export async function listMedia(fetchFn, { token, accountId, maxMedia, fields }) {
  if (!isApiId(accountId)) throw new InsightsError('bad-account-id');
  const out = []; let after = null; const maxPages = Math.ceil(maxMedia / PAGE_LIMIT) + 1;
  for (let page = 0; page < maxPages && out.length < maxMedia; page++) {
    const limit = Math.min(PAGE_LIMIT, maxMedia - out.length);
    const j = await graphGet(fetchFn, `${accountId}/media?fields=${fields}&limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ''}`, token);
    if (j.error) throw new InsightsError(apiReason(j.error));
    if (!Array.isArray(j.data)) throw new InsightsError('unexpected-response');
    out.push(...(Array.isArray(j.data) ? j.data : [])); after = j.paging?.cursors?.after; if (!after || !j.paging?.next) break;
  }
  return out.slice(0, maxMedia);
}

const valuesOf = (j) => { const o = {}; for (const d of Array.isArray(j?.data) ? j.data : []) { const v = d.values?.[0]?.value ?? d.total_value?.value; if (typeof v === 'number') o[d.name] = v; } return o; };
/** All five metrics in one call; if the API refuses that (code 100) ask one by one, so one refused metric is only absent. Any other error stops the run. */
async function mediaMetrics(fetchFn, token, id) {
  const one = async (names) => { const j = await graphGet(fetchFn, `${id}/insights?metric=${names.join(',')}`, token); if (j.error && j.error.code !== 100) throw new InsightsError(apiReason(j.error)); if (j.error) return null; if (!Array.isArray(j.data)) throw new InsightsError('unexpected-response'); return valuesOf(j); };
  const all = await one(INSIGHT_METRICS); if (all) return all; // (null only when the API said code 100)
  const got = {}; for (const n of INSIGHT_METRICS) Object.assign(got, (await one([n])) || {}); return got;
}
const sha = (s) => createHash('sha256').update(String(s ?? '')).digest('hex');
const normPermalink = (p) => String(p || '').split(/[?#]/)[0].replace(/\/+$/, '').replace('://www.', '://').toLowerCase();
/** The queue item (draft id) that is this media, by permalink or Instagram media id; null when none. */
export function matchQueueId(media, queue) {
  for (const d of queue && Array.isArray(queue.drafts) ? queue.drafts : []) {
    if (d.ig?.id != null && String(d.ig.id) === String(media.id)) return d.id;
    if (d.ig?.permalink && normPermalink(d.ig.permalink) === normPermalink(media.permalink)) return d.id;
  }
  return null;
}

export async function fetchInsights({ fetchFn, token, accountId, now = new Date(), maxMedia = 100, queue = null } = {}) {
  const list = await listMedia(fetchFn, { token, accountId, maxMedia, fields: 'id,permalink,timestamp,media_type,media_product_type,like_count,comments_count,caption' });
  const media = [], skipped = [];
  for (const x of list) {
    if (!isApiId(x.id)) { skipped.push('bad-media-id'); continue; }
    const g = await mediaMetrics(fetchFn, token, x.id); const absent = INSIGHT_METRICS.filter((n) => g[n] === undefined);
    media.push({ id: String(x.id), permalink: x.permalink ?? null, timestamp: x.timestamp ?? null, type: x.media_type ?? null, productType: x.media_product_type ?? null, likes: x.like_count ?? null, comments: x.comments_count ?? null,
      reach: g.reach ?? null, saved: g.saved ?? null, shares: g.shares ?? null, views: g.views ?? null, interactions: g.total_interactions ?? null, metricsAbsent: absent, captionSha256: sha(x.caption), queueId: matchQueueId(x, queue) });
  }
  return { fetchedAt: now.toISOString(), media, skipped };
}

export const eastAfricaDay = (now) => new Date(new Date(now).getTime() + 3 * 3600e3).toISOString().slice(0, 10);
export function readInsightsState(p = defaultInsightsPath()) { try { if (fs.statSync(p).size > MAX_STATE_BYTES) return null; const s = JSON.parse(fs.readFileSync(p, 'utf8')); return s && Array.isArray(s.media) ? s : null; } catch { return null; } }
/** Atomic, mode 600, private folder. */
export function writePrivateJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 }); const tmp = `${p}.tmp`;
  fs.rmSync(tmp, { force: true }); // a leftover (or a planted symlink: rmSync removes the link itself) never survives; 'wx' then refuses to open anything that exists
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, p);
}
/** One fetch, once per East Africa day unless force. Returns { ok, ... } and never throws for an API problem; on failure nothing is written. */
export async function runFetch({ fetchFn, token, accountId, now = new Date(), maxMedia = 100, statePath = defaultInsightsPath(), queue = null, force = false, clock = Date.now, deadlineMs = RUN_DEADLINE_MS } = {}) {
  const day = eastAfricaDay(now); const prev = readInsightsState(statePath);
  if (!force && prev && prev.fetchedDay === day) return { ok: true, skipped: 'already-fetched-today', media: prev.media.length };
  try {
    const s = await fetchInsights({ fetchFn: deadlineFetch(fetchFn, { deadlineMs, clock }), token, accountId, now, maxMedia, queue });
    if (!s.media.length && prev && prev.media.length) return { ok: false, reason: 'empty-result-kept-previous' }; // never replace a good file with an empty list
    writePrivateJson(statePath, { fetchedAt: s.fetchedAt, fetchedDay: day, media: s.media }); return { ok: true, media: s.media.length, skippedIds: s.skipped.length };
  } catch (e) { if (e instanceof InsightsError) return { ok: false, reason: e.reason }; throw e; }
}

export function median(xs) { const a = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((p, q) => p - q); if (!a.length) return null; const h = a.length >> 1; return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2; }
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Pure. Counts and median reach by product type / weekday / month (East Africa time), ten best and ten weakest by reach. No caption text. */
export function summarise(state, queue) {
  const media = state && Array.isArray(state.media) ? state.media : []; const drafts = queue && Array.isArray(queue.drafts) ? queue.drafts : [];
  const group = (keyOf) => { const g = Object.create(null); for (const x of media) { const k = keyOf(x); if (k == null) continue; (g[k] ||= []).push(x); } const o = Object.create(null); for (const [k, v] of Object.entries(g)) o[k] = { count: v.length, medianReach: median(v.map((x) => x.reach)) }; return o; };
  const eat = (x) => { const t = Date.parse(x.timestamp); return Number.isNaN(t) ? null : new Date(t + 3 * 3600e3); };
  const kindOf = (id) => { const d = id ? drafts.find((y) => y.id === id) : null; return d ? (d.ideaKind ?? d.kind ?? null) : null; };
  const fig = (x) => ({ permalink: x.permalink, reach: x.reach, likes: x.likes, comments: x.comments, saved: x.saved, shares: x.shares, views: x.views, productType: x.productType, queueId: x.queueId ?? null, kind: kindOf(x.queueId) });
  const ranked = media.filter((x) => typeof x.reach === 'number').sort((a, b) => b.reach - a.reach);
  const absentByType = Object.create(null); for (const x of media) for (const n of x.metricsAbsent || []) { const t = x.productType || x.type || 'unknown'; ((absentByType[t] ||= Object.create(null))[n] = (absentByType[t][n] || 0) + 1); }
  return { fetchedAt: state?.fetchedAt ?? null, total: media.length, withReach: ranked.length, medianReach: median(ranked.map((x) => x.reach)), matchedQueue: media.filter((x) => x.queueId).length,
    byProductType: group((x) => x.productType || x.type || 'unknown'), byWeekday: group((x) => { const d = eat(x); return d ? DAYS[d.getUTCDay()] : null; }), byMonth: group((x) => { const d = eat(x); return d ? d.toISOString().slice(0, 7) : null; }),
    metricsAbsentByType: absentByType, best: ranked.slice(0, 10).map(fig), weakest: ranked.slice().reverse().slice(0, 10).map(fig) };
}

// ── own results as a bounded nudge for the idea ranking (used by ideas.js; pure) ───────────────────
export const MIN_TOPIC_POSTS = 4, MAX_STATE_AGE_DAYS = 14, MAX_ADJUST = 5;
/** Map topic -> { adjust, reason }. Only a topic with at least MIN_TOPIC_POSTS of our own posts with a known topic and reach; none when the state is missing, unreadable or older than 14 days.
 *  adjust = 5 * (topic median reach / account median reach - 1), capped at +-5. `topicOfSource(sourceId)` gives a queue item's topic. */
export function topicAdjustments({ state, queue, topicOfSource, now = new Date() } = {}) {
  try {
    if (!state || !Array.isArray(state.media)) return new Map(); const at = Date.parse(state.fetchedAt); const age = new Date(now).getTime() - at;
    if (Number.isNaN(at) || age < 0 || age > MAX_STATE_AGE_DAYS * 86400e3) return new Map(); // unreadable, from the future or too old = no state
    const good = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0; // a tampered file (1e999, NaN, negative, "400") must not move a score
    const accountMedian = median(state.media.map((x) => x.reach).filter(good)); if (!(accountMedian > 0) || !Number.isFinite(accountMedian)) return new Map();
    const drafts = new Map((queue && Array.isArray(queue.drafts) ? queue.drafts : []).map((d) => [d.id, d])); const byTopic = new Map();
    for (const x of state.media) { if (!good(x.reach) || !x.queueId) continue; const d = drafts.get(x.queueId); const t = d && d.sourceId != null ? topicOfSource(d.sourceId) : null; if (t) (byTopic.get(t) || byTopic.set(t, []).get(t)).push(x.reach); }
    const out = new Map();
    for (const [t, reaches] of byTopic) {
      if (reaches.length < MIN_TOPIC_POSTS) continue; const tm = median(reaches);
      const adjust = Math.round(Math.max(-MAX_ADJUST, Math.min(MAX_ADJUST, MAX_ADJUST * (tm / accountMedian - 1))) * 1000) / 1000;
      if (!Number.isFinite(adjust)) continue;
      out.set(t, { adjust, reason: `own results: topic median reach ${tm} against ${accountMedian}, ${reaches.length} posts (${adjust >= 0 ? '+' : ''}${adjust})` });
    }
    return out;
  } catch { return new Map(); }
}

// ── command line ───────────────────────────────────────────────────────────────────────────────
/** The Page login and account id, from the same shared module and config the publisher uses (registered setup meta-pages-publisher). Loaded only here so importing this file has no side effects. */
export async function liveAccess({ queueFile } = {}) {
  const { createRequire } = await import('node:module'); const { requireResource } = await import('./resources.js'); const lib = await import('./lib.js');
  const { findPage } = createRequire(import.meta.url)(requireResource('metaPublish')); return { token: findPage(lib.CONFIG.page).token, accountId: lib.CONFIG.instagram.igUserId, queue: queueFile ? lib.loadQueue(queueFile) : lib.loadQueue() };
}
/** The value of --queue-file (the queue to match against, e.g. the main checkout's from a worktree); null when absent. */
export function queueFileArg(argv) { const i = argv.indexOf('--queue-file'); if (i < 0) return null; if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--queue-file needs a path'); return argv[i + 1]; }
async function main(argv) {
  let queueFile; try { queueFile = queueFileArg(argv); } catch (e) { console.error(`insights: ${e.message}`); process.exit(2); }
  if (argv.includes('--summary')) {
    const state = readInsightsState(); if (!state) { console.error('insights: no state file yet (run --fetch)'); process.exit(1); }
    const { loadQueue } = await import('./lib.js'); console.log(JSON.stringify(summarise(state, queueFile ? loadQueue(queueFile) : loadQueue()), null, 2)); return;
  }
  if (!argv.includes('--fetch')) { console.error('usage: node insights.js --fetch [--force] [--queue-file <path>] | --summary [--queue-file <path>]'); process.exit(2); }
  let acc; try { acc = await liveAccess({ queueFile }); } catch (e) { console.error(`insights: no Page login available (${e?.code || e?.name || 'error'})`); process.exit(1); }
  const r = await runFetch({ fetchFn: fetch, token: acc.token, accountId: acc.accountId, queue: acc.queue, force: argv.includes('--force') });
  console.log(r.ok ? (r.skipped ? `insights: ${r.skipped} (${r.media} media in the state file)` : `insights: ${r.media} media read`) : `insights: failed, ${r.reason}`); if (!r.ok) process.exit(1);
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
