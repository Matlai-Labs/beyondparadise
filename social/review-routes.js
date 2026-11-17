// All /review/* routes in one function, so approval-server.js only delegates. Every route goes through checkAccess first.
//   GET /review/                the page (sets the session cookie; needs the login header)
//   GET /review/api/items       { status, items, counts, problems } (needs login + cookie; the item list is cached a few seconds)
//   GET /review/media/<id>      a clip video (needs login + cookie; the id list is computed fresh on EVERY request)
// Every refusal answers the plain text `not available`, except one: a page load refused only because a new session was issued under 2 s ago answers a tiny HTML page that reloads itself after 3 s. Logs hold closed-set reason codes and the route kind only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stateDir, stopStatus } from './stop.js';
import { loadAccess, checkAccess, checkAction, checkSameOrigin, cookieOf, setCookieHeader, isPageLoad, PAGE_HEADER } from './review-auth.js';
import { createActions, publicCode } from './bpa-actions.js';
import { parseDecisionBody, parsePostingBody, runDecision, runPosting } from './review-decide.js';
import { decisionsFilePath, readDecisions } from './review-decisions.js';
import { buildDraftItems } from './review-draft-items.js';
import { readQueueStrict, draftVersion } from './draft-version.js';
import { approveSwitchOn } from './approve-switch.js';
import { buildItems, fileInfoOf } from './review-items.js';
import { readClipApprovals, defaultClipApprovalsPath } from './clip-approvals.js';
import { readStatus } from './review-status.js';
import { resolveMediaPath, serveMedia } from './review-media.js';
import { readHooks, defaultHooksPath, claimsSha256 } from './auto-hooks.js';
import { loadIdeaPool } from './idea-drafts.js';
import { libraryDir as libraryDirOf, readManifest } from './clip-library.js';
import { readUsage, defaultUsagePath } from './reel-clip.js';
import { historyFromQueue } from './ideas.js';
import { loadQueue, QUEUE_PATH, finalCheck, igEnabled, autoDir, CONFIG } from './lib.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_ID = /^m_[0-9a-f]{32}$/;
const SECRET = crypto.randomBytes(32).toString('hex'); // per process: media ids do not survive a restart
const INFO = fileInfoOf(); // one hash cache for the whole process

export const CSP = (nonce) => `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; media-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

export function refuse(res, check) {
  const code = check && [404, 405, 429, 503].includes(check.code) ? check.code : 403;
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
  res.end('not available');
}

/** Cache a function's result for ttlMs, per key. A thrown error or a rejected promise is not kept. */
export function ttlMemo(fn, { ttlMs, now = Date.now, key = () => '' } = {}) {
  const store = new Map();
  return (...args) => {
    const k = key(...args); const hit = store.get(k);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = fn(...args); store.set(k, { at: now(), value });
    if (value && typeof value.then === 'function') value.catch(() => { const cur = store.get(k); if (cur && cur.value === value) store.delete(k); });
    return value;
  };
}

export const CHECK_CACHE_MS = 60000; // the idea pool and the hook checks change slowly; the item list itself is cached shorter

/** Ids of drafts with an un-voided approve line in the record. An unreadable record gives an empty set: the server-side check at Approve time is the guard. */
function approvedDraftIds(env) {
  const r = readDecisions(decisionsFilePath(env)); if (!r.ok) return new Set();
  return new Set(r.records.filter((x) => x.kind === 'draft' && x.decision === 'approve' && typeof x.id === 'string').map((x) => x.id));
}

/** The inputs buildItems takes, from the real sources. The idea pool and the hook checks are cached for 60 s (this process also answers the WhatsApp commands and the worker's health call). */
export function createDefaultInputs({ env = process.env, now = Date.now, loadPool = (o) => loadIdeaPool(o), evaluateImpl } = {}) {
  const dir = libraryDirOf(env);
  const checkDraft = ttlMemo((d) => finalCheck(d), { ttlMs: CHECK_CACHE_MS, now, key: (d) => `${d.id}|${draftVersion(d)}` }); // the final check of a draft's exact text, 60 s per id and version
  const evalImpl = evaluateImpl || (async (idea, o) => { const { evaluateIdea } = await import('./auto-lane.js'); return evaluateIdea(idea, { now: o.now, hook: o.hook, sourceNames: o.sourceNames }); });
  return {
    readHooks: () => readHooks(defaultHooksPath(env)),
    loadPool: ttlMemo(() => loadPool({ now: new Date(), env }), { ttlMs: CHECK_CACHE_MS, now }),
    readManifest: () => readManifest(dir),
    libraryDir: dir, info: INFO, secret: SECRET,
    evaluate: ttlMemo((idea, o) => evalImpl(idea, o), { ttlMs: CHECK_CACHE_MS, now, key: (idea, o) => `${idea.id}|${o.hook}|${claimsSha256(idea)}` }),
    readApprovals: () => readClipApprovals(defaultClipApprovalsPath(env)), // the clip decisions the lane reads
    readUsage: () => readUsage(defaultUsagePath(env)),              // the ledger the lane reads
    readHistory: () => historyFromQueue(loadQueue(QUEUE_PATH)),     // posted and queued ideas, as the lane reads them
    readConfig: () => JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')), // fresh from disk
    laneVerdict: async (idea, ctx) => (await import('./auto-lane.js')).laneVerdictFor(idea, ctx),
    sourceFor: async (claim, sourceNames) => { const { sourceLine } = await import('./caption.js'); return sourceLine([claim], { sourceNames }).replace(/^Source: /, ''); }, // the same words the post's own source line uses
    previewFor: () => null, // part 1b fills this in
    autoFolder: autoDir(env), // the one folder a prepared post's video may be served from
    buildDrafts: () => buildDraftItems({
      readQueue: () => readQueueStrict(QUEUE_PATH), checkFor: checkDraft, stop: () => stopStatus({ env }), igOn: igEnabled, approveOn: () => approveSwitchOn(env),
      approvedIds: approvedDraftIds(env), ttlDays: CONFIG.draftTtlDays, autoDir: autoDir(env), info: INFO, secret: SECRET, now: new Date(),
    }),
  };
}
/** The decision actions, from the real sources: the same hash cache, a fresh pool and a fresh evaluation (no 60 s memo) on every decision. One per process. */
export function createDefaultActions(env = process.env) {
  const dir = libraryDirOf(env);
  return createActions({
    env, libraryDir: dir, info: INFO,
    loadPool: () => loadIdeaPool({ now: new Date(), env }),
    evaluate: async (idea, o) => { const { evaluateIdea } = await import('./auto-lane.js'); return evaluateIdea(idea, { now: o.now, hook: o.hook, sourceNames: o.sourceNames }); },
    readManifest: () => readManifest(dir),
    readUsage: () => readUsage(defaultUsagePath(env)),
    readHistory: () => historyFromQueue(loadQueue(QUEUE_PATH)),
  });
}
let DEFAULT_ACTIONS = null;
export function defaultActions(env = process.env) { if (!DEFAULT_ACTIONS) DEFAULT_ACTIONS = createDefaultActions(env); return DEFAULT_ACTIONS; }
let DEFAULT_INPUTS = null;
export function defaultInputs(env = process.env) { if (!DEFAULT_INPUTS) DEFAULT_INPUTS = createDefaultInputs({ env }); return DEFAULT_INPUTS; }

export const MAX_BODY = 2048; // bytes
const BODY_WAIT_MS = 10000;
// path -> { route, method }; a Map, so a hostile path such as /review/api/__proto__ is just a miss. /review/media/<id> is matched by prefix.
const ROUTES = new Map([['/review/', { route: 'page', method: 'GET' }], ['/review/api/items', { route: 'items', method: 'GET' }], ['/review/api/session', { route: 'session', method: 'POST' }], ['/review/api/decide', { route: 'decide', method: 'POST' }], ['/review/api/posting', { route: 'posting', method: 'POST' }]]);

export function createReviewHandler({ sessions, loadInputs = defaultInputs, loadActions = defaultActions, recordFile = decisionsFilePath(), postingOpts = {}, log = () => {}, env = process.env, cacheMs = 10000, now = Date.now, pageFile = path.join(HERE, 'review-page.html'), previewDir = path.join(stateDir(env), 'bpa-review-previews') } = {}) {
  let cache = null; // { at, built: Promise }
  let lastMedia = new Map(); let lastLibraryDir = null; let lastAutoDir = null; // the id to file map of the latest item build: media requests are answered from it, never by building a list
  const built = () => {
    if (cache && now() - cache.at < cacheMs) return cache.built;
    const p = (async () => { const inp = loadInputs(env); const b = await buildItems(inp); lastMedia = b.media; lastLibraryDir = inp.libraryDir; lastAutoDir = inp.autoFolder; return b; })(); cache = { at: now(), built: p }; p.catch(() => { if (cache && cache.built === p) cache = null; });
    return p;
  };
  // The one refusal that clears itself: another new session was issued under 2 s ago. A tiny page, no script, that asks again in 3 s. Same headers and the same CSP as the real page.
  const waitPage = (res) => {
    const nonce = crypto.randomBytes(16).toString('hex');
    res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP(nonce), 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store' });
    res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="3"><title>Beyond Paradise: review</title></head><body style="font:17px system-ui,sans-serif;padding:24px"><p>One moment. The page opens by itself.</p></body></html>');
  };
  const text = (res, code, body = 'not available') => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' }); res.end(body); };
  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' }); res.end(JSON.stringify(obj)); };
  // an answer that leaves unread input: tell the client the connection ends, and destroy it once the answer is out (never before, or no answer is sent)
  const early = (req, res, code) => { res.setHeader('Connection', 'close'); text(res, code); res.on('finish', () => { try { req.destroy(); } catch { /* gone */ } }); };
  // the body, counted in BYTES, only after every guard has passed. Content-Length is judged first and the body is never awaited when it is too big.
  const ABORTED = Symbol('aborted'); // SR5: the client went away before the body was complete (not a size problem)
  function readBody(req, res) {
    return new Promise((resolve) => {
      const cl = req.headers['content-length'];
      if (cl !== undefined && (!/^\d{1,10}$/.test(cl) || Number(cl) > MAX_BODY)) { early(req, res, 413); return resolve(null); }
      const chunks = []; let n = 0; let done = false;
      const fin = (v) => { if (done) return; done = true; clearTimeout(timer); req.removeAllListeners('data'); resolve(v); };
      const timer = setTimeout(() => { early(req, res, 413); fin(null); }, BODY_WAIT_MS); timer.unref?.();
      req.on('data', (c) => { const b = Buffer.isBuffer(c) ? c : Buffer.from(c); n += b.length; if (n > MAX_BODY) { early(req, res, 413); return fin(null); } chunks.push(b); });
      req.on('end', () => fin(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => fin(ABORTED)); req.on('aborted', () => fin(ABORTED)); req.on('close', () => fin(ABORTED)); // 'close' after a complete body finds fin already done
    });
  }
  async function handlePost(req, res, route, access) {
    if (route === 'session') {
      if (req.headers[PAGE_HEADER] !== '1') { log('review refused: no-page-header session'); return refuse(res, { code: 403 }); }
      { const so = checkSameOrigin(req); if (!so.ok) { log(`review refused: ${so.reason} session`); return refuse(res, so); } }
      const t = sessions.actionToken(cookieOf(req)); if (t === null) { log('review refused: bad-cookie session'); return refuse(res, { code: 403 }); }
      return json(res, 200, { ok: true, token: t });
    }
    const chk = checkAction(req, { sessions }); if (!chk.ok) { log(`review refused: ${chk.reason} ${route}`); res.setHeader('Connection', 'close'); refuse(res, chk); res.on('finish', () => { try { req.destroy(); } catch { /* gone */ } }); return; }
    const so = checkSameOrigin(req); if (!so.ok) { log(`review refused: ${so.reason} ${route}`); res.setHeader('Connection', 'close'); refuse(res, so); res.on('finish', () => { try { req.destroy(); } catch { /* gone */ } }); return; } // SR1, before the body is read
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json') { log(`review refused: content-type ${route}`); return early(req, res, 415); }
    const body = await readBody(req, res); if (body === ABORTED) { log(`review refused: client-aborted ${route}`); return; } if (body === null) { log(`review refused: body-size ${route}`); return; }
    if (route === 'decide') {
      const pr = parseDecisionBody(body); if (!pr.ok) { log('review refused: bad-request decide'); return json(res, 400, { ok: false, code: 'bad-request' }); }
      const r = await runDecision(pr.req, { actions: loadActions(env), recordFile, claimedLogin: access.ownerLogin });
      if (r && r.ok === true) { cache = null; log(`review decision: ${pr.req.action} ${pr.req.kind} ok`); return json(res, 200, { ok: true, change: r.change, ...(r.enforced !== undefined ? { enforced: r.enforced } : {}) }); }
      const code = publicCode(r && r.code); log(`review decision: ${pr.req.action} ${pr.req.kind} refused ${code}`); return json(res, 409, { ok: false, code });
    }
    const pp = parsePostingBody(body); if (!pp.ok) { log('review refused: bad-request posting'); return json(res, 400, { ok: false, code: 'bad-request' }); }
    const r = await runPosting(pp.action, { recordFile, claimedLogin: access.ownerLogin, env, log, ...(pp.seen !== undefined ? { seen: pp.seen } : {}), ...postingOpts });
    if (r && r.ok === true) { cache = null; log(`review decision: ${pp.action} posting ok`); return json(res, 200, { ok: true, ...(r.note ? { note: r.note } : {}) }); }
    const code = publicCode(r && r.code); log(`review decision: ${pp.action} posting refused ${code}`); return json(res, 409, { ok: false, code });
  }

  async function handle(req, res, p, route) {
    if (route === 'page') {
      let page; try { page = fs.readFileSync(pageFile, 'utf8'); } catch { log('review failed: page-missing page'); return text(res, 503); }
      // a request that already carries a valid cookie gets the page and no new cookie; a cookie-less one needs a new session, which is rate limited (429)
      const hasCookie = checkAccess(req, { access: loadAccess({ env }), sessions, needCookie: true }).ok;
      let cookieHeader = null;
      if (!hasCookie && !isPageLoad(req)) { log('review refused: not-a-page-load page'); refuse(res, { code: 403 }); return; } // nothing is issued to an image tag or no-cors fetch from another site
      if (!hasCookie) { const tok = sessions.issue(); if (!tok) { log('review refused: rate-limited page'); return sessions.tooSoon() ? waitPage(res) : refuse(res, { code: 429 }); } cookieHeader = setCookieHeader(tok); }
      const nonce = crypto.randomBytes(16).toString('hex');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP(nonce), 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store', ...(cookieHeader ? { 'Set-Cookie': cookieHeader } : {}) });
      return res.end(page.split('__NONCE__').join(nonce));
    }
    if (route === 'items') {
      const b = await built();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
      return res.end(JSON.stringify({ status: readStatus({ env }), items: b.items, counts: b.counts, problems: b.problems }));
    }
    if (route === 'media') {
      const id = p.slice('/review/media/'.length);
      if (!MEDIA_ID.test(id)) return text(res, 404);
      const entry = lastMedia.get(id); if (!entry) return text(res, 404);
      if (typeof entry.size === 'number') { // file identity is checked on EVERY request: a file that changed since the build is not served under its old id
        let st; try { st = fs.lstatSync(entry.path); } catch { return text(res, 404); }
        if (st.isSymbolicLink() || !st.isFile() || st.size !== entry.size || st.mtimeMs !== entry.mtimeMs || st.ino !== entry.ino) return text(res, 404);
      }
      const r = resolveMediaPath(entry.path, [lastLibraryDir, lastAutoDir, previewDir].filter(Boolean));
      if (!r.ok) { log(`review media refused: ${r.reason}`); return text(res, 404); }
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      return serveMedia(req, res, { path: r.path });
    }
    return text(res, 404);
  }

  return (req, res) => {
    const p = String(req.url || '').split('?')[0];
    if (!(p === '/review/' || p.startsWith('/review/'))) return false;
    const def = ROUTES.get(p); const route = def ? def.route : (p.startsWith('/review/media/') ? 'media' : 'other'); const method = def ? def.method : 'GET';
    const access = loadAccess({ env });
    const chk = checkAccess(req, { access, sessions, needCookie: p !== '/review/' });
    if (!chk.ok) { log(`review refused: ${chk.reason} ${route}`); if (req.method === 'POST') { res.setHeader('Connection', 'close'); res.on('finish', () => { try { req.destroy(); } catch { /* gone */ } }); } refuse(res, chk); return true; }
    if (req.method !== method) { log(`review refused: method ${route}`); refuse(res, { code: 405 }); return true; }
    const run = method === 'POST' ? handlePost(req, res, route, access) : handle(req, res, p, route);
    run.catch(() => { log(`review failed: error ${route}`); try { if (!res.headersSent) text(res, 503); else res.destroy(); } catch { /* gone */ } });
    return true;
  };
}
