// Post-render QA for Instagram Reels: a reel that is the wrong shape, too short, empty or mostly
// black must never reach WordPress hosting or Instagram. renderReel() only checked "a file exists".
// Same idea as matlai_wix tools/video-studio/verify-outputs.mjs (the hotel studio's gate), sized
// for silent 9:16 HyperFrames cards. Local ffprobe/ffmpeg only, $0.
import { execFileSync, spawnSync } from 'node:child_process';

export const LIMITS = { width: 1080, height: 1920, codec: 'h264', minSec: 3, maxSec: 90, minBytes: 50_000, maxBytes: 100_000_000, maxBlackShare: 0.4 };

/** Total seconds of black from ffmpeg blackdetect stderr. */
export function blackSeconds(log) {
  return [...String(log).matchAll(/black_duration:([\d.]+)/g)].reduce((s, m) => s + Number(m[1]), 0);
}

/** Pure verdict from ffprobe JSON + measured black seconds. */
export function evaluateReel(probe, black = 0, L = LIMITS) {
  const problems = [];
  const v = (probe.streams || []).find((s) => s.codec_type === 'video');
  const dur = Number(probe.format?.duration ?? v?.duration ?? 0), size = Number(probe.format?.size ?? 0);
  if (!v) problems.push('no video stream');
  else {
    if (v.width !== L.width || v.height !== L.height) problems.push(`size ${v.width}x${v.height}, want ${L.width}x${L.height}`);
    if (v.codec_name !== L.codec) problems.push(`codec ${v.codec_name}, want ${L.codec}`);
  }
  if (!(dur >= L.minSec && dur <= L.maxSec)) problems.push(`duration ${dur.toFixed(1)} s, want ${L.minSec}-${L.maxSec} s`);
  if (!(size >= L.minBytes && size <= L.maxBytes)) problems.push(`file size ${size} bytes, want ${L.minBytes}-${L.maxBytes}`);
  if (dur > 0 && black / dur > L.maxBlackShare) problems.push(`${black.toFixed(1)} s of ${dur.toFixed(1)} s is black`);
  return { ok: problems.length === 0, problems, duration: dur, black };
}

/** Probe a rendered file and judge it. Never throws for a bad video; throws only if ffprobe is missing. */
export function checkReel(file, L = LIMITS) {
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,duration:format=duration,size', '-of', 'json', file], { encoding: 'utf8' }));
  const bd = spawnSync('ffmpeg', ['-nostdin', '-i', file, '-vf', 'blackdetect=d=0.5:pix_th=0.10', '-an', '-f', 'null', '-'], { encoding: 'utf8' });
  return evaluateReel(probe, blackSeconds(bd.stderr || ''), L);
}
