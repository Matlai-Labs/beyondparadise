import './test-env.js';
// The vendored JSON extractor: same behaviour as the upstream original, on fixtures that reproduce real model output (fences, prose, braces in strings).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseJsonLoose } from './vendor/json-loose/json-loose.mjs';

const UP = process.env.JSON_LOOSE_UPSTREAM;
test('vendored copy equals the upstream file apart from the type annotations', { skip: UP ? false : 'set JSON_LOOSE_UPSTREAM to the upstream json.ts to run the drift check' }, () => {
  const strip = (s) => s.replace('<T = unknown>', '').replace('(text: string): T | null', '(text)').replace('const candidates: string[] = [];', 'const candidates = [];').replace('parsed as T', 'parsed').replace('(s: string): string | null', '(s)');
  assert.equal(fs.readFileSync(new URL('./vendor/json-loose/json-loose.mjs', import.meta.url), 'utf8'), strip(fs.readFileSync(UP, 'utf8')), 'vendored json-loose.mjs drifted from the upstream original');
});
test('plain, fenced, prose-wrapped and brace-in-string answers parse; arrays, scalars, empty and truncated give null', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Sure!\n```json\n{"a":"x}y"}\n```\nbye'), { a: 'x}y' });
  assert.deepEqual(parseJsonLoose('before {"a":{"b":2}} after {"c":3}'), { a: { b: 2 } });
  for (const bad of ['[1,2]', '3', 'null', '', '   ', 'no object here', '{"a": ', undefined, null, 5]) assert.equal(parseJsonLoose(bad), null, String(bad));
});
