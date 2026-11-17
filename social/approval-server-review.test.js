import './test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
process.env.BPA_APPROVAL_TOKEN = 'test-token';
const { server } = await import('./approval-server.js');
const { CONFIG } = await import('./lib.js');
import { writeAccess, OWNER, HOST } from './review-test-kit.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = CONFIG.approvalPort;
let port, accessFile;
before(async () => { accessFile = writeAccess(); await new Promise((r) => server.listen(0, '127.0.0.1', r)); port = server.address().port; });
after(() => { server.close(); });
const call = (method, p, headers = {}, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
  r.on('error', reject); if (body) r.write(body); r.end(); });
const loop = { host: `127.0.0.1:${PORT}` };

test('old route: POST /bpa/action refuses a request whose Host is the tailnet name', async () => { const r = await call('POST', '/bpa/action', { host: HOST, 'content-type': 'application/json', 'x-bpa-token': 'test-token', 'tailscale-user-login': OWNER }, '{"text":"bpa help"}'); assert.equal(r.status, 403); assert.match(r.body, /bad Host header/); });
test('old route still works on loopback with the token', async () => { const r = await call('POST', '/bpa/action', { ...loop, 'content-type': 'application/json', 'x-bpa-token': 'test-token' }, '{"text":"bpa help"}'); assert.equal(r.status, 200); assert.match(JSON.parse(r.body).message, /^bpa/); });
test('/health answers as today on 127.0.0.1 and localhost', async () => { for (const h of [`127.0.0.1:${PORT}`, `localhost:${PORT}`]) { const r = await call('GET', '/health', { host: h }); assert.equal(r.status, 200); const j = JSON.parse(r.body); assert.equal(j.ok, true); assert.equal(typeof j.pending, 'number'); } });
test('/health through the published name needs login AND cookie', async () => {
  assert.equal((await call('GET', '/health', { host: HOST })).status, 403); assert.equal((await call('GET', '/health', { host: HOST, 'tailscale-user-login': OWNER })).status, 403);
  const page = await call('GET', '/review/', { host: HOST, 'tailscale-user-login': OWNER }); const ck = page.headers['set-cookie'][0].split(';')[0];
  assert.equal((await call('GET', '/health', { host: HOST, 'tailscale-user-login': OWNER, cookie: ck })).status, 200);
});
test('/health: another login is refused; an unreadable settings file refuses non-loopback but not loopback', async () => {
  assert.equal((await call('GET', '/health', { host: HOST, 'tailscale-user-login': 'x@example.com' })).status, 403);
  fs.rmSync(accessFile); assert.equal((await call('GET', '/health', { host: HOST, 'tailscale-user-login': OWNER })).status, 503); assert.equal((await call('GET', '/health', loop)).status, 200);
  accessFile = writeAccess();
});
test('/review/ is delegated: refused without login, served with it', async () => { assert.equal((await call('GET', '/review/', { host: HOST })).status, 403); assert.equal((await call('GET', '/review/', { host: HOST, 'tailscale-user-login': OWNER })).status, 200); });
test('the server still binds 127.0.0.1 only', () => { const s = fs.readFileSync(path.join(HERE, 'approval-server.js'), 'utf8'); assert.match(s, /server\.listen\(PORT, '127\.0\.0\.1'/); assert.doesNotMatch(s, /listen\([^)]*0\.0\.0\.0/); });
