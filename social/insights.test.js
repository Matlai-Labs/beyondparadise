import './test-env.js';
// Read-only Instagram results: the fetch, the state file, the once-a-day rule, the summary. The fetch function, the clock and every path are injected; nothing here touches the network.
import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { createHash } from 'node:crypto';
import { fetchInsights, runFetch, summarise, median, eastAfricaDay, matchQueueId, readInsightsState, InsightsError, INSIGHT_METRICS, assertReadOnlySpec } from './insights.js';

const TOKEN = 'TOKEN_SHOULD_NEVER_APPEAR_123'; const ACC = '1784'; const NOW = new Date('2026-11-17T10:00:00Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-ins-'));
const ok = (j) => ({ ok: true, status: 200, json: async () => j });
const m = (i, extra = {}) => ({ id: `9${i}`, permalink: `https://www.instagram.com/reel/P${i}/`, timestamp: '2026-11-10T08:00:00+0000', media_type: 'VIDEO', media_product_type: 'REELS', like_count: i, comments_count: 0, caption: `secret caption ${i}`, ...extra });
const VALUES = { reach: 100, saved: 2, shares: 1, total_interactions: 7, views: 150 };
const insightsOf = (names) => ({ data: names.map((n) => ({ name: n, values: [{ value: VALUES[n] }] })) });
/** A fake Graph API: media = list of media objects; insights(mediaId, names) => json. Records every call. */
function fake({ media = [], insights = (id, names) => insightsOf(names), mediaError = null, pages = null } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts }); const u = new URL(url); const p = u.pathname.replace(/^\/v[\d.]+\//, '');
    if (mediaError) return ok({ error: mediaError });
    if (p === `${ACC}/media`) {
      if (pages) return ok(pages(u.searchParams.get('after'), Number(u.searchParams.get('limit'))));
      const limit = Number(u.searchParams.get('limit')); return ok({ data: media.slice(0, limit) });
    }
    const mm = /^(\d+)\/insights$/.exec(p); if (mm) return ok(insights(mm[1], u.searchParams.get('metric').split(',')));
    return ok({ error: { code: 1, message: 'unexpected' } });
  };
  fn.calls = calls; return fn;
}

test('fetchInsights returns the list fields and the five metrics for a reel', async () => {
  const r = await fetchInsights({ fetchFn: fake({ media: [m(1)] }), token: TOKEN, accountId: ACC, now: NOW });
  assert.equal(r.fetchedAt, NOW.toISOString()); assert.equal(r.media.length, 1);
  const x = r.media[0]; assert.equal(x.id, '91'); assert.equal(x.type, 'VIDEO'); assert.equal(x.productType, 'REELS'); assert.equal(x.likes, 1); assert.equal(x.comments, 0);
  assert.deepEqual([x.reach, x.saved, x.shares, x.views, x.interactions], [100, 2, 1, 150, 7]); assert.deepEqual(x.metricsAbsent, []);
  assert.equal(x.captionSha256, createHash('sha256').update('secret caption 1').digest('hex')); assert.equal(x.queueId, null);
  assert.ok(!('caption' in x));
});
test('a metric the API refuses for one media is recorded as absent and does not fail the run', async () => {
  const insights = (id, names) => (id === '92' && names.length > 1 ? { error: { code: 100, error_subcode: 2108006, message: 'Invalid parameter' } } : id === '92' && names[0] === 'views' ? { error: { code: 100, message: 'no' } } : insightsOf(names));
  const r = await fetchInsights({ fetchFn: fake({ media: [m(1), m(2)], insights }), token: TOKEN, accountId: ACC, now: NOW });
  assert.equal(r.media[0].views, 150); assert.equal(r.media[1].views, null); assert.deepEqual(r.media[1].metricsAbsent, ['views']); assert.equal(r.media[1].reach, 100);
});
test('a media whose insights are refused for every metric is kept with absent metrics', async () => {
  const r = await fetchInsights({ fetchFn: fake({ media: [m(1)], insights: () => ({ error: { code: 100, message: 'Invalid parameter' } }) }), token: TOKEN, accountId: ACC, now: NOW });
  assert.equal(r.media[0].reach, null); assert.deepEqual(r.media[0].metricsAbsent, INSIGHT_METRICS); assert.equal(r.media[0].likes, 1);
});
test('an API error that is not "invalid parameter" (token, rate limit) stops the run with a named reason that holds no token', async () => {
  await assert.rejects(fetchInsights({ fetchFn: fake({ media: [m(1)], insights: () => ({ error: { code: 190, type: 'OAuthException', message: `bad ${TOKEN}` } }) }), token: TOKEN, accountId: ACC, now: NOW }),
    (e) => e instanceof InsightsError && /^api-error code=190/.test(e.reason) && !e.message.includes(TOKEN) && !e.reason.includes(TOKEN));
});
test('an error on the media list gives a named reason; a network failure and a timeout too', async () => {
  await assert.rejects(fetchInsights({ fetchFn: fake({ mediaError: { code: 10, type: 'OAuthException', message: 'x' } }), token: TOKEN, accountId: ACC, now: NOW }), (e) => /^api-error code=10/.test(e.reason));
  const timeout = async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; };
  await assert.rejects(fetchInsights({ fetchFn: timeout, token: TOKEN, accountId: ACC, now: NOW }), (e) => e.reason === 'timeout');
  const boom = async () => { throw new TypeError(`fetch failed for ${TOKEN}`); };
  await assert.rejects(fetchInsights({ fetchFn: boom, token: TOKEN, accountId: ACC, now: NOW }), (e) => e.reason === 'network:TypeError' && !e.message.includes(TOKEN));
});
test('bounded: maxMedia caps the media read and the number of list pages', async () => {
  const many = Array.from({ length: 500 }, (_, i) => m(i + 1));
  const f = fake({ media: many }); const r = await fetchInsights({ fetchFn: f, token: TOKEN, accountId: ACC, now: NOW, maxMedia: 3 });
  assert.equal(r.media.length, 3);
  const endless = fake({ pages: (after, limit) => ({ data: Array.from({ length: limit }, (_, i) => m(Number(after || 0) + i + 1)), paging: { cursors: { after: String(Number(after || 0) + limit) }, next: 'https://elsewhere.example/next?access_token=x' } }) });
  const r2 = await fetchInsights({ fetchFn: endless, token: TOKEN, accountId: ACC, now: NOW, maxMedia: 120 });
  assert.equal(r2.media.length, 120); const listCalls = endless.calls.filter((c) => /\/media\?/.test(c.url)); assert.ok(listCalls.length <= 3, `list calls: ${listCalls.length}`);
  assert.ok(listCalls.every((c) => Number(new URL(c.url).searchParams.get('limit')) <= 50));
  assert.ok(endless.calls.every((c) => !c.url.includes('elsewhere.example')), 'the paging.next URL (it carries a token) is never followed');
});
test('every request is a GET to the Graph API host with a timeout', async () => {
  const f = fake({ media: [m(1), m(2)] }); await fetchInsights({ fetchFn: f, token: TOKEN, accountId: ACC, now: NOW });
  assert.ok(f.calls.length >= 3);
  for (const c of f.calls) { assert.ok(c.url.startsWith('https://graph.facebook.com/'), c.url); assert.equal((c.opts.method || 'GET'), 'GET'); assert.equal(c.opts.body, undefined); assert.ok(c.opts.signal instanceof AbortSignal, 'a timeout signal is set'); }
});
test('matchQueueId matches by permalink (query and trailing slash ignored) or by media id', () => {
  const q = { drafts: [{ id: 'B1', ig: { permalink: 'https://www.instagram.com/reel/AAA/?utm=x' } }, { id: 'B2', ig: { id: '999' } }, { id: 'B3' }] };
  assert.equal(matchQueueId({ id: '1', permalink: 'https://www.instagram.com/reel/AAA' }, q), 'B1'); assert.equal(matchQueueId({ id: '999', permalink: 'https://x/y' }, q), 'B2');
  assert.equal(matchQueueId({ id: '5', permalink: 'https://x/z' }, q), null); assert.equal(matchQueueId({ id: '5', permalink: 'p' }, null), null);
});
test('runFetch writes the state file (mode 600, no caption text, no token, no temp file left) and fills queueId', async () => {
  const dir = tmp(); const statePath = path.join(dir, 'bpa-ig-insights.json');
  const queue = { drafts: [{ id: 'B9', ig: { permalink: 'https://www.instagram.com/reel/P1/' } }] };
  const r = await runFetch({ fetchFn: fake({ media: [m(1), m(2)] }), token: TOKEN, accountId: ACC, now: NOW, statePath, queue });
  assert.equal(r.ok, true); assert.equal(r.media, 2);
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600); assert.deepEqual(fs.readdirSync(dir), ['bpa-ig-insights.json']);
  const raw = fs.readFileSync(statePath, 'utf8'); assert.ok(!raw.includes('secret caption')); assert.ok(!raw.includes(TOKEN));
  const s = JSON.parse(raw); assert.equal(s.media[0].queueId, 'B9'); assert.equal(s.media[1].queueId, null); assert.equal(s.fetchedAt, NOW.toISOString());
  assert.equal(readInsightsState(statePath).media.length, 2);
});
test('an API error writes nothing: no state file and an older one stays as it was', async () => {
  const dir = tmp(); const statePath = path.join(dir, 's.json');
  const r = await runFetch({ fetchFn: fake({ mediaError: { code: 190, type: 'OAuthException' } }), token: TOKEN, accountId: ACC, now: NOW, statePath }); assert.equal(r.ok, false); assert.match(r.reason, /^api-error code=190/); assert.equal(fs.existsSync(statePath), false);
  fs.writeFileSync(statePath, '{"fetchedAt":"old","media":[]}'); await runFetch({ fetchFn: fake({ mediaError: { code: 190 } }), token: TOKEN, accountId: ACC, now: NOW, statePath, force: true });
  assert.equal(fs.readFileSync(statePath, 'utf8'), '{"fetchedAt":"old","media":[]}');
});
test('at most one real fetch per East Africa day unless forced', async () => {
  const dir = tmp(); const statePath = path.join(dir, 's.json'); const f = fake({ media: [m(1)] }); const go = (now, force) => runFetch({ fetchFn: f, token: TOKEN, accountId: ACC, now, statePath, force });
  assert.equal((await go(new Date('2026-11-17T05:00:00Z'))).ok, true); const n = f.calls.length;
  const again = await go(new Date('2026-11-17T20:30:00Z')); assert.deepEqual([again.ok, again.skipped], [true, 'already-fetched-today']); assert.equal(f.calls.length, n, 'no request on the second run');
  assert.equal((await go(new Date('2026-11-17T20:30:00Z'), true)).skipped, undefined); assert.ok(f.calls.length > n, 'force fetches');
  assert.equal((await go(new Date('2026-11-17T21:30:00Z'))).skipped, undefined, '21:30 UTC is already the next day in East Africa');
  assert.equal(eastAfricaDay(new Date('2026-11-17T21:30:00Z')), '2026-11-18'); assert.equal(eastAfricaDay(new Date('2026-11-17T20:59:00Z')), '2026-11-17');
});
test('summarise: counts and median reach by product type, weekday and month; ten best and ten weakest without caption text', () => {
  const media = Array.from({ length: 25 }, (_, i) => ({ id: `9${i}`, permalink: `https://x/p${i}`, timestamp: i < 10 ? '2026-11-16T08:00:00+0000' : '2026-10-21T22:30:00+0000', type: i % 5 === 0 ? 'IMAGE' : 'VIDEO', productType: i % 5 === 0 ? 'FEED' : 'REELS', likes: i, comments: 0, reach: i === 24 ? null : (i + 1) * 10, saved: 0, shares: 0, views: 1, captionSha256: 'aa', queueId: i === 3 ? 'B3' : null }));
  const queue = { drafts: [{ id: 'B3', ideaKind: 'fact', text: 'queue text must not leak' }] }; const before = JSON.stringify({ media, queue });
  const s = summarise({ fetchedAt: NOW.toISOString(), media }, queue); assert.equal(JSON.stringify({ media, queue }), before, 'pure: inputs unchanged');
  assert.equal(s.total, 25); assert.equal(s.withReach, 24); assert.equal(s.matchedQueue, 1);
  assert.equal(s.byProductType.FEED.count, 5); assert.equal(s.byProductType.REELS.count, 20); assert.equal(s.byProductType.FEED.medianReach, median([10, 60, 110, 160, 210]));
  assert.equal(s.byMonth['2026-11'].count, 10); assert.equal(s.byMonth['2026-10'].count, 15); assert.equal(s.byWeekday.Mon.count, 10); assert.equal(s.byWeekday.Thu.count, 15, '22:30 UTC on Wed 21 Oct is Thu 22 Oct in East Africa');
  assert.equal(s.best.length, 10); assert.equal(s.weakest.length, 10); assert.equal(s.best[0].reach, 240); assert.equal(s.weakest[0].reach, 10); assert.equal(s.best[0].permalink, 'https://x/p23');
  assert.equal(s.weakest.find((b) => b.queueId === 'B3').kind, 'fact'); assert.ok(!JSON.stringify(s).includes('must not leak'));
  assert.equal(s.medianReach, median(media.filter((x) => x.reach != null).map((x) => x.reach)));
});
test('summarise copes with an empty or missing state', () => { assert.equal(summarise(null, null).total, 0); assert.equal(summarise({ media: [] }, {}).medianReach, null); assert.equal(median([]), null); assert.equal(median([1, 3]), 2); });
test('the source holds no absolute user path and sends nothing but GET', () => {
  const src = fs.readFileSync(new URL('./insights.js', import.meta.url), 'utf8'); assert.ok(!/\/Users\//.test(src)); assert.ok(!/method:\s*'(POST|DELETE|PUT|PATCH)'/i.test(src));
});
test('the read-only guard refuses a POST, a body, another host and a look-alike host; and graphGet really calls it', () => {
  const good = { method: 'GET', url: 'https://graph.facebook.com/v21.0/x?y=1', body: undefined }; assert.doesNotThrow(() => assertReadOnlySpec(good));
  for (const bad of [{ ...good, method: 'POST' }, { ...good, method: 'DELETE' }, { ...good, body: new URLSearchParams({ a: '1' }) }, { ...good, url: 'https://example.com/v21.0/x' }, { ...good, url: 'https://graph.facebook.com.evil.example/x' }, { ...good, url: 'http://graph.facebook.com/x' }, null])
    assert.throws(() => assertReadOnlySpec(bad), (e) => e instanceof InsightsError && /refused/.test(e.reason));
  const src = fs.readFileSync(new URL('./insights.js', import.meta.url), 'utf8'); assert.match(src.slice(src.indexOf('export async function graphGet')), /^[^]*?assertReadOnlySpec\(spec\);[^]*?await fetchFn\(/, 'graphGet checks the spec before it fetches');
});
