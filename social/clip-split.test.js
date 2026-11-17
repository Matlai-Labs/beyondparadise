import './test-env.js';
// C5: a library clip must be ONE shot. clip-library.js --split cuts a clip into single-shot children; the parent is superseded; each child is
// judged on its own. Fake ffmpeg for the logic, two tests run the real local ffmpeg on a generated clip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MIN_SHOT_SEC, LIBRARY_CLIP_MIN_SEC, checkRendered, parseCuts, planPieces, narrowSource, eligibleClips, readManifest, setVerdict, summarise, main } from './clip-library.js';
import { composeClip } from './overlay.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-split-')));
const noGit = () => null;
const GOOD = { verdict: 'pass', by: 'me', at: '2026-11-17T00:00:00Z', notes: '', singleSubject: 'yes' };
const parentOf = (over = {}) => ({
  id: 'clip-AAAAAAAAAAA-100', file: 'clip-AAAAAAAAAAA-100.mp4', durationSec: 7, source: [{ videoId: 'AAAAAAAAAAA', startSec: 100, endSec: 107 }], subject: 's', renderedAt: 'x',
  checks: { rendered: 'ok' }, flash: { flash: false, atSec: [] }, verified: { ...GOOD }, shows: { tags: ['lion'], by: 'me', at: 'x', notes: '' }, ...over,
});
function lib(clips = [parentOf()]) {
  const dir = tmp(); fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({ version: 1, updatedAt: 'x', clips }, null, 2)}\n`, { mode: 0o600 });
  for (const c of clips) fs.writeFileSync(path.join(dir, c.file), 'parent-bytes');
  return dir;
}
const listing = (dir) => fs.readdirSync(dir).sort();
// fake ffmpeg: the cut writes its output (last argument) and remembers -t; the flash pass answers with calm luma; the probe reports the remembered length
function fakes({ failOn = null } = {}) {
  const lens = new Map(); const cuts = [];
  const run = async (cmd, args) => {
    if (args.join(' ').includes('signalstats')) return { stdout: 'pts_time:0\nlavfi.signalstats.YAVG=100\npts_time:0.1\nlavfi.signalstats.YAVG=110\n', stderr: '' };
    const out = args[args.length - 1]; cuts.push({ args, out });
    if (failOn !== null && cuts.length === failOn) throw new Error('ffmpeg exploded');
    lens.set(out, Number(args[args.indexOf('-t') + 1])); fs.writeFileSync(out, 'child-bytes'); return { stdout: '', stderr: '' };
  };
  const probe = async (f) => ({ streams: [{ codec_type: 'video', width: 1080, height: 1920, r_frame_rate: '30/1' }], format: { duration: String(lens.get(f)) } });
  return { run, probe, cuts };
}
const cli = (argv, dir, deps = {}) => { const out = []; const err = []; return main(argv, { HOME: dir, BPA_CLIP_LIBRARY: dir, BPA_STATE_DIR: path.join(dir, 'state') }, { log: (s) => out.push(s), error: (s) => err.push(s), gitTopLevel: noGit, repoRoot: tmp(), ...deps }).then((code) => ({ code, out, err })); };

// ---------------------------------------------------------------- parsing and planning
test('MIN_SHOT_SEC is exported and is 3 s', () => assert.equal(MIN_SHOT_SEC, 3));
test('parseCuts: a point drops 0.2 s each side, a range is dropped as given', () => {
  assert.deepEqual(parseCuts('2.9', 7).drops, [[2.7, 3.1]]);
  assert.deepEqual(parseCuts('3.25-4.25', 7).drops, [[3.25, 4.25]]);
  assert.deepEqual(parseCuts('1.5, 4.0-4.5', 8).drops, [[1.3, 1.7], [4, 4.5]]);
});
test('parseCuts: unordered, overlapping, out of range and malformed boundaries are refused', () => {
  for (const [t, d] of [['4,2', 8], ['3,3.2', 8], ['2-4,3-5', 8], ['0', 7], ['7', 7], ['9', 7], ['2-8', 7], ['4-3', 7], ['4-4', 7], ['abc', 7], ['', 7], ['2,,3', 8], ['-2', 7], ['1e1', 20]]) {
    assert.throws(() => parseCuts(t, d), (e) => e.code === 'refused', `${t}`);
  }
});
test('planPieces: pieces of at least MIN_SHOT_SEC are kept, shorter ones are reported as dropped', () => {
  const r = planPieces(7, [[1.5, 2.5]]);
  assert.deepEqual(r.keep, [{ startSec: 2.5, endSec: 7 }]); assert.deepEqual(r.short, [{ startSec: 0, endSec: 1.5 }]);
  const exact = planPieces(6.2, [[3, 3.2]]); // [0,3] is exactly 3 s and long enough, [3.2,6.2] too
  assert.equal(exact.keep.length, 2); assert.equal(exact.short.length, 0);
});
test('narrowSource: one range, and a clip made of two ranges (a piece may straddle both)', () => {
  assert.deepEqual(narrowSource([{ videoId: 'A', startSec: 100, endSec: 107 }], 3.7, 7), [{ videoId: 'A', startSec: 103.7, endSec: 107 }]);
  const two = [{ videoId: 'A', startSec: 10, endSec: 14 }, { videoId: 'B', startSec: 50, endSec: 54 }];
  assert.deepEqual(narrowSource(two, 0, 3.9), [{ videoId: 'A', startSec: 10, endSec: 13.9 }]);
  assert.deepEqual(narrowSource(two, 4.1, 8), [{ videoId: 'B', startSec: 50.1, endSec: 54 }]);
  assert.deepEqual(narrowSource(two, 3.2, 8), [{ videoId: 'A', startSec: 13.2, endSec: 14 }, { videoId: 'B', startSec: 50, endSec: 54 }]);
});

// ---------------------------------------------------------------- --split
test('--split: children cut from the parent file, narrowed source, no verdict, parent superseded, manifest 0600', async () => {
  const dir = lib(); const f = fakes();
  const r = await cli(['--split', 'clip-AAAAAAAAAAA-100', '3.5', '--by', 'dense look', '--notes', 'lion then elephants'], dir, f);
  assert.equal(r.code, 0, r.err.join('\n'));
  const m = readManifest(dir); assert.equal(m.clips.length, 3);
  const [p, c1, c2] = m.clips;
  assert.deepEqual(p.supersededBy, ['clip-AAAAAAAAAAA-100-s1', 'clip-AAAAAAAAAAA-100-s2']); assert.equal(p.split.by, 'dense look'); assert.ok(!Number.isNaN(Date.parse(p.split.at))); assert.equal(p.split.notes, 'lion then elephants');
  assert.equal(c1.id, 'clip-AAAAAAAAAAA-100-s1'); assert.equal(c1.parent, p.id); assert.equal(c1.file, 'clip-AAAAAAAAAAA-100-s1.mp4'); assert.equal(c1.durationSec, 3.3);
  assert.deepEqual(c1.source, [{ videoId: 'AAAAAAAAAAA', startSec: 100, endSec: 103.3 }]); assert.deepEqual(c2.source, [{ videoId: 'AAAAAAAAAAA', startSec: 103.7, endSec: 107 }]);
  for (const c of [c1, c2]) { assert.equal(c.checks.rendered, 'ok'); assert.deepEqual(c.flash, { flash: false, atSec: [] }); assert.ok(!c.verified); assert.equal(c.shows, undefined); assert.ok(fs.existsSync(path.join(dir, c.file))); }
  assert.equal(f.cuts.length, 2);
  for (const { args } of f.cuts) { assert.ok(args.includes('-an')); assert.equal(args[args.indexOf('-i') + 1], path.join(dir, p.file)); assert.ok(args.includes('libx264')); assert.ok(args.indexOf('-i') < args.indexOf('-ss'), 'output side seek = frame accurate'); }
  assert.equal(fs.statSync(path.join(dir, 'manifest.json')).mode & 0o777, 0o600);
  assert.deepEqual(listing(dir), ['clip-AAAAAAAAAAA-100-s1.mp4', 'clip-AAAAAAAAAAA-100-s2.mp4', 'clip-AAAAAAAAAAA-100.mp4', 'manifest.json'], 'no temporary file left');
  assert.match(r.out.join('\n'), /clip-AAAAAAAAAAA-100-s1.*3\.3/);
});
test('--split: pieces shorter than MIN_SHOT_SEC are dropped and reported; a parent of two source ranges is narrowed per child', async () => {
  const two = parentOf({ id: 'clip-B-1', file: 'clip-B-1.mp4', durationSec: 8, source: [{ videoId: 'V1', startSec: 10, endSec: 14 }, { videoId: 'V2', startSec: 50, endSec: 54 }] });
  const dir = lib([two]); const r = await cli(['--split', 'clip-B-1', '3.0', '--by', 'x'], dir, fakes());
  assert.equal(r.code, 0, r.err.join('\n')); const m = readManifest(dir);
  assert.deepEqual(m.clips.map((c) => c.id), ['clip-B-1', 'clip-B-1-s1']); // [0,2.8] is too short and has no id
  assert.deepEqual(m.clips[1].source, [{ videoId: 'V1', startSec: 13.2, endSec: 14 }, { videoId: 'V2', startSec: 50, endSec: 54 }]); assert.equal(m.clips[1].durationSec, 4.8);
  assert.match(r.out.join('\n'), /dropped.*0.*2\.8/);
});
test('--split refusals exit 2, write nothing and leave no file', async () => {
  const child = parentOf({ id: 'clip-AAAAAAAAAAA-100-s1', file: 'clip-AAAAAAAAAAA-100-s1.mp4', parent: 'clip-AAAAAAAAAAA-100' });
  const gone = parentOf({ id: 'clip-G-1', file: 'clip-G-1.mp4', supersededBy: ['clip-G-1-s1'] });
  const cases = {
    'unknown id': ['--split', 'clip-nope', '3.5', '--by', 'x'], 'already superseded': ['--split', 'clip-G-1', '3.5', '--by', 'x'], 'a child': ['--split', 'clip-AAAAAAAAAAA-100-s1', '3.5', '--by', 'x'],
    'out of range': ['--split', 'clip-AAAAAAAAAAA-100', '8', '--by', 'x'], 'unordered': ['--split', 'clip-AAAAAAAAAAA-100', '4,2', '--by', 'x'], 'overlapping': ['--split', 'clip-AAAAAAAAAAA-100', '3,3.2', '--by', 'x'],
    'no piece long enough': ['--split', 'clip-AAAAAAAAAAA-100', '2,5', '--by', 'x'], 'missing --by': ['--split', 'clip-AAAAAAAAAAA-100', '3.5'], 'empty --by': ['--split', 'clip-AAAAAAAAAAA-100', '3.5', '--by', ' '],
    'missing cuts': ['--split', 'clip-AAAAAAAAAAA-100'], 'notes describe a person': ['--split', 'clip-AAAAAAAAAAA-100', '3.5', '--by', 'x', '--notes', 'a man in a hat'],
  };
  for (const [name, argv] of Object.entries(cases)) {
    const dir = lib(name === 'a child' ? [parentOf(), child] : name === 'already superseded' ? [parentOf(), gone] : [parentOf()]); const before = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'); const files = listing(dir); const f = fakes();
    const r = await cli(argv, dir, f);
    assert.equal(r.code, 2, `${name}: ${r.err.join('|')}`); assert.equal(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), before, `${name}: manifest changed`);
    assert.deepEqual(listing(dir), files, `${name}: files changed`); assert.equal(f.cuts.length, 0, `${name}: ffmpeg ran`);
  }
});
test('--split: an ffmpeg failure on the second child leaves no file and no manifest change', async () => {
  const dir = lib(); const before = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'); const files = listing(dir);
  const r = await cli(['--split', 'clip-AAAAAAAAAAA-100', '3.5', '--by', 'x'], dir, fakes({ failOn: 2 }));
  assert.equal(r.code, 5); assert.equal(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), before); assert.deepEqual(listing(dir), files);
});
test('--split: a child that fails the render check is refused as a whole, nothing is written', async () => {
  const dir = lib(); const before = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'); const files = listing(dir);
  const f = fakes(); const probe = async (file) => { const p = await f.probe(file); return { ...p, streams: [{ ...p.streams[0], width: 100 }] }; };
  const r = await cli(['--split', 'clip-AAAAAAAAAAA-100', '3.5', '--by', 'x'], dir, { run: f.run, probe });
  assert.equal(r.code, 5); assert.match(r.err.join('\n'), /size 100x1920/); assert.equal(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), before); assert.deepEqual(listing(dir), files);
});
test('--split really runs the local ffmpeg: children have the planned durations within 0.1 s', async (t) => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0 || spawnSync('ffprobe', ['-version']).status !== 0) return t.skip('no local ffmpeg');
  const dir = lib([parentOf({ id: 'clip-R-1', file: 'clip-R-1.mp4', durationSec: 8, source: [{ videoId: 'RRRRRRRRRRR', startSec: 20, endSec: 28 }] })]);
  const g = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=8', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', path.join(dir, 'clip-R-1.mp4')]); assert.equal(g.status, 0);
  const r = await cli(['--split', 'clip-R-1', '3.4-3.6', '--by', 'x'], dir);
  assert.equal(r.code, 0, r.err.join('\n')); const m = readManifest(dir);
  assert.equal(m.clips.length, 3);
  const want = [3.4, 4.4];
  for (const [i, c] of m.clips.slice(1).entries()) {
    const p = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', path.join(dir, c.file)], { encoding: 'utf8' }).stdout);
    assert.ok(Math.abs(Number(p.format.duration) - want[i]) <= 0.1, `${c.id} ${p.format.duration}`); assert.ok(Math.abs(c.durationSec - want[i]) <= 0.1);
    assert.deepEqual(p.streams.map((s) => s.codec_type), ['video']); assert.equal(c.checks.rendered, 'ok'); assert.equal(c.flash.flash, false);
  }
  assert.deepEqual(m.clips[1].source, [{ videoId: 'RRRRRRRRRRR', startSec: 20, endSec: 23.4 }]); assert.deepEqual(m.clips[2].source, [{ videoId: 'RRRRRRRRRRR', startSec: 23.6, endSec: 28 }]);
});

// ---------------------------------------------------------------- eligibility
const elig = (clips, usage = []) => eligibleClips({ clips }, usage, { dir: '/d', exists: () => true }).map((c) => c.id);
test('eligibleClips: a superseded parent is never returned, even with a pass, a single subject and tags', () => {
  assert.deepEqual(elig([parentOf()]), ['clip-AAAAAAAAAAA-100']);
  assert.deepEqual(elig([parentOf({ supersededBy: ['clip-AAAAAAAAAAA-100-s1'] })]), []);
});
test('eligibleClips: a pass without singleSubject "yes" is not eligible (fail closed)', () => {
  for (const v of [{ ...GOOD, singleSubject: undefined }, { ...GOOD, singleSubject: 'no' }, { ...GOOD, singleSubject: true }, { ...GOOD, singleSubject: 'YES' }, { ...GOOD, singleSubject: null }]) assert.deepEqual(elig([parentOf({ verified: v })]), [], JSON.stringify(v.singleSubject));
  const old = { verdict: 'pass', by: 'me', at: 'x', notes: '' }; assert.deepEqual(elig([parentOf({ verified: old })]), []);
});
test('usage: using a child blocks the same range and not a sibling with a different range', () => {
  const s1 = parentOf({ id: 'c-s1', file: 'c-s1.mp4', parent: 'c', source: [{ videoId: 'AAAAAAAAAAA', startSec: 100, endSec: 103.3 }] });
  const s2 = parentOf({ id: 'c-s2', file: 'c-s2.mp4', parent: 'c', source: [{ videoId: 'AAAAAAAAAAA', startSec: 103.7, endSec: 107 }] });
  const used = [{ id: 'AAAAAAAAAAA', startSec: 100, endSec: 103.3 }];
  assert.deepEqual(elig([s1, s2], used), ['c-s2']); assert.deepEqual(elig([s1, s2], [{ id: 'AAAAAAAAAAA', startSec: 103.7, endSec: 107 }]), ['c-s1']); assert.deepEqual(elig([s1, s2], []), ['c-s1', 'c-s2']);
});

// ---------------------------------------------------------------- duration limits
const probeOf = (dur) => async () => ({ streams: [{ codec_type: 'video', width: 1080, height: 1920, r_frame_rate: '30/1' }], format: { duration: String(dur) } });
test('LIBRARY_CLIP_MIN_SEC is the single lower limit: a 3 s single-shot clip passes the render check, 2.8 s does not', async () => {
  assert.equal(LIBRARY_CLIP_MIN_SEC, MIN_SHOT_SEC);
  for (const d of [3, 2.97, 3.3, 9, 10]) assert.equal((await checkRendered('f.mp4', { probe: probeOf(d) })).ok, true, `${d}`);
  for (const d of [2.8, 10.01]) assert.equal((await checkRendered('f.mp4', { probe: probeOf(d) })).ok, false, `${d}`);
});
test('composeClip: the QA of a composed 2.93 s clip (a 3 s shot a frame short) uses the same limit (real ffmpeg)', async (t) => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('no local ffmpeg');
  const d = tmp(); const clip = path.join(d, 'c.mp4'); const png = path.join(d, 'o.png');
  assert.equal(spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=2.93', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]).status, 0);
  assert.equal(spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=c=black@0.0:s=1080x1920,format=rgba', '-frames:v', '1', png]).status, 0);
  const r = await composeClip({ clipFile: clip, overlayPng: png, out: path.join(d, 'out', 'o.mp4'), repoRoot: tmp(), gitTopLevel: noGit });
  assert.equal(r.ok, true, r.problems.join('; '));
});

// ---------------------------------------------------------------- verdict field and summary
test('setVerdict records singleSubject yes|no, refuses other values; without it the field is absent', () => {
  const m = { clips: [parentOf({ verified: null })] };
  assert.equal(setVerdict(m, 'clip-AAAAAAAAAAA-100', { verdict: 'pass', by: 'x', singleSubject: 'yes' }).clips[0].verified.singleSubject, 'yes');
  assert.equal(setVerdict(m, 'clip-AAAAAAAAAAA-100', { verdict: 'pass', by: 'x', singleSubject: 'no' }).clips[0].verified.singleSubject, 'no');
  assert.equal('singleSubject' in setVerdict(m, 'clip-AAAAAAAAAAA-100', { verdict: 'pass', by: 'x' }).clips[0].verified, false);
  assert.throws(() => setVerdict(m, 'clip-AAAAAAAAAAA-100', { verdict: 'pass', by: 'x', singleSubject: 'maybe' }), /single-subject/);
});
test('--verdict --single-subject: writes the field; a bad value exits 4 and writes nothing', async () => {
  const dir = lib([parentOf({ verified: null })]);
  assert.equal((await cli(['--verdict', 'clip-AAAAAAAAAAA-100', 'pass', '--by', 'dense look', '--single-subject', 'yes'], dir)).code, 0);
  assert.equal(readManifest(dir).clips[0].verified.singleSubject, 'yes');
  const before = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
  assert.equal((await cli(['--verdict', 'clip-AAAAAAAAAAA-100', 'pass', '--by', 'x', '--single-subject', 'perhaps'], dir)).code, 4);
  assert.equal(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), before);
});
test('--summary shows parent and children and says what is missing for each clip', async () => {
  const parent = parentOf({ supersededBy: ['c-s1', 'c-s2'] });
  const s1 = parentOf({ id: 'c-s1', file: 'c-s1.mp4', parent: parent.id, verified: null, shows: undefined });
  const s2 = parentOf({ id: 'c-s2', file: 'c-s2.mp4', parent: parent.id, verified: { ...GOOD, singleSubject: undefined }, shows: undefined });
  const dir = lib([parent, s1, s2]); const r = await cli(['--summary'], dir); const lines = r.out;
  const line = (id) => lines.find((l) => l.startsWith(`  ${id} `));
  assert.equal(r.code, 0); assert.match(line(parent.id), /superseded by c-s1, c-s2/); assert.doesNotMatch(line(parent.id), /missing/);
  assert.match(line('c-s1'), /child of clip-AAAAAAAAAAA-100/); assert.match(line('c-s1'), /missing: verdict, single-subject, tags/);
  assert.match(line('c-s2'), /missing: single-subject, tags/); assert.doesNotMatch(line('c-s2'), /missing: verdict/);
  const sm = summarise({ clips: [parent, s1, s2] }, [], { dir: '/d', exists: () => true }); assert.equal(sm.superseded, 1); assert.equal(sm.eligible, 0);
});
