import './test-env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createReviewHandler, CSP } from './review-routes.js';
import { createSessions } from './review-auth.js';
import { fileInfoOf } from './review-items.js';
import { claimsSha256 } from './auto-hooks.js';
import { writeAccess, goodHeaders, OWNER, HOST } from './review-test-kit.js';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-routes-'));
const clip = (id) => ({ id, file: `${id}.mp4`, durationSec: 7, source: [{ videoId: 'v1', startSec: 1, endSec: 8 }], checks: { rendered: 'ok' }, flash: { flash: false }, verified: { verdict: 'pass', singleSubject: 'yes', notes: 'a lion' }, shows: { tags: ['lion'] } });
const IDEA = { id: 'idea_1', title: 'Lion fact', link: '/x/', claims: [{ text: 'Claim A', sourceDate: '2026-10-01' }] };
const login = goodHeaders();
let dir, clipFile, accessFile, manifest, logs, srv, port, loads;
const info = fileInfoOf(); const SECRET = 'test-secret';
const inputs = () => { loads += 1; return {
  readHooks: () => ({ ok: true, hooks: [{ ideaId: 'idea_1', sourceId: null, hook: 'Hook one', claimsSha256: claimsSha256(IDEA), approvedBy: null, approvedAt: null }] }),
  loadPool: () => ({ ok: true, ideas: [IDEA], sourceNames: {} }), readManifest: () => manifest, libraryDir: dir, info, secret: SECRET,
  evaluate: async (i, { hook }) => ({ ok: true, draft: { hook, caption: 'SECRETCAPTION' } }) }; };
async function start({ cacheMs = 0 } = {}) {
  const h = createReviewHandler({ sessions: createSessions(), loadInputs: inputs, log: (m) => logs.push(m), cacheMs, previewDir: path.join(dir, 'previews') });
  srv = http.createServer((q, s) => { if (!h(q, s)) { s.statusCode = 418; s.end(); } }); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); port = srv.address().port;
}
const call = (p, headers = {}, { method = 'GET' } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => { const bufs = []; res.on('data', (b) => bufs.push(b)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(bufs) })); }); r.on('error', reject); r.end(); });
async function cookie() { const r = await call('/review/', login); return r.headers['set-cookie'][0].split(';')[0]; }
let ck;
async function firstClipMedia() { const r = await call('/review/api/items', ck); const j = JSON.parse(r.body); return { id: j.items.find((i) => i.kind === 'clip').preview.mediaId }; }
const bump = (f) => { const t = new Date(Date.now() + 5000 + Math.floor(Math.random() * 1000)); fs.utimesSync(f, t, t); };

beforeEach(async () => {
  dir = mk(); logs = []; loads = 0; for (const f of ['c1', 'c2']) fs.writeFileSync(path.join(dir, `${f}.mp4`), Buffer.alloc(1000, f.length)); clipFile = path.join(dir, 'c1.mp4');
  const t = new Date(Date.now() + 9000); fs.utimesSync(clipFile, t, t); // c1 is the newest, so it is the first clip item
  manifest = { clips: [clip('c1'), clip('c2')] }; accessFile = writeAccess(); await start();
  ck = { ...login, cookie: await cookie() };
});
afterEach(() => { srv.close(); });

test('page: 200 with cookie, CSP, nonce in header and body, hardening headers, fresh nonce each time', async () => {
  const a = await call('/review/', login), b = await call('/review/', login); assert.equal(a.status, 200); assert.match(a.headers['set-cookie'][0], /^bpa_review=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Secure; Path=\/review/);
  const n = /nonce-([0-9a-f]{32})/.exec(a.headers['content-security-policy'])[1]; assert.ok(a.body.toString().includes(`nonce="${n}"`)); assert.ok(!a.body.toString().includes('__NONCE__')); assert.notEqual(n, /nonce-([0-9a-f]{32})/.exec(b.headers['content-security-policy'])[1]);
  assert.equal(a.headers['content-security-policy'], CSP(n)); assert.equal(a.headers['x-content-type-options'], 'nosniff'); assert.equal(a.headers['referrer-policy'], 'no-referrer'); assert.equal(a.headers['x-frame-options'], 'DENY'); assert.equal(a.headers['cache-control'], 'no-store'); assert.match(a.headers['content-type'], /^text\/html; charset=utf-8/);
});
test('CSP has exactly the allowed directives', () => assert.equal(CSP('N'), "default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-N'; media-src 'self'; connect-src 'self'; img-src 'self'"));
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
  for (const i of j.items) assert.deepEqual(Object.keys(i).sort(), ['actions', 'facts', 'id', 'kind', 'preview', 'reason', 'state', 'title', 'usableToday', 'version']);
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
test('media: an id that left the list is 404 (focus 1)', async () => { const { id } = await firstClipMedia(); manifest = { clips: [] }; assert.equal((await call(`/review/media/${id}`, ck)).status, 404); });
test('media: after the file is replaced the old id is 404 and the new id works (focus 1, 4)', async () => {
  const old = (await firstClipMedia()).id; fs.writeFileSync(clipFile, 'x'.repeat(1000)); bump(clipFile);
  assert.equal((await call(`/review/media/${old}`, ck)).status, 404); const fresh = (await firstClipMedia()).id; assert.notEqual(fresh, old); assert.equal((await call(`/review/media/${fresh}`, ck)).status, 200);
});
test('media: ids shaped like paths or names are 404 and never read', async () => {
  for (const id of ['../c1.mp4', '%2e%2e%2fc1.mp4', 'c1.mp4', 'm_zz', `m_${'g'.repeat(32)}`, `m_${'0'.repeat(32)}`, `m_${'0'.repeat(32)}/x`, `m_${'0'.repeat(33)}`]) assert.equal((await call(`/review/media/${id}`, ck)).status, 404, id);
});
test('media: a clip file turned into a symlink is 404 and the refusal is logged by reason only', async () => {
  const outside = path.join(mk(), 'outside.mp4'); fs.writeFileSync(outside, Buffer.alloc(1000, 7)); const old = (await firstClipMedia()).id;
  fs.rmSync(clipFile); fs.symlinkSync(outside, clipFile); bump(outside);
  assert.equal((await call(`/review/media/${old}`, ck)).status, 404); const fresh = (await firstClipMedia()).id; assert.equal((await call(`/review/media/${fresh}`, ck)).status, 404, 'the link is refused even though the list shows it');
  assert.ok(logs.some((l) => /symlink/.test(l))); assert.ok(!logs.join('\n').includes(outside));
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
test('media list is computed fresh even while the item list is cached (focus 1)', async () => {
  srv.close(); await start({ cacheMs: 60000 }); ck = { ...login, cookie: await cookie() };
  const { id } = await firstClipMedia(); assert.equal((await call(`/review/media/${id}`, ck)).status, 200); // the item list is now cached, id included
  fs.writeFileSync(clipFile, 'y'.repeat(1000)); bump(clipFile); assert.equal((await call(`/review/media/${id}`, ck)).status, 404, 'file replaced: the cached list must not serve it');
  const again = (await firstClipMedia()).id; assert.equal(again, id, 'the cached item list still shows the old id'); manifest = { clips: [] }; assert.equal((await call(`/review/media/${id}`, ck)).status, 404, 'left the list');
});
test('defaultInputs wires the lane\'s own readers and verdict (usage ledger, history, config, laneVerdict)', async () => {
  const { defaultInputs } = await import('./review-routes.js'); const d = defaultInputs();
  for (const k of ['readHooks', 'loadPool', 'readManifest', 'readUsage', 'readHistory', 'readConfig', 'laneVerdict', 'evaluate']) assert.equal(typeof d[k], 'function', k);
  assert.deepEqual(d.readUsage(), [], 'no ledger in the test state folder'); assert.equal(typeof d.readConfig(), 'object');
  assert.equal((await d.laneVerdict({ id: 'i', kind: 'rule', title: 'Lion', claims: [] }, { clips: [], history: [], config: {}, now: new Date() })).reason, 'no-matching-clip');
});
