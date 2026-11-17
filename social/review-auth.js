// Access rule for the review page. Every /review route (and /health through the published port) goes through here.
// Fail closed: anything unclear is a refusal. Results carry closed-set reason codes only, never header values.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { stateDir } from './stop.js';

export const COOKIE_NAME = 'bpa_review';
export const SESSION_TTL_MS = 12 * 3600e3;
export const accessFilePath = (env = process.env) => path.join(stateDir(env), 'bpa-review-access.json');

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?:\d{1,5}$/;

export function loadAccess({ env = process.env, file = accessFilePath(env), readFile = (f) => fs.readFileSync(f, 'utf8'), statFile = (f) => fs.lstatSync(f) } = {}) {
  let st;
  try { st = statFile(file); } catch { return { ok: false, reason: 'access-file-missing' }; }
  if (!st.isFile()) return { ok: false, reason: 'access-file-malformed' };
  if ((st.mode & 0o077) !== 0) return { ok: false, reason: 'access-file-mode' };
  let obj;
  try { obj = JSON.parse(readFile(file)); } catch { return { ok: false, reason: 'access-file-malformed' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'access-file-malformed' };
  const login = obj.ownerLogin;
  if (typeof login !== 'string' || login === '' || /[\s,]/.test(login)) return { ok: false, reason: 'access-file-malformed' };
  const host = typeof obj.host === 'string' ? obj.host.trim().toLowerCase() : '';
  if (!HOST_RE.test(host)) return { ok: false, reason: 'access-file-malformed' };
  return { ok: true, ownerLogin: login, host };
}

export const SESSION_MIN_AGE_MS = 60e3;   // a session younger than this is never evicted
export const SESSION_ISSUE_GAP_MS = 2e3;  // at most one new session per this time, per process
/** issue() returns a token, or null when it is too soon after the last one or the table is full of young sessions (nothing is evicted then). */
export function createSessions({ ttlMs = SESSION_TTL_MS, now = Date.now, max = 50, minAgeMs = SESSION_MIN_AGE_MS, issueGapMs = SESSION_ISSUE_GAP_MS } = {}) {
  const live = new Map(); // token -> { issuedAt, expiry } (insertion order = age)
  let lastIssue = -Infinity;
  const prune = () => { for (const [t, v] of live) if (v.expiry <= now()) live.delete(t); };
  return {
    issue() {
      prune(); const t0 = now();
      if (t0 - lastIssue < issueGapMs) return null;
      if (live.size >= max) { const oldest = live.entries().next().value; if (!oldest || t0 - oldest[1].issuedAt < minAgeMs) return null; live.delete(oldest[0]); }
      const t = crypto.randomBytes(32).toString('hex'); live.set(t, { issuedAt: t0, expiry: t0 + ttlMs }); lastIssue = t0; return t;
    },
    /** true while a new session was issued less than issueGapMs ago (the only refusal that clears itself in seconds) */
    tooSoon() { return now() - lastIssue < issueGapMs; },
    valid(token) {
      if (typeof token !== 'string') return false;
      prune();
      return live.has(token);
    },
    count() { prune(); return live.size; },
  };
}

export const setCookieHeader = (token, ttlMs = SESSION_TTL_MS) => `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Secure; Path=/review; Max-Age=${Math.floor(ttlMs / 1000)}`;

export const loopbackHost = (host, port) => {
  if (typeof host !== 'string') return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
};

const digest = (s) => crypto.createHash('sha256').update(String(s).toLowerCase()).digest();
const refuse = (code, reason) => ({ ok: false, code, reason });

function cookieValues(header) {
  if (typeof header !== 'string') return [];
  return header.split(';').map((p) => p.trim()).filter((p) => p.startsWith(`${COOKIE_NAME}=`)).map((p) => p.slice(COOKIE_NAME.length + 1));
}

export function checkAccess(req, { access, sessions, needCookie }) {
  if (!access || !access.ok) return refuse(503, 'access-file-unavailable');
  const host = req.headers?.host;
  if (typeof host !== 'string' || host.toLowerCase() !== access.host) return refuse(403, 'bad-host');
  const login = req.headers['tailscale-user-login'];
  if (typeof login !== 'string' || !crypto.timingSafeEqual(digest(login), digest(access.ownerLogin))) return refuse(403, 'bad-login');
  if (needCookie) {
    const vals = cookieValues(req.headers.cookie);
    if (vals.length === 0) return refuse(403, 'no-cookie');
    if (vals.length !== 1 || !sessions.valid(vals[0])) return refuse(403, 'bad-cookie');
  }
  return { ok: true };
}

/** A request that came through `tailscale serve` always carries these; a caller on loopback (the WhatsApp bridge, the worker) never does. */
export function hasProxyHeaders(req) {
  return Object.keys((req && req.headers) || {}).some((n) => { const k = n.toLowerCase(); return k === 'x-forwarded-for' || k === 'x-forwarded-host' || k === 'x-forwarded-proto' || k.startsWith('tailscale-'); });
}

export const PAGE_HEADER = 'x-bpa-page';
/** True for a real page load (browser navigation) or a request that carries the page's own header. Another site's image tag or no-cors fetch is neither; the Tailscale proxy adds the owner's login to those too. */
export function isPageLoad(req) {
  const h = req && req.headers; if (!h || typeof h !== 'object') return false;
  const norm = (v) => (typeof v === 'string' ? v.toLowerCase().trim() : null);
  return (norm(h['sec-fetch-dest']) === 'document' && norm(h['sec-fetch-mode']) === 'navigate') || h[PAGE_HEADER] === '1';
}

export function checkHealthAccess(req, { port, access, sessions }) {
  if (loopbackHost(req.headers?.host, port) && !hasProxyHeaders(req)) return { ok: true };
  return checkAccess(req, { access, sessions, needCookie: true });
}
