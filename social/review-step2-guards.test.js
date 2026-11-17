import './test-env.js';
// Static guards for step 2, in the style of auto-lane-wired.test.js: they fail when a guard is removed from one of several call sites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
const count = (s, re) => (s.match(re) || []).length;
const NEW_FILES = ['review-routes.js', 'review-decide.js', 'bpa-actions.js', 'clip-approvals.js', 'review-decisions.js', 'auto-hooks.js', 'review-auth.js'];

test('(1) one call site each of checkAction, runDecision, runPosting; checkAccess guards before handle; sessions.issue at ONE site, only in the page route', () => {
  const s = read('review-routes.js');
  assert.equal(count(s, /\bcheckAction\(/g), 1); assert.equal(count(s, /\brunDecision\(/g), 1); assert.equal(count(s, /\brunPosting\(/g), 1);
  assert.equal(count(s, /\bsessions\.issue\(/g), 1);
  const guard = s.lastIndexOf('checkAccess('), call = s.lastIndexOf('handle(');
  assert.ok(guard > 0 && call > 0 && guard < call, 'checkAccess( must precede the handler call');
  const dispatch = s.slice(s.lastIndexOf('const def = ROUTES.get'));
  assert.equal(count(dispatch, /\bhandle\(|\bhandlePost\(/g), 2); assert.ok(dispatch.indexOf('checkAccess(') < dispatch.indexOf('handlePost('));
  const issue = s.indexOf('sessions.issue('); assert.ok(s.lastIndexOf("route === 'page'", issue) > s.lastIndexOf('async function handle(', issue), 'the one issue() sits in the page route');
  for (const f of NEW_FILES.filter((x) => x !== 'review-routes.js')) assert.equal(count(read(f), /\bsessions\.issue\(/g), 0, f);
});

test('(2) no config write, switch, network or model word in the new files', () => {
  const words = [/autoPublish/, /node:https/, /child_process/, /anthropic/i, /openai/i, /localAsk/, /\bfetch\(/, /writeFile\w*\([^)]*config/i];
  for (const f of NEW_FILES) {
    const s = read(f); for (const re of words) assert.doesNotMatch(s, re, `${f} must not match ${re}`);
    if (f === 'review-routes.js') { // the page only READS the settings file (fresh from disk) for its status line; every mention must be a read
      for (const m of s.matchAll(/config\.json/g)) { const line = s.slice(s.lastIndexOf('\n', m.index) + 1, s.indexOf('\n', m.index)); assert.match(line, /readFileSync\(/, 'config.json may only be read'); assert.doesNotMatch(line, /write|rename|append|copy/i); }
    } else assert.doesNotMatch(s, /config\.json/, `${f} must not mention config.json`);
  }
});

test('(3) review-decisions.js is imported only by review-decide.js, bpa-actions.js (and the routes for the file path)', () => {
  const importers = fs.readdirSync(HERE).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && /from\s+'\.\/review-decisions\.js'/.test(read(f))).sort();
  for (const f of importers) assert.ok(['review-decide.js', 'bpa-actions.js', 'review-routes.js'].includes(f), `unexpected importer ${f}`);
  assert.ok(importers.includes('review-decide.js'));
  // only review-decide.js may CALL appendDecision (the writer)
  for (const f of fs.readdirSync(HERE).filter((x) => x.endsWith('.js') && !x.endsWith('.test.js') && x !== 'review-decide.js' && x !== 'review-decisions.js')) assert.equal(count(read(f), /\bappendDecision\(/g), 0, f);
});

test('(4) every lock section of bpa-actions.js goes through the one locked() helper, which holds the one withDecisionLock( call', () => {
  const s = read('bpa-actions.js');
  assert.equal(count(s, /\bwithDecisionLock\(/g), 1);
  assert.equal(count(s, /\breturn locked\(/g), 4, 'hook decision (skip, undo), approve (CR5: its check runs outside, the decision inside), edit and clip decision: four lock sections');
  assert.equal(count(s, /\blocked\(/g), 5, 'the definition plus the four call sites');
});

test('(4b) CR3: the posting record in review-decide.js is written inside withDecisionLock; the two ctx writers are only handed to bpa-actions, which calls them under its lock', () => {
  const s = read('review-decide.js');
  assert.equal(count(s, /\bwithDecisionLock\(/g), 1); assert.equal(count(s, /\bappendDecision\(/g), 3, 'record, voidRecord (both run inside bpa-actions locked()) and the posting record');
  const posting = s.split('\n').filter((l) => /kind: 'posting'/.test(l)); assert.equal(posting.length, 1);
  assert.match(posting[0], /withDecisionLock\(\(\) => appendDecision\(/, 'the posting record sits inside the lock call');
  assert.match(s, /import \{ withDecisionLock \} from '\.\/decision-lock\.js'/);
});

test('(5) no request or body id is used as a plain object key', () => {
  for (const f of ['bpa-actions.js', 'review-decide.js']) for (const line of read(f).split('\n')) assert.doesNotMatch(line, /\[\s*(req|body)\.id\s*\]/, `${f}: ${line.trim()}`);
});

test('(6) SR1: checkSameOrigin( is called at exactly two sites in review-routes.js (session, then decide/posting after the token), both inside handlePost, never in the page route', () => {
  const s = read('review-routes.js'); assert.equal(count(s, /\bcheckSameOrigin\(/g), 2);
  const post = s.slice(s.indexOf('async function handlePost('), s.indexOf('async function handle(req'));
  assert.equal(count(post, /\bcheckSameOrigin\(/g), 2);
  assert.ok(post.indexOf('checkSameOrigin(', post.indexOf('checkAction(')) > post.indexOf('checkAction('), 'after the token check');
  assert.ok(post.indexOf('checkSameOrigin(', post.indexOf('checkAction(')) < post.indexOf('readBody('), 'before the body is read');
  assert.equal(count(s.slice(s.indexOf('async function handle(req')), /\bcheckSameOrigin\(/g), 0, 'the page route does not use it');
});
