import './test-env.js';
// Tests for social/media-segments.js: clean stretches of a video and the local vision check.
// No model, no ffprobe, no real media: injected `ask` and `fetchImpl`, made-up stamps, tiny fake frame files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findCleanWindows, parseStamps, parseVerdict, checkFrame, judgeWindow, windowFrameSeconds,
  makeLocalAsk, applySegments, processVideo, selftest, main, loadCoverage, subtractRanges,
} from './media-segments.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ms-test-')));
const W = (a, b) => ({ startSec: a, endSec: b });
const find = (o) => findCleanWindows({ sampleIntervalSec: 2, ...o });

// ---------- windows ----------
test('windows: no text at all gives the whole covered stretch', () => {
  assert.deepEqual(find({ durationSec: 100, textStamps: [], coveredUntilSec: 100 }), [W(0, 100)]);
});
test('windows: text at the very start shrinks the start by one interval after it', () => {
  assert.deepEqual(find({ durationSec: 20, textStamps: [0], coveredUntilSec: 20 }), [W(2, 20)]);
});
test('windows: text at the very end shrinks the end by one interval before it', () => {
  assert.deepEqual(find({ durationSec: 20, textStamps: [20], coveredUntilSec: 20 }), [W(0, 18)]);
  assert.deepEqual(find({ durationSec: 20, textStamps: [18], coveredUntilSec: 20 }), [W(0, 16)]);
});
test('windows: shrink is one interval on each side of a reading (the interval is a parameter)', () => {
  assert.deepEqual(find({ durationSec: 60, textStamps: [30], coveredUntilSec: 60 }), [W(0, 28), W(32, 60)]);
  assert.deepEqual(findCleanWindows({ durationSec: 60, textStamps: [30], sampleIntervalSec: 5, coveredUntilSec: 60 }), [W(0, 25), W(35, 60)]);
});
test('windows: two readings closer than the minimum leave no window between them', () => {
  assert.deepEqual(find({ durationSec: 40, textStamps: [10, 17], coveredUntilSec: 40 }), [W(0, 8), W(19, 40)]);
  assert.deepEqual(find({ durationSec: 40, textStamps: [10, 14], coveredUntilSec: 40 }), [W(0, 8), W(16, 40)]);
});
test('windows: length exactly the minimum is kept, one second less is dropped; default minimum is 6', () => {
  assert.deepEqual(find({ durationSec: 40, textStamps: [10, 20], coveredUntilSec: 40, minLenSec: 4 }), [W(0, 8), W(12, 18), W(22, 40)]);
  assert.deepEqual(find({ durationSec: 40, textStamps: [10, 20], coveredUntilSec: 40, minLenSec: 7 }), [W(0, 8), W(22, 40)]);
  assert.deepEqual(find({ durationSec: 6, textStamps: [], coveredUntilSec: 6 }), [W(0, 6)]);
  assert.deepEqual(find({ durationSec: 5.9, textStamps: [], coveredUntilSec: 5.9 }), []);
});
test('windows: analysis covering only part of the video never extends past the covered part', () => {
  assert.deepEqual(find({ durationSec: 300, textStamps: [50], coveredUntilSec: 180 }), [W(0, 48), W(52, 180)]);
  assert.deepEqual(find({ durationSec: 100, textStamps: [], coveredUntilSec: 500 }), [W(0, 100)]);
  assert.deepEqual(find({ durationSec: 100, textStamps: [] }), [W(0, 100)]);
  assert.deepEqual(find({ durationSec: 300, textStamps: [190], coveredUntilSec: 180 }), [W(0, 180)]);
});
test('windows: unsorted, duplicate and non-numeric stamps are tolerated; bad duration gives nothing', () => {
  assert.deepEqual(find({ durationSec: 60, textStamps: [30, 30, 'x', NaN, null], coveredUntilSec: 60 }), [W(0, 28), W(32, 60)]);
  assert.deepEqual(find({ durationSec: 60, textStamps: [40, 10], coveredUntilSec: 60 }), [W(0, 8), W(12, 38), W(42, 60)]);
  assert.deepEqual(find({ durationSec: NaN, textStamps: [] }), []);
  assert.deepEqual(find({ durationSec: 0, textStamps: [] }), []);
});

test('parseStamps: reads [12s] prefixes, ignores lines without one', () => {
  assert.deepEqual(parseStamps('[0s] Beyond\n[2s] x\n[2s] y\nno stamp\n[156s] END'), [0, 2, 156]);
  assert.deepEqual(parseStamps(''), []);
});

// ---------- strict parsing ----------
test('parseVerdict: clean JSON', () => {
  const v = parseVerdict('{"text": false, "person": true, "subject": "Elephant herd"}');
  assert.deepEqual({ text: v.text, person: v.person, label: v.label }, { text: false, person: true, label: 'elephant herd' });
});
test('parseVerdict: garbage gives null everywhere', () => {
  for (const g of ['', 'I cannot help', '{not json', '[]', '42', null, undefined, '{"text": ']) {
    const v = parseVerdict(g);
    assert.deepEqual({ text: v.text, person: v.person, label: v.label }, { text: null, person: null, label: null }, String(g));
  }
});
test('parseVerdict: prose around the JSON is tolerated, a code fence too', () => {
  const v = parseVerdict('Sure! Here it is:\n```json\n{"text": true, "person": false, "subject": "beach"}\n```\nHope that helps.');
  assert.equal(v.text, true); assert.equal(v.person, false); assert.equal(v.label, 'beach');
});
test('parseVerdict: wrong types become null per field, never a guess', () => {
  const v = parseVerdict('{"text": "yes", "person": 0, "subject": 7}');
  assert.deepEqual({ text: v.text, person: v.person, label: v.label }, { text: null, person: null, label: null });
  const w = parseVerdict('{"text": false, "person": "false", "subject": ""}');
  assert.deepEqual({ text: w.text, person: w.person, label: w.label }, { text: false, person: null, label: null });
  assert.equal(parseVerdict('{"text": false, "person": false}').label, null);
});
test('parseVerdict: raw is kept', () => {
  assert.equal(parseVerdict('zzz').raw, 'zzz');
});
test('checkFrame: passes the path and a prompt to ask; an ask that throws gives all null, not a crash', async () => {
  let seen;
  const ok = await checkFrame('/x/001.jpg', { ask: async (p, prompt) => { seen = [p, prompt]; return '{"text": false, "person": false, "subject": "landscape"}'; } });
  assert.equal(seen[0], '/x/001.jpg'); assert.match(seen[1], /JSON/);
  assert.equal(ok.text, false);
  const bad = await checkFrame('/x/001.jpg', { ask: async () => { throw new Error('down'); } });
  assert.deepEqual({ text: bad.text, person: bad.person, label: bad.label }, { text: null, person: null, label: null });
});
test('checkFrame: a guard refusal is NOT swallowed (it must stop the run)', async () => {
  const e = Object.assign(new Error('cap'), { guard: true });
  await assert.rejects(checkFrame('/x/001.jpg', { ask: async () => { throw e; } }), /cap/);
});

// ---------- judging ----------
const F = (text, person, label = 'beach') => ({ text, person, label });
test('judgeWindow: all clear with 2 frames is clear', () => {
  const j = judgeWindow(W(0, 10), [F(false, false), F(false, false)]);
  assert.equal(j.verdict, 'clear'); assert.deepEqual(j.reasons, []); assert.equal(j.frames, 2);
});
test('judgeWindow: a single frame is never enough', () => {
  const j = judgeWindow(W(0, 10), [F(false, false)]);
  assert.equal(j.verdict, 'not-clear'); assert.match(j.reasons.join(' '), /fewer than 2/);
  assert.equal(judgeWindow(W(0, 10), []).verdict, 'not-clear');
});
test('judgeWindow: one null counts as not clear, with the reason', () => {
  const j = judgeWindow(W(0, 10), [F(false, false), F(false, false), F(null, false)]);
  assert.equal(j.verdict, 'not-clear'); assert.match(j.reasons.join(' '), /text.*unknown|unknown.*text/);
  const k = judgeWindow(W(0, 10), [F(false, false), F(false, null)]);
  assert.equal(k.verdict, 'not-clear'); assert.match(k.reasons.join(' '), /person.*unknown|unknown.*person/);
});
test('judgeWindow: one true makes it not clear, with the reason', () => {
  const t = judgeWindow(W(0, 10), [F(false, false), F(true, false)]);
  assert.equal(t.verdict, 'not-clear'); assert.match(t.reasons.join(' '), /text seen/);
  const p = judgeWindow(W(0, 10), [F(false, true), F(false, false)]);
  assert.equal(p.verdict, 'not-clear'); assert.match(p.reasons.join(' '), /person seen/);
});
test('judgeWindow: label is the most common non-null label', () => {
  const j = judgeWindow(W(0, 10), [F(false, false, 'beach'), F(false, false, 'boat'), F(false, false, 'beach'), F(false, false, null)]);
  assert.equal(j.label, 'beach');
  assert.equal(judgeWindow(W(0, 10), [F(false, false, null), F(false, false, null)]).label, null);
});

test('windowFrameSeconds: multiples of the interval inside the window, evenly thinned to the cap, ends kept', () => {
  assert.deepEqual(windowFrameSeconds(W(0, 10), 2, 99), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(windowFrameSeconds(W(3, 9), 2, 99), [4, 6, 8]);
  const s = windowFrameSeconds(W(0, 100), 2, 5);
  assert.equal(s.length, 5); assert.equal(s[0], 0); assert.equal(s[4], 100);
});

// ---------- the model call: one guarded caller (local-model.js); its guard tests live in local-model.test.js ----------
const askDeps = (dir, o = {}) => ({
  run: { calls: 0 }, counterFile: path.join(dir, 'c.json'), stopOpts: { flagPath: path.join(dir, 'stop'), fleetPath: path.join(dir, 'fleet') },
  now: () => new Date('2026-11-17T10:00:00Z'), ...o,
});
test('makeLocalAsk: posts through askLocal to the local chat endpoint with the image, temperature 0, no stream, short keep_alive, a timeout signal', async () => {
  const dir = tmp(); const img = path.join(dir, 'a.jpg'); fs.writeFileSync(img, 'abc');
  let req;
  const ask = makeLocalAsk({ askDeps: askDeps(dir, { fetchImpl: async (url, o) => { req = { url, o }; return { ok: true, status: 200, json: async () => ({ message: { content: '{"text":false}' } }) }; } }) });
  assert.equal(await ask(img, 'Q?'), '{"text":false}');
  assert.equal(req.url, 'http://127.0.0.1:11434/api/chat');
  const b = JSON.parse(req.o.body);
  assert.equal(b.model, 'qwen2.5vl:3b'); assert.equal(b.stream, false); assert.equal(b.keep_alive, '2m'); assert.equal(b.format, 'json');
  assert.equal(b.options.temperature, 0); assert.deepEqual(b.messages[0].images, [Buffer.from('abc').toString('base64')]); assert.equal(b.messages[0].content, 'Q?');
  assert.ok(req.o.signal); assert.equal(req.o.redirect, 'error');
});
test('makeLocalAsk: one shared counter file with the text caller (reserved before the call, same shape), the per-run cap holds', async () => {
  const dir = tmp(); const img = path.join(dir, 'a.jpg'); fs.writeFileSync(img, 'abc'); let sent = 0;
  const d = askDeps(dir, { maxCalls: 2, fetchImpl: async () => { sent += 1; return { ok: true, status: 200, json: async () => ({ message: { content: '{}' } }) }; } });
  const ask = makeLocalAsk({ askDeps: d });
  await ask(img, 'Q'); await ask(img, 'Q');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'c.json'), 'utf8')), { day: '2026-11-17', count: 2 });
  await assert.rejects(ask(img, 'Q'), (e) => e.guard === true && /per-run cap/.test(e.message)); assert.equal(sent, 2); assert.equal(ask.run.calls, 2);
});
test('makeLocalAsk: a host elsewhere, a stop flag or an unreadable counter refuse BEFORE any request (guard=true); an HTTP error is a plain error', async () => {
  const dir = tmp(); const img = path.join(dir, 'a.jpg'); fs.writeFileSync(img, 'abc'); let sent = 0;
  const fetchImpl = async () => { sent += 1; return { ok: true, status: 200, json: async () => ({ message: { content: '{}' } }) }; };
  await assert.rejects(makeLocalAsk({ askDeps: askDeps(dir, { fetchImpl, baseUrl: 'https://api.example.com' }) })(img, 'Q'), (e) => e.guard === true && /refus/i.test(e.message));
  fs.writeFileSync(path.join(dir, 'stop'), '');
  await assert.rejects(makeLocalAsk({ askDeps: askDeps(dir, { fetchImpl }) })(img, 'Q'), (e) => e.guard === true);
  fs.unlinkSync(path.join(dir, 'stop')); fs.writeFileSync(path.join(dir, 'c.json'), 'not json');
  await assert.rejects(makeLocalAsk({ askDeps: askDeps(dir, { fetchImpl }) })(img, 'Q'), (e) => e.guard === true && /counter/.test(e.message));
  assert.equal(sent, 0);
  fs.unlinkSync(path.join(dir, 'c.json'));
  await assert.rejects(makeLocalAsk({ askDeps: askDeps(dir, { fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) }) })(img, 'Q'), (e) => !e.guard && /500/.test(e.message));
});
test('media-segments.js has no guard, counter or request code of its own', () => {
  const src = fs.readFileSync(new URL('./media-segments.js', import.meta.url), 'utf8');
  for (const gone of ['export function guardCall', 'export function assertLocalOllama', 'export class GuardError', 'fetchImpl(', 'fetch(', 'counterFile)', 'readFileSync(cfg']) assert.ok(!src.includes(gone), gone);
  assert.ok(/from '\.\/local-model\.js'/.test(src));
});

// ---------- catalogue write ----------
const entry = (id, extra = {}) => ({ id, folder: 'africa', durationSec: 100, flags: { otherPublisherMark: null, overlayText: true, personRecognisable: null, region: 'east-africa' }, rights: { basis: 'b', document: null }, ...extra });
test('applySegments: sets segments and hasClearSegment, keeps hand-set flags and other videos untouched', () => {
  const cat = { version: 1, entries: [
    entry('AAA', { flags: { otherPublisherMark: false, overlayText: true, personRecognisable: false, region: 'east-africa' }, note: 'hand' }),
    entry('BBB', { segments: [{ startSec: 1, endSec: 9, verdict: 'clear' }], hasClearSegment: true }),
  ] };
  const seg = [{ startSec: 0, endSec: 10, frames: 3, verdict: 'clear', reasons: [], label: 'beach', checkedAt: 'x', model: 'm' }];
  const out = applySegments(cat, { AAA: seg });
  const a = out.entries.find((e) => e.id === 'AAA'); const b = out.entries.find((e) => e.id === 'BBB');
  assert.deepEqual(a.segments, seg); assert.equal(a.hasClearSegment, true);
  assert.equal(a.flags.personRecognisable, false); assert.equal(a.flags.otherPublisherMark, false); assert.equal(a.flags.overlayText, true);
  assert.equal(a.note, 'hand');
  assert.deepEqual(b.segments, [{ startSec: 1, endSec: 9, verdict: 'clear' }]); assert.equal(b.hasClearSegment, true);
  assert.deepEqual(cat.entries[0].segments, undefined, 'input not mutated');
});
test('applySegments: no clear window gives hasClearSegment false; empty list is a recorded "none found"', () => {
  const out = applySegments({ entries: [entry('AAA')] }, { AAA: [{ startSec: 0, endSec: 8, verdict: 'not-clear' }] });
  assert.equal(out.entries[0].hasClearSegment, false);
  assert.equal(applySegments({ entries: [entry('AAA')] }, { AAA: [] }).entries[0].hasClearSegment, false);
});

// ---------- per-video processing and the command ----------
function tree({ id = 'AAA', stamps = '', frames = 20, folder = 'africa', duration = 40, catalogExtra = {}, other = [] } = {}) {
  const root = tmp(); const home = tmp();
  fs.mkdirSync(path.join(root, 'analysis', folder, 'frames', id), { recursive: true });
  for (let i = 1; i <= frames; i += 1) fs.writeFileSync(path.join(root, 'analysis', folder, 'frames', id, `${String(i).padStart(3, '0')}.jpg`), 'x');
  if (stamps !== null) fs.writeFileSync(path.join(root, 'analysis', folder, `${id}.onscreen.txt`), stamps);
  const catPath = path.join(home, 'cat.json');
  fs.writeFileSync(catPath, JSON.stringify({ version: 1, entries: [entry(id, { folder, durationSec: duration, ...catalogExtra }), ...other] }));
  const env = { BPA_MEDIA_ROOT: root, BPA_MEDIA_CATALOG: catPath, BPA_SEGMENTS_COUNTER: path.join(home, 'counter.json'), BPA_STOP_FLAG: path.join(home, 'stop'), STOP_ALL_FLAG_PATH: path.join(home, 'fleet'), HOME: home };
  return { root, home, catPath, env };
}
const fakeFetch = (fn) => async (_u, o) => {
  const b = JSON.parse(o.body); const img = b.messages[0].images[0];
  return { ok: true, status: 200, json: async () => ({ message: { content: fn(img, b) } }) };
};
const clearJson = '{"text": false, "person": false, "subject": "beach"}';
const io = () => { const out = []; const err = []; return { out, err, log: (s) => out.push(s), error: (s) => err.push(s) }; };

test('processVideo: finds windows from stamps and judges them with the injected ask', async () => {
  const t = tree({ stamps: '[10s] hello\n', frames: 20, duration: 40 });
  const entryRec = JSON.parse(fs.readFileSync(t.catPath, 'utf8')).entries[0];
  const asked = [];
  const r = await processVideo({ entry: entryRec, root: t.root, ask: async (p) => { asked.push(p); return clearJson; }, maxFramesPerWindow: 50, now: () => new Date('2026-11-17T10:00:00Z') });
  // frames 20 at 2 s => covered 40 s, text at 10 s => windows [0,8] and [12,40]
  assert.deepEqual(r.segments.map((s) => [s.startSec, s.endSec, s.verdict]), [[0, 8, 'clear'], [12, 40, 'clear']]);
  assert.equal(r.segments[0].frames, 5); assert.equal(r.segments[0].model, 'qwen2.5vl:3b'); assert.equal(r.segments[0].label, 'beach');
  assert.equal(r.calls, asked.length);
});
test('processVideo: a person in one frame makes that window not clear', async () => {
  const t = tree({ stamps: '', frames: 10, duration: 20 });
  const entryRec = JSON.parse(fs.readFileSync(t.catPath, 'utf8')).entries[0];
  let n = 0;
  const r = await processVideo({ entry: entryRec, root: t.root, ask: async () => { n += 1; return n === 3 ? '{"text": false, "person": true, "subject": "people"}' : clearJson; }, maxFramesPerWindow: 50 });
  assert.equal(r.segments[0].verdict, 'not-clear'); assert.match(r.segments[0].reasons.join(' '), /person seen/);
});
test('processVideo: no on-screen file means unknown text, so the video is skipped (never treated as text-free)', async () => {
  const t = tree({ stamps: null, frames: 10, duration: 20 });
  const entryRec = JSON.parse(fs.readFileSync(t.catPath, 'utf8')).entries[0];
  const r = await processVideo({ entry: entryRec, root: t.root, ask: async () => { throw new Error('must not ask'); } });
  assert.equal(r.skipped, 'no on-screen text file'); assert.equal(r.segments, null);
});
test('processVideo: no frames means skipped', async () => {
  const t = tree({ stamps: '', frames: 0, duration: 20 });
  const entryRec = JSON.parse(fs.readFileSync(t.catPath, 'utf8')).entries[0];
  const r = await processVideo({ entry: entryRec, root: t.root, ask: async () => clearJson });
  assert.match(r.skipped, /no frames/);
});

test('main --run: writes segments atomically (0600), keeps hand-set flags, skips other regions and publisher-marked videos', async () => {
  const other = [
    entry('MARK', { flags: { otherPublisherMark: true, overlayText: true, personRecognisable: null, region: 'east-africa' } }),
    entry('ASIA', { flags: { otherPublisherMark: null, overlayText: true, personRecognisable: null, region: 'asia' } }),
  ];
  const t = tree({ stamps: '[10s] x', frames: 20, duration: 40, other, catalogExtra: { flags: { otherPublisherMark: false, overlayText: true, personRecognisable: false, region: 'east-africa' } } });
  const { out, err, log, error } = io();
  const code = await main(['--run', '--region', 'east-africa'], t.env, { fetchImpl: fakeFetch(() => clearJson), log, error, now: () => new Date('2026-11-17T10:00:00Z') });
  assert.equal(code, 0, err.join('\n'));
  const cat = JSON.parse(fs.readFileSync(t.catPath, 'utf8'));
  const a = cat.entries.find((e) => e.id === 'AAA');
  assert.equal(a.hasClearSegment, true); assert.equal(a.segments.length, 2);
  assert.equal(a.flags.personRecognisable, false); assert.equal(a.flags.otherPublisherMark, false);
  assert.equal(cat.entries.find((e) => e.id === 'MARK').segments, undefined);
  assert.equal(cat.entries.find((e) => e.id === 'ASIA').segments, undefined);
  assert.equal(fs.statSync(t.catPath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(t.home).filter((f) => f.endsWith('.tmp')), []);
});
test('main --run: --max-calls stops the run, the cut-off video is not written half done', async () => {
  const t = tree({ stamps: '', frames: 20, duration: 40 });
  const { err, log, error } = io();
  const code = await main(['--run', '--region', 'east-africa', '--max-calls', '3'], t.env, { fetchImpl: fakeFetch(() => clearJson), log, error });
  assert.notEqual(code, 0); assert.match(err.join('\n'), /per-run cap/);
  assert.equal(JSON.parse(fs.readFileSync(t.catPath, 'utf8')).entries[0].segments, undefined);
});
test('main --run: the stop flag refuses the whole run', async () => {
  const t = tree({ stamps: '', frames: 20, duration: 40 });
  fs.writeFileSync(t.env.BPA_STOP_FLAG, '');
  const { err, log, error } = io();
  const code = await main(['--run'], t.env, { fetchImpl: fakeFetch(() => clearJson), log, error });
  assert.notEqual(code, 0); assert.match(err.join('\n'), /stopped by flag/);
});
test('main --run: refuses a catalogue path inside the repository', async () => {
  const t = tree({ stamps: '', frames: 4, duration: 8 });
  const inside = path.join(path.dirname(new URL(import.meta.url).pathname), 'zz-test-catalog.json');
  const { err, log, error } = io();
  const code = await main(['--run'], { ...t.env, BPA_MEDIA_CATALOG: inside }, { fetchImpl: fakeFetch(() => clearJson), log, error });
  assert.notEqual(code, 0); assert.equal(fs.existsSync(inside), false);
});
test('main --summary: counts only, by id', async () => {
  const t = tree({ stamps: '', frames: 20, duration: 40 });
  const { out, log, error } = io();
  await main(['--run'], t.env, { fetchImpl: fakeFetch(() => clearJson), log: () => {}, error });
  const code = await main(['--summary'], t.env, { log, error });
  assert.equal(code, 0); assert.match(out.join('\n'), /AAA/); assert.match(out.join('\n'), /clear/);
});
test('main: unknown argument is a usage error', async () => {
  const { err, log, error } = io();
  assert.equal(await main(['--nope'], {}, { log, error }), 2);
  assert.match(err.join('\n'), /usage/);
});

test('selftest: reports the numbers and writes the spot-check list without describing anyone', async () => {
  const t = tree({ stamps: '[10s] hello\n[20s] world\n', frames: 25, duration: 50 });
  const spot = path.join(t.home, 'spot.txt');
  const { out, log, error } = io();
  // text reading at 10s => frame 006 (and 011 at 20s): the fake model says text only for those two files
  let call = 0;
  const code = await main(['--selftest', '--spotcheck', spot], t.env, {
    fetchImpl: fakeFetch(() => { call += 1; return call % 2 ? '{"text": true, "person": false, "subject": "x"}' : '{"text": false, "person": true, "subject": "y"}'; }), log, error,
  });
  assert.equal(code, 0);
  const text = out.join('\n');
  assert.match(text, /known-text frames: \d+/); assert.match(text, /called text: true: \d+/); assert.match(text, /unparsable: \d+/); assert.match(text, /mean seconds per call/);
  const lines = fs.readFileSync(spot, 'utf8').trim().split('\n');
  assert.ok(lines.length > 0 && lines.every((l) => /^\/.+\.jpg\t(person:false|person:true)$/.test(l)), lines.join('|'));
});
test('selftest: nothing to test is reported, not invented', async () => {
  const t = tree({ stamps: null, frames: 3, duration: 6 });
  const { out, log, error } = io();
  const code = await main(['--selftest'], t.env, { fetchImpl: fakeFetch(() => clearJson), log, error });
  assert.equal(code, 0); assert.match(out.join('\n'), /known-text frames: 0/);
});

// ---------- later parts of a long video ----------
function addPart(t, { id = 'AAA', folder = 'africa', offset, frames, stamps = '' }) {
  const d = path.join(t.root, 'analysis', folder, 'parts', String(offset));
  fs.mkdirSync(path.join(d, 'frames', id), { recursive: true });
  for (let i = 1; i <= frames; i += 1) fs.writeFileSync(path.join(d, 'frames', id, `${String(i).padStart(3, '0')}.jpg`), `p${offset}-${i}`);
  if (stamps !== null) fs.writeFileSync(path.join(d, `${id}.onscreen.txt`), stamps);
}
const recEntry = (t) => JSON.parse(fs.readFileSync(t.catPath, 'utf8')).entries[0];

test('parts: stamps and frames of a later part are moved onto the original timeline (offset from the folder name)', () => {
  const t = tree({ stamps: '[10s] a', frames: 90, duration: 300 });
  addPart(t, { offset: 180, frames: 60, stamps: '[20s] later caption' });
  const c = loadCoverage(t.root, recEntry(t), 2);
  assert.equal(c.covered, 300);
  assert.ok(c.stamps.includes(10) && c.stamps.includes(200));
  assert.match(fs.readFileSync(c.frameFor(200), 'utf8'), /^p180-11$/); // (200-180)/2 + 1
  assert.match(c.frameFor(178), /frames\/AAA\/090\.jpg$/);
  assert.match(fs.readFileSync(c.frameFor(180), 'utf8'), /^p180-1$/);
  assert.equal(c.frameFor(301), null);
});
test('parts: a clean stretch runs across a boundary only when both sides were sampled (contiguous parts)', () => {
  const t = tree({ stamps: '', frames: 90, duration: 300 });
  addPart(t, { offset: 180, frames: 60, stamps: '' });
  const c = loadCoverage(t.root, recEntry(t), 2);
  // the boundary itself is a reading, so the stretch is split by one interval each side, never spanning blind
  const w = findCleanWindows({ durationSec: 300, textStamps: c.stamps, sampleIntervalSec: 2, coveredUntilSec: c.covered });
  assert.deepEqual(w, [W(0, 178), W(182, 300)]);
});
test('parts: a gap (previous part short of the offset) ends the coverage there, nothing beyond is claimed', () => {
  const t = tree({ stamps: '', frames: 80, duration: 400 }); // covers 0..160 only
  addPart(t, { offset: 180, frames: 60, stamps: '' });
  const c = loadCoverage(t.root, recEntry(t), 2);
  assert.equal(c.covered, 160); assert.equal(c.parts.length, 1);
});
test('parts: a later part with no stamp file (text unknown) or no frames is not used', () => {
  const a = tree({ stamps: '', frames: 90, duration: 400 });
  addPart(a, { offset: 180, frames: 60, stamps: null });
  assert.equal(loadCoverage(a.root, recEntry(a), 2).covered, 180);
  const b = tree({ stamps: '', frames: 90, duration: 400 });
  addPart(b, { offset: 180, frames: 0, stamps: '' });
  assert.equal(loadCoverage(b.root, recEntry(b), 2).covered, 180);
});
test('parts: a caption still on screen across the boundary is not trusted as clear in the first seconds of the later part', () => {
  const t = tree({ stamps: '[170s] big caption', frames: 90, duration: 300 });
  addPart(t, { offset: 180, frames: 60, stamps: '' }); // the later cut carried its de-duplication: no stamp at its start
  const c = loadCoverage(t.root, recEntry(t), 2);
  const w = findCleanWindows({ durationSec: 300, textStamps: c.stamps, sampleIntervalSec: 2, coveredUntilSec: c.covered });
  assert.ok(w.every((x) => x.endSec <= 178 || x.startSec >= 182), JSON.stringify(w));
});
test('subtractRanges: only the parts outside the taken ranges, short pieces dropped', () => {
  assert.deepEqual(subtractRanges(W(162, 190), [W(162, 180)]), [W(180, 190)]);
  assert.deepEqual(subtractRanges(W(162, 184), [W(162, 180)]), []);
  assert.deepEqual(subtractRanges(W(0, 100), [W(20, 30), W(50, 90)]), [W(0, 20), W(30, 50), W(90, 100)].filter((x) => x.endSec - x.startSec >= 6));
});
test('processVideo: existing segments (and their later review) are kept untouched and not asked about again; new windows come from the later part', async () => {
  const old = { startSec: 0, endSec: 100, frames: 8, verdict: 'not-clear', reasons: ['x'], label: 'animal', checkedAt: 'c', model: 'm', secondLook: { verdict: 'fails', usable: null } };
  const t = tree({ stamps: '', frames: 90, duration: 300, catalogExtra: { segments: [old] } });
  addPart(t, { offset: 180, frames: 60, stamps: '[40s] x' });
  const asked = [];
  const r = await processVideo({ entry: recEntry(t), root: t.root, ask: async (p) => { asked.push(p); return clearJson; }, maxFramesPerWindow: 50 });
  assert.deepEqual(r.segments[0], old);
  assert.deepEqual(r.segments.slice(1).map((s) => [s.startSec, s.endSec]), [[100, 178], [182, 218], [222, 300]]);
  assert.ok(asked.some((p) => p.includes(`${path.sep}parts${path.sep}180${path.sep}`)));
  assert.equal(r.segments.every((s) => s.startSec >= 0), true);
});
test('processVideo: a video with no parts behaves as before (covered only by the first cut)', async () => {
  const t = tree({ stamps: '', frames: 90, duration: 300 });
  const r = await processVideo({ entry: recEntry(t), root: t.root, ask: async () => clearJson, maxFramesPerWindow: 50 });
  assert.deepEqual(r.segments.map((s) => [s.startSec, s.endSec]), [[0, 180]]);
});
