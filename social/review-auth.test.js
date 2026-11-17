import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs';
import { loadAccess, createSessions, setCookieHeader, checkAccess, checkHealthAccess, loopbackHost, COOKIE_NAME } from './review-auth.js';
import { writeAccess, fakeReq, goodHeaders, OWNER, HOST } from './review-test-kit.js';
const A = { ok: true, ownerLogin: OWNER, host: HOST };
test('loadAccess accepts the file with trailing newlines', () => { writeAccess({ raw: JSON.stringify({ ownerLogin: OWNER, host: HOST }) + '\n\n' }); assert.deepEqual(loadAccess(), A); });
test('loadAccess refuses a file others can read', () => { writeAccess({ mode: 0o644 }); assert.deepEqual(loadAccess(), { ok: false, reason: 'access-file-mode' }); });
test('loadAccess fails closed: missing and malformed', () => {
  fs.rmSync(writeAccess(), { force: true }); assert.equal(loadAccess().reason, 'access-file-missing');
  for (const raw of ['{nope', '[]', '{"ownerLogin":"","host":"a.b:1"}', `{"ownerLogin":"${OWNER}","host":"device.example.ts.net"}`, `{"ownerLogin":"a@example.com, d@example.com","host":"${HOST}"}`, `{"ownerLogin":"${OWNER}"}`])
    { writeAccess({ raw }); assert.equal(loadAccess().reason, 'access-file-malformed', raw); } });
test('access file unusable gives 503 even with perfect headers', () => { const r = checkAccess(fakeReq(goodHeaders()), { access: { ok: false, reason: 'access-file-missing' }, sessions: createSessions(), needCookie: false }); assert.deepEqual([r.ok, r.code, r.reason], [false, 503, 'access-file-unavailable']); });
test('Host must match exactly (case-insensitive)', () => {
  const run = (h) => checkAccess(fakeReq(goodHeaders({ host: h })), { access: A, sessions: createSessions(), needCookie: false });
  assert.equal(run(HOST.toUpperCase()).ok, true);
  for (const h of ['device.example.ts.net:10001', 'device.example.ts.net', 'device.example.ts.net.:10000', 'other.example.com:10000', '127.0.0.1:3028', undefined]) { const r = run(h); assert.deepEqual([r.ok, r.code, r.reason], [false, 403, 'bad-host'], String(h)); } });
test('login must be the owner: other case ok; missing, other, duplicated, empty refused', () => {
  const run = (v) => checkAccess(fakeReq(goodHeaders({ 'tailscale-user-login': v })), { access: A, sessions: createSessions(), needCookie: false });
  assert.equal(run('OWNER@example.com').ok, true);
  for (const v of [undefined, '', 'other@example.com', `${OWNER}, ${OWNER}`, `${OWNER}, other@example.com`, 'o']) assert.equal(run(v).reason, 'bad-login', String(v)); });
test('cookie rule: none, wrong, expired, duplicated refused; valid passes', () => {
  let t = 0; const s = createSessions({ now: () => t, ttlMs: 1000 }); const tok = s.issue(); const run = (c) => checkAccess(fakeReq(goodHeaders(c === undefined ? {} : { cookie: c })), { access: A, sessions: s, needCookie: true });
  assert.equal(run(undefined).reason, 'no-cookie'); assert.equal(run(`${COOKIE_NAME}=zzz`).reason, 'bad-cookie');
  assert.equal(run(`${COOKIE_NAME}=${tok}`).ok, true); assert.equal(run(`a=b; ${COOKIE_NAME}=${tok}`).ok, true);
  assert.equal(run(`${COOKIE_NAME}=zzz; ${COOKIE_NAME}=${tok}`).reason, 'bad-cookie');
  t = 1001; assert.equal(run(`${COOKIE_NAME}=${tok}`).reason, 'bad-cookie'); });
test('sessions: 64 hex, distinct, unknown invalid, oldest evicted past max', () => { const s = createSessions({ max: 2 }); const a = s.issue(), b = s.issue(); assert.match(a, /^[0-9a-f]{64}$/); assert.notEqual(a, b); assert.equal(s.valid('nope'), false); s.issue(); assert.equal(s.valid(a), false); assert.equal(s.count(), 2); });
test('cookie header has every attribute and the token once', () => { const c = setCookieHeader('T0K', 43200e3); for (const p of ['bpa_review=T0K', 'HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/review', 'Max-Age=43200']) assert.ok(c.includes(p), p); assert.equal(c.split('T0K').length, 2); });
test('a refusal never carries header values', () => { const r = checkAccess(fakeReq(goodHeaders({ 'tailscale-user-login': 'x@example.com' })), { access: A, sessions: createSessions(), needCookie: false }); const j = JSON.stringify(r); assert.ok(!j.includes('x@example.com') && !j.includes(HOST) && !j.includes(OWNER)); });
test('health rule: loopback passes as today; any other Host needs login AND cookie', () => {
  const s = createSessions(); const tok = s.issue(); const p = 3028; const run = (h) => checkHealthAccess(fakeReq(h), { port: p, access: A, sessions: s });
  for (const h of ['127.0.0.1:3028', 'localhost:3028', 'LOCALHOST:3028']) assert.equal(run({ host: h }).ok, true, h);
  assert.equal(checkHealthAccess(fakeReq({ host: '127.0.0.1:3028' }), { port: p, access: { ok: false }, sessions: s }).ok, true, 'worker unaffected by a broken settings file');
  assert.equal(run({ host: '127.0.0.1:3029' }).reason, 'bad-host'); assert.equal(run({ host: HOST }).reason, 'bad-login');
  assert.equal(run(goodHeaders()).reason, 'no-cookie'); assert.equal(run(goodHeaders({ cookie: `${COOKIE_NAME}=${tok}` })).ok, true); });
test('loopbackHost is exact', () => { assert.equal(loopbackHost('127.0.0.1:3028', 3028), true); for (const h of ['[::1]:3028', '127.0.0.1', '127.0.0.1:3028.', undefined, '']) assert.equal(loopbackHost(h, 3028), false, String(h)); });
