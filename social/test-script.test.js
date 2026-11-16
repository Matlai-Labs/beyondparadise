import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const script = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts.test;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js'));

/** Which test files would `npm test` run? A `*.test.js` glob runs all of them; otherwise only the names written in the script. */
function filesRun(cmd) { return /(^|\s)\*\.test\.js(\s|$)/.test(cmd) ? files : files.filter((f) => new RegExp(`(^|\\s)${f.replace(/\./g, '\\.')}(\\s|$)`).test(cmd)); }

test('`npm test` runs every *.test.js in the folder (no hand-kept list that can silently omit a file)', () => {
  assert.match(script, /^node --test /); assert.ok(files.length >= 14);
  const missed = files.filter((f) => !filesRun(script).includes(f));
  assert.deepEqual(missed, [], `these test files exist but the test script would not run them: ${missed.join(', ')}`);
});
test('the checker itself notices an omission (a script listing all but one file is flagged)', () => {
  const partial = `node --test ${files.filter((f) => f !== 'youtube-channel-edit-decisions.test.js').join(' ')}`;
  assert.deepEqual(files.filter((f) => !filesRun(partial).includes(f)), ['youtube-channel-edit-decisions.test.js']);
});
