import './test-env.js';
// WIRING: every path that builds or accepts draft text for the queue must pass the voice gate.
// Source-level and deliberately blunt, in the style of the fleet's gate-wiring test: it counts
// invocations per call site (not "the name appears somewhere"), orders the gate before the write,
// and fails when a NEW file starts writing draft text without being declared here.
// A guard nothing exercises in the shape it runs in is not a guard (fleet rule: prove the guard fires).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');
const count = (s, re) => (s.match(re) || []).length;
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, `marker not found: ${a}`); const j = b ? s.indexOf(b, i + a.length) : -1; return s.slice(i, j > i ? j : undefined); };

test('call site 1: buildDrafts runs the gate once per candidate, before the draft is accepted', () => {
  const body = between(read('lib.js'), 'export async function buildDrafts', '// ── scheduling slots');
  assert.equal(count(body, /await voiceGate\(/g), 1, 'buildDrafts must call voiceGate exactly once (in the per-draft loop)');
  assert.ok(body.indexOf('await voiceGate(') < body.indexOf('createdAt: now.toISOString()'), 'gate must run before the accepted draft is built');
  assert.match(body, /if \(!v\.ok\) \{ out\.push\(\{ \.\.\.d, rejected:/, 'a failing gate must mark the draft rejected');
});

test('call site 2: the approval-server edit branch gates the new text before it replaces the draft text', () => {
  const edit = between(read('approval-server.js'), "c.cmd === 'edit'", "c.cmd === 'approve'");
  assert.equal(count(edit, /await voiceGate\(c\.text\)/g), 1);
  assert.ok(edit.indexOf('await voiceGate(c.text)') < edit.indexOf('d.text = c.text'), 'gate must run before d.text is assigned');
  assert.equal(count(read('approval-server.js'), /\.text\s*=[^=]/g), 1, 'the approval server may assign draft text in exactly one place (the edit branch)');
});

test('call site 3: carousel slides each pass the gate (default gate is voiceGate, called once per slide in the loop)', () => {
  const body = between(read('carousel.js'), 'export async function planCarousel', null);
  assert.match(body, /\{ voice = voiceGate(?:, rules = rulesCheck)? \} = \{\}/, 'planCarousel default must be the real voiceGate');
  assert.equal(count(body, /await voice\(/g), 1);
  assert.ok(body.slice(0, body.indexOf('await voice(')).includes('for ('), 'the gate call must sit inside the slide loop');
});

test('draft.js only queues what buildDrafts returned, and never a rejected draft', () => {
  const s = read('draft.js');
  assert.equal(count(s, /await buildDrafts\(/g), 1);
  assert.ok(s.indexOf('if (d.rejected)') >= 0 && s.indexOf('if (d.rejected)') < s.indexOf('q.drafts.push('), 'rejected drafts must be skipped before the queue push');
  assert.equal(count(s, /q\.drafts\.push\(/g), 1, 'one queue push, fed only by buildDrafts output');
});

test('no other file writes draft text to the queue without being declared here', () => {
  const declared = new Set(['lib.js', 'draft.js', 'approval-server.js', 'auto-lane.js']); // the three paths above, and the automatic lane (proved in auto-lane-wired.test.js: its one queue push follows the voice + rules final check)
  const offenders = [];
  for (const f of fs.readdirSync(HERE).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && !declared.has(f))) {
    const s = read(f);
    if (/\bdrafts\.push\(|\bd\.text\s*=[^=]|\.drafts\s*=[^=]/.test(s)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `these files write draft text but are not covered by the voice gate wiring: ${offenders.join(', ')}`);
});

test('the linter is loaded only through resources.js (vendored default), never by a sibling path', () => {
  const offenders = fs.readdirSync(HERE).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && /shared_knowledge\/scripts\/voice-lint|VOICE_LINT_PATH\s*\|\|/.test(read(f)));
  assert.deepEqual(offenders, []);
  const r = read('resources.js');
  assert.match(between(r, 'voiceLint:', 'metaPublish:'), /path\.join\(HERE, 'vendor', 'voice-lint', 'voice-lint\.mjs'\)/);
  assert.ok(!/shared_knowledge\/scripts\/voice-lint/.test(r));
  for (const f of ['voice-lint.mjs', 'rules.json']) assert.ok(fs.existsSync(path.join(HERE, 'vendor', 'voice-lint', f)), `vendored ${f} missing`);
});
