import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join, dirname } from 'node:path'; import { fileURLToPath } from 'node:url';
import { accessToken, channelInfo, listVideos, listPlaylists, analytics, dump } from './youtube-channel.js';

// All values are built at runtime so no secret-looking literal sits in the repo.
const rnd = (p) => p + '_' + Math.random().toString(36).slice(2, 10);
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ytc-'));
  const refresh = rnd('r'), cid = rnd('c'), sec = rnd('s'), chan = rnd('ch');
  writeFileSync(join(dir, 'youtube-client.env'), `YOUTUBE_OAUTH_CLIENT_ID=${cid}\nYOUTUBE_OAUTH_CLIENT_SECRET=${sec}\n`);
  writeFileSync(join(dir, 'youtube-asia.json'), JSON.stringify({ channelId: chan, channelTitle: 'T', scope: 'x', obtainedAt: 'now', refresh_token: refresh }));
  writeFileSync(join(dir, 'youtube-africa.json'), JSON.stringify({ channelId: chan + '2', channelTitle: 'U', scope: 'x', obtainedAt: 'now', refresh_token: refresh }));
  return { dir, refresh, cid, sec, chan };
}
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
function fakeFetch(calls, routes = {}) {
  return async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes('oauth2.googleapis.com/token')) return json({ access_token: 'AT' + calls.length });
    for (const [k, v] of Object.entries(routes)) if (String(url).includes(k)) return typeof v === 'function' ? v(String(url)) : json(v);
    return json({});
  };
}

test('accessToken posts the refresh grant to the token endpoint and returns the token only', async () => {
  const s = setup(); const calls = []; const logs = [];
  const orig = console.log; console.log = (...a) => logs.push(a.join(' '));
  try {
    const t = await accessToken('asia', { configDir: s.dir, env: {}, fetch: fakeFetch(calls) });
    assert.match(t, /^AT/);
  } finally { console.log = orig; }
  assert.equal(calls.length, 1); assert.equal(calls[0].opts.method, 'POST');
  assert.match(calls[0].opts.body, /grant_type=refresh_token/); assert.ok(calls[0].opts.body.includes(s.refresh));
  assert.equal(logs.join('').includes(s.refresh), false);
});
test('accessToken fails with a message that holds no secret when the exchange is refused', async () => {
  const s = setup();
  const f = async () => json({ error: 'invalid_grant' }, 400);
  await assert.rejects(() => accessToken('asia', { configDir: s.dir, env: {}, fetch: f }), (e) => { assert.match(e.message, /invalid_grant/); assert.equal(e.message.includes(s.refresh), false); assert.equal(e.message.includes(s.sec), false); return true; });
});
test('accessToken rejects an unknown channel name', async () => {
  const s = setup(); await assert.rejects(() => accessToken('mars', { configDir: s.dir, env: {}, fetch: fakeFetch([]) }), /unknown channel/i);
});
test('channelInfo asks for the four parts with mine=true and a bearer token', async () => {
  const s = setup(); const calls = [];
  const r = await channelInfo('asia', { configDir: s.dir, env: {}, fetch: fakeFetch(calls, { '/youtube/v3/channels': { items: [{ id: 'C1' }] } }) });
  assert.equal(r.id, 'C1');
  const u = new URL(calls[1].url); assert.equal(u.searchParams.get('mine'), 'true');
  assert.equal(u.searchParams.get('part'), 'snippet,statistics,brandingSettings,contentDetails');
  assert.match(calls[1].opts.headers.Authorization, /^Bearer AT/);
});
test('listVideos pages through the uploads playlist and fetches details in batches of 50', async () => {
  const s = setup(); const calls = [];
  const ids = Array.from({ length: 120 }, (_, i) => 'v' + i);
  const routes = {
    '/youtube/v3/channels': { items: [{ id: 'C1', contentDetails: { relatedPlaylists: { uploads: 'UP1' } } }] },
    '/youtube/v3/playlistItems': (url) => { const p = new URL(url).searchParams.get('pageToken'); if (!p) return json({ items: ids.slice(0, 50).map((v) => ({ contentDetails: { videoId: v } })), nextPageToken: 'n1' }); if (p === 'n1') return json({ items: ids.slice(50, 100).map((v) => ({ contentDetails: { videoId: v } })), nextPageToken: 'n2' }); return json({ items: ids.slice(100).map((v) => ({ contentDetails: { videoId: v } })) }); },
    '/youtube/v3/videos': (url) => json({ items: new URL(url).searchParams.get('id').split(',').map((id) => ({ id })) }),
  };
  const vids = await listVideos('asia', { configDir: s.dir, env: {}, fetch: fakeFetch(calls, routes) });
  assert.equal(vids.length, 120);
  const vcalls = calls.filter((c) => c.url.includes('/youtube/v3/videos'));
  assert.equal(vcalls.length, 3); assert.equal(new URL(vcalls[0].url).searchParams.get('id').split(',').length, 50);
  assert.equal(new URL(vcalls[0].url).searchParams.get('part'), 'snippet,statistics,contentDetails,status');
});
test('listPlaylists follows pages', async () => {
  const s = setup(); const calls = [];
  const routes = { '/youtube/v3/playlists': (url) => new URL(url).searchParams.get('pageToken') ? json({ items: [{ id: 'p2' }] }) : json({ items: [{ id: 'p1' }], nextPageToken: 'x' }) };
  const r = await listPlaylists('asia', { configDir: s.dir, env: {}, fetch: fakeFetch(calls, routes) });
  assert.deepEqual(r.map((p) => p.id), ['p1', 'p2']);
});
test('analytics returns ok:false with a reason instead of throwing when the API is disabled', async () => {
  const s = setup();
  const routes = { youtubeanalytics: () => json({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'YouTube Analytics API has not been used in project before or it is disabled.' } }, 403) };
  const r = await analytics('asia', { startDate: '2025-01-01', endDate: '2025-12-31', metrics: 'views', dimensions: 'day' }, { configDir: s.dir, env: {}, fetch: fakeFetch([], routes) });
  assert.equal(r.ok, false); assert.match(r.reason, /disabled|403/i);
});
test('analytics returns the rows when it works, and survives a thrown network error', async () => {
  const s = setup(); const calls = [];
  const ok = await analytics('asia', { startDate: '2025-01-01', endDate: '2025-02-01', metrics: 'views', dimensions: 'day' }, { configDir: s.dir, env: {}, fetch: fakeFetch(calls, { youtubeanalytics: { rows: [[1]] } }) });
  assert.equal(ok.ok, true); assert.deepEqual(ok.data.rows, [[1]]);
  assert.equal(new URL(calls[1].url).searchParams.get('ids'), 'channel==MINE');
  const bad = await analytics('asia', { startDate: 'a', endDate: 'b', metrics: 'views' }, { configDir: s.dir, env: {}, fetch: async (u) => { if (String(u).includes('oauth2')) return json({ access_token: 'x' }); throw new Error('network down'); } });
  assert.equal(bad.ok, false); assert.match(bad.reason, /network down/);
});
test('dump writes four files per channel and keeps the analytics failure reason', async () => {
  const s = setup(); const out = mkdtempSync(join(tmpdir(), 'ytout-'));
  const routes = {
    '/youtube/v3/channels': { items: [{ id: 'C1', contentDetails: { relatedPlaylists: { uploads: 'UP1' } } }] },
    '/youtube/v3/playlistItems': { items: [{ contentDetails: { videoId: 'v1' } }] },
    '/youtube/v3/videos': { items: [{ id: 'v1' }] }, '/youtube/v3/playlists': { items: [] },
    youtubeanalytics: () => json({ error: { message: 'disabled' } }, 403),
  };
  await dump(out, { configDir: s.dir, env: {}, fetch: fakeFetch([], routes), now: new Date('2026-11-16T00:00:00Z') });
  const files = readdirSync(out).sort();
  for (const c of ['asia', 'africa']) for (const k of ['channel', 'videos', 'playlists', 'analytics']) assert.ok(files.includes(`${c}-${k}.json`), `${c}-${k}`);
  assert.equal(JSON.parse(readFileSync(join(out, 'asia-analytics.json'), 'utf8')).ok, false);
  const all = files.map((f) => readFileSync(join(out, f), 'utf8')).join('');
  assert.equal(all.includes(s.refresh), false);
});
test('the module source is read-only: no PUT, DELETE, PATCH, and one POST that goes to the token endpoint', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'youtube-channel.js'), 'utf8');
  assert.doesNotMatch(src, /method:\s*['"]PUT['"]/); assert.doesNotMatch(src, /method:\s*['"]DELETE['"]/); assert.doesNotMatch(src, /method:\s*['"]PATCH['"]/);
  const posts = src.match(/method:\s*['"]POST['"]/g) || []; assert.equal(posts.length, 1);
  const line = src.split('\n').find((l) => /method:\s*['"]POST['"]/.test(l)); assert.match(line, /TOKEN_URL/);
  assert.doesNotMatch(src, /videos\.(insert|update|delete)|playlists\.(insert|update|delete)|thumbnails\/set/);
});
