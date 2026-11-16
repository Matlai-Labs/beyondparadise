import { test } from 'node:test'; import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { randomUUID } from 'node:crypto';
import { run, CHANNELS, SCOPES } from './youtube-login.js';

// All values are built at runtime; nothing here is a real credential.
const fake = () => `fake-${randomUUID()}`;
function setup({ withClient = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ytlogin-'));
  const env = withClient ? { YOUTUBE_OAUTH_CLIENT_ID: fake(), YOUTUBE_OAUTH_CLIENT_SECRET: fake() } : {};
  const out = []; const err = [];
  const deps = { configDir: dir, env, out: (s) => out.push(String(s)), err: (s) => err.push(String(s)), fetch: async () => { throw new Error('unexpected network call'); } };
  return { dir, env, out, err, deps };
}
const getUrl = async (s, ch = 'asia') => { assert.equal(await run(['--url', '--channel', ch], s.deps), 0); return new URL(s.out[0]); };
// fake Google: token endpoint + channels endpoint
function fakeFetch({ channelId, title = 'Some Channel', scope = SCOPES.join(' '), refresh = fake(), calls = [] }) {
  return async (url) => {
    calls.push(String(url));
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if (String(url).includes('/token')) return ok({ access_token: fake(), refresh_token: refresh, scope, token_type: 'Bearer' });
    if (String(url).includes('/youtube/v3/channels')) return ok({ items: [{ id: channelId, snippet: { title } }] });
    throw new Error('unexpected url');
  };
}
const redirectedFor = (u, extra = {}) => { const p = new URLSearchParams({ state: u.searchParams.get('state'), code: 'abc', ...extra }); return `${u.searchParams.get('redirect_uri')}?${p}`; };

test('--url prints one line with exactly the three scopes, offline access, prompt and a saved state', async () => {
  const s = setup(); const u = await getUrl(s);
  assert.equal(s.out.length, 1);
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.deepEqual(u.searchParams.get('scope').split(' ').sort(), ['https://www.googleapis.com/auth/youtube.force-ssl', 'https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/yt-analytics.readonly']);
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent select_account');
  assert.equal(u.searchParams.get('client_id'), s.env.YOUTUBE_OAUTH_CLIENT_ID);
  const state = u.searchParams.get('state'); assert.ok(state.length >= 16);
  const f = join(s.dir, 'youtube-state-asia.json');
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).state, state);
  assert.equal(statSync(f).mode & 0o777, 0o600);
});

test('--exchange with a wrong state refuses and writes nothing', async () => {
  const s = setup(); const u = await getUrl(s);
  const calls = []; s.deps.fetch = fakeFetch({ channelId: CHANNELS.asia.id, calls });
  assert.equal(await run(['--exchange', redirectedFor(u, { state: 'wrong' }), '--channel', 'asia'], s.deps), 1);
  assert.ok(!existsSync(join(s.dir, 'youtube-asia.json')));
  assert.equal(calls.length, 0, 'no token call on state mismatch');
  assert.match(s.err.join('\n'), /state/i);
});

test('--exchange with a channel id mismatch names the chosen channel title and stores nothing', async () => {
  const s = setup(); const u = await getUrl(s, 'asia');
  s.deps.fetch = fakeFetch({ channelId: CHANNELS.africa.id, title: 'BPA - Africa' });
  assert.equal(await run(['--exchange', redirectedFor(u), '--channel', 'asia'], s.deps), 1);
  assert.ok(!existsSync(join(s.dir, 'youtube-asia.json')));
  assert.match(s.err.join('\n'), /BPA - Africa/);
});

test('--exchange refuses when a scope was unticked at consent', async () => {
  const s = setup(); const u = await getUrl(s);
  s.deps.fetch = fakeFetch({ channelId: CHANNELS.asia.id, scope: SCOPES[0] });
  assert.equal(await run(['--exchange', redirectedFor(u), '--channel', 'asia'], s.deps), 1);
  assert.ok(!existsSync(join(s.dir, 'youtube-asia.json')));
});

test('matching channel writes the file with mode 600 and never prints the token', async () => {
  const s = setup(); const u = await getUrl(s, 'africa');
  const refresh = fake(); s.deps.fetch = fakeFetch({ channelId: CHANNELS.africa.id, title: 'BPA - Africa', refresh });
  s.out.length = 0;
  assert.equal(await run(['--exchange', redirectedFor(u), '--channel', 'africa'], s.deps), 0);
  const f = join(s.dir, 'youtube-africa.json');
  assert.equal(statSync(f).mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(f, 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['channelId', 'channelTitle', 'obtainedAt', 'refresh_token', 'scope']);
  assert.equal(saved.refresh_token, refresh); assert.equal(saved.channelId, CHANNELS.africa.id);
  const printed = s.out.join('\n') + s.err.join('\n');
  assert.ok(!printed.includes(refresh)); assert.ok(!printed.includes(s.env.YOUTUBE_OAUTH_CLIENT_SECRET));
  assert.match(printed, /BPA - Africa/); assert.match(printed, /youtube-africa\.json/);
  assert.ok(!existsSync(join(s.dir, 'youtube-state-africa.json')), 'state file is consumed');
});

test('--exchange accepts a bare code', async () => {
  const s = setup(); await getUrl(s);
  s.deps.fetch = fakeFetch({ channelId: CHANNELS.asia.id, title: 'BPA - Asia' });
  assert.equal(await run(['--exchange', '4%2F0Abare-code', '--channel', 'asia'], s.deps), 0);
  assert.ok(existsSync(join(s.dir, 'youtube-asia.json')));
});

test('missing client exits 1 naming the file and both key names', async () => {
  const s = setup({ withClient: false });
  assert.equal(await run(['--url', '--channel', 'asia'], s.deps), 1);
  const m = s.err.join('\n');
  assert.match(m, /youtube-client\.env/); assert.match(m, /YOUTUBE_OAUTH_CLIENT_ID/); assert.match(m, /YOUTUBE_OAUTH_CLIENT_SECRET/);
});

test('client is read from youtube-client.env in the config dir', async () => {
  const s = setup({ withClient: false }); const id = fake();
  writeFileSync(join(s.dir, 'youtube-client.env'), `YOUTUBE_OAUTH_CLIENT_ID=${id}\nYOUTUBE_OAUTH_CLIENT_SECRET=${fake()}\n`);
  const u = await getUrl(s); assert.equal(u.searchParams.get('client_id'), id);
});

test('--status prints presence, title, date and scopes but no token', async () => {
  const s = setup(); const u = await getUrl(s, 'asia');
  const refresh = fake(); s.deps.fetch = fakeFetch({ channelId: CHANNELS.asia.id, title: 'BPA - Asia', refresh });
  await run(['--exchange', redirectedFor(u), '--channel', 'asia'], s.deps);
  s.out.length = 0;
  assert.equal(await run(['--status'], s.deps), 0);
  const t = s.out.join('\n');
  assert.match(t, /asia[^\n]*yes/i); assert.match(t, /africa[^\n]*no/i); assert.match(t, /BPA - Asia/);
  assert.match(t, /youtube\.upload/); assert.ok(!t.includes(refresh));
});

test('unknown channel is refused', async () => {
  const s = setup(); assert.equal(await run(['--url', '--channel', 'mars'], s.deps), 1);
  assert.equal(readdirSync(s.dir).length, 0);
});
