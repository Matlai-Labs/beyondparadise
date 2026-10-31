import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateReel, blackSeconds, checkReel } from './reel-qa.js';

const good = { streams: [{ codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, duration: '8.000000' }], format: { duration: '8.000000', size: '900000' } };

test('a normal 8 s 1080x1920 h264 reel passes', () => {
  const r = evaluateReel(good, 1.67);
  assert.equal(r.ok, true, r.problems.join('; '));
});

test('wrong size, codec, duration and file size are each reported', () => {
  const bad = { streams: [{ codec_type: 'video', codec_name: 'vp9', width: 720, height: 1280, duration: '1.5' }], format: { duration: '1.5', size: '2000' } };
  const r = evaluateReel(bad, 0);
  assert.equal(r.ok, false);
  for (const k of ['1080x1920', 'h264', 'duration', 'file size']) assert.ok(r.problems.some((p) => p.includes(k)), `missing ${k}: ${r.problems}`);
});

test('no video stream fails', () => {
  assert.equal(evaluateReel({ streams: [{ codec_type: 'audio' }], format: { duration: '8', size: '900000' } }, 0).ok, false);
});

test('mostly black reel fails (>40% black)', () => {
  const r = evaluateReel(good, 4);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('black')));
});

test('blackSeconds sums blackdetect segments', () => {
  const log = 'x black_start:0 black_end:1.5 black_duration:1.5\ny black_start:5 black_end:6.25 black_duration:1.25\n';
  assert.equal(blackSeconds(log), 2.75);
  assert.equal(blackSeconds('nothing'), 0);
});

test('checkReel on a real all-black render fails, on a real lit clip passes', { skip: !hasFfmpeg() }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reelqa-'));
  const black = path.join(dir, 'black.mp4');
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=1080x1920:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', black]);
  const r = checkReel(black);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('black')), r.problems.join('; '));
  const lit = path.join(dir, 'lit.mp4');
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:d=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', lit]);
  const ok = checkReel(lit);
  assert.equal(ok.ok, true, ok.problems.join('; '));
  fs.rmSync(dir, { recursive: true, force: true });
});

function hasFfmpeg() { try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } }

test('renderReel runs the QA gate before returning the file (wiring)', () => {
  const src = fs.readFileSync(new URL('./video.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function renderReel'));
  const qa = body.indexOf('checkReel(out)'), ret = body.indexOf('return out');
  assert.ok(qa > 0 && qa < ret, 'checkReel(out) must run before `return out` in renderReel');
  assert.match(body.slice(qa, ret), /throw new Error\(`reel QA failed/);
});
