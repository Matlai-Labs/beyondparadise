import './test-env.js';
// The page's own script, run for real in a stub DOM (no source-text searches): a decision click, a key press with and without focus in the edit box,
// Undo in the decided list, a network error, and the two taps of the Stop button. The stub is the smallest one that lets those run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(HERE, 'review-page.html'), 'utf8');
const markup = html.split('<script')[0];
const SCRIPT = html.slice(html.indexOf('<script nonce="__NONCE__">') + '<script nonce="__NONCE__">'.length, html.lastIndexOf('</script>'));
const V = (c) => c.repeat(64);

class El {
  constructor(tag, id) { this.tagName = String(tag).toUpperCase(); this.id = id || ''; this.children = []; this.parent = null; this._text = ''; this.attrs = {}; this.listeners = {}; this.hidden = new Set(); this.disabled = false; this.value = ''; this.style = {}; this.className = ''; this.focused = 0; this.open = false; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get firstChild() { return this.children[0] || null; }
  get classList() { const s = this.hidden; return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c), toggle: (c, f) => { const on = f === undefined ? !s.has(c) : Boolean(f); if (on) s.add(c); else s.delete(c); return on; } }; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  remove() { if (this.parent) this.parent.removeChild(this); }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  focus() { this.focused += 1; }
  descendants(tag) { const out = []; const walk = (n) => { for (const c of n.children) { if (!tag || c.tagName === tag.toUpperCase()) out.push(c); walk(c); } }; walk(this); return out; }
  querySelectorAll(sel) { return this.descendants(sel); }
  pause() {} load() {} play() { return Promise.resolve(); }
  click() { const e = { target: this, stopPropagation() {}, preventDefault() {} }; for (const fn of this.listeners.click || []) fn(e); }
}

/** Run the page. `server` answers the fetches: items() -> object, decide(body) -> object|Error, posting(body) -> object|Error. */
async function openPage(server) {
  const byId = new Map(); const docListeners = {};
  for (const m of markup.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"/g)) byId.set(m[2], new El(m[1], m[2]));
  const filters = byId.get('filters'); for (const m of markup.matchAll(/<button\b[^>]*data-kind="(\w+)"[^>]*>/g)) { const b = new El('button'); b.setAttribute('data-kind', m[1]); filters.appendChild(b); }
  const calls = []; const timers = []; let reloads = 0;
  const respond = (status, obj) => ({ status, ok: status >= 200 && status < 300, json: async () => obj });
  const fetch = async (url, init = {}) => {
    const rec = { url, method: init.method || 'GET', headers: init.headers || {}, body: init.body === undefined ? undefined : JSON.parse(init.body) }; calls.push(rec);
    if (url === 'api/items') return respond(200, server.items());
    if (url === 'api/session') return respond(200, { ok: true, token: 'tok-1' });
    if (url === 'api/decide' || url === 'api/posting') { const r = server[url === 'api/decide' ? 'decide' : 'posting'](rec.body); if (r instanceof Error) throw r; return respond(r.ok === true ? 200 : 409, r); }
    return respond(200, {});
  };
  const document = {
    getElementById: (id) => { const e = byId.get(id); if (!e) throw new Error(`no element ${id}`); return e; },
    createElement: (t) => new El(t), createTextNode: (t) => { const n = new El('#text'); n.textContent = t; return n; },
    querySelectorAll: (sel) => (sel === '#filters button[data-kind]' ? filters.children.filter((c) => c.tagName === 'BUTTON' && c.getAttribute('data-kind')) : sel === '#decided-list button' ? byId.get('decided-list').descendants('button') : []),
    addEventListener: (t, fn) => { (docListeners[t] ||= []).push(fn); },
  };
  const store = new Map();
  const ctx = vm.createContext({ document, fetch, console, window: { matchMedia: (q) => ({ matches: !/reduce/.test(q) }) }, sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }, location: { reload: () => { reloads += 1; } }, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {} });
  vm.runInContext(SCRIPT, ctx);
  const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
  await flush();
  const key = (k, over = {}, target = new El('body')) => { const e = { key: k, repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target, preventDefault() { this.prevented = true; }, ...over }; for (const fn of docListeners.keydown || []) fn(e); return e; };
  const $ = (id) => byId.get(id);
  return { $, calls, timers, flush, key, reloads: () => reloads, posts: (u) => calls.filter((c) => c.method === 'POST' && c.url === u) };
}

const hookItem = (over = {}) => ({ kind: 'hook', id: 'idea_1', version: V('a'), title: 'Lions sleep up to 20 hours', preview: { mediaId: null, note: 'no example video yet' }, facts: { hook: 'Lions sleep up to 20 hours', claims: [] }, state: 'unapproved', reason: 'not-approved', usableToday: false, decision: null, actions: ['approve', 'skip', 'edit'], ...over });
const decidedItem = () => hookItem({ id: 'idea_2', version: V('b'), title: 'Done earlier', state: 'approved', reason: null, decision: { kind: 'approved', at: '2026-11-17T08:00:00Z' }, actions: ['undo'] });
const status = (stop = { stopped: false, reason: null }) => ({ autoLane: 'off', stop, lastPost: 'none', lastRun: 'unknown' });
function serverOf(over = {}) {
  const s = { items: () => ({ status: s.status, items: s.list, counts: { all: s.list.length, hook: s.list.length, clip: 0 }, problems: [] }), status: status(), list: [hookItem(), decidedItem()],
    decide: () => ({ ok: true, change: { kind: 'hook', id: 'idea_1', decision: 'approved' } }), posting: () => ({ ok: true }), ...over }; return s;
}

test('DOM: the page loads: the waiting card shows, the decided one is under What I decided; no decision is sent on load', async () => {
  const p = await openPage(serverOf());
  assert.equal(p.$('card-title').textContent, 'Lions sleep up to 20 hours'); assert.equal(p.$('decided-summary').textContent, 'What I decided (1)');
  assert.equal(p.$('act-approve').hidden.has('hidden'), false); assert.equal(p.posts('api/decide').length, 0);
});

test('DOM: a click on Approve sends exactly one decision (the card, its version, the token), a second click while it is saving sends none, the notice and the card update', async () => {
  const s = serverOf(); s.decide = (b) => { s.list = [{ ...hookItem(), state: 'approved', decision: { kind: 'approved', at: '2026-11-17T09:00:00Z' }, actions: ['undo'] }, decidedItem()]; return { ok: true, change: { kind: 'hook', id: b.id, decision: 'approved' } }; };
  const p = await openPage(s);
  p.$('act-approve').click(); p.$('act-approve').click(); await p.flush();
  const posts = p.posts('api/decide'); assert.equal(posts.length, 1, 'one POST');
  assert.deepEqual(posts[0].body, { kind: 'hook', id: 'idea_1', version: V('a'), action: 'approve' }); assert.equal(posts[0].headers['X-Bpa-Action'], 'tok-1'); assert.equal(posts[0].headers['Content-Type'], 'application/json');
  assert.equal(p.$('notice').textContent, 'Approved. You can undo it under What I decided.');
  assert.equal(p.$('state').textContent, 'Nothing waits here. Pick another filter.', 'the decided card left the waiting list'); assert.equal(p.$('decided-summary').textContent, 'What I decided (2)');
});

test('DOM: a refused decision shows its plain sentence and sends nothing more; a card that changed reloads the list', async () => {
  const s = serverOf({ decide: () => ({ ok: false, code: 'version-changed' }) }); const p = await openPage(s); const loads = () => p.calls.filter((c) => c.url === 'api/items').length; const before = loads();
  p.$('act-skip').click(); await p.flush();
  assert.equal(p.posts('api/decide').length, 1); assert.equal(p.$('notice').textContent, 'This changed after you looked at it. The card is loaded again. Please look at it once more.'); assert.ok(loads() > before, 'the list was reloaded');
});

test('DOM: a network error on a decision says it may have been saved (not the old "did not work" sentence)', async () => {
  const p = await openPage(serverOf({ decide: () => new Error('offline') }));
  p.$('act-approve').click(); await p.flush();
  assert.match(p.$('notice').textContent, /may have been saved/); assert.doesNotMatch(p.$('notice').textContent, /That did not work/); assert.equal(p.posts('api/decide').length, 1);
});

test('DOM: a key does nothing while the edit box has focus; Escape closes the box; the same key outside the box approves once; Shift+A and Ctrl+A do nothing', async () => {
  const p = await openPage(serverOf());
  p.key('e'); assert.equal(p.$('edit-box').hidden.has('hidden'), false, 'E opens the edit box'); assert.equal(p.$('edit-text').focused > 0, true);
  const typing = p.key('a', {}, p.$('edit-text')); p.key('s', {}, p.$('edit-text')); await p.flush();
  assert.equal(p.posts('api/decide').length, 0, 'typing a letter in the box decides nothing'); assert.equal(typing.prevented, undefined);
  p.key('a'); await p.flush(); assert.equal(p.posts('api/decide').length, 0, 'also not with the box open and the focus elsewhere');
  p.key('Escape'); assert.equal(p.$('edit-box').hidden.has('hidden'), true, 'Escape closes it');
  p.key('A', { shiftKey: true }); p.key('a', { ctrlKey: true }); await p.flush(); assert.equal(p.posts('api/decide').length, 0);
  p.key('a'); await p.flush(); const posts = p.posts('api/decide'); assert.equal(posts.length, 1); assert.equal(posts[0].body.action, 'approve');
});

test('DOM: Undo in the decided list sends the undo for that decided card', async () => {
  const s = serverOf({ decide: (b) => { s.list = [hookItem(), hookItem({ id: 'idea_2', version: V('b'), title: 'Done earlier' })]; return { ok: true, change: { kind: 'hook', id: b.id, decision: 'undone' } }; } });
  const p = await openPage(s); const undo = p.$('decided-list').descendants('button'); assert.equal(undo.length, 1); assert.equal(undo[0].textContent, 'Undo');
  undo[0].click(); await p.flush();
  const posts = p.posts('api/decide'); assert.equal(posts.length, 1); assert.deepEqual(posts[0].body, { kind: 'hook', id: 'idea_2', version: V('b'), action: 'undo' });
  assert.equal(p.$('notice').textContent, 'Undone. It is back in the waiting list.'); assert.equal(p.$('decided-summary').textContent, 'What I decided (0)');
});

test('DOM: Stop all posting: the first tap reads the real state first and sends nothing, the second sends the stop', async () => {
  const s = serverOf(); const p = await openPage(s); const loads = () => p.calls.filter((c) => c.url === 'api/items').length; const before = loads();
  p.$('stop-all').click(); await p.flush(); assert.ok(loads() > before, 'the status was reloaded on the first tap'); assert.equal(p.posts('api/posting').length, 0); assert.equal(p.$('stop-all').textContent, 'Tap again to stop all posting');
  s.status = status({ stopped: true, reason: 'stopped by flag since T1' }); p.$('stop-all').click(); await p.flush();
  assert.deepEqual(p.posts('api/posting').map((c) => c.body), [{ action: 'stop' }]); assert.equal(p.$('notice').textContent, 'Posting is stopped.');
});

test('DOM: Start carries the stop the page saw; a stop that changed before the first tap is noticed and nothing is armed or sent', async () => {
  const s = serverOf(); s.status = status({ stopped: true, reason: 'stopped by flag since T1' }); const p = await openPage(s);
  assert.equal(p.$('stop-all').textContent, 'Allow posting again');
  p.$('stop-all').click(); await p.flush(); assert.equal(p.$('stop-all').textContent, 'Tap again to allow posting');
  s.status = status(); p.$('stop-all').click(); await p.flush();
  assert.deepEqual(p.posts('api/posting').map((c) => c.body), [{ action: 'start', seen: 'stopped by flag since T1' }], 'the second tap names the stop the first tap showed');
  // stopped again by WhatsApp between the page load and the first tap
  const s2 = serverOf(); s2.status = status({ stopped: true, reason: 'stopped by flag since T1' }); const q = await openPage(s2);
  s2.status = status({ stopped: true, reason: 'stopped by flag since T2' }); q.$('stop-all').click(); await q.flush();
  assert.equal(q.posts('api/posting').length, 0); assert.equal(q.$('notice').textContent, 'Posting was stopped again in the meantime. Check and tap again.'); assert.equal(q.$('stop-all').textContent, 'Allow posting again', 'not armed');
});

test('DOM: a refusal of Start for a changed stop shows the agreed sentence', async () => {
  const s = serverOf({ posting: () => ({ ok: false, code: 'stop-changed' }) }); s.status = status({ stopped: true, reason: 'R' }); const p = await openPage(s);
  p.$('stop-all').click(); await p.flush(); p.$('stop-all').click(); await p.flush();
  assert.equal(p.$('notice').textContent, 'Posting was stopped again in the meantime. Check and tap again.');
});

test('DOM: a first tap on Stop while the status cannot be loaded arms nothing (the old state is not trusted), and a second tap sends no POST', async () => {
  const s = serverOf(); const p = await openPage(s); assert.equal(p.$('stop-all').textContent, 'Stop all posting');
  s.items = () => { throw new Error('offline'); };
  p.$('stop-all').click(); await p.flush();
  assert.equal(p.$('stop-all').textContent, 'Stop all posting', 'not armed');
  p.$('stop-all').click(); await p.flush();
  assert.equal(p.posts('api/posting').length, 0, 'no POST after two taps while the status fails'); assert.equal(p.$('stop-all').textContent, 'Stop all posting');
});

const ARM_EXPIRED = 'The second tap came too late. Tap the button again if you still want to.';
const fireArmTimer = (p) => { const t = p.timers.filter((x) => x.ms === 5000); assert.equal(t.length, 1, 'exactly one 5 second timer'); t[0].fn(); };

test('DOM: the arming of Stop runs out with a plain sentence', async () => {
  const p = await openPage(serverOf());
  p.$('stop-all').click(); await p.flush(); assert.equal(p.$('stop-all').textContent, 'Tap again to stop all posting');
  fireArmTimer(p);
  assert.equal(p.$('notice').textContent, ARM_EXPIRED); assert.equal(p.$('stop-all').textContent, 'Stop all posting'); assert.equal(p.posts('api/posting').length, 0);
});

test('DOM: the same for Start', async () => {
  const s = serverOf(); s.status = status({ stopped: true, reason: 'stopped by flag since T1' }); const p = await openPage(s);
  p.$('stop-all').click(); await p.flush(); assert.equal(p.$('stop-all').textContent, 'Tap again to allow posting');
  fireArmTimer(p);
  assert.equal(p.$('notice').textContent, ARM_EXPIRED); assert.equal(p.$('stop-all').textContent, 'Allow posting again'); assert.equal(p.posts('api/posting').length, 0);
});

test('DOM: a second tap in time sends the post and the timer does nothing later', async () => {
  const p = await openPage(serverOf());
  p.$('stop-all').click(); await p.flush(); p.$('stop-all').click(); await p.flush();
  assert.equal(p.posts('api/posting').length, 1); const after = p.$('notice').textContent;
  fireArmTimer(p);
  assert.notEqual(p.$('notice').textContent, ARM_EXPIRED); assert.equal(p.$('notice').textContent, after);
});

test('DOM: the expiry sentence does not overwrite another notice', async () => {
  const p = await openPage(serverOf({ decide: () => ({ ok: false, code: 'version-changed' }) }));
  p.$('stop-all').click(); await p.flush();
  p.$('act-approve').click(); await p.flush();
  const other = p.$('notice').textContent; assert.notEqual(other, ''); assert.notEqual(other, ARM_EXPIRED);
  fireArmTimer(p);
  assert.equal(p.$('notice').textContent, other);
});

test('DOM: the status line shows the time in words while Start still sends the raw reason as seen', async () => {
  const raw = 'stopped by flag since 2026-11-17T21:06:42.521Z'; const s = serverOf(); s.status = status({ stopped: true, reason: raw, since: '2026-11-17T21:06:42.521Z', sinceText: '18 Nov at 00:06 (East Africa time)', by: 'own' }); const p = await openPage(s);
  assert.match(p.$('status').textContent || JSON.stringify(p.$('status').children.map((c) => c.textContent)), /stopped since 18 Nov at 00:06/);
  p.$('stop-all').click(); await p.flush(); p.$('stop-all').click(); await p.flush();
  assert.deepEqual(p.posts('api/posting').map((c) => c.body), [{ action: 'start', seen: raw }]);
});

// ══ Task 13: drafts on the page ══════════════════════════════════════════════════════════════════════════════
const pureNames = vm.runInNewContext(`${html.split('// BEGIN PURE')[1].split('// END PURE')[0]}; ({ REFUSAL_TEXT, EDIT_PROBLEM_TEXT, confirmText, doneText, netText, stateLine })`);
const SLOT = '2026-11-19T09:00:00+03:00'; const SLOT_TEXT = '19 Nov at 09:00 (East Africa time)';
const draftItem = (over = {}) => ({ kind: 'draft', id: 'B1', version: V('d'), title: 'Lions sleep', preview: { mediaId: null, note: 'picture is made when the post goes out' }, usableToday: false, decision: null, state: 'waiting', reason: null, actions: ['approve', 'skip', 'edit'],
  facts: { text: 'Lions sleep.\nThey are gentle.', videoText: null, draftKind: 'outlook', sources: [], expiresText: '22 Nov at 11:00 (East Africa time)', whenText: null, nextSlot: SLOT, nextSlotText: SLOT_TEXT, instagram: false, auto: false, blockedRules: [], lastTryFailed: false, ...(over.facts || {}) }, ...over, ...(over.facts ? { facts: { text: 'Lions sleep.\nThey are gentle.', videoText: null, draftKind: 'outlook', sources: [], expiresText: '22 Nov at 11:00 (East Africa time)', whenText: null, nextSlot: SLOT, nextSlotText: SLOT_TEXT, instagram: false, auto: false, blockedRules: [], lastTryFailed: false, ...over.facts } } : {}) });
const withDraft = (over = {}, serverOver = {}) => serverOf({ list: [draftItem(over), decidedItem()], decide: () => ({ ok: true, change: { kind: 'draft', id: 'B1', decision: 'scheduled' }, scheduledForText: SLOT_TEXT }), ...serverOver });
const fireTimers = (p) => { for (const t of [...p.timers]) { if (t.ms !== 5000 && t.ms !== 8000) t.fn(); } };
const open = (p, id) => !p.$(id).classList.contains('hidden');

test('T13 a ready draft with approve-off shows no Approve button and the plain sentence; a check-meta card has only Skip', async () => {
  const a = await openPage(withDraft({ reason: 'approve-off', actions: ['skip', 'edit'] }));
  assert.ok(a.$('act-approve').classList.contains('hidden')); assert.ok(!a.$('act-skip').classList.contains('hidden')); assert.ok(!a.$('act-edit').classList.contains('hidden'));
  assert.equal(a.$('state').textContent, 'Ready. Approving posts on this page is not switched on yet. You can skip or edit it.'); assert.equal(a.$('card-kind').textContent, 'Post waiting for your yes'); assert.equal(a.$('idline').textContent, 'Post number B1');
  const m = await openPage(withDraft({ state: 'refused: check-meta', reason: 'check-meta', actions: ['skip'] }));
  assert.ok(m.$('act-approve').classList.contains('hidden')); assert.ok(m.$('act-edit').classList.contains('hidden')); assert.ok(!m.$('act-skip').classList.contains('hidden')); assert.match(m.$('state').textContent, /^Not ready: This post may already be scheduled at Meta/);
});
test('T13 Approve on a draft shows the warning and sends nothing; no timer closes it; Cancel closes it and sends nothing', async () => {
  const p = await openPage(withDraft()); assert.ok(!open(p, 'confirm-box'), 'closed on load');
  p.$('act-approve').click(); await p.flush();
  assert.ok(open(p, 'confirm-box')); assert.equal(p.$('confirm-text').textContent, pureNames.confirmText(draftItem(), 'approve')); assert.match(p.$('confirm-text').textContent, /real post at Meta for 19 Nov at 09:00/); assert.equal(p.$('confirm-yes').textContent, 'Schedule it'); assert.ok(p.$('confirm-no').focused > 0, 'the safe button has the focus'); assert.equal(p.posts('api/decide').length, 0);
  fireTimers(p); await p.flush(); assert.ok(open(p, 'confirm-box'), 'no timer closes the box'); assert.equal(p.posts('api/decide').length, 0);
  p.$('confirm-no').click(); await p.flush(); assert.ok(!open(p, 'confirm-box')); assert.equal(p.posts('api/decide').length, 0);
  p.$('act-approve').click(); await p.flush(); p.key('Escape'); await p.flush(); assert.ok(!open(p, 'confirm-box'), 'Escape closes it'); assert.equal(p.posts('api/decide').length, 0);
});
test('T13 Schedule it sends exactly one decision with the card id, version and slot; a second click while saving sends none; the notice names the time; the list is reloaded', async () => {
  const s = withDraft(); const p = await openPage(s); const loads = () => p.calls.filter((c) => c.url === 'api/items').length; const before = loads();
  p.$('act-approve').click(); await p.flush(); p.$('confirm-yes').click(); p.$('confirm-yes').click(); await p.flush();
  assert.deepEqual(p.posts('api/decide').map((c) => c.body), [{ kind: 'draft', id: 'B1', version: V('d'), action: 'approve', slot: SLOT }]);
  assert.equal(p.$('notice').textContent, `Scheduled at Meta for ${SLOT_TEXT}. It goes out by itself.`); assert.ok(loads() > before, 'reloaded'); assert.ok(!open(p, 'confirm-box'));
});
test('T13 Skip on a draft needs the same second step and is not approved', async () => {
  const p = await openPage(withDraft()); p.$('act-skip').click(); await p.flush(); assert.ok(open(p, 'confirm-box')); assert.equal(p.$('confirm-text').textContent, 'Skip this post? It does not come back on this page.'); assert.equal(p.$('confirm-yes').textContent, 'Skip it'); assert.equal(p.posts('api/decide').length, 0);
  fireTimers(p); assert.ok(open(p, 'confirm-box')); p.$('confirm-yes').click(); await p.flush();
  assert.deepEqual(p.posts('api/decide').map((c) => c.body), [{ kind: 'draft', id: 'B1', version: V('d'), action: 'skip' }]); assert.equal(p.$('notice').textContent, 'Skipped. This cannot be undone here.');
});
test('T13 keys never approve or skip a draft; e opens the edit box; a hook is unchanged', async () => {
  const p = await openPage(withDraft()); p.key('a'); p.key('s'); await p.flush(); assert.equal(p.posts('api/decide').length, 0); assert.ok(!open(p, 'confirm-box')); p.key('e'); await p.flush(); assert.ok(open(p, 'edit-box'));
  const h = await openPage(serverOf()); h.key('a'); await h.flush(); assert.equal(h.posts('api/decide').length, 1); assert.equal(h.posts('api/decide')[0].body.action, 'approve');
});
test('T13 the edit box for a draft takes several lines, sends one edit and never an approve; a refused edit keeps the text', async () => {
  const p = await openPage(withDraft()); p.$('act-edit').click(); await p.flush();
  assert.equal(p.$('edit-text').value, 'Lions sleep.\nThey are gentle.'); assert.equal(p.$('edit-text').rows, 10); assert.equal(p.$('edit-save').textContent, 'Save'); assert.equal(p.$('edit-count').textContent, '29 of 2000'); assert.equal(p.$('edit-box').children.length >= 0, true);
  p.$('edit-text').value = 'New text.\nSecond line.'; p.$('edit-save').click(); await p.flush();
  assert.deepEqual(p.posts('api/decide').map((c) => c.body), [{ kind: 'draft', id: 'B1', version: V('d'), action: 'edit', text: 'New text.\nSecond line.' }]); assert.equal(p.$('notice').textContent, 'Saved. It is not scheduled yet. Look at the card again before you approve.');
  const r = await openPage(withDraft({}, { decide: () => ({ ok: false, code: 'rules' }) })); r.$('act-edit').click(); await r.flush(); r.$('edit-text').value = 'Keep my words\nplease.'; r.$('edit-save').click(); await r.flush();
  assert.equal(r.$('edit-text').value, 'Keep my words\nplease.'); assert.equal(r.$('edit-error').textContent, pureNames.REFUSAL_TEXT.rules); assert.ok(open(r, 'edit-box'));
});
test('T13 a draft edit that breaks a rule is refused before sending, each with its sentence', async () => {
  const p = await openPage(withDraft()); p.$('act-edit').click(); await p.flush();
  const rows = [['a\rb', 'bad-characters'], ['a​b', 'bad-characters'], ['x'.repeat(2001), 'too-long'], ['—'.repeat(700), 'too-big'], ['   ', 'empty']];
  for (const [text, problem] of rows) { p.$('edit-text').value = text; p.$('edit-save').click(); await p.flush(); const want = pureNames.EDIT_PROBLEM_TEXT[problem]; assert.equal(p.$('edit-error').textContent, typeof want === 'function' ? want('draft') : want, problem); assert.equal(p.$('edit-text').value, text); }
  assert.equal(p.posts('api/decide').length, 0);
});
test('T13 every new refusal code shows its own sentence; the codes that change the card also reload the list', async () => {
  const codes = ['queue-unreadable', 'already-scheduled', 'already-posted', 'expired', 'blocked', 'stopped', 'text-missing', 'sources-missing', 'sources-old', 'sources-outdated', 'sources-too-few', 'brand-rule', 'voice-rule', 'rules', 'number-not-in-facts', 'schedule-failed', 'schedule-not-saved', 'not-pending', 'check-meta', 'slot-changed', 'cannot-decide', 'version-changed'];
  const reload = new Set(['already-scheduled', 'already-posted', 'blocked', 'expired', 'not-pending', 'version-changed', 'slot-changed', 'check-meta']); // the reload list of the pure block
  for (const code of codes) {
    const p = await openPage(withDraft({}, { decide: () => ({ ok: false, code }) })); const loads = () => p.calls.filter((c) => c.url === 'api/items').length; const before = loads();
    p.$('act-approve').click(); await p.flush(); p.$('confirm-yes').click(); await p.flush();
    assert.equal(p.$('notice').textContent, pureNames.REFUSAL_TEXT[code], code); assert.equal(loads() > before, reload.has(code), `${code} reload`);
  }
});
test('T13 a network error on a draft approval says the post may have been scheduled', async () => {
  const p = await openPage(withDraft({}, { decide: () => new Error('offline') })); p.$('act-approve').click(); await p.flush(); p.$('confirm-yes').click(); await p.flush();
  assert.equal(p.$('notice').textContent, 'The connection broke. The post may have been scheduled at Meta. Check Meta before you tap again.');
});
test('T13 decided drafts have no Undo button; a decided hook still has one that sends the undo', async () => {
  const done = draftItem({ id: 'B2', state: 'scheduled', actions: [], decision: { kind: 'scheduled', at: '2026-11-17T08:00:00Z' }, facts: { whenText: SLOT_TEXT } });
  const p = await openPage(serverOf({ list: [done, decidedItem()] })); const undo = p.$('decided-list').descendants('button'); assert.equal(undo.length, 1);
  assert.match(p.$('decided-list').textContent, /You scheduled "Lions sleep" for 19 Nov at 09:00 \(East Africa time\)\./); undo[0].click(); await p.flush(); assert.equal(p.posts('api/decide')[0].body.action, 'undo'); assert.equal(p.posts('api/decide')[0].body.kind, 'hook');
});
test('T13 a prepared post shows a Play button and no action buttons; a blocked draft shows the rules and no buttons', async () => {
  const auto = draftItem({ state: 'automatic', actions: [], preview: { mediaId: 'm_' + 'a'.repeat(32), note: null }, facts: { auto: true, whenText: SLOT_TEXT, nextSlot: null } });
  const p = await openPage(serverOf({ list: [auto] })); assert.ok(p.$('video-slot').descendants('button').some((b) => b.textContent === 'Play video')); assert.ok(p.$('actions').classList.contains('hidden'));
  assert.equal(p.$('state').textContent, `Automatic post, scheduled for ${SLOT_TEXT}. There is nothing to decide here. Stop all posting holds it.`); assert.equal(p.$('card-kind').textContent, 'Automatic post');
  const b = await openPage(serverOf({ list: [draftItem({ state: 'blocked', reason: 'blocked', actions: [], facts: { blockedRules: ['sea-conditions'] } })] })); assert.ok(b.$('actions').classList.contains('hidden')); assert.match(b.$('facts').textContent, /Rules that refused it: sea conditions/);
});
test('T13 nothing is sent while the page loads with drafts in the list', async () => {
  const p = await openPage(withDraft()); assert.equal(p.posts('api/decide').length, 0); assert.equal(p.posts('api/posting').length, 0);
});

// ── fix round (18 Nov): R1 page card, R2 the date in the confirm box ───────────────────────────────────────────────
test('R1 a check-meta card says in plain words what to do, offers no Approve and no Edit, and its Skip warns that a post may still exist at Meta', async () => {
  const p = await openPage(withDraft({ state: 'refused: check-meta', reason: 'check-meta', actions: ['skip'] }));
  const t = p.$('state').textContent; assert.match(t, /did not finish cleanly/); assert.match(t, /Look in Meta/); assert.match(t, /send "bpa approve B1 again" on WhatsApp/);
  assert.ok(p.$('act-approve').classList.contains('hidden')); assert.ok(p.$('act-edit').classList.contains('hidden')); assert.ok(!p.$('act-skip').classList.contains('hidden'));
  p.$('act-skip').click(); await p.flush(); assert.ok(open(p, 'confirm-box')); assert.match(p.$('confirm-text').textContent, /post may still exist at Meta/); assert.match(p.$('confirm-text').textContent, /does not cancel/);
  assert.equal(pureNames.confirmText(draftItem(), 'skip'), 'Skip this post? It does not come back on this page.', 'the ordinary skip text is unchanged');
});
const OTHER = '2026-11-20T09:00:00+03:00';
test('R2 the slot changes while the confirm box is open: the box closes and nothing is sent', async () => {
  const s = withDraft(); const p = await openPage(s); p.$('act-approve').click(); await p.flush(); assert.ok(open(p, 'confirm-box'));
  s.list = [draftItem({ facts: { nextSlot: OTHER, nextSlotText: '20 Nov at 09:00 (East Africa time)' } }), decidedItem()]; p.$('refresh').click(); await p.flush();
  assert.ok(!open(p, 'confirm-box'), 'closed by the changed card'); p.$('confirm-yes').click(); await p.flush(); assert.equal(p.posts('api/decide').length, 0);
});
test('R2 a card changed without a re-render: the stale box sends nothing and closes; the unchanged box still sends the date it showed', async () => {
  const s = withDraft(); const p = await openPage(s); p.$('act-approve').click(); await p.flush();
  s.list[0].facts.nextSlot = OTHER; p.$('confirm-yes').click(); await p.flush(); assert.equal(p.posts('api/decide').length, 0); assert.ok(!open(p, 'confirm-box'));
  const q = await openPage(withDraft()); q.$('act-approve').click(); await q.flush(); q.$('confirm-yes').click(); await q.flush(); assert.equal(q.posts('api/decide')[0].body.slot, SLOT);
});
