import './test-env.js';
// WIRING of the automatic lane, in the style of rules-gate-wired.test.js: source-level call-site counts plus behaviour with injected dependencies.
// The lane QUEUES an item; the existing worker path publishes it. These tests fail when a second publisher appears, when a guard is moved behind the
// network, or when the switch stops being the first thing the lane looks at.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { postReadyReel, readyFileOf, igPostDraftAny, autoDir } from './lib.js';
import { engageStop, releaseStop, StoppedError } from './stop.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
const count = (s, re) => (s.match(re) || []).length;
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, `marker not found: ${a}`); const j = b ? s.indexOf(b, i + a.length) : -1; return s.slice(i, j > i ? j : undefined); };
const before = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b); assert.ok(i >= 0, `not found: ${a}`); assert.ok(j >= 0, `not found: ${b}`); assert.ok(i < j, `${a} must come before ${b}`); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-aw-'));

// ── the lane's own order ───────────────────────────────────────────────────────────
test('ensureDailyAuto: the switch is the very first statement that decides anything; the day is recorded before the work', () => {
  const body = between(read('auto-lane.js'), 'export async function ensureDailyAuto', '/** After a SUCCESSFUL publish only');
  assert.equal(count(body, /autoPublish !== true\) return/g), 1);
  const first = body.indexOf('autoPublish !== true'); for (const later of ['stop()', 'reservationsOnDay(', 'igOn()', 'readState(', 'writeAtomic(statePath', 'await prepare(', 'withQueueLock(', 'loadPool', 'readManifest(']) assert.ok(first < body.indexOf(later), `switch check must precede ${later}`);
  before(body, 'stop()', 'writeAtomic(statePath'); before(body, 'reservationsOnDay(', 'writeAtomic(statePath'); before(body, 'writeAtomic(statePath', 'await prepare(');
});
test('the one queue push of auto-lane.js follows a successful prepareAutoPost, which ran the voice + rules final check on the exact text, then the judge checks, BEFORE any clip work', () => {
  const s = read('auto-lane.js'); assert.equal(count(s, /\.drafts\.push\(/g), 1);
  const ens = between(s, 'export async function ensureDailyAuto', '/** After a SUCCESSFUL publish only'); before(ens, 'await prepare(', 'if (!res.ok)'); before(ens, 'if (!res.ok)', 'drafts.push(');
  const ev = between(s, 'export async function evaluateIdea', 'export async function prepareAutoPost');
  assert.equal(count(ev, /await check\(draft/g), 1); before(ev, 'verbatim(idea', 'await check(draft'); before(ev, 'await check(draft', 'await judgeChecks('); assert.match(ev, /check = finalCheck/);
  const prep = between(s, 'export async function prepareAutoPost', 'export const defaultStatePath'); assert.equal(count(prep, /await evaluateIdea\(/g), 1); before(prep, 'eligibleClips(', 'laneVerdictFor('); before(prep, 'laneVerdictFor(', 'await evaluateIdea('); const gate = between(s, 'export function laneVerdictFor', '/** config.autoRequireApprovedHook'); assert.equal(count(gate, /pairingFor\(/g), 1); before(gate, 'inHistory(', 'pairingFor('); // the cheap gates (history, title, clip pairing) live in laneVerdictFor, which the review page shares; before(prep, 'await evaluateIdea(', 'await compose({'); // C2: the cheap pairing test comes BEFORE the text checks, the clip work after
});
test('auto-lane.js and fact-post.js never call a publisher, a scheduler, a hosting function or the model caller', () => {
  for (const f of ['auto-lane.js', 'fact-post.js', 'overlay.js']) { const s = read(f); assert.doesNotMatch(s, /\b(schedulePost|publishNow|igPostDraft\w*|igPublish\w*|publishIg|hostVideo|hostImage\w*|createPost|askLocal|localAsk)\b/, f); assert.doesNotMatch(s, /\bfetch\(/, f); }
});

// ── the worker: the lane is AFTER the existing work, behind the switch; publishing stays on the existing path ──
test('worker.js: ensureDailyAuto is called once, only behind `autoPublish === true`, after the final queue save, and the module is loaded lazily', () => {
  const body = between(read('worker.js'), 'async function runWorkerInner', 'const isMain');
  assert.equal(count(body, /ensureDailyAuto\(/g), 1); assert.equal(count(body, /import\('\.\/auto-lane\.js'\)/g), 2, 'ensureDailyAuto and afterAutoPublish, both dynamic');
  assert.equal(count(read('worker.js'), /^import .*auto-lane/gm), 0, 'no static import: with the switch absent the module is not even loaded');
  const at = body.indexOf('ensureDailyAuto('); assert.ok(body.lastIndexOf('autoPublish === true', at) > body.lastIndexOf('saveQueue(mergeQueue(', at), 'guarded, and after the final save');
  for (const earlier of ['await check(d', 'reserve({', 'claimIgPublish(', 'await publishIg(d)']) assert.ok(body.indexOf(earlier) < at, `${earlier} comes first`);
  assert.equal(count(body, /await publishIg\(/g), 1, 'still exactly one publisher call in the worker');
});
test('worker.js: an automatic item is held when the switch is off, BEFORE the stop re-check, the final check, the reservation, the claim and the publisher; the follow-up runs only after the publisher returned', () => {
  const body = between(read('worker.js'), 'async function runWorkerInner', 'const isMain');
  const hold = body.indexOf('d.auto === true && capConfig.autoPublish !== true'); assert.ok(hold > 0);
  for (const later of ['const st = stop()', 'await check(d', 'reserve({', 'claimIgPublish(', 'await publishIg(d)']) { const at = body.indexOf(later, hold); assert.ok(at > hold, `hold precedes ${later}`); }
  assert.ok(body.indexOf('const st = stop()', hold) < body.indexOf('await check(d', hold), 'and the existing order stop, final check, reserve, claim, publish is unchanged');
  before(body, 'await publishIg(d)', 'afterAutoPublish(d, r'); before(body, 'recordPost({ now, id: d.id, path: lastPostPath })', 'afterAutoPublish(d, r');
});
test('the set of files that call a publisher is unchanged: approval-server.js and worker.js only', () => {
  const callers = [];
  for (const f of fs.readdirSync(HERE).filter((x) => x.endsWith('.js') && !x.endsWith('.test.js') && x !== 'lib.js')) { const s = read(f); if (/\b(?:await\s+)?(?:schedulePost|publishNow|igPostDraftAny|publishIg|publish|schedule)\(/.test(s) && /\b(schedulePost|publishNow|igPostDraftAny|igPostDraft|igPublish\w*|createPost)\b/.test(s)) callers.push(f); }
  assert.deepEqual(callers.sort(), ['approval-server.js', 'worker.js']);
});

// ── lib.js: the ready-file branch sits behind the stop check and every guard runs before anything is uploaded ──
test('lib.js: igPostDraftAny checks the stop flag before the ready-file branch; postReadyReel runs its guards, then the render checks, then hosts, then publishes', () => {
  const lib = read('lib.js'); const any = between(lib, 'export async function igPostDraftAny', null);
  assert.equal(count(any, /postReadyReel\(/g), 1); before(any, 'assertNotStopped()', 'postReadyReel('); before(any, 'postReadyReel(', 'chooseFormat(d)');
  const body = between(lib, 'export async function postReadyReel', '/** Post a draft to Instagram');
  assert.equal(count(body, /await host\(/g), 1); assert.equal(count(body, /await publishReel\(/g), 1);
  before(body, 'readyFileOf(d, dir)', 'await verify(f)'); before(body, 'await verify(f)', 'await host('); before(body, 'await host(', 'await publishReel(');
  assert.equal(count(lib, /await hostVideo\(/g), 1, 'the old render path is the only direct hosting call; the ready path goes through the injectable `host`');
});
test('lib.js finalCheck: the automatic-item guard runs before the text loop and adds the rule id auto-text-changed', () => {
  const body = between(read('lib.js'), 'export async function finalCheck', 'export async function blockDraft');
  assert.equal(count(body, /autoTextIntact\(d\)/g), 1); before(body, 'autoTextIntact(d)', 'for (const t of await outgoingTexts(d))'); assert.match(body, /auto-text-changed/);
});

// ── the ready-file branch, by behaviour ──────────────────────────────────────────────
function ready(over = {}) {
  const dir = tmp(); const f = path.join(dir, 'auto-idea_1-clip-a.mp4'); fs.writeFileSync(f, 'mp4-bytes');
  const d = { id: 'B1', auto: true, text: 'T', sourceDate: '2026-11-17', readyFile: f, readyFileSha256: crypto.createHash('sha256').update('mp4-bytes').digest('hex'), ...over };
  const calls = []; const deps = { dir, verify: async () => { calls.push('verify'); }, host: async () => { calls.push('host'); return { id: 7, url: 'https://example.invalid/v.mp4' }; }, publishReel: async () => { calls.push('publish'); return { id: 'm', permalink: 'https://example.invalid/p' }; } };
  return { dir, d, calls, deps };
}
test('postReadyReel: guards, then verify, then host, then publish; the result carries the hosted url and the format', async () => {
  const r = ready(); const out = await postReadyReel(r.d, r.deps); assert.deepEqual(r.calls, ['verify', 'host', 'publish']); assert.deepEqual([out.format, out.lane, out.permalink, out.videoUrl], ['reel', 'auto', 'https://example.invalid/p', 'https://example.invalid/v.mp4']);
});
test('postReadyReel: every failed guard throws BEFORE anything is hosted or published (outside folder, wrong name, missing, changed bytes, missing hash, failed render check)', async () => {
  const cases = {
    'file outside the lane folder': (r) => ({ readyFile: path.join(os.tmpdir(), 'other.mp4') }), 'not an mp4': (r) => ({ readyFile: path.join(r.dir, 'x.txt') }),
    'path with ..': (r) => ({ readyFile: path.join(r.dir, '..', path.basename(r.dir), 'auto-idea_1-clip-a.mp4') + '/../auto-idea_1-clip-a.mp4x' }), 'no ready file': () => ({ readyFile: undefined }),
    'missing file': (r) => ({ readyFile: path.join(r.dir, 'gone.mp4') }), 'bytes changed': (r) => { fs.writeFileSync(r.d.readyFile, 'tampered'); return {}; }, 'no hash': () => ({ readyFileSha256: undefined }),
  };
  for (const [name, mut] of Object.entries(cases)) { const r = ready(); Object.assign(r.d, mut(r)); await assert.rejects(() => postReadyReel(r.d, r.deps), Error, name); assert.deepEqual(r.calls, [], name); }
  const r = ready(); r.deps.verify = async () => { r.calls.push('verify'); throw new Error('ready file failed the render checks: size'); }; await assert.rejects(() => postReadyReel(r.d, r.deps), /render checks/); assert.deepEqual(r.calls, ['verify']);
});
test('igPostDraftAny on an automatic item: a stop flag throws StoppedError first; with no flag and no ready file it throws and renders nothing (no text reel, no fallback)', async () => {
  const flag = process.env.BPA_STOP_FLAG; engageStop({ flagPath: flag });
  try { await assert.rejects(() => igPostDraftAny({ id: 'B1', auto: true, readyFile: '/x/y.mp4' }), StoppedError); } finally { releaseStop({ flagPath: flag }); }
  await assert.rejects(() => igPostDraftAny({ id: 'B1', auto: true, kind: 'auto', text: 'T' }), /no ready file/);
  assert.equal(autoDir({ BPA_STATE_DIR: '/s' }), path.join('/s', 'bpa-auto'));
});
test('readyFileOf accepts exactly the file the lane wrote', () => { const r = ready(); assert.equal(readyFileOf(r.d, r.dir), r.d.readyFile); });

// ── switch and docs ─────────────────────────────────────────────────────────────────
test('config.json does not carry autoPublish, autoKinds or autoSlotHourEAT (the switch stays absent = off); the README documents all three', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')); for (const k of ['autoPublish', 'autoKinds', 'autoSlotHourEAT']) assert.equal(k in cfg, false, k);
  const r = fs.readFileSync(path.join(HERE, 'README.md'), 'utf8');
  assert.match(r, /\|\s*`autoPublish`[^\n]*(absent|false)[^\n]*(not active|inactive|off)/i); assert.match(r, /\|\s*`autoKinds`[^\n]*rule/); assert.match(r, /\|\s*`autoSlotHourEAT`[^\n]*18/); assert.match(r, /## Automatic lane/);
});
