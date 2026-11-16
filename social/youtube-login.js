#!/usr/bin/env node
// One-time YouTube sign-in for the two Beyond Paradise channels. Two steps, so it works from another computer:
//   node youtube-login.js --url --channel asia|africa          print the Google sign-in address (open it anywhere)
//   node youtube-login.js --exchange "<address or code>" --channel asia|africa
//   node youtube-login.js --status
// Vendored from matlai_wix/tools/entity/youtube-auth.mjs + lib/youtube.js (loopback redirect + PKCE), changed to a
// paste-back flow. Node built-ins only. Client id/secret come from ~/.config/beyondparadise/youtube-client.env
// (or env), never from the repo. A refresh token is stored only if it belongs to the expected channel. Never printed.
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CHANNELS = {
  asia: { id: 'UCkWgpqnOXI6RRxZzjFayajg', name: 'BPA - Asia' },
  africa: { id: 'UChgJACHQ-bmtDldU0et_gFg', name: 'BPA - Africa' },
};
// upload = publish videos; force-ssl = read and edit the channel (titles, descriptions, playlists, comments, thumbnails); yt-analytics.readonly = read the channel's statistics
export const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.force-ssl', 'https://www.googleapis.com/auth/yt-analytics.readonly'];
// Same loopback shape the hotel's Desktop client uses (http://127.0.0.1:<port>/callback); Desktop clients accept any port.
// Loopback only. YOUTUBE_LOGIN_REDIRECT may move the port (a local listener can then catch the redirect); anything else is ignored.
const REDIRECT_OVERRIDE = process.env.YOUTUBE_LOGIN_REDIRECT;
export const REDIRECT_URI = /^http:\/\/127\.0\.0\.1:\d{2,5}\/callback$/.test(REDIRECT_OVERRIDE || '') ? REDIRECT_OVERRIDE : 'http://127.0.0.1:8124/callback';
export const CONFIG_DIR = join(homedir(), '.config', 'beyondparadise');
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true';
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function writePrivate(dir, file, obj) {
  mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
  writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 }); chmodSync(file, 0o600);
}
function readJson(f) { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } }

function loadClient({ env, configDir }) {
  const file = join(configDir, 'youtube-client.env');
  const fromFile = {};
  if (existsSync(file)) for (const l of readFileSync(file, 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m) fromFile[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
  const get = (k) => env[k] || fromFile[k];
  const clientId = get('YOUTUBE_OAUTH_CLIENT_ID'); const clientSecret = get('YOUTUBE_OAUTH_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error(`Missing the YouTube OAuth client. Put YOUTUBE_OAUTH_CLIENT_ID and YOUTUBE_OAUTH_CLIENT_SECRET in ${file} (mode 600) or set them in the environment.`);
  return { clientId, clientSecret };
}

export function buildUrl({ clientId, challenge, state }) {
  return `${AUTH_URL}?${new URLSearchParams({
    client_id: clientId, redirect_uri: REDIRECT_URI, response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent select_account', state, code_challenge: challenge, code_challenge_method: 'S256',
  })}`;
}

// Full redirected address (state is checked) or a bare code (url-decoded).
export function parseInput(input, expectedState) {
  const s = String(input).trim();
  if (/^https?:\/\//i.test(s) || s.includes('code=')) {
    const u = new URL(s.startsWith('http') ? s : `${REDIRECT_URI}?${s.replace(/^\?/, '')}`);
    if (u.searchParams.get('error')) throw new Error(`authorisation refused: ${u.searchParams.get('error')}`);
    if (u.searchParams.get('state') !== expectedState) throw new Error('state mismatch - refusing (start again with --url)');
    const code = u.searchParams.get('code'); if (!code) throw new Error('no code in the address');
    return code;
  }
  if (!s) throw new Error('nothing to exchange');
  return s.includes('%') ? decodeURIComponent(s) : s;
}

export async function run(argv, deps = {}) {
  const d = { configDir: CONFIG_DIR, env: process.env, out: console.log, err: console.error, fetch: globalThis.fetch, ...deps };
  const flag = (n) => argv.includes(n); const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    if (flag('--status')) {
      for (const [key, ch] of Object.entries(CHANNELS)) {
        const t = readJson(join(d.configDir, `youtube-${key}.json`));
        d.out(t ? `${key}: file yes | channel ${t.channelTitle} | obtained ${t.obtainedAt} | scopes ${t.scope}` : `${key}: file no`);
      }
      return 0;
    }
    const channel = val('--channel');
    if (!CHANNELS[channel]) throw new Error('usage: --url --channel asia|africa | --exchange "<address or code>" --channel asia|africa | --status');
    const stateFile = join(d.configDir, `youtube-state-${channel}.json`);
    if (flag('--url')) {
      const { clientId } = loadClient(d);
      const verifier = b64url(randomBytes(32)); const state = randomBytes(16).toString('hex');
      writePrivate(d.configDir, stateFile, { state, verifier, createdAt: new Date().toISOString() });
      d.out(buildUrl({ clientId, challenge: b64url(createHash('sha256').update(verifier).digest()), state }));
      return 0;
    }
    if (flag('--exchange')) {
      const { clientId, clientSecret } = loadClient(d);
      const st = readJson(stateFile); if (!st) throw new Error(`no pending sign-in for ${channel}; run --url --channel ${channel} first`);
      const code = parseInput(val('--exchange'), st.state);
      const body = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT_URI, code_verifier: st.verifier });
      const tr = await d.fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
      const tok = await tr.json();
      if (!tr.ok || !tok.access_token) throw new Error(`token exchange failed: HTTP ${tr.status} ${tok.error || ''}`);
      if (!tok.refresh_token) throw new Error('Google returned no refresh token (revoke the app grant at the account permissions page and retry)');
      const granted = String(tok.scope || '').split(' ');
      const missing = SCOPES.filter((s) => !granted.includes(s));
      if (missing.length) throw new Error(`consent was narrowed, missing: ${missing.join(' ')} - nothing stored; tick every box and retry`);
      const cr = await d.fetch(CHANNELS_URL, { headers: { Authorization: `Bearer ${tok.access_token}` } });
      const cj = await cr.json(); const item = cj.items && cj.items[0];
      if (!cr.ok || !item) throw new Error(`could not read the signed-in channel: HTTP ${cr.status}`);
      if (item.id !== CHANNELS[channel].id) throw new Error(`wrong channel: sign-in chose "${item.snippet.title}", expected ${CHANNELS[channel].name}. Nothing stored. Run --url again and pick ${CHANNELS[channel].name}.`);
      const file = join(d.configDir, `youtube-${channel}.json`);
      writePrivate(d.configDir, file, { channelId: item.id, channelTitle: item.snippet.title, scope: tok.scope, obtainedAt: new Date().toISOString(), refresh_token: tok.refresh_token });
      rmSync(stateFile, { force: true });
      d.out(`Stored for channel "${item.snippet.title}"\nScopes: ${tok.scope}\nFile: ${file} (token not printed)`);
      return 0;
    }
    throw new Error('usage: --url | --exchange | --status');
  } catch (e) { d.err(e.message); return 1; }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) run(process.argv.slice(2)).then((c) => { process.exitCode = c; });
