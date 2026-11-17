import './test-env.js';
// A: what a clip shows, recorded by a reviewer (clip-library.js --shows). Fixed vocabulary, refusals exit 2 and write nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, setShows, readManifest, SHOW_TAGS, ANIMAL_TAGS, SCENE_TAGS, manifestPath } from './clip-library.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-shows-'));
const entry = (id) => ({ id, file: `${id}.mp4`, durationSec: 7, source: [{ videoId: 'v', startSec: 1, endSec: 8 }], subject: 'x', checks: { rendered: 'ok' }, flash: { flash: false, atSec: [] }, verified: { verdict: 'pass', by: 't', at: '2026-11-16T00:00:00Z', notes: '', singleSubject: 'yes' } });
function lib() { const dir = tmp(); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(manifestPath(dir), JSON.stringify({ version: 1, clips: [entry('clip-a'), entry('clip-b')] })); return dir; }
const cli = (argv, dir) => { const out = []; const err = []; return main(argv, { HOME: tmp(), BPA_CLIP_LIBRARY: dir, BPA_STATE_DIR: path.join(tmp(), 'state') }, { log: (s) => out.push(s), error: (s) => err.push(s) }).then((code) => ({ code, out, err })); };

test('vocabulary: lowercase singular, the animal and scene tags the brief names, frozen', () => {
  for (const t of ['lion', 'elephant', 'buffalo', 'zebra', 'hippo', 'wildebeest', 'crocodile', 'bird', 'giraffe', 'cheetah', 'leopard', 'hyena', 'rhino', 'wild-dog']) assert.ok(ANIMAL_TAGS.includes(t), t);
  for (const t of ['savanna', 'wetland', 'river', 'river-crossing', 'volcano', 'landscape']) assert.ok(SCENE_TAGS.includes(t), t);
  assert.deepEqual([...SHOW_TAGS].sort(), [...ANIMAL_TAGS, ...SCENE_TAGS].sort()); assert.ok(SHOW_TAGS.every((t) => t === t.toLowerCase())); assert.ok(Object.isFrozen(SHOW_TAGS));
});
test('setShows records tags, by, at, notes; replaces an earlier record; does not change the input or other fields', () => {
  const m = { clips: [entry('clip-a'), entry('clip-b')] }; const before = JSON.stringify(m);
  const n = setShows(m, 'clip-a', { tags: ['lion', 'elephant', 'lion'], by: ' dense look ', at: '2026-11-17T10:00:00Z', notes: 'two animals' });
  assert.deepEqual(n.clips[0].shows, { tags: ['lion', 'elephant'], by: 'dense look', at: '2026-11-17T10:00:00Z', notes: 'two animals' });
  assert.equal(n.clips[1].shows, undefined); assert.equal(JSON.stringify(m), before); assert.deepEqual(n.clips[0].verified, m.clips[0].verified);
  assert.deepEqual(setShows(n, 'clip-a', { tags: ['zebra'], by: 'x' }).clips[0].shows.tags, ['zebra']);
});
test('setShows refuses an unknown tag, an empty list, a missing by, an unknown clip, and a note that describes a person', () => {
  const m = { clips: [entry('clip-a')] };
  assert.throws(() => setShows(m, 'clip-a', { tags: ['lion', 'unicorn'], by: 'x' }), /unknown tag/);
  assert.throws(() => setShows(m, 'clip-a', { tags: ['Lion'], by: 'x' }), /unknown tag/);
  assert.throws(() => setShows(m, 'clip-a', { tags: [], by: 'x' }), /at least one tag/);
  assert.throws(() => setShows(m, 'clip-a', { tags: 'lion', by: 'x' }), /at least one tag/);
  assert.throws(() => setShows(m, 'clip-a', { tags: ['lion'], by: '' }), /by/); assert.throws(() => setShows(m, 'clip-a', { tags: ['lion'] }), /by/);
  assert.throws(() => setShows(m, 'clip-nope', { tags: ['lion'], by: 'x' }), /unknown clip/);
  assert.throws(() => setShows(m, 'clip-a', { tags: ['lion'], by: 'x', notes: 'a man in a shirt' }), /describe/);
});
test('--shows: writes the manifest atomically, --summary prints the tags', async () => {
  const dir = lib(); const r = await cli(['--shows', 'clip-a', 'lion,elephant', '--by', 'dense look notes', '--notes', 'pride at dusk'], dir);
  assert.equal(r.code, 0, r.err.join('\n')); const c = readManifest(dir).clips[0]; assert.deepEqual(c.shows.tags, ['lion', 'elephant']); assert.equal(c.shows.by, 'dense look notes'); assert.equal(c.shows.notes, 'pride at dusk'); assert.ok(!Number.isNaN(Date.parse(c.shows.at)));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), []);
  const s = await cli(['--summary'], dir); assert.equal(s.code, 0); const txt = s.out.join('\n');
  assert.match(txt, /clip-a\b.*lion, elephant/); assert.match(txt, /clip-b\b.*no tags/);
});
test('--shows refusals exit 2 and write nothing: unknown tag, empty list, missing --by, missing arguments', async () => {
  const dir = lib(); const before = fs.readFileSync(manifestPath(dir), 'utf8');
  for (const argv of [['--shows', 'clip-a', 'lion,unicorn', '--by', 'x'], ['--shows', 'clip-a', '', '--by', 'x'], ['--shows', 'clip-a', ',', '--by', 'x'], ['--shows', 'clip-a', 'lion'], ['--shows', 'clip-a', 'lion', '--by', ''], ['--shows', 'clip-a']]) {
    const r = await cli(argv, dir); assert.equal(r.code, 2, JSON.stringify(argv)); assert.equal(fs.readFileSync(manifestPath(dir), 'utf8'), before, JSON.stringify(argv));
  }
  assert.equal((await cli(['--shows', 'clip-nope', 'lion', '--by', 'x'], dir)).code, 4, 'an unknown clip is 4, like --verdict');
});
