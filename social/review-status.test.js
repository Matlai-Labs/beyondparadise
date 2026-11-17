import './test-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStatus } from './review-status.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-rev-status-'));
let n = 0;
const put = (text) => { const f = path.join(dir, `f${n++}.json`); fs.writeFileSync(f, typeof text === 'string' ? text : JSON.stringify(text)); return f; };
const missing = () => path.join(dir, `none${n++}.json`);
const st = (over = {}) => readStatus({ configFile: put({}), runStatePath: missing(), lastPostPath: missing(), stop: () => ({ stopped: false, reason: null }), ...over });

test('autoPublish: true gives on', () => { assert.equal(st({ configFile: put({ autoPublish: true }) }).autoLane, 'on'); });
test('autoPublish absent gives off', () => { assert.equal(st({ configFile: put({ other: 1 }) }).autoLane, 'off'); });
test('autoPublish that is not the boolean true gives off', () => { for (const v of ['true', 1, null, false]) assert.equal(st({ configFile: put({ autoPublish: v }) }).autoLane, 'off', String(v)); });
test('missing config file gives unknown', () => { assert.equal(st({ configFile: missing() }).autoLane, 'unknown'); });
test('malformed config gives unknown', () => { assert.equal(st({ configFile: put('{nope') }).autoLane, 'unknown'); assert.equal(st({ configFile: put('[]') }).autoLane, 'unknown'); });
test('config is read fresh on every call', () => { const f = put({}); assert.equal(st({ configFile: f }).autoLane, 'off'); fs.writeFileSync(f, JSON.stringify({ autoPublish: true })); assert.equal(st({ configFile: f }).autoLane, 'on'); });
test('run file gives lastRun', () => { assert.deepEqual(st({ runStatePath: put({ lastRunAt: '2026-11-17T09:00:00Z', lastOkAt: null, result: 'ok' }) }).lastRun, { at: '2026-11-17T09:00:00Z', result: 'ok' }); });
test('missing run file gives lastRun unknown', () => { assert.equal(st().lastRun, 'unknown'); });
test('run file with a bad date gives unknown', () => { assert.equal(st({ runStatePath: put({ lastRunAt: 'not a date', result: 'ok' }) }).lastRun, 'unknown'); });
test('last post file gives lastPost; a bad date gives unknown', () => {
  assert.deepEqual(st({ lastPostPath: put({ at: '2026-11-12T10:00:00Z', id: 'B26' }) }).lastPost, { at: '2026-11-12T10:00:00Z', id: 'B26' });
  assert.equal(st({ lastPostPath: put({ at: 'not a date', id: 'x' }) }).lastPost, 'unknown'); assert.equal(st({ lastPostPath: put('{nope') }).lastPost, 'unknown', 'unreadable'); assert.equal(st().lastPost, 'none', 'no file: no post yet');
});
test('stop passes through; a throwing stop check gives unknown', () => {
  assert.deepEqual(st({ stop: () => ({ stopped: true, reason: 'r' }) }).stop, { stopped: true, reason: 'r' });
  assert.equal(st({ stop: () => { throw new Error('x'); } }).stop, 'unknown');
});
test('the status carries no path and never throws on odd input', () => { const s = st({ configFile: put('null'), runStatePath: put('{"lastRunAt":5}'), lastPostPath: put('7') }); assert.ok(!JSON.stringify(s).includes(dir)); assert.equal(s.autoLane, 'unknown'); });

test('stop with a valid time carries sinceText in words and still the raw reason; a bad time or no time adds nothing', () => {
  const r = st({ stop: () => ({ stopped: true, reason: 'stopped by flag since 2026-11-17T21:06:42.521Z', since: '2026-11-17T21:06:42.521Z', by: 'own' }) }).stop;
  assert.deepEqual(r, { stopped: true, reason: 'stopped by flag since 2026-11-17T21:06:42.521Z', since: '2026-11-17T21:06:42.521Z', sinceText: '18 Nov at 00:06 (East Africa time)', by: 'own' });
  const bad = st({ stop: () => ({ stopped: true, reason: 'r', since: 'garbage', by: 'other' }) }).stop; assert.deepEqual(bad, { stopped: true, reason: 'r' });
  assert.equal(st({ stop: () => ({ stopped: true, reason: 'r', by: 'fleet' }) }).stop.by, 'fleet');
});
