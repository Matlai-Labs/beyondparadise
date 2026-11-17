// Safe video serving for the review page: path containment, no symbolic links, single byte ranges only.
import fs from 'node:fs';
import path from 'node:path';

/** { ok:true, path } | { ok:false, reason }. The candidate is lstat-ed (a link is refused, even one pointing inside); its real path must lie under the real path of a root (path.relative, not a string prefix). */
export function resolveMediaPath(candidate, roots) {
  let ls; try { ls = fs.lstatSync(candidate); } catch { return { ok: false, reason: 'missing' }; }
  if (ls.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  if (!ls.isFile()) return { ok: false, reason: 'missing' };
  if (path.extname(candidate) !== '.mp4') return { ok: false, reason: 'not-mp4' };
  let real; try { real = fs.realpathSync(candidate); } catch { return { ok: false, reason: 'missing' }; }
  for (const root of Array.isArray(roots) ? roots : []) {
    let r; try { r = fs.realpathSync(root); } catch { continue; }
    const rel = path.relative(r, real);
    if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) return { ok: true, path: real };
  }
  return { ok: false, reason: 'outside-roots' };
}

/** One range only: bytes=a-b, bytes=a-, bytes=-n. Everything else (and size 0) is invalid. No header is the whole file. */
export function parseRange(header, size) {
  if (header === undefined || header === null) return { kind: 'full' };
  if (typeof header !== 'string' || !Number.isInteger(size) || size <= 0) return { kind: 'invalid' };
  const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header); if (!m) return { kind: 'invalid' };
  const [, a, b] = m;
  if (a === '' && b === '') return { kind: 'invalid' };
  if (a === '') { const n = Number(b); if (n === 0) return { kind: 'invalid' }; return { kind: 'range', start: Math.max(0, size - n), end: size - 1 }; }
  const start = Number(a); const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (start >= size || end < start) return { kind: 'invalid' };
  return { kind: 'range', start, end };
}

/** 200 / 206 / 416. The path comes from the server, never from the browser. A stream error ends the response and never throws. */
export function serveMedia(req, res, { path: absPath }) {
  let size; try { size = fs.statSync(absPath).size; } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('not available'); return; }
  const base = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
  const r = parseRange(req.headers && req.headers.range, size);
  if (r.kind === 'invalid') { res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' }); res.end(); return; }
  const start = r.kind === 'range' ? r.start : 0; const end = r.kind === 'range' ? r.end : size - 1;
  if (size === 0) { res.writeHead(200, { ...base, 'Content-Length': '0' }); res.end(); return; }
  res.writeHead(r.kind === 'range' ? 206 : 200, { ...base, 'Content-Length': String(end - start + 1), ...(r.kind === 'range' ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
  const stream = fs.createReadStream(absPath, { start, end });
  stream.on('error', () => { try { res.destroy(); } catch { /* already gone */ } });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
