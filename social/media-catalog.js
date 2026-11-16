// Media catalogue: one record per finished video, with the rights record and the flags that decide
// whether a video may enter the automatic posting lane. Self-contained, Node built-ins only.
//
//   node media-catalog.js --scan [--root <path>] [--out <path>]
//   node media-catalog.js --summary [--root <path>] [--out <path>]
//
// The catalogue holds local paths and titles. It lives OUTSIDE the repository and must never be
// committed: the command refuses to write it to any path inside this repository or any git work tree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

/** folder name -> kind. Order is the scan order. */
export const FOLDERS = [['africa', 'full'], ['asia', 'full'], ['asia-shorts', 'short']];

/** The whole rights record that exists. No provider and no licence type are known; none is invented. */
export const RIGHTS_BASIS = 'owner statement of 2026-11-16: paid for, may be used';

/**
 * More than this many words of on-screen text counts as burned-in overlay text.
 * Chosen from the 35 real files (word counts, time stamps removed): 2 have none, the smallest
 * non-empty one has 9 (a caption), the rest have 13 to 647. Every file with any real caption or
 * any ticket overlay is above 8, so the line is set just under the smallest real caption: a stray
 * OCR word or two does not flag a clean video, a caption does. Being wrong in this direction only
 * keeps a video out of the automatic lane.
 */
export const OVERLAY_WORD_THRESHOLD = 8;

/** Ids where another publisher's mark was seen in the 16 Nov audit. */
export const PUBLISHER_MARK_SEED = new Set([
  'NPNODhL-ZFU', // seen in the 16 Nov audit
  '-0O22tResG0', // seen in the 16 Nov audit
]);

/** Places that are neither East Africa nor Asia. A guess at a useful starting list; extend as needed. */
const OUTSIDE_PLACES = /\b(namibia|zimbabwe|botswana|zambia|south africa|egypt|morocco|tunisia|ghana|nigeria|senegal|cappadocia|turkey|t[üu]rkiye|iceland|europe|america|australia)\b/i;

const VIDEO_NAME = /^(\d{4})(\d{2})(\d{2}) (.+) \[([A-Za-z0-9_-]{11})\]\.mp4$/i;

/** Name pattern: `YYYYMMDD <title> [<11-char id>].mp4`. Returns null when it does not match. */
export function parseMediaName(basename) {
  const m = VIDEO_NAME.exec(basename);
  if (!m) return null;
  const [, y, mo, d, title, id] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d));
  if (date.getUTCFullYear() !== +y || date.getUTCMonth() !== +mo - 1 || date.getUTCDate() !== +d) return null;
  return { uploadDate: `${y}-${mo}-${d}`, title, id };
}

/** Words in an on-screen text file, without the leading `[12s]` time stamps. */
export function countOnscreenWords(text) {
  let n = 0;
  for (const line of String(text).split('\n')) {
    for (const tok of line.replace(/^\s*\[\d+s\]\s*/, '').split(/\s+/)) {
      if (/[\p{L}\p{N}]/u.test(tok)) n += 1;
    }
  }
  return n;
}

function regionFor(folder, title) {
  if (OUTSIDE_PLACES.test(title)) return 'other';
  if (folder === 'africa') return 'east-africa';
  if (folder === 'asia' || folder === 'asia-shorts') return 'asia';
  return 'other';
}

/** Real probe: ffprobe through execFile (no shell). Returns { durationSec, width, height }. */
export async function ffprobe(file) {
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file,
  ], { timeout: 60_000, maxBuffer: 1 << 20 });
  const j = JSON.parse(stdout);
  const s = (j.streams && j.streams[0]) || {};
  const dur = parseFloat(j.format && j.format.duration);
  return {
    durationSec: Number.isFinite(dur) ? Math.round(dur * 100) / 100 : null,
    width: Number.isInteger(s.width) ? s.width : null,
    height: Number.isInteger(s.height) ? s.height : null,
  };
}

/**
 * Walk the three folders. Returns { records, problems }: a file whose name carries no id, a failing
 * probe and a duplicate id are reported in `problems` and never crash the scan.
 */
export async function scanMedia({ root, probe = ffprobe }) {
  const records = [];
  const problems = [];
  const seen = new Set();
  for (const [folder, kind] of FOLDERS) {
    let names;
    try { names = fs.readdirSync(path.join(root, folder)).sort(); } catch { continue; }
    for (const base of names) {
      if (!/\.mp4$/i.test(base)) continue;
      const file = path.join(folder, base);
      const parsed = parseMediaName(base);
      if (!parsed) { problems.push({ file, reason: 'no YouTube id or date in the file name' }); continue; }
      if (seen.has(parsed.id)) { problems.push({ file, reason: `duplicate id ${parsed.id}, first one kept` }); continue; }
      seen.add(parsed.id);
      let m = { durationSec: null, width: null, height: null };
      try {
        const p = await probe(path.join(root, file));
        m = { durationSec: p.durationSec ?? null, width: p.width ?? null, height: p.height ?? null };
      } catch (e) {
        problems.push({ file, reason: `probe failed: ${e.message}` });
      }
      let onscreenWords = null;
      try {
        onscreenWords = countOnscreenWords(fs.readFileSync(path.join(root, 'analysis', folder, `${parsed.id}.onscreen.txt`), 'utf8'));
      } catch { /* no analysis file: unknown */ }
      records.push({
        id: parsed.id,
        file,
        folder,
        title: parsed.title,
        uploadDate: parsed.uploadDate,
        kind,
        ...m,
        onscreenWords,
        rights: { basis: RIGHTS_BASIS, document: null },
        flags: {
          otherPublisherMark: PUBLISHER_MARK_SEED.has(parsed.id) ? true : null,
          overlayText: onscreenWords === null ? null : onscreenWords > OVERLAY_WORD_THRESHOLD,
          personRecognisable: null, // a later branch checks frames with a local vision model
          region: regionFor(folder, parsed.title),
        },
      });
    }
  }
  return { records, problems };
}

/** Verdict with reasons. Only exactly `false` counts as clear; null (unknown) never does. */
export function autoEligible(record, config = {}) {
  const reasons = [];
  const regions = config.autoRegions || ['east-africa'];
  const flags = record && record.flags;
  if (!flags) return { eligible: false, reasons: ['no flags'] };
  for (const f of ['otherPublisherMark', 'overlayText', 'personRecognisable']) {
    if (flags[f] === true) reasons.push(`${f} is true`);
    else if (flags[f] !== false) reasons.push(`${f} is unknown`);
  }
  if (!regions.includes(flags.region)) reasons.push(`region ${flags.region ?? 'unknown'} is not an automatic region`);
  if (!(typeof record.durationSec === 'number' && record.durationSec > 0)) reasons.push('duration unknown');
  const exists = config.fileExists
    || (config.root ? (f) => fs.existsSync(path.join(config.root, f)) : null);
  if (!exists) reasons.push('file existence cannot be verified');
  else if (!record.file || !exists(record.file)) reasons.push('file is missing');
  return { eligible: reasons.length === 0, reasons };
}

const MEASURED = ['file', 'folder', 'title', 'uploadDate', 'kind', 'durationSec', 'width', 'height', 'onscreenWords'];
const asEntries = (x) => (Array.isArray(x) ? x : (x && x.entries) || []);

/**
 * Re-scan merge. A flag that is already set (not null) is never overwritten; null flags are filled
 * from the scan. Only measured fields are refreshed. Entries whose file vanished are kept, marked
 * `missing`, and reported.
 */
export function mergeCatalog(existing, scanned) {
  const old = new Map(asEntries(existing).map((e) => [e.id, e]));
  const entries = [];
  const added = [];
  const conflicts = [];
  const seen = new Set();
  for (const s of scanned) {
    seen.add(s.id);
    const e = old.get(s.id);
    if (!e) { entries.push(s); added.push(s.id); continue; }
    const merged = { ...e };
    for (const k of MEASURED) merged[k] = s[k];
    delete merged.missing;
    merged.rights = e.rights || s.rights;
    merged.flags = { ...s.flags };
    for (const [k, v] of Object.entries(e.flags || {})) {
      if (v === null || v === undefined) continue;
      if (s.flags && s.flags[k] != null && s.flags[k] !== v) conflicts.push({ id: s.id, flag: k, kept: v, scanned: s.flags[k] });
      merged.flags[k] = v;
    }
    entries.push(merged);
  }
  const vanished = [];
  for (const [id, e] of old) {
    if (seen.has(id)) continue;
    vanished.push(id);
    entries.push({ ...e, missing: true });
  }
  return { entries, added, vanished, conflicts };
}

/** Temp file in the same directory, fsync, rename. Mode 0600. A failure leaves the old file intact. */
export function writeFileAtomic(target, data, fsImpl = fs) {
  const tmpPath = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const buf = Buffer.from(data);
  const fd = fsImpl.openSync(tmpPath, 'wx', 0o600);
  try {
    let off = 0;
    while (off < buf.length) off += fsImpl.writeSync(fd, buf, off, buf.length - off);
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
  } catch (e) {
    try { fsImpl.closeSync(fd); } catch { /* already closed */ }
    try { fsImpl.unlinkSync(tmpPath); } catch { /* nothing to clean */ }
    throw e;
  }
  try {
    fsImpl.renameSync(tmpPath, target);
  } catch (e) {
    try { fsImpl.unlinkSync(tmpPath); } catch { /* nothing to clean */ }
    throw e;
  }
}

function realish(p) {
  let head = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(head)) { tail.unshift(path.basename(head)); const up = path.dirname(head); if (up === head) break; head = up; }
  return { real: path.join(fs.realpathSync(head), ...tail), existing: fs.realpathSync(head) };
}

function defaultGitTopLevel(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim() || null;
  } catch { return null; }
}

/** Throws when `outPath` is inside this repository (also through .. and symlinks) or any git work tree. */
export function assertOutsideRepo(outPath, { repoRoot = REPO_ROOT, gitTopLevel = defaultGitTopLevel } = {}) {
  const { real, existing } = realish(outPath);
  const repo = fs.realpathSync(repoRoot);
  const rel = path.relative(repo, real);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error(`refusing to write the catalogue inside the repository (${repo}); it holds local paths and titles`);
  }
  const top = gitTopLevel(existing);
  if (top) throw new Error(`refusing to write the catalogue inside a git work tree (${top})`);
}

const home = (env) => env.HOME || os.homedir();
const defaultRoot = (env) => env.BPA_MEDIA_ROOT || path.join(home(env), 'Movies', 'Beyond Paradise', 'youtube-archive');
const defaultOut = (env) => env.BPA_MEDIA_CATALOG || path.join(home(env), '.matlai', 'bpa-media-catalog.json');

function parseArgs(argv) {
  const a = { scan: false, summary: false, root: null, out: null, bad: null };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--scan') a.scan = true;
    else if (t === '--summary') a.summary = true;
    else if (t === '--root' || t === '--out') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) { a.bad = `${t} needs a value`; break; }
      a[t.slice(2)] = argv[i + 1]; i += 1;
    } else { a.bad = `unknown argument ${t}`; break; }
  }
  return a;
}

function summarise(catalog, root) {
  const entries = asEntries(catalog);
  const count = (fn) => entries.reduce((m, e) => { const k = fn(e); m[k] = (m[k] || 0) + 1; return m; }, {});
  const lines = [`videos: ${entries.length}`];
  const block = (title, obj) => { lines.push(`${title}:`); for (const [k, v] of Object.entries(obj).sort()) lines.push(`  ${k}: ${v}`); };
  block('per folder', count((e) => e.folder));
  block('per region', count((e) => (e.flags && e.flags.region) ?? 'unknown'));
  for (const f of ['otherPublisherMark', 'overlayText', 'personRecognisable']) {
    block(`flag ${f}`, count((e) => String(e.flags ? e.flags[f] : null)));
  }
  const reasons = {}; const eligible = [];
  for (const e of entries) {
    const v = autoEligible(e, { root });
    if (v.eligible) eligible.push(e.id);
    for (const r of v.reasons) reasons[r] = (reasons[r] || 0) + 1;
  }
  lines.push(`eligible for the automatic lane: ${eligible.length}${eligible.length ? ` (${eligible.join(', ')})` : ''}`);
  block('reasons not eligible (a video can have several)', reasons);
  return lines.join('\n');
}

/** Command entry. Returns the exit code. `deps` are injectable for tests. */
export async function main(argv, env = process.env, deps = {}) {
  const log = deps.log || ((s) => console.log(s));
  const error = deps.error || ((s) => console.error(s));
  const args = parseArgs(argv);
  if (args.bad || (!args.scan && !args.summary)) {
    error(`${args.bad ? `${args.bad}\n` : ''}usage: media-catalog.js --scan [--root <path>] [--out <path>] | --summary [--root <path>] [--out <path>]`);
    return 2;
  }
  const root = args.root || defaultRoot(env);
  const out = path.resolve(args.out || defaultOut(env));
  try {
    assertOutsideRepo(out, { repoRoot: deps.repoRoot, gitTopLevel: deps.gitTopLevel });
  } catch (e) {
    error(e.message);
    return 3;
  }
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') { error(`cannot read the existing catalogue: ${e.message}`); return 4; }
  }
  if (args.scan) {
    const { records, problems } = await scanMedia({ root, probe: deps.probe || ffprobe });
    const merged = mergeCatalog(existing, records);
    const catalog = { version: 1, updatedAt: new Date().toISOString(), entries: merged.entries };
    fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
    writeFileAtomic(out, `${JSON.stringify(catalog, null, 2)}\n`);
    existing = catalog;
    log(`scanned ${records.length} videos; added ${merged.added.length}, vanished ${merged.vanished.length}, `
      + `flag conflicts kept ${merged.conflicts.length}, problems ${problems.length}`);
    for (const p of problems) log(`problem: ${p.reason}`);
  }
  if (args.summary) {
    if (!existing) { error('no catalogue yet: run --scan first'); return 4; }
    log(summarise(existing, root));
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
}
