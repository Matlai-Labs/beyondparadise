#!/usr/bin/env node
// Read-only YouTube channel data pull for the two Beyond Paradise Adventures channels.
// Uses the stored sign-ins in ~/.config/beyondparadise/ (never printed). Node built-ins only.
// ONLY read calls. The single POST in this file is the token exchange.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/youtube/v3';
const ANALYTICS = 'https://youtubeanalytics.googleapis.com/v2/reports';
const CHANNELS = ['asia', 'africa'];
const defaults = () => ({ configDir: join(homedir(), '.config', 'beyondparadise'), env: process.env, fetch: globalThis.fetch });
const dep = (d) => ({ ...defaults(), ...(d || {}) });

function loadClient({ env, configDir }) {
  const fromFile = {}; const f = join(configDir, 'youtube-client.env');
  if (existsSync(f)) for (const l of readFileSync(f, 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m) fromFile[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
  const id = env.YOUTUBE_OAUTH_CLIENT_ID || fromFile.YOUTUBE_OAUTH_CLIENT_ID; const secret = env.YOUTUBE_OAUTH_CLIENT_SECRET || fromFile.YOUTUBE_OAUTH_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Missing the YouTube OAuth client values (youtube-client.env or environment)');
  return { id, secret };
}

export async function accessToken(channel, deps) {
  const d = dep(deps);
  if (!CHANNELS.includes(channel)) throw new Error(`unknown channel "${channel}" (use asia or africa)`);
  const stored = JSON.parse(readFileSync(join(d.configDir, `youtube-${channel}.json`), 'utf8'));
  const c = loadClient(d);
  const body = new URLSearchParams({ client_id: c.id, client_secret: c.secret, refresh_token: stored.refresh_token, grant_type: 'refresh_token' });
  const r = await d.fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`token exchange failed: HTTP ${r.status} ${j.error || ''}`.trim());
  return j.access_token;
}

async function get(url, token, d) {
  const r = await d.fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`HTTP ${r.status} ${j?.error?.message || j?.error || ''} (${new URL(url).pathname})`.trim());
  return j;
}
const qs = (o) => new URLSearchParams(o).toString();

export async function channelInfo(channel, deps) {
  const d = dep(deps); const t = await accessToken(channel, d);
  const j = await get(`${API}/channels?${qs({ part: 'snippet,statistics,brandingSettings,contentDetails', mine: 'true' })}`, t, d);
  return (j.items || [])[0] || null;
}

export async function listVideos(channel, deps) {
  const d = dep(deps); const t = await accessToken(channel, d);
  const ch = (await get(`${API}/channels?${qs({ part: 'contentDetails', mine: 'true' })}`, t, d)).items?.[0];
  const uploads = ch?.contentDetails?.relatedPlaylists?.uploads; if (!uploads) return [];
  const ids = []; let page;
  do {
    const p = { part: 'contentDetails', playlistId: uploads, maxResults: '50' }; if (page) p.pageToken = page;
    const j = await get(`${API}/playlistItems?${qs(p)}`, t, d);
    for (const it of j.items || []) if (it.contentDetails?.videoId) ids.push(it.contentDetails.videoId);
    page = j.nextPageToken;
  } while (page);
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const j = await get(`${API}/videos?${qs({ part: 'snippet,statistics,contentDetails,status', id: ids.slice(i, i + 50).join(',') })}`, t, d);
    out.push(...(j.items || []));
  }
  return out;
}

export async function listPlaylists(channel, deps) {
  const d = dep(deps); const t = await accessToken(channel, d);
  const out = []; let page;
  do {
    const p = { part: 'snippet,contentDetails,status', mine: 'true', maxResults: '50' }; if (page) p.pageToken = page;
    const j = await get(`${API}/playlists?${qs(p)}`, t, d);
    out.push(...(j.items || [])); page = j.nextPageToken;
  } while (page);
  return out;
}

export async function analytics(channel, { startDate, endDate, metrics, dimensions } = {}, deps) {
  try {
    const d = dep(deps); const t = await accessToken(channel, d);
    const p = { ids: 'channel==MINE', startDate, endDate, metrics }; if (dimensions) p.dimensions = dimensions;
    return { ok: true, data: await get(`${ANALYTICS}?${qs(p)}`, t, d) };
  } catch (e) { return { ok: false, reason: String(e.message || e) }; }
}

export async function dump(dir, deps) {
  const d = dep(deps); mkdirSync(dir, { recursive: true });
  const now = d.now || new Date(); const end = now.toISOString().slice(0, 10);
  const write = (name, v) => writeFileSync(join(dir, name), JSON.stringify(v, null, 2));
  for (const c of CHANNELS) {
    const step = async (fn) => { try { return await fn(); } catch (e) { return { ok: false, reason: String(e.message || e) }; } };
    write(`${c}-channel.json`, await step(() => channelInfo(c, d)));
    write(`${c}-videos.json`, await step(() => listVideos(c, d)));
    write(`${c}-playlists.json`, await step(() => listPlaylists(c, d)));
    write(`${c}-analytics.json`, await analytics(c, { startDate: '2024-01-01', endDate: end, metrics: 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost', dimensions: 'month' }, d));
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const i = process.argv.indexOf('--dump');
  if (i < 0 || !process.argv[i + 1]) { console.error('usage: node youtube-channel.js --dump <dir>'); process.exit(2); }
  await dump(process.argv[i + 1]); console.log(`written to ${process.argv[i + 1]}`);
}
