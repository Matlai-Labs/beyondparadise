import './test-env.js';
// Security-review hardening of the read-only Instagram tools: HTTP errors, empty results, NaN, redirects, ids in paths, private files, control characters, deadlines.
import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process'; import { fileURLToPath } from 'node:url';
import { fetchInsights, runFetch, summarise, apiReason, topicAdjustments, readInsightsState, writePrivateJson, deadlineFetch, queueFileArg, RUN_DEADLINE_MS, MAX_STATE_BYTES, InsightsError } from './insights.js';
import { fetchUnanswered, runCommentsFetch, listLines } from './comments.js';
import { buildIdeaPool, loadInputs } from './ideas.js';

const TOKEN = 'TOKEN_SHOULD_NEVER_APPEAR_789'; const ACC = '1784'; const NOW = new Date('2026-11-17T10:00:00Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-hard-'));
const ok = (j) => ({ ok: true, status: 200, json: async () => j }); const http = (status, j = {}) => ({ ok: false, status, json: async () => j });
const med = (id, extra = {}) => ({ id: String(id), permalink: `https://www.instagram.com/reel/P${id}/`, timestamp: '2026-11-10T08:00:00+0000', media_type: 'VIDEO', media_product_type: 'REELS', like_count: 1, comments_count: 1, caption: 'c', ...extra });
const METR = { data: ['reach', 'saved', 'shares', 'total_interactions', 'views'].map((n) => ({ name: n, values: [{ value: 5 }] })) };
/** route(path, params) -> a response; every call is recorded. */
const fake = (route) => { const calls = []; const fn = async (url, opts) => { calls.push({ url, opts }); const u = new URL(url); return route(u.pathname.replace(/^\/v[\d.]+\//, ''), u.searchParams); }; fn.calls = calls; return fn; };
const base = (o = {}) => fake((p) => (p === ACC ? ok({ username: 'ownacct' }) : p === `${ACC}/media` ? ok({ data: [med(11), med(12)] }) : /insights$/.test(p) ? ok(METR) : /comments$/.test(p) ? ok({ data: [{ id: '5', text: 'x', timestamp: 't', username: 'v' }] }) : ok({ error: { code: 1 } })));
const args = (f, o = {}) => ({ fetchFn: f, token: TOKEN, accountId: ACC, now: NOW, ...o });
const prevInsights = (dir) => { const p = path.join(dir, 'i.json'); fs.writeFileSync(p, JSON.stringify({ fetchedAt: '2026-11-01T00:00:00Z', fetchedDay: '2026-11-01', media: [{ id: '1', reach: 5 }] })); return p; };

test('an HTTP error without an error field (5xx, proxy) is a named reason, for the list, for insights and for comments', async () => {
  await assert.rejects(fetchInsights(args(fake(() => http(503, {})))), (e) => e.reason === 'http-error status=503');
  await assert.rejects(fetchInsights(args(fake(() => ({ ok: false, status: 502, json: async () => { throw new Error('html'); } })))), (e) => e.reason === 'http-error status=502');
  await assert.rejects(fetchInsights(args(fake((p) => (p === `${ACC}/media` ? ok({ data: [med(11)] }) : http(500, {}))))), (e) => e.reason === 'http-error status=500', 'a per-media 500 is not "all metrics absent"');
  await assert.rejects(fetchUnanswered(args(fake((p) => (p === ACC ? ok({ username: 'o' }) : http(504, {}))))), (e) => e.reason === 'http-error status=504');
});
test('a 200 answer with {} is "unexpected-response", never an empty list or "all metrics absent"; code 100 is still absent', async () => {
  await assert.rejects(fetchInsights(args(fake(() => ok({})))), (e) => e.reason === 'unexpected-response');
  await assert.rejects(fetchInsights(args(fake((p) => (p === `${ACC}/media` ? ok({ data: [med(11)] }) : ok({}))))), (e) => e.reason === 'unexpected-response');
  await assert.rejects(fetchUnanswered(args(fake((p) => (p === ACC ? ok({ username: 'o' }) : p === `${ACC}/media` ? ok({ data: [med(11)] }) : ok({}))))), (e) => e.reason === 'unexpected-response');
  const r = await fetchInsights(args(fake((p) => (p === `${ACC}/media` ? ok({ data: [med(11)] }) : http(400, { error: { code: 100 } })))));
  assert.equal(r.media[0].reach, null); assert.equal(r.media[0].metricsAbsent.length, 5);
});
test('a non-empty previous state is never replaced by an empty list: the old file stays and a named reason comes back (insights and comments)', async () => {
  const dir = tmp(); const sp = prevInsights(dir); const before = fs.readFileSync(sp, 'utf8');
  const r = await runFetch(args(fake(() => ok({ data: [] })), { statePath: sp, force: true })); assert.deepEqual([r.ok, r.reason], [false, 'empty-result-kept-previous']); assert.equal(fs.readFileSync(sp, 'utf8'), before);
  const r5 = await runFetch(args(fake(() => http(503, {})), { statePath: sp, force: true })); assert.equal(r5.ok, false); assert.equal(fs.readFileSync(sp, 'utf8'), before);
  const fresh = path.join(dir, 'new.json'); assert.equal((await runFetch(args(fake(() => ok({ data: [] })), { statePath: fresh }))).ok, true, 'no previous state: an empty list may be written');
  const cp = path.join(dir, 'c.json'); const prev = JSON.stringify({ fetchedAt: 'x', fetchedDay: '2026-11-01', unanswered: [{ commentId: '9' }] }); fs.writeFileSync(cp, prev);
  const c = await runCommentsFetch(args(fake((p) => (p === ACC ? ok({ username: 'o' }) : ok({ data: [] }))), { statePath: cp, force: true })); assert.deepEqual([c.ok, c.reason], [false, 'empty-result-kept-previous']); assert.equal(fs.readFileSync(cp, 'utf8'), prev);
  assert.equal((await runCommentsFetch(args(fake(() => http(500, {})), { statePath: cp, force: true }))).ok, false); assert.equal(fs.readFileSync(cp, 'utf8'), prev);
});

const world = (reaches, others, fetchedAt = '2026-11-15T00:00:00Z') => { const media = [], drafts = []; reaches.forEach((reach, i) => { media.push({ id: `m${i}`, reach, queueId: `B${i}` }); drafts.push({ id: `B${i}`, sourceId: `fact:a${i}` }); }); others.forEach((reach, i) => media.push({ id: `o${i}`, reach, queueId: null })); return { state: { fetchedAt, media }, queue: { drafts } }; };
const topicOfSource = () => 'beaches';
test('only finite, non-negative numeric reach counts; the adjustment is always finite; a future fetchedAt is a missing state', () => {
  const finite = (m) => { for (const v of m.values()) assert.ok(Number.isFinite(v.adjust)); return m; };
  const tamper = JSON.parse('{"a":1e999}').a; assert.equal(tamper, Infinity);
  assert.equal(finite(topicAdjustments({ ...world([tamper, tamper, tamper, tamper], [tamper, tamper, tamper]), topicOfSource, now: NOW })).size, 0, 'Infinity / Infinity is NaN: nothing');
  assert.equal(finite(topicAdjustments({ ...world([400, 400, 400, 400], [100, 100, 100, tamper, tamper, tamper, tamper, tamper, tamper]), topicOfSource, now: NOW })).size, 1, 'infinite values are ignored, finite ones still count');
  assert.equal(topicAdjustments({ ...world([NaN, NaN, NaN, NaN], [100, 100]), topicOfSource, now: NOW }).size, 0);
  assert.equal(topicAdjustments({ ...world([-400, -400, -400, -400], [100, 100, 100]), topicOfSource, now: NOW }).size, 0, 'negative reach does not count');
  assert.equal(topicAdjustments({ ...world(['400', '400', '400', '400'], [100, 100, 100]), topicOfSource, now: NOW }).size, 0, 'string numbers do not count');
  assert.equal(topicAdjustments({ ...world([400, 400, 400, 400], [100, 100, 100], '2026-11-18T00:00:00Z'), topicOfSource, now: NOW }).size, 0, 'future fetchedAt');
  assert.equal(topicAdjustments({ ...world([400, 400, 400, 400], [100, 100, 100], '2026-11-17T10:00:00Z'), topicOfSource, now: NOW }).size, 1, 'fetched right now is fine');
  const facts = [{ id: 'f', topic: 'beaches', region: 'zanzibar', claim: 'c', value: 'v', sources: ['a', 'b'], status: 'confirmed', lastChecked: '2026-10-01' }];
  const pool = buildIdeaPool({ facts, now: NOW, own: { ...world([tamper, tamper, tamper, tamper], [tamper]), queue: { drafts: [] } } }); assert.ok(Number.isFinite(pool.ideas[0].score));
});
test('every request is sent with redirect: error (the token is in the query string)', async () => {
  const f = base(); await fetchInsights(args(f)); const g = base(); await fetchUnanswered(args(g));
  for (const c of [...f.calls, ...g.calls]) assert.equal(c.opts.redirect, 'error');
  assert.ok(f.calls.length > 2 && g.calls.length > 2);
});
test('ids that come from the API go into request paths only when they are digits; others are skipped with a named reason, the rest is still read', async () => {
  const f = fake((p) => (p === ACC ? ok({ username: 'o' }) : p === `${ACC}/media` ? ok({ data: [med('12/../evil'), med('13'), med('1a'), med('')] }) : /insights$/.test(p) ? ok(METR) : ok({ data: [] })));
  const r = await fetchInsights(args(f)); assert.deepEqual(r.media.map((x) => x.id), ['13']); assert.deepEqual(r.skipped, ['bad-media-id', 'bad-media-id', 'bad-media-id']);
  assert.ok(f.calls.every((c) => !/evil|1a/.test(c.url)));
  const sp = path.join(tmp(), 's.json'); assert.equal((await runFetch(args(f, { statePath: sp }))).skippedIds, 3);
  const g = fake((p) => (p === ACC ? ok({ username: 'o' }) : p === `${ACC}/media` ? ok({ data: [med('x/y'), med('14')] }) : ok({ data: [] })));
  const s = await fetchUnanswered(args(g)); assert.equal(s.skippedIds, 1); assert.ok(g.calls.every((c) => !c.url.includes('x/y')));
  await assert.rejects(fetchInsights(args(base(), { accountId: '17/../x' })), (e) => e.reason === 'bad-account-id'); await assert.rejects(fetchUnanswered(args(base(), { accountId: 'abc' })), (e) => e.reason === 'bad-account-id');
});
test('the state file is written through a fresh exclusive temp file: a leftover is removed and a symlink at that path is not followed', () => {
  const dir = tmp(); const target = path.join(dir, 'victim.txt'); fs.writeFileSync(target, 'precious'); const p = path.join(dir, 's.json');
  fs.symlinkSync(target, `${p}.tmp`); writePrivateJson(p, { a: 1 }); assert.equal(fs.readFileSync(target, 'utf8'), 'precious'); assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { a: 1 }); assert.equal(fs.lstatSync(p).isSymbolicLink(), false);
  fs.writeFileSync(`${p}.tmp`, 'leftover'); fs.chmodSync(`${p}.tmp`, 0o666); writePrivateJson(p, { b: 2 }); assert.equal(fs.statSync(p).mode & 0o777, 0o600); assert.deepEqual(fs.readdirSync(dir).sort(), ['s.json', 'victim.txt']);
  assert.match(fs.readFileSync(new URL('./insights.js', import.meta.url), 'utf8'), /flag: 'wx'/);
});
test('--list strips control characters from the text, the name and the permalink', () => {
  const s = { unanswered: [{ commentId: '1', mediaPermalink: 'https://x/\u001b[2Jp', at: '2026-11-11\u0007', from: 'na\u0000me', text: 'hi\u001b[31m red\r\nnew\u007fline\ttab', isQuestion: false }] };
  const out = listLines(s).join('\n'); assert.ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(out), JSON.stringify(out)); assert.ok(!out.includes('\u001b')); assert.match(out, /hi.*red.*new.*line/);
});
test('apiReason coerces code and subcode to numbers', () => {
  assert.equal(apiReason({ code: '190', error_subcode: '2108006', type: 'OAuthException' }), 'api-error code=190/2108006 type=OAuthException');
  assert.equal(apiReason({ code: '1<script>', error_subcode: 'x;rm' }), 'api-error code=?'); assert.equal(apiReason({ code: 190 }), 'api-error code=190'); assert.equal(apiReason(null), 'api-error code=?');
});
test('summarise groups survive a key called __proto__', () => {
  const s = summarise({ fetchedAt: 'x', media: [{ id: '1', productType: '__proto__', timestamp: '2026-11-10T08:00:00+0000', reach: 5, metricsAbsent: ['views'] }, { id: '2', productType: 'constructor', timestamp: '2026-11-10T08:00:00+0000', reach: 7, metricsAbsent: [] }] }, null);
  assert.equal(s.byProductType['__proto__'].count, 1); assert.equal(s.byProductType.constructor.count, 1); assert.equal(s.metricsAbsentByType['__proto__'].views, 1); assert.ok(JSON.stringify(s).includes('__proto__'));
});
test('comments: at most one real fetch per East Africa day unless forced, and the state carries the day stamp', async () => {
  const sp = path.join(tmp(), 'c.json'); const f = base(); const go = (now, force) => runCommentsFetch(args(f, { statePath: sp, now, force }));
  assert.equal((await go(new Date('2026-11-17T05:00:00Z'))).ok, true); const n = f.calls.length; assert.equal(JSON.parse(fs.readFileSync(sp, 'utf8')).fetchedDay, '2026-11-17');
  const again = await go(new Date('2026-11-17T20:30:00Z')); assert.equal(again.skipped, 'already-fetched-today'); assert.equal(f.calls.length, n);
  assert.equal((await go(new Date('2026-11-17T20:30:00Z'), true)).skipped, undefined); assert.ok(f.calls.length > n);
  assert.equal((await go(new Date('2026-11-17T21:30:00Z'))).skipped, undefined);
});
test('a total deadline for the whole run (both tools): past it the next request is not sent, the reason is "deadline" and nothing is written', async () => {
  assert.equal(RUN_DEADLINE_MS, 300000);
  let t = 0; const clock = () => t; const f = base(); const slow = async (u, o) => { const r = await f(u, o); t += 200000; return r; };
  const dir = tmp(); const sp = path.join(dir, 'i.json'); const r = await runFetch(args(slow, { statePath: sp, clock })); assert.deepEqual([r.ok, r.reason], [false, 'deadline']); assert.equal(fs.existsSync(sp), false); assert.ok(f.calls.length <= 3);
  t = 0; const cp = path.join(dir, 'c.json'); const g = base(); const slow2 = async (u, o) => { const x = await g(u, o); t += 200000; return x; };
  const c = await runCommentsFetch(args(slow2, { statePath: cp, clock })); assert.deepEqual([c.ok, c.reason], [false, 'deadline']); assert.equal(fs.existsSync(cp), false);
  t = 0; const wrapped = deadlineFetch(async (u, o) => { assert.ok(o.signal instanceof AbortSignal); return ok({}); }, { deadlineMs: 1000, clock }); await wrapped('https://x', { signal: AbortSignal.timeout(5000) }); t = 1000; await assert.rejects(wrapped('https://x', {}), (e) => e instanceof InsightsError && e.reason === 'deadline');
});
test('a state file over the size cap is treated as missing', () => {
  const p = path.join(tmp(), 'big.json'); assert.equal(MAX_STATE_BYTES, 5 * 1024 * 1024); fs.writeFileSync(p, JSON.stringify({ fetchedAt: 'x', media: [], pad: 'a'.repeat(MAX_STATE_BYTES) })); assert.equal(readInsightsState(p), null);
  fs.writeFileSync(p, JSON.stringify({ fetchedAt: 'x', media: [] })); assert.ok(readInsightsState(p));
});
test('the idea pool reads the insights file from an injectable place: loadInputs takes insightsFile or env, loadIdeaPool passes it on, no caller reads a fixed real path', () => {
  const root = tmp(); const dir = tmp(); fs.writeFileSync(path.join(dir, 'bpa-ig-insights.json'), JSON.stringify({ fetchedAt: '2026-11-16T00:00:00Z', media: [] }));
  assert.deepEqual(loadInputs({ root, env: { BPA_STATE_DIR: dir } }).own.state.media, []); assert.equal(loadInputs({ root, env: { BPA_STATE_DIR: tmp() } }).own.state, null);
  const src = fs.readFileSync(new URL('./idea-drafts.js', import.meta.url), 'utf8'); assert.match(src, /insightsFile/);
  const here = path.dirname(fileURLToPath(import.meta.url)); for (const f of fs.readdirSync(here).filter((x) => x.endsWith('.js') && !x.endsWith('.test.js'))) if (!['insights.js', 'comments.js'].includes(f)) assert.ok(!/bpa-ig-insights|bpa-ig-comments/.test(fs.readFileSync(path.join(here, f), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')), `${f} must not name the real state files in code`);
});
test('--queue-file: parsed for insights.js, and --summary run from a worktree uses the given queue file', () => {
  assert.equal(queueFileArg(['--summary', '--queue-file', 'q.json']), 'q.json'); assert.equal(queueFileArg(['--summary']), null); assert.throws(() => queueFileArg(['--summary', '--queue-file']), /needs a path/);
  const dir = tmp(); const qf = path.join(dir, 'q.json'); fs.writeFileSync(qf, JSON.stringify({ drafts: [{ id: 'B1', ideaKind: 'fact' }] }));
  fs.writeFileSync(path.join(dir, 'bpa-ig-insights.json'), JSON.stringify({ fetchedAt: '2026-11-16T00:00:00Z', media: [{ id: '1', permalink: 'https://x/1', timestamp: '2026-11-10T08:00:00+0000', productType: 'REELS', reach: 9, queueId: 'B1', metricsAbsent: [] }] }));
  const r = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'insights.js'), '--summary', '--queue-file', qf], { env: { ...process.env, BPA_STATE_DIR: dir }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).best[0].kind, 'fact');
});
