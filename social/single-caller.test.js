import './test-env.js';
// One model caller: no source file in social/ other than local-model.js sends a request to the local model server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKIP_DIRS = new Set(['node_modules', 'vendor']);
function sources(dir = HERE) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...sources(path.join(dir, e.name))); continue; }
    if (/\.(m?js|cjs|py|sh)$/.test(e.name) && !/\.test\.js$/.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}
// Built from pieces so this file does not contain the words it forbids elsewhere.
const FORBIDDEN = [new RegExp('1143' + '4'), new RegExp('api/' + 'generate'), new RegExp('api/' + 'chat')];

test('only local-model.js talks to the model server (port, generate and chat endpoints appear in no other source file)', () => {
  const files = sources(); assert.ok(files.length > 20, 'the scan found the source files');
  assert.ok(files.some((f) => path.basename(f) === 'local-model.js'));
  const hits = [];
  for (const f of files) { if (path.basename(f) === 'local-model.js') continue; const t = fs.readFileSync(f, 'utf8'); for (const re of FORBIDDEN) if (re.test(t)) hits.push(`${path.basename(f)}: ${re}`); }
  assert.deepEqual(hits, []);
});
test('local-model.js does contain them (the scan would notice a caller that moved)', () => {
  const t = fs.readFileSync(path.join(HERE, 'local-model.js'), 'utf8');
  for (const re of [FORBIDDEN[0], FORBIDDEN[2]]) assert.ok(re.test(t), String(re));
});
