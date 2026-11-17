import './test-env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createReviewHandler } from './review-routes.js';
import { createSessions } from './review-auth.js';
import { writeAccess, goodHeaders, OWNER, HOST } from './review-test-kit.js';

const login = goodHeaders(); const nav = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' };
const VER = 'a'.repeat(64);
const GOOD = { kind: 'hook', id: 'idea_1', version: VER, action: 'approve' };
const FNS = ['approveHook', 'skipHook', 'unapproveHook', 'editHook', 'approveClip', 'skipClip', 'unapproveClip'];
let clock = 1e9; let dir, recordFile, logs, srv, port, sessions, issueCalls, calls, reply, loads, stopped, postCalls, handlerSessions;
const mkStubs = () => Object.fromEntries(FNS.map((f) => [f, async (req, ctx) => { calls.push({ f, req }); ctx.record({ kind: req.kind, id: req.id, version: req.version, decision: req.action }); return typeof reply === 'function' ? reply(req) : reply; }]));
async function start(over = {}) {
  sessions = over.sessions || createSessions({ now: () => clock });
  const realIssue = sessions.issue.bind(sessions); sessions.issue = () => { issueCalls += 1; return realIssue(); };
  const h = createReviewHandler({
    sessions, loadInputs: () => { loads += 1; return { readHooks: () => ({ ok: true, hooks: [] }), loadPool: () => ({ ok: true, ideas: [], sourceNames: {} }), readManifest: () => ({ clips: [] }), libraryDir: dir, info: { get: async () => 'x' }, secret: 's', evaluate: async () => ({ ok: true, draft: { hook: 'h', caption: 'SECRETCAPTION' } }) }; },
    loadActions: () => mkStubs(), recordFile, log: (m) => logs.push(m), cacheMs: 60000, previewDir: path.join(dir, 'previews'),
    postingOpts: { stop: () => { postCalls.push('stop'); stopped = true; return { note: 'n' }; }, start: () => { postCalls.push('start'); stopped = false; }, readStatus: () => ({ stop: { stopped } }) },
  });
  const s = http.createServer((q, r) => { if (!h(q, r)) { r.statusCode = 418; r.end(); } }); await new Promise((r) => s.listen(0, '127.0.0.1', r)); return s;
}
const call = (p, headers = {}, { method = 'GET', body, port: pt = port } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port: pt, path: p, method, headers: Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined)) }, (res) => { const bufs = []; res.on('data', (b) => bufs.push(b)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(bufs) })); });
  r.on('error', reject); if (body !== undefined) r.write(body); r.end(); });
async function cookieFrom(pt = port) { const r = await call('/review/', { ...login, ...nav }, { port: pt }); return r.headers['set-cookie'][0].split(';')[0]; }
let ck, tok;
const H = (over = {}) => ({ ...login, cookie: ck, 'x-bpa-action': tok, 'content-type': 'application/json', ...over });
const post = (p, obj, over = {}) => { const body = typeof obj === 'string' ? obj : JSON.stringify(obj); return call(p, H({ 'content-length': Buffer.byteLength(body), ...over }), { method: 'POST', body }); };
const getTok = async (cookie = ck, pt = port) => JSON.parse((await call('/review/api/session', { ...login, cookie, 'x-bpa-page': '1' }, { method: 'POST', port: pt })).body).token;
// raw socket: send the given text, collect the answer until close or ms
const raw = (text, { ms = 1500, port: pt = port } = {}) => new Promise((resolve) => { const s = net.connect(pt, '127.0.0.1', () => s.write(text)); let d = ''; const t = setTimeout(() => { s.destroy(); resolve({ data: d, closed: false }); }, ms); s.on('data', (b) => { d += b; }); s.on('close', () => { clearTimeout(t); resolve({ data: d, closed: true }); }); s.on('error', () => {}); });
const headText = (h) => Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n');

beforeEach(async () => {
  clock += 5000; dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-dr-')); recordFile = path.join(dir, 'decisions.jsonl'); logs = []; issueCalls = 0; calls = []; loads = 0; stopped = false; postCalls = [];
  reply = { ok: true, change: { kind: 'hook', id: 'idea_1', decision: 'approved' } };
  writeAccess(); srv = await start(); port = srv.address().port; ck = await cookieFrom(); tok = await getTok(); issueCalls = 0;
});
afterEach(() => { srv.close(); });

test('session: needs login, Host, a valid cookie and the page header; a cookie-less call is refused and issues nothing (no Set-Cookie, zero calls to sessions.issue)', async () => {
  const rows = [['no cookie', { ...login, 'x-bpa-page': '1' }], ['no page header', { ...login, cookie: ck }], ['no login', { host: HOST, cookie: ck, 'x-bpa-page': '1' }], ['wrong host', { ...login, host: 'x.example.com:10000', cookie: ck, 'x-bpa-page': '1' }], ['wrong cookie', { ...login, cookie: `bpa_review=${'0'.repeat(64)}`, 'x-bpa-page': '1' }], ['page header not 1', { ...login, cookie: ck, 'x-bpa-page': '2' }]];
  for (const [n, h] of rows) { const r = await call('/review/api/session', h, { method: 'POST' }); assert.equal(r.status, 403, n); assert.equal(r.body.toString(), 'not available', n); assert.equal(r.headers['set-cookie'], undefined, n); }
  assert.equal(issueCalls, 0);
});
test('session: with a valid cookie returns the SAME 64-hex token every time, no Set-Cookie, Cache-Control no-store, and the token is not the cookie value', async () => {
  const a = await call('/review/api/session', { ...login, cookie: ck, 'x-bpa-page': '1' }, { method: 'POST' }); const b = await call('/review/api/session', { ...login, cookie: ck, 'x-bpa-page': '1' }, { method: 'POST' });
  const ja = JSON.parse(a.body), jb = JSON.parse(b.body); assert.equal(a.status, 200); assert.equal(ja.ok, true); assert.match(ja.token, /^[0-9a-f]{64}$/); assert.equal(ja.token, jb.token); assert.equal(ja.token, tok);
  assert.equal(a.headers['set-cookie'], undefined); assert.match(a.headers['cache-control'], /no-store/); assert.notEqual(ja.token, ck.split('=')[1]); assert.equal(issueCalls, 0);
});
test('renewal after a restart (C4): a header-marked fetch of the page address gets a new cookie from the page route (the cookie fix path); then session gives a token; then the same decide body that was refused 403 before succeeds', async () => {
  const s2 = await start({ sessions: createSessions({ now: () => clock }) }); const p2 = s2.address().port;
  try {
    const body = JSON.stringify(GOOD); const hh = { ...login, cookie: ck, 'x-bpa-action': tok, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
    assert.equal((await call('/review/api/decide', hh, { method: 'POST', body, port: p2 })).status, 403);
    const pg = await call('/review/', { ...login, 'x-bpa-page': '1' }, { port: p2 }); assert.equal(pg.status, 200); const c2 = pg.headers['set-cookie'][0].split(';')[0];
    const t2 = await getTok(c2, p2); const r = await call('/review/api/decide', { ...hh, cookie: c2, 'x-bpa-action': t2 }, { method: 'POST', body, port: p2 }); assert.equal(r.status, 200);
  } finally { s2.close(); }
});
test('the page route is the only route that sets a cookie: no answer of session, decide, posting, items or media carries Set-Cookie', async () => {
  const rs = [await call('/review/api/session', { ...login, cookie: ck, 'x-bpa-page': '1' }, { method: 'POST' }), await post('/review/api/decide', GOOD), await post('/review/api/posting', { action: 'stop' }), await call('/review/api/items', { ...login, cookie: ck }), await call(`/review/media/m_${'0'.repeat(32)}`, { ...login, cookie: ck }), await post('/review/api/decide', '{')];
  for (const r of rs) assert.equal(r.headers['set-cookie'], undefined);
  assert.equal(issueCalls, 0);
});
test('decide: every guard refuses alone (table of 9): no login, wrong Host, no cookie, wrong cookie, no token, token of another session, the cookie value as token, wrong content type 415, body over 2048 bytes 413 - and the action stub is never called', async () => {
  const other = createSessions({ now: () => clock }); clock += 5000; const oc = other.issue(); const otherTok = other.actionToken(oc);
  const body = JSON.stringify(GOOD); const len = { 'content-length': Buffer.byteLength(body) };
  const rows = [
    ['no login', 403, { host: HOST, cookie: ck, 'x-bpa-action': tok, 'content-type': 'application/json', ...len }],
    ['wrong host', 403, H({ host: 'x.example.com:10000', ...len })],
    ['no cookie', 403, { ...login, 'x-bpa-action': tok, 'content-type': 'application/json', ...len }],
    ['wrong cookie', 403, H({ cookie: `bpa_review=${'1'.repeat(64)}`, ...len })],
    ['no token', 403, { ...login, cookie: ck, 'content-type': 'application/json', ...len }],
    ['other session token', 403, H({ 'x-bpa-action': otherTok, ...len })],
    ['cookie as token', 403, H({ 'x-bpa-action': ck.split('=')[1], ...len })],
    ['wrong content type', 415, H({ 'content-type': 'text/plain', ...len })],
  ];
  const want = { 'no login': 'bad-login', 'wrong host': 'bad-host', 'no cookie': 'no-cookie', 'wrong cookie': 'bad-cookie', 'no token': 'no-token', 'other session token': 'bad-token', 'cookie as token': 'bad-token', 'wrong content type': 'content-type' };
  for (const [n, st, h] of rows) { logs.length = 0; const r = await call('/review/api/decide', h, { method: 'POST', body }); assert.equal(r.status, st, n); assert.equal(r.body.toString(), 'not available', n); assert.deepEqual(logs, [`review refused: ${want[n]} decide`], n); /* the exact guard that refused: a valid token with no or a wrong cookie can only be refused by the cookie check, not hidden by the token check */ }
  const big = JSON.stringify({ ...GOOD, text: 'x'.repeat(2100) }); const r = await call('/review/api/decide', H({ 'content-length': Buffer.byteLength(big) }), { method: 'POST', body: big }).catch(() => ({ status: 413 })); assert.equal(r.status, 413);
  assert.equal(calls.length, 0);
});
test('decide: GET, PUT, DELETE, HEAD answer 405 not available with a cookie and change nothing; OPTIONS with no cookie is 403, with a cookie 405; none carries an Access-Control-* header, on session, decide and posting alike (C5)', async () => {
  for (const p of ['/review/api/session', '/review/api/decide', '/review/api/posting']) {
    for (const m of ['PUT', 'DELETE', 'HEAD', 'OPTIONS', 'GET']) {
      const r = await call(p, { ...login, cookie: ck }, { method: m }); assert.equal(r.status, 405, `${p} ${m}`); if (m !== 'HEAD') assert.equal(r.body.toString(), 'not available'); assert.deepEqual(Object.keys(r.headers).filter((k) => /^access-control-/i.test(k)), [], `${p} ${m}`);
    }
    const o = await call(p, { ...login, origin: 'https://evil.example', 'access-control-request-method': 'POST' }, { method: 'OPTIONS' }); assert.equal(o.status, 403, p); assert.deepEqual(Object.keys(o.headers).filter((k) => /^access-control-/i.test(k)), []);
  }
  assert.equal(calls.length, 0); assert.equal(postCalls.length, 0);
});
test('every JSON and media answer carries Cross-Origin-Resource-Policy: same-origin, nosniff and no-store (C5): items, media, session, decide 200, decide 409, decide 400, posting, and the plain not available', async () => {
  const items = await call('/review/api/items', { ...login, cookie: ck });
  const mediaMiss = await call(`/review/media/m_${'0'.repeat(32)}`, { ...login, cookie: ck });
  const sess = await call('/review/api/session', { ...login, cookie: ck, 'x-bpa-page': '1' }, { method: 'POST' });
  const d200 = await post('/review/api/decide', GOOD); reply = { ok: false, code: 'stale' }; const d409 = await post('/review/api/decide', GOOD); const d400 = await post('/review/api/decide', '{"x":1}');
  const pst = await post('/review/api/posting', { action: 'stop' }); const na = await call('/review/api/decide', login, { method: 'POST' });
  for (const [n, r] of Object.entries({ items, mediaMiss, sess, d200, d409, d400, pst, na })) { assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin', n); assert.equal(r.headers['x-content-type-options'], 'nosniff', n); assert.match(r.headers['cache-control'], /no-store/, n); }
  assert.deepEqual([d200.status, d409.status, d400.status, pst.status, na.status], [200, 409, 400, 200, 403]);
});
test('body size is counted in BYTES: 1025 times the two-byte character e-acute is 2050 bytes and 1025 characters and gets 413 (with and without Content-Length); exactly 2048 bytes is read; the action stub is not called for the 413', async () => {
  const e = 'é'.repeat(1025); assert.equal(e.length, 1025); assert.equal(Buffer.byteLength(e), 2050);
  const bodyOf = (s) => `{"kind":"hook","id":"${s}","version":"${VER}","action":"approve"}`;
  const over = bodyOf(e.slice(0, 1025)); const hdr = { ...H(), 'content-length': Buffer.byteLength(over) };
  const r1 = await raw(`POST /review/api/decide HTTP/1.1\r\n${headText(hdr)}\r\nConnection: close\r\n\r\n${over}`); assert.match(r1.data, /^HTTP\/1\.1 413/);
  const hdr2 = { ...H() }; const chunk = Buffer.from(over); const r2 = await raw(`POST /review/api/decide HTTP/1.1\r\n${headText(hdr2)}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${chunk.length.toString(16)}\r\n${over}\r\n0\r\n\r\n`); assert.match(r2.data, /^HTTP\/1\.1 413/);
  assert.equal(calls.length, 0);
  // exactly 2048 bytes: id of 'e-acute' * k padded to hit 2048 total
  const base = Buffer.byteLength(bodyOf('')); const idLen = 2048 - base; const id = 'é'.repeat(Math.floor(idLen / 2)) + (idLen % 2 ? 'x' : '');
  const exact = bodyOf(id); assert.equal(Buffer.byteLength(exact), 2048);
  const ok = await call('/review/api/decide', H({ 'content-length': 2048 }), { method: 'POST', body: exact }); assert.notEqual(ok.status, 413); assert.equal(calls.length, 0, 'id over 200 characters is a bad request, read fully'); assert.equal(ok.status, 400);
  const chunked = await raw(`POST /review/api/decide HTTP/1.1\r\n${headText(H())}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${Buffer.byteLength(exact).toString(16)}\r\n${exact}\r\n0\r\n\r\n`); assert.match(chunked.data, /^HTTP\/1\.1 400/);
});
test('Content-Length first: a declared length of 99999 with no body sent is answered 413 at once, with Connection: close, and the socket ends; the body is never awaited', async () => {
  const t0 = Date.now(); const r = await raw(`POST /review/api/decide HTTP/1.1\r\n${headText({ ...H(), 'content-length': 99999 })}\r\n\r\n`, { ms: 3000 });
  assert.match(r.data, /^HTTP\/1\.1 413/); assert.match(r.data, /connection: close/i); assert.equal(r.closed, true); assert.ok(Date.now() - t0 < 1500); assert.equal(calls.length, 0);
});
test('a malformed Content-Length (letters, negative) is refused 413 before any body is read', async () => {
  for (const v of ['abc', '-5', '12x', '1e3']) { const r = await raw(`POST /review/api/decide HTTP/1.1\r\n${headText({ ...H(), 'content-length': v })}\r\n\r\n`, { ms: 3000 }); assert.match(r.data, /^HTTP\/1\.1 (413|400)/, v); /* node's own parser answers 400 to a malformed length before our code runs; either way no body is read */ }
  assert.equal(calls.length, 0);
});
test('decide: a good request reaches the action once with the claimed login from the private file, answers 200, and the items cache is dropped', async () => {
  await call('/review/api/items', { ...login, cookie: ck }); await call('/review/api/items', { ...login, cookie: ck }); assert.equal(loads, 1, 'cached');
  const r = await post('/review/api/decide', GOOD); assert.equal(r.status, 200); const j = JSON.parse(r.body); assert.equal(j.ok, true); assert.deepEqual(j.change, { kind: 'hook', id: 'idea_1', decision: 'approved' });
  assert.equal(calls.length, 1); assert.equal(calls[0].f, 'approveHook'); assert.deepEqual(calls[0].req, GOOD);
  const rec = JSON.parse(fs.readFileSync(recordFile, 'utf8').trim()); assert.equal(rec.claimedLogin, OWNER);
  await call('/review/api/items', { ...login, cookie: ck }); assert.equal(loads, 2, 'cache dropped');
});
test('decide: a refused action answers 409 with its code; a bad body 400; an unknown kind/action pair 400; nothing reaches the action', async () => {
  reply = { ok: false, code: 'version-changed' }; const a = await post('/review/api/decide', GOOD); assert.equal(a.status, 409); assert.deepEqual(JSON.parse(a.body), { ok: false, code: 'version-changed' }); assert.equal(calls.length, 1);
  calls = [];
  for (const b of ['{', '[]', '{"kind":"hook"}', JSON.stringify({ ...GOOD, extra: 1 }), JSON.stringify({ ...GOOD, kind: 'clip', action: 'edit', text: 'x' }), JSON.stringify({ ...GOOD, action: 'nuke' })]) { const r = await post('/review/api/decide', b); assert.equal(r.status, 400, b); assert.deepEqual(JSON.parse(r.body), { ok: false, code: 'bad-request' }); }
  assert.equal(calls.length, 0);
});
test('closed set at the route (C1): an action stub that answers code "Edited text Lions at dawn" (or one longer than 60 characters, or with a newline) gives 409 check-failed; neither the response nor any log line contains that text; final-check:rule-9 gives final-check', async () => {
  for (const code of ['Edited text Lions at dawn', 'a'.repeat(61), 'stale\nx', 'unknown-code']) { reply = { ok: false, code }; const r = await post('/review/api/decide', GOOD); assert.equal(r.status, 409); assert.equal(JSON.parse(r.body).code, 'check-failed'); assert.ok(!r.body.toString().includes('Lions')); }
  reply = { ok: false, code: 'final-check:rule-9' }; const r = await post('/review/api/decide', GOOD); assert.equal(JSON.parse(r.body).code, 'final-check');
  assert.ok(!logs.join('\n').includes('Lions'));
});
test('ids __proto__ and constructor reach the action as plain strings and the route table is not confused by the paths /review/api/__proto__ and /review/api/constructor (404)', async () => {
  for (const id of ['__proto__', 'constructor']) { const r = await post('/review/api/decide', { ...GOOD, id }); assert.equal(r.status, 200); }
  assert.deepEqual(calls.map((c) => c.req.id), ['__proto__', 'constructor']);
  for (const p of ['/review/api/__proto__', '/review/api/constructor', '/review/api/toString']) { const r = await call(p, { ...login, cookie: ck }); assert.equal(r.status, 404, p); }
});
test('posting: needs the same five guards; stop and start call the shared functions (stub) and the answer is read back from the status, not from the reply', async () => {
  const body = JSON.stringify({ action: 'stop' });
  for (const [h, why] of [[{ cookie: undefined }, 'no-cookie'], [{ cookie: `bpa_review=${'1'.repeat(64)}` }, 'bad-cookie'], [{ 'x-bpa-action': undefined }, 'no-token'], [{ 'content-type': 'text/plain' }, 'content-type'], [{ host: 'x.example.com:10000' }, 'bad-host'], [{ 'tailscale-user-login': 'no@example.com' }, 'bad-login']]) { logs.length = 0; const r = await call('/review/api/posting', H({ 'content-length': body.length, ...h }), { method: 'POST', body }); assert.ok([403, 415].includes(r.status)); assert.deepEqual(logs, [`review refused: ${why} posting`], why); }
  assert.deepEqual(postCalls, []);
  const a = await post('/review/api/posting', { action: 'stop' }); assert.equal(a.status, 200); assert.deepEqual(postCalls, ['stop']);
  const b = await post('/review/api/posting', { action: 'start' }); assert.equal(b.status, 200); assert.deepEqual(postCalls, ['stop', 'start']);
  const bad = await post('/review/api/posting', { action: 'fly' }); assert.equal(bad.status, 400);
});
test('logs hold codes only: no id, hook text, header value, cookie or token in any log line after a full set of calls', async () => {
  await post('/review/api/decide', GOOD); reply = { ok: false, code: 'Edited text' }; await post('/review/api/decide', GOOD); await post('/review/api/decide', '{'); await post('/review/api/posting', { action: 'stop' });
  await call('/review/api/decide', { ...login, cookie: ck }, { method: 'POST' }); await call('/review/api/items', { ...login, cookie: ck }); await call('/review/api/session', { ...login, 'x-bpa-page': '1' }, { method: 'POST' });
  const all = logs.join('\n'); assert.ok(all.length > 0); for (const s of [OWNER, HOST, tok, ck.split('=')[1], 'idea_1', 'SECRETCAPTION', 'Edited text']) assert.ok(!all.includes(s), s);
  assert.match(all, /review decision: approve hook ok/); assert.match(all, /review decision: approve hook refused check-failed/);
});
test('no route writes config.json: its bytes and mtime are identical after every route was called', async () => {
  const f = path.join(path.dirname(new URL(import.meta.url).pathname), 'config.json'); const before = fs.readFileSync(f); const m0 = fs.statSync(f).mtimeMs;
  await post('/review/api/decide', GOOD); await post('/review/api/posting', { action: 'stop' }); await post('/review/api/posting', { action: 'start' }); await call('/review/api/items', { ...login, cookie: ck }); await call('/review/api/session', { ...login, cookie: ck, 'x-bpa-page': '1' }, { method: 'POST' });
  assert.ok(before.equals(fs.readFileSync(f))); assert.equal(fs.statSync(f).mtimeMs, m0);
});

// ── review fixes: SR1, a same-origin check on every state-changing request (not on the page load) ───────────────────────
const sf = (v) => ({ 'sec-fetch-site': v });
test('SR1: decide, posting and session refuse Sec-Fetch-Site cross-site, same-site and none with the plain answer and the code cross-site; the action is never reached and no record is written', async () => {
  const dec = JSON.stringify(GOOD); const pst = JSON.stringify({ action: 'stop' });
  for (const v of ['cross-site', 'same-site', 'none', 'Cross-Site', '']) {
    for (const [route, body] of [['decide', dec], ['posting', pst]]) {
      logs.length = 0; const r = await post(`/review/api/${route}`, body, sf(v));
      assert.equal(r.status, 403, `${route} ${v}`); assert.equal(r.body.toString(), 'not available', `${route} ${v}`); assert.deepEqual(logs, [`review refused: cross-site ${route}`], `${route} ${v}`);
    }
    logs.length = 0; const s = await call('/review/api/session', { ...login, cookie: ck, 'x-bpa-page': '1', ...sf(v) }, { method: 'POST' });
    assert.equal(s.status, 403, `session ${v}`); assert.equal(s.body.toString(), 'not available'); assert.deepEqual(logs, ['review refused: cross-site session'], `session ${v}`);
  }
  assert.equal(calls.length, 0); assert.deepEqual(postCalls, []); assert.equal(fs.existsSync(recordFile), false);
});
test('SR1: same-origin and a request with no Sec-Fetch-Site header are accepted on all three routes (older browsers, the bridge, the existing tests)', async () => {
  for (const extra of [sf('same-origin'), {}]) {
    const d = await post('/review/api/decide', GOOD, extra); assert.equal(d.status, 200, JSON.stringify(extra));
    const p = await post('/review/api/posting', { action: 'stop' }, extra); assert.equal(p.status, 200, JSON.stringify(extra));
    const s = await call('/review/api/session', { ...login, cookie: ck, 'x-bpa-page': '1', ...extra }, { method: 'POST' }); assert.equal(s.status, 200, JSON.stringify(extra));
  }
});
test('SR1: the guard order is kept: a cross-site request with a wrong token is refused by the token check first (no-token), by the cookie check before that', async () => {
  logs.length = 0; const a = await call('/review/api/decide', { ...login, cookie: ck, 'content-type': 'application/json', 'content-length': 2, ...sf('cross-site') }, { method: 'POST', body: '{}' });
  assert.equal(a.status, 403); assert.deepEqual(logs, ['review refused: no-token decide']);
  logs.length = 0; const b = await call('/review/api/decide', { ...login, 'x-bpa-action': tok, 'content-type': 'application/json', 'content-length': 2, ...sf('cross-site') }, { method: 'POST', body: '{}' });
  assert.equal(b.status, 403); assert.deepEqual(logs, ['review refused: no-cookie decide']);
});
test('SR1: the page load is NOT subject to it: a cross-site document navigation (a link in a chat app) still gets the page and a cookie; a cross-site page request that is not a navigation is still refused as before', async () => {
  clock += 5000; const a = await call('/review/', { ...login, ...nav, ...sf('cross-site') }); assert.equal(a.status, 200); assert.match(String(a.headers['set-cookie']), /bpa_review=/); assert.match(a.headers['content-type'], /text\/html/);
  clock += 5000; const b = await call('/review/', { ...login, ...nav, ...sf('none') }); assert.equal(b.status, 200, 'a typed address arrives as none'); assert.match(String(b.headers['set-cookie']), /bpa_review=/);
  clock += 5000; const c = await call('/review/', { ...login, 'sec-fetch-dest': 'image', 'sec-fetch-mode': 'no-cors', ...sf('cross-site') }); assert.equal(c.status, 403); assert.equal(c.headers['set-cookie'], undefined);
});

test('SR4: the posting route passes seen to runPosting: a Start that names a different stop than the one now in force answers 409 stop-changed (plain code in the log), nothing is released; the matching one releases', async () => {
  // a server whose status reads a reason, like the real stop status
  let reason = 'stopped by flag since 2026-11-17T09:00:00.000Z'; stopped = true;
  const h = createReviewHandler({ sessions: createSessions({ now: () => clock }), loadInputs: () => ({ readHooks: () => ({ ok: true, hooks: [] }), loadPool: () => ({ ok: true, ideas: [], sourceNames: {} }), readManifest: () => ({ clips: [] }), libraryDir: dir, info: { get: async () => 'x' }, secret: 's', evaluate: async () => ({ ok: true, draft: {} }) }), loadActions: () => mkStubs(), recordFile, log: (m) => logs.push(m), cacheMs: 60000, previewDir: path.join(dir, 'previews'),
    postingOpts: { stop: () => ({}), start: () => { postCalls.push('start'); stopped = false; }, readStatus: () => ({ stop: { stopped, reason: stopped ? reason : null } }) } });
  const srv2 = http.createServer((q, r) => { if (!h(q, r)) { r.statusCode = 418; r.end(); } }); await new Promise((r) => srv2.listen(0, '127.0.0.1', r)); const p2 = srv2.address().port;
  try {
    clock += 5000; const c2 = await cookieFrom(p2); const t2 = await getTok(c2, p2);
    const go = (obj) => { const body = JSON.stringify(obj); return call('/review/api/posting', { ...login, cookie: c2, 'x-bpa-action': t2, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, { method: 'POST', body, port: p2 }); };
    logs.length = 0; const a = await go({ action: 'start', seen: 'stopped by flag since 2026-11-17T08:00:00.000Z' });
    assert.equal(a.status, 409); assert.deepEqual(JSON.parse(a.body), { ok: false, code: 'stop-changed' }); assert.deepEqual(postCalls, []); assert.ok(logs.includes('review decision: start posting refused stop-changed'));
    const b = await go({ action: 'start', seen: reason }); assert.equal(b.status, 200); assert.deepEqual(postCalls, ['start']);
  } finally { srv2.close(); }
});

test('SR5: a client that hangs up in the middle of the body is logged as client-aborted, not as body-size; nothing reaches the action', async () => {
  const body = '{"kind":"hook","id":"idea_1"'; const head = { ...H({ 'content-length': 120 }), host: HOST };
  await new Promise((resolve) => { const s = net.connect(port, '127.0.0.1', () => { s.write(`POST /review/api/decide HTTP/1.1\r\n${headText(head)}\r\n\r\n${body}`); setTimeout(() => { s.destroy(); resolve(); }, 80); }); s.on('error', () => {}); });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(logs.includes('review refused: client-aborted decide'), JSON.stringify(logs)); assert.ok(!logs.some((l) => l.includes('body-size')), JSON.stringify(logs)); assert.equal(calls.length, 0);
});
test('SR5: a body that is really too large is still logged as body-size', async () => {
  const big = JSON.stringify({ ...GOOD, text: 'x'.repeat(2100) }); logs.length = 0;
  await post('/review/api/decide', big).catch(() => ({})); await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(logs, ['review refused: body-size decide']); assert.equal(calls.length, 0);
});

test('lock file: the posting route uses the handler env for the decision lock (a non-default state folder): a Start record contends with a decision holding that lock', async () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-dr2-')); const env2 = { ...process.env, BPA_STATE_DIR: path.join(d2, 'state') }; fs.mkdirSync(env2.BPA_STATE_DIR, { recursive: true, mode: 0o700 }); { const f = path.join(env2.BPA_STATE_DIR, 'bpa-review-access.json'); fs.writeFileSync(f, JSON.stringify({ ownerLogin: OWNER, host: HOST })); fs.chmodSync(f, 0o600); } // the access file lives in the state folder
  const h = createReviewHandler({ sessions: createSessions({ now: () => clock }), loadInputs: () => ({ readHooks: () => ({ ok: true, hooks: [] }), loadPool: () => ({ ok: true, ideas: [], sourceNames: {} }), readManifest: () => ({ clips: [] }), libraryDir: dir, info: { get: async () => 'x' }, secret: 's', evaluate: async () => ({ ok: true, draft: {} }) }), loadActions: () => mkStubs(), recordFile, log: (m) => logs.push(m), cacheMs: 60000, previewDir: path.join(dir, 'previews'), env: env2,
    postingOpts: { lockTimeoutMs: 80, stop: () => ({}), start: () => { postCalls.push('start'); stopped = false; }, readStatus: () => ({ stop: { stopped } }) } });
  const srv2 = http.createServer((q, r) => { if (!h(q, r)) { r.statusCode = 418; r.end(); } }); await new Promise((r) => srv2.listen(0, '127.0.0.1', r)); const p2 = srv2.address().port;
  try {
    clock += 5000; const c2 = await cookieFrom(p2); const t2 = await getTok(c2, p2); stopped = true;
    const go = () => { const body = JSON.stringify({ action: 'start' }); return call('/review/api/posting', { ...login, cookie: c2, 'x-bpa-action': t2, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, { method: 'POST', body, port: p2 }); };
    const { withDecisionLock } = await import('./decision-lock.js'); let release; const held = withDecisionLock(() => new Promise((r) => { release = r; }), { env: env2 }); await new Promise((r) => setTimeout(r, 30));
    const a = await go(); assert.equal(a.status, 409); assert.deepEqual(JSON.parse(a.body), { ok: false, code: 'record-failed' }); assert.deepEqual(postCalls, []);
    release(); await held; const b = await go(); assert.equal(b.status, 200); assert.deepEqual(postCalls, ['start']);
  } finally { srv2.close(); }
});
