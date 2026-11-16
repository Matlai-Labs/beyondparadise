import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { log, LOG_PATH, DEFAULT_LOG_PATH } from './lib.js';

const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

test('the default log is the real one under the home folder', () => {
  assert.equal(DEFAULT_LOG_PATH, path.join(os.homedir(), 'Library', 'Logs', 'beyondparadise', 'social.log'));
});
test('under the test setup, log() writes to a temporary file and never changes the size of the real log', () => {
  const before = sizeOf(DEFAULT_LOG_PATH);
  assert.notEqual(LOG_PATH, DEFAULT_LOG_PATH, 'LOG_PATH must be redirected by BPA_LOG_PATH in tests');
  assert.ok(LOG_PATH.startsWith(os.tmpdir()) || LOG_PATH.startsWith(fs.realpathSync(os.tmpdir())), 'test log must live under the temp dir');
  process.env.BPA_QUIET = '1';
  log('log-isolation probe line');
  assert.equal(sizeOf(DEFAULT_LOG_PATH), before, 'the real log changed during a test');
  assert.match(fs.readFileSync(LOG_PATH, 'utf8'), /log-isolation probe line/);
});
test('every test file loads test-env.js as its first import (so no test can reach the real log or the real flag/ledger/state)', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js'));
  assert.ok(files.length >= 14, 'expected to find the test files');
  for (const f of files) {
    const firstImport = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').find((l) => /^\s*import\b/.test(l));
    assert.match(firstImport || '', /^\s*import\s+['"]\.\/test-env\.js['"]/, `${f}: first import must be './test-env.js'`);
  }
});
