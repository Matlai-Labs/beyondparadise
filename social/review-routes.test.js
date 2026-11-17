import './test-env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { createReviewHandler, CSP, createDefaultInputs, ttlMemo } from './review-routes.js';
import { createSessions } from './review-auth.js';
import { fileInfoOf } from './review-items.js';
import { claimsSha256 } from './auto-hooks.js';
import { writeAccess, goodHeaders, OWNER, HOST } from './review-test-kit.js';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-routes-'));
const clip = (id) => ({ id, file: `${id}.mp4`, durationSec: 7, source: [{ videoId: 'v1', startSec: 1, endSec: 8 }], checks: { rendered: 'ok' }, flash: { flash: false }, verified: { verdict: 'pass', singleSubject: 'yes', notes: 'a lion' }, shows: { tags: ['lion'] } });
const IDEA = { id: 'idea_1', title: 'Lion fact', link: '/x/', claims: [{ text: 'Claim A', sourceDate: '2026-10-01' }] };
const login = goodHeaders(); const nav = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' };
let srvSessions; let dir, clipFile, accessFile, manifest, logs, srv, port, loads; let clock = 1e9;
let hashed = 0; const info = fileInfoOf({ hashFile: async (f) => { hashed += 1; return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } }); const SECRET = 'test-secret';
const inputs = () => { loads += 1; return {
  readHooks: () => ({ ok: true, hooks: [{ ideaId: 'idea_1', sourceId: null, hook: 'Hook one', claimsSha256: claimsSha256(IDEA), approvedBy: null, approvedAt: null }] }),
  loadPool: () => ({ ok: true, ideas: [IDEA], sourceNames: {} }), readManifest: () => manifest, libraryDir: dir, info, secret: SECRET,
  evaluate: async (i, { hook }) => ({ ok: true, draft: { hook, caption: 'SECRETCAPTION' } }) }; };
async function start({ cacheMs = 0 } = {}) {
  srvSessions = createSessions({ now: () => clock }); const h = createReviewHandler({ sessions: srvSessions, loadInputs: inputs, log: (m) => logs.push(m), cacheMs, previewDir: path.join(dir, 'previews') });
  srv = http.createServer((q, s) => { if (!h(q, s)) { s.statusCode = 418; s.end(); } }); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); port = srv.address().port;
}
const call = (p, headers = {}, { method = 'GET' } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => { const bufs = []; res.on('data', (b) => bufs.push(b)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(bufs) })); }); r.on('error', reject); r.end(); });
async function cookie() { const r = await call('/review/', { ...login, ...nav }); return r.headers['set-cookie'][0].split(';')[0]; }
let ck;
async function firstClipMedia() { const r = await call('/review/api/items', ck); const j = JSON.parse(r.body); return { id: j.items.find((i) => i.kind === 'clip').preview.mediaId }; }
const bump = (f) => { const t = new Date(Date.now() + 5000 + Math.floor(Math.random() * 1000)); fs.utimesSync(f, t, t); };

beforeEach(async () => {
  clock += 5000;
  dir = mk(); logs = []; loads = 0; for (const f of ['c1', 'c2']) fs.writeFileSync(path.join(dir, `${f}.mp4`), Buffer.alloc(1000, f.length)); clipFile = path.join(dir, 'c1.mp4');
  const t = new Date(Date.now() + 9000); fs.utimesSync(clipFile, t, t); // c1 is the newest, so it is the first clip item
  manifest = { clips: [clip('c1'), clip('c2')] }; accessFile = writeAccess(); await start();
  ck = { ...login, cookie: await cookie() }; a0 = ck.cookie;
});
afterEach(() => { srv.close(); });

let a0 = ''; test('page: 200 with cookie, CSP, nonce in header and body, hardening headers, fresh nonce each time', async () => {
  clock += 5000; const a = await call('/review/', { ...login, ...nav }), b = await call('/review/', { ...login, cookie: a0 }); assert.equal(a.status, 200); assert.match(a.headers['set-cookie'][0], /^bpa_review=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Secure; Path=\/review/);
  const n = /nonce-([0-9a-f]{32})/.exec(a.headers['content-security-policy'])[1]; assert.ok(a.body.toString().includes(`nonce="${n}"`)); assert.ok(!a.body.toString().includes('__NONCE__')); assert.notEqual(n, /nonce-([0-9a-f]{32})/.exec(b.headers['content-security-policy'])[1]);
  assert.equal(a.headers['content-security-policy'], CSP(n)); assert.equal(b.headers['set-cookie'], undefined, 'a request that already carries a valid cookie gets none'); assert.equal(a.headers['x-content-type-options'], 'nosniff'); assert.equal(a.headers['referrer-policy'], 'no-referrer'); assert.equal(a.headers['x-frame-options'], 'DENY'); assert.equal(a.headers['cache-control'], 'no-store'); assert.match(a.headers['content-type'], /^text\/html; charset=utf-8/);
});
test('CSP has exactly the allowed directives (E10: base-uri, form-action and frame-ancestors are shut)', () => assert.equal(CSP('N'), "default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-N'; media-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"));
test('every route refuses without login or Host, and without the cookie except the page', async () => {
  assert.equal((await call('/review/', { host: HOST })).status, 403); assert.equal((await call('/review/', goodHeaders({ host: 'x.example.com:10000' }))).status, 403);
  for (const p of ['/review/api/items', `/review/media/m_${'0'.repeat(32)}`, '/review/zzz']) { const r = await call(p, login); assert.equal(r.status, 403, p); assert.equal(r.body.toString(), 'not available'); assert.match(r.headers['content-type'], /^text\/plain/); assert.equal(r.headers['cache-control'], 'no-store'); }
  for (const p of ['/review/api/items', `/review/media/m_${'0'.repeat(32)}`]) assert.equal((await call(p, { host: HOST, cookie: ck.cookie })).status, 403, `cookie alone is not enough: ${p}`);
});
test('settings file missing gives 503 not available and a log line without values', async () => {
  fs.rmSync(accessFile); const r = await call('/review/', login); assert.equal(r.status, 503); assert.equal(r.body.toString(), 'not available');
  const all = logs.join('\n'); assert.match(all, /access-file-unavailable/); for (const s of [OWNER, HOST, 'SECRETCAPTION']) assert.ok(!all.includes(s));
});
test('settings file with group-readable mode gives 503', async () => { fs.chmodSync(accessFile, 0o644); assert.equal((await call('/review/', login)).status, 503); });
test('items: shape, counts, private cache header, no captions in logs', async () => {
  const r = await call('/review/api/items', ck); assert.equal(r.status, 200); assert.equal(r.headers['cache-control'], 'private, no-store'); const j = JSON.parse(r.body); assert.deepEqual(Object.keys(j).sort(), ['counts', 'items', 'problems', 'status']);
  for (const i of j.items) assert.deepEqual(Object.keys(i).sort(), ['actions', 'decision', 'facts', 'id', 'kind', 'preview', 'reason', 'state', 'title', 'usableToday', 'version']);
  assert.deepEqual(j.counts, { all: 3, hook: 1, clip: 2 }); assert.ok(!logs.join('\n').includes('SECRETCAPTION')); assert.ok(!r.body.toString().includes(dir), 'no path in the answer');
});
test('items are cached for cacheMs, not longer', async () => {
  srv.close(); await start({ cacheMs: 60000 }); ck = { ...login, cookie: await cookie() }; loads = 0;
  await call('/review/api/items', ck); await call('/review/api/items', ck); assert.equal(loads, 1);
  srv.close(); await start({ cacheMs: 0 }); ck = { ...login, cookie: await cookie() }; loads = 0;
  await call('/review/api/items', ck); await call('/review/api/items', ck); assert.equal(loads, 2);
});
test('media: 200 and 206 for an id from the list', async () => {
  const { id } = await firstClipMedia(); const full = await call(`/review/media/${id}`, ck); assert.equal(full.status, 200); assert.equal(full.body.length, 1000); assert.equal(full.headers['content-type'], 'video/mp4');
  const part = await call(`/review/media/${id}`, { ...ck, range: 'bytes=0-9' }); assert.equal(part.status, 206); assert.equal(part.body.length, 10);
  assert.equal((await call(`/review/media/${id}`, { ...ck, range: 'bytes=5000-' })).status, 416);
});
test('media needs the cookie', async () => { const { id } = await firstClipMedia(); assert.equal((await call(`/review/media/${id}`, login)).status, 403); });
test('media: an id that left the list is 404 once the next item list is built (focus 1)', async () => {
  const { id } = await firstClipMedia(); manifest = { clips: [] }; await call('/review/api/items', ck); assert.equal((await call(`/review/media/${id}`, ck)).status, 404);
});
test('D7: the media route never builds a list and never hashes: an id from before the first item list is 404; a request does not hash', async () => {
  await call('/review/', login); const before = hashed; assert.equal((await call(`/review/media/m_${'a'.repeat(32)}`, ck)).status, 404);
  const { id } = await firstClipMedia(); const afterItems = hashed; assert.ok(afterItems > before, 'the items build hashed the files'); assert.equal((await call(`/review/media/${id}`, ck)).status, 200); await call(`/review/media/${id}`, { ...ck, range: 'bytes=0-9' }); assert.equal(hashed, afterItems, 'no hashing on the media route');
});
test('media: after the file is replaced the old id is 404 and the new id works (focus 1, 4)', async () => {
  const old = (await firstClipMedia()).id; fs.writeFileSync(clipFile, 'x'.repeat(1000)); bump(clipFile);
  assert.equal((await call(`/review/media/${old}`, ck)).status, 404); const fresh = (await firstClipMedia()).id; assert.notEqual(fresh, old); assert.equal((await call(`/review/media/${fresh}`, ck)).status, 200);
});
test('media: ids shaped like paths or names are 404 and never read', async () => {
  for (const id of ['../c1.mp4', '%2e%2e%2fc1.mp4', 'c1.mp4', 'm_zz', `m_${'g'.repeat(32)}`, `m_${'0'.repeat(32)}`, `m_${'0'.repeat(32)}/x`, `m_${'0'.repeat(33)}`]) assert.equal((await call(`/review/media/${id}`, ck)).status, 404, id);
});
test('media: a clip file turned into a symlink is 404 and gets no id in the next list (E11)', async () => {
  const outside = path.join(mk(), 'outside.mp4'); fs.writeFileSync(outside, Buffer.alloc(1000, 7)); const old = (await firstClipMedia()).id;
  fs.rmSync(clipFile); fs.symlinkSync(outside, clipFile);
  assert.equal((await call(`/review/media/${old}`, ck)).status, 404, 'the old id: the file is a link now');
  const j = JSON.parse((await call('/review/api/items', ck)).body); const c1 = j.items.find((i) => i.id === 'c1'); assert.deepEqual([c1.state, c1.preview.mediaId], ['video missing', null]);
  assert.ok(!logs.join('\n').includes(outside));
});
test('non-GET is 405 after access; other paths are not handled', async () => {
  assert.equal((await call('/review/', login, { method: 'POST' })).status, 405); assert.equal((await call('/review/', { host: HOST }, { method: 'POST' })).status, 403, 'access comes first');
  assert.equal((await call('/other', login)).status, 418); assert.equal((await call('/health', login)).status, 418); assert.equal((await call('/reviewx/', login)).status, 418);
});
test('logs hold reason codes and route kinds only', async () => {
  await call('/review/', { host: HOST }); await call('/review/api/items', login); await call('/review/media/m_zz', ck); const all = logs.join('\n');
  assert.match(all, /review refused: bad-login page/); assert.match(all, /review refused: no-cookie items/);
  for (const s of [OWNER, HOST, ck.cookie.split('=')[1], 'm_zz']) assert.ok(!all.includes(s), s);
});
test('D7: a file that changed since the build is not served under its old id, even while the item list is cached (focus 1)', async () => {
  srv.close(); await start({ cacheMs: 60000 }); ck = { ...login, cookie: await cookie() };
  const { id } = await firstClipMedia(); assert.equal((await call(`/review/media/${id}`, ck)).status, 200); // the item list is now cached, id included
  fs.writeFileSync(clipFile, 'y'.repeat(1000)); bump(clipFile); assert.equal((await call(`/review/media/${id}`, ck)).status, 404, 'mtime changed');
  assert.equal((await firstClipMedia()).id, id, 'the cached list still shows the old id, which is simply not served');
});
test('D7: size-only and inode-only changes are caught too', async () => {
  srv.close(); await start({ cacheMs: 60000 }); ck = { ...login, cookie: await cookie() };
  const { id } = await firstClipMedia(); const st = fs.statSync(clipFile); fs.writeFileSync(clipFile, Buffer.alloc(900, 3)); fs.utimesSync(clipFile, st.atime, st.mtime); assert.equal((await call(`/review/media/${id}`, ck)).status, 404, 'size changed, mtime put back');
  const { id: id2 } = await (async () => { fs.writeFileSync(clipFile, Buffer.alloc(1000, 9)); bump(clipFile); srv.close(); await start({ cacheMs: 0 }); ck = { ...login, cookie: await cookie() }; return firstClipMedia(); })();
  assert.equal((await call(`/review/media/${id2}`, ck)).status, 200); const t = fs.statSync(clipFile); const copy = `${clipFile}.new`; fs.copyFileSync(clipFile, copy); fs.utimesSync(copy, t.atime, t.mtime); fs.renameSync(copy, clipFile);
  assert.equal((await call(`/review/media/${id2}`, ck)).status, 404, 'same bytes, size and mtime, other inode');
});
test('D7: ttlMemo caches a value for the time to live, a failure is not cached, a key keeps its own entry', async () => {
  let t = 0; let n = 0; const f = ttlMemo((k) => { n += 1; if (k === 'bad') throw new Error('x'); return `${k}${n}`; }, { ttlMs: 60000, now: () => t, key: (k) => k });
  assert.equal(f('a'), 'a1'); assert.equal(f('a'), 'a1'); assert.equal(f('b'), 'b2'); t = 59999; assert.equal(f('a'), 'a1'); t = 60001; assert.equal(f('a'), 'a3');
  assert.throws(() => f('bad')); assert.throws(() => f('bad')); assert.equal(n, 5);
  const g = ttlMemo(async (k) => { n += 1; if (k === 'bad') throw new Error('x'); return k; }, { ttlMs: 60000, now: () => t, key: (k) => k }); n = 0; await g('a'); await g('a'); assert.equal(n, 1); await assert.rejects(g('bad')); await assert.rejects(g('bad')); assert.equal(n, 3, 'a rejected promise is dropped');
});
test('D7: the default inputs cache the idea pool and the hook checks for 60 s', async () => {
  let t = 0; let pools = 0; let evals = 0; const d = createDefaultInputs({ env: process.env, now: () => t, loadPool: () => { pools += 1; return { ok: true, ideas: [], sourceNames: {} }; }, evaluateImpl: async () => { evals += 1; return { ok: true, draft: { hook: 'x' } }; } });
  d.loadPool(); d.loadPool(); assert.equal(pools, 1); const idea = { id: 'i1', title: 'T', claims: [{ text: 'c' }] };
  await d.evaluate(idea, { hook: 'H', sourceNames: {}, now: new Date() }); await d.evaluate(idea, { hook: 'H', sourceNames: {}, now: new Date() }); assert.equal(evals, 1);
  await d.evaluate(idea, { hook: 'H2', sourceNames: {}, now: new Date() }); assert.equal(evals, 2, 'another hook text is another check');
  await d.evaluate({ ...idea, claims: [{ text: 'changed' }] }, { hook: 'H', sourceNames: {}, now: new Date() }); assert.equal(evals, 3, 'changed claims are another check');
  t = 60001; d.loadPool(); await d.evaluate(idea, { hook: 'H', sourceNames: {}, now: new Date() }); assert.equal(pools, 2); assert.equal(evals, 4);
});
test('defaultInputs wires the lane\'s own readers and verdict (usage ledger, history, config, laneVerdict)', async () => {
  const { defaultInputs } = await import('./review-routes.js'); const d = defaultInputs();
  for (const k of ['readHooks', 'loadPool', 'readManifest', 'readUsage', 'readHistory', 'readConfig', 'laneVerdict', 'sourceFor', 'evaluate']) assert.equal(typeof d[k], 'function', k);
  assert.deepEqual(d.readUsage(), [], 'no ledger in the test state folder'); assert.equal(typeof d.readConfig(), 'object');
  assert.equal((await d.laneVerdict({ id: 'i', kind: 'rule', title: 'Lion', claims: [] }, { clips: [], history: [], config: {}, now: new Date() })).reason, 'no-matching-clip');
});

test('E8: page loads without a cookie are rate limited: one cookie, then 429 not available; a valid cookie always gets the page', async () => {
  clock += 10000; const first = await call('/review/', { ...login, ...nav }); assert.equal(first.status, 200); const c = first.headers['set-cookie'][0].split(';')[0];
  for (let i = 0; i < 5; i++) { const r = await call('/review/', { ...login, ...nav }); assert.equal(r.status, 429, 'a cookie-less flood'); assert.match(r.body.toString(), /One moment\. The page opens by itself\./); assert.equal(r.headers['set-cookie'], undefined); }
  const again = await call('/review/', { ...login, cookie: c }); assert.equal(again.status, 200); assert.equal(again.headers['set-cookie'], undefined);
  clock += 2000; assert.equal((await call('/review/', { ...login, ...nav })).status, 200, 'two seconds later a new one is allowed');
  assert.ok(logs.some((l) => /rate-limited page/.test(l)));
});
test('E8: a flood of page loads does not evict a live session', async () => {
  const live = ck; for (let i = 0; i < 28; i++) { clock += 2000; await call('/review/', { ...login, ...nav }); } // 56 s of flood, one new cookie per 2 s at best assert.equal((await call('/review/api/items', live)).status, 200);
});
test('E10: nosniff on every response of the review routes: page, items, media 200/206/416/404, refusals 403/404/405/429/503', async () => {
  const { id } = await firstClipMedia(); const all = [
    await call('/review/', ck), await call('/review/api/items', ck), await call(`/review/media/${id}`, ck), await call(`/review/media/${id}`, { ...ck, range: 'bytes=0-9' }), await call(`/review/media/${id}`, { ...ck, range: 'bytes=9999-' }),
    await call(`/review/media/m_${'0'.repeat(32)}`, ck), await call('/review/zzz', ck), await call('/review/', { host: HOST }), await call('/review/', login, { method: 'POST' })];
  clock += 10000; await call('/review/', { ...login, ...nav }); all.push(await call('/review/', { ...login, ...nav })); fs.rmSync(accessFile); all.push(await call('/review/', { ...login, ...nav }));
  assert.deepEqual(all.map((r) => r.status), [200, 200, 200, 206, 416, 404, 404, 403, 405, 429, 503]);
  for (const r of all) assert.equal(r.headers['x-content-type-options'], 'nosniff', String(r.status));
});

const WAIT_PAGE_SENTENCE = 'One moment. The page opens by itself.';
test('change 4: a page load refused only because a session was issued under 2 s ago gets the small refresh page with the same strict headers', async () => {
  clock += 10000; assert.equal((await call('/review/', { ...login, ...nav })).status, 200);
  const r = await call('/review/', { ...login, ...nav }); const body = r.body.toString();
  assert.equal(r.status, 429); assert.match(r.headers['content-type'], /^text\/html; charset=utf-8/);
  assert.ok(body.includes(WAIT_PAGE_SENTENCE)); assert.ok(body.includes('<meta http-equiv="refresh" content="3">')); assert.doesNotMatch(body, /<script|<link|https?:|\son[a-z]+=|<iframe/i);
  const n = /nonce-([0-9a-f]{32})/.exec(r.headers['content-security-policy'])[1]; assert.equal(r.headers['content-security-policy'], CSP(n), 'the policy is the same function, so it allows nothing more than the page');
  assert.equal(r.headers['x-content-type-options'], 'nosniff'); assert.equal(r.headers['referrer-policy'], 'no-referrer'); assert.equal(r.headers['x-frame-options'], 'DENY'); assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(r.headers['set-cookie'], undefined);
  assert.ok(logs.some((l) => /rate-limited page/.test(l)));
  assert.equal(body.length < 600, true, 'minimal');
});
test('change 4: every other refusal stays the plain body not available, with no detail', async () => {
  const plain = async (r, code) => { assert.equal(r.status, code); assert.equal(r.body.toString(), 'not available'); assert.match(r.headers['content-type'], /^text\/plain/); assert.equal(r.headers['set-cookie'], undefined); };
  await plain(await call('/review/', { host: HOST }), 403); await plain(await call('/review/', login, { method: 'POST' }), 405);
  await plain(await call('/review/api/items', login), 403); // no cookie
  await plain(await call('/review/media/m_' + '0'.repeat(32), login), 403);
  fs.rmSync(accessFile); await plain(await call('/review/', login), 503);
});
test('change 4: a full table of young sessions (not the 2 s rule) is still the plain refusal', async () => {
  srv.close(); let t = 5e9; const sessions = createSessions({ now: () => t, max: 1 });
  const h = createReviewHandler({ sessions, loadInputs: inputs, log: (m) => logs.push(m), cacheMs: 0, previewDir: path.join(dir, 'previews') });
  srv = http.createServer((q, s) => { if (!h(q, s)) { s.statusCode = 418; s.end(); } }); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); port = srv.address().port;
  assert.equal((await call('/review/', { ...login, ...nav })).status, 200); t += 3000; // past the 2 s gap, the table (max 1) still holds a young session
  const r = await call('/review/', { ...login, ...nav }); assert.equal(r.status, 429); assert.equal(r.body.toString(), 'not available'); assert.match(r.headers['content-type'], /^text\/plain/);
});

// the page issues a session only to a real page load: another site in the owner's browser (image tag, no-cors fetch) must not use up sessions
const NOT_PAGE = [['image/no-cors', { 'sec-fetch-dest': 'image', 'sec-fetch-mode': 'no-cors' }], ['empty/cors', { 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' }], ['no fetch-metadata headers', {}]];
for (const [name, h] of NOT_PAGE) test(`page: no cookie and not a page load (${name}) is refused, no session, no Set-Cookie`, async () => {
  clock += 5000; const s = srvSessions.count(); logs.length = 0; const r = await call('/review/', { ...login, ...h });
  assert.equal(r.status, 403); assert.equal(r.body.toString(), 'not available'); assert.equal(r.headers['set-cookie'], undefined); assert.match(r.headers['content-type'], /^text\/plain/); assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(srvSessions.count(), s); assert.deepEqual(logs, ['review refused: not-a-page-load page']);
});
test('page: 30 non-page requests in a row do not block or fill anything; the real page load right after gets 200 and a cookie', async () => {
  clock += 5000; const s = srvSessions.count(); for (let i = 0; i < 30; i++) assert.equal((await call('/review/', { ...login, 'sec-fetch-dest': 'image', 'sec-fetch-mode': 'no-cors' })).status, 403);
  assert.equal(srvSessions.count(), s); const r = await call('/review/', { ...login, ...nav }); assert.equal(r.status, 200); assert.match(r.headers['set-cookie'][0], /^bpa_review=[0-9a-f]{64}/); assert.equal(srvSessions.count(), s + 1);
});
test('page: a real page load without a cookie still gets 200 and a cookie', async () => { clock += 5000; const r = await call('/review/', { ...login, ...nav, 'sec-fetch-site': 'cross-site' }); assert.equal(r.status, 200); assert.ok(r.headers['set-cookie']); });
test('page: the page header alone (with login and Host) gets 200 and a cookie', async () => { clock += 5000; const r = await call('/review/', { ...login, 'x-bpa-page': '1' }); assert.equal(r.status, 200); assert.ok(r.headers['set-cookie']); });
test('page: the page header never bypasses Host or login', async () => {
  clock += 5000; const s = srvSessions.count(); for (const h of [{ ...goodHeaders({ 'tailscale-user-login': 'x@example.com' }) }, goodHeaders({ host: 'x.example.com:10000' }), { host: HOST }]) { const r = await call('/review/', { ...h, 'x-bpa-page': '1' }); assert.equal(r.status, 403); assert.equal(r.headers['set-cookie'], undefined); }
  assert.equal(srvSessions.count(), s);
});
test('page: a valid cookie and no fetch-metadata headers still gets 200 and no new cookie', async () => { clock += 5000; const s = srvSessions.count(); const r = await call('/review/', ck); assert.equal(r.status, 200); assert.equal(r.headers['set-cookie'], undefined); assert.equal(srvSessions.count(), s); });
