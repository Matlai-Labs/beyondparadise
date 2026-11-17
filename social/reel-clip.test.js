import './test-env.js';
// Tests for social/reel-clip.js: clips cut from the finished videos, only from the second-look stretches.
// No ffmpeg, no real media: an injected `run` and `probe`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  usableStretches, parseSceneTimes, detectShots, safeShots, planClip, buildRenderArgs, renderClip,
  checkRendered, wrapHook, shotKey, readUsage, appendUsage, SHOT_TRIM_SEC,
} from './reel-clip.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-test-')));
const seg = (startSec, endSec, secondLook) => ({ startSec, endSec, verdict: 'clear', ...(secondLook === undefined ? {} : { secondLook }) });
const look = (a, b, subject = 'landscape') => ({ verdict: 'ok', usable: a === null ? null : { startSec: a, endSec: b }, subject, by: 'x', at: '2026-11-17' });
const entry = (id, segments, extra = {}) => ({ id, file: `africa/${id}.mp4`, durationSec: 300, flags: {}, segments, ...extra });

// ---------------------------------------------------------------- usableStretches
test('usableStretches returns only secondLook.usable stretches, with id, file and subject', () => {
  const cat = { entries: [entry('AAAAAAAAAAA', [seg(8, 34, look(10, 20, 'zebra')), seg(40, 60, look(null))])] };
  assert.deepEqual(usableStretches(cat), [{ id: 'AAAAAAAAAAA', file: 'africa/AAAAAAAAAAA.mp4', startSec: 10, endSec: 20, subject: 'zebra' }]);
});
test('a segment without secondLook contributes nothing', () => {
  assert.deepEqual(usableStretches({ entries: [entry('AAAAAAAAAAA', [seg(8, 34)])] }), []);
});
test('an entry with otherPublisherMark === true contributes nothing', () => {
  const e = entry('AAAAAAAAAAA', [seg(8, 34, look(10, 20))], { flags: { otherPublisherMark: true } });
  assert.deepEqual(usableStretches({ entries: [e] }), []);
});
test('a missing entry contributes nothing', () => {
  assert.deepEqual(usableStretches({ entries: [entry('AAAAAAAAAAA', [seg(8, 34, look(10, 20))], { missing: true })] }), []);
});
test('an unknown (null) publisher mark still counts; garbage usable spans do not', () => {
  const e = entry('AAAAAAAAAAA', [seg(0, 9, look(10, 20)), seg(0, 9, look(30, 25)), seg(0, 9, { usable: { startSec: 'a', endSec: 4 } })], { flags: { otherPublisherMark: null } });
  assert.equal(usableStretches({ entries: [e] }).length, 1);
});
test('usableStretches accepts a bare array of entries', () => {
  assert.equal(usableStretches([entry('AAAAAAAAAAA', [seg(0, 9, look(10, 20))])]).length, 1);
});

// ---------------------------------------------------------------- scene output parsing
const info = (t) => `[Parsed_showinfo_1 @ 0x6000] n:   0 pts:  1000 pts_time:${t}  duration: 1 fmt:yuv420p`;
test('parseSceneTimes: no cuts', () => assert.deepEqual(parseSceneTimes('frame=  0 fps=0.0\nvideo:0kB'), []));
test('parseSceneTimes: reads pts_time of showinfo lines only, ignores N/A and other lines', () => {
  const err = `${info('1.5')}\nsomething pts_time:99\n[Parsed_showinfo_1 @ 0x1] n: 1 pts_time:N/A\n${info('4.25')}`;
  assert.deepEqual(parseSceneTimes(err), [1.5, 4.25]);
});
const R = { file: 'africa/x.mp4', startSec: 10, endSec: 30 };
const runWith = (stderr, seen = []) => async (cmd, args) => { seen.push([cmd, args]); return { stdout: '', stderr }; };
test('detectShots: no cuts gives one shot over the whole stretch', async () => {
  assert.deepEqual(await detectShots(R, { run: runWith('') }), [{ startSec: 10, endSec: 30 }]);
});
test('detectShots: cuts at the very edges are ignored (no empty shots)', async () => {
  const shots = await detectShots(R, { run: runWith(`${info('0.0')}\n${info('0.02')}\n${info('19.98')}\n${info('20.0')}`) });
  assert.deepEqual(shots, [{ startSec: 10, endSec: 30 }]);
});
test('detectShots: many cuts, times are shifted to the original timeline, sorted and de-duplicated', async () => {
  const shots = await detectShots(R, { run: runWith([info('8'), info('2.5'), info('2.5'), info('5')].join('\n')) });
  assert.deepEqual(shots, [{ startSec: 10, endSec: 12.5 }, { startSec: 12.5, endSec: 15 }, { startSec: 15, endSec: 18 }, { startSec: 18, endSec: 30 }]);
});
test('detectShots builds an argument list (no shell), with the threshold and showinfo', async () => {
  const seen = [];
  await detectShots(R, { run: runWith('', seen), threshold: 0.4, ffmpeg: 'FF' });
  const [cmd, args] = seen[0];
  assert.equal(cmd, 'FF');
  assert.ok(Array.isArray(args));
  const vf = args[args.indexOf('-vf') + 1];
  assert.match(vf, /select='gt\(scene,0\.4\)',showinfo/);
  assert.ok(args.includes('-an'));
  assert.equal(args[args.indexOf('-ss') + 1], '10');
  assert.equal(args[args.indexOf('-t') + 1], '20');
});

// ---------------------------------------------------------------- safeShots
const sc = (s) => safeShots(s, { sampleEverySec: 2, sampleOffsetSec: 0, minLenSec: 3 });
test('safeShots: a 1.5 second shot is dropped as not-seen-enough', () => {
  const r = sc([{ startSec: 10.2, endSec: 11.7 }]);
  assert.deepEqual(r.safe, []);
  assert.equal(r.dropped[0].reason, 'not-seen-enough');
});
test('safeShots: a shot holding exactly one looked-at instant is dropped, even when long', () => {
  const r = sc([{ startSec: 11, endSec: 13.9 }]); // instants in [11,13.9): 12 only
  assert.deepEqual(r.safe, []);
  assert.equal(r.dropped[0].reason, 'not-seen-enough');
});
test('safeShots: two instants keep the shot, trimmed 0.3 s off both ends', () => {
  const r = sc([{ startSec: 10, endSec: 14.5 }]); // 10, 12, 14
  assert.equal(SHOT_TRIM_SEC, 0.3);
  assert.deepEqual(r.safe, [{ startSec: 10.3, endSec: 14.2 }]);
});
test('safeShots: the minimum length applies after trimming', () => {
  assert.equal(sc([{ startSec: 10, endSec: 13.6 }]).safe.length, 1); // 3.6 - 0.6 = 3.0 -> kept
  const r = sc([{ startSec: 10, endSec: 13.5 }]); // 2.9 after trimming
  assert.deepEqual(r.safe, []);
  assert.equal(r.dropped[0].reason, 'too-short');
});
test('safeShots: a frame exactly at a cut belongs to the shot that starts there, not the one that ends there', () => {
  const r = sc([{ startSec: 8, endSec: 12 }, { startSec: 12, endSec: 15.9 }]); // [8,12): 8,10 ; [12,15.9): 12,14
  assert.equal(r.safe.length, 2);
  assert.equal(sc([{ startSec: 9, endSec: 12 }]).safe.length, 0); // [9,12): only 10
});
test('safeShots: the sample offset moves the looked-at instants', () => {
  const r = safeShots([{ startSec: 10, endSec: 14.5 }], { sampleEverySec: 2, sampleOffsetSec: 1, minLenSec: 3 }); // 11, 13
  assert.equal(r.safe.length, 1);
  assert.equal(safeShots([{ startSec: 11.5, endSec: 15.5 }], { sampleEverySec: 2, sampleOffsetSec: 1, minLenSec: 3 }).safe.length, 1); // 13, 15
  assert.equal(safeShots([{ startSec: 11.5, endSec: 14.9 }], { sampleEverySec: 2, sampleOffsetSec: 1, minLenSec: 3 }).safe.length, 0); // 13 only
});

// ---------------------------------------------------------------- planClip
const stretch = (id, startSec, endSec, shots) => ({ id, file: `africa/${id}.mp4`, startSec, endSec, subject: 's', shots });
const within = (d) => d >= 6 - 1e-9 && d <= 9 + 1e-9;
const inShots = (sp, st) => st.shots.some((h) => sp.startSec >= h.startSec - 1e-9 && sp.endSec <= h.endSec + 1e-9);

test('planClip: one long shot gives one span of the target length inside that shot', () => {
  const st = stretch('AAAAAAAAAAA', 0, 40, [{ startSec: 10.3, endSec: 30.2 }]);
  const p = planClip([st], { targetSec: 7, usedLedger: [], seed: 'a' });
  assert.equal(p.ok, true);
  assert.equal(p.spans.length, 1);
  assert.equal(p.durationSec, 7);
  assert.ok(inShots(p.spans[0], st));
});
test('planClip: short shots are joined from the SAME stretch only, total within 6 to 9 s', () => {
  const a = stretch('AAAAAAAAAAA', 0, 20, [{ startSec: 1, endSec: 4.5 }, { startSec: 5, endSec: 8.5 }]);
  const b = stretch('BBBBBBBBBBB', 0, 20, [{ startSec: 1, endSec: 4.5 }]);
  for (const seed of ['1', '2', '3', '4', '5', '6']) {
    const p = planClip([a, b], { usedLedger: [], seed });
    assert.equal(p.ok, true);
    assert.ok(within(p.durationSec), `duration ${p.durationSec}`);
    assert.equal(new Set(p.spans.map((s) => s.id)).size, 1, 'never crosses stretches');
    assert.equal(p.spans[0].id, 'AAAAAAAAAAA');
    assert.equal(p.spans.length, 2);
  }
});
test('planClip: two stretches of one video are not mixed either', () => {
  const a = stretch('AAAAAAAAAAA', 0, 10, [{ startSec: 1, endSec: 4.5 }]);
  const b = stretch('AAAAAAAAAAA', 50, 60, [{ startSec: 51, endSec: 54.5 }]);
  assert.deepEqual(planClip([a, b], { usedLedger: [], seed: 'x' }), { ok: false, reason: 'nothing left' });
});
test('planClip: a shot recorded in the ledger is never reused, also when its edges moved slightly', () => {
  const st = stretch('AAAAAAAAAAA', 0, 60, [{ startSec: 1, endSec: 8 }, { startSec: 20, endSec: 28 }]);
  const used = [{ id: 'AAAAAAAAAAA', startSec: 1.05, endSec: 7.95 }];
  for (const seed of ['a', 'b', 'c', 'd', 'e']) {
    const p = planClip([st], { usedLedger: used, seed });
    assert.equal(p.ok, true);
    assert.ok(p.spans[0].startSec >= 20, 'the used shot must not come back');
  }
});
test('planClip: a ledger entry of ANOTHER video does not block the same time range', () => {
  const st = stretch('AAAAAAAAAAA', 0, 60, [{ startSec: 1, endSec: 8 }]);
  assert.equal(planClip([st], { usedLedger: [{ id: 'BBBBBBBBBBB', startSec: 1, endSec: 8 }], seed: 'a' }).ok, true);
});
test('planClip: returns "nothing left" when every shot is used, or none is long enough', () => {
  const st = stretch('AAAAAAAAAAA', 0, 60, [{ startSec: 1, endSec: 8 }]);
  assert.deepEqual(planClip([st], { usedLedger: [{ id: 'AAAAAAAAAAA', startSec: 1, endSec: 8 }], seed: 'a' }), { ok: false, reason: 'nothing left' });
});
test('planClip: three consecutive shots join when two are not enough; no piece is a sliver', () => {
  const st = stretch('AAAAAAAAAAA', 0, 60, [{ startSec: 1, endSec: 3.5 }, { startSec: 6, endSec: 8.5 }, { startSec: 11, endSec: 13.5 }]);
  const p = planClip([st], { usedLedger: [], seed: 'a', targetSec: 6 });
  assert.equal(p.ok, true);
  assert.equal(p.spans.length, 3);
  assert.ok(within(p.durationSec));
  for (const s of p.spans) assert.ok(s.endSec - s.startSec >= 2 - 1e-9);
});
test('planClip: the cut-off last piece is stretched to at least 2 s instead of leaving a sliver', () => {
  const st = stretch('AAAAAAAAAAA', 0, 60, [{ startSec: 1, endSec: 6 }, { startSec: 10, endSec: 13.9 }]);
  const p = planClip([st], { usedLedger: [], seed: 'a', targetSec: 6 });
  assert.equal(p.ok, true);
  assert.equal(p.spans.length, 2);
  assert.ok(p.spans[1].endSec - p.spans[1].startSec >= 2 - 1e-9);
  assert.ok(within(p.durationSec));
});
test('planClip is deterministic for a seed and varies with it', () => {
  const st = stretch('AAAAAAAAAAA', 0, 400, Array.from({ length: 20 }, (_, i) => ({ startSec: i * 20 + 1, endSec: i * 20 + 12 })));
  const one = (seed) => JSON.stringify(planClip([st], { usedLedger: [], seed }));
  assert.equal(one('s1'), one('s1'));
  assert.ok(new Set(['s1', 's2', 's3', 's4', 's5', 's6']).size && new Set(['s1', 's2', 's3', 's4', 's5', 's6'].map(one)).size > 1);
});
test('planClip reports the whole shots it used (for the ledger), not only the cut part', () => {
  const st = stretch('AAAAAAAAAAA', 0, 60, [{ startSec: 10, endSec: 30 }]);
  const p = planClip([st], { usedLedger: [], seed: 'a', targetSec: 6 });
  assert.deepEqual(p.usedShots, [{ id: 'AAAAAAAAAAA', startSec: 10, endSec: 30 }]);
  assert.equal(shotKey(p.usedShots[0]), 'AAAAAAAAAAA:10.00-30.00');
});

// ---------------------------------------------------------------- usage ledger
test('the usage ledger appends lines atomically and reads them back; a broken line is skipped', () => {
  const dir = tmp(); const f = path.join(dir, 'bpa-clip-usage.jsonl');
  assert.deepEqual(readUsage(f), []);
  appendUsage(f, [{ id: 'AAAAAAAAAAA', startSec: 1, endSec: 8 }], new Date('2026-11-17T10:00:00Z'));
  fs.appendFileSync(f, 'not json\n');
  appendUsage(f, [{ id: 'BBBBBBBBBBB', startSec: 2, endSec: 9 }, { id: 'BBBBBBBBBBB', startSec: 12, endSec: 19 }]);
  const u = readUsage(f);
  assert.equal(u.length, 3);
  assert.equal(u[0].at, '2026-11-17T10:00:00.000Z');
});

// ---------------------------------------------------------------- the ffmpeg argument list
const plan2 = {
  ok: true, durationSec: 7,
  spans: [{ id: 'AAAAAAAAAAA', file: 'africa/AAAAAAAAAAA.mp4', startSec: 10.3, endSec: 13.8 }, { id: 'AAAAAAAAAAA', file: 'africa/AAAAAAAAAAA.mp4', startSec: 15, endSec: 18.5 }],
};
test('render args: -an, centre crop to 9:16, scale 1080x1920, 30 fps, one input per span, cut from the original', () => {
  const out = path.join(tmp(), 'clip.mp4');
  const { args } = buildRenderArgs(plan2, { out, root: '/media-root', hook: null });
  assert.ok(args.includes('-an'));
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.match(fc, /crop=trunc\(ih\*9\/16\/2\)\*2:ih/);
  assert.match(fc, /scale=1080:1920/);
  assert.match(fc, /fps=30/);
  assert.match(fc, /concat=n=2:v=1:a=0/);
  assert.equal(args.filter((a) => a === '-i').length, 2);
  assert.ok(args.includes(path.join('/media-root', 'africa/AAAAAAAAAAA.mp4')));
  assert.equal(args[args.length - 1], out);
  assert.ok(!/drawtext/.test(fc), 'no hook, no drawtext');
});
test('render args with a hook: textfile=, the hook text itself never appears in the arguments', () => {
  const out = path.join(tmp(), 'clip.mp4');
  const hook = "It's 100% a secret: \"quotes\", commas; and %{pts} too";
  const { args, textFile } = buildRenderArgs(plan2, { out, root: '/media-root', hook, fontFile: '/fonts/F.ttf' });
  const all = args.join('\n');
  assert.match(all, /textfile=/);
  assert.match(all, /fontfile=/);
  assert.match(all, /expansion=none/);
  assert.match(all, /box=1:boxcolor=black@/);
  for (const piece of ['secret', 'quotes', 'commas', 'pts']) assert.ok(!all.includes(piece), `raw hook text leaked: ${piece}`);
  assert.ok(fs.readFileSync(textFile, 'utf8').includes('secret'));
  fs.rmSync(path.dirname(textFile), { recursive: true, force: true });
});
test('render args: a source path that leaves the media root is refused', () => {
  const bad = { ...plan2, spans: [{ ...plan2.spans[0], file: '../../etc/passwd' }] };
  assert.throws(() => buildRenderArgs(bad, { out: path.join(tmp(), 'c.mp4'), root: '/media-root' }), /outside the media root/);
});
test('render: output inside the repository is refused and nothing is run', async () => {
  let ran = 0;
  const here = path.dirname(new URL(import.meta.url).pathname);
  await assert.rejects(renderClip(plan2, { out: path.join(here, 'x.mp4'), root: '/m', run: async () => { ran += 1; return {}; } }), /refusing to write/);
  assert.equal(ran, 0);
});
test('render: output inside the media root is refused (a source must never be overwritten)', async () => {
  const root = tmp();
  await assert.rejects(renderClip(plan2, { out: path.join(root, 'africa', 'AAAAAAAAAAA.mp4'), root, run: async () => ({}) }), /media root/);
});
test('render runs one ffmpeg command, returns path, duration and exact source spans, and cleans the text file', async () => {
  const dir = tmp(); const out = path.join(dir, 'c.mp4'); const calls = [];
  const r = await renderClip(plan2, { out, root: '/media-root', hook: 'Hello there', fontFile: '/fonts/F.ttf', ffmpeg: 'FF', run: async (c, a) => { calls.push([c, a]); return { stdout: '', stderr: '' }; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'FF');
  assert.equal(r.file, out);
  assert.equal(r.durationSec, 7);
  assert.deepEqual(r.spans.map((s) => [s.id, s.startSec, s.endSec]), [['AAAAAAAAAAA', 10.3, 13.8], ['AAAAAAAAAAA', 15, 18.5]]);
  const tf = calls[0][1].join('\n').match(/textfile=([^:]+)/)[1].replace(/\\/g, '');
  assert.equal(fs.existsSync(tf), false, 'temporary text file removed');
});
test('render: a missing drawtext filter in ffmpeg gives a plain message', async () => {
  const run = async () => { const e = new Error('x'); e.stderr = "No such filter: 'drawtext'"; throw e; };
  await assert.rejects(renderClip(plan2, { out: path.join(tmp(), 'c.mp4'), root: '/m', hook: 'hi', fontFile: '/f.ttf', run }), /drawtext/);
});
test('render: a plan that is not ok is refused', async () => {
  await assert.rejects(renderClip({ ok: false, reason: 'nothing left' }, { out: path.join(tmp(), 'c.mp4'), run: async () => ({}) }), /no clip to render/);
});

// ---------------------------------------------------------------- hook wrapping
test('wrapHook: about 22 characters a line, at most 3 lines, never splits a word, cuts with an ellipsis', () => {
  assert.equal(wrapHook('Short'), 'Short');
  const w = wrapHook('Sample text, not for posting');
  assert.ok(w.split('\n').every((l) => l.length <= 22));
  const long = wrapHook('one two three four five six seven eight nine ten eleven twelve thirteen fourteen');
  assert.equal(long.split('\n').length, 3);
  assert.ok(long.split('\n').every((l) => l.length <= 22));
  assert.ok(long.endsWith('…'));
  assert.ok(wrapHook('Supercalifragilisticexpialidocious-word').split('\n').every((l) => l.length <= 22));
});

// ---------------------------------------------------------------- checkRendered
const good = { streams: [{ codec_type: 'video', width: 1080, height: 1920, r_frame_rate: '30/1' }], format: { duration: '7.5' } };
const withP = (over = {}, fmt = {}) => ({ streams: over.streams || [{ ...good.streams[0], ...over }], format: { ...good.format, ...fmt } });
const chk = (p) => checkRendered('f.mp4', { probe: async () => p });
test('checkRendered: a good file passes', async () => { assert.deepEqual(await chk(good), { ok: true, problems: [], durationSec: 7.5 }); });
test('checkRendered: duration limits, both sides of each', async () => {
  assert.equal((await chk(withP({}, { duration: '5' }))).ok, true);
  assert.equal((await chk(withP({}, { duration: '4.99' }))).ok, false);
  assert.equal((await chk(withP({}, { duration: '10' }))).ok, true);
  assert.equal((await chk(withP({}, { duration: '10.01' }))).ok, false);
});
test('checkRendered: size, one pixel off either way fails', async () => {
  assert.equal((await chk(withP({ width: 1079 }))).ok, false);
  assert.equal((await chk(withP({ width: 1081 }))).ok, false);
  assert.equal((await chk(withP({ height: 1919 }))).ok, false);
  assert.equal((await chk(withP({ height: 1921 }))).ok, false);
});
test('checkRendered: any audio stream fails', async () => {
  const p = withP({ streams: [good.streams[0], { codec_type: 'audio' }] });
  const r = await chk(p);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((x) => /audio/.test(x)));
});
test('checkRendered: frame rate must be 30 (29.97 and 31 fail; 30000/1000 passes)', async () => {
  assert.equal((await chk(withP({ r_frame_rate: '30000/1001' }))).ok, false);
  assert.equal((await chk(withP({ r_frame_rate: '31/1' }))).ok, false);
  assert.equal((await chk(withP({ r_frame_rate: '29/1' }))).ok, false);
  assert.equal((await chk(withP({ r_frame_rate: '30000/1000' }))).ok, true);
  assert.equal((await chk(withP({ r_frame_rate: '0/0' }))).ok, false);
});
test('checkRendered: no video stream, or a probe that throws, is a failure with reasons and deletes nothing', async () => {
  const dir = tmp(); const f = path.join(dir, 'x.mp4'); fs.writeFileSync(f, 'x');
  assert.equal((await checkRendered(f, { probe: async () => ({ streams: [], format: { duration: '7' } }) })).ok, false);
  const r = await checkRendered(f, { probe: async () => { throw new Error('boom'); } });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /boom/);
  assert.ok(fs.existsSync(f), 'the file is left alone');
});

// ---------------------------------------------------------------- the module keeps the rules in its source
test('the source holds no absolute user path and no network call', () => {
  const src = fs.readFileSync(new URL('./reel-clip.js', import.meta.url), 'utf8');
  assert.ok(!/\/Users\//.test(src));
  assert.ok(!/https?:\/\/|fetch\(/.test(src));
  assert.ok(!/(?<![.\w])exec\(|execSync|shell:\s*true/.test(src), 'execFile only');
});
