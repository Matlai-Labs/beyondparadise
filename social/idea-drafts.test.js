import './test-env.js';
// Post ideas -> checked drafts -> the SAME queue path as the weekly drafts, through runDraft(deps). The switch `ideaDrafts` is off by default.
// No network, no model (every ask is injected), no real queue, no real log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDraft } from './draft.js';
import { CONFIG, loadQueue, saveQueue, STATUS, chooseFormat } from './lib.js';
import { engageStop } from './stop.js';
import { GuardError } from './local-model.js';
import { loadIdeaPool, gateIdeaDrafts, DEFAULT_PER_RUN } from './idea-drafts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-id-'));
const read = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');
const ANSWER = JSON.stringify({ hook: 'Ferries link Zanzibar and the mainland', caption: 'Ferries run between Zanzibar and the mainland. The crossing is a common way to reach the island. Check the operator for current times before you travel.', altText: 'Text card with the headline: ferries link Zanzibar and the mainland.' });
const idea = (i, over = {}) => ({ id: `idea_${i}`, sourceId: `fact:f${i}`, kind: 'fact', topic: 'getting-there', title: `Ferry crossing ${i}`, claims: [{ text: 'Ferries connect Zanzibar and the mainland.', factId: `f${i}`, sourceDate: '2026-10-01' }], link: '/destinations/zanzibar/', score: 100 - i, ...over });
const IDEAS = [0, 1, 2, 3, 4].map((i) => idea(i));

function setup({ ideas = IDEAS, config = {}, answer = () => ANSWER, preQueue, pool } = {}) {
  const dir = tmp(); const queuePath = path.join(dir, 'q.json'); if (preQueue) saveQueue(preQueue, queuePath);
  const s = { dir, queuePath, asked: [], poolCalls: 0, lines: [], sent: [], stopOpts: { flagPath: path.join(dir, 'stop'), fleetPath: path.join(dir, 'fleet') } };
  s.deps = { queuePath, stopOpts: s.stopOpts, say: (m) => s.lines.push(m), notify: async (m) => { s.sent.push(m); return true; }, readBriefs: () => [], buildDrafts: async () => [],
    config: { ...CONFIG, ...config }, ask: async (req) => { s.asked.push(req); const a = answer(req, s.asked.length); if (a instanceof Error) throw a; return a; }, ideaPool: pool || (() => { s.poolCalls++; return { ok: true, ideas, dropped: [], sourceNames: {} }; }) };
  return s;
}

test('the shipped config.json leaves the switch absent, and the idea drafts are carousels', () => {
  assert.equal('ideaDrafts' in CONFIG, false); assert.equal(CONFIG.instagram.formatByKind.idea, 'carousel'); assert.equal(typeof CONFIG.captionModel, 'string');
  assert.equal(DEFAULT_PER_RUN, 3);
});

test('switch off (absent, false, or anything but boolean true): the model is never asked and the pool is never read', async () => {
  for (const config of [{}, { ideaDrafts: false }, { ideaDrafts: 'true' }, { ideaDrafts: 1 }, { ideaDrafts: null }]) {
    const s = setup({ config }); const r = await runDraft(s.deps);
    assert.equal(r.exitCode, 0); assert.equal(s.asked.length, 0, JSON.stringify(config)); assert.equal(s.poolCalls, 0); assert.equal(loadQueue(s.queuePath).drafts.length, 0);
    assert.ok(!s.lines.some((l) => /idea/i.test(l)), 'no idea log line when off');
  }
});

test('switch on: at most ideaDraftsPerRun drafts, each carrying its claims, planned as a carousel, in the normal queue state', async () => {
  const s = setup({ config: { ideaDrafts: true, ideaDraftsPerRun: 2, captionModel: 'test-model' } }); const r = await runDraft(s.deps);
  assert.equal(r.exitCode, 0); const q = loadQueue(s.queuePath); assert.equal(q.drafts.length, 2);
  for (const [n, d] of q.drafts.entries()) {
    assert.equal(d.status, STATUS.PENDING); assert.equal(d.id, `B${n + 1}`); assert.equal(d.kind, 'idea'); assert.equal(d.ideaId, IDEAS[n].id); assert.deepEqual(d.claims, IDEAS[n].claims);
    assert.equal(d.model, 'test-model'); assert.equal(chooseFormat(d, CONFIG), 'carousel'); assert.ok(d.slides.length >= 3 && d.slides[0].role === 'hook' && d.slides.at(-1).role === 'save'); assert.ok(d.createdAt); assert.ok(d.score);
  }
  assert.equal(s.asked.length, 2); assert.ok(s.asked.every((a) => a.model === 'test-model'));
  assert.ok(s.sent.length === 1 && s.sent[0].includes('Ferries link Zanzibar'), 'the approval prompt lists them like any other draft');
});
test('default per run is 3; an invalid number fails closed to none', async () => {
  const s = setup({ config: { ideaDrafts: true } }); await runDraft(s.deps); assert.equal(loadQueue(s.queuePath).drafts.length, 3);
  for (const bad of [0, -1, 1.5, '3', null]) { const t = setup({ config: { ideaDrafts: true, ideaDraftsPerRun: bad } }); await runDraft(t.deps); assert.equal(t.asked.length, 0, String(bad)); assert.equal(loadQueue(t.queuePath).drafts.length, 0); assert.ok(t.lines.some((l) => /ideaDraftsPerRun/.test(l))); }
});
test('an idea already in the queue (any state) is not drafted again', async () => {
  const pre = { seq: 2, drafts: [{ id: 'B1', status: STATUS.PENDING, kind: 'idea', ideaId: 'idea_0', sourceId: 'x', text: 't' }, { id: 'B2', status: STATUS.SKIPPED, kind: 'idea', ideaId: 'idea_1', sourceId: 'y', text: 't' }] };
  const s = setup({ config: { ideaDrafts: true, ideaDraftsPerRun: 3 }, preQueue: pre }); await runDraft(s.deps);
  assert.deepEqual(loadQueue(s.queuePath).drafts.slice(2).map((d) => d.ideaId), ['idea_2', 'idea_3', 'idea_4']);
});
test('an idea whose draft fails is logged with its reasons and not queued; the others still are', async () => {
  const s = setup({ config: { ideaDrafts: true, ideaDraftsPerRun: 3 }, answer: (req) => (req.prompt.includes('Ferry crossing 0') ? 'no json at all' : ANSWER) });
  await runDraft(s.deps);
  assert.deepEqual(loadQueue(s.queuePath).drafts.map((d) => d.ideaId), ['idea_1', 'idea_2']);
  const line = s.lines.find((l) => /idea draft failed/.test(l)); assert.ok(line && line.includes('idea_0') && line.includes('not-json'), line);
});
test('with the stop flag nothing is asked and nothing is queued', async () => {
  const s = setup({ config: { ideaDrafts: true } }); engageStop({ flagPath: s.stopOpts.flagPath }); const r = await runDraft(s.deps);
  assert.equal(r.stopped, true); assert.equal(s.asked.length, 0); assert.equal(s.poolCalls, 0); assert.equal(fs.existsSync(s.queuePath), false);
});
test('a guard refusal in the middle (cap, stop) ends the idea drafting, keeps what was made, exit code 0', async () => {
  const s = setup({ config: { ideaDrafts: true, ideaDraftsPerRun: 3 }, answer: (req, n) => (n >= 2 ? new GuardError('per-day cap of 1500 calls reached') : ANSWER) });
  const r = await runDraft(s.deps); assert.equal(r.exitCode, 0); assert.equal(loadQueue(s.queuePath).drafts.length, 1); assert.ok(s.lines.some((l) => /stopped by guard: per-day cap/.test(l)));
});
test('a pool that cannot be built (private list unavailable) asks nothing and says why', async () => {
  const s = setup({ config: { ideaDrafts: true }, pool: () => ({ ok: false, reason: 'never-promote list unreadable' }) }); await runDraft(s.deps);
  assert.equal(s.asked.length, 0); assert.ok(s.lines.some((l) => /never-promote list unreadable/.test(l)));
});
test('the same gates as buildDrafts: a draft that trips the brand, voice or rules check is marked rejected, a clean one gets createdAt and a score', async () => {
  const base = { kind: 'idea', text: 'Ferries link Zanzibar and the mainland\n\nFerries run daily.\nSource: Beyond Paradise Adventures research, read 2026-10-01\n\n#Tanzania', sourceDate: '2026-10-01', sourceId: 'fact:f0', claims: IDEAS[0].claims };
  const [ok, brand, rules, voice] = await gateIdeaDrafts([base, { ...base, text: base.text + '\nBeyond Paradise rocks' }, { ...base, text: base.text + '\nBook now for big waves' }, { ...base, text: base.text + '\nA game-changing, unforgettable, must-see journey' }], { now: new Date('2026-11-17T06:00:00Z') });
  assert.equal(ok.rejected, undefined); assert.equal(ok.createdAt, '2026-11-17T06:00:00.000Z'); assert.ok(ok.score);
  assert.match(brand.rejected, /Beyond Paradise Adventures/); assert.match(rules.rejected, /^rules: /); assert.match(voice.rejected, /^voice-lint/);
});

// ── the real pool, from files (a small fake repository) ──
function fakeRoot(extraFacts = []) {
  const root = tmp(); fs.mkdirSync(path.join(root, 'data', 'facts'), { recursive: true }); fs.mkdirSync(path.join(root, 'data', 'rules'), { recursive: true });
  const f = (id, claim, over = {}) => ({ id, topic: 'visa', region: 'tanzania', claim, value: `${claim} value text`, sources: ['src-a', 'src-b'], status: 'confirmed', lastChecked: '2026-10-01', ...over });
  fs.writeFileSync(path.join(root, 'data', 'facts', 'facts.json'), JSON.stringify({ facts: [f('a', 'Alpha fact'), f('b', 'Mentions examplehotel by name'), ...extraFacts] }));
  fs.writeFileSync(path.join(root, 'data', 'facts', 'sources.json'), JSON.stringify({ sources: { 'src-a': { name: 'Source Alpha' }, 'src-b': { name: 'Source Beta' }, 'src-c': { name: 'Source Gamma' } } }));
  fs.writeFileSync(path.join(root, 'data', 'rules', 'official-rules.json'), JSON.stringify({ rules: [] }));
  return root;
}
test('loadIdeaPool: reads the files, applies the private list, names sources; no list or a broken list = no pool', () => {
  const root = fakeRoot(); const base = { root, queuePath: path.join(root, 'none.json'), now: new Date('2026-11-17T00:00:00Z') };
  const p = loadIdeaPool(base); assert.equal(p.ok, true); assert.deepEqual(p.ideas.map((i) => i.claims[0].factId), ['a'], 'the fact naming the never-promote word is dropped');
  assert.equal(p.sourceNames.a, 'Source Alpha and Source Beta');
  const dir = tmp();
  for (const content of [null, '{not json', '{"patterns":[]}', '[]']) {
    const file = path.join(dir, `l${String(content).length}.json`); if (content !== null) fs.writeFileSync(file, content);
    const q = loadIdeaPool({ ...base, env: { ...process.env, BPA_NEVER_PROMOTE_FILE: file } }); assert.equal(q.ok, false); assert.match(q.reason, /never-promote/); assert.ok(!q.ideas);
  }
  fs.mkdirSync(path.join(root, 'data', 'facts'), { recursive: true }); fs.writeFileSync(path.join(root, 'data', 'facts', 'facts.json'), '{broken');
  assert.equal(loadIdeaPool(base).ok, false);
});
test('loadIdeaPool: ideas already in the queue by source id are left out (the pool history rule)', () => {
  const root = fakeRoot(); const queuePath = path.join(root, 'q.json'); saveQueue({ seq: 1, drafts: [{ id: 'B1', status: STATUS.PENDING, sourceId: 'fact:a', createdAt: '2026-11-10T00:00:00Z', text: 'x' }] }, queuePath);
  assert.deepEqual(loadIdeaPool({ root, queuePath, now: new Date('2026-11-17T00:00:00Z') }).ideas, []);
});
test('loadIdeaPool on this repository: the real data gives ranked ideas of all three kinds', () => {
  const p = loadIdeaPool({ queuePath: path.join(tmp(), 'q.json'), now: new Date('2026-11-17T00:00:00Z') });
  assert.equal(p.ok, true); const kinds = new Set(p.ideas.map((i) => i.kind)); assert.ok(kinds.has('fact') && kinds.has('rule'), [...kinds].join());
});

// ── wiring, source level ──
test('draft.js: the new code is loaded only inside the switch, idea drafts join the same list and the same single queue push', () => {
  const s = read('draft.js').replace(/\/\/.*$/gm, '');
  assert.ok(!/^import .*(idea-drafts|caption|local-model)/m.test(s), 'no static import of the new modules');
  const on = s.indexOf('config.ideaDrafts === true'); const imp = s.indexOf("import('./idea-drafts.js')"); assert.ok(on > 0 && imp > on, 'dynamic import sits behind the switch');
  assert.equal((s.match(/await buildDrafts\(/g) || []).length, 1); assert.equal((s.match(/q\.drafts\.push\(/g) || []).length, 1);
  assert.ok(s.indexOf('...ideaDrafts') > 0 && s.indexOf('...ideaDrafts') < s.indexOf('if (d.rejected)') && s.indexOf('if (d.rejected)') < s.indexOf('q.drafts.push('));
  assert.equal((s.match(/ideaDrafts\s*===\s*true/g) || []).length, 1);
});
