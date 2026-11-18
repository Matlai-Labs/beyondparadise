import './test-env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { createReviewHandler, defaultPreviewDir } from './review-routes.js';
import { createSessions } from './review-auth.js';
import { fileInfoOf } from './review-items.js';
import { claimsSha256 } from './auto-hooks.js';
import { writeAccess, goodHeaders } from './review-test-kit.js';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-prevroutes-'));
const clip = (id) => ({ id, file: `${id}.mp4`, durationSec: 7, source: [{ videoId: 'v1', startSec: 1, endSec: 8 }], checks: { rendered: 'ok' }, flash: { flash: false }, verified: { verdict: 'pass', singleSubject: 'yes', notes: 'a lion' }, shows: { tags: ['lion'], at: '2026-11-17T10:00:00.000Z' } });
const IDEA = { id: 'idea_1', title: 'Lion fact', link: '/x/', claims: [{ text: 'Claim A', sourceDate: '2026-10-01' }] };
const login = goodHeaders(); const nav = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' };
let dir, previews, srv, port, manifest, ck, clock = 2e9, maker;
const info = fileInfoOf({ hashFile: async (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') });
const inputs = () => ({
  readHooks: () => ({ ok: true, hooks: [{ ideaId: 'idea_1', sourceId: null, hook: 'Hook one', claimsSha256: claimsSha256(IDEA), approvedBy: null, approvedAt: null }] }),
  loadPool: () => ({ ok: true, ideas: [IDEA], sourceNames: {} }), readManifest: () => manifest, libraryDir: dir, info, secret: 'test-secret',
  evaluate: async (i, { hook }) => ({ ok: true, draft: { hook, caption: 'X' } }) });
const call = (p, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => { const b = []; res.on('data', (x) => b.push(x)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(b) })); }).on('error', reject); });
async function mediaId() { const j = JSON.parse((await call('/review/api/items', ck)).body); return j.items.find((i) => i.kind === 'clip').preview.mediaId; }
async function start() {
  const h = createReviewHandler({ sessions: createSessions({ now: () => clock }), loadInputs: inputs, cacheMs: 0, previewDir: previews, previewMaker: maker, previewWaitMs: 80 });
  srv = http.createServer((q, s) => { if (!h(q, s)) { s.statusCode = 418; s.end(); } }); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); port = srv.address().port;
  const r = await call('/review/', { ...login, ...nav }); ck = { ...login, cookie: r.headers['set-cookie'][0].split(';')[0] };
}
beforeEach(() => { clock += 5000; dir = mk(); previews = path.join(mk(), 'previews'); fs.mkdirSync(path.join(previews, 'h264'), { recursive: true }); writeAccess(); fs.writeFileSync(path.join(dir, 'c1.mp4'), Buffer.alloc(1000, 1)); manifest = { clips: [clip('c1')] }; });
afterEach(() => { srv.close(); });
const prev = (bytes) => { const f = path.join(previews, 'h264', `${'a'.repeat(32)}.mp4`); fs.writeFileSync(f, bytes); return f; };

test('the media route serves the H.264 copy when there is one: 200 and 206 with the copy bytes', async () => {
  const f = prev(Buffer.alloc(300, 7)); const seen = []; maker = { get: async (e) => { seen.push(e); return f; }, warm: async () => {} }; await start();
  const id = await mediaId(); const full = await call(`/review/media/${id}`, ck); assert.equal(full.status, 200); assert.equal(full.body.length, 300); assert.equal(full.headers['content-type'], 'video/mp4'); assert.equal(full.headers['accept-ranges'], 'bytes');
  const part = await call(`/review/media/${id}`, { ...ck, range: 'bytes=0-9' }); assert.equal(part.status, 206); assert.equal(part.headers['content-range'], 'bytes 0-9/300'); assert.equal(part.body.length, 10);
  assert.ok(seen[0].path.endsWith('c1.mp4'), 'the maker was asked about the original'); assert.equal(seen[0].size, 1000);
});

test('no copy (null) or a maker that throws: the original is served, never an error', async () => {
  for (const get of [async () => null, async () => { throw new Error('boom'); }]) {
    maker = { get, warm: async () => {} }; await start(); const id = await mediaId(); const r = await call(`/review/media/${id}`, ck); assert.equal(r.status, 200); assert.equal(r.body.length, 1000); srv.close(); clock += 5000;
  }
  srv = http.createServer(); // afterEach closes it
});

test('a copy outside the allowed folders or a link is never served: the original is', async () => {
  const outside = path.join(mk(), 'o.mp4'); fs.writeFileSync(outside, Buffer.alloc(77, 9)); const real = prev(Buffer.alloc(5, 1)); fs.rmSync(real); fs.symlinkSync(outside, real);
  for (const p of [outside, real]) { maker = { get: async () => p, warm: async () => {} }; await start(); const id = await mediaId(); const r = await call(`/review/media/${id}`, ck); assert.equal(r.status, 200); assert.equal(r.body.length, 1000, p); srv.close(); clock += 5000; }
  srv = http.createServer();
});

test('the identity check still comes first: a changed original is 404 and the maker is not asked', async () => {
  let asked = 0; maker = { get: async () => { asked++; return prev(Buffer.alloc(300, 7)); }, warm: async () => {} }; await start(); const id = await mediaId();
  const t = new Date(Date.now() + 9000); fs.utimesSync(path.join(dir, 'c1.mp4'), t, t); assert.equal((await call(`/review/media/${id}`, ck)).status, 404); assert.equal(asked, 0);
});

test('building the item list starts the background warm-up with the clip files; a warm-up that throws changes nothing', async () => {
  let got = null; maker = { get: async () => null, warm: (e) => { got = e; throw new Error('sync boom'); } }; await start();
  const r = await call('/review/api/items', ck); assert.equal(r.status, 200); assert.ok(Array.isArray(got) && got.length === 1); assert.equal(got[0].size, 1000); assert.ok(typeof got[0].path === 'string' && got[0].path.endsWith('c1.mp4'));
});

test('no maker given (every older caller): nothing changes', async () => { maker = undefined; await start(); const id = await mediaId(); const r = await call(`/review/media/${id}`, ck); assert.equal(r.status, 200); assert.equal(r.body.length, 1000); });

test('the real server file wires a maker whose folder lies inside the preview folder the media route allows', () => {
  const src = fs.readFileSync(new URL('./approval-server.js', import.meta.url), 'utf8');
  assert.match(src, /createPreviewMaker\(/); assert.match(src, /import path from 'node:path'/); assert.match(src, /createReviewHandler\(\{[^\n]*\bpreviewMaker\b/); assert.match(src, /path\.join\(defaultPreviewDir\(\), 'h264'\)/);
  assert.equal(defaultPreviewDir({ BPA_STATE_DIR: '/s' }), path.join('/s', 'bpa-review-previews'));
});

test('a copy that is still being made after the wait time: this request gets the original at once, the next one the copy', async () => {
  const f = prev(Buffer.alloc(300, 7)); let ready = false; maker = { get: async () => (ready ? f : new Promise(() => {})), warm: async () => {} }; await start();
  const id = await mediaId(); const t0 = Date.now(); const a = await call(`/review/media/${id}`, ck); assert.equal(a.status, 200); assert.equal(a.body.length, 1000); assert.ok(Date.now() - t0 < 3000);
  ready = true; const b = await call(`/review/media/${id}`, ck); assert.equal(b.body.length, 300);
});

test('with a maker the copies are started when the handler is created, before any page load', async () => {
  let warmed = null; maker = { get: async () => null, warm: (e) => { warmed = e; return Promise.resolve(); } };
  const h = createReviewHandler({ sessions: createSessions({ now: () => clock }), loadInputs: inputs, cacheMs: 0, previewDir: previews, previewMaker: maker }); assert.ok(h);
  for (let i = 0; i < 50 && !warmed; i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(Array.isArray(warmed) && warmed.length === 1);
  maker = undefined; await start();
});
