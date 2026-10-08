import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeClickDepth } from '../click-depth.mjs';
import { makeSite, page } from './helpers.mjs';

test('BFS depth: chain of 5 pages -> depth 0..4, depth>=4 flagged with max-depth 3', () => {
  const dir = makeSite({
    'index.html': page('Home', ['/a']),
    'a.html': page('A', ['/b']),
    'b/index.html': page('B', ['/c.html']),
    'c.html': page('C', ['/d']),
    'd.html': page('D', ['/e']),
    'e.html': page('E', []),
  });
  const r = analyzeClickDepth(dir, { maxDepth: 3 });
  assert.equal(r.depth['/'], 0);
  assert.equal(r.depth['/a'], 1);
  assert.equal(r.depth['/b'], 2);
  assert.equal(r.depth['/c'], 3);
  assert.equal(r.depth['/d'], 4);
  assert.deepEqual(r.deep.map((d) => d.path).sort(), ['/d', '/e']);
});

test('orphans: page with zero inlinks is reported; noindex and redirect stubs are not', () => {
  const dir = makeSite({
    'index.html': page('Home', ['/a']),
    'a.html': page('A'),
    'lonely.html': page('Lonely'),
    'private.html': page('Private', [], '', '<meta name="robots" content="noindex,follow">'),
    'old.html': '<html><head><meta http-equiv="refresh" content="0; url=/a"></head></html>',
  });
  const r = analyzeClickDepth(dir, {});
  assert.deepEqual(r.orphans, ['/lonely']);
  assert.ok(!r.pages.includes('/old'));
});

test('allow list silences a deliberate orphan; relative + absolute-self links resolve', () => {
  const dir = makeSite({
    'index.html': page('Home', ['https://x.test/a/'], '', '<link rel="canonical" href="https://x.test/">'),
    'a/index.html': page('A', ['b']),
    'a/b.html': page('B'),
    'thanks.html': page('Thanks'),
  });
  const r = analyzeClickDepth(dir, { allow: ['/thanks'] });
  assert.deepEqual(r.orphans, []);
  assert.equal(r.depth['/a/b'], 2);
});

test('unreachable-but-linked-from-orphan page is reported as unreachable, not hidden', () => {
  const dir = makeSite({
    'index.html': page('Home', []),
    'x.html': page('X', ['/y']),
    'y.html': page('Y'),
  });
  const r = analyzeClickDepth(dir, {});
  assert.deepEqual(r.orphans, ['/x']);
  assert.deepEqual(r.unreachable.sort(), ['/x', '/y']);
});

test('site without a "/" page (language-redirect root) starts BFS from /en and /de', () => {
  const dir = makeSite({
    'en/index.html': page('EN', ['/en/a']),
    'en/a/index.html': page('A'),
    'de/index.html': page('DE', ['/de/b']),
    'de/b/index.html': page('B'),
  });
  const r = analyzeClickDepth(dir, {});
  assert.deepEqual(r.roots.sort(), ['/de', '/en']);
  assert.equal(r.depth['/en/a'], 1);
  assert.deepEqual(r.orphans, []);
});
