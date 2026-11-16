import { test } from 'node:test'; import assert from 'node:assert/strict';
import { pickItems, draftFromItem, draftFromForecast, brandGuard, parseCommand, nextSlots, STATUS, renderList } from './lib.js';
const item = (id, conf, mag, region = 'zanzibar') => ({ signal: { id, subject: 'Sauti za Busara', region, summary: 'The festival dates were confirmed for February.', confidence: conf, magnitude: mag, sourceIds: ['a', 'b'] }, whyItMatters: 'Beds in Stone Town fill a month early.', whatToDo: 'Open February availability now.', confidence: conf, sources: [{ id: 'a' }, { id: 'b' }] });
test('pickItems dedupes by signal id and ranks by confidence×magnitude', () => {
  const briefs = [{ date: '2026-09-10', items: [item('x', 0.9, 1), item('y', 0.7, 3)] }, { date: '2026-09-11', items: [item('x', 0.9, 1)] }];
  const out = pickItems(briefs, 3); assert.equal(out.length, 2); assert.equal(out[0].signal.id, 'y');
});
test('draftFromItem writes first person, full brand, date, no links', () => {
  const d = draftFromItem({ ...item('x', 0.88, 1), date: '2026-09-11' });
  assert.match(d.text, /Sauti za Busara — Zanzibar, 11 September 2026/); assert.match(d.text, /What I'd do:/);
  assert.match(d.text, /— Tim, Beyond Paradise Adventures/); assert.doesNotMatch(d.text, /https?:/); assert.equal(brandGuard(d.text), null);
});
test('brandGuard rejects the short brand name and links', async () => {
  assert.match(brandGuard('Hello from Beyond Paradise today'), /in full/); assert.equal(brandGuard('Beyond Paradise Adventures'), null);
  // links are gated by config.includeLinks (false until the site went live on 2026-09-14)
  const { CONFIG } = await import('./lib.js');
  if (CONFIG.includeLinks) assert.equal(brandGuard('see https://beyondparadiseadventures.com/x'), null); else assert.match(brandGuard('see https://x.y'), /links are disabled/);
});
test('draftFromForecast renders both regions', () => {
  const d = draftFromForecast({ date: '2026-09-13', forecasts: [{ region: 'zanzibar', direction: 'rising', confidence: 0.82, drivers: ['Peak dry season'] }, { region: 'dar-es-salaam', direction: 'rising', confidence: 0.82, drivers: [] }] });
  assert.match(d.text, /Zanzibar: rising \(82% confidence\) — Peak dry season/); assert.match(d.text, /Dar es Salaam: rising/); assert.equal(d.kind, 'outlook');
});
test('parseCommand handles the bpa family', () => {
  assert.deepEqual(parseCommand('bpa'), { cmd: 'list' }); assert.deepEqual(parseCommand('BPA approve b1 B2'), { cmd: 'approve', ids: ['B1', 'B2'] });
  assert.deepEqual(parseCommand('bpa skip b3'), { cmd: 'skip', ids: ['B3'] }); assert.equal(parseCommand('bpa edit B1: new words').text, 'new words');
  assert.deepEqual(parseCommand('bpa post b2 now'), { cmd: 'postnow', ids: ['B2'] }); assert.equal(parseCommand('bpa dance').cmd, 'unknown');
});
test('nextSlots skips days already scheduled and is one per day', () => {
  const now = new Date('2026-09-13T12:00:00Z');
  const q = { drafts: [{ status: STATUS.SCHEDULED, scheduledFor: '2026-09-14T09:00:00+03:00' }] };
  const s = nextSlots(q, 2, now); assert.deepEqual(s, ['2026-09-15T09:00:00+03:00', '2026-09-16T09:00:00+03:00']);
});
test('renderList shows commands', () => { assert.match(renderList({ drafts: [{ id: 'B1', status: STATUS.PENDING, kind: 'outlook', sourceDate: '2026-09-13', text: 'x' }] }), /bpa approve B1 B2/); });
import { cardSpec } from './lib.js';
test('cardSpec derives label/headline/tag/lines from a draft', () => {
  const d = { id: 'B1', kind: 'outlook', region: 'all', sourceDate: '2026-09-13', text: 'Demand outlook, next 8 weeks — 13 September 2026\n\nZanzibar: rising (82% confidence) — Peak dry season\nDar es Salaam: rising (82% confidence)\n\nThis is what my intelligence engine reads.\n— Tim, Beyond Paradise Adventures\n\n#BeyondParadiseAdventures' };
  const s = cardSpec(d); assert.equal(s.headline, 'Demand outlook, next 8 weeks'); assert.equal(s.date, '13 September 2026'); assert.match(s.tag, /Zanzibar & Dar/); assert.equal(s.lines.length, 2); assert.equal(s.label, 'Demand outlook · next 8 weeks');
});
import { outlookIsFresh, outlookSignature } from './lib.js';
test('outlook is drafted only when content changes or 14 days passed', () => {
  const fc = { date: '2026-09-14', forecasts: [{ region: 'zanzibar', direction: 'rising', drivers: ['Peak dry season'] }] };
  const sig = outlookSignature(fc); const now = new Date('2026-09-14T04:00:00Z');
  assert.equal(outlookIsFresh(fc, [], now), true);
  assert.equal(outlookIsFresh(fc, [{ kind: 'outlook', signature: sig, createdAt: '2026-09-13T13:55:00Z' }], now), false, 'same content → no');
  assert.equal(outlookIsFresh(fc, [{ kind: 'outlook', signature: 'other', createdAt: '2026-09-13T13:55:00Z' }], now), false, 'different content but <14 days → no');
  assert.equal(outlookIsFresh(fc, [{ kind: 'outlook', signature: 'other', createdAt: '2026-08-20T13:55:00Z' }], now), true, 'different content and 14+ days → yes');
});

// ── audit fixes (2026-11): queue lock/merge, publish claim, source gate, tz slots, auth, pinned CDN, no PII default ──
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { stuckIgPublishes, markStuckAlerted, withQueueLock, mergeQueue, claimIgPublish, loadQueue, saveQueue, sourceGate, buildDrafts, whatsapp } from './lib.js';
import { authorize } from './auth.js';
import { buildComposition } from './video.js';
const tmpq = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bpaq-')), 'queue.json');
test('withQueueLock runs concurrent critical sections serially', async () => {
  const lockPath = tmpq() + '.lock'; let active = 0, max = 0; const order = [];
  const job = (n) => withQueueLock(async () => { active++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, 30)); order.push(n); active--; }, { lockPath, pollMs: 5 });
  await Promise.all([job(1), job(2), job(3)]); assert.equal(max, 1); assert.equal(order.length, 3); assert.equal(fs.existsSync(lockPath), false);
});
test('withQueueLock breaks a stale lock', async () => {
  const lockPath = tmpq() + '.lock'; fs.writeFileSync(lockPath, '1'); const old = new Date(Date.now() - 3600e3); fs.utimesSync(lockPath, old, old);
  assert.equal(await withQueueLock(async () => 'ok', { lockPath, staleMs: 1000 }), 'ok');
});
test('withQueueLock never deletes a lock it no longer owns', async () => {
  const lockPath = tmpq() + '.lock';
  await withQueueLock(async () => { fs.unlinkSync(lockPath); fs.writeFileSync(lockPath, 'other-owner'); }, { lockPath });
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'other-owner', "another process's lock survives our release");
});
test('withQueueLock: concurrent waiters on one stale lock still run one at a time', async () => {
  const lockPath = tmpq() + '.lock'; fs.writeFileSync(lockPath, 'dead'); const old = new Date(Date.now() - 3600e3); fs.utimesSync(lockPath, old, old);
  let active = 0, max = 0;
  const job = () => withQueueLock(async () => { active++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, 20)); active--; }, { lockPath, staleMs: 1000, pollMs: 2 });
  await Promise.all([job(), job(), job(), job()]); assert.equal(max, 1); assert.equal(fs.existsSync(lockPath), false);
  assert.deepEqual(fs.readdirSync(path.dirname(lockPath)).filter((f) => f.includes('.stale')), [], 'no stale leftovers');
});
test('worker snapshot save does not undo a skip made by the approval server', () => {
  const base = { drafts: [{ id: 'B1', status: STATUS.PENDING, text: 'a' }, { id: 'B2', status: STATUS.SCHEDULED, postId: null }], state: {} };
  const mine = JSON.parse(JSON.stringify(base)); mine.drafts[0].status = STATUS.EXPIRED; mine.drafts[1].status = STATUS.POSTED; mine.state.lastRunOk = 'now';
  const fresh = JSON.parse(JSON.stringify(base)); fresh.drafts[0].status = STATUS.SKIPPED; fresh.drafts[1].postId = 'p1';
  const m = mergeQueue(base, mine, fresh);
  assert.equal(m.drafts[0].status, STATUS.SKIPPED, 'server decision wins'); assert.equal(m.drafts[1].status, STATUS.POSTED, 'worker change kept'); assert.equal(m.drafts[1].postId, 'p1', 'server field kept'); assert.equal(m.state.lastRunOk, 'now');
});
test('claimIgPublish marks publishing once; a second claim gets nothing', async () => {
  const p = tmpq(); saveQueue({ seq: 1, drafts: [{ id: 'B1', status: STATUS.SCHEDULED, ig: { status: 'queued', at: 'x' } }] }, p);
  const first = await claimIgPublish('B1', new Date(), p); assert.equal(first.status, 'publishing'); assert.equal(loadQueue(p).drafts[0].ig.status, 'publishing');
  assert.equal(await claimIgPublish('B1', new Date(), p), null, 'already publishing → not republished');
});
test('sourceGate / buildDrafts reject signal drafts with fewer than 2 sources', async () => {
  const one = item('s1', 0.9, 1); one.sources = [{ id: 'a' }]; one.signal.sourceIds = ['a'];
  assert.match(sourceGate(draftFromItem({ ...one, date: '2026-09-11' })), /fewer than 2/); assert.equal(sourceGate(draftFromItem({ ...item('s2', 0.9, 1), date: '2026-09-11' })), null);
  const out = await buildDrafts({ briefs: [{ date: '2026-09-11', items: [one] }], existingDrafts: [] });
  assert.match(out[0].rejected, /fewer than 2/);
});
test('nextSlots uses the Africa/Dar_es_Salaam day, not the UTC day', () => {
  const s = nextSlots({ drafts: [] }, 1, new Date('2026-11-02T22:30:00Z')); assert.deepEqual(s, ['2026-11-04T09:00:00+03:00']);
  const t = nextSlots({ drafts: [{ status: STATUS.SCHEDULED, scheduledFor: '2026-11-04T09:00:00+03:00' }] }, 1, new Date('2026-11-02T22:30:00Z')); assert.deepEqual(t, ['2026-11-05T09:00:00+03:00']);
});
test('authorize: fail closed, host, content-type and token checks', () => {
  const req = (h) => ({ headers: { host: '127.0.0.1:3028', 'content-type': 'application/json', 'x-bpa-token': 's3cret', ...h } });
  assert.equal(authorize(req(), {}).code, 503); assert.equal(authorize(req(), {}).ok, false);
  const env = { BPA_APPROVAL_TOKEN: 's3cret' };
  assert.equal(authorize(req({ host: 'evil.example:3028' }), env).code, 403); assert.equal(authorize(req({ host: '127.0.0.1:9999' }), env).code, 403);
  assert.equal(authorize(req({ 'x-bpa-token': undefined }), env).code, 401); assert.equal(authorize(req({ 'x-bpa-token': 'wrong' }), env).code, 401);
  assert.equal(authorize(req({ 'content-type': 'text/plain' }), env).code, 415);
  assert.equal(authorize(req(), env).ok, true); assert.equal(authorize(req({ host: 'localhost:3028' }), env).ok, true);
});
test('reel composition fetches nothing over the network (gsap and fonts come from node_modules)', () => {
  const html = buildComposition({ headline: 'h', lines: [], brand: 'b', label: 'l', tag: 't', date: 'd' });
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcs.length, 'the composition still needs its animation script');
  for (const s of srcs) assert.doesNotMatch(s, /^(https?:)?\/\//, `remote script in the render: ${s}`);
  for (const m of html.matchAll(/<link[^>]+href="([^"]+)"/g)) assert.doesNotMatch(m[1], /^(https?:)?\/\//, `remote stylesheet in the render: ${m[1]}`);
  assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/, 'brand fonts must be local: an offline render has to look right');
  const faces = [...html.matchAll(/@font-face\{[^}]*src:url\(([^)]+)\)/g)].map((m) => m[1]);
  assert.equal(faces.length, 3, 'Playfair 700 italic + Inter 400 + Inter 600');
  for (const f of faces) assert.doesNotMatch(f, /^(https?:)?\/\//, `remote font in the render: ${f}`);
});
test('the reel footer tagline comes from config, not from the renderer', async () => {
  const { CONFIG, cardSpec: spec } = await import('./lib.js');
  assert.ok(CONFIG.reelTagline, 'config.json must carry reelTagline (the published footer claim is Tim\'s to word)');
  const s = spec({ id: 'B1', kind: 'outlook', region: 'all', sourceDate: '2026-09-13', text: 'Head — 13 September 2026\n\nline one\n' });
  assert.equal(s.tagline, CONFIG.reelTagline, 'cardSpec must always supply it, so the footer cannot silently empty');
  assert.match(buildComposition({ headline: 'h', lines: [], brand: 'b', label: 'l', tag: 't', date: 'd', tagline: 'From config' }), /From config/);
  for (const f of ['./video.js', './card.py']) assert.doesNotMatch(fs.readFileSync(new URL(f, import.meta.url), 'utf8'), /Daily tourism intelligence/, `no tagline baked into ${f}`);
});
test('README and config.json agree on whether links go into posts', () => {
  const readme = fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  const cfg = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
  const m = readme.match(/`includeLinks:\s*(true|false)`/);
  assert.ok(m, 'README must state the includeLinks value it documents');
  assert.equal(m[1], String(cfg.includeLinks), 'README and config.json must not drift (audit finding 7)');
});
test('HERE decodes a percent-encoded module path (a space in a directory name)', async () => {
  const { modulePath } = await import('./resources.js');
  assert.equal(modulePath('file:///tmp/My%20Projects/social/lib.js'), '/tmp/My Projects/social/lib.js');
  assert.doesNotMatch(fs.readFileSync(new URL('./lib.js', import.meta.url), 'utf8'), /new URL\(import\.meta\.url\)\.pathname/);
});
test('whatsapp() fails closed without WHATSAPP_ALERT_TO and no phone number is committed', async () => {
  const prev = process.env.WHATSAPP_ALERT_TO; const prevF = process.env.WHATSAPP_ALERT_TO_FILE; delete process.env.WHATSAPP_ALERT_TO; process.env.BPA_QUIET = '1';
  process.env.WHATSAPP_ALERT_TO_FILE = path.join(os.tmpdir(), 'bpa-no-such-alert-file'); // never read the owner's real private file in a test
  assert.equal(await whatsapp('x'), false); if (prev) process.env.WHATSAPP_ALERT_TO = prev; if (prevF === undefined) delete process.env.WHATSAPP_ALERT_TO_FILE; else process.env.WHATSAPP_ALERT_TO_FILE = prevF;
  assert.doesNotMatch(fs.readFileSync(new URL('./lib.js', import.meta.url), 'utf8'), /\+255\d{6,}/);
});

test('stuck IG publish is alerted once per draft, not on every run', () => {
  const now = new Date('2026-11-01T10:00:00Z');
  const q = { drafts: [
    { id: 'B1', ig: { status: 'publishing', publishingAt: '2026-11-01T09:00:00Z' } },
    { id: 'B2', ig: { status: 'publishing', publishingAt: '2026-11-01T09:50:00Z' } },
    { id: 'B3', ig: { status: 'posted' } }] };
  assert.deepEqual(stuckIgPublishes(q, now), ['B1'], 'only >30 min in publishing');
  markStuckAlerted(q, ['B1'], now);
  assert.equal(q.drafts[0].ig.stuckAlertedAt, now.toISOString()); assert.equal(q.drafts[0].ig.status, 'publishing', 'status untouched (human verifies on Meta)');
  assert.deepEqual(stuckIgPublishes(q, new Date('2026-11-01T16:00:00Z')), ['B2'], 'B1 already alerted → silent; B2 newly stuck');
});

test('a re-claimed IG publish that gets stuck again is alerted again (old stuckAlertedAt does not silence it)', async () => {
  const p = tmpq(); const t0 = new Date('2026-11-01T09:00:00Z');
  saveQueue({ drafts: [{ id: 'B1', status: STATUS.SCHEDULED, ig: { status: 'queued' } }], state: {} }, p);
  await claimIgPublish('B1', t0, p);
  let q = loadQueue(p); assert.deepEqual(stuckIgPublishes(q, new Date('2026-11-01T10:00:00Z')), ['B1']);
  markStuckAlerted(q, ['B1'], new Date('2026-11-01T10:00:00Z'));
  q.drafts[0].ig.status = 'queued'; saveQueue(q, p); // human reset after checking Meta
  await claimIgPublish('B1', new Date('2026-11-02T09:00:00Z'), p);
  q = loadQueue(p); assert.deepEqual(stuckIgPublishes(q, new Date('2026-11-02T10:00:00Z')), ['B1']);
});

// ── Instagram switched on in config but off in practice must be LOUD (2026-11-15: 2 months of silent Facebook-only posts) ──
import { igStatus, igGate } from './lib.js';
const tokensFile = (user) => { const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bpatok-')), 'tokens.json'); if (user !== undefined) fs.writeFileSync(p, JSON.stringify({ user })); return p; };
const CFG_ON = { instagram: { enabled: true } };
test('igStatus: says WHY Instagram is off, and igEnabled agrees with it', () => {
  assert.deepEqual(igStatus({ config: { instagram: { enabled: false } }, tokensPath: tokensFile({ scopes: ['instagram_content_publish'] }) }), { configEnabled: false, enabled: false, reason: 'disabled in config.json' });
  const ok = igStatus({ config: CFG_ON, tokensPath: tokensFile({ scopes: ['public_profile', 'instagram_content_publish'] }) }); assert.equal(ok.enabled, true); assert.equal(ok.reason, null);
  assert.equal(igStatus({ config: CFG_ON, tokensPath: tokensFile({ igPublishOk: true }) }).enabled, true);
  const noScopes = igStatus({ config: CFG_ON, tokensPath: tokensFile({ token: 'x' }) }); assert.equal(noScopes.enabled, false); assert.match(noScopes.reason, /user\.scopes is missing/);
  const lacking = igStatus({ config: CFG_ON, tokensPath: tokensFile({ scopes: ['public_profile'] }) }); assert.equal(lacking.enabled, false); assert.match(lacking.reason, /instagram_content_publish is not in user\.scopes/);
  const gone = igStatus({ config: CFG_ON, tokensPath: path.join(os.tmpdir(), 'bpa-no-such-dir', 'tokens.json') }); assert.equal(gone.enabled, false); assert.match(gone.reason, /unreadable/);
  for (const r of [noScopes.reason, lacking.reason, gone.reason]) assert.doesNotMatch(r, /token":|EAA/);
});
const blockedStatus = { configEnabled: true, enabled: false, reason: 'user.scopes is missing from the tokens file' };
const okStatus = { configEnabled: true, enabled: true, reason: null };
const gateQueue = () => ({ drafts: [
  { id: 'B1', status: STATUS.POSTED }, { id: 'B2', status: STATUS.SCHEDULED, scheduledFor: '2026-11-17T09:00:00+03:00' },
  { id: 'B3', status: STATUS.SCHEDULED, ig: { status: 'queued', at: '2026-11-17T09:00:00+03:00' } }, { id: 'B4', status: STATUS.PENDING }, { id: 'B5', status: STATUS.SCHEDULED, ig: { status: 'posted' } }], state: {} });
const harness = () => { const lines = []; const sent = []; const h = { lines, sent, ok: true, say: (m) => lines.push(m), notify: async (m) => { sent.push(m); return h.ok; } }; return h; };
test('igGate: Instagram on in config but off in practice -> one log line per affected post, ONE alert, nothing more on later runs', async () => {
  const q = gateQueue(); const h = harness(); const t = (min) => new Date(Date.UTC(2026, 10, 15, 8, min));
  assert.equal(await igGate(q, { now: t(0), status: blockedStatus, notify: h.notify, say: h.say }), true);
  const skipLines = h.lines.filter((l) => /instagram NOT published/.test(l)); assert.deepEqual(skipLines.map((l) => l.split(' ')[0]), ['B2', 'B3'], 'only the posts that will really miss Instagram');
  for (const l of skipLines) assert.match(l, /user\.scopes is missing/);
  assert.equal(h.sent.length, 1); assert.match(h.sent[0], /Instagram/); assert.match(h.sent[0], /B2, B3/); assert.match(h.sent[0], /user\.scopes is missing/); assert.match(h.sent[0], /--refresh-scopes/);
  assert.equal(q.state.igGate, 'blocked');
  for (let i = 1; i <= 5; i++) await igGate(q, { now: t(i * 15), status: blockedStatus, notify: h.notify, say: h.say });
  assert.equal(h.sent.length, 1, 'later runs in the same state send nothing'); assert.equal(h.lines.filter((l) => /instagram NOT published/.test(l)).length, 2, 'each post is logged once, not on every 15-minute run');
});
test('igGate: a post that becomes affected later is logged once; an alert that failed to send is retried, but the log lines are not repeated', async () => {
  const q = gateQueue(); const h = harness(); h.ok = false;
  await igGate(q, { now: new Date('2026-11-15T08:00:00Z'), status: blockedStatus, notify: h.notify, say: h.say });
  await igGate(q, { now: new Date('2026-11-15T08:15:00Z'), status: blockedStatus, notify: h.notify, say: h.say });
  assert.equal(h.sent.length, 2, 'bridge was down: not recorded as alerted, so it tries again'); assert.equal(h.lines.filter((l) => /B2 instagram NOT published/.test(l)).length, 1);
  h.ok = true; q.drafts.push({ id: 'B6', status: STATUS.SCHEDULED });
  await igGate(q, { now: new Date('2026-11-15T08:30:00Z'), status: blockedStatus, notify: h.notify, say: h.say });
  assert.equal(h.sent.length, 3); assert.match(h.sent[2], /B6/); assert.equal(h.lines.filter((l) => /B6 instagram NOT published/.test(l)).length, 1);
  await igGate(q, { now: new Date('2026-11-15T08:45:00Z'), status: blockedStatus, notify: h.notify, say: h.say }); assert.equal(h.sent.length, 3);
});
test('igGate: recovery is announced once, and a later relapse is a NEW state change (alert + log again)', async () => {
  const q = gateQueue(); const h = harness();
  await igGate(q, { now: new Date('2026-11-15T08:00:00Z'), status: blockedStatus, notify: h.notify, say: h.say });
  await igGate(q, { now: new Date('2026-11-15T09:00:00Z'), status: okStatus, notify: h.notify, say: h.say });
  assert.equal(h.sent.length, 2); assert.match(h.sent[1], /back on/); assert.equal(q.state.igGate, 'ok');
  await igGate(q, { now: new Date('2026-11-15T09:15:00Z'), status: okStatus, notify: h.notify, say: h.say }); assert.equal(h.sent.length, 2);
  await igGate(q, { now: new Date('2026-11-15T10:00:00Z'), status: blockedStatus, notify: h.notify, say: h.say });
  assert.equal(h.sent.length, 3); assert.match(h.sent[2], /switched on|OFF/i); assert.equal(h.lines.filter((l) => /B2 instagram NOT published/.test(l)).length, 2);
});
test('igGate: Instagram deliberately off in config, or healthy from the start, is silent', async () => {
  const h = harness();
  const off = gateQueue(); await igGate(off, { now: new Date(), status: { configEnabled: false, enabled: false, reason: 'disabled in config.json' }, notify: h.notify, say: h.say }); assert.equal(off.state.igGate, 'ok', 'not a fault: never "blocked"');
  const fine = gateQueue(); await igGate(fine, { now: new Date(), status: okStatus, notify: h.notify, say: h.say });
  assert.equal(h.sent.length, 0); assert.equal(h.lines.length, 0); assert.equal(fine.state.igGate, 'ok');
});
test('igGate: blocked with nothing scheduled still raises the alarm once (the NEXT approval would go Facebook-only)', async () => {
  const q = { drafts: [{ id: 'B1', status: STATUS.PENDING }], state: {} }; const h = harness();
  await igGate(q, { now: new Date(), status: blockedStatus, notify: h.notify, say: h.say }); await igGate(q, { now: new Date(), status: blockedStatus, notify: h.notify, say: h.say });
  assert.equal(h.sent.length, 1); assert.match(h.sent[0], /next|approved/i);
});
test('igGate state survives the worker/approval-server merge (a worker-written igGate is not lost)', async () => {
  const base = gateQueue(); const mine = JSON.parse(JSON.stringify(base)); const h = harness();
  await igGate(mine, { now: new Date('2026-11-15T08:00:00Z'), status: blockedStatus, notify: h.notify, say: h.say });
  const merged = mergeQueue(base, mine, JSON.parse(JSON.stringify(base)));
  assert.equal(merged.state.igGate, 'blocked'); assert.ok(merged.state.igBlockedAlertedAt); assert.ok(merged.drafts.find((d) => d.id === 'B2').igSkipNotedAt);
});
test('worker.js is wired: it imports igGate and calls it exactly once, before the state is saved', () => {
  const w = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  assert.match(w.split('\n')[2], /\bigGate\b/, 'imported'); assert.equal((w.match(/igGate\(/g) || []).length, 1);
  assert.ok(w.indexOf('igGate(') < w.indexOf('saveQueue(mergeQueue'), 'runs before the queue is saved, or its state would be lost');
});

// ── outlook post: the exchange rate has a single source, so it never goes into the public text ──
const AFFORD = 'Affordability backdrop: EUR ≈ 2,905.2 TZS.';
const fcWith = (drivers) => ({ date: '2026-11-16', forecasts: [{ region: 'zanzibar', direction: 'rising', confidence: 0.8, drivers }] });
test('draftFromForecast drops the single-source exchange-rate driver', () => {
  const d = draftFromForecast(fcWith(['Mostly drier months over the next ~8 weeks: Nov and Jan dry, Dec wetter.', AFFORD]));
  assert.match(d.text, /Mostly drier months/); assert.doesNotMatch(d.text, /Affordability/); assert.doesNotMatch(d.text, /EUR/); assert.doesNotMatch(d.text, /TZS/);
});
test('draftFromForecast lets a third driver move up when the affordability one is dropped', () => {
  const d = draftFromForecast(fcWith([AFFORD, 'A', 'B']));
  assert.match(d.text, /Zanzibar: rising \(80% confidence\) — A; B\n/);
});
test('draftFromForecast with only the affordability driver has no driver part', () => {
  const d = draftFromForecast(fcWith([AFFORD.toUpperCase()]));
  const line = d.text.split('\n').find((l) => l.startsWith('Zanzibar:'));
  assert.equal(line, 'Zanzibar: rising (80% confidence)'); assert.ok(!line.includes(' — '));
});

// ── alert number: variable first, then a private file outside the repo, never a literal in the repo ──
import { alertNumber } from './lib.js';
const fakeNum = (d) => '+' + String(d).repeat(11); // built at runtime, obviously fake
const alertFile = (content) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bpaalert-')), 'whatsapp-alert-to'); if (content !== null) fs.writeFileSync(f, content); return f; };
test('alertNumber: the environment variable wins over the file', () => {
  assert.equal(alertNumber({ env: { WHATSAPP_ALERT_TO: fakeNum(1) }, file: alertFile(fakeNum(2) + '\n') }), fakeNum(1));
});
test('alertNumber: variable unset falls back to the file number', () => {
  assert.equal(alertNumber({ env: {}, file: alertFile(fakeNum(2) + '\n') }), fakeNum(2));
});
test('alertNumber: a whitespace-only variable falls through to the file', () => {
  assert.equal(alertNumber({ env: { WHATSAPP_ALERT_TO: '   ' }, file: alertFile(fakeNum(3)) }), fakeNum(3));
});
test('alertNumber: missing file gives null, never throws', () => {
  assert.equal(alertNumber({ env: {}, file: alertFile(null) }), null);
});
test('alertNumber: a line that is not a number gives null', () => {
  assert.equal(alertNumber({ env: {}, file: alertFile('call me\n') }), null);
});
test('alertNumber: a blank first line is skipped, the next non-empty line is used', () => {
  assert.equal(alertNumber({ env: {}, file: alertFile('\n  \n' + fakeNum(4) + '\n') }), fakeNum(4));
});
