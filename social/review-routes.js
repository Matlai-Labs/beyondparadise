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
import { buildItems, listMedia, fileInfoOf } from './review-items.js';
import { readStatus } from './review-status.js';
import { resolveMediaPath, serveMedia } from './review-media.js';
import { readHooks, defaultHooksPath } from './auto-hooks.js';
import { loadIdeaPool } from './idea-drafts.js';
import { libraryDir as libraryDirOf, readManifest } from './clip-library.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_ID = /^m_[0-9a-f]{32}$/;
const SECRET = crypto.randomBytes(32).toString('hex'); // per process: media ids do not survive a restart
const INFO = fileInfoOf(); // one hash cache for the whole process

export const CSP = (nonce) => `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; media-src 'self'; connect-src 'self'; img-src 'self'`;

export function refuse(res, check) {
  res.writeHead(check && check.code === 503 ? 503 : (check && check.code === 405 ? 405 : (check && check.code === 404 ? 404 : 403)), { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('not available');
}

/** The inputs buildItems takes, from the real sources. */
export function defaultInputs(env = process.env) {
  const dir = libraryDirOf(env);
  return {
    readHooks: () => readHooks(defaultHooksPath(env)),
    loadPool: () => loadIdeaPool({ now: new Date(), env }),
    readManifest: () => readManifest(dir),
    libraryDir: dir, info: INFO, secret: SECRET,
    evaluate: async (idea, o) => { const { evaluateIdea } = await import('./auto-lane.js'); return evaluateIdea(idea, { now: o.now, hook: o.hook, sourceNames: o.sourceNames }); },
    previewFor: () => null, // part 1b fills this in
  };
}

export function createReviewHandler({ sessions, loadInputs = defaultInputs, log = () => {}, env = process.env, cacheMs = 10000, now = Date.now, pageFile = path.join(HERE, 'review-page.html'), previewDir = path.join(stateDir(env), 'bpa-review-previews') } = {}) {
  let cache = null; // { at, built: Promise }
  const built = () => {
    if (cache && now() - cache.at < cacheMs) return cache.built;
    const p = (async () => buildItems(loadInputs(env)))(); cache = { at: now(), built: p }; p.catch(() => { if (cache && cache.built === p) cache = null; });
    return p;
  };
  const text = (res, code, body = 'not available') => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };

  async function handle(req, res, p, route) {
    if (route === 'page') {
      let page; try { page = fs.readFileSync(pageFile, 'utf8'); } catch { log('review failed: page-missing page'); return text(res, 503); }
      const nonce = crypto.randomBytes(16).toString('hex');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP(nonce), 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store', 'Set-Cookie': setCookieHeader(sessions.issue()) });
      return res.end(page.split('__NONCE__').join(nonce));
    }
    if (route === 'items') {
      const b = await built();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
      return res.end(JSON.stringify({ status: readStatus({ env }), items: b.items, counts: b.counts, problems: b.problems }));
    }
    if (route === 'media') {
      const id = p.slice('/review/media/'.length);
      if (!MEDIA_ID.test(id)) return text(res, 404);
      const inp = loadInputs(env); let media;
      try { media = listMedia({ manifest: inp.readManifest(), libraryDir: inp.libraryDir, info: inp.info, secret: inp.secret }); } catch { return text(res, 404); } // computed fresh: an id for something that left the list or changed is simply absent
      const entry = media.get(id); if (!entry) return text(res, 404);
      const r = resolveMediaPath(entry.path, [inp.libraryDir, previewDir]);
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
