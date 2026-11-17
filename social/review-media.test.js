import './test-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { resolveMediaPath, parseRange, serveMedia } from './review-media.js';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-media-'));

test('resolveMediaPath allows files inside a root, refuses everything else', () => {
  const lib = mk(), evil = lib + '-evil', other = mk(); fs.mkdirSync(evil); fs.writeFileSync(path.join(lib, 'a.mp4'), 'A'); fs.writeFileSync(path.join(evil, 'x.mp4'), 'X'); fs.writeFileSync(path.join(lib, 'a.txt'), 'T'); fs.writeFileSync(path.join(other, 'o.mp4'), 'O');
  fs.symlinkSync(path.join(lib, 'a.mp4'), path.join(lib, 'link.mp4')); fs.symlinkSync(other, path.join(lib, 'dir'));
  assert.equal(resolveMediaPath(path.join(lib, 'a.mp4'), [lib]).ok, true); assert.equal(resolveMediaPath(path.join(other, 'o.mp4'), [lib, other]).ok, true, 'second root');
  assert.equal(resolveMediaPath(path.join(lib, 'link.mp4'), [lib]).reason, 'symlink'); assert.equal(resolveMediaPath(path.join(lib, 'dir', 'o.mp4'), [lib]).reason, 'outside-roots');
  assert.equal(resolveMediaPath(path.join(evil, 'x.mp4'), [lib]).reason, 'outside-roots'); assert.equal(resolveMediaPath(path.join(lib, '..', path.basename(evil), 'x.mp4'), [lib]).reason, 'outside-roots');
  assert.equal(resolveMediaPath(path.join(lib, 'a.txt'), [lib]).reason, 'not-mp4'); assert.equal(resolveMediaPath(path.join(lib, 'none.mp4'), [lib]).reason, 'missing');
});
test('resolveMediaPath: a root that does not exist allows nothing; a folder named .mp4 is not a file', () => {
  const lib = mk(); fs.mkdirSync(path.join(lib, 'd.mp4')); fs.writeFileSync(path.join(lib, 'a.mp4'), 'A');
  assert.equal(resolveMediaPath(path.join(lib, 'a.mp4'), [path.join(lib, 'nope')]).ok, false); assert.equal(resolveMediaPath(path.join(lib, 'a.mp4'), []).ok, false);
  assert.equal(resolveMediaPath(path.join(lib, 'd.mp4'), [lib]).ok, false);
});
test('parseRange table (focus 2)', () => {
  const p = (h, s = 100) => parseRange(h, s);
  assert.deepEqual(p(undefined), { kind: 'full' }); assert.deepEqual(p('bytes=0-9'), { kind: 'range', start: 0, end: 9 }); assert.deepEqual(p('bytes=90-'), { kind: 'range', start: 90, end: 99 }); assert.deepEqual(p('bytes=-10'), { kind: 'range', start: 90, end: 99 }); assert.deepEqual(p('bytes=0-999'), { kind: 'range', start: 0, end: 99 });
  for (const h of ['bytes=100-', 'bytes=5-2', 'bytes=a-b', 'items=0-1', 'bytes=0-1,5-6', 'bytes=', 'bytes=--1', '', 'bytes=-', 'bytes=-0']) assert.deepEqual(p(h), { kind: 'invalid' }, h);
  assert.deepEqual(p('bytes=0-', 0), { kind: 'invalid' }); assert.deepEqual(p('bytes=-500'), { kind: 'range', start: 0, end: 99 });
});
test('serveMedia over HTTP: 200, 206, 416, headers', async () => {
  const f = path.join(mk(), 'v.mp4'); fs.writeFileSync(f, Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251)));
  const srv = http.createServer((req, res) => serveMedia(req, res, { path: f })); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  const get = (headers) => new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path: '/', headers }, (res) => { const bufs = []; res.on('data', (b) => bufs.push(b)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(bufs) })); }).on('error', reject); });
  try {
    const full = await get({}); assert.equal(full.status, 200); assert.equal(full.body.length, 1000); assert.equal(full.headers['cache-control'], 'private, no-store'); assert.equal(full.headers['accept-ranges'], 'bytes'); assert.equal(full.headers['x-content-type-options'], 'nosniff'); assert.equal(full.headers['content-type'], 'video/mp4'); assert.equal(full.headers['content-length'], '1000');
    const part = await get({ range: 'bytes=0-9' }); assert.equal(part.status, 206); assert.equal(part.headers['content-range'], 'bytes 0-9/1000'); assert.equal(part.headers['content-length'], '10'); assert.deepEqual([...part.body], Array.from({ length: 10 }, (_, i) => i));
    const tail = await get({ range: 'bytes=-5' }); assert.equal(tail.status, 206); assert.equal(tail.headers['content-range'], 'bytes 995-999/1000'); assert.equal(tail.body.length, 5);
    for (const r of ['bytes=1000-', 'bytes=9-3', 'bytes=zz', 'bytes=0-1,5-6']) { const bad = await get({ range: r }); assert.equal(bad.status, 416, r); assert.equal(bad.headers['content-range'], 'bytes */1000'); assert.equal(bad.body.length, 0); }
  } finally { srv.close(); }
});
test('serveMedia: a file that vanished ends the response without throwing', async () => {
  const srv = http.createServer((req, res) => serveMedia(req, res, { path: path.join(mk(), 'gone.mp4') })); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  try { const r = await new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path: '/' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject); }); assert.equal(r, 404); } finally { srv.close(); }
});
