import './test-env.js';
// The repository is PUBLIC: nothing private in the new files or in the README section.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// this file is left out of its own scan: it holds the patterns it looks for
const files = fs.readdirSync(HERE).filter((f) => (/^review-.*\.(js|html)$/.test(f) && f !== 'review-public-repo.test.js') || ['auto-hooks.js', 'auto-hooks-private.test.js', 'approval-server-review.test.js'].includes(f));
const readme = fs.readFileSync(path.join(HERE, 'README.md'), 'utf8'); const section = readme.split('## Review page (read only, step 1)')[1]?.split(/\n## /)[0] ?? '';
const texts = [...files.map((f) => [f, fs.readFileSync(path.join(HERE, f), 'utf8')]), ['README section', section]];
test('new files and the README section hold nothing private', () => {
  for (const [name, text] of texts) {
    for (const re of [/tail[0-9a-f]{4,}/, /matlai-mini/, /\+\d{8,15}\b/, /\/Users\//, /[\w.+-]+@(?!example\.com)[\w-]+\.[\w.]+/]) assert.doesNotMatch(text, re, `${name} ${re}`);
    for (const m of text.matchAll(/[\w.-]+\.ts\.net/g)) assert.equal(m[0], 'device.example.ts.net', `${name} ${m[0]}`);
  }
});
test('the scan covers the new files', () => { for (const f of ['review-auth.js', 'review-routes.js', 'review-page.html', 'auto-hooks.js', 'approval-server-review.test.js']) assert.ok(files.includes(f), f); assert.ok(files.length >= 13); });
test('README section carries the required commands and warnings', () => {
  assert.ok(section.length > 200);
  for (const s of ['tailscale serve --bg --https=10000 http://127.0.0.1:3028', 'Never use Tailscale Funnel', 'bpa-review-access.json', 'bpa-auto-hooks.json', '--migrate', 'tailscale serve --https=10000 off']) assert.ok(section.includes(s), s);
});
test('no review module makes an external request or calls a model', () => {
  for (const [f, t] of texts.filter(([f]) => f.startsWith('review-') && !f.endsWith('.test.js'))) assert.doesNotMatch(t.replace(/\/\/.*$/gm, ''), /\bfetch\(\s*['"`]https?:|node:https|localAsk|askLocal|captionModel|judgeModel|anthropic|openai/i, f);
});
