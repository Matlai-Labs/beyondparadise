import './test-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(HERE, 'review-page.html'), 'utf8');
const pure = vm.runInNewContext(`${html.split('// BEGIN PURE')[1].split('// END PURE')[0]}; ({ LIST_PAGE, LABELS, filterItems, countKinds, moveIndex, windowOf })`);

test('static rules: no external request, no HTML injection, no inline handlers, nonce on every script', () => {
  assert.ok(html.length < 60000); assert.doesNotMatch(html, /https?:\/\//); assert.doesNotMatch(html, /<link|@import|<iframe/);
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) assert.ok(!html.includes(bad), bad);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/); const scripts = html.match(/<script\b[^>]*>/g) || []; assert.ok(scripts.length >= 1); for (const s of scripts) assert.match(s, /nonce="__NONCE__"/);
  assert.doesNotMatch(html.match(/<style\b[^>]*>/)[0], /nonce/);
  for (const m of html.matchAll(/fetch\(([^)]*)\)/g)) assert.match(m[1], /^'api\/items'/);
  assert.ok((html.match(/fetch\(/g) || []).length >= 1);
});
test('head: charset, viewport, title', () => {
  assert.match(html, /<meta charset=/i); assert.match(html, /<meta name="viewport"/); assert.match(html, /<title>Beyond Paradise: review<\/title>/);
});
test('the step line, a muted looping inline video built in script, and no video in the markup', () => {
  assert.ok(html.includes('Step 1: look only. Approve and Skip arrive with the next step.')); assert.doesNotMatch(html.split('<script')[0], /<video/);
  for (const w of ["createElement('video')", 'muted = true', 'loop = true', 'playsInline = true', "'media/'"]) assert.ok(html.includes(w), w);
});
test('the named elements and the only fetch exist', () => {
  for (const id of ['status', 'filters', 'list', 'card', 'video-slot', 'prev', 'next', 'refresh']) assert.ok(html.includes(`id="${id}"`), id);
  for (const k of ['all', 'hook', 'clip']) assert.ok(html.includes(`data-kind="${k}"`), k);
});
test('server text goes in through textContent only', () => { assert.ok(html.includes('textContent')); assert.ok(!/\.(innerText|srcdoc)\s*=/.test(html)); });
test('plain English: no jargon in markup text or labels', () => {
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '') + Object.values(pure.LABELS).join(' ');
  assert.doesNotMatch(text, /\b(sha\d*|hash|json|manifest|api|mediaId|version|null|undefined|token|nonce)\b/i);
});
test('filterItems and countKinds', () => { const it = [{ kind: 'hook' }, { kind: 'clip' }, { kind: 'hook' }]; assert.equal(pure.filterItems(it, 'hook').length, 2); assert.equal(pure.filterItems(it, 'all').length, 3); assert.deepEqual({ ...pure.countKinds(it) }, { all: 3, hook: 2, clip: 1 }); assert.deepEqual(pure.filterItems(it, 'clip'), [{ kind: 'clip' }]); });
test('moveIndex clamps and never wraps', () => { assert.equal(pure.moveIndex(0, -1, 5), 0); assert.equal(pure.moveIndex(4, 1, 5), 4); assert.equal(pure.moveIndex(2, 1, 5), 3); assert.equal(pure.moveIndex(0, 1, 0), 0); });
test('windowOf keeps 300 items to 50 rows and contains the current index (focus 5)', () => {
  assert.equal(pure.LIST_PAGE, 50); for (const i of [0, 49, 50, 123, 299]) { const w = pure.windowOf(300, i, 50); assert.ok(w.to - w.from <= 50 && w.from <= i && i < w.to, String(i)); assert.equal(w.from % 50, 0); }
  assert.deepEqual({ ...pure.windowOf(0, 0, 50) }, { from: 0, to: 0 });
});
test('every problem code the server can send has a plain sentence', () => { for (const k of ['hooks-unreadable', 'ideas-unavailable', 'library-missing', 'library-unreadable']) assert.match(pure.LABELS[k], /^[A-Z].*\.$/); });
