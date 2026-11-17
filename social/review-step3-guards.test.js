import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sources = () => fs.readdirSync(HERE).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).map((f) => [f, fs.readFileSync(path.join(HERE, f), 'utf8').replace(/^\s*\/\/.*$/gm, '')]);

test('approveSwitchOn( is called at most once, and only from review-routes.js (the items input); the definition is not a call', () => {
  const callers = [];
  for (const [f, s] of sources()) { const n = (s.match(/approveSwitchOn\(/g) || []).length - (f === 'approve-switch.js' ? 1 : 0); for (let i = 0; i < n; i++) callers.push(f); }
  assert.ok(callers.length <= 1, callers.join(', ')); assert.deepEqual([...new Set(callers)].filter((f) => f !== 'review-routes.js'), []);
});
