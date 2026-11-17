import fs from 'node:fs'; import path from 'node:path'; import { stateDir } from './stop.js';
export const OWNER = 'owner@example.com', HOST = 'device.example.ts.net:10000';
export function writeAccess({ ownerLogin = OWNER, host = HOST, mode = 0o600, raw } = {}) {
  const f = path.join(stateDir(), 'bpa-review-access.json'); fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, raw ?? JSON.stringify({ ownerLogin, host })); fs.chmodSync(f, mode); return f; }
export const fakeReq = (headers = {}, extra = {}) => ({ method: 'GET', url: '/review/', headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), ...extra });
export const goodHeaders = (over = {}) => ({ host: HOST, 'tailscale-user-login': OWNER, ...over });
