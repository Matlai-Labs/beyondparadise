import './test-env.js';
// A build may never destroy a judgement: a clip with a verdict, a record of what it shows, children, or a split
// child is PROTECTED (file and manifest entry are never rendered over, changed or dropped). No ffmpeg, no real media.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPlan, renderLibrary, readManifest, main } from './clip-library.js';
import { planClip } from './reel-clip.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cbg-test-')));
const noGit = () => null;
const goodProbe = async () => ({ streams: [{ codec_type: 'video', width: 1080, height: 1920, r_frame_rate: '30/1' }], format: { duration: '7.5' } });
const info = (t) => `[Parsed_showinfo_1 @ 0x6000] n:   0 pts:  1000 pts_time:${t}  duration: 1 fmt:yuv420p`;
let rendered; // output files the fake render wrote in this test
const fakeRun = async (cmd, args) => { if (args[args.length - 1] === '-') return { stdout: '', stderr: '' }; rendered.push(path.basename(args[args.length - 1])); fs.writeFileSync(args[args.length - 1], `render-${rendered.length}`); return { stdout: '', stderr: '' }; };
const deps = (dir, extra = {}) => ({ dir, root: '/media', run: fakeRun, probe: goodProbe, repoRoot: tmp(), gitTopLevel: noGit, ...extra });
const item = (id, vid, a, b) => ({ ok: true, id, durationSec: r(b - a), subject: 'x', spans: [{ id: vid, file: `africa/${vid}.mp4`, startSec: a, endSec: b }], source: [{ videoId: vid, startSec: a, endSec: b }] });
const r = (x) => Math.round(x * 100) / 100;
const A = 'AAAAAAAAAAA'; const B = 'BBBBBBBBBBB'; const C = 'CCCCCCCCCCC';
const PASS = { verdict: 'pass', by: 'me', at: '2026-11-17T10:00:00Z', notes: '', singleSubject: 'yes' };
const SHOWS = { tags: ['lion'], by: 'me', at: '2026-11-17T10:00:00Z', notes: '' };

// a library with one rendered clip per plan item, then `mark(manifest)` edits the manifest (judgements) before the next build
async function libWith(plan, mark) {
  rendered = [];
  const dir = path.join(tmp(), 'lib');
  await renderLibrary(plan, deps(dir));
  const m = readManifest(dir); mark(m);
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(m, null, 2)}\n`);
  rendered = [];
  return dir;
}
const snapshot = (dir, id) => ({ entry: readManifest(dir).clips.find((c) => c.id === id), bytes: fs.readFileSync(path.join(dir, `${id}.mp4`), 'utf8') });
const moved = () => [item(`clip-${A}-150`, A, 15, 22.5)]; // same id, other end
const orig = () => [item(`clip-${A}-150`, A, 15, 21)];

async function protectedStaysPut(mark, label) {
  const dir = await libWith(orig(), mark);
  const before = snapshot(dir, `clip-${A}-150`);
  const res = await renderLibrary(moved(), deps(dir));
  assert.deepEqual(rendered, [], `${label}: nothing rendered`);
  assert.deepEqual(snapshot(dir, `clip-${A}-150`), before, `${label}: file bytes and entry unchanged`);
  assert.deepEqual(res.counts.protectedChanged.map((p) => p.id), [`clip-${A}-150`]);
  assert.deepEqual(res.manifest.clips.find((c) => c.id === `clip-${A}-150`), before.entry);
  return dir;
}
const cliBuild = async (dir, plan, extra = []) => {
  const home = tmp(); const cat = path.join(home, 'cat.json'); fs.writeFileSync(cat, JSON.stringify({ entries: [] }));
  const out = []; const err = [];
  const code = await main(['--build', '--catalog', cat, '--root', path.join(home, 'media'), ...extra], { HOME: home, BPA_CLIP_LIBRARY: dir, BPA_STATE_DIR: path.join(home, 'state') },
    { log: (s) => out.push(s), error: (s) => err.push(s), gitTopLevel: noGit, repoRoot: tmp(), run: fakeRun, probe: goodProbe, plan });
  return { code, out, err };
};

test('a judged clip (verdict pass) whose planned span moved is untouched: file bytes, entry, listed as protected', async () => {
  await protectedStaysPut((m) => { m.clips[0].verified = PASS; m.clips[0].flash = { flash: false, atSec: [] }; }, 'verdict');
});
test('a clip with only a shows record is protected the same way', async () => {
  await protectedStaysPut((m) => { m.clips[0].shows = SHOWS; }, 'shows');
});
test('a parent with supersededBy is protected the same way', async () => {
  await protectedStaysPut((m) => { m.clips[0].supersededBy = [`clip-${A}-150-s1`]; }, 'parent');
});
test('a split child is protected the same way', async () => {
  await protectedStaysPut((m) => { m.clips[0].parent = `clip-${A}-100`; }, 'child');
});
test('a judged clip that is no longer planned stays in the manifest with its file, and is reported', async () => {
  const dir = await libWith(orig(), (m) => { m.clips[0].verified = PASS; });
  const before = snapshot(dir, `clip-${A}-150`);
  const res = await renderLibrary([], deps(dir));
  assert.deepEqual(snapshot(dir, `clip-${A}-150`), before);
  assert.deepEqual(res.manifest.clips.map((c) => c.id), [`clip-${A}-150`]);
  assert.deepEqual(res.counts.protectedChanged.map((p) => p.id), [`clip-${A}-150`]);
  assert.equal(res.counts.unjudgedDropped, 0);
});
test('a protected clip with an unchanged plan is kept exactly as it is and is not reported', async () => {
  const dir = await libWith(orig(), (m) => { m.clips[0].verified = PASS; m.clips[0].durationSec = 99; m.clips[0].subject = 'edited'; });
  const before = snapshot(dir, `clip-${A}-150`);
  const res = await renderLibrary(orig(), deps(dir));
  assert.deepEqual(snapshot(dir, `clip-${A}-150`), before);
  assert.deepEqual(res.counts.protectedChanged, []);
  assert.equal(res.counts.kept, 1);
});
test('an unjudged clip with a moved span is re-rendered, one no longer planned is dropped (today, pinned)', async () => {
  const dir = await libWith([...orig(), item(`clip-${B}-250`, B, 25, 31)], () => {});
  const res = await renderLibrary(moved(), deps(dir));
  assert.deepEqual(rendered, [`clip-${A}-150.mp4`]);
  assert.deepEqual(res.manifest.clips.map((c) => c.id), [`clip-${A}-150`]);
  assert.deepEqual(res.manifest.clips[0].source, [{ videoId: A, startSec: 15, endSec: 22.5 }]);
  assert.equal(res.counts.unjudgedRerendered, 1);
  assert.equal(res.counts.unjudgedDropped, 1);
  assert.deepEqual(res.counts.protectedChanged, []);
});
test('a new stretch that does not overlap a protected clip becomes a new clip beside it; an overlapping one does not', async () => {
  const dir = await libWith(orig(), (m) => { m.clips[0].verified = PASS; });
  const plan = [item(`clip-${A}-150`, A, 15, 21), item(`clip-${A}-300`, A, 30, 36), item(`clip-${A}-190`, A, 19, 25), item(`clip-${B}-150`, B, 15, 21)];
  const res = await renderLibrary(plan, deps(dir));
  assert.deepEqual(res.manifest.clips.map((c) => c.id).sort(), [`clip-${A}-150`, `clip-${A}-300`, `clip-${B}-150`]);
  assert.deepEqual(rendered.sort(), [`clip-${A}-300.mp4`, `clip-${B}-150.mp4`]);
  assert.deepEqual(res.counts.skippedOverVerdicts.map((p) => p.id), [`clip-${A}-190`]);
  assert.equal(res.counts.newClips, 2);
});
test('dry run: renders nothing and writes nothing (manifest bytes identical, no folder made), counts are the same', async () => {
  const dir = await libWith(orig(), (m) => { m.clips[0].verified = PASS; });
  const before = fs.readFileSync(path.join(dir, 'manifest.json'));
  const plan = [...moved(), item(`clip-${C}-100`, C, 10, 16)];
  const dry = await renderLibrary(plan, deps(dir, { dryRun: true }));
  assert.deepEqual(rendered, []);
  assert.ok(fs.readFileSync(path.join(dir, 'manifest.json')).equals(before));
  const real = await renderLibrary(plan, deps(dir));
  assert.deepEqual(dry.counts, real.counts);
  const fresh = path.join(tmp(), 'never-made');
  await renderLibrary(plan, deps(fresh, { dryRun: true }));
  assert.equal(fs.existsSync(fresh), false);
});
test('--build: the judged-clips line is printed every time (stdout) but is not a failure: exit 0; --dry-run the same and writes nothing; exit 5 stays for render and flash failures', async () => {
  const dir = await libWith(orig(), (m) => { m.clips[0].verified = PASS; });
  const before = fs.readFileSync(path.join(dir, 'manifest.json'));
  const line = /1 judged clips were planned differently and were kept as they are: clip-AAAAAAAAAAA-150/;
  const dry = await cliBuild(dir, moved(), ['--dry-run']);
  assert.equal(dry.code, 0, dry.err.join('\n')); assert.deepEqual(rendered, []);
  assert.ok(fs.readFileSync(path.join(dir, 'manifest.json')).equals(before));
  assert.match(dry.out.join('\n'), line);
  const real = await cliBuild(dir, moved());
  assert.equal(real.code, 0, real.err.join('\n'));
  assert.match(real.out.join('\n'), line);
  assert.equal(snapshot(dir, `clip-${A}-150`).bytes, 'render-1');
  const ok = await cliBuild(dir, orig());
  assert.equal(ok.code, 0, ok.err.join('\n'));
  assert.match(ok.out.join('\n'), /kept unchanged 1/);
  const failing = await cliBuild(dir, [...orig(), item(`clip-${B}-250`, B, 25, 31)]); // the fake cannot measure frames, so the flash check of the new clip fails
  assert.equal(failing.code, 5);
});
test('an unjudged clip whose new plan overlaps judged footage is KEPT as it is (entry and file), listed as skipped, and every id is accounted for', async () => {
  const two = () => [item(`clip-${A}-100`, A, 10, 16), item(`clip-${A}-300`, A, 30, 36)];
  const dir = await libWith(two(), (m) => { m.clips.find((c) => c.id === `clip-${A}-100`).verified = PASS; });
  const before = snapshot(dir, `clip-${A}-300`);
  const plan = [item(`clip-${A}-100`, A, 10, 16), item(`clip-${A}-300`, A, 14, 20)];
  const res = await renderLibrary(plan, deps(dir));
  assert.deepEqual(rendered, []);
  assert.deepEqual(snapshot(dir, `clip-${A}-300`), before);
  assert.deepEqual(res.manifest.clips.map((c) => c.id).sort(), [`clip-${A}-100`, `clip-${A}-300`]);
  assert.deepEqual(res.counts.skippedOverVerdicts.map((p) => p.id), [`clip-${A}-300`]);
  const k = res.counts;
  assert.equal(k.unjudgedDropped, 0);
  assert.equal(k.kept + k.newClips + k.unjudgedRerendered + k.unjudgedDropped + k.skippedOverVerdicts.length + k.protectedChanged.length, 2);
  const cli = await cliBuild(dir, plan);
  assert.match(cli.out.join('\n'), /skipped.*clip-AAAAAAAAAAA-300/);
});

// ---------------------------------------------------------------- the planner: the same stretch gives the same clip
const seg = (a, b) => ({ startSec: 0, endSec: 99, verdict: 'clear', secondLook: { verdict: 'ok', usable: { startSec: a, endSec: b }, subject: 's', by: 'x', at: '2026-11-17' } });
const entryOf = (id, segs) => ({ id, file: `africa/${id}.mp4`, durationSec: 600, flags: {}, segments: segs });
const cutsRun = async () => ({ stdout: '', stderr: `${info('5')}\n${info('15')}` });
test('buildPlan: clips of a catalogue that gets more stretches keep their id and span (length does not depend on how many other stretches exist)', async () => {
  const small = { entries: [entryOf(A, [seg(10, 40)]), entryOf(B, [seg(20, 50)])] };
  const big = { entries: [entryOf(C, [seg(5, 35)]), entryOf(A, [seg(10, 40), seg(100, 130)]), entryOf(B, [seg(20, 50), seg(200, 260)])] };
  const p1 = await buildPlan(small, { run: cutsRun, root: '/media' });
  const p2 = await buildPlan(big, { run: cutsRun, root: '/media' });
  assert.ok(p1.length >= 4 && p2.length > p1.length);
  for (const c of p1) assert.deepEqual(p2.find((x) => x.id === c.id)?.source, c.source, c.id);
});

test('buildPlan: a NEW stretch that sorts before the existing ones, and a reversed pool order, leave the old clips as they are', async () => {
  const base = [entryOf(B, [seg(20, 50)]), entryOf(C, [seg(5, 35)])];
  const p1 = await buildPlan({ entries: base }, { run: cutsRun, root: '/media' });
  const withA = await buildPlan({ entries: [entryOf(A, [seg(10, 40)]), ...base] }, { run: cutsRun, root: '/media' });
  const reversed = await buildPlan({ entries: [...base].reverse() }, { run: cutsRun, root: '/media' });
  assert.ok(p1.length >= 4 && withA.length > p1.length);
  for (const c of p1) { assert.deepEqual(withA.find((x) => x.id === c.id)?.source, c.source, c.id); assert.deepEqual(reversed.find((x) => x.id === c.id)?.source, c.source, c.id); }
  assert.equal(reversed.length, p1.length);
});

// weekly reels keep the seeded pick: values computed once from main's planClip (git show main:social/reel-clip.js), written as literals
test('planClip without stable (weekly reels) gives exactly what main gave for fixed inputs and seeds', () => {
  const st = [{ id: 'AAAAAAAAAAA', file: 'a.mp4', startSec: 10, endSec: 40, shots: [{ startSec: 10.3, endSec: 14 }, { startSec: 14, endSec: 25 }, { startSec: 25.3, endSec: 39.7 }] },
    { id: 'BBBBBBBBBBB', file: 'b.mp4', startSec: 20, endSec: 50, shots: [{ startSec: 20.3, endSec: 24 }, { startSec: 24.6, endSec: 27.6 }, { startSec: 27.6, endSec: 30 }, { startSec: 30.5, endSec: 49.7 }] }];
  const short = [{ id: 'CCCCCCCCCCC', file: 'c.mp4', startSec: 0, endSec: 30, shots: [{ startSec: 1, endSec: 4 }, { startSec: 4, endSec: 6.5 }, { startSec: 6.5, endSec: 9.5 }, { startSec: 12, endSec: 15 }] }];
  const got = [...['s-0', 's-1', 's-2', 'weekly-7'].map((seed) => planClip(st, { seed })), planClip(st, { seed: 't', targetSec: 8 }),
    ...['g-0', 'g-1'].map((seed) => planClip(short, { seed })), planClip(st, { seed: 'l', usedLedger: [{ id: 'AAAAAAAAAAA', startSec: 10, endSec: 40 }] })];
  assert.deepEqual(got, JSON.parse(MAIN_PLANS));
});
const MAIN_PLANS = '[{"ok":true,"spans":[{"id":"BBBBBBBBBBB","file":"b.mp4","startSec":30.5,"endSec":37.5}],"durationSec":7,"usedShots":[{"id":"BBBBBBBBBBB","startSec":30.5,"endSec":49.7}]},{"ok":true,"spans":[{"id":"AAAAAAAAAAA","file":"a.mp4","startSec":25.3,"endSec":32.3}],"durationSec":7,"usedShots":[{"id":"AAAAAAAAAAA","startSec":25.3,"endSec":39.7}]},{"ok":true,"spans":[{"id":"AAAAAAAAAAA","file":"a.mp4","startSec":14,"endSec":21}],"durationSec":7,"usedShots":[{"id":"AAAAAAAAAAA","startSec":14,"endSec":25}]},{"ok":true,"spans":[{"id":"AAAAAAAAAAA","file":"a.mp4","startSec":14,"endSec":20}],"durationSec":6,"usedShots":[{"id":"AAAAAAAAAAA","startSec":14,"endSec":25}]},{"ok":true,"spans":[{"id":"BBBBBBBBBBB","file":"b.mp4","startSec":30.5,"endSec":38.5}],"durationSec":8,"usedShots":[{"id":"BBBBBBBBBBB","startSec":30.5,"endSec":49.7}]},{"ok":true,"spans":[{"id":"CCCCCCCCCCC","file":"c.mp4","startSec":6.5,"endSec":9.5},{"id":"CCCCCCCCCCC","file":"c.mp4","startSec":12,"endSec":15}],"durationSec":6,"usedShots":[{"id":"CCCCCCCCCCC","startSec":6.5,"endSec":9.5},{"id":"CCCCCCCCCCC","startSec":12,"endSec":15}]},{"ok":true,"spans":[{"id":"CCCCCCCCCCC","file":"c.mp4","startSec":6.5,"endSec":9.5},{"id":"CCCCCCCCCCC","file":"c.mp4","startSec":12,"endSec":15}],"durationSec":6,"usedShots":[{"id":"CCCCCCCCCCC","startSec":6.5,"endSec":9.5},{"id":"CCCCCCCCCCC","startSec":12,"endSec":15}]},{"ok":true,"spans":[{"id":"BBBBBBBBBBB","file":"b.mp4","startSec":30.5,"endSec":39.5}],"durationSec":9,"usedShots":[{"id":"BBBBBBBBBBB","startSec":30.5,"endSec":49.7}]}]';
