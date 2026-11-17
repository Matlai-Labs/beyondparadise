import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs';
import { loadAccess, createSessions, setCookieHeader, checkAccess, checkHealthAccess, loopbackHost, hasProxyHeaders, isPageLoad, PAGE_HEADER, COOKIE_NAME } from './review-auth.js';
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
test('sessions: 64 hex, distinct, unknown invalid', () => { let t = 0; const s = createSessions({ now: () => t }); const a = s.issue(); t = 2000; const b = s.issue(); assert.match(a, /^[0-9a-f]{64}$/); assert.notEqual(a, b); assert.equal(s.valid('nope'), false); assert.equal(s.valid(undefined), false); assert.equal(s.count(), 2); });
test('E8: at most one new session per 2 s: a flood issues exactly one', () => {
  let t = 0; const s = createSessions({ now: () => t }); let got = 0; for (let i = 0; i < 1000; i++) if (s.issue()) got += 1; assert.equal(got, 1);
  t = 1999; assert.equal(s.issue(), null); t = 2000; assert.ok(s.issue()); assert.equal(s.count(), 2);
});
test('E8: a session younger than 60 s is never evicted; an older one is, oldest first; the cap is 50', () => {
  let t = 0; const s = createSessions({ now: () => t, max: 3 }); const a = s.issue(); t = 2000; const b = s.issue(); t = 4000; const c = s.issue();
  t = 6000; assert.equal(s.issue(), null, 'full of young sessions: nothing is evicted, nothing is issued'); assert.ok(s.valid(a) && s.valid(b) && s.valid(c));
  t = 60000; const d = s.issue(); assert.ok(d); assert.equal(s.valid(a), false, 'the oldest, 60 s old, made room'); assert.ok(s.valid(b) && s.valid(c) && s.valid(d)); assert.equal(s.count(), 3);
  t = 59999; const u = createSessions({ now: () => t, max: 1 }); t = 0; const first = u.issue(); t = 59999; assert.equal(u.issue(), null); assert.ok(u.valid(first));
  let t2 = 0; const big = createSessions({ now: () => t2 }); for (let i = 0; i < 60; i++) { t2 = i * 2000; big.issue(); } assert.ok(big.count() <= 50);
});
test('E9: proxy headers are recognised: x-forwarded-for, -host, -proto and anything tailscale-*', () => {
  for (const h of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'tailscale-user-login', 'tailscale-anything', 'X-Forwarded-For']) assert.equal(hasProxyHeaders(fakeReq({ host: '127.0.0.1:3028', [h]: 'x' })), true, h);
  for (const h of ['x-bpa-token', 'content-type', 'user-agent', 'x-forwarded', 'xtailscale-a']) assert.equal(hasProxyHeaders(fakeReq({ host: '127.0.0.1:3028', [h]: 'x' })), false, h);
});
test('cookie header has every attribute and the token once', () => { const c = setCookieHeader('T0K', 43200e3); for (const p of ['bpa_review=T0K', 'HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/review', 'Max-Age=43200']) assert.ok(c.includes(p), p); assert.equal(c.split('T0K').length, 2); });
test('a refusal never carries header values', () => { const r = checkAccess(fakeReq(goodHeaders({ 'tailscale-user-login': 'x@example.com' })), { access: A, sessions: createSessions(), needCookie: false }); const j = JSON.stringify(r); assert.ok(!j.includes('x@example.com') && !j.includes(HOST) && !j.includes(OWNER)); });
test('health rule: loopback passes as today; any other Host needs login AND cookie', () => {
  const s = createSessions(); const tok = s.issue(); const p = 3028; const run = (h) => checkHealthAccess(fakeReq(h), { port: p, access: A, sessions: s });
  for (const h of ['127.0.0.1:3028', 'localhost:3028', 'LOCALHOST:3028']) assert.equal(run({ host: h }).ok, true, h);
  assert.equal(checkHealthAccess(fakeReq({ host: '127.0.0.1:3028' }), { port: p, access: { ok: false }, sessions: s }).ok, true, 'worker unaffected by a broken settings file');
  assert.equal(run({ host: '127.0.0.1:3029' }).reason, 'bad-host'); assert.equal(run({ host: HOST }).reason, 'bad-login');
  assert.equal(run(goodHeaders()).reason, 'no-cookie'); assert.equal(run(goodHeaders({ cookie: `${COOKIE_NAME}=${tok}` })).ok, true); });
test('E9: health on a loopback Host with a proxy header falls under the login and cookie rule', () => {
  const s = createSessions(); const tok = s.issue(); const run = (h) => checkHealthAccess(fakeReq(h), { port: 3028, access: A, sessions: s });
  for (const h of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'tailscale-user-login']) { const r = run({ host: '127.0.0.1:3028', [h]: 'x' }); assert.equal(r.ok, false, h); assert.equal(r.reason, 'bad-host', h); }
  assert.equal(run({ host: '127.0.0.1:3028' }).ok, true); assert.equal(run(goodHeaders({ cookie: `${COOKIE_NAME}=${tok}`, 'x-forwarded-for': '100.64.0.1' })).ok, true, 'the real published path still works');
});
test('loopbackHost is exact', () => { assert.equal(loopbackHost('127.0.0.1:3028', 3028), true); for (const h of ['[::1]:3028', '127.0.0.1', '127.0.0.1:3028.', undefined, '']) assert.equal(loopbackHost(h, 3028), false, String(h)); });

test('change 4: tooSoon is true only inside the 2 s gap after a new session', () => {
  let t = 1e6; const s = createSessions({ now: () => t }); assert.equal(s.tooSoon(), false); assert.ok(s.issue()); assert.equal(s.tooSoon(), true); assert.equal(s.issue(), null); t += 2000; assert.equal(s.tooSoon(), false);
});

test('isPageLoad: only a document navigation or the page header counts', () => {
  const r = (h) => isPageLoad({ headers: h }); assert.equal(PAGE_HEADER, 'x-bpa-page');
  for (const h of [{ 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' }, { 'sec-fetch-dest': ' Document ', 'sec-fetch-mode': 'NAVIGATE' }, { 'x-bpa-page': '1' }, { 'x-bpa-page': '1', 'sec-fetch-dest': 'image' }]) assert.equal(r(h), true, JSON.stringify(h));
  for (const h of [{ 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'no-cors' }, { 'sec-fetch-dest': 'image', 'sec-fetch-mode': 'no-cors' }, { 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' }, { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate' }, { 'sec-fetch-dest': 'document' }, { 'sec-fetch-mode': 'navigate' }, {},
    { 'x-bpa-page': '0' }, { 'x-bpa-page': 'true' }, { 'x-bpa-page': '11' }, { 'x-bpa-page': '' }, { 'x-bpa-page': ['1'] }, { 'x-bpa-page': ['1', '1'] }, { 'sec-fetch-dest': ['document'], 'sec-fetch-mode': 'navigate' }, { 'sec-fetch-dest': 'document', 'sec-fetch-mode': ['navigate'] }]) assert.equal(r(h), false, JSON.stringify(h));
  assert.equal(isPageLoad(undefined), false); assert.equal(isPageLoad({}), false); assert.equal(isPageLoad(null), false);
});
