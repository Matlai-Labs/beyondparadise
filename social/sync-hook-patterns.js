#!/usr/bin/env node
// One-command refresh of social/hook-patterns.json from the Agent OS reference-video store (dev-time copy; the pipeline never reads Agent OS).
//   npm run sync-hook-patterns            copy + validate (atomic; a failure leaves the previous copy)
//   npm run sync-hook-patterns -- --check validate the current copy
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_FILE } from './hookpatterns.js';

const SOURCE = process.env.HOOK_PATTERNS_SOURCE || path.join(os.homedir(), 'Desktop/AI_projects/MATLAI_VS_CODE_Agent_OS/knowledge/reference-videos/hook-patterns.json');
const TARGET = process.env.HOOK_PATTERNS_FILE || DEFAULT_FILE;

export function validate(text) {
  const p = JSON.parse(text);
  if (!p || p.schema !== 1 || !Array.isArray(p.patterns)) throw new Error('not a schema-1 hook-patterns file');
  return p;
}
export function sync({ check = false } = {}) {
  if (check) { const p = validate(fs.readFileSync(TARGET, 'utf8')); return `ok: ${TARGET} (${p.patterns.length} patterns, generated ${p.generated_at})`; }
  const text = fs.readFileSync(SOURCE, 'utf8'); const p = validate(text);
  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  const tmp = `${TARGET}.${process.pid}.tmp`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, TARGET);
  return `copied ${SOURCE} -> ${TARGET} (${p.patterns.length} patterns, ${p.source_count} source videos)`;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  try { console.log(sync({ check: process.argv.includes('--check') })); } catch (e) { console.error(`sync-hook-patterns failed: ${e.message}`); process.exit(1); }
}
