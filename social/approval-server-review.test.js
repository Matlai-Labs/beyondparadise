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
let port, accessFile, ck;
before(async () => { accessFile = writeAccess(); await new Promise((r) => server.listen(0, '127.0.0.1', r)); port = server.address().port; });
after(() => { server.close(); });
const call = (method, p, headers = {}, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
  r.on('error', reject); if (body) r.write(body); r.end(); });
const loop = { host: `127.0.0.1:${PORT}` };

test('old route: POST /bpa/action refuses a request whose Host is the tailnet name', async () => { const r = await call('POST', '/bpa/action', { host: HOST, 'content-type': 'application/json', 'x-bpa-token': 'test-token' }, '{"text":"bpa help"}'); assert.equal(r.status, 403); assert.match(r.body, /bad Host header/); });
test('old route still works on loopback with the token', async () => { const r = await call('POST', '/bpa/action', { ...loop, 'content-type': 'application/json', 'x-bpa-token': 'test-token' }, '{"text":"bpa help"}'); assert.equal(r.status, 200); assert.match(JSON.parse(r.body).message, /^bpa/); });
test('/health answers as today on 127.0.0.1 and localhost', async () => { for (const h of [`127.0.0.1:${PORT}`, `localhost:${PORT}`]) { const r = await call('GET', '/health', { host: h }); assert.equal(r.status, 200); const j = JSON.parse(r.body); assert.equal(j.ok, true); assert.equal(typeof j.pending, 'number'); } });
test('/health through the published name needs login AND cookie', async () => {
  assert.equal((await call('GET', '/health', { host: HOST })).status, 403); assert.equal((await call('GET', '/health', { host: HOST, 'tailscale-user-login': OWNER })).status, 403);
  const page = await call('GET', '/review/', { host: HOST, 'tailscale-user-login': OWNER, 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' }); ck = page.headers['set-cookie'][0].split(';')[0];
  assert.equal((await call('GET', '/health', { host: HOST, 'tailscale-user-login': OWNER, cookie: ck })).status, 200);
});
test('/health: another login is refused; an unreadable settings file refuses non-loopback but not loopback', async () => {
  assert.equal((await call('GET', '/health', { host: HOST, 'tailscale-user-login': 'x@example.com' })).status, 403);
  fs.rmSync(accessFile); assert.equal((await call('GET', '/health', { host: HOST, 'tailscale-user-login': OWNER })).status, 503); assert.equal((await call('GET', '/health', loop)).status, 200);
  accessFile = writeAccess();
});
test('/review/ is delegated: refused without login, served with it', async () => { assert.equal((await call('GET', '/review/', { host: HOST })).status, 403); assert.equal((await call('GET', '/review/', { host: HOST, 'tailscale-user-login': OWNER, cookie: ck })).status, 200); });
test('the server still binds 127.0.0.1 only', () => { const s = fs.readFileSync(path.join(HERE, 'approval-server.js'), 'utf8'); assert.match(s, /server\.listen\(PORT, '127\.0\.0\.1'/); assert.doesNotMatch(s, /listen\([^)]*0\.0\.0\.0/); });

const FWD = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'tailscale-user-login', 'tailscale-user-name'];
test('E9: the old command route refuses a loopback request that carries a proxy header (same plain body); without one it works', async () => {
  for (const h of FWD) { const r = await call('POST', '/bpa/action', { ...loop, 'content-type': 'application/json', 'x-bpa-token': 'test-token', [h]: '100.64.0.1' }, '{"text":"bpa help"}'); assert.equal(r.status, 403, h); assert.equal(r.body, 'not available', h); assert.match(r.headers['content-type'], /^text\/plain/); }
  const ok = await call('POST', '/bpa/action', { ...loop, 'content-type': 'application/json', 'x-bpa-token': 'test-token' }, '{"text":"bpa help"}'); assert.equal(ok.status, 200);
});
test('E9: /health on a loopback Host with a proxy header falls under the login and cookie rule', async () => {
  for (const h of FWD) { const r = await call('GET', '/health', { ...loop, [h]: '100.64.0.1' }); assert.equal(r.status, 403, h); assert.equal(r.body, 'not available'); }
  assert.equal((await call('GET', '/health', loop)).status, 200, 'the worker, no proxy header'); assert.equal((await call('GET', '/health', { host: HOST, 'tailscale-user-login': OWNER, cookie: ck, 'x-forwarded-for': '100.64.0.1' })).status, 200, 'the published path with login and cookie');
});

// ── step 2: the new routes through the REAL server, and the stop/start parity with WhatsApp ──────────────
const { handle } = await import('./approval-server.js');
const PAGE = { 'x-bpa-page': '1' };
const who = { host: HOST, 'tailscale-user-login': OWNER };
const tokenOf = async () => JSON.parse((await call('POST', '/review/api/session', { ...who, cookie: ck, ...PAGE })).body).token;
const act = (route, tok, obj) => call('POST', `/review/api/${route}`, { ...who, cookie: ck, 'x-bpa-action': tok, 'content-type': 'application/json' }, JSON.stringify(obj));

test('old route still refuses the tailnet Host and proxy headers after step 2', async () => {
  const base = { 'content-type': 'application/json', 'x-bpa-token': 'test-token' };
  const a = await call('POST', '/bpa/action', { ...base, host: HOST }, '{"text":"bpa help"}'); assert.equal(a.status, 403);
  const b = await call('POST', '/bpa/action', { ...base, ...loop, 'x-forwarded-for': '100.64.0.1' }, '{"text":"bpa help"}'); assert.equal(b.status, 403); assert.equal(b.body, 'not available');
});
test('POST /review/api/decide through the real server without the token is 403 not available, with login and cookie only', async () => {
  const r = await call('POST', '/review/api/decide', { ...who, cookie: ck, 'content-type': 'application/json' }, JSON.stringify({ action: 'approve', kind: 'clip', id: 'x', version: 'y' }));
  assert.equal(r.status, 403); assert.equal(r.body, 'not available');
});
test('POST /review/api/session through the real server without a cookie is 403 not available and sets no cookie; with the cookie it returns a token', async () => {
  const no = await call('POST', '/review/api/session', { ...who, ...PAGE }); assert.equal(no.status, 403); assert.equal(no.body, 'not available'); assert.equal(no.headers['set-cookie'], undefined);
  const yes = await call('POST', '/review/api/session', { ...who, cookie: ck, ...PAGE }); assert.equal(yes.status, 200); assert.equal(yes.headers['set-cookie'], undefined);
  const j = JSON.parse(yes.body); assert.equal(j.ok, true); assert.equal(typeof j.token, 'string'); assert.ok(j.token.length >= 16);
});
test('page stop and WhatsApp start see one state: stop through /review/api/posting, then handle(bpa start) answers the pinned release text; and the other way round', async () => {
  const tok = await tokenOf();
  const s = await act('posting', tok, { action: 'stop' }); assert.equal(s.status, 200, s.body); assert.equal(JSON.parse(s.body).ok, true);
  assert.equal(await handle('bpa start', {}), '▶️ started. Publishing, scheduling and drafting are allowed again.');
  assert.match(await handle('bpa stop', {}), /^🛑 Stopped\./);
  const st = await act('posting', tok, { action: 'start' }); assert.equal(st.status, 200, st.body); assert.equal(JSON.parse(st.body).ok, true);
  assert.equal(await handle('bpa start', {}), 'ℹ️ it was not stopped.');
});
