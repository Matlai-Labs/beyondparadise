import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, ''); // line comments only, like review-step2-guards.test.js
const nonTest = () => fs.readdirSync(HERE).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).map((f) => [f, strip(fs.readFileSync(path.join(HERE, f), 'utf8'))]);
const tests = () => fs.readdirSync(HERE).filter((f) => f.endsWith('.test.js')).map((f) => [f, fs.readFileSync(path.join(HERE, f), 'utf8')]);
const countIn = (files, re) => Object.fromEntries(files.map(([f, s]) => [f, (s.match(re) || []).length]).filter(([, n]) => n > 0));
const src = (f) => nonTest().find(([n]) => n === f)[1];

test('(0) approveSwitchOn( is called exactly twice, both in review-routes.js (the items input and the approveOn of createDefaultActions), never from draft-decisions.js', () => {
  const n = countIn(nonTest(), /approveSwitchOn\(/g); n['approve-switch.js'] -= 1; if (!n['approve-switch.js']) delete n['approve-switch.js'];
  assert.deepEqual(n, { 'review-routes.js': 2 });
});
test('(a) the publishers are named only where they are expected', () => {
  assert.deepEqual(countIn(nonTest(), /\bschedulePost\b/g), { 'lib.js': 1, 'approval-server.js': 2, 'review-routes.js': 2 });
  assert.deepEqual(countIn(nonTest(), /\bpublishNow\b/g), { 'lib.js': 1, 'approval-server.js': 2 });
  assert.deepEqual(countIn(nonTest(), /\bigPostDraftAny\b/g), { 'lib.js': 1, 'approval-server.js': 2, 'worker.js': 2 });
});
test('(b) the default actions: one creation, one explicit hand-over, no default in the handler, only the real-wiring test mentions them', () => {
  assert.deepEqual(countIn(nonTest(), /(?<!function )createDefaultActions\(/g), { 'review-routes.js': 1 });
  const d = countIn(nonTest(), /\bdefaultActions\b/g); assert.deepEqual(Object.keys(d).sort(), ['approval-server.js', 'review-routes.js']); assert.equal(d['approval-server.js'], 2, 'the import and the one loadActions: defaultActions');
  const rr = src('review-routes.js'); assert.ok(!/loadActions\s*=\s*defaultActions/.test(rr), 'no default for loadActions'); assert.match(rr, /loadActions = \(\) => \{ throw new Error\('no actions configured'\); \}/);
  assert.deepEqual(countIn(nonTest(), /(?<!function )createReviewHandler\(/g), { 'approval-server.js': 1 }); assert.match(src('approval-server.js'), /createReviewHandler\(\{[^}]*loadActions: defaultActions/);
  const t = tests().filter(([f, s]) => /\b(defaultActions|createDefaultActions)\b/.test(s) && f !== 'review-step3-guards.test.js').map(([f]) => f); assert.deepEqual(t, ['review-real-wiring.test.js']);
});
test('(c) the only schedule: line of review-routes.js is in createDefaultActions', () => {
  const rr = src('review-routes.js'); const lines = rr.split('\n').filter((l) => /\bschedule:/.test(l)); assert.equal(lines.length, 1);
  const at = rr.indexOf(lines[0]); assert.ok(at > rr.indexOf('export function createDefaultActions') && at < rr.indexOf('let DEFAULT_ACTIONS'));
});
test('(d) the draft modules name no publisher, no auto-publish switch and no config file', () => {
  for (const f of ['draft-decisions.js', 'draft-actions.js', 'approve-switch.js']) for (const w of ['schedulePost', 'publishNow', 'igPostDraftAny', 'createPost', 'autoPublish', 'config.json']) assert.ok(!src(f).includes(w), `${f} ${w}`);
});
test('(e) review-decide.js has no draft:undo', () => { assert.ok(!/draft:undo/.test(src('review-decide.js'))); });
test('(f) review-routes.js never passes the test-only finalCheck option into createDraftActions', () => {
  const rr = src('review-routes.js'); const lines = rr.split('\n'); const at = lines.findIndex((l) => l.includes('createDraftActions({')); assert.ok(at >= 0);
  let call = ''; for (let k = at; k < lines.length; k++) { call += lines[k]; if (/\}\),?\s*$/.test(lines[k])) break; } // the whole call, up to the line that closes it
  assert.ok(call.includes('neverPromotePatterns'), 'the call was read to its end'); assert.ok(!/\bfinalCheck\b/.test(call), 'no finalCheck option in the createDraftActions call');
});
