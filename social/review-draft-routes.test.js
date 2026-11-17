import './test-env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import crypto from 'node:crypto';
import { createReviewHandler } from './review-routes.js';
import { createSessions } from './review-auth.js';
import { createDraftActions } from './draft-decisions.js';
import { buildDraftItems } from './review-draft-items.js';
import { readQueueStrict, draftVersion } from './draft-version.js';
import { fileInfoOf } from './review-items.js';
import { approveSwitchPath } from './approve-switch.js';
import { withQueueLock, nextSlots } from './lib.js';
import { writeAccess, goodHeaders } from './review-test-kit.js';

const login = goodHeaders(); const nav = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' };
const NP = ['examplehotel']; const LOGF = process.env.BPA_LOG_PATH;
let clock = 2e9; let dir, srv, port, ck, tok, logs, cur, sessions;
const draft = (id, extra = {}) => ({ id, status: 'pending_approval', kind: 'outlook', text: `Lions sleep most of the day on the plains (${id}).`, createdAt: new Date().toISOString(), ...extra });
// one record file for the handler and the actions, as in production
function fresh(drafts = [draft('B1'), draft('B2')], over = {}) {
  const d = fs.mkdtempSync(path.join(dir, 'case-')); const queuePath = path.join(d, 'q.json'); const recordFile = path.join(dir, 'rec.jsonl'); fs.rmSync(recordFile, { force: true }); fs.writeFileSync(queuePath, JSON.stringify({ seq: 3, drafts }));
  const calls = { schedule: 0, notify: 0 }; const state = { approveOn: true, stopped: false };
  const actions = createDraftActions({ env: process.env, queuePath, recordFile, lockTimeoutMs: 150, schedule: async () => { calls.schedule++; return { id: 'p1' }; }, igOn: () => false, stop: () => ({ stopped: state.stopped, reason: 'stopped by flag since T1' }), notify: async () => { calls.notify++; return true; }, approveOn: () => state.approveOn, neverPromotePatterns: NP, ...over });
  cur = { queuePath, recordFile, calls, state, actions, d };
  return cur;
}
const q = () => JSON.parse(fs.readFileSync(cur.queuePath, 'utf8'));
const lines = () => (fs.existsSync(cur.recordFile) ? fs.readFileSync(cur.recordFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const slotNow = () => nextSlots(q(), 1, new Date())[0];
const body = (id = 'B1', o = {}) => ({ kind: 'draft', id, version: draftVersion(q().drafts.find((x) => x.id === id) || {}), action: 'approve', slot: slotNow(), ...o });
const call = (p, headers = {}, { method = 'GET', body: b } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined)) }, (res) => { const bufs = []; res.on('data', (x) => bufs.push(x)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(bufs) })); });
  r.on('error', reject); if (b !== undefined) r.write(b); r.end(); });
const H = (over = {}) => ({ ...login, cookie: ck, 'x-bpa-action': tok, 'content-type': 'application/json', ...over });
const post = (p, obj, over = {}) => { const b = typeof obj === 'string' ? obj : JSON.stringify(obj); return call(p, H({ 'content-length': Buffer.byteLength(b), ...over }), { method: 'POST', body: b }); };
const decide = (obj, over) => post('/review/api/decide', obj, over);
const json = (r) => JSON.parse(r.body.toString());
let inputs = null;
beforeEach(async () => {
  clock += 5000; dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-dr3-')); logs = []; writeAccess(); fresh(); inputs = null;
  sessions = createSessions({ now: () => clock });
  const h = createReviewHandler({ sessions, loadInputs: () => inputs || { readHooks: () => ({ ok: true, hooks: [] }), loadPool: () => ({ ok: true, ideas: [], sourceNames: {} }), readManifest: () => null, libraryDir: dir, info: fileInfoOf(), secret: 's', evaluate: async () => ({ ok: false }) }, loadActions: () => cur.actions, recordFile: path.join(dir, 'rec.jsonl'), log: (m) => logs.push(m), cacheMs: 0, previewDir: path.join(dir, 'previews') });
  srv = http.createServer((a, b) => { if (!h(a, b)) { b.statusCode = 418; b.end(); } }); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); port = srv.address().port;
  ck = (await call('/review/', { ...login, ...nav })).headers['set-cookie'][0].split(';')[0]; tok = json(await call('/review/api/session', { ...login, cookie: ck, 'x-bpa-page': '1' }, { method: 'POST' })).token;
});
afterEach(() => { srv.close(); });
// the real record file of a case is the one the actions write; the handler's own recordFile is not used for drafts

test('1 approve through HTTP: 200 with the change and the date in words; schedule once; one record line', async () => {
  const r = await decide(body()); assert.equal(r.status, 200); const j = json(r);
  assert.equal(j.ok, true); assert.deepEqual(j.change, { kind: 'draft', id: 'B1', decision: 'scheduled' }); assert.match(j.scheduledFor, /T09:00:00\+03:00$/); assert.match(j.scheduledForText, /at 09:00 \(East Africa time\)$/);
  assert.equal(cur.calls.schedule, 1); assert.equal(lines().length, 1); assert.equal(lines()[0].decision, 'approve');
});
test('2 every refusal is 409 with a code from the closed set and no text; nothing more is scheduled; no data in the answer', async () => {
  const T = 'A resort on Muyuni Beach'; const login1 = 'owner@example.com';
  const cases = [
    ['version-changed', () => fresh(), (b) => ({ ...b, version: 'f'.repeat(64) })],
    ['slot-changed', () => fresh(), (b) => ({ ...b, slot: '2031-01-01T09:00:00+03:00' })],
    ['already-scheduled', () => fresh(), null],
    ['stopped', () => { const c = fresh(); c.state.stopped = true; return c; }, null],
    ['sources-missing', () => fresh([draft('B1', { text: T })]), null],
    ['blocked', () => fresh([draft('B1', { text: 'Book now for big waves today at the beach.' })]), null],
    ['queue-unreadable', () => fresh(), (b) => { fs.writeFileSync(cur.queuePath, '{broken'); return b; }],
    ['not-found', () => fresh(), (b) => ({ ...b, id: 'B9' })],
    ['cannot-decide', () => { const c = fresh(); c.state.approveOn = false; return c; }, null],
  ];
  for (const [code, setup, mod] of cases) {
    setup(); const b0 = body(); const b = mod ? mod(b0) : b0;
    if (code === 'already-scheduled') { assert.equal((await decide(b)).status, 200); }
    const before = cur.calls.schedule; const r = await decide(b); assert.equal(r.status, 409, code); const j = json(r); assert.deepEqual(Object.keys(j).sort(), ['code', 'ok']); assert.equal(j.code, code);
    if (code !== 'already-scheduled') assert.equal(cur.calls.schedule, before, code); else assert.equal(cur.calls.schedule, 1);
    const txt = r.body.toString(); for (const bad of ['Lions', 'Muyuni', 'exact line', login1, 'B1', 'no recorded source']) assert.ok(!txt.includes(bad), `${code} leaks ${bad}`);
    if (code === 'blocked') assert.equal(cur.calls.notify, 1);
  }
  { fresh(); const b = body(); const r = await withQueueLock(async () => decide(b), { lockPath: cur.queuePath + '.lock' }); assert.equal(r.status, 409); assert.equal(json(r).code, 'lock-busy'); assert.equal(cur.calls.schedule, 0); }
});
test('3 undo of a draft is bad-request; an extra key or a missing slot is 400', async () => {
  for (const b of [body('B1', { action: 'undo', slot: undefined }), body('B1', { extra: 1 }), body('B1', { slot: undefined })]) { const r = await decide(b); assert.equal(r.status, 400); assert.deepEqual(json(r), { ok: false, code: 'bad-request' }); }
  assert.equal(cur.calls.schedule, 0); assert.equal(lines().length, 0);
});
test('4 the guards still come first and nothing is scheduled', async () => {
  const b = JSON.stringify(body()); const len = { 'content-length': Buffer.byteLength(b) };
  const rows = [['no cookie', { cookie: undefined, ...len }, 403], ['no token', { 'x-bpa-action': undefined, ...len }, 403], ['text/plain', { 'content-type': 'text/plain', ...len }, 415], ['cross-site', { 'sec-fetch-site': 'cross-site', ...len }, 403]];
  for (const [n, over, status] of rows) { const r = await call('/review/api/decide', H(over), { method: 'POST', body: b }); assert.equal(r.status, status, n); assert.equal(r.body.toString(), 'not available', n); }
  const big = await post('/review/api/decide', 'x'.repeat(2049)); assert.equal(big.status, 413); assert.equal(big.headers.connection, 'close');
  assert.equal((await call('/review/api/decide', H(), {})).status, 405); assert.equal(cur.calls.schedule, 0); assert.equal(lines().length, 0);
});
test('5 a draft edit of 1500 ordinary characters passes the body limit; a 2049 byte body is 413 and the queue is unchanged', async () => {
  const text = Array.from({ length: 60 }, (_, i) => `Giraffe number ${i} feeds slowly on acacia leaves.`).join(' ').slice(0, 1500); const b = q();
  const ok = await decide({ kind: 'draft', id: 'B1', version: draftVersion(b.drafts[0]), action: 'edit', text }); assert.notEqual(ok.status, 413); assert.ok([200, 409].includes(ok.status), String(ok.status));
  fresh(); const before = fs.readFileSync(cur.queuePath, 'utf8'); const huge = await decide({ kind: 'draft', id: 'B1', version: draftVersion(q().drafts[0]), action: 'edit', text: '—'.repeat(700) });
  assert.equal(huge.status, 413); assert.equal(huge.body.toString(), 'not available'); assert.equal(fs.readFileSync(cur.queuePath, 'utf8'), before);
});
test('6 the logs hold only closed shapes: never an id, a text or a code with data', async () => {
  const was = fs.existsSync(LOGF) ? fs.readFileSync(LOGF, 'utf8').length : 0;
  await decide(body()); fresh(); await decide(body('B1', { version: 'f'.repeat(64) })); fresh([draft('B1', { text: 'A resort on Muyuni Beach' })]); await decide(body());
  fresh(); cur.state.stopped = true; await decide(body());
  for (const l of logs) assert.match(l, /^review (decision|refused|failed): [a-z0-9 -]+$/, l);
  const all = logs.join('\n'); for (const bad of ['B1', 'Lions', 'Muyuni', 'owner@example.com']) assert.ok(!all.includes(bad), bad);
  const own = (fs.existsSync(LOGF) ? fs.readFileSync(LOGF, 'utf8').slice(was) : '').split('\n').filter(Boolean); for (const l of own) assert.match(l, /^\S+ review (draft|failed): [a-z0-9-]+$/, l);
});
test('7 no request creates the switch file', async () => {
  const sw = approveSwitchPath(process.env); assert.ok(sw.startsWith(os.tmpdir()), 'a temp state folder'); assert.equal(fs.existsSync(sw), false);
  await decide(body()); const hostile = ['/review/api/bpa-page-approve-on', '/review/bpa-page-approve-on', '/review/media/bpa-page-approve-on', '/review/api/__proto__', '/review/api/items?bpa-page-approve-on=1'];
  for (const p of hostile) for (const method of ['GET', 'POST', 'PUT', 'DELETE']) { await call(p, H(), { method, body: method === 'GET' ? undefined : JSON.stringify({ file: 'bpa-page-approve-on', approveOn: true }) }).catch(() => null); }
  for (const b of [{ kind: 'draft', id: 'B1', version: 'a'.repeat(64), action: 'approve', slot: slotNow(), approveOn: true }, { switch: 'bpa-page-approve-on' }, '{"x":"bpa-page-approve-on"}']) await decide(b).catch(() => null);
  for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) await call('/review/api/decide', H(), { method, body: '{}' }).catch(() => null);
  assert.equal(fs.existsSync(sw), false);
});
test('8 items carry the draft count and an item; a prepared post video is served (200, 206) and refused when outside, a link or changed (404)', async () => {
  const auto = fs.mkdtempSync(path.join(dir, 'auto-')); const f = path.join(auto, 'reel_1.mp4'); fs.writeFileSync(f, Buffer.alloc(4000, 7)); const sha = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  fresh([draft('B1'), draft('B2', { status: 'scheduled', auto: true, readyFile: f, readyFileSha256: sha })]); const info = fileInfoOf(); const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-out-')), 'o.mp4'); fs.writeFileSync(outside, Buffer.alloc(100, 1)); const link = path.join(auto, 'link.mp4'); fs.symlinkSync(f, link);
  inputs = { readHooks: () => ({ ok: true, hooks: [] }), loadPool: () => ({ ok: true, ideas: [], sourceNames: {} }), readManifest: () => null, libraryDir: dir, info, secret: 's', evaluate: async () => ({ ok: false }), autoFolder: auto,
    buildDrafts: async () => { const r = await buildDraftItems({ readQueue: () => readQueueStrict(cur.queuePath), checkFor: async () => ({ ok: true }), stop: () => ({ stopped: false }), igOn: () => false, approveOn: () => true, ttlDays: 7, now: new Date(), autoDir: auto, info, secret: 's' });
      const st = fs.lstatSync(outside); r.media.set('m_' + 'a'.repeat(32), { path: outside, kind: 'prepared', size: st.size, mtimeMs: st.mtimeMs, ino: st.ino }); const sl = fs.lstatSync(link); r.media.set('m_' + 'b'.repeat(32), { path: link, kind: 'prepared', size: sl.size, mtimeMs: sl.mtimeMs, ino: sl.ino }); return r; } };
  const items = json(await call('/review/api/items', { ...login, cookie: ck })); assert.equal(items.counts.draft, 2); assert.equal(items.items[0].kind, 'draft');
  const prepared = items.items.find((i) => i.id === 'B2'); assert.match(prepared.preview.mediaId, /^m_[0-9a-f]{32}$/);
  assert.equal((await call(`/review/media/${prepared.preview.mediaId}`, { ...login, cookie: ck })).status, 200); const part = await call(`/review/media/${prepared.preview.mediaId}`, { ...login, cookie: ck, range: 'bytes=0-9' }); assert.equal(part.status, 206); assert.equal(part.body.length, 10);
  assert.equal((await call(`/review/media/m_${'a'.repeat(32)}`, { ...login, cookie: ck })).status, 404); assert.equal((await call(`/review/media/m_${'b'.repeat(32)}`, { ...login, cookie: ck })).status, 404);
  fs.appendFileSync(f, 'more'); assert.equal((await call(`/review/media/${prepared.preview.mediaId}`, { ...login, cookie: ck })).status, 404);
});
test('9 a handler built without loadActions: a decide request answers 503 not available, calls nothing, and logs the closed line', async () => {
  const lg = []; const h = createReviewHandler({ sessions: createSessions({ now: () => clock + 20000 }), loadInputs: () => ({}), recordFile: path.join(dir, 'x.jsonl'), log: (m) => lg.push(m) });
  const s2 = http.createServer((a, b) => { if (!h(a, b)) { b.statusCode = 418; b.end(); } }); await new Promise((r) => s2.listen(0, '127.0.0.1', r)); const p2 = s2.address().port;
  try {
    const c2 = (await call2(p2, '/review/', { ...login, ...nav })).headers['set-cookie'][0].split(';')[0]; const t2 = json(await call2(p2, '/review/api/session', { ...login, cookie: c2, 'x-bpa-page': '1' }, { method: 'POST' })).token;
    const b = JSON.stringify(body()); const r = await call2(p2, '/review/api/decide', { ...login, cookie: c2, 'x-bpa-action': t2, 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }, { method: 'POST', body: b });
    assert.equal(r.status, 503); assert.equal(r.body.toString(), 'not available'); assert.ok(lg.includes('review failed: error decide'), lg.join('|')); assert.equal(cur.calls.schedule, 0);
  } finally { s2.close(); }
});
const call2 = (pt, p, headers = {}, { method = 'GET', body: b } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port: pt, path: p, method, headers }, (res) => { const bufs = []; res.on('data', (x) => bufs.push(x)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(bufs) })); }); r.on('error', reject); if (b !== undefined) r.write(b); r.end(); });
