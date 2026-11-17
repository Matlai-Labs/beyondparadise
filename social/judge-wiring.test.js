import './test-env.js';
// The judge in the draft job (B6), through runDraft(deps): off / shadow (default) / enforce. No network, no model, no real queue, log or state folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDraft } from './draft.js';
import { CONFIG, loadQueue } from './lib.js';
import { GuardError } from './local-model.js';
import { JUDGE_QUESTION } from './judge.js';
import { DEFAULT_JUDGE_MODEL, defaultJudgeLog } from './idea-drafts.js';
import { stateDir } from './stop.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpa-jw-'));
const ANSWER = JSON.stringify({ hook: 'Ferries link Zanzibar and the mainland', caption: 'Ferries run between Zanzibar and the mainland. The crossing is a common way to reach the island. Check the operator for current times before you travel.', altText: 'Text card about ferries between Zanzibar and the mainland.' });
const idea = (i) => ({ id: `idea_${i}`, sourceId: `fact:f${i}`, kind: 'fact', topic: 'getting-there', title: `Ferry crossing ${i}`, claims: [{ text: 'Ferries connect Zanzibar and the mainland.', factId: `f${i}`, sourceDate: '2026-10-01' }], link: '/destinations/zanzibar/', score: 90 });
const IDEAS = [0, 1, 2, 3].map(idea);
const yes = JSON.stringify({ supported: true, extra: '' });
const no = JSON.stringify({ supported: false, extra: 'the crossing is common' });

function setup({ config = {}, judgeAnswer = () => yes, judgeLog } = {}) {
  const dir = tmp(); const queuePath = path.join(dir, 'q.json');
  const s = { dir, queuePath, caption: [], judged: [], lines: [], sent: [], log: judgeLog || path.join(dir, 'state', 'judge-shadow.jsonl') };
  s.deps = { queuePath, stopOpts: { flagPath: path.join(dir, 'stop'), fleetPath: path.join(dir, 'fleet') }, say: (m) => s.lines.push(m), notify: async (m) => { s.sent.push(m); return true; }, readBriefs: () => [], buildDrafts: async () => [],
    config: { ...CONFIG, ideaDrafts: true, ideaDraftsPerRun: 2, captionModel: 'cap-model', judgeModel: 'judge-model', ...config }, judgeLog: s.log,
    ask: async (req) => { if (req.system === JUDGE_QUESTION) { s.judged.push(req); const a = judgeAnswer(req, s.judged.length); if (a instanceof Error) throw a; return a; } s.caption.push(req); return ANSWER; },
    ideaPool: () => ({ ok: true, ideas: IDEAS, dropped: [], sourceNames: {} }) };
  return s;
}
const shadowLines = (s) => (fs.existsSync(s.log) ? fs.readFileSync(s.log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('the shipped config.json names a judge model and leaves judgeMode absent (= shadow); the default log is in the state folder', () => {
  assert.equal(typeof CONFIG.judgeModel, 'string'); assert.ok(CONFIG.judgeModel.length > 2); assert.equal('judgeMode' in CONFIG, false); assert.equal('ideaDrafts' in CONFIG, false);
  assert.equal(typeof DEFAULT_JUDGE_MODEL, 'string'); assert.equal(defaultJudgeLog(), path.join(stateDir(), 'bpa-judge-shadow.jsonl'));
});
test('judgeMode absent = shadow: every passing draft is judged, the verdict is stored on it, the draft is queued even when the judge fails it, one private log line each', async () => {
  const s = setup({ judgeAnswer: (req) => (req.prompt.includes('Check the operator') ? no : yes) }); await runDraft(s.deps);
  const q = loadQueue(s.queuePath); assert.equal(q.drafts.length, 2, 'queued as before, judge verdict or not');
  for (const d of q.drafts) { assert.equal(d.judge.verdict, 'fail'); assert.equal(d.judge.model, 'judge-model'); assert.ok(d.judge.at); assert.deepEqual(d.judge.reasons.map((r) => r.check), ['unsupported-statement']); assert.deepEqual(Object.keys(d.judge).sort(), ['at', 'model', 'reasons', 'verdict']); }
  assert.ok(s.judged.length >= 2 && s.judged.every((r) => r.model === 'judge-model' && r.temperature === 0));
  const lines = shadowLines(s); assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.ideaId), ['idea_0', 'idea_1']); for (const l of lines) { assert.equal(l.verdict, 'fail'); assert.deepEqual(l.checks, ['unsupported-statement']); assert.equal(l.model, 'judge-model'); assert.equal(l.mode, 'shadow'); }
  assert.equal(fs.statSync(s.log).mode & 0o777, 0o600);
  const raw = fs.readFileSync(s.log, 'utf8'); for (const leak of ['Ferries', 'crossing', 'operator', 'Source:', '#']) assert.ok(!raw.includes(leak), `the log carries no caption text (${leak})`);
});
test('shadow: a passing draft is stored with verdict pass and an empty reasons list; absent judgeModel falls back to the default model', async () => {
  const s = setup({ config: { judgeModel: undefined } }); await runDraft(s.deps);
  for (const d of loadQueue(s.queuePath).drafts) { assert.equal(d.judge.verdict, 'pass'); assert.deepEqual(d.judge.reasons, []); assert.equal(d.judge.model, DEFAULT_JUDGE_MODEL); }
  assert.ok(s.judged.every((r) => r.model === DEFAULT_JUDGE_MODEL));
});
test('judgeMode off: the judge is never asked, nothing is stored, no log file', async () => {
  const s = setup({ config: { judgeMode: 'off' } }); await runDraft(s.deps);
  const q = loadQueue(s.queuePath); assert.equal(q.drafts.length, 2); assert.equal(s.judged.length, 0); assert.ok(q.drafts.every((d) => !('judge' in d))); assert.equal(fs.existsSync(s.log), false);
});
test('judgeMode enforce: a failed draft is not queued and is logged with its check ids; a passing one is queued with the verdict stored', async () => {
  const s = setup({ config: { judgeMode: 'enforce' }, judgeAnswer: (req, n) => (n === 1 ? no : yes) }); // the first question (draft idea_0) fails, everything after passes
  await runDraft(s.deps); const q = loadQueue(s.queuePath);
  assert.deepEqual(q.drafts.map((d) => d.ideaId), ['idea_1'], 'idea_0 refused, idea_1 queued'); assert.equal(q.drafts[0].judge.verdict, 'pass');
  const line = s.lines.find((l) => /rejected draft .*judge/.test(l)); assert.ok(line && line.includes('unsupported-statement') && line.includes('fact:f0'), s.lines.join('\n'));
  assert.ok(!line.includes('Ferries run between') && !line.includes('crossing'), 'the log line carries check ids, not caption text');
  assert.equal(fs.existsSync(s.log), false, 'enforce writes the normal log line, not the shadow file');
});
test('judgeMode enforce, judge passes everything: both queued, verdicts stored', async () => {
  const s = setup({ config: { judgeMode: 'enforce' } }); await runDraft(s.deps); const q = loadQueue(s.queuePath); assert.equal(q.drafts.length, 2); assert.ok(q.drafts.every((d) => d.judge.verdict === 'pass'));
});
test('judgeMode enforce, every draft fails: nothing is queued, the approval prompt says nothing new', async () => {
  const s = setup({ config: { judgeMode: 'enforce' }, judgeAnswer: () => no }); await runDraft(s.deps);
  assert.equal(loadQueue(s.queuePath).drafts.length, 0); assert.equal(s.lines.filter((l) => /rejected draft/.test(l) && /unsupported-statement/.test(l)).length, 2); assert.ok(s.sent.length === 1 && /nothing new to draft/.test(s.sent[0]));
});
test('a mode that is not off, shadow or enforce is treated as enforce (a typo must not switch the filter to advice) and says so', async () => {
  for (const mode of ['enfroce', 'ENFORCE ', 1, true, null, '']) {
    const s = setup({ config: { judgeMode: mode }, judgeAnswer: () => no }); await runDraft(s.deps);
    assert.equal(loadQueue(s.queuePath).drafts.length, 0, String(mode)); assert.ok(s.lines.some((l) => /judgeMode/.test(l) && /enforce/.test(l)), String(mode));
  }
});
test('fail closed in the judge: an unparsable answer or a caller error fails the draft; in shadow it is stored, in enforce it is refused', async () => {
  for (const [judgeAnswer, check] of [[() => 'garbage', 'judge-unparsable'], [() => new Error('ollama HTTP 500'), 'judge-error']]) {
    const sh = setup({ judgeAnswer }); await runDraft(sh.deps); assert.equal(loadQueue(sh.queuePath).drafts.length, 2); assert.deepEqual(loadQueue(sh.queuePath).drafts[0].judge.reasons.map((r) => r.check), [check]);
    const en = setup({ config: { judgeMode: 'enforce' }, judgeAnswer }); await runDraft(en.deps); assert.equal(loadQueue(en.queuePath).drafts.length, 0);
  }
});
test('a guard refusal in the judge stops further judge calls: the rest are failed without asking (shadow: queued with a failed verdict; enforce: refused)', async () => {
  const sh = setup({ judgeAnswer: (req, n) => (n >= 2 ? new GuardError('per-run cap of 120 calls reached') : yes) }); await runDraft(sh.deps);
  const ds = loadQueue(sh.queuePath).drafts; assert.equal(ds.length, 2); assert.equal(ds[1].judge.verdict, 'fail'); assert.equal(ds[1].judge.reasons[0].check, 'judge-error'); const askedAtStop = sh.judged.length;
  assert.ok(sh.lines.some((l) => /stopped by guard/.test(l)));
  const en = setup({ config: { judgeMode: 'enforce' }, judgeAnswer: () => new GuardError('stopped by flag') }); await runDraft(en.deps); assert.equal(loadQueue(en.queuePath).drafts.length, 0); assert.equal(en.judged.length, 1, 'one call hit the guard, the next draft was not asked');
  assert.ok(askedAtStop >= 2);
});
test('a log file that cannot be written does not stop the draft job: the draft is queued, one line says so', async () => {
  const dir = tmp(); fs.writeFileSync(path.join(dir, 'afile'), 'x'); const s = setup({ judgeLog: path.join(dir, 'afile', 'sub', 'log.jsonl') });
  const r = await runDraft(s.deps); assert.equal(r.exitCode, 0); assert.equal(loadQueue(s.queuePath).drafts.length, 2); assert.ok(s.lines.some((l) => /shadow log/.test(l)));
});
test('a draft the earlier gates already refused is never judged', async () => {
  const s = setup({ config: { ideaDraftsPerRun: 1 } }); s.deps.ask = async (req) => { if (req.system === JUDGE_QUESTION) { s.judged.push(req); return yes; } return JSON.stringify({ hook: 'Ferries link Zanzibar and the mainland', caption: 'Ferries run between Zanzibar and the mainland, and we stayed there in the sea waves. Book now for the best price.', altText: 'Text card about ferries between Zanzibar and mainland.' }); };
  await runDraft(s.deps); assert.equal(s.judged.length, 0); assert.equal(loadQueue(s.queuePath).drafts.length, 0);
});
test('switch ideaDrafts off: the judge code is not even loaded by draft.js (source level) and nothing is judged', async () => {
  const src = fs.readFileSync(path.join(HERE, 'draft.js'), 'utf8').replace(/\/\/.*$/gm, ''); assert.ok(!/judge/i.test(src.split('config.ideaDrafts === true')[0].replace(/judgeMode/g, '')), 'draft.js does not import the judge before the switch');
  const s = setup({ config: { ideaDrafts: false } }); await runDraft(s.deps); assert.equal(s.judged.length, 0); assert.equal(s.caption.length, 0); assert.equal(fs.existsSync(s.log), false);
});
