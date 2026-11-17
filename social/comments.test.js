import './test-env.js';
// Comments nobody answered (read only). Comment texts and commenter names here are made up; the fetch function, the clock and every path are injected.
import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { isQuestion, fetchUnanswered, runCommentsFetch, readCommentsState, countOf, listLines } from './comments.js';
import { InsightsError } from './insights.js';

const TOKEN = 'TOKEN_SHOULD_NEVER_APPEAR_456'; const ACC = '1784'; const OWN = 'ownacct'; const NOW = new Date('2026-11-17T10:00:00Z');
const ok = (j) => ({ ok: true, status: 200, json: async () => j });
const media = (i, n) => ({ id: `9${i}`, permalink: `https://www.instagram.com/reel/P${i}/`, timestamp: '2026-11-10T08:00:00+0000', comments_count: n });
const c = (id, text, o = {}) => ({ id, text, timestamp: '2026-11-11T08:00:00+0000', username: o.username ?? 'someone', from: { id: o.fromId ?? `u-${id}`, username: o.username ?? 'someone' }, ...(o.replies ? { replies: { data: o.replies } } : {}), ...(o.truncated ? { replies: { data: [], paging: { next: 'https://x.example/n' } } } : {}) });
const r = (id, username, fromId) => ({ id, username, from: { id: fromId ?? `u-${id}`, username }, timestamp: '2026-11-12T08:00:00+0000' });
/** commentsOf: mediaId -> array of comment objects (or a function (after) -> page json). */
function fake({ list = [], commentsOf = {}, ownUsername = OWN, error = null } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts }); const u = new URL(url); const p = u.pathname.replace(/^\/v[\d.]+\//, '');
    if (error) return ok({ error });
    if (p === ACC) return ok(ownUsername ? { username: ownUsername, id: ACC } : { error: { code: 10 } });
    if (p === `${ACC}/media`) return ok({ data: list.slice(0, Number(u.searchParams.get('limit'))) });
    const m = /^(\d+)\/comments$/.exec(p); if (m) { const v = commentsOf[m[1]]; return ok(typeof v === 'function' ? v(u.searchParams.get('after')) : { data: v || [] }); }
    return ok({ error: { code: 1 } });
  };
  fn.calls = calls; return fn;
}
const run = (f, o = {}) => fetchUnanswered({ fetchFn: f, token: TOKEN, accountId: ACC, now: NOW, ...o });

test('isQuestion: a question mark, or a question word at the start', () => {
  for (const t of ['Where is this?', 'how much for two', 'What time do you leave', 'Can we book', 'is it open in May', 'Are there rooms', 'do you take kids', 'Does it rain', 'Which month is best', 'Who runs it', 'When does it start', 'Price please', 'Price?', '@someone how much is it', 'nice, what a view?']) assert.equal(isQuestion(t), true, t);
  for (const t of ['Beautiful place', 'Whatever you say', 'Isabella loves it', 'Wow!', 'Dooooo it', '', null, undefined]) assert.equal(isQuestion(t), false, String(t));
});
test('a top-level comment is answered only when a reply to it is from our own account (by name or by id); our own top-level comments are ignored', async () => {
  const f = fake({ list: [media(1, 6)], commentsOf: { 91: [
    c('c1', 'nobody answered this'), c('c2', 'answered by name', { replies: [r('r1', OWN)] }), c('c3', 'answered by id', { replies: [r('r2', 'renamed', ACC)] }),
    c('c4', 'only another visitor replied', { replies: [r('r3', 'visitor')] }), c('c5', 'our own comment', { username: OWN, fromId: ACC }), c('c6', 'third visitor thread', { replies: [r('r4', 'v1'), r('r5', 'v2')] }) ] } });
  const s = await run(f); assert.deepEqual(s.unanswered.map((x) => x.commentId), ['c1', 'c4', 'c6']);
  assert.equal(s.unanswered[0].mediaPermalink, 'https://www.instagram.com/reel/P1/'); assert.equal(s.unanswered[0].text, 'nobody answered this'); assert.equal(s.unanswered[0].from, 'someone'); assert.equal(s.unanswered[0].at, '2026-11-11T08:00:00+0000'); assert.equal(s.unanswered[0].isQuestion, false);
});
test('only media with comments are read, and only the most recent maxMedia media are looked at', async () => {
  const list = [media(1, 0), media(2, 1), media(3, 0), media(4, 2), media(5, 1)];
  const f = fake({ list, commentsOf: { 92: [c('a', 'q?')], 94: [c('b', 'x'), c('c', 'y')], 95: [c('d', 'z')] } });
  const s = await run(f, { maxMedia: 4 }); assert.deepEqual(s.unanswered.map((x) => x.commentId), ['a', 'b', 'c'], 'media 5 is outside the most recent 4');
  const asked = f.calls.map((x) => new URL(x.url).pathname).filter((p) => /comments$/.test(p)).map((p) => p.split('/')[2]); assert.deepEqual(asked.sort(), ['92', '94']);
  assert.equal(s.mediaRead, 4); assert.equal(s.mediaWithComments, 2);
});
test('bounded: at most 3 comment pages per media, and the next-page link (it carries the token) is never followed', async () => {
  const f = fake({ list: [media(1, 500)], commentsOf: { 91: (after) => ({ data: [c(`c${after || 0}`, 'hi')], paging: { cursors: { after: String(Number(after || 0) + 1) }, next: 'https://elsewhere.example/next?access_token=x' } }) } });
  const s = await run(f); assert.ok(f.calls.filter((x) => /91\/comments/.test(x.url)).length <= 3); assert.equal(s.unanswered.length, 3); assert.ok(f.calls.every((x) => !x.url.includes('elsewhere.example')));
});
test('a thread whose replies were cut off by paging is not claimed as unanswered (it is counted as uncertain)', async () => {
  const s = await run(fake({ list: [media(1, 2)], commentsOf: { 91: [c('c1', 'cut off', { truncated: true }), c('c2', 'plain')] } })); assert.deepEqual(s.unanswered.map((x) => x.commentId), ['c2']); assert.equal(s.uncertain, 1);
});
test('every request is a GET to the Graph API host with a timeout', async () => {
  const f = fake({ list: [media(1, 1)], commentsOf: { 91: [c('c1', 'x')] } }); await run(f); assert.ok(f.calls.length >= 3);
  for (const x of f.calls) { assert.ok(x.url.startsWith('https://graph.facebook.com/')); assert.equal(x.opts.method, 'GET'); assert.equal(x.opts.body, undefined); assert.ok(x.opts.signal instanceof AbortSignal); }
});
test('an API error, or an unreadable own account name, stops the run with a named reason and no token; nothing is written', async () => {
  await assert.rejects(run(fake({ error: { code: 190, type: 'OAuthException', message: TOKEN } })), (e) => e instanceof InsightsError && /^api-error code=190/.test(e.reason) && !e.message.includes(TOKEN));
  await assert.rejects(run(fake({ list: [media(1, 1)], ownUsername: null })), (e) => /^api-error code=10/.test(e.reason) || /own-account/.test(e.reason));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-com-')); const statePath = path.join(dir, 'c.json');
  const res = await runCommentsFetch({ fetchFn: fake({ error: { code: 4 } }), token: TOKEN, accountId: ACC, now: NOW, statePath }); assert.equal(res.ok, false); assert.match(res.reason, /^api-error code=4/); assert.equal(fs.existsSync(statePath), false);
});
test('runCommentsFetch writes the private state file (mode 600, atomic, no token) and returns counts only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-com-')); const statePath = path.join(dir, 'bpa-ig-comments.json');
  const f = fake({ list: [media(1, 2)], commentsOf: { 91: [c('c1', 'How much is it?', { username: 'visitorname' }), c('c2', 'lovely', { replies: [r('r1', OWN)] })] } });
  const res = await runCommentsFetch({ fetchFn: f, token: TOKEN, accountId: ACC, now: NOW, statePath });
  assert.deepEqual(res, { ok: true, unanswered: 1, questions: 1, mediaRead: 1, mediaWithComments: 1, uncertain: 0, skippedIds: 0 }); assert.ok(!JSON.stringify(res).includes('visitorname') && !JSON.stringify(res).includes('How much'));
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600); assert.deepEqual(fs.readdirSync(dir), ['bpa-ig-comments.json']);
  const raw = fs.readFileSync(statePath, 'utf8'); assert.ok(!raw.includes(TOKEN)); const s = JSON.parse(raw);
  assert.deepEqual(Object.keys(s).sort(), ['fetchedAt', 'fetchedDay', 'unanswered']); assert.deepEqual(Object.keys(s.unanswered[0]).sort(), ['at', 'commentId', 'from', 'isQuestion', 'mediaPermalink', 'text']); assert.equal(s.unanswered[0].isQuestion, true);
  assert.deepEqual(countOf(readCommentsState(statePath)), { unanswered: 1, questions: 1 }); assert.equal(countOf(null).unanswered, 0);
});
test('listLines (the one place the text is shown) gives date, permalink, text; --questions filters; counts are separate', () => {
  const s = { fetchedAt: NOW.toISOString(), unanswered: [{ commentId: 'a', mediaPermalink: 'https://x/1', at: '2026-11-11T08:00:00+0000', from: 'n1', text: 'Is it open?', isQuestion: true }, { commentId: 'b', mediaPermalink: 'https://x/2', at: '2026-11-12T08:00:00+0000', from: 'n2', text: 'lovely', isQuestion: false }] };
  assert.equal(listLines(s).length, 2); assert.match(listLines(s)[0], /2026-11-11.*https:\/\/x\/1.*Is it open\?/); assert.equal(listLines(s, { questionsOnly: true }).length, 1); assert.deepEqual(listLines(null), []);
});
test('the source holds no absolute user path, no write call and does not use the log', () => {
  const src = fs.readFileSync(new URL('./comments.js', import.meta.url), 'utf8'); assert.ok(!/\/Users\//.test(src)); assert.ok(!/method:\s*'(POST|DELETE|PUT|PATCH)'/i.test(src)); assert.ok(!/(^|[^.\w])log\(|appendFileSync|social\.log|from '\.\/lib\.js'/.test(src), 'comment data never goes near the log');
});
