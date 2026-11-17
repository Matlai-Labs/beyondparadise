// All /review/* routes in one function, so approval-server.js only delegates. Every route goes through checkAccess first.
//   GET /review/                the page (sets the session cookie; needs the login header)
//   GET /review/api/items       { status, items, counts, problems } (needs login + cookie; the item list is cached a few seconds)
//   GET /review/media/<id>      a clip video (needs login + cookie; the id list is computed fresh on EVERY request)
// Every refusal answers the plain text `not available`. Logs hold closed-set reason codes and the route kind only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stateDir } from './stop.js';
import { loadAccess, checkAccess, setCookieHeader } from './review-auth.js';
import { buildItems, fileInfoOf } from './review-items.js';
import { readStatus } from './review-status.js';
import { resolveMediaPath, serveMedia } from './review-media.js';
import { readHooks, defaultHooksPath, claimsSha256 } from './auto-hooks.js';
import { loadIdeaPool } from './idea-drafts.js';
import { libraryDir as libraryDirOf, readManifest } from './clip-library.js';
import { readUsage, defaultUsagePath } from './reel-clip.js';
import { historyFromQueue } from './ideas.js';
import { loadQueue, QUEUE_PATH } from './lib.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_ID = /^m_[0-9a-f]{32}$/;
const SECRET = crypto.randomBytes(32).toString('hex'); // per process: media ids do not survive a restart
const INFO = fileInfoOf(); // one hash cache for the whole process

export const CSP = (nonce) => `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; media-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

export function refuse(res, check) {
  const code = check && [404, 405, 429, 503].includes(check.code) ? check.code : 403;
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
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

/** The inputs buildItems takes, from the real sources. The idea pool and the hook checks are cached for 60 s (this process also answers the WhatsApp commands and the worker's health call). */
export function createDefaultInputs({ env = process.env, now = Date.now, loadPool = (o) => loadIdeaPool(o), evaluateImpl } = {}) {
  const dir = libraryDirOf(env);
  const evalImpl = evaluateImpl || (async (idea, o) => { const { evaluateIdea } = await import('./auto-lane.js'); return evaluateIdea(idea, { now: o.now, hook: o.hook, sourceNames: o.sourceNames }); });
  return {
    readHooks: () => readHooks(defaultHooksPath(env)),
    loadPool: ttlMemo(() => loadPool({ now: new Date(), env }), { ttlMs: CHECK_CACHE_MS, now }),
    readManifest: () => readManifest(dir),
    libraryDir: dir, info: INFO, secret: SECRET,
    evaluate: ttlMemo((idea, o) => evalImpl(idea, o), { ttlMs: CHECK_CACHE_MS, now, key: (idea, o) => `${idea.id}|${o.hook}|${claimsSha256(idea)}` }),
    readUsage: () => readUsage(defaultUsagePath(env)),              // the ledger the lane reads
    readHistory: () => historyFromQueue(loadQueue(QUEUE_PATH)),     // posted and queued ideas, as the lane reads them
    readConfig: () => JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')), // fresh from disk
    laneVerdict: async (idea, ctx) => (await import('./auto-lane.js')).laneVerdictFor(idea, ctx),
    sourceFor: async (claim, sourceNames) => { const { sourceLine } = await import('./caption.js'); return sourceLine([claim], { sourceNames }).replace(/^Source: /, ''); }, // the same words the post's own source line uses
    previewFor: () => null, // part 1b fills this in
  };
}
let DEFAULT_INPUTS = null;
export function defaultInputs(env = process.env) { if (!DEFAULT_INPUTS) DEFAULT_INPUTS = createDefaultInputs({ env }); return DEFAULT_INPUTS; }

export function createReviewHandler({ sessions, loadInputs = defaultInputs, log = () => {}, env = process.env, cacheMs = 10000, now = Date.now, pageFile = path.join(HERE, 'review-page.html'), previewDir = path.join(stateDir(env), 'bpa-review-previews') } = {}) {
  let cache = null; // { at, built: Promise }
  let lastMedia = new Map(); let lastLibraryDir = null; // the id to file map of the latest item build: media requests are answered from it, never by building a list
  const built = () => {
    if (cache && now() - cache.at < cacheMs) return cache.built;
    const p = (async () => { const inp = loadInputs(env); const b = await buildItems(inp); lastMedia = b.media; lastLibraryDir = inp.libraryDir; return b; })(); cache = { at: now(), built: p }; p.catch(() => { if (cache && cache.built === p) cache = null; });
    return p;
  };
  const text = (res, code, body = 'not available') => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(body); };

  async function handle(req, res, p, route) {
    if (route === 'page') {
      let page; try { page = fs.readFileSync(pageFile, 'utf8'); } catch { log('review failed: page-missing page'); return text(res, 503); }
      // a request that already carries a valid cookie gets the page and no new cookie; a cookie-less one needs a new session, which is rate limited (429)
      const hasCookie = checkAccess(req, { access: loadAccess({ env }), sessions, needCookie: true }).ok;
      let cookieHeader = null;
      if (!hasCookie) { const tok = sessions.issue(); if (!tok) { log('review refused: rate-limited page'); return refuse(res, { code: 429 }); } cookieHeader = setCookieHeader(tok); }
      const nonce = crypto.randomBytes(16).toString('hex');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP(nonce), 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store', ...(cookieHeader ? { 'Set-Cookie': cookieHeader } : {}) });
      return res.end(page.split('__NONCE__').join(nonce));
    }
    if (route === 'items') {
      const b = await built();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
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
      const r = resolveMediaPath(entry.path, [lastLibraryDir, previewDir].filter(Boolean));
      if (!r.ok) { log(`review media refused: ${r.reason}`); return text(res, 404); }
      return serveMedia(req, res, { path: r.path });
    }
    return text(res, 404);
  }

  return (req, res) => {
    const p = String(req.url || '').split('?')[0];
    if (!(p === '/review/' || p.startsWith('/review/'))) return false;
    const route = p === '/review/' ? 'page' : (p === '/review/api/items' ? 'items' : (p.startsWith('/review/media/') ? 'media' : 'other'));
    const chk = checkAccess(req, { access: loadAccess({ env }), sessions, needCookie: p !== '/review/' });
    if (!chk.ok) { log(`review refused: ${chk.reason} ${route}`); refuse(res, chk); return true; }
    if (req.method !== 'GET') { refuse(res, { code: 405 }); return true; }
    handle(req, res, p, route).catch(() => { log(`review failed: error ${route}`); try { if (!res.headersSent) text(res, 503); else res.destroy(); } catch { /* gone */ } });
    return true;
  };
}
