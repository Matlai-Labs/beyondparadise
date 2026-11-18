// A conservative H.264 copy of every clip for the page's player. The originals are never changed.
// Why: the page plays the library files as they are (1080x1920 H.264 High, level 4.0 with a decoded-picture buffer of exactly 4 of 4 frames).
// A stock Chrome or Edge on Windows decodes with the graphics chip, which is stricter than the Mac's decoder, and a clip in any other
// codec or 10-bit (HEVC, HDR) shows only a still picture there. The copy is 720 wide, 8-bit yuv420p, High profile, level 4.0 (so the buffer has
// room: 9 frames), AAC if there is sound, moov box first. Made with the local ffmpeg: $0, no network, no paid service.
// A copy that cannot be made is never an error for the page: the caller falls back to the original file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

export const PREVIEW_VERSION = 'h264-720-v1'; // bump when the ffmpeg arguments change: the old copies are then never used
const KEY_RE = /^[0-9a-f]{32}\.mp4$/;
const BUILD_TIMEOUT_MS = 90_000;

/** 32 hex chars from the version, the path and the file identity (size, mtime, inode): a changed file gets a new copy. */
export function previewKey(entry) {
  return crypto.createHash('sha256').update([PREVIEW_VERSION, entry.path, entry.size, entry.mtimeMs, entry.ino].join('|')).digest('hex').slice(0, 32);
}

/** The ffmpeg arguments. The source is only read; the output is the LAST argument (a temporary name, renamed by the caller when complete). */
export function ffmpegArgs(src, out) {
  return [
    '-nostdin', '-v', 'error', '-y', '-i', src,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', "scale='if(gt(iw,720),720,iw)':-2:flags=lanczos,format=yuv420p",
    '-c:v', 'libx264', '-profile:v', 'high', '-level:v', '4.0', '-preset', 'veryfast', '-crf', '23', '-maxrate', '3M', '-bufsize', '6M',
    '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-threads', '2',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
    '-movflags', '+faststart', '-f', 'mp4', out,
  ];
}

const KNOWN = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
/** launchd has a short PATH, so look at the usual places first. */
export function findFfmpeg(env = process.env, exists = (p) => fs.existsSync(p)) {
  if (typeof env.BPA_FFMPEG === 'string' && env.BPA_FFMPEG !== '') return env.BPA_FFMPEG;
  for (const p of KNOWN) if (exists(p)) return p;
  return 'ffmpeg';
}

const defaultRun = (bin, args) => new Promise((resolve, reject) => {
  execFile(bin, args, { timeout: BUILD_TIMEOUT_MS, maxBuffer: 1 << 20, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
});

/** { get(entry) -> Promise<path|null>, warm(entries) -> Promise<void> }. entry = { path, size, mtimeMs, ino } of an original file. */
export function createPreviewMaker({ cacheDir, run = defaultRun, ffmpeg = findFfmpeg(), log = () => {} } = {}) {
  const inflight = new Map(); // key -> Promise<path|null>
  const failed = new Set(); // keys that failed in this process: not retried until a restart (a new file has a new key)
  const fileOf = (key) => path.join(cacheDir, `${key}.mp4`);
  const usable = (f) => { try { const st = fs.statSync(f); return st.isFile() && st.size > 0; } catch { return false; } };

  async function build(entry, key) {
    const out = fileOf(key); const tmp = path.join(cacheDir, `.${key}.${process.pid}.tmp`);
    try {
      fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      await run(ffmpeg, ffmpegArgs(entry.path, tmp));
      if (!usable(tmp)) throw new Error('empty output');
      fs.renameSync(tmp, out); return out;
    } catch (e) {
      failed.add(key); log(`review preview not made: ${e && e.code ? e.code : 'error'} (the original file is served)`);
      try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ }
      return null;
    }
  }

  function get(entry) {
    if (!entry || typeof entry.path !== 'string') return Promise.resolve(null);
    const key = previewKey(entry);
    if (usable(fileOf(key))) return Promise.resolve(fileOf(key));
    if (failed.has(key)) return Promise.resolve(null);
    let p = inflight.get(key);
    if (!p) { p = build(entry, key).finally(() => inflight.delete(key)); inflight.set(key, p); }
    return p;
  }

  let warming = null;
  /** In the background, one clip at a time: make what is missing, then remove copies no clip needs any more. Never throws. */
  function warm(entries) {
    if (warming) return warming;
    const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e.path === 'string') : [];
    warming = (async () => {
      for (const e of list) { try { await get(e); } catch { /* get never throws; belt and braces */ } }
      try {
        const keep = new Set(list.map((e) => `${previewKey(e)}.mp4`));
        for (const name of fs.readdirSync(cacheDir)) if (KEY_RE.test(name) && !keep.has(name)) fs.rmSync(path.join(cacheDir, name), { force: true });
      } catch { /* no folder yet */ }
    })().finally(() => { warming = null; });
    return warming;
  }

  return { get, warm };
}
