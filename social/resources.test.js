// Tests for social/resources.js — the single seam for everything outside this repo:
// filesystem paths on Tim's Mac, third-party credential files, render assets, Graph API transport.
// Audit 2026-11 findings 5 (CDN at render time), 6 (hard-coded /Users paths), 12 (token in URL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESOURCES, resourcePath, requireResource, gsapAssetPath, fontAssets, graphRequestSpec, GRAPH_VERSION } from './resources.js';

/** assert.throws() returns undefined, so capture the error when the message is what we care about. */
const caught = (fn) => { try { fn(); } catch (e) { return e; } throw new Error('expected a throw'); };

test('every external path is overridable by a named env var and defaults to the current location', () => {
  for (const [name, r] of Object.entries(RESOURCES)) {
    assert.ok(r.env, `${name} must declare an env var`);
    assert.ok(r.what, `${name} must describe what it is, for the error message`);
    assert.equal(resourcePath(name, {}), r.default, `${name} default must not change`);
    assert.equal(resourcePath(name, { [r.env]: '/somewhere/else' }), '/somewhere/else', `${name} must honour ${r.env}`);
  }
});

test('resourcePath rejects an unknown resource rather than returning undefined', () => {
  assert.throws(() => resourcePath('nope', {}), /unknown external resource/i);
});

test('a missing external file fails with a message naming the env var, not a raw ENOENT', () => {
  const missing = path.join(os.tmpdir(), 'bpa-does-not-exist-' + Date.now());
  const err = caught(() => requireResource('voiceLint', { VOICE_LINT_PATH: missing }));
  assert.match(err.message, /VOICE_LINT_PATH/, 'names the env var to set');
  assert.match(err.message, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'names the path it looked at');
  assert.doesNotMatch(err.message, /ENOENT/);
});

test('requireResource returns the path when the file is there', () => {
  const real = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bpares-')), 'voice-lint.mjs');
  fs.writeFileSync(real, 'export const lint = () => ({ ok: true });');
  assert.equal(requireResource('voiceLint', { VOICE_LINT_PATH: real }), real);
});

test('no absolute /Users path is hard-coded outside resources.js', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const offenders = [];
  for (const f of fs.readdirSync(here).filter((f) => f.endsWith('.js') && f !== 'resources.js' && !f.endsWith('.test.js'))) {
    if (/['"`]\/Users\//.test(fs.readFileSync(path.join(here, f), 'utf8'))) offenders.push(f);
  }
  assert.deepEqual(offenders, [], 'external paths belong in resources.js, where they are env-overridable');
});

test('gsapAssetPath resolves a local file and never a URL', () => {
  const p = gsapAssetPath();
  assert.doesNotMatch(p, /^https?:/, 'the render must not fetch gsap over the network');
  assert.ok(fs.existsSync(p), `${p} should exist — run npm install in social/`);
  assert.match(fs.readFileSync(p, 'utf8').slice(0, 4000), /gsap/i);
});

test('gsapAssetPath honours BPA_GSAP_PATH and explains how to fix a miss', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpagsap-'));
  const fake = path.join(dir, 'gsap.min.js'); fs.writeFileSync(fake, '// gsap');
  assert.equal(gsapAssetPath({ BPA_GSAP_PATH: fake }), fake);
  const err = caught(() => gsapAssetPath({ BPA_GSAP_PATH: path.join(dir, 'gone.js') }));
  assert.match(err.message, /BPA_GSAP_PATH|npm install/);
});

test('fontAssets resolves the three brand faces locally so a render needs no network', () => {
  const faces = fontAssets();
  assert.deepEqual(faces.map((f) => f.as).sort(), ['inter-400.woff2', 'inter-600.woff2', 'playfair-700-italic.woff2']);
  for (const f of faces) {
    assert.ok(fs.existsSync(f.path), `${f.as} should exist at ${f.path} — run npm install in social/`);
    assert.doesNotMatch(f.path, /^https?:/);
    assert.equal(fs.readFileSync(f.path).subarray(0, 4).toString('latin1'), 'wOF2', `${f.as} must be a woff2 file`);
    assert.ok(f.family && f.weight && f.style, `${f.as} must carry the @font-face descriptors`);
  }
});

// ── Graph API transport (audit finding 12) ───────────────────────────────────
test('graphRequestSpec keeps the token out of the URL when BPA_META_AUTH_HEADER=1', () => {
  const s = graphRequestSpec('123456?fields=id,permalink', { token: 'T0KEN', env: { BPA_META_AUTH_HEADER: '1' } });
  assert.doesNotMatch(s.url, /access_token/, 'no token in the query string');
  assert.doesNotMatch(s.url, /T0KEN/);
  assert.equal(s.headers.Authorization, 'Bearer T0KEN');
  assert.equal(s.method, 'GET');
  assert.match(s.url, new RegExp(`^https://graph\\.facebook\\.com/${GRAPH_VERSION}/123456\\?`));
  assert.match(s.url, /fields=id%2Cpermalink|fields=id,permalink/);
});

test('graphRequestSpec defaults to the current query-string form (live Meta path unverified here)', () => {
  const s = graphRequestSpec('123456?fields=id', { token: 'T0KEN', env: {} });
  assert.match(s.url, /access_token=T0KEN/);
  assert.equal(s.headers.Authorization, undefined);
});

test('graphRequestSpec POSTs put the token in the body, never the URL, either way', () => {
  for (const env of [{}, { BPA_META_AUTH_HEADER: '1' }]) {
    const s = graphRequestSpec('17841/media', { token: 'T0KEN', method: 'POST', form: { caption: 'hi' }, env });
    assert.equal(s.method, 'POST');
    assert.doesNotMatch(s.url, /T0KEN/, 'a POST must never carry the token in the URL');
    const body = s.body.toString();
    assert.match(body, /caption=hi/);
    if (env.BPA_META_AUTH_HEADER === '1') {
      assert.equal(s.headers.Authorization, 'Bearer T0KEN');
      assert.doesNotMatch(body, /access_token/, 'header mode must not also send it in the body');
    } else {
      assert.match(body, /access_token=T0KEN/);
    }
  }
});

test('every Graph API call in lib.js goes through the helper', () => {
  const src = fs.readFileSync(new URL('./lib.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /access_token=\$\{/, 'no hand-built access_token query parameter');
  assert.doesNotMatch(src, /graph\.facebook\.com/, 'Graph URLs are built in resources.js only');
});
