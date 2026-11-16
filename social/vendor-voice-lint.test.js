import './test-env.js';
// The vendored voice linter: drift against the shared original, the rules compared as data, and
// fail-closed behaviour of the gate in lib.js. No network, no queue, no log written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyNeutralisation, UpstreamNoteChanged } from './vendor/voice-lint/neutralise.mjs';
import { voiceGate } from './lib.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, 'vendor', 'voice-lint');
// The sibling sits next to this repo (main checkout) or one level higher (a worktree). VOICE_LINT_UPSTREAM overrides.
const UPSTREAM = [process.env.VOICE_LINT_UPSTREAM, path.join(HERE, '..', '..', 'shared_knowledge', 'scripts', 'voice-lint'), path.join(HERE, '..', '..', '..', 'shared_knowledge', 'scripts', 'voice-lint')]
  .filter(Boolean).find((d) => fs.existsSync(path.join(d, 'voice-lint.mjs')));
const SKIP = UPSTREAM ? false : 'sibling shared_knowledge/scripts/voice-lint not present: drift cannot be checked here (skipped, NOT passed)';
const spec = JSON.parse(fs.readFileSync(path.join(VENDOR, 'neutralised.json'), 'utf8'));
const STALE = 're-copy with: node social/vendor/voice-lint/revendor.mjs';

test('vendored files are the upstream files with only the recorded notes replaced (byte for byte)', { skip: SKIP }, () => {
  for (const [file, entries] of Object.entries(spec.files)) {
    let expected;
    try { expected = applyNeutralisation(fs.readFileSync(path.join(UPSTREAM, file), 'utf8'), entries, file); }
    catch (e) { if (e instanceof UpstreamNoteChanged) assert.fail(e.message); throw e; }
    const vendored = fs.readFileSync(path.join(VENDOR, file), 'utf8');
    assert.ok(vendored === expected, `vendored copy is stale: ${file} differs from the upstream original; ${STALE}`);
  }
});

test('vendored rules.json equals the upstream rules as parsed data, except the one comment field', { skip: SKIP }, () => {
  const strip = (o) => { const c = JSON.parse(JSON.stringify(o)); delete c.structure._crutchComment; return c; };
  const up = JSON.parse(fs.readFileSync(path.join(UPSTREAM, 'rules.json'), 'utf8'));
  const ve = JSON.parse(fs.readFileSync(path.join(VENDOR, 'rules.json'), 'utf8'));
  assert.equal(typeof ve.structure._crutchComment, 'string');
  assert.deepEqual(strip(ve), strip(up), `vendored rules differ from upstream beyond the comment field; ${STALE}`);
});

test('neutralise: a changed upstream note is refused, not silently replaced', () => {
  const entries = [{ startLine: 2, endLine: 2, original_sha256: 'deadbeef', replacement: 'x' }];
  assert.throws(() => applyNeutralisation('a\nb\nc', entries, 'f'), /upstream note changed, re-vendor/);
});

test('neutralised.json records hashes only: no span of original text is stored', () => {
  for (const entries of Object.values(spec.files)) for (const e of entries) { assert.match(e.original_sha256, /^[0-9a-f]{64}$/); assert.ok(!('original' in e)); }
});

// ── the gate itself, in the shape it is deployed: vendored default ────────────
test('default linter is the vendored copy, not a sibling path', async () => {
  const r = await import('./resources.js');
  assert.equal(r.resourcePath('voiceLint', {}), path.join(VENDOR, 'voice-lint.mjs'));
  assert.ok(!/shared_knowledge/.test(r.resourcePath('voiceLint', {})));
});

test('the gate refuses machine-sounding text and passes clean text (vendored linter)', async () => {
  delete process.env.VOICE_LINT_PATH;
  const bad = await voiceGate("We are thrilled to delve into a rich tapestry of unforgettable experiences in today's fast-paced world.");
  assert.equal(bad.ok, false); assert.match(bad.reason, /findings/);
  const good = await voiceGate('Arrivals to Zanzibar rose in August. The statistics office counted 124,481 visitors, up on last year.');
  assert.equal(good.ok, true, good.reason);
});

function withLintPath(p, fn) { const prev = process.env.VOICE_LINT_PATH; process.env.VOICE_LINT_PATH = p; return Promise.resolve(fn()).finally(() => { if (prev === undefined) delete process.env.VOICE_LINT_PATH; else process.env.VOICE_LINT_PATH = prev; }); }

test('fail closed: missing linter refuses the draft with a clear reason', async () => {
  await withLintPath(path.join(os.tmpdir(), 'bpa-no-such-lint-' + Date.now() + '.mjs'), async () => {
    const r = await voiceGate('A perfectly clean sentence about the beach.');
    assert.equal(r.ok, false); assert.match(r.reason, /voice-lint unavailable.*fail closed/);
  });
});

test('fail closed: a linter that does not load, has no lint(), or throws refuses the draft', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-lint-'));
  const cases = { 'syntax.mjs': 'export const lint = (', 'nolint.mjs': 'export const x = 1;', 'throws.mjs': 'export const lint = () => { throw new Error("boom"); };', 'noresult.mjs': 'export const lint = () => undefined;' };
  for (const [f, src] of Object.entries(cases)) {
    fs.writeFileSync(path.join(dir, f), src);
    await withLintPath(path.join(dir, f), async () => { const r = await voiceGate('Clean text.'); assert.equal(r.ok, false, f); assert.ok(r.reason, f); });
  }
});

test('fail closed: vendored linter present but its rules.json missing refuses the draft', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-lint-norules-'));
  fs.copyFileSync(path.join(VENDOR, 'voice-lint.mjs'), path.join(dir, 'voice-lint.mjs'));
  await withLintPath(path.join(dir, 'voice-lint.mjs'), async () => { const r = await voiceGate('Clean text.'); assert.equal(r.ok, false); assert.match(r.reason, /unavailable/); });
});
