// The tourism-statistics source (BPI briefs: signal and outlook drafts, which go to Instagram and Facebook)
// can be switched off with config.tourismStatsDrafts === false. Absent or true = old behaviour.
import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { buildDrafts, CONFIG } from './lib.js';
const brief = { date: '2026-09-11', items: [{ signal: { id: 'x', subject: 'Sauti za Busara', region: 'zanzibar', summary: 'The festival dates were confirmed for February.', confidence: 0.9, magnitude: 1, sourceIds: ['a', 'b'] }, whyItMatters: 'Beds in Stone Town fill a month early.', whatToDo: 'Open February dates now.', sources: [{ id: 'a' }, { id: 'b' }] }], forecasts: [{ region: 'zanzibar', direction: 'rising', confidence: 0.8, drivers: ['Peak dry season'] }] };
const run = (config) => buildDrafts({ briefs: [brief], now: new Date('2026-09-12T00:00:00Z'), existingDrafts: [], config });
test('switch off: the tourism statistics source produces no draft at all', async () => {
  assert.deepEqual(await run({ ...CONFIG, tourismStatsDrafts: false }), []);
});
test('key absent or true: signal and outlook drafts are still produced (old behaviour)', async () => {
  const { tourismStatsDrafts, ...without } = CONFIG;
  for (const cfg of [without, { ...CONFIG, tourismStatsDrafts: true }]) {
    const kinds = (await run(cfg)).map((d) => d.kind).sort();
    assert.deepEqual(kinds, ['outlook', 'signal']);
  }
});
test('config.json has the switch set to off', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'config.json'), 'utf8'));
  assert.equal(cfg.tourismStatsDrafts, false);
});
