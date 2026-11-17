import './test-env.js';
// B: the hook overlay (overlay.py) and composeClip (one ffmpeg overlay command, no text filter, no audio, output outside every repository).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildComposeArgs, composeClip, renderOverlay, OVERLAY_PY } from './overlay.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-ov-'));
const hasPillow = spawnSync('python3', ['-c', 'import PIL']).status === 0;
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const okChecks = { check: async () => ({ ok: true, problems: [], durationSec: 7 }), qa: () => ({ ok: true, problems: [], duration: 7, black: 0 }) };

test('overlay.py uses the same sans-bold font list as card.py (no drift)', () => {
  const list = (f) => { const m = /^SANS_B\s*=\s*(\[[^\]]*\])/m.exec(fs.readFileSync(path.join(HERE, f), 'utf8')); assert.ok(m, `SANS_B in ${f}`); return JSON.parse(m[1]); };
  assert.deepEqual(list('overlay.py'), list('card.py'));
});

test('buildComposeArgs: one overlay filter, no text filter, no audio, h264 yuv420p 30 fps, the output last', () => {
  const a = buildComposeArgs({ clipFile: '/x/c.mp4', overlayPng: '/x/o.png', out: '/y/out.mp4' });
  const fc = a[a.indexOf('-filter_complex') + 1];
  assert.match(fc, /overlay=0:0/); assert.doesNotMatch(a.join(' '), /drawtext|subtitles|textfile/); assert.ok(a.includes('-an'));
  assert.deepEqual([a[a.indexOf('-c:v') + 1], a[a.indexOf('-pix_fmt') + 1], a[a.indexOf('-r') + 1]], ['libx264', 'yuv420p', '30']);
  assert.equal(a[a.length - 1], '/y/out.mp4'); assert.equal(a.filter((x) => x === '-i').length, 2);
});

test('composeClip: runs exactly one ffmpeg command, then both render checks; ok only when both pass', async () => {
  const dir = tmp(); const clip = path.join(dir, 'c.mp4'); const png = path.join(dir, 'o.png'); fs.writeFileSync(clip, 'x'); fs.writeFileSync(png, 'x');
  const calls = []; const run = async (cmd, args) => { calls.push([cmd, args]); };
  const out = path.join(dir, 'out', 'r.mp4');
  const r = await composeClip({ clipFile: clip, overlayPng: png, out, run, ...okChecks });
  assert.equal(r.ok, true); assert.equal(calls.length, 1); assert.equal(calls[0][0], 'ffmpeg'); assert.equal(r.out, out);
  const bad = await composeClip({ clipFile: clip, overlayPng: png, out, run, check: async () => ({ ok: false, problems: ['size 1x1'], durationSec: 7 }), qa: okChecks.qa });
  assert.equal(bad.ok, false); assert.deepEqual(bad.problems, ['rendered: size 1x1']);
  const bad2 = await composeClip({ clipFile: clip, overlayPng: png, out, run, check: okChecks.check, qa: () => ({ ok: false, problems: ['file size 3 bytes'] }) });
  assert.equal(bad2.ok, false); assert.deepEqual(bad2.problems, ['qa: file size 3 bytes']);
});
test('composeClip: both checks run even when the first fails (all problems are reported); a throwing ffmpeg or check is a refusal, not a crash', async () => {
  const dir = tmp(); const clip = path.join(dir, 'c.mp4'); const png = path.join(dir, 'o.png'); fs.writeFileSync(clip, 'x'); fs.writeFileSync(png, 'x'); const out = path.join(dir, 'r.mp4');
  const r = await composeClip({ clipFile: clip, overlayPng: png, out, run: async () => {}, check: async () => ({ ok: false, problems: ['a'] }), qa: () => ({ ok: false, problems: ['b'] }) });
  assert.deepEqual(r.problems, ['rendered: a', 'qa: b']);
  const t = await composeClip({ clipFile: clip, overlayPng: png, out, run: async () => { throw new Error('ffmpeg exploded'); }, ...okChecks }); assert.equal(t.ok, false); assert.match(t.problems[0], /ffmpeg failed: ffmpeg exploded/);
  const u = await composeClip({ clipFile: clip, overlayPng: png, out, run: async () => {}, check: okChecks.check, qa: () => { throw new Error('ffprobe missing'); } }); assert.equal(u.ok, false); assert.match(u.problems.join(), /qa failed: ffprobe missing/);
});
test('composeClip: refuses an output inside this repository, the same file as the input, and a missing input; ffmpeg is never run', async () => {
  const dir = tmp(); const clip = path.join(dir, 'c.mp4'); const png = path.join(dir, 'o.png'); fs.writeFileSync(clip, 'x'); fs.writeFileSync(png, 'x');
  let ran = 0; const run = async () => { ran++; };
  const inRepo = path.join(HERE, 'composed-test-output.mp4');
  for (const [args, re] of [[{ out: inRepo }, /outside every repository|inside the repository|git work tree/], [{ out: clip }, /same file/], [{ out: path.join(dir, 'a.mp4'), clipFile: path.join(dir, 'nope.mp4') }, /clip file not found/], [{ out: path.join(dir, 'a.mp4'), overlayPng: path.join(dir, 'nope.png') }, /overlay file not found/]]) {
    const r = await composeClip({ clipFile: clip, overlayPng: png, run, ...okChecks, ...args }); assert.equal(r.ok, false); assert.match(r.problems.join(), re);
  }
  assert.equal(ran, 0); assert.equal(fs.existsSync(inRepo), false);
});

test('renderOverlay: passes the hook through a spec file (never the command line) and reports a refusal with its reason', async () => {
  const dir = tmp(); const seen = []; const out = path.join(dir, 'o.png');
  const run = async (cmd, args) => { seen.push([cmd, args, JSON.parse(fs.readFileSync(args[1], 'utf8'))]); };
  const r = await renderOverlay({ hook: 'A "quoted" hook; $(rm -rf x)', out, run }); assert.equal(r.ok, true);
  assert.equal(seen[0][0], 'python3'); assert.equal(seen[0][1][0], OVERLAY_PY); assert.equal(seen[0][2].hook, 'A "quoted" hook; $(rm -rf x)'); assert.ok(!seen[0][1].join(' ').includes('quoted'));
  const e = Object.assign(new Error('Command failed'), { code: 3, stderr: 'overlay refused: the hook does not fit in 3 lines\n' });
  const f = await renderOverlay({ hook: 'x', out, run: async () => { throw e; } }); assert.deepEqual(f, { ok: false, reason: 'overlay refused: the hook does not fit in 3 lines' });
  assert.equal((await renderOverlay({ hook: '', out, run })).ok, false);
});

// ---- real smoke tests (skipped, and reported as skipped, when Pillow or ffmpeg is missing) ----
const pngSize = (f) => { const b = fs.readFileSync(f); assert.equal(b.subarray(1, 4).toString(), 'PNG'); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25] }; };
const alphaBox = (f) => JSON.parse(spawnSync('python3', ['-c', `import json,sys; from PIL import Image; print(json.dumps(Image.open(sys.argv[1]).getchannel("A").getbbox()))`, f], { encoding: 'utf8' }).stdout);
test('overlay.py (real): 1080x1920 RGBA, transparent outside a band that lies inside the upper third', { skip: hasPillow ? false : 'Pillow is not installed' }, () => {
  const dir = tmp(); const spec = path.join(dir, 's.json'); const out = path.join(dir, 'o.png'); fs.writeFileSync(spec, JSON.stringify({ hook: 'Wildebeest cross the river every year when the long rains' }));
  const r = spawnSync('python3', [OVERLAY_PY, spec, out], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(pngSize(out), { w: 1080, h: 1920, colorType: 6 });
  const [x0, y0, x1, y1] = alphaBox(out); assert.ok(y0 >= 200 && y1 <= 640, `band ${y0}..${y1}`); assert.equal(x0, 0); assert.equal(x1, 1080);
});
test('overlay.py (real): refuses with exit 3 and writes no file when the text cannot fit in 3 lines at the minimum size', { skip: hasPillow ? false : 'Pillow is not installed' }, () => {
  const dir = tmp(); const spec = path.join(dir, 's.json'); const out = path.join(dir, 'o.png');
  for (const hook of [Array(40).fill('wildebeest').join(' '), 'Supercalifragilisticexpialidocious'.repeat(3), '   ']) {
    fs.writeFileSync(spec, JSON.stringify({ hook })); const r = spawnSync('python3', [OVERLAY_PY, spec, out], { encoding: 'utf8' });
    assert.equal(r.status, 3, `${hook.slice(0, 20)}: ${r.stderr}`); assert.match(r.stderr, /overlay refused/); assert.equal(fs.existsSync(out), false);
  }
});
test('overlay.py + composeClip (real ffmpeg): a generated 6 s clip comes out 1080x1920, silent, and passes both render checks', { skip: hasPillow && hasFfmpeg ? false : 'Pillow or ffmpeg is missing' }, async () => {
  const dir = tmp(); const clip = path.join(dir, 'c.mp4'); const png = path.join(dir, 'o.png'); const out = path.join(dir, 'out.mp4');
  const g = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=6', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]); assert.equal(g.status, 0);
  assert.equal((await renderOverlay({ hook: 'Wildebeest cross the river', out: png })).ok, true);
  const r = await composeClip({ clipFile: clip, overlayPng: png, out }); assert.deepEqual(r.problems, []); assert.equal(r.ok, true); assert.ok(fs.statSync(out).size > 50_000);
});
