// Comments on our own Instagram posts that nobody answered (READ ONLY: HTTP GET to the Graph API host; it never replies, likes, hides or deletes).
//   node comments.js --fetch                 read the newest 60 media that have comments, write bpa-ig-comments.json (state folder, mode 600)
//   node comments.js --list [--questions]    print date, permalink and TEXT for the person running it: the only place the text is shown
//   node comments.js --count                 counts only
// A top-level comment is answered when any reply to it is from our own account (by user name or by id); our own top-level comments are ignored.
// Commenter names and comment texts are personal data: they live only in the private state file, never in a log, never in this repository.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { graphGet, listMedia, apiReason, InsightsError, writePrivateJson, liveAccess, MAX_STATE_BYTES, isApiId, deadlineFetch, eastAfricaDay, RUN_DEADLINE_MS } from './insights.js';
import { stateDir } from './stop.js';

export const defaultCommentsPath = (env = process.env) => path.join(stateDir(env), 'bpa-ig-comments.json');
export const COMMENT_PAGES = 3, COMMENT_PAGE_LIMIT = 50;
const COMMENT_FIELDS = 'id,text,timestamp,username,from,replies.limit(50){id,username,from,timestamp}';

/** Plain rule: a question mark anywhere, or the text (after leading @mentions) starts with one of these words. */
export const isQuestion = (text) => {
  const t = String(text ?? '').replace(/^(\s*@\S+)+/, '').trim();
  return /\?/.test(t) || /^(how much|how|what|when|where|which|who|can|is|are|do|does|price)\b/i.test(t);
};

/** Newest `maxMedia` media; for those with a comment count above zero, all top-level comments (3 pages of 50 at most) with their replies. Throws InsightsError (named reason, never a token). */
export async function fetchUnanswered({ fetchFn, token, accountId, now = new Date(), maxMedia = 60 } = {}) {
  if (!isApiId(accountId)) throw new InsightsError('bad-account-id');
  const who = await graphGet(fetchFn, `${accountId}?fields=username`, token);
  if (who.error) throw new InsightsError(apiReason(who.error)); if (!who.username) throw new InsightsError('own-account-name-unreadable');
  const isOwn = (x) => !!x && (x.username === who.username || (x.from && (x.from.username === who.username || String(x.from.id) === String(accountId))));
  const list = await listMedia(fetchFn, { token, accountId, maxMedia, fields: 'id,permalink,timestamp,comments_count' });
  const withComments = list.filter((m) => m.comments_count > 0 && isApiId(m.id)); const unanswered = []; let uncertain = 0; const skippedIds = list.filter((m) => !isApiId(m.id)).length; // an id that is not digits never goes into a path
  for (const m of withComments) {
    let after = null;
    for (let page = 0; page < COMMENT_PAGES; page++) {
      const j = await graphGet(fetchFn, `${m.id}/comments?fields=${COMMENT_FIELDS}&limit=${COMMENT_PAGE_LIMIT}${after ? `&after=${encodeURIComponent(after)}` : ''}`, token);
      if (j.error) throw new InsightsError(apiReason(j.error));
      if (!Array.isArray(j.data)) throw new InsightsError('unexpected-response');
      for (const cm of j.data) {
        if (isOwn(cm)) continue;
        if (cm.replies?.paging?.next) { uncertain++; continue; } // more replies than we read: we cannot say nobody answered
        if ((cm.replies?.data || []).some(isOwn)) continue;
        unanswered.push({ commentId: String(cm.id), mediaPermalink: m.permalink ?? null, at: cm.timestamp ?? null, from: cm.username ?? cm.from?.username ?? null, text: String(cm.text ?? ''), isQuestion: isQuestion(cm.text) });
      }
      after = j.paging?.cursors?.after; if (!after || !j.paging?.next) break;
    }
  }
  return { fetchedAt: now.toISOString(), unanswered, mediaRead: list.length, mediaWithComments: withComments.length, uncertain, skippedIds };
}

export function readCommentsState(p = defaultCommentsPath()) { try { if (fs.statSync(p).size > MAX_STATE_BYTES) return null; const s = JSON.parse(fs.readFileSync(p, 'utf8')); return s && Array.isArray(s.unanswered) ? s : null; } catch { return null; } }
export const countOf = (s) => { const u = s && Array.isArray(s.unanswered) ? s.unanswered : []; return { unanswered: u.length, questions: u.filter((x) => x.isQuestion).length }; };
/** One fetch; writes the private state file only on success. The returned object holds COUNTS ONLY (it may be printed or logged). */
export async function runCommentsFetch({ fetchFn, token, accountId, now = new Date(), maxMedia = 60, statePath = defaultCommentsPath(), force = false, clock = Date.now, deadlineMs = RUN_DEADLINE_MS } = {}) {
  const day = eastAfricaDay(now); const prev = readCommentsState(statePath);
  if (!force && prev && prev.fetchedDay === day) return { ok: true, skipped: 'already-fetched-today', ...countOf(prev) };
  try {
    const s = await fetchUnanswered({ fetchFn: deadlineFetch(fetchFn, { deadlineMs, clock }), token, accountId, now, maxMedia });
    if (s.mediaRead === 0 && prev && prev.unanswered.length) return { ok: false, reason: 'empty-result-kept-previous' }; // an empty media list never replaces a good file
    writePrivateJson(statePath, { fetchedAt: s.fetchedAt, fetchedDay: day, unanswered: s.unanswered });
    return { ok: true, ...countOf(s), mediaRead: s.mediaRead, mediaWithComments: s.mediaWithComments, uncertain: s.uncertain, skippedIds: s.skippedIds };
  } catch (e) { if (e instanceof InsightsError) return { ok: false, reason: e.reason }; throw e; }
}
/** Terminal lines for the person running --list: date, permalink, text. */
const clean = (v) => String(v ?? '').replace(/[\x00-\x1f\x7f]+/g, ' '); // control characters (terminal escapes) never reach the terminal
export function listLines(s, { questionsOnly = false } = {}) {
  return (s && Array.isArray(s.unanswered) ? s.unanswered : []).filter((x) => !questionsOnly || x.isQuestion).map((x) => `${clean(x.at).slice(0, 10)}  ${clean(x.mediaPermalink)}  ${clean(x.text).replace(/\s+/g, ' ')}`);
}

async function main(argv) {
  if (argv.includes('--count')) { const s = readCommentsState(); if (!s) { console.error('comments: no state file yet (run --fetch)'); process.exit(1); } const c = countOf(s); console.log(`comments: ${c.unanswered} unanswered, ${c.questions} of them questions (state from ${s.fetchedAt})`); return; }
  if (argv.includes('--list')) { const s = readCommentsState(); if (!s) { console.error('comments: no state file yet (run --fetch)'); process.exit(1); } for (const l of listLines(s, { questionsOnly: argv.includes('--questions') })) console.log(l); return; }
  if (!argv.includes('--fetch')) { console.error('usage: node comments.js --fetch [--force] | --list [--questions] | --count'); process.exit(2); }
  let acc; try { acc = await liveAccess(); } catch (e) { console.error(`comments: no Page login available (${e?.code || e?.name || 'error'})`); process.exit(1); }
  const r = await runCommentsFetch({ fetchFn: fetch, token: acc.token, accountId: acc.accountId, force: argv.includes('--force') });
  console.log(r.ok ? (r.skipped ? `comments: ${r.skipped} (${r.unanswered} unanswered in the state file)` : `comments: ${r.unanswered} unanswered (${r.questions} questions), ${r.mediaWithComments} of ${r.mediaRead} media have comments, ${r.uncertain} threads uncertain`) : `comments: failed, ${r.reason}`); if (!r.ok) process.exit(1);
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
