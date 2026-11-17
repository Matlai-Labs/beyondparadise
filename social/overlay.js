// The hook on a clip, without any text filter (the ffmpeg here has none): overlay.py draws a transparent 1080x1920 PNG, ONE ffmpeg `overlay`
// command lays it over a library clip, and the result goes through both render checks. Local only: no network, nothing hosted or posted.
//   renderOverlay({ hook, out, run })                         -> { ok: true } | { ok: false, reason }
//   composeClip({ clipFile, overlayPng, out, run, check, qa }) -> { ok, problems, out, rendered, qa }
// The output must lie outside every repository (assertOutsideRepo) and must not be the input file. The audio stays absent (-an).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertOutsideRepo } from './media-catalog.js';
import { checkRendered, OUT_FPS, LIBRARY_CLIP_FLOOR_SEC } from './reel-clip.js';
import { checkReel, LIMITS } from './reel-qa.js';

const execFileP = promisify(execFile);
export const OVERLAY_PY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'overlay.py');
const defaultRun = (cmd, args) => execFileP(cmd, args, { timeout: 300_000, maxBuffer: 64 << 20 });
const firstLine = (e) => String((e && (e.stderr || e.message)) || e).trim().split('\n').filter(Boolean).pop() || 'failed';

/** The hook goes to overlay.py through a temporary spec file, never through the command line. */
export async function renderOverlay({ hook, out, run = defaultRun, python = 'python3' } = {}) {
  if (typeof hook !== 'string' || !hook.trim()) return { ok: false, reason: 'overlay refused: empty hook' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-overlay-')); const spec = path.join(dir, 'spec.json');
  try {
    fs.writeFileSync(spec, JSON.stringify({ hook }), { mode: 0o600 });
    try { await run(python, [OVERLAY_PY, spec, out]); } catch (e) { return { ok: false, reason: firstLine(e) }; }
    return { ok: true };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** One command: the clip, the overlay on top, 30 fps h264, no audio. */
export function buildComposeArgs({ clipFile, overlayPng, out }) {
  return ['-nostdin', '-hide_banner', '-y', '-i', clipFile, '-i', overlayPng,
    '-filter_complex', '[0:v][1:v]overlay=0:0:format=auto,format=yuv420p[v]', '-map', '[v]', '-an',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(OUT_FPS), '-movflags', '+faststart', out];
}

/** The reel QA with the library clip's own lower length limit (a single shot of 3 s is a valid reel here; the card reels keep LIMITS as they are). */
export const checkLibraryClip = (file) => checkReel(file, { ...LIMITS, minSec: LIBRARY_CLIP_FLOOR_SEC });
export const checkLibraryRendered = (file, opts = {}) => checkRendered(file, { ...opts, minSec: LIBRARY_CLIP_FLOOR_SEC });

export async function composeClip({ clipFile, overlayPng, out, run = defaultRun, ffmpeg = 'ffmpeg', check = checkLibraryRendered, qa = checkLibraryClip, repoRoot, gitTopLevel } = {}) {
  const refuse = (msg) => ({ ok: false, problems: [msg], out: null, rendered: null, qa: null });
  if (!clipFile || !fs.existsSync(clipFile)) return refuse(`clip file not found: ${path.basename(String(clipFile || ''))}`);
  if (!overlayPng || !fs.existsSync(overlayPng)) return refuse(`overlay file not found: ${path.basename(String(overlayPng || ''))}`);
  if (!out) return refuse('no output path');
  out = path.resolve(out);
  if (out === path.resolve(clipFile)) return refuse('the output is the same file as the input');
  try { assertOutsideRepo(out, { repoRoot, gitTopLevel }); } catch (e) { return refuse(`the output must be outside every repository: ${e.message}`); }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  try { await run(ffmpeg, buildComposeArgs({ clipFile, overlayPng, out })); } catch (e) { return refuse(`ffmpeg failed: ${firstLine(e)}`); }
  const problems = []; let rendered = null; let qaRes = null;
  try { rendered = await check(out); if (!rendered.ok) problems.push(...rendered.problems.map((p) => `rendered: ${p}`)); } catch (e) { problems.push(`rendered check failed: ${firstLine(e)}`); }
  try { qaRes = qa(out); if (!qaRes.ok) problems.push(...qaRes.problems.map((p) => `qa: ${p}`)); } catch (e) { problems.push(`qa failed: ${firstLine(e)}`); }
  return { ok: problems.length === 0, problems, out, rendered, qa: qaRes };
}
