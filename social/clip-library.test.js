import './test-env.js';
// Tests for social/clip-library.js: a fixed, densely checked set of silent clips. No ffmpeg, no real media:
// an injected `run` and `probe`, temporary directories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPlan, renderLibrary, detectFlash, parseLumaFrames, parseBlackIntervals, findFlashes, eligibleClips,
  setVerdict, libraryDir, readManifest, summarise, main,
} from './clip-library.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-test-')));
const noGit = () => null;
const info = (t) => `[Parsed_showinfo_1 @ 0x6000] n:   0 pts:  1000 pts_time:${t}  duration: 1 fmt:yuv420p`;
const seg = (a, b, subject = 'landscape') => ({ startSec: 0, endSec: 99, verdict: 'clear', secondLook: { verdict: 'ok', usable: { startSec: a, endSec: b }, subject, by: 'x', at: '2026-11-17' } });
const entry = (id, segments) => ({ id, file: `africa/${id}.mp4`, durationSec: 300, flags: {}, segments });
const catalog = () => ({ entries: [entry('AAAAAAAAAAA', [seg(10, 40, 'zebra herd')]), entry('BBBBBBBBBBB', [seg(20, 50, 'beach')])] });
const cutsRun = async () => ({ stdout: '', stderr: `${info('5')}\n${info('15')}` }); // shots 5, 10, 15 s long per 30 s stretch
const goodProbe = async () => ({ streams: [{ codec_type: 'video', width: 1080, height: 1920, r_frame_rate: '30/1' }], format: { duration: '7.5' } });

// ---------------------------------------------------------------- buildPlan
test('buildPlan: stable ids, same plan for the same seed, subject and source spans carried', async () => {
  const a = await buildPlan(catalog(), { seed: 's1', run: cutsRun, root: '/media' });
  const b = await buildPlan(catalog(), { seed: 's1', run: cutsRun, root: '/media' });
  assert.deepEqual(a, b);
  assert.ok(a.length >= 4);
  for (const c of a) {
    assert.match(c.id, /^clip-[A-Z]{11}-\d+$/);
    assert.equal(c.id, `clip-${c.source[0].videoId}-${Math.round(c.source[0].startSec * 10)}`);
    assert.ok(['zebra herd', 'beach'].includes(c.subject));
    assert.equal(c.subject, c.source[0].videoId === 'AAAAAAAAAAA' ? 'zebra herd' : 'beach');
    assert.equal(c.ok, true);
    assert.ok(c.durationSec >= 6 && c.durationSec <= 9);
  }
  assert.equal(new Set(a.map((c) => c.id)).size, a.length);
});
test('buildPlan: no two clips use the same moment of a video', async () => {
  const plan = await buildPlan(catalog(), { seed: 'x', run: cutsRun, root: '/media' });
  const spans = plan.flatMap((c) => c.source);
  for (let i = 0; i < spans.length; i += 1) {
    for (let j = i + 1; j < spans.length; j += 1) {
      if (spans[i].videoId !== spans[j].videoId) continue;
      const overlap = Math.min(spans[i].endSec, spans[j].endSec) - Math.max(spans[i].startSec, spans[j].startSec);
      assert.ok(overlap <= 0, `${JSON.stringify(spans[i])} overlaps ${JSON.stringify(spans[j])}`);
    }
  }
});
test('buildPlan: an empty catalogue plans nothing', async () => {
  assert.deepEqual(await buildPlan({ entries: [] }, { seed: 's', run: cutsRun, root: '/media' }), []);
});

// ---------------------------------------------------------------- renderLibrary
const fakeRun = (log = []) => async (cmd, args) => { log.push(args); fs.writeFileSync(args[args.length - 1], 'x'); return { stdout: '', stderr: '' }; };
const mkPlan = (over = {}) => [
  { ok: true, id: 'clip-AAAAAAAAAAA-150', durationSec: 7.5, subject: 'zebra herd', spans: [{ id: 'AAAAAAAAAAA', file: 'africa/AAAAAAAAAAA.mp4', startSec: 15, endSec: 22.5 }], source: [{ videoId: 'AAAAAAAAAAA', startSec: 15, endSec: 22.5 }], ...over },
  { ok: true, id: 'clip-BBBBBBBBBBB-250', durationSec: 6, subject: 'beach', spans: [{ id: 'BBBBBBBBBBB', file: 'africa/BBBBBBBBBBB.mp4', startSec: 25, endSec: 31 }], source: [{ videoId: 'BBBBBBBBBBB', startSec: 25, endSec: 31 }] },
];
const common = (dir, extra = {}) => ({ dir, root: '/media', run: fakeRun(), probe: goodProbe, repoRoot: tmp(), gitTopLevel: noGit, ...extra });

test('renderLibrary: renders without any text, writes a 0600 manifest with the agreed fields', async () => {
  const dir = path.join(tmp(), 'lib'); const calls = [];
  const { manifest } = await renderLibrary(mkPlan(), common(dir, { run: fakeRun(calls) }));
  assert.equal(calls.length, 2);
  for (const args of calls) assert.ok(!args.join(' ').includes('drawtext'));
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(disk, manifest);
  assert.equal(fs.statSync(path.join(dir, 'manifest.json')).mode & 0o777, 0o600);
  const c = disk.clips[0];
  assert.deepEqual(Object.keys(c).sort(), ['checks', 'durationSec', 'file', 'flash', 'id', 'renderedAt', 'source', 'subject', 'verified']);
  assert.equal(c.id, 'clip-AAAAAAAAAAA-150');
  assert.equal(c.checks.rendered, 'ok');
  assert.equal(c.flash, null); assert.equal(c.verified, null);
  assert.ok(fs.existsSync(path.join(dir, c.file)));
  assert.deepEqual(c.source, [{ videoId: 'AAAAAAAAAAA', startSec: 15, endSec: 22.5 }]);
});
test('renderLibrary: a clip that fails the render check carries the reasons; a render error does not stop the rest', async () => {
  const dir = path.join(tmp(), 'lib'); let n = 0;
  const run = async (cmd, args) => { n += 1; if (n === 1) throw new Error('boom'); fs.writeFileSync(args[args.length - 1], 'x'); return { stdout: '', stderr: '' }; };
  const { manifest } = await renderLibrary(mkPlan(), common(dir, { run }));
  assert.ok(Array.isArray(manifest.clips[0].checks.rendered) && /boom/.test(manifest.clips[0].checks.rendered[0]));
  assert.equal(manifest.clips[1].checks.rendered, 'ok');
  const bad = await renderLibrary(mkPlan(), common(path.join(tmp(), 'l2'), { probe: async () => ({ streams: [{ codec_type: 'video', width: 10, height: 10, r_frame_rate: '30/1' }], format: { duration: '7' } }) }));
  assert.ok(Array.isArray(bad.manifest.clips[0].checks.rendered) && bad.manifest.clips[0].checks.rendered.length > 0);
});
test('renderLibrary: verified and flash survive a re-run when file and spans are unchanged, and are not re-rendered', async () => {
  const dir = path.join(tmp(), 'lib');
  await renderLibrary(mkPlan(), common(dir));
  const m = readManifest(dir);
  m.clips[0].verified = { verdict: 'pass', by: 'me', at: '2026-11-17T10:00:00Z', notes: '' };
  m.clips[0].flash = { flash: false, atSec: [] };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  const calls = [];
  const { manifest } = await renderLibrary(mkPlan(), common(dir, { run: fakeRun(calls) }));
  assert.equal(calls.length, 0);
  assert.deepEqual(manifest.clips[0].verified, m.clips[0].verified);
  assert.deepEqual(manifest.clips[0].flash, { flash: false, atSec: [] });
  assert.equal(manifest.clips[1].verified, null);
});
test('renderLibrary: flash is reset when the source spans changed (same id) and when the file is gone, for clips nobody judged; a judged clip is protected (clip-build-guard.test.js)', async () => {
  const dir = path.join(tmp(), 'lib');
  await renderLibrary(mkPlan(), common(dir));
  const m = readManifest(dir);
  for (const c of m.clips) c.flash = { flash: false, atSec: [] };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  fs.rmSync(path.join(dir, m.clips[1].file));
  const changed = mkPlan();
  changed[0].spans[0].endSec = 23; changed[0].source[0].endSec = 23; changed[0].durationSec = 8;
  const { manifest } = await renderLibrary(changed, common(dir));
  assert.equal(manifest.clips[0].verified, null); assert.equal(manifest.clips[0].flash, null);
  assert.equal(manifest.clips[1].verified, null); assert.equal(manifest.clips[1].flash, null);
  assert.deepEqual(manifest.clips[0].source, [{ videoId: 'AAAAAAAAAAA', startSec: 15, endSec: 23 }]);
});
test('renderLibrary: the library folder is refused inside a repository or a git work tree, nothing is written', async () => {
  const repo = tmp(); const dir = path.join(repo, 'clips');
  await assert.rejects(renderLibrary(mkPlan(), { dir, root: '/media', run: fakeRun(), probe: goodProbe, repoRoot: repo, gitTopLevel: noGit }), /refus/);
  assert.ok(!fs.existsSync(dir));
  const out = path.join(tmp(), 'lib');
  await assert.rejects(renderLibrary(mkPlan(), { dir: out, root: '/media', run: fakeRun(), probe: goodProbe, repoRoot: tmp(), gitTopLevel: () => '/some/work/tree' }), /refus/);
  assert.ok(!fs.existsSync(path.join(out, 'manifest.json')));
});
test('libraryDir: default under the home folder, BPA_CLIP_LIBRARY overrides', () => {
  assert.equal(libraryDir({ HOME: '/h' }), path.join('/h', 'Movies', 'Beyond Paradise', 'clip-library'));
  assert.equal(libraryDir({ HOME: '/h', BPA_CLIP_LIBRARY: '/elsewhere' }), '/elsewhere');
});

// ---------------------------------------------------------------- flash detection
const luma = (list) => list.map(([t, y]) => `frame:0    pts:0       pts_time:${t}\nlavfi.signalstats.YAVG=${y}`).join('\n');
const frames = (ys, fps = 30) => ys.map((y, i) => [(i / fps).toFixed(3), y]);
test('parseLumaFrames reads pts_time and YAVG pairs', () => {
  assert.deepEqual(parseLumaFrames(luma([['0.000', 100.5], ['0.033', 240]])), [{ t: 0, y: 100.5 }, { t: 0.033, y: 240 }]);
  assert.deepEqual(parseLumaFrames('nothing here'), []);
});
test('parseBlackIntervals reads blackdetect lines', () => {
  assert.deepEqual(parseBlackIntervals('[blackdetect @ 0x1] black_start:2.5 black_end:2.8 black_duration:0.3'), [{ start: 2.5, end: 2.8 }]);
  assert.deepEqual(parseBlackIntervals('frame= 10'), []);
});
test('findFlashes: two bright frames in a row is a white flash; one is not', () => {
  assert.deepEqual(findFlashes(parseLumaFrames(luma(frames([100, 100, 245, 250, 100, 100]))), []), [0.067]);
  assert.deepEqual(findFlashes(parseLumaFrames(luma(frames([100, 100, 245, 100, 100]))), []), []);
});
test('findFlashes: two dark frames in a row is a black flash; one is not', () => {
  assert.deepEqual(findFlashes(parseLumaFrames(luma(frames([100, 3, 2, 100]))), []), [0.033]);
  assert.deepEqual(findFlashes(parseLumaFrames(luma(frames([100, 3, 100]))), []), []);
});
test('findFlashes: a run at the end of the clip counts, a blackdetect interval counts, close ones merge', () => {
  assert.deepEqual(findFlashes(parseLumaFrames(luma(frames([100, 100, 250, 250]))), []), [0.067]);
  assert.deepEqual(findFlashes([], [{ start: 2.5, end: 2.8 }]), [2.5]);
  assert.deepEqual(findFlashes(parseLumaFrames(luma(frames([100, 2, 2, 100]))), [{ start: 0.033, end: 0.2 }]), [0.033]);
});
test('detectFlash: both outcomes through an injected run', async () => {
  const bad = await detectFlash('/x/clip.mp4', { run: async () => ({ stdout: luma(frames([100, 250, 251, 100])), stderr: '' }) });
  assert.deepEqual(bad, { flash: true, atSec: [0.033] });
  const ok = await detectFlash('/x/clip.mp4', { run: async () => ({ stdout: luma(frames([100, 110, 120])), stderr: '' }) });
  assert.deepEqual(ok, { flash: false, atSec: [] });
  const black = await detectFlash('/x/clip.mp4', { run: async () => ({ stdout: luma(frames([100, 110])), stderr: '[blackdetect @ 0x1] black_start:1 black_end:1.2 black_duration:0.2' }) });
  assert.deepEqual(black, { flash: true, atSec: [1] });
});
test('detectFlash: no frames at all is an error, never "no flash"', async () => {
  await assert.rejects(detectFlash('/x/clip.mp4', { run: async () => ({ stdout: '', stderr: '' }) }), /no frames/);
});

// ---------------------------------------------------------------- eligibleClips
const good = (id = 'clip-AAAAAAAAAAA-150') => ({
  id, file: `${id}.mp4`, durationSec: 7, source: [{ videoId: 'AAAAAAAAAAA', startSec: 15, endSec: 22 }], subject: 's', renderedAt: 'x',
  checks: { rendered: 'ok' }, flash: { flash: false, atSec: [] }, verified: { verdict: 'pass', by: 'me', at: 'x', notes: '', singleSubject: 'yes' },
});
const elig = (clip, usage = [], exists = () => true) => eligibleClips({ clips: [clip] }, usage, { dir: '/d', exists }).length === 1;
test('eligibleClips: a fully good clip is eligible', () => assert.equal(elig(good()), true));
test('eligibleClips: every null and every wrong value makes a clip ineligible', () => {
  const variants = {
    'rendered null': { checks: { rendered: null } }, 'rendered reasons': { checks: { rendered: ['size'] } }, 'rendered OK': { checks: { rendered: 'OK' } },
    'checks null': { checks: null }, 'checks missing': { checks: undefined },
    'flash null': { flash: null }, 'flash true': { flash: { flash: true, atSec: [1] } }, 'flash string': { flash: { flash: 'false', atSec: [] } },
    'flash undefined': { flash: undefined }, 'flash empty object': { flash: {} }, 'flash.flash null': { flash: { flash: null, atSec: [] } },
    'verified null': { verified: null }, 'verified fail': { verified: { verdict: 'fail' } }, 'verified empty': { verified: {} },
    'verified verdict null': { verified: { verdict: null } }, 'verified PASS': { verified: { verdict: 'PASS' } }, 'verified undefined': { verified: undefined }, 'singleSubject missing': { verified: { verdict: 'pass', by: 'me', at: 'x', notes: '' } }, 'singleSubject no': { verified: { verdict: 'pass', singleSubject: 'no' } }, 'superseded': { supersededBy: ['clip-AAAAAAAAAAA-150-s1'] },
    'file null': { file: null }, 'file empty': { file: '' },
  };
  for (const [name, patch] of Object.entries(variants)) assert.equal(elig({ ...good(), ...patch }), false, name);
});
test('eligibleClips: a missing file, or a clip in the usage ledger, is not eligible', () => {
  assert.equal(elig(good(), [], () => false), false);
  assert.equal(elig(good(), [{ id: 'AAAAAAAAAAA', startSec: 18, endSec: 30 }]), false);
  assert.equal(elig(good(), [{ id: 'AAAAAAAAAAA', startSec: 50, endSec: 60 }]), true);
  assert.equal(elig(good(), [{ id: 'ZZZZZZZZZZZ', startSec: 15, endSec: 22 }]), true);
  assert.equal(elig(good(), [{ clipId: 'clip-AAAAAAAAAAA-150' }]), false);
});
test('eligibleClips: a bad manifest gives nothing', () => {
  assert.deepEqual(eligibleClips(null, []), []);
  assert.deepEqual(eligibleClips({}, []), []);
});

// ---------------------------------------------------------------- setVerdict
const man = () => ({ version: 1, clips: [good('clip-AAAAAAAAAAA-150'), { ...good('clip-BBBBBBBBBBB-250'), verified: null }] });
test('setVerdict writes pass and fail, and returns a new manifest', () => {
  const m = man();
  const out = setVerdict(m, 'clip-BBBBBBBBBBB-250', { verdict: 'fail', by: 'dense look', at: '2026-11-17T10:00:00Z', notes: 'sign at 3.5 s' });
  assert.deepEqual(out.clips[1].verified, { verdict: 'fail', by: 'dense look', at: '2026-11-17T10:00:00Z', notes: 'sign at 3.5 s' });
  assert.equal(m.clips[1].verified, null);
  assert.equal(setVerdict(m, 'clip-BBBBBBBBBBB-250', { verdict: 'pass', by: 'x' }).clips[1].verified.verdict, 'pass');
});
test('setVerdict refuses unknown ids, unknown verdict words and a missing by', () => {
  assert.throws(() => setVerdict(man(), 'clip-nope', { verdict: 'pass', by: 'x' }), /unknown clip/);
  for (const v of ['maybe', 'PASS', '', null, undefined, true]) assert.throws(() => setVerdict(man(), 'clip-BBBBBBBBBBB-250', { verdict: v, by: 'x' }), /verdict/);
  assert.throws(() => setVerdict(man(), 'clip-BBBBBBBBBBB-250', { verdict: 'pass', by: '' }), /by/);
});
test('setVerdict refuses notes that describe a person, allows "person at 3.5 s"', () => {
  for (const n of ['tall man in a red shirt', 'woman at 2 s', 'a child waving', 'wearing a hat', 'long hair at 1 s']) {
    assert.throws(() => setVerdict(man(), 'clip-BBBBBBBBBBB-250', { verdict: 'fail', by: 'x', notes: n }), /describe/, n);
  }
  assert.doesNotThrow(() => setVerdict(man(), 'clip-BBBBBBBBBBB-250', { verdict: 'fail', by: 'x', notes: 'person at 3.5 s' }));
  assert.doesNotThrow(() => setVerdict(man(), 'clip-BBBBBBBBBBB-250', { verdict: 'fail', by: 'x', notes: 'logo in corner at 5 s' }));
});

// ---------------------------------------------------------------- command line
function cli(argv, env, deps = {}) {
  const out = []; const err = [];
  return main(argv, env, { log: (s) => out.push(s), error: (s) => err.push(s), gitTopLevel: noGit, repoRoot: tmp(), ...deps }).then((code) => ({ code, out, err }));
}
test('--build then --summary then --verdict, end to end with fakes', async () => {
  const home = tmp(); const dir = path.join(home, 'lib'); const catPath = path.join(home, 'cat.json');
  fs.writeFileSync(catPath, JSON.stringify(catalog()));
  const env = { HOME: home, BPA_CLIP_LIBRARY: dir, BPA_STATE_DIR: path.join(home, 'state') };
  const run = async (cmd, args) => {
    if (args.includes('-f') && args.includes('null') && args.join(' ').includes('showinfo') && !args.join(' ').includes('signalstats')) return { stdout: '', stderr: `${info('5')}\n${info('15')}` };
    if (args.join(' ').includes('signalstats')) return { stdout: luma(frames([100, 110, 120])), stderr: '' };
    fs.writeFileSync(args[args.length - 1], 'x'); return { stdout: '', stderr: '' };
  };
  const b = await cli(['--build', '--catalog', catPath, '--root', path.join(home, 'media')], env, { run, probe: goodProbe });
  assert.equal(b.code, 0, b.err.join('\n'));
  const m = readManifest(dir);
  assert.ok(m.clips.length >= 4);
  assert.ok(m.clips.every((c) => c.checks.rendered === 'ok' && c.flash && c.flash.flash === false && c.verified === null));
  const id = m.clips[0].id;
  const v = await cli(['--verdict', id, 'pass', '--by', 'dense look', '--notes', 'nothing', '--single-subject', 'yes'], env);
  assert.equal(v.code, 0, v.err.join('\n'));
  assert.equal(readManifest(dir).clips[0].verified.verdict, 'pass');
  const s = await cli(['--summary'], env);
  assert.equal(s.code, 0);
  assert.match(s.out.join('\n'), /eligible 1\b/);
  assert.equal((await cli(['--verdict', 'clip-nope', 'pass', '--by', 'x'], env)).code, 4);
  assert.equal((await cli(['--verdict', id, 'maybe', '--by', 'x'], env)).code, 4);
  assert.equal((await cli(['--wat'], env)).code, 2);
  assert.equal((await cli([], env)).code, 2);
});
test('summarise counts', () => {
  const m = { clips: [good(), { ...good('clip-B-1'), flash: { flash: true, atSec: [1] } }, { ...good('clip-C-1'), verified: null, checks: { rendered: ['x'] } }] };
  const s = summarise(m, [], { dir: '/d', exists: () => true });
  assert.equal(s.total, 3); assert.equal(s.renderFailed, 1); assert.equal(s.flash, 1); assert.equal(s.eligible, 1); assert.equal(s.eligibleSec, 7);
});
