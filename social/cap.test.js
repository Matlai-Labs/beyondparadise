import './test-env.js';
import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { execFile } from 'node:child_process'; import { fileURLToPath } from 'node:url';
import { reserveInstagramPublish, dailyCap, eatDay, defaultLedgerPath } from './ledger.js';
import { saveQueue, loadQueue } from './lib.js';
import { runWorker } from './worker.js';
import { handle } from './approval-server.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bpacap-'));
const lp = () => path.join(tmp(), 'ledger.jsonl');
const at = (iso) => new Date(iso);
const lines = (p) => fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('cap: absent key = 1, 0 = none, n = n; junk fails closed to 0', () => {
  assert.equal(dailyCap({}), 1); assert.equal(dailyCap({ maxInstagramPostsPerDay: 0 }), 0); assert.equal(dailyCap({ maxInstagramPostsPerDay: 3 }), 3);
  for (const bad of [-1, 1.5, 'two', null, NaN]) assert.equal(dailyCap({ maxInstagramPostsPerDay: bad }), 0, String(bad));
});
test('eatDay: 21:30 UTC is already the next calendar day in East Africa Time', () => {
  assert.equal(eatDay(at('2026-11-16T20:59:59Z'), 'Africa/Dar_es_Salaam'), '2026-11-16'); assert.equal(eatDay(at('2026-11-16T21:00:00Z'), 'Africa/Dar_es_Salaam'), '2026-11-17');
});
test('second publish on the same EAT day is refused, with a reason; the ledger keeps exactly one line', () => {
  const p = lp(); const a = reserveInstagramPublish({ id: 'B1', now: at('2026-11-17T06:00:00Z'), path: p, config: {} }); assert.equal(a.ok, true);
  const b = reserveInstagramPublish({ id: 'B2', now: at('2026-11-17T12:00:00Z'), path: p, config: {} });
  assert.equal(b.ok, false); assert.match(b.reason, /daily cap 1 reached/); assert.deepEqual(lines(p).map((x) => x.id), ['B1']);
});
test('21:30 UTC against 00:30 EAT: a publish at 23:59 EAT does not block the first publish after 00:00 EAT', () => {
  const p = lp(); assert.equal(reserveInstagramPublish({ id: 'B1', now: at('2026-11-16T20:59:00Z'), path: p, config: {} }).ok, true);
  assert.equal(reserveInstagramPublish({ id: 'B2', now: at('2026-11-16T21:30:00Z'), path: p, config: {} }).ok, true, '21:30 UTC = 00:30 EAT next day');
  assert.equal(reserveInstagramPublish({ id: 'B3', now: at('2026-11-17T20:00:00Z'), path: p, config: {} }).ok, false, '23:00 EAT same day as B2');
});
test('the UTC-day trap: 22:00 UTC and 01:00 UTC next day are the SAME EAT day, so the second is refused', () => {
  const p = lp(); assert.equal(reserveInstagramPublish({ id: 'B1', now: at('2026-11-16T22:00:00Z'), path: p, config: {} }).ok, true);
  assert.equal(reserveInstagramPublish({ id: 'B2', now: at('2026-11-17T01:00:00Z'), path: p, config: {} }).ok, false);
});
test('cap 0 refuses everything; cap 2 allows two and refuses the third', () => {
  const p = lp(); assert.equal(reserveInstagramPublish({ id: 'B1', now: at('2026-11-17T06:00:00Z'), path: p, config: { maxInstagramPostsPerDay: 0 } }).ok, false); assert.equal(fs.existsSync(p), false);
  const c = { maxInstagramPostsPerDay: 2 }; const r = ['B1', 'B2', 'B3'].map((id) => reserveInstagramPublish({ id, now: at('2026-11-17T06:00:00Z'), path: p, config: c }).ok); assert.deepEqual(r, [true, true, false]);
});
test('ledger line carries ISO time and queue id; no temp file is left behind', () => {
  const p = lp(); reserveInstagramPublish({ id: 'B7', now: at('2026-11-17T06:00:00Z'), path: p, config: {} });
  assert.deepEqual(lines(p), [{ at: '2026-11-17T06:00:00.000Z', id: 'B7' }]); assert.deepEqual(fs.readdirSync(path.dirname(p)).sort(), ['ledger.jsonl']);
});
test('corrupt ledger fails CLOSED and is left untouched', () => {
  for (const content of ['{not json\n', '{"at":"yesterday","id":"B1"}\n', '{"id":"B1"}\n', '[]\n']) {
    const p = lp(); fs.writeFileSync(p, content);
    const r = reserveInstagramPublish({ id: 'B2', now: at('2026-11-17T06:00:00Z'), path: p, config: {} }); assert.equal(r.ok, false, content); assert.match(r.reason, /ledger unreadable or corrupt/); assert.equal(fs.readFileSync(p, 'utf8'), content);
  }
});
test('an unreadable ledger (a directory in its place) fails closed', () => {
  const p = lp(); fs.mkdirSync(p); assert.equal(reserveInstagramPublish({ id: 'B1', now: at('2026-11-17T06:00:00Z'), path: p, config: {} }).ok, false);
});
test('a held lock refuses (fail closed) and writes nothing; a stale lock is cleared', () => {
  const p = lp(); fs.writeFileSync(p + '.lock', 'other');
  const r = reserveInstagramPublish({ id: 'B1', now: at('2026-11-17T06:00:00Z'), path: p, config: {}, lockTimeoutMs: 100 }); assert.equal(r.ok, false); assert.match(r.reason, /lock/); assert.equal(fs.existsSync(p), false);
  const old = new Date(Date.now() - 120e3); fs.utimesSync(p + '.lock', old, old);
  assert.equal(reserveInstagramPublish({ id: 'B1', now: at('2026-11-17T06:00:00Z'), path: p, config: {}, lockTimeoutMs: 500 }).ok, true);
});
test('two near-simultaneous reservations (separate processes, same file) cannot both pass', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (let round = 0; round < 4; round++) {
    const p = lp();
    const code = `import { reserveInstagramPublish } from ${JSON.stringify(path.join(here, 'ledger.js'))};
      const r = reserveInstagramPublish({ id: process.argv[1], now: new Date('2026-11-17T06:00:00Z'), path: process.argv[2], config: {} }); console.log(r.ok ? 'PASS' : 'REFUSED');`;
    const run = (id) => new Promise((res, rej) => execFile(process.execPath, ['--input-type=module', '-e', code, id, p], { env: { ...process.env, BPA_QUIET: '1' } }, (e, out) => e ? rej(e) : res(out.trim())));
    const out = await Promise.all(['B1', 'B2', 'B3', 'B4', 'B5', 'B6'].map(run));
    assert.equal(out.filter((x) => x === 'PASS').length, 1, `round ${round}: ${out}`); assert.equal(lines(p).length, 1);
  }
});
test('default ledger path is under the state folder (~/.matlai by default, BPA_STATE_DIR override)', () => {
  assert.equal(defaultLedgerPath({ BPA_STATE_DIR: '/x' }), '/x/bpa-social-ig-ledger.jsonl'); assert.equal(defaultLedgerPath({}), path.join(os.homedir(), '.matlai', 'bpa-social-ig-ledger.jsonl'));
});

// ── worker wiring ─────────────────────────────────────────────────────────────
function fixture(cap) {
  const d = tmp(); const queuePath = path.join(d, 'queue.json'); const ledgerPath = path.join(d, 'ledger.jsonl'); const calls = { ig: 0, lines: [], ledgerAtCall: null };
  saveQueue({ seq: 2, drafts: [
    { id: 'B1', status: 'scheduled', kind: 'signal', text: 'x', sourceDate: '2026-11-01', scheduledFor: '2026-11-02T09:00:00+03:00', ig: { status: 'queued', at: '2026-11-02T09:00:00+03:00' } },
    { id: 'B2', status: 'scheduled', kind: 'signal', text: 'y', sourceDate: '2026-11-01', scheduledFor: '2026-11-02T09:00:00+03:00', ig: { status: 'queued', at: '2026-11-02T09:00:00+03:00' } }] }, queuePath);
  const deps = { now: new Date('2026-11-17T10:00:00Z'), queuePath, igOn: () => true, stopOpts: { flagPath: path.join(d, 'no-flag'), fleetPath: path.join(d, 'no-fleet') }, config: cap === undefined ? {} : { maxInstagramPostsPerDay: cap }, ledgerPath,
    publishIg: async (x) => { calls.ig++; calls.ledgerAtCall = fs.existsSync(ledgerPath) ? lines(ledgerPath).map((l) => l.id) : []; return { permalink: `https://example.invalid/${x.id}` }; },
    postStatus: async () => ({ is_published: false }), notify: async () => true, say: (m) => calls.lines.push(m), approvalHealth: async () => ({ ok: true }) };
  return { d, deps, calls, queuePath, ledgerPath };
}
test('worker: default cap 1 publishes one of two queued items; the other stays queued and the refusal is logged once per day', async () => {
  const { deps, calls, queuePath } = fixture();
  await runWorker(deps); assert.equal(calls.ig, 1);
  const q = loadQueue(queuePath); assert.equal(q.drafts[0].ig.status, 'posted'); assert.equal(q.drafts[1].ig.status, 'queued');
  assert.equal(calls.lines.filter((l) => /B2 .*daily cap 1 reached/.test(l)).length, 1);
  await runWorker({ ...deps, now: new Date('2026-11-17T10:15:00Z') }); assert.equal(calls.ig, 1, 'still capped 15 minutes later'); assert.equal(calls.lines.filter((l) => /daily cap/.test(l)).length, 1, 'no repeated log line the same day');
});
test('worker: the ledger line exists BEFORE the publisher (the network call) runs', async () => {
  const { deps, calls } = fixture(); await runWorker(deps); assert.deepEqual(calls.ledgerAtCall, ['B1']);
});
test('worker: a failed publish keeps the reservation (safe direction) and says so in the log', async () => {
  const { deps, calls, ledgerPath } = fixture(); deps.publishIg = async () => { throw new Error('boom'); };
  await runWorker(deps); assert.deepEqual(lines(ledgerPath).map((l) => l.id), ['B1']); assert.ok(calls.lines.some((l) => /B1 instagram publish failed.*reservation kept.*boom/.test(l)), calls.lines.join('\n'));
});
test('worker: cap 0 and a corrupt ledger publish nothing', async () => {
  { const { deps, calls } = fixture(0); await runWorker(deps); assert.equal(calls.ig, 0); }
  { const { deps, calls, ledgerPath } = fixture(); fs.writeFileSync(ledgerPath, 'garbage\n'); await runWorker(deps); assert.equal(calls.ig, 0); assert.ok(calls.lines.some((l) => /ledger unreadable or corrupt/.test(l))); }
});
test('approval handler: bpa post B1 now with the cap reached posts nothing on Instagram and says why', async () => {
  const d = tmp(); const queuePath = path.join(d, 'queue.json'); const ledgerPath = path.join(d, 'ledger.jsonl');
  saveQueue({ seq: 1, drafts: [{ id: 'B1', status: 'pending_approval', kind: 'outlook', text: 'Outlook text with no figures', sourceDate: '2026-11-17' }] }, queuePath);
  reserveInstagramPublish({ id: 'B0', now: new Date(), path: ledgerPath, config: {} });
  let ig = 0, fb = 0; const out = await handle('bpa post B1 now', { queuePath, ledgerPath, config: {}, stopOpts: { flagPath: path.join(d, 'n'), fleetPath: path.join(d, 'm') }, igOn: () => true, publish: async () => { fb++; return { id: 'p1', permalink_url: 'https://example.invalid/p1' }; }, publishIg: async () => { ig++; return { permalink: 'x' }; } });
  assert.equal(fb, 1); assert.equal(ig, 0); assert.match(out, /Instagram not posted.*daily cap 1 reached/);
});

// ── call sites counted ────────────────────────────────────────────────────────
const read = (f) => fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
test('every Instagram publish call in worker.js and approval-server.js is preceded by a reserve call (counted, ordered)', () => {
  for (const [f, pub, res] of [['worker.js', /\bpublishIg\(/g, /\breserve\(/g], ['approval-server.js', /\bpublishIg\(/g, /\breserve\(/g]]) {
    const s = read(f); const np = (s.match(pub) || []).length, nr = (s.match(res) || []).length;
    assert.ok(np >= 1, `${f}: expected a publishIg call`); assert.ok(nr >= np, `${f}: ${np} publish call(s) but only ${nr} reserve call(s)`);
    assert.ok(s.search(res) < s.search(pub), `${f}: reserve must come before publishIg`);
  }
});
