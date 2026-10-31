// Authentication for the local approval endpoint. Fail closed: no token configured => every action refused.
import crypto from 'node:crypto';
export function authorize(req, env = process.env) {
  const want = env.BPA_APPROVAL_TOKEN;
  if (!want) return { ok: false, code: 503, reason: 'approval endpoint disabled: BPA_APPROVAL_TOKEN is not set' };
  const port = env.BPA_APPROVAL_PORT || '3028';
  const host = String(req.headers?.host || '').toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return { ok: false, code: 403, reason: 'bad Host header' };
  if (!/^application\/json\b/i.test(String(req.headers?.['content-type'] || ''))) return { ok: false, code: 415, reason: 'content-type must be application/json' };
  const got = Buffer.from(String(req.headers?.['x-bpa-token'] || '')); const exp = Buffer.from(want);
  if (got.length !== exp.length || !crypto.timingSafeEqual(got, exp)) return { ok: false, code: 401, reason: 'missing or wrong x-bpa-token' };
  return { ok: true, code: 200 };
}
