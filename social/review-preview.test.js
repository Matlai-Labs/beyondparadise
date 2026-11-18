import './test-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { previewKey, ffmpegArgs, createPreviewMaker, findFfmpeg } from './review-preview.js';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-prev-'));
const entryOf = (file) => { const st = fs.statSync(file); return { path: file, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino }; };
// a fake ffmpeg: writes the output file named by the last argument
const fakeRun = (calls, { fail = false, empty = false, delay = 0 } = {}) => async (bin, args) => {
  calls.push({ bin, args, at: Date.now() }); if (delay) await new Promise((r) => setTimeout(r, delay));
  if (fail) throw new Error('ffmpeg exited 1'); fs.writeFileSync(args[args.length - 1], empty ? '' : 'H264-PREVIEW');
};

test('previewKey: 32 hex, stable, and different for another path, size, mtime or inode', () => {
  const e = { path: '/a/b.mp4', size: 10, mtimeMs: 5, ino: 7 };
  assert.match(previewKey(e), /^[0-9a-f]{32}$/); assert.equal(previewKey(e), previewKey({ ...e }));
  for (const o of [{ path: '/a/c.mp4' }, { size: 11 }, { mtimeMs: 6 }, { ino: 8 }]) assert.notEqual(previewKey(e), previewKey({ ...e, ...o }), JSON.stringify(o));
});

test('ffmpegArgs: H.264 High, yuv420p, at most 720 wide, no more than level 4.0, +faststart, MP4, the source is only read, the output is the last argument', () => {
  const a = ffmpegArgs('/in/src.mp4', '/out/x.tmp'); const s = a.join(' ');
  assert.equal(a[a.indexOf('-i') + 1], '/in/src.mp4'); assert.equal(a[a.length - 1], '/out/x.tmp');
  assert.match(s, /-c:v libx264/); assert.match(s, /-profile:v high/); assert.match(s, /-pix_fmt yuv420p/); assert.match(s, /-level:v 4\.0/); assert.match(s, /-movflags \+faststart/); assert.match(s, /-f mp4/);
  assert.match(s, /scale=/); assert.match(s, /720/); assert.match(s, /-c:a aac/); assert.match(s, /-map 0:a:0\?/); assert.match(s, /-nostdin/);
  assert.ok(!a.includes('-y') || a.indexOf('-y') < a.indexOf('-i'), 'overwrite flag only before the input');
});

test('findFfmpeg: BPA_FFMPEG wins; otherwise an existing known path; otherwise the bare name', () => {
  assert.equal(findFfmpeg({ BPA_FFMPEG: '/x/ffmpeg' }, () => false), '/x/ffmpeg');
  assert.equal(findFfmpeg({}, (p) => p === '/opt/homebrew/bin/ffmpeg'), '/opt/homebrew/bin/ffmpeg');
  assert.equal(findFfmpeg({}, () => false), 'ffmpeg');
});

test('get: builds once into the cache folder, atomically, and serves the cache after that; the original is untouched', async () => {
  const src = path.join(mk(), 'c.mp4'); fs.writeFileSync(src, 'ORIGINAL'); const cache = path.join(mk(), 'cache', 'h264'); const calls = [];
  const m = createPreviewMaker({ cacheDir: cache, run: fakeRun(calls), ffmpeg: 'ff' });
  const p1 = await m.get(entryOf(src)); assert.equal(path.dirname(p1), cache); assert.equal(path.extname(p1), '.mp4'); assert.equal(fs.readFileSync(p1, 'utf8'), 'H264-PREVIEW');
  const p2 = await m.get(entryOf(src)); assert.equal(p2, p1); assert.equal(calls.length, 1, 'cached');
  assert.equal(fs.readFileSync(src, 'utf8'), 'ORIGINAL'); assert.deepEqual(fs.readdirSync(cache), [path.basename(p1)], 'no temporary file left');
  assert.equal(calls[0].args[calls[0].args.indexOf('-i') + 1], src); assert.notEqual(calls[0].args[calls[0].args.length - 1], p1, 'written to a temporary name first');
});

test('get: a new process finds the cache from before (a restart does not redo the work)', async () => {
  const src = path.join(mk(), 'c.mp4'); fs.writeFileSync(src, 'O'); const cache = path.join(mk(), 'h264'); const c1 = [], c2 = [];
  const p = await createPreviewMaker({ cacheDir: cache, run: fakeRun(c1), ffmpeg: 'ff' }).get(entryOf(src));
  assert.equal(await createPreviewMaker({ cacheDir: cache, run: fakeRun(c2), ffmpeg: 'ff' }).get(entryOf(src)), p); assert.equal(c2.length, 0);
});

test('get: two requests for the same clip at once run ffmpeg once', async () => {
  const src = path.join(mk(), 'c.mp4'); fs.writeFileSync(src, 'O'); const calls = []; const m = createPreviewMaker({ cacheDir: path.join(mk(), 'h'), run: fakeRun(calls, { delay: 30 }), ffmpeg: 'ff' });
  const [a, b] = await Promise.all([m.get(entryOf(src)), m.get(entryOf(src))]); assert.equal(a, b); assert.equal(calls.length, 1);
});

test('get: a failed or empty build answers null, leaves nothing behind, and is not retried in a loop', async () => {
  const src = path.join(mk(), 'c.mp4'); fs.writeFileSync(src, 'O'); const logs = [];
  for (const opt of [{ fail: true }, { empty: true }]) {
    const calls = []; const cache = path.join(mk(), 'h'); const m = createPreviewMaker({ cacheDir: cache, run: fakeRun(calls, opt), ffmpeg: 'ff', log: (l) => logs.push(l) });
    assert.equal(await m.get(entryOf(src)), null); assert.equal(await m.get(entryOf(src)), null); assert.equal(calls.length, 1, 'the failure is remembered for this process');
    assert.deepEqual(fs.readdirSync(cache), [], 'no partial file');
  }
  assert.ok(logs.some((l) => /preview/i.test(l)), 'a failure is logged'); assert.ok(logs.every((l) => !l.includes(path.dirname(src))), 'no folder path in the log');
});

test('get: a changed source (new mtime) gets a new preview, never the old one', async () => {
  const src = path.join(mk(), 'c.mp4'); fs.writeFileSync(src, 'A'); const calls = []; const m = createPreviewMaker({ cacheDir: path.join(mk(), 'h'), run: fakeRun(calls), ffmpeg: 'ff' });
  const p1 = await m.get(entryOf(src)); const t = new Date(Date.now() + 5000); fs.utimesSync(src, t, t); const p2 = await m.get(entryOf(src)); assert.notEqual(p1, p2); assert.equal(calls.length, 2);
});

test('warm: one build at a time, skips what is cached, then removes cache files that no clip needs any more', async () => {
  const dir = mk(); const files = [1, 2, 3].map((i) => { const f = path.join(dir, `c${i}.mp4`); fs.writeFileSync(f, `O${i}`); return f; }); const cache = path.join(mk(), 'h'); fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, `${'0'.repeat(32)}.mp4`), 'STALE'); fs.writeFileSync(path.join(cache, 'notes.txt'), 'keep: not ours');
  let live = 0, peak = 0; const calls = [];
  const run = async (bin, args) => { live++; peak = Math.max(peak, live); calls.push(args); await new Promise((r) => setTimeout(r, 15)); fs.writeFileSync(args[args.length - 1], 'P'); live--; };
  const m = createPreviewMaker({ cacheDir: cache, run, ffmpeg: 'ff' }); await m.get(entryOf(files[0])); calls.length = 0;
  await m.warm(files.map(entryOf)); assert.equal(peak, 1); assert.equal(calls.length, 2, 'the cached one is skipped');
  const left = fs.readdirSync(cache).sort(); assert.equal(left.length, 4, 'three previews + the file that is not ours'); assert.ok(left.includes('notes.txt')); assert.ok(!left.includes(`${'0'.repeat(32)}.mp4`), 'stale preview removed');
});

test('warm: a clip whose build failed does not stop the others', async () => {
  const dir = mk(); const files = [1, 2].map((i) => { const f = path.join(dir, `c${i}.mp4`); fs.writeFileSync(f, `O${i}`); return f; }); let n = 0;
  const run = async (bin, args) => { n++; if (n === 1) throw new Error('boom'); fs.writeFileSync(args[args.length - 1], 'P'); };
  const m = createPreviewMaker({ cacheDir: path.join(mk(), 'h'), run, ffmpeg: 'ff' }); await m.warm(files.map(entryOf)); assert.equal(n, 2);
  assert.equal(await m.get(entryOf(files[0])), null); assert.ok(await m.get(entryOf(files[1])));
});

const ff = findFfmpeg(process.env); const hasFf = spawnSync(ff, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
const canHevc = hasFf.status === 0 && /libx265/.test(hasFf.stdout) && /libx264/.test(hasFf.stdout);
test('REAL ffmpeg: a 10-bit HEVC clip in a .mp4 (the kind Chrome on Windows cannot play) comes out as 8-bit H.264 High yuv420p, moov first, 720 wide; the original is byte-identical', { skip: canHevc ? false : 'no ffmpeg with libx264 and libx265 here' }, async () => {
  const dir = mk(); const src = path.join(dir, 'hevc.mp4');
  execFileSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=2', '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', '-an', src]);
  const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', f], { encoding: 'utf8' })).streams[0];
  assert.equal(probe(src).codec_name, 'hevc'); const before = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex');
  const m = createPreviewMaker({ cacheDir: path.join(dir, 'h264'), ffmpeg: ff }); const out = await m.get(entryOf(src)); assert.ok(out, 'a preview was made');
  const s = probe(out); assert.equal(s.codec_name, 'h264'); assert.equal(s.profile, 'High'); assert.equal(s.pix_fmt, 'yuv420p'); assert.equal(s.width, 720); assert.equal(s.height, 1280); assert.ok(Number(s.level) <= 40);
  const bytes = fs.readFileSync(out); assert.ok(bytes.indexOf('moov') > 0 && bytes.indexOf('moov') < bytes.indexOf('mdat'), 'moov before mdat (+faststart)');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex'), before, 'original untouched');
});
