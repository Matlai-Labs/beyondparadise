#!/usr/bin/env node
// Re-copies the shared voice linter into this folder, applying neutralised.json.
// Usage:  node social/vendor/voice-lint/revendor.mjs [path-to-upstream-voice-lint-folder]
// Default upstream folder: ../../../../shared_knowledge/scripts/voice-lint relative to this file
// (main checkout), or one level higher when run from a worktree.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyNeutralisation } from './neutralise.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const candidates = [process.argv[2], path.join(HERE, '../../../../shared_knowledge/scripts/voice-lint'), path.join(HERE, '../../../../../shared_knowledge/scripts/voice-lint')].filter(Boolean);
const upstream = candidates.find((c) => fs.existsSync(path.join(c, 'voice-lint.mjs')));
if (!upstream) { console.error(`upstream voice-lint folder not found (looked at: ${candidates.join(', ')})`); process.exit(1); }
const spec = JSON.parse(fs.readFileSync(path.join(HERE, 'neutralised.json'), 'utf8'));
for (const [file, entries] of Object.entries(spec.files)) {
  const out = applyNeutralisation(fs.readFileSync(path.join(upstream, file), 'utf8'), entries, file);
  fs.writeFileSync(path.join(HERE, file), out);
  console.log(`wrote ${file} (${Buffer.byteLength(out)} bytes)`);
}
