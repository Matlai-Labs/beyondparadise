import './test-env.js';
// Tests for the explicit-decisions path of youtube-channel-edit.js. Mocked fetch only: nothing here can reach YouTube.
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import * as E from './youtube-channel-edit.js';
import { CHANNELS } from './youtube-login.js';

const { buildPlan, applyPlan, undoLedger, planMarkdown, main } = E;

// ---------- fake YouTube (own copy: models inserts, deletes, partial playlist updates, refused channel titles) ----------
const rnd = (p) => p + '_' + Math.random().toString(36).slice(2, 10);
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
function world(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ycd-')); const ledgerDir = join(dir, 'ledger');
  const refresh = { asia: rnd('ra'), africa: rnd('rf') };
  writeFileSync(join(dir, 'youtube-client.env'), `YOUTUBE_OAUTH_CLIENT_ID=${rnd('c')}\nYOUTUBE_OAUTH_CLIENT_SECRET=${rnd('s')}\n`);
  for (const c of ['asia', 'africa']) writeFileSync(join(dir, `youtube-${c}.json`), JSON.stringify({ channelId: CHANNELS[c].id, channelTitle: c, scope: 'x', obtainedAt: 'n', refresh_token: refresh[c] }));
  const mk = (id, chan, extra = {}, priv = 'public') => ({ id, snippet: { publishedAt: 'p', channelId: CHANNELS[chan].id, title: 'Title ' + id, description: `L1 ${id}\nwww.beyondparadiseadventures.net`, tags: ['a', 'b'], categoryId: chan === 'africa' ? '22' : '19', defaultLanguage: 'en', defaultAudioLanguage: 'en', ...extra }, status: { privacyStatus: priv } });
  const state = {
    tokenOwner: { asia: 'asia', africa: 'africa' }, calls: [], n: 0, items: {},
    videos: { v1: mk('v1', 'asia'), v2: mk('v2', 'asia'), v3: mk('v3', 'asia', {}, 'private'), v4: mk('v4', 'asia', {}, 'unlisted'), a1: mk('a1', 'africa') },
    playlists: {
      p1: { id: 'p1', snippet: { channelId: CHANNELS.asia.id, title: 'PL', description: 'x', defaultLanguage: 'en' }, status: { privacyStatus: 'public' } },
      p2: { id: 'p2', snippet: { channelId: CHANNELS.africa.id, title: 'PL2', description: 'y' }, status: { privacyStatus: 'private' } },
    },
    channels: { asia: { id: CHANNELS.asia.id, brandingSettings: { channel: { title: 'BPA - Asia', description: 'old', keywords: 'old', country: 'VN', defaultLanguage: 'en', unsubscribedTrailer: 'tr' }, image: { bannerExternalUrl: 'https://x/y' } } }, africa: { id: CHANNELS.africa.id, brandingSettings: { channel: { title: 'BPA - Africa', description: 'oldA', keywords: 'oldA', country: 'TZ' }, image: { bannerExternalUrl: 'https://x/z' } } } },
    channelTitle: null, afterPut: null, failPost: false, dieAfterPost: false, failItemAt: -1, ...opts,
  };
  const fetch = async (url, o = {}) => {
    url = String(url); const u = new URL(url); const method = o.method || 'GET'; state.calls.push({ url, method, body: o.body });
    if (u.host === 'oauth2.googleapis.com') { const b = new URLSearchParams(o.body); return json({ access_token: 'AT-' + (b.get('refresh_token') === refresh.asia ? 'asia' : 'africa') }); }
    const owner = state.tokenOwner[o.headers.Authorization.replace('Bearer AT-', '')]; const q = u.searchParams; const p = u.pathname;
    if (method === 'GET') {
      if (p.endsWith('/channels')) return json({ items: [{ id: state.channels[owner].id, brandingSettings: structuredClone(state.channels[owner].brandingSettings) }] });
      if (p.endsWith('/videos')) return json({ items: q.get('id').split(',').filter((i) => state.videos[i]).map((i) => structuredClone(state.videos[i])) });
      if (p.endsWith('/playlistItems')) return json({ items: (state.items[q.get('playlistId')] || []).map((r) => structuredClone(r)) });
      if (p.endsWith('/playlists')) return json({ items: q.get('id') ? [structuredClone(state.playlists[q.get('id')])].filter(Boolean) : Object.values(state.playlists).filter((x) => x.snippet.channelId === state.channels[owner].id).map((x) => structuredClone(x)) });
    }
    if (method === 'PUT') {
      const body = JSON.parse(o.body); state.puts = (state.puts || []).concat([{ url, body }]); let res;
      if (p.endsWith('/videos')) { const cur = state.videos[body.id]; if (body.snippet) cur.snippet = { publishedAt: cur.snippet.publishedAt, channelId: cur.snippet.channelId, ...body.snippet }; if (body.status) cur.status = { ...cur.status, ...body.status }; res = cur; }
      if (p.endsWith('/playlists') && !body.snippet?.title) return json({ error: { message: '{0}' } }, 400); // what the real API answers
      if (p.endsWith('/playlists')) { const cur = state.playlists[body.id]; if (body.snippet) cur.snippet = { channelId: cur.snippet.channelId, ...body.snippet }; if (body.status) cur.status = { ...cur.status, ...body.status }; res = cur; }
      if (p.endsWith('/channels')) {
        const cur = state.channels[owner]; const changes = body.brandingSettings.channel.title !== cur.brandingSettings.channel.title;
        if (changes && state.channelTitle === 'http') return json({ error: { message: 'Invalid channel title' } }, 400);
        if (changes && state.channelTitle === 'lie') res = { id: cur.id, brandingSettings: body.brandingSettings }; // the answer claims the new title, the state keeps the old one
        else { if (!(changes && state.channelTitle === 'ignore')) cur.brandingSettings = body.brandingSettings; res = cur; }
      }
      if (state.afterPut) state.afterPut(p, owner);
      return json(res);
    }
    if (method === 'POST') {
      const body = JSON.parse(o.body); state.posts = (state.posts || []).concat([{ url, body }]);
      if (p.endsWith('/playlists')) {
        if (state.failPost) return json({ error: { message: 'insert broke' } }, 500);
        const id = 'PLNEW' + (++state.n); state.playlists[id] = { id, snippet: { channelId: state.channels[owner].id, publishedAt: 'p', ...body.snippet }, status: { ...body.status } }; state.items[id] = [];
        if (state.dieAfterPost) throw new Error('network went away');
        return json(structuredClone(state.playlists[id]));
      }
      if (p.endsWith('/playlistItems')) {
        const pl = body.snippet.playlistId; if (!state.playlists[pl]) return json({ error: { message: 'playlist not found' } }, 404);
        if (state.failItemAt === state.items[pl].length) return json({ error: { message: 'item broke' } }, 500);
        const rec = { id: 'PI' + (++state.n), snippet: { playlistId: pl, resourceId: body.snippet.resourceId } }; state.items[pl].push(rec); return json(rec);
      }
    }
    if (method === 'DELETE' && p.endsWith('/playlists')) {
      state.deletes = (state.deletes || []).concat([{ url }]); const id = q.get('id');
      if (!state.playlists[id]) return json({ error: { message: 'not found' } }, 404);
      delete state.playlists[id]; delete state.items[id]; return json({});
    }
    return json({}, 404);
  };
  const deps = { configDir: dir, env: {}, fetch, now: new Date('2026-11-16T10:00:00Z'), sleep: async (ms) => { state.sleeps = (state.sleeps || []).concat([ms]); } };
  return { dir, ledgerDir, state, deps, clean: () => rmSync(dir, { recursive: true, force: true }) };
}
const writes = (w) => w.state.calls.filter((c) => c.method !== 'GET' && new URL(c.url).host === 'www.googleapis.com');
const readLedger = (w) => { const f = readdirSync(w.ledgerDir).map((n) => join(w.ledgerDir, n)); return { file: f[0], lines: readFileSync(f[0], 'utf8').trim().split('\n').map((l) => JSON.parse(l)) }; };
const writeLedger = (w, lines) => { mkdirSync(w.ledgerDir, { recursive: true }); const f = join(w.ledgerDir, 'changes-test.jsonl'); writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n'); return f; };
const plan = (w, ops) => buildPlan({ ...w.deps, decisions: { ops } });
const vid = (id, set, channel = 'asia') => ({ channel, kind: 'video', id, set });
const pl = (id, set, channel = 'asia') => ({ channel, kind: 'playlist', id, set });
const chan = (set, channel = 'asia') => ({ channel, kind: 'channel', id: CHANNELS[channel].id, set });
const create = (key, title, items, privacyStatus = 'public', channel = 'asia') => ({ channel, kind: 'playlist-create', key, set: { title, description: 'About ' + title, privacyStatus }, items });
const run = async (w, ops, opts = {}) => applyPlan(await plan(w, ops), { ledgerDir: w.ledgerDir, ...opts }, w.deps);

// ---------- the single place that lists writable fields ----------
test('ALLOWED lists the new fields, and never a video privacy or a delete', () => {
  assert.ok(E.ALLOWED.video.includes('title') && E.ALLOWED.video.includes('description'));
  assert.ok(!E.ALLOWED.video.includes('privacyStatus')); assert.ok(!E.ALLOWED.channel.includes('privacyStatus'));
  assert.deepEqual([...E.ALLOWED.playlist].sort(), ['description', 'privacyStatus', 'title']);
  assert.ok(E.ALLOWED.channel.includes('title')); assert.ok(E.ALLOWED['playlist-create']);
  assert.equal(E.ALLOWED.delete, undefined);
});

// ---------- plan: decisions only ----------
test('decisions plan: only the listed ops, old and new values, readable diff, rules never run, nothing written', async () => {
  const w = world();
  try {
    const texts = new Proxy({}, { get() { throw new Error('the text rules ran'); } }); // a rules plan would touch texts[channel]
    const p = await buildPlan({ ...w.deps, texts, decisions: { ops: [vid('v1', { title: 'Nieuwe titel', description: 'Hello' })] } });
    assert.equal(p.source, 'decisions'); assert.equal(p.ops.length, 1);
    const o = p.ops[0]; assert.equal(o.kind, 'video'); assert.equal(o.id, 'v1'); assert.equal(o.source, 'decisions');
    assert.deepEqual(o.before, { title: 'Title v1', description: 'L1 v1\nwww.beyondparadiseadventures.net' }); assert.deepEqual(o.after, { title: 'Nieuwe titel', description: 'Hello' });
    // v1, v2, a1, p1 and both channels would all be rule ops; none of them is here
    assert.deepEqual(Object.keys(o.after).sort(), ['description', 'title']);
    const md = planMarkdown(p); assert.match(md, /^- title: Title v1$/m); assert.match(md, /^\+ title: Nieuwe titel$/m); assert.match(md, /^\+ Hello$/m);
    assert.equal(writes(w).length, 0);
  } finally { w.clean(); }
});
test('decisions plan: only the fields that really change are kept; partly done op shrinks, finished op is dropped as already-applied', async () => {
  const w = world();
  try {
    const p = await plan(w, [vid('v1', { title: 'Title v1', description: 'New text' }), vid('v2', { title: 'Title v2' }), chan({ title: 'BPA - Asia' }), pl('p1', { privacyStatus: 'public' })]);
    assert.deepEqual(p.ops.map((o) => `${o.kind}:${o.id}`), ['video:v1']); assert.deepEqual(Object.keys(p.ops[0].after), ['description']);
    assert.deepEqual(p.skipped.map((s) => `${s.kind}:${s.id}:${s.reason}`), ['video:v2:already-applied', `channel:${CHANNELS.asia.id}:already-applied`, 'playlist:p1:already-applied']);
    assert.match(planMarkdown(p), /## skipped: already-applied \(3\)/);
  } finally { w.clean(); }
});
test('decisions plan: a private video is skipped with a note, not refused', async () => {
  const w = world();
  try {
    const p = await plan(w, [vid('v3', { title: 'X' }), vid('v1', { title: 'Y' })]);
    assert.deepEqual(p.ops.map((o) => o.id), ['v1']); assert.deepEqual(p.skipped.map((s) => `${s.id}:${s.reason}`), ['v3:private']);
  } finally { w.clean(); }
});
test('decisions plan: a playlist-create whose title already exists on the channel gives already-exists and no op', async () => {
  const w = world();
  try {
    const p = await plan(w, [create('pl', 'pl', ['v1'])]); // "PL" exists on asia (case and spaces do not matter)
    assert.equal(p.ops.length, 0); assert.deepEqual(p.skipped.map((s) => s.reason), ['already-exists']);
    const p2 = await plan(w, [create('pl2', 'PL2', ['v1'])]); // PL2 exists only on africa: fine on asia
    assert.equal(p2.ops.length, 1);
  } finally { w.clean(); }
});

// ---------- plan: refusals ----------
const long = (n) => 'x'.repeat(n);
const REFUSALS = [
  ['video: field outside the list (categoryId)', vid('v1', { categoryId: '19' }), /categoryId/],
  ['video: field outside the list (tags)', vid('v1', { tags: ['x'] }), /tags/],
  ['playlist: field outside the list', pl('p1', { defaultLanguage: 'nl' }), /defaultLanguage/],
  ['channel: description is not a decision field', chan({ description: 'x' }), /description/],
  ['channel: keywords is not a decision field', chan({ keywords: 'x' }), /keywords/],
  ['playlist-create: field outside the list', { ...create('k', 'New', ['v1']), set: { title: 'New', privacyStatus: 'public', tags: ['x'] } }, /tags/],
  ['video title empty', vid('v1', { title: '   ' }), /title is empty/],
  ['video title 101 characters', vid('v1', { title: long(101) }), /100/],
  ['video title with <', vid('v1', { title: 'a<b' }), /<|>/],
  ['video title with >', vid('v1', { title: 'a>b' }), /<|>/],
  ['video description 5001 characters', vid('v1', { description: long(5001) }), /5000/],
  ['video description with <', vid('v1', { description: '<b>x</b>' }), /<|>/],
  ['playlist title empty', pl('p1', { title: '' }), /title is empty/],
  ['playlist title 151 characters', pl('p1', { title: long(151) }), /150/],
  ['playlist description 5001 characters', pl('p1', { description: long(5001) }), /5000/],
  ['channel title empty', chan({ title: '' }), /title is empty/],
  ['channel title 101 characters', chan({ title: long(101) }), /100/],
  ['playlist privacy "unlisted"', pl('p1', { privacyStatus: 'unlisted' }), /privacyStatus/],
  ['playlist privacy not text', pl('p1', { privacyStatus: true }), /privacyStatus|text/],
  ['video privacy can never be set', vid('v1', { privacyStatus: 'private' }), /privacy/],
  ['video privacy "public" is refused too', vid('v1', { privacyStatus: 'public' }), /privacy/],
  ['channel privacy', chan({ privacyStatus: 'private' }), /privacyStatus/],
  ['kind delete', { channel: 'asia', kind: 'delete', id: 'v1', set: {} }, /unknown op kind "delete"/],
  ['kind delete-playlist', { channel: 'asia', kind: 'playlist-delete', id: 'p1' }, /unknown op kind/],
  ['an extra delete key on a normal op', { ...vid('v1', { title: 'ok' }), delete: true }, /unknown key "delete"/],
  ['unknown channel', vid('v1', { title: 'ok' }, 'europe'), /unknown channel/],
  ['channel op with the other channel id', { channel: 'asia', kind: 'channel', id: CHANNELS.africa.id, set: { title: 'ok' } }, /channel id/],
  ['empty set', vid('v1', {}), /nothing to set|set/],
  ['old address as text', vid('v1', { description: 'Book at www.beyondparadiseadventures.net now' }), /old address/],
  ['old address in a title', vid('v1', { title: 'beyondparadiseadventures.net' }), /old address/],
  ['old address with https', vid('v1', { description: 'https://beyondparadiseadventures.net/' }), /old address/],
  ['foreign address (url)', vid('v1', { description: 'see https://evil.example.com/x' }), /evil\.example\.com/],
  ['foreign address (bare domain)', vid('v1', { description: 'visit evil.io today' }), /evil\.io/],
  ['foreign address (www)', vid('v1', { description: 'visit www.tiktok.com/@x' }), /www\.tiktok\.com/],
  ['foreign address hidden behind an allowed host', vid('v1', { description: 'https://www.instagram.com@evil.example.com/' }), /evil\.example\.com/],
  ['allowed-looking but different host', vid('v1', { description: 'https://beyondparadiseadventures.com.evil.example.com/' }), /evil\.example\.com/],
  ['another channel\'s video (the id does not belong to the named channel)', vid('v1', { title: 'ok' }, 'africa'), /channel/],
  ['a video id that does not exist', vid('nope', { title: 'ok' }), /not found/],
  ['a playlist of the other channel', pl('p2', { title: 'ok' }, 'asia'), /channel/],
  ['playlist-create: item is private', create('k', 'New', ['v1', 'v3']), /v3.*private/],
  ['playlist-create: item is unlisted', create('k', 'New', ['v4']), /v4.*unlisted/],
  ['playlist-create: item of the other channel', create('k', 'New', ['a1']), /a1.*another channel/],
  ['playlist-create: item does not exist', create('k', 'New', ['nope']), /nope.*not found/],
  ['playlist-create: privacy missing', { ...create('k', 'New', ['v1']), set: { title: 'New' } }, /privacyStatus/],
  ['playlist-create: privacy "unlisted"', create('k', 'New', ['v1'], 'unlisted'), /privacyStatus/],
  ['playlist-create: empty title', create('k', '', ['v1']), /title is empty/],
  ['playlist-create: title 151 characters', create('k', long(151), ['v1']), /150/],
  ['playlist-create: same item twice', create('k', 'New', ['v1', 'v1']), /twice|duplicate/],
  ['playlist-create: no key', { ...create('k', 'New', ['v1']), key: undefined }, /key/],
  ['playlist-create with an id', { ...create('k', 'New', ['v1']), id: 'p1' }, /unknown key "id"/],
];
for (const [name, op, re] of REFUSALS) {
  test(`plan refuses: ${name}`, async () => {
    const w = world();
    try {
      await assert.rejects(() => plan(w, [vid('v2', { title: 'fine' }), op]), (e) => { assert.match(e.message, re); assert.match(e.message, /decisions op #2/); return true; });
      assert.equal(writes(w).length, 0);
    } finally { w.clean(); }
  });
}
test('plan refuses a file that is not {"ops": [...]}, with unknown top-level keys, or with no ops', async () => {
  const w = world();
  try {
    for (const bad of [null, [], {}, { ops: [] }, { ops: 'x' }, { ops: [vid('v1', { title: 'a' })], extra: 1 }]) await assert.rejects(() => buildPlan({ ...w.deps, decisions: bad }), /decisions refused/);
    assert.equal(writes(w).length, 0);
  } finally { w.clean(); }
});
test('plan names every refused op in one message, not only the first', async () => {
  const w = world();
  try { await assert.rejects(() => plan(w, [vid('v1', { title: '' }), vid('v2', { description: 'x<y' })]), (e) => /decisions op #1/.test(e.message) && /decisions op #2/.test(e.message)); } finally { w.clean(); }
});
test('plan refuses two ops on the same object and two creates of the same playlist title', async () => {
  const w = world();
  try {
    await assert.rejects(() => plan(w, [vid('v1', { title: 'a' }), vid('v1', { description: 'b' })]), /same object|twice/);
    await assert.rejects(() => plan(w, [create('a', 'Vietnam', ['v1']), create('b', 'vietnam ', ['v2'])]), /same title|twice/);
    await assert.rejects(() => plan(w, [create('a', 'Vietnam', ['v1']), create('a', 'Other', ['v2'])]), /key/);
  } finally { w.clean(); }
});
test('plan accepts the four allowed hosts (with and without a path)', async () => {
  const w = world();
  try {
    const d = 'See https://beyondparadiseadventures.com/ and https://www.instagram.com/beyondparadiseadventures/, https://www.youtube.com/@bpa-africa and https://www.facebook.com/x. Mail: info@beyondparadiseadventures.com';
    const p = await plan(w, [vid('v1', { description: d })]); assert.equal(p.ops.length, 1);
  } finally { w.clean(); }
});

// ---------- apply: video title / description ----------
test('apply title change: the snippet sent carries the live tags, category and languages unchanged; pending line holds all old values', async () => {
  const w = world();
  try {
    const orig = structuredClone(w.state.videos.v1.snippet);
    const r = await run(w, [vid('v1', { title: 'Nieuwe titel' })]);
    assert.equal(r.done, 1);
    assert.match(w.state.puts[0].url, /^https:\/\/www\.googleapis\.com\/youtube\/v3\/videos\?part=snippet$/);
    assert.deepEqual(w.state.puts[0].body, { id: 'v1', snippet: { title: 'Nieuwe titel', description: orig.description, tags: ['a', 'b'], categoryId: '19', defaultLanguage: 'en', defaultAudioLanguage: 'en' } });
    const { lines } = readLedger(w); assert.deepEqual(lines.map((l) => l.status), ['pending', 'done']);
    assert.deepEqual(lines[0].before, { title: orig.title, description: orig.description, tags: ['a', 'b'], categoryId: '19', defaultLanguage: 'en', defaultAudioLanguage: 'en', privacyStatus: 'public' });
    assert.deepEqual(lines[0].planned, { title: 'Nieuwe titel' }); assert.equal(lines[1].verified, true);
    assert.deepEqual(w.state.videos.v1.snippet.tags, ['a', 'b']); assert.equal(w.state.videos.v1.status.privacyStatus, 'public');
  } finally { w.clean(); }
});
test('apply title + description in one write', async () => {
  const w = world();
  try { await run(w, [vid('v2', { title: 'T2', description: 'D2' })]); assert.equal(writes(w).length, 1); assert.equal(w.state.videos.v2.snippet.title, 'T2'); assert.equal(w.state.videos.v2.snippet.description, 'D2'); } finally { w.clean(); }
});
for (const [what, mutate, re] of [
  ['tags', (v) => { v.snippet.tags = ['changed']; }, /tags/],
  ['tags removed', (v) => { delete v.snippet.tags; }, /tags/],
  ['category', (v) => { v.snippet.categoryId = '1'; }, /categoryId/],
  ['privacy', (v) => { v.status.privacyStatus = 'private'; }, /privacyStatus/],
]) {
  test(`read-back mismatch on ${what} stops the run; the next op is not written`, async () => {
    const w = world(); w.state.afterPut = (p) => { if (p.endsWith('/videos')) mutate(w.state.videos.v1); };
    try {
      await assert.rejects(() => run(w, [vid('v1', { title: 'T1' }), vid('v2', { title: 'T2' })]), (e) => { assert.match(e.message, /mismatch/); assert.match(e.message, re); return true; });
      assert.equal(writes(w).length, 1); assert.deepEqual(readLedger(w).lines.map((l) => l.status), ['pending', 'mismatch']);
    } finally { w.clean(); }
  });
}
test('apply twice: the second run finds the title already applied and writes nothing', async () => {
  const w = world();
  try { const p = await plan(w, [vid('v1', { title: 'T1' })]); await applyPlan(p, { ledgerDir: w.ledgerDir }, w.deps); const n = writes(w).length; const r = await applyPlan(p, { ledgerDir: w.ledgerDir }, w.deps); assert.equal(r.alreadyApplied, 1); assert.equal(writes(w).length, n); } finally { w.clean(); }
});
test('apply: a title edited by hand since the plan is stale, nothing written', async () => {
  const w = world();
  try { const p = await plan(w, [vid('v1', { title: 'T1' })]); w.state.videos.v1.snippet.title = 'hand edit'; const r = await applyPlan(p, { ledgerDir: w.ledgerDir }, w.deps); assert.equal(r.stale, 1); assert.equal(writes(w).length, 0); } finally { w.clean(); }
});

// ---------- apply: playlists ----------
test('apply playlist privacy-only: part=snippet,status with the full live snippet (the real API needs snippet.title)', async () => {
  const w = world();
  try {
    const r = await run(w, [pl('p1', { privacyStatus: 'private' })]); assert.equal(r.done, 1);
    assert.match(w.state.puts[0].url, /playlists\?part=snippet,status$/); assert.deepEqual(w.state.puts[0].body, { id: 'p1', snippet: { title: 'PL', description: 'x', defaultLanguage: 'en' }, status: { privacyStatus: 'private' } });
    assert.equal(w.state.playlists.p1.status.privacyStatus, 'private'); assert.equal(w.state.playlists.p1.snippet.title, 'PL'); assert.equal(w.state.playlists.p1.snippet.description, 'x');
    const l = readLedger(w).lines; assert.equal(l[0].before.privacyStatus, 'public'); assert.equal(l[0].before.title, 'PL');
  } finally { w.clean(); }
});
test('apply playlist title + privacy: one call with both parts', async () => {
  const w = world();
  try {
    await run(w, [pl('p1', { title: 'Renamed', privacyStatus: 'private' })]);
    assert.equal(writes(w).length, 1); assert.match(w.state.puts[0].url, /playlists\?part=snippet,status$/);
    assert.deepEqual(w.state.puts[0].body, { id: 'p1', snippet: { title: 'Renamed', description: 'x', defaultLanguage: 'en' }, status: { privacyStatus: 'private' } });
    assert.equal(w.state.playlists.p1.snippet.title, 'Renamed'); assert.equal(w.state.playlists.p1.status.privacyStatus, 'private');
  } finally { w.clean(); }
});
test('apply playlist description: part=snippet only (as the rules path does)', async () => {
  const w = world();
  try { await run(w, [pl('p1', { description: 'new text' })]); assert.match(w.state.puts[0].url, /playlists\?part=snippet,status$/); assert.deepEqual(w.state.puts[0].body.status, { privacyStatus: 'public' }); } finally { w.clean(); }
});
test('a playlist privacy change that the read-back does not show is a mismatch and stops', async () => {
  const w = world(); w.state.afterPut = (p) => { if (p.endsWith('/playlists')) w.state.playlists.p1.status.privacyStatus = 'unlisted'; };
  try { await assert.rejects(() => run(w, [pl('p1', { privacyStatus: 'private' })]), /mismatch.*privacyStatus/); } finally { w.clean(); }
});

// ---------- apply: channel title ----------
test('channel title: sends the full live brandingSettings.channel with only the title changed, banner untouched', async () => {
  const w = world();
  try {
    const r = await run(w, [chan({ title: 'Beyond Paradise Asia' })]); assert.equal(r.done, 1);
    assert.match(w.state.puts[0].url, /channels\?part=brandingSettings$/);
    const b = w.state.puts[0].body.brandingSettings; assert.deepEqual(b.image, { bannerExternalUrl: 'https://x/y' });
    assert.deepEqual(b.channel, { title: 'Beyond Paradise Asia', description: 'old', keywords: 'old', country: 'VN', defaultLanguage: 'en', unsubscribedTrailer: 'tr' });
  } finally { w.clean(); }
});
test('channel rename refused by YouTube (HTTP error): ledgered refused-by-youtube and the run CONTINUES', async () => {
  const w = world({ channelTitle: 'http' });
  try {
    const r = await run(w, [chan({ title: 'Nope' }), vid('v1', { title: 'T1' })]);
    assert.equal(r.refused, 1); assert.equal(r.done, 1); assert.equal(r.failed, 0);
    assert.deepEqual(readLedger(w).lines.map((l) => l.status), ['pending', 'refused-by-youtube', 'pending', 'done']);
    assert.match(readLedger(w).lines[1].error, /Invalid channel title/); assert.equal(w.state.videos.v1.snippet.title, 'T1'); assert.equal(w.state.channels.asia.brandingSettings.channel.title, 'BPA - Asia');
  } finally { w.clean(); }
});
test('channel rename silently ignored (read-back still shows the old title after all retries): refused-by-youtube, run continues', async () => {
  const w = world({ channelTitle: 'ignore' });
  try {
    const r = await run(w, [chan({ title: 'Nope' }), vid('v1', { title: 'T1' })]);
    assert.equal(r.refused, 1); assert.equal(r.done, 1); assert.deepEqual(w.state.sleeps, [5000, 5000, 5000, 5000, 5000]);
    assert.deepEqual(readLedger(w).lines.map((l) => l.status), ['pending', 'refused-by-youtube', 'pending', 'done']);
  } finally { w.clean(); }
});
test('a channel title write where something ELSE changed is still a mismatch that stops the run', async () => {
  const w = world(); w.state.afterPut = (p, owner) => { if (p.endsWith('/channels')) w.state.channels[owner].brandingSettings.channel.country = 'XX'; };
  try { await assert.rejects(() => run(w, [chan({ title: 'New' }), vid('v1', { title: 'T1' })]), /mismatch/); assert.equal(writes(w).length, 1); assert.deepEqual(readLedger(w).lines.map((l) => l.status), ['pending', 'mismatch']); } finally { w.clean(); }
});
test('a refusal by another kind of op (video title HTTP error) still stops the run as today', async () => {
  const w = world(); const orig = w.deps.fetch; let first = true;
  w.deps.fetch = async (u, o = {}) => (o.method === 'PUT' && first ? (first = false, json({ error: { message: 'boom' } }, 400)) : orig(u, o));
  try { await assert.rejects(() => run(w, [vid('v1', { title: 'T1' }), vid('v2', { title: 'T2' })]), /boom/); assert.deepEqual(readLedger(w).lines.map((l) => l.status), ['pending', 'failed']); assert.equal(w.state.videos.v2.snippet.title, 'Title v2'); } finally { w.clean(); }
});
test('a server error (5xx) on the channel title write is NOT treated as a refusal: failed, run stops', async () => {
  const w = world(); const orig = w.deps.fetch;
  w.deps.fetch = async (u, o = {}) => (o.method === 'PUT' ? json({ error: { message: 'backend down' } }, 503) : orig(u, o));
  try { await assert.rejects(() => run(w, [chan({ title: 'New' }), vid('v1', { title: 'T1' })]), /backend down|503/); assert.deepEqual(readLedger(w).lines.map((l) => l.status), ['pending', 'failed']); } finally { w.clean(); }
});

// ---------- apply: playlist-create ----------
test('playlist-create with two items: insert, two item inserts, one ledger line each with the ids; then undo deletes exactly that playlist', async () => {
  const w = world();
  try {
    const r = await run(w, [create('vietnam', 'Vietnam', ['v1', 'v2'])]); assert.equal(r.done, 1);
    assert.equal(w.state.posts.length, 3);
    assert.match(w.state.posts[0].url, /playlists\?part=snippet,status$/); assert.deepEqual(w.state.posts[0].body, { snippet: { title: 'Vietnam', description: 'About Vietnam' }, status: { privacyStatus: 'private' } }); // ALWAYS inserted private
    assert.equal(w.state.puts.length, 1); assert.match(w.state.puts[0].url, /playlists\?part=snippet,status$/); assert.deepEqual(w.state.puts[0].body, { id: 'PLNEW1', snippet: { title: 'Vietnam', description: 'About Vietnam' }, status: { privacyStatus: 'public' } });
    assert.deepEqual(writes(w).map((c) => c.method), ['POST', 'POST', 'POST', 'PUT']); // privacy is the LAST write
    assert.match(w.state.posts[1].url, /playlistItems\?part=snippet$/); assert.deepEqual(w.state.posts[1].body, { snippet: { playlistId: 'PLNEW1', resourceId: { kind: 'youtube#video', videoId: 'v1' } } });
    assert.equal(w.state.posts[2].body.snippet.resourceId.videoId, 'v2');
    const { lines, file } = readLedger(w); assert.deepEqual(lines.map((l) => l.status), ['pending', 'created', 'item-created', 'item-created', 'privacy-pending', 'privacy-done', 'done']);
    assert.equal(lines[1].playlistId, 'PLNEW1'); assert.equal(lines[1].of, lines[0].ts);
    assert.deepEqual(lines.slice(2, 4).map((l) => [l.videoId, l.playlistItemId]), [['v1', 'PI2'], ['v2', 'PI3']]); assert.deepEqual(lines[6].itemIds, ['PI2', 'PI3']); assert.equal(w.state.playlists.PLNEW1.status.privacyStatus, 'public');
    assert.ok(r.units >= 150);
    // applying again must not create a second playlist
    const again = await applyPlan(await plan(w, [create('vietnam', 'Vietnam', ['v1', 'v2'])]), { ledgerDir: w.ledgerDir }, w.deps); assert.equal(again.done, 0);
    const again2 = await applyPlan({ ops: [{ kind: 'playlist-create', channel: 'asia', id: 'vietnam', key: 'vietnam', title: 'Vietnam', before: {}, after: { title: 'Vietnam', description: 'About Vietnam', privacyStatus: 'public' }, items: ['v1', 'v2'], source: 'decisions' }] }, { ledgerDir: w.ledgerDir }, w.deps);
    assert.equal(again2.alreadyApplied, 1); assert.equal(w.state.posts.length, 3);
    // undo
    const u = await undoLedger(file, {}, w.deps); assert.equal(u.undone, 1);
    assert.deepEqual(w.state.deletes.map((d) => new URL(d.url).searchParams.get('id')), ['PLNEW1']); assert.equal(w.state.playlists.PLNEW1, undefined); assert.ok(w.state.playlists.p1 && w.state.playlists.p2);
    assert.ok(readLedger(w).lines.some((l) => l.status === 'undone' && l.playlistId === 'PLNEW1'));
    assert.equal((await undoLedger(file, {}, w.deps)).undone, 0); assert.equal(w.state.deletes.length, 1);
  } finally { w.clean(); }
});
test('playlist-create plan op carries the key as id, the items, and a readable diff', async () => {
  const w = world();
  try { const p = await plan(w, [create('vietnam', 'Vietnam', ['v1', 'v2'])]); const o = p.ops[0]; assert.equal(o.kind, 'playlist-create'); assert.equal(o.id, 'vietnam'); assert.deepEqual(o.items, ['v1', 'v2']); assert.deepEqual(o.before, {}); assert.equal(o.after.privacyStatus, 'public'); const md = planMarkdown(p); assert.match(md, /## playlist-create asia vietnam/); assert.match(md, /^\+ title: Vietnam$/m); assert.match(md, /v1, v2/); assert.equal(writes(w).length, 0); } finally { w.clean(); }
});
test('playlist-create: an item insert that fails leaves a failed line, stops, and undo still deletes only the created playlist', async () => {
  const w = world({ failItemAt: 1 });
  try {
    await assert.rejects(() => run(w, [create('vietnam', 'Vietnam', ['v1', 'v2'])]), /item broke/);
    assert.deepEqual(readLedger(w).lines.map((l) => l.status), ['pending', 'created', 'item-created', 'failed']);
    const u = await undoLedger(readLedger(w).file, {}, w.deps); assert.equal(u.undone, 1); assert.equal(w.state.deletes.length, 1); assert.equal(w.state.playlists.PLNEW1, undefined);
  } finally { w.clean(); }
});
test('playlist-create: insert rejected by YouTube: failed line, nothing created, undo does nothing', async () => {
  const w = world({ failPost: true });
  try {
    await assert.rejects(() => run(w, [create('vietnam', 'Vietnam', ['v1'])]), /insert broke|500/);
    assert.deepEqual(readLedger(w).lines.map((l) => l.status), ['pending', 'failed']);
    const out = []; const u = await undoLedger(readLedger(w).file, {}, { ...w.deps, out: (s) => out.push(s) }); assert.equal(u.undone, 0); assert.equal(w.state.deletes, undefined);
  } finally { w.clean(); }
});
test('undo of a pending playlist-create whose insert response was never recorded does nothing and says so', async () => {
  const w = world({ dieAfterPost: true });
  try {
    await assert.rejects(() => run(w, [create('vietnam', 'Vietnam', ['v1'])]), /network/);
    assert.deepEqual(readLedger(w).lines.map((l) => l.status), ['pending', 'failed']); assert.ok(w.state.playlists.PLNEW1); // it WAS created on the server, but we never saw the id
    const out = []; const u = await undoLedger(readLedger(w).file, {}, { ...w.deps, out: (s) => out.push(s) });
    assert.equal(u.undone, 0); assert.equal(w.state.deletes, undefined); assert.ok(w.state.playlists.PLNEW1);
    assert.match(out.join('\n'), /nothing undone/); assert.match(out.join('\n'), /by hand/);
  } finally { w.clean(); }
});
test('undo refuses to delete a playlist id that is not recorded as created in the same ledger file', async () => {
  const w = world();
  try {
    const t = { channel: 'asia', kind: 'playlist-create', id: 'k', planned: { title: 'PL', description: '', privacyStatus: 'public' } };
    const cases = [
      [{ ts: 't1', status: 'pending', ...t, playlistId: 'p1' }], // id smuggled into the pending line
      [{ ts: 't1', status: 'pending', ...t }, { ts: 't2', status: 'done', ...t, of: 't1', playlistId: 'p1' }], // only a done line mentions it
      [{ ts: 't1', status: 'pending', ...t }, { ts: 't2', status: 'created', ...t, of: 'OTHER', playlistId: 'p1' }], // created, but for a different attempt
      [{ ts: 't1', status: 'pending', ...t }, { ts: 't2', status: 'created', ...t, channel: 'africa', of: 't1', playlistId: 'p1' }], // created on another channel
      [{ ts: 't1', status: 'pending', ...t }, { ts: 't2', status: 'created', ...t, of: 't1', playlistId: '' }], // empty id
    ];
    for (const lines of cases) {
      const f = writeLedger(w, lines); const out = [];
      const u = await undoLedger(f, {}, { ...w.deps, out: (s) => out.push(s) });
      assert.equal(u.undone, 0); assert.equal(w.state.deletes, undefined); assert.ok(w.state.playlists.p1); assert.match(out.join('\n'), /nothing undone/);
    }
  } finally { w.clean(); }
});
test('undo of a created playlist whose title was changed since is skipped as changed-since (nothing deleted)', async () => {
  const w = world();
  try { await run(w, [create('vietnam', 'Vietnam', ['v1'])]); w.state.playlists.PLNEW1.snippet.title = 'Renamed by hand'; const u = await undoLedger(readLedger(w).file, {}, w.deps); assert.equal(u['changed-since'], 1); assert.equal(w.state.deletes, undefined); } finally { w.clean(); }
});
test('undo of a created playlist that is already gone: not-applied, no delete call', async () => {
  const w = world();
  try { await run(w, [create('vietnam', 'Vietnam', ['v1'])]); delete w.state.playlists.PLNEW1; const u = await undoLedger(readLedger(w).file, {}, w.deps); assert.equal(u['not-applied'], 1); assert.equal(w.state.deletes, undefined); } finally { w.clean(); }
});
test('unit budget counts inserts: a create needing 150 units is not started when it cannot be paid in full', async () => {
  const w = world();
  try {
    const r = await run(w, [create('vietnam', 'Vietnam', ['v1', 'v2'])], { maxUnits: 202 }); // 3 read units + 150 inserts + 50 privacy update would be 203
    assert.equal(r.done, 0); assert.match(r.stoppedReason, /maxUnits/); assert.equal(writes(w).length, 0); assert.equal(existsSync(w.ledgerDir) ? readdirSync(w.ledgerDir).length : 0, 0);
    const r2 = await run(w, [create('vietnam', 'Vietnam', ['v1', 'v2'])], { maxUnits: 203 }); assert.equal(r2.done, 1); assert.equal(writes(w).length, 4);
  } finally { w.clean(); }
});
test('unit budget: inserts of an earlier op are counted against the next op', async () => {
  const w = world();
  try {
    const r = await run(w, [create('a', 'Alpha', ['v1', 'v2']), create('b', 'Beta', ['v1', 'v2'])], { maxUnits: 300 });
    assert.equal(r.done, 1); assert.match(r.stoppedReason, /maxUnits/); assert.equal(w.state.posts.length, 3); assert.ok(r.units >= 203);
  } finally { w.clean(); }
});
test('apply re-checks the items: a video that turned private since the plan makes the create stale, nothing written', async () => {
  const w = world();
  try { const p = await plan(w, [create('vietnam', 'Vietnam', ['v1', 'v2'])]); w.state.videos.v2.status.privacyStatus = 'private'; const r = await applyPlan(p, { ledgerDir: w.ledgerDir }, w.deps); assert.equal(r.stale, 1); assert.equal(writes(w).length, 0); } finally { w.clean(); }
});

// ---------- undo of the new fields ----------
test('undo from a pending title line (the run died after the write landed) restores title, keeps tags', async () => {
  const w = world();
  try {
    const orig = structuredClone(w.state.videos.v1.snippet);
    w.state.videos.v1.snippet.title = 'Landed title';
    const f = writeLedger(w, [{ ts: 't1', status: 'pending', kind: 'video', channel: 'asia', id: 'v1', before: { ...orig, privacyStatus: 'public' }, planned: { title: 'Landed title' } }]);
    const u = await undoLedger(f, {}, w.deps); assert.equal(u.undone, 1);
    assert.equal(w.state.videos.v1.snippet.title, orig.title); assert.deepEqual(w.state.videos.v1.snippet.tags, ['a', 'b']); assert.equal(w.state.puts[0].body.snippet.title, orig.title);
  } finally { w.clean(); }
});
test('undo of a full run restores title, description and playlist privacy', async () => {
  const w = world();
  try {
    await run(w, [vid('v1', { title: 'T1', description: 'D1' }), pl('p1', { title: 'New PL', privacyStatus: 'private' })]);
    const u = await undoLedger(readLedger(w).file, {}, w.deps); assert.equal(u.undone, 2);
    assert.equal(w.state.videos.v1.snippet.title, 'Title v1'); assert.equal(w.state.videos.v1.snippet.description, 'L1 v1\nwww.beyondparadiseadventures.net');
    assert.equal(w.state.playlists.p1.snippet.title, 'PL'); assert.equal(w.state.playlists.p1.status.privacyStatus, 'public');
  } finally { w.clean(); }
});
test('undo of a channel title restores it; an op the channel refused is not-applied and writes nothing', async () => {
  const w = world();
  try { await run(w, [chan({ title: 'Renamed' })]); const u = await undoLedger(readLedger(w).file, {}, w.deps); assert.equal(u.undone, 1); assert.equal(w.state.channels.asia.brandingSettings.channel.title, 'BPA - Asia'); } finally { w.clean(); }
  const w2 = world({ channelTitle: 'http' });
  try { await run(w2, [chan({ title: 'Nope' })]); const n = writes(w2).length; const u = await undoLedger(readLedger(w2).file, {}, w2.deps); assert.equal(u['not-applied'], 1); assert.equal(writes(w2).length, n); } finally { w2.clean(); }
});
test('undo refuses a ledger line that lists a field that is not writable (video privacy), with no write', async () => {
  const w = world();
  try {
    const f = writeLedger(w, [{ ts: 't1', status: 'pending', kind: 'video', channel: 'asia', id: 'v1', before: { title: 'x', privacyStatus: 'public' }, planned: { privacyStatus: 'private' } }]);
    w.state.videos.v1.status.privacyStatus = 'private';
    await assert.rejects(() => undoLedger(f, {}, w.deps), /not writable|privacyStatus/); assert.equal(writes(w).length, 0);
    const g = writeLedger(w, [{ ts: 't1', status: 'pending', kind: 'delete', channel: 'asia', id: 'v1', before: {}, planned: { title: 'x' } }]);
    await assert.rejects(() => undoLedger(g, {}, w.deps), /kind/); assert.equal(writes(w).length, 0);
  } finally { w.clean(); }
});

// ---------- --only ----------
test('apply --only works with the new kinds (playlist-create key, playlist id, channel id)', async () => {
  const w = world();
  try {
    const ops = [vid('v1', { title: 'T1' }), pl('p1', { privacyStatus: 'private' }), chan({ title: 'Renamed' }), create('vietnam', 'Vietnam', ['v2'])];
    const r = await run(w, ops, { only: ['vietnam'] }); assert.equal(r.done, 1); assert.equal(r.skipped, 3); assert.equal(w.state.videos.v1.snippet.title, 'Title v1'); assert.equal(w.state.posts.length, 2);
    const r2 = await run(w, ops, { only: ['p1', CHANNELS.asia.id] }); assert.equal(r2.done, 2); assert.equal(w.state.playlists.p1.status.privacyStatus, 'private'); assert.equal(w.state.channels.asia.brandingSettings.channel.title, 'Renamed'); assert.equal(w.state.videos.v1.snippet.title, 'Title v1');
  } finally { w.clean(); }
});
test('undo --only works with the new kinds', async () => {
  const w = world();
  try {
    await run(w, [vid('v1', { title: 'T1' }), pl('p1', { title: 'New PL' }), create('vietnam', 'Vietnam', ['v2'])]);
    const f = readLedger(w).file;
    const u = await undoLedger(f, { only: ['p1'] }, w.deps); assert.equal(u.undone, 1); assert.equal(w.state.playlists.p1.snippet.title, 'PL'); assert.equal(w.state.videos.v1.snippet.title, 'T1'); assert.ok(w.state.playlists.PLNEW1);
    const u2 = await undoLedger(f, { only: ['vietnam'] }, w.deps); assert.equal(u2.undone, 1); assert.equal(w.state.playlists.PLNEW1, undefined); assert.equal(w.state.videos.v1.snippet.title, 'T1');
  } finally { w.clean(); }
});

// ---------- apply-side guards (a hand-edited plan.json) ----------
test('apply refuses a tampered decisions plan before the first request: video privacy, delete, bad text, bad address, bad create', async () => {
  const w = world();
  try {
    const base = (await plan(w, [vid('v1', { title: 'T1' })])).ops[0]; w.state.calls.length = 0;
    const tamper = (f) => { const o = structuredClone(base); f(o); return o; };
    const cases = [
      [tamper((o) => { o.before.privacyStatus = 'public'; o.after.privacyStatus = 'private'; }), /privacyStatus/],
      [tamper((o) => { o.kind = 'delete'; }), /unknown op kind/],
      [tamper((o) => { o.after.title = 'a<b'; }), /<|>/],
      [tamper((o) => { o.after.title = ''; }), /empty/],
      [tamper((o) => { o.after.title = long(101); }), /100/],
      [tamper((o) => { o.before.description = 'd'; o.after.description = 'see www.beyondparadiseadventures.net'; }), /old address/],
      [tamper((o) => { o.before.description = 'd'; o.after.description = 'see https://evil.example.com'; }), /evil\.example\.com/],
      [{ kind: 'playlist-create', channel: 'asia', id: 'k', key: 'k', before: {}, after: { title: 'N', description: '', privacyStatus: 'unlisted' }, items: ['v1'], source: 'decisions' }, /privacyStatus/],
      [{ kind: 'playlist-create', channel: 'asia', id: 'k', key: 'k', before: {}, after: { title: 'N', description: '', privacyStatus: 'public', categoryId: '1' }, items: ['v1'], source: 'decisions' }, /categoryId/],
      [{ kind: 'playlist-create', channel: 'asia', id: 'k', key: 'k', before: {}, after: { title: 'N', description: '', privacyStatus: 'public' }, items: 'v1', source: 'decisions' }, /items/],
    ];
    for (const [op, re] of cases) { await assert.rejects(() => applyPlan({ ops: [structuredClone(base), op] }, { ledgerDir: w.ledgerDir }, w.deps), re); assert.equal(w.state.calls.length, 0); }
  } finally { w.clean(); }
});

// ---------- CLI ----------
test('CLI plan --decisions writes plan.json and plan.md, and exits 0 with no write to YouTube', async () => {
  const w = world(); const out = join(w.dir, 'out'); const f = join(w.dir, 'decisions.json'); const lines = [];
  writeFileSync(f, JSON.stringify({ ops: [vid('v1', { title: 'Nieuw' }), create('vietnam', 'Vietnam', ['v2'])] }));
  try {
    const code = await main(['plan', '--decisions', f, '--out', out], { ...w.deps, out: (s) => lines.push(s), err: (s) => lines.push(s) });
    assert.equal(code, 0); const p = JSON.parse(readFileSync(join(out, 'plan.json'), 'utf8')); assert.equal(p.source, 'decisions'); assert.deepEqual(p.ops.map((o) => o.kind), ['video', 'playlist-create']);
    assert.match(readFileSync(join(out, 'plan.md'), 'utf8'), /\+ title: Nieuw/); assert.equal(writes(w).length, 0);
    // the plan file feeds apply: same decisions run end to end through the CLI
    const code2 = await main(['apply', '--plan', join(out, 'plan.json'), '--ledger', w.ledgerDir, '--only', 'v1'], { ...w.deps, out: (s) => lines.push(s), err: (s) => lines.push(s) });
    assert.equal(code2, 0); assert.equal(w.state.videos.v1.snippet.title, 'Nieuw'); assert.equal(w.state.posts, undefined);
  } finally { w.clean(); }
});
test('CLI plan --decisions with a refused op exits 1, names the op, and writes NO files', async () => {
  const w = world(); const out = join(w.dir, 'out'); const f = join(w.dir, 'decisions.json'); const msgs = [];
  writeFileSync(f, JSON.stringify({ ops: [vid('v1', { title: 'ok' }), vid('v2', { privacyStatus: 'private' })] }));
  try {
    const code = await main(['plan', '--decisions', f, '--out', out], { ...w.deps, out: (s) => msgs.push(s), err: (s) => msgs.push(s) });
    assert.equal(code, 1); assert.match(msgs.join('\n'), /decisions op #2 \(video v2/); assert.equal(existsSync(out), false); assert.equal(writes(w).length, 0);
  } finally { w.clean(); }
});
test('CLI plan --decisions: missing value, missing file and broken json are clear errors, no network', async () => {
  const w = world(); const msgs = [];
  try {
    assert.equal(await main(['plan', '--out', join(w.dir, 'o'), '--decisions'], { ...w.deps, out: (s) => msgs.push(s), err: (s) => msgs.push(s) }), 2); assert.match(msgs.join('\n'), /--decisions/);
    assert.equal(await main(['plan', '--out', join(w.dir, 'o'), '--decisions', join(w.dir, 'missing.json')], { ...w.deps, out: () => {}, err: (s) => msgs.push(s) }), 1);
    const bad = join(w.dir, 'bad.json'); writeFileSync(bad, '{ not json');
    assert.equal(await main(['plan', '--out', join(w.dir, 'o'), '--decisions', bad], { ...w.deps, out: () => {}, err: (s) => msgs.push(s) }), 1); assert.match(msgs.join('\n'), /decisions/);
    assert.equal(w.state.calls.length, 0);
  } finally { w.clean(); }
});
test('CLI usage mentions --decisions', async () => {
  const msgs = []; await main([], { err: (s) => msgs.push(s) }); assert.match(msgs.join('\n'), /--decisions/);
});

// ======================= fix round: review findings =======================
const planOnce = async (w, ops) => plan(w, ops);
const ledgerLines = (w) => readdirSync(w.ledgerDir).sort().flatMap((n) => readFileSync(join(w.ledgerDir, n), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const itemVideos = (w, id) => w.state.items[id].map((r) => r.snippet.resourceId.videoId);

// ---- 1. private-first create, resume, never adopt ----
test('create: a failed item leaves the playlist PRIVATE; a re-run resumes (only the missing item, then privacy, then done), never a second playlist', async () => {
  const w = world({ failItemAt: 1 });
  try {
    const p = await planOnce(w, [create('vietnam', 'Vietnam', ['v1', 'v2'])]);
    await assert.rejects(() => applyPlan(p, { ledgerDir: w.ledgerDir }, w.deps), /item broke/);
    assert.equal(w.state.playlists.PLNEW1.status.privacyStatus, 'private'); assert.deepEqual(itemVideos(w, 'PLNEW1'), ['v1']); assert.equal(w.state.puts, undefined);
    w.state.failItemAt = -1; const before = w.state.posts.length;
    const r = await applyPlan(p, { ledgerDir: w.ledgerDir }, w.deps);
    assert.equal(r.done, 1); assert.equal(r.alreadyApplied, 0);
    assert.deepEqual(itemVideos(w, 'PLNEW1'), ['v1', 'v2']); assert.equal(Object.keys(w.state.playlists).filter((k) => k.startsWith('PLNEW')).length, 1);
    assert.equal(w.state.posts.length, before + 1); assert.equal(w.state.posts.at(-1).body.snippet.resourceId.videoId, 'v2'); // only the missing item
    assert.equal(w.state.playlists.PLNEW1.status.privacyStatus, 'public');
    const st = ledgerLines(w).map((l) => l.status); assert.equal(st.at(-1), 'done'); assert.ok(st.includes('privacy-done'));
    // and undo of the resumed attempt still deletes exactly that playlist
    const files = readdirSync(w.ledgerDir).sort().map((n) => join(w.ledgerDir, n)); assert.equal(files.length, 2);
    const u0 = await undoLedger(files[0], { only: ['vietnam'] }, w.deps); assert.equal(u0['changed-since'], 1); assert.ok(w.state.playlists.PLNEW1); // the first run's file does not know the item the resume inserted
    const u = await undoLedger(files[1], { only: ['vietnam'] }, w.deps); assert.ok(u.undone >= 1); assert.equal(w.state.playlists.PLNEW1, undefined);
  } finally { w.clean(); }
});
test('create: the privacy is only set after EVERY item has its ledger line; a refused privacy update leaves it private and a re-run finishes', async () => {
  const w = world();
  try {
    const p = await planOnce(w, [create('vietnam', 'Vietnam', ['v1', 'v2'])]);
    w.state.afterPut = (path) => { if (path.endsWith('/playlists')) w.state.playlists.PLNEW1.status.privacyStatus = 'private'; }; // YouTube "forgets" the update
    await assert.rejects(() => applyPlan(p, { ledgerDir: w.ledgerDir }, w.deps), /mismatch/);
    assert.deepEqual(ledgerLines(w).map((l) => l.status), ['pending', 'created', 'item-created', 'item-created', 'privacy-pending', 'mismatch']);
    w.state.afterPut = null; const posts = w.state.posts.length;
    const r = await applyPlan(p, { ledgerDir: w.ledgerDir }, w.deps); assert.equal(r.done, 1); assert.equal(w.state.posts.length, posts); // no item inserted twice
    assert.equal(w.state.playlists.PLNEW1.status.privacyStatus, 'public'); assert.deepEqual(itemVideos(w, 'PLNEW1'), ['v1', 'v2']);
  } finally { w.clean(); }
});
test('create: a requested private playlist gets no privacy update at all', async () => {
  const w = world();
  try { const r = await run(w, [create('vietnam', 'Vietnam', ['v1'], 'private')]); assert.equal(r.done, 1); assert.equal(w.state.puts, undefined); assert.ok(!ledgerLines(w).some((l) => /^privacy/.test(l.status))); } finally { w.clean(); }
});
test('create: insert succeeded but the response was lost (no created line): the playlist is private, a re-run stops with playlist-exists-not-ours and touches nothing', async () => {
  const w = world({ dieAfterPost: true });
  try {
    const p = await planOnce(w, [create('vietnam', 'Vietnam', ['v1'])]);
    await assert.rejects(() => applyPlan(p, { ledgerDir: w.ledgerDir }, w.deps), /network/);
    assert.equal(w.state.playlists.PLNEW1.status.privacyStatus, 'private'); w.state.dieAfterPost = false; const posts = w.state.posts.length;
    await assert.rejects(() => applyPlan(p, { ledgerDir: w.ledgerDir }, w.deps), (e) => { assert.match(e.message, /playlist-exists-not-ours/); assert.match(e.message, /PLNEW1/); assert.match(e.message, /Studio/); return true; });
    assert.equal(w.state.posts.length, posts); assert.equal(w.state.deletes, undefined); assert.equal(w.state.puts, undefined); assert.ok(w.state.playlists.PLNEW1);
  } finally { w.clean(); }
});
test('create: a playlist with the title that this ledger did not create is never adopted, never deleted', async () => {
  const w = world();
  try {
    const op = { kind: 'playlist-create', channel: 'asia', id: 'k', key: 'k', title: 'PL', before: {}, after: { title: 'PL', description: '', privacyStatus: 'public' }, items: ['v1'], source: 'decisions' }; // p1 is titled PL
    await assert.rejects(() => applyPlan({ ops: [op] }, { ledgerDir: w.ledgerDir }, w.deps), /playlist-exists-not-ours.*p1/s);
    assert.equal(writes(w).length, 0); assert.ok(w.state.playlists.p1);
  } finally { w.clean(); }
});
test('create: a created line in ANOTHER op or channel does not let a same-title playlist be resumed', async () => {
  const w = world();
  try {
    writeLedger(w, [{ ts: 't1', status: 'pending', kind: 'playlist-create', channel: 'asia', id: 'other', planned: { title: 'x' } }, { ts: 't2', status: 'created', kind: 'playlist-create', channel: 'asia', id: 'other', of: 't1', playlistId: 'p1' }]);
    const op = { kind: 'playlist-create', channel: 'asia', id: 'k', key: 'k', title: 'PL', before: {}, after: { title: 'PL', description: '', privacyStatus: 'public' }, items: ['v1'], source: 'decisions' };
    await assert.rejects(() => applyPlan({ ops: [op] }, { ledgerDir: w.ledgerDir }, w.deps), /playlist-exists-not-ours/); assert.equal(writes(w).length, 0);
  } finally { w.clean(); }
});
test('create: a done line for the key means already-applied (no list, no insert)', async () => {
  const w = world();
  try {
    const p = await planOnce(w, [create('vietnam', 'Vietnam', ['v1'])]); await applyPlan(p, { ledgerDir: w.ledgerDir }, w.deps); const n = writes(w).length;
    const r = await applyPlan(p, { ledgerDir: w.ledgerDir }, w.deps); assert.equal(r.alreadyApplied, 1); assert.equal(writes(w).length, n);
  } finally { w.clean(); }
});
test('create budget: the privacy update is counted (150 for a private create, 200 for a public one); a resume counts only what is missing', async () => {
  const w = world();
  try {
    const rp = await run(w, [create('a', 'Alpha', ['v1', 'v2'], 'private')], { maxUnits: 152 }); assert.equal(rp.done, 0); assert.match(rp.stoppedReason, /maxUnits/);
    const rp2 = await run(w, [create('a', 'Alpha', ['v1', 'v2'], 'private')], { maxUnits: 153 }); assert.equal(rp2.done, 1);
  } finally { w.clean(); }
  const w2 = world({ failItemAt: 1 });
  try {
    const p = await planOnce(w2, [create('vietnam', 'Vietnam', ['v1', 'v2'])]);
    await assert.rejects(() => applyPlan(p, { ledgerDir: w2.ledgerDir }, w2.deps), /item broke/); w2.state.failItemAt = -1;
    const r = await applyPlan(p, { ledgerDir: w2.ledgerDir, maxUnits: 100 }, w2.deps); // 1 missing item + 1 privacy update = 100 units, plus the reads
    assert.equal(r.done, 0); assert.match(r.stoppedReason, /maxUnits/); assert.equal(w2.state.playlists.PLNEW1.status.privacyStatus, 'private');
    const r2 = await applyPlan(p, { ledgerDir: w2.ledgerDir, maxUnits: 110 }, w2.deps); assert.equal(r2.done, 1);
  } finally { w2.clean(); }
});
test('undo of a created playlist: items we did not insert, or a privacy that is neither private nor the planned one, make it changed-since (nothing deleted)', async () => {
  const w = world();
  try {
    await run(w, [create('vietnam', 'Vietnam', ['v1'])]);
    w.state.items.PLNEW1.push({ id: 'PIHAND', snippet: { playlistId: 'PLNEW1', resourceId: { videoId: 'v2' } } });
    const u = await undoLedger(readLedger(w).file, {}, w.deps); assert.equal(u['changed-since'], 1); assert.equal(w.state.deletes, undefined);
    w.state.items.PLNEW1.pop(); w.state.playlists.PLNEW1.status.privacyStatus = 'unlisted';
    const u2 = await undoLedger(readLedger(w).file, {}, w.deps); assert.equal(u2['changed-since'], 1); assert.equal(w.state.deletes, undefined);
    w.state.playlists.PLNEW1.status.privacyStatus = 'private'; // still private (an unfinished build) is deletable
    assert.equal((await undoLedger(readLedger(w).file, {}, w.deps)).undone, 1); assert.equal(w.state.playlists.PLNEW1, undefined);
  } finally { w.clean(); }
});

// ---- 2. which refusals let a channel rename continue ----
const putFails = (w, status, reasons, message) => { const orig = w.deps.fetch; w.deps.fetch = async (u, o = {}) => (o.method === 'PUT' && /\/channels\?/.test(u) ? { ok: false, status, json: async () => ({ error: { message, errors: reasons.map((reason) => ({ reason })) } }) } : orig(u, o)); };
for (const [status, reasons, message, cont] of [
  [400, ['invalidValue'], 'Invalid channel title', true], [400, [], 'bad request', true], [403, ['channelTitleUpdateForbidden'], 'title cannot be changed now', true], [403, [], 'refused', true], [403, ['somethingElse'], 'refused', true],
  [401, [], 'Invalid Credentials', false], [429, [], 'Too many requests', false], [403, ['quotaExceeded'], 'quota', false], [403, ['rateLimitExceeded'], 'slow down', false], [403, ['dailyLimitExceeded'], 'x', false],
  [403, ['forbidden'], 'The caller does not have permission for this channel', false], [403, ['authError'], 'x', false], [403, ['insufficientPermissions'], 'x', false], [400, ['quotaExceeded'], 'quota', false], [403, [], 'The request cannot be completed because you have exceeded your quota.', false],
]) {
  test(`channel title write answered ${status} [${reasons.join(',')}] ${cont ? 'continues the run' : 'STOPS the run'}`, async () => {
    const w = world(); putFails(w, status, reasons, message);
    try {
      const p = await planOnce(w, [chan({ title: 'New' }), vid('v1', { title: 'T1' })]);
      if (cont) { const r = await applyPlan(p, { ledgerDir: w.ledgerDir }, w.deps); assert.equal(r.refused, 1); assert.equal(r.done, 1); assert.deepEqual(readLedger(w).lines.map((l) => l.status), ['pending', 'refused-by-youtube', 'pending', 'done']); }
      else { await assert.rejects(() => applyPlan(p, { ledgerDir: w.ledgerDir }, w.deps)); assert.deepEqual(readLedger(w).lines.map((l) => l.status), ['pending', 'failed']); assert.equal(w.state.videos.v1.snippet.title, 'Title v1'); }
    } finally { w.clean(); }
  });
}

// ---- 3. a channel title never trusts the write's own answer ----
test('channel title: an answer that CLAIMS the new title is not believed; the live read-back (all retries) decides -> refused-by-youtube', async () => {
  const w = world({ channelTitle: 'lie' });
  try {
    const r = await run(w, [chan({ title: 'Claimed' }), vid('v1', { title: 'T1' })]);
    assert.equal(r.refused, 1); assert.equal(r.done, 1); assert.deepEqual(w.state.sleeps, [5000, 5000, 5000, 5000, 5000]);
    assert.equal(w.state.channels.asia.brandingSettings.channel.title, 'BPA - Asia'); assert.equal(readLedger(w).lines[1].status, 'refused-by-youtube');
    const reads = w.state.calls.slice(w.state.calls.findIndex((c) => c.method === 'PUT')).filter((c) => c.method === 'GET' && /channels\?/.test(c.url) && /brandingSettings/.test(c.url)).length; assert.equal(reads, 6);
  } finally { w.clean(); }
});
test('channel title that really lands is verified by a live read (attempts >= 1, via read-back)', async () => {
  const w = world();
  try { await run(w, [chan({ title: 'Real' })]); const d = readLedger(w).lines[1]; assert.equal(d.via, 'read-back'); assert.ok(d.attempts >= 1); } finally { w.clean(); }
});

// ---- 4. limits by what YouTube counts ----
test('description limit is 5000 BYTES: 2400 three-byte characters and 2600 two-byte characters are refused at plan time, 2400 two-byte ones are fine', async () => {
  const w = world();
  try {
    await assert.rejects(() => plan(w, [vid('v1', { description: '€'.repeat(2400) })]), /7200 bytes|5000/);
    await assert.rejects(() => plan(w, [vid('v1', { description: 'é'.repeat(2600) })]), /5200 bytes|5000/);
    assert.equal((await plan(w, [vid('v1', { description: 'é'.repeat(2400) })])).ops.length, 1); assert.equal((await plan(w, [vid('v1', { description: 'x'.repeat(5000) })])).ops.length, 1);
    await assert.rejects(() => plan(w, [pl('p1', { description: '€'.repeat(2400) })]), /5000/); await assert.rejects(() => plan(w, [create('k', 'N', ['v1']), { ...create('k2', 'M', ['v1']), set: { title: 'M', privacyStatus: 'public', description: '€'.repeat(2400) } }]), /5000/);
  } finally { w.clean(); }
});
test('title limits count code points: 51 emoji in a video title are fine (102 UTF-16 units), 101 emoji are refused; playlist 150, channel 100 the same way', async () => {
  const w = world(); const e = (n) => '😀'.repeat(n);
  try {
    assert.equal((await plan(w, [vid('v1', { title: e(51) })])).ops.length, 1); assert.equal((await plan(w, [vid('v1', { title: e(100) })])).ops.length, 1);
    await assert.rejects(() => plan(w, [vid('v1', { title: e(101) })]), /100/);
    assert.equal((await plan(w, [pl('p1', { title: e(150) })])).ops.length, 1); await assert.rejects(() => plan(w, [pl('p1', { title: e(151) })]), /150/);
    assert.equal((await plan(w, [chan({ title: e(100) })])).ops.length, 1); await assert.rejects(() => plan(w, [chan({ title: e(101) })]), /100/);
  } finally { w.clean(); }
});

// ---- 5. address check: no false refusals, no new holes ----
test('address check: sentence borders without a space, abbreviations and chapter lines pass', async () => {
  const w = world();
  try {
    for (const t of ['Great.Be careful', 'Nice day.Me too', 'Day 1.Co-op', 'approx. 20 minutes', 'Made in the U.S. in 2020', 'No. 1 trip', "St. Monica's church", '00:00 Intro\n01:23 Hanoi\n05:10 Ha Long Bay\n1.Introduction', 'Ha Long Bay.Vietnam is great.Next stop', 'e.g. rice, i.e. noodles']) {
      assert.equal((await plan(w, [vid('v1', { description: t })])).ops.length, 1, t);
    }
  } finally { w.clean(); }
});
test('address check: every real foreign host, the old domain, mixed case, trailing dots, youtu.be, hosts inside @ and # are still refused', async () => {
  const w = world();
  try {
    for (const [t, host] of [['Evil.com', /evil\.com/i], ['EVIL.COM', /evil\.com/i], ['mail me@evil.com', /evil\.com/], ['tag #evil.com', /evil\.com/], ['https://youtu.be/abc', /youtu\.be/], ['youtu.be/abc', /youtu\.be/], ['HTTPS://WWW.EVIL.COM/x', /evil\.com/], ['Www.Evil.Com', /evil\.com/], ['see evil.com.', /evil\.com/], ['https://evil.com./x', /evil\.com/], ['https://www.instagram.com./x', /instagram\.com\./], ['see BeyondParadiseAdventures.NET', /old address/], ['go to shop.example.org/x', /example\.org/]]) {
      await assert.rejects(() => plan(w, [vid('v1', { description: t })]), host, t);
    }
  } finally { w.clean(); }
});

// ---- 6. apply-time content check does not depend on a flag in the plan file ----
test('apply refuses a title/description with a foreign address even when the "source" flag was removed from the op', async () => {
  const w = world();
  try {
    const op = (await plan(w, [vid('v1', { title: 'T1' })])).ops[0]; delete op.source; op.before.description = 'd'; op.after.description = 'see https://evil.example.com'; w.state.calls.length = 0;
    await assert.rejects(() => applyPlan({ ops: [op] }, { ledgerDir: w.ledgerDir }, w.deps), /evil\.example\.com/); assert.equal(w.state.calls.length, 0);
    const op2 = (await plan(w, [vid('v1', { title: 'T1' })])).ops[0]; delete op2.source; op2.after.title = 'a<b'; w.state.calls.length = 0;
    await assert.rejects(() => applyPlan({ ops: [op2] }, { ledgerDir: w.ledgerDir }, w.deps), /<|>/); assert.equal(w.state.calls.length, 0);
  } finally { w.clean(); }
});

// ---- 7. more fake-YouTube sabotage on the read-back ----
for (const [what, mutate, re] of [
  ['defaultAudioLanguage cleared', (v) => { delete v.snippet.defaultAudioLanguage; }, /defaultAudioLanguage/],
  ['defaultLanguage changed', (v) => { v.snippet.defaultLanguage = 'vi'; }, /defaultLanguage/],
  ['tags dropped', (v) => { delete v.snippet.tags; }, /tags/],
  ['privacy flipped', (v) => { v.status.privacyStatus = 'unlisted'; }, /privacyStatus/],
]) {
  test(`video title update where the fake ${what}: the run stops with a mismatch`, async () => {
    const w = world(); w.state.afterPut = (p) => { if (p.endsWith('/videos')) mutate(w.state.videos.v1); };
    try { await assert.rejects(() => run(w, [vid('v1', { title: 'T1' }), vid('v2', { title: 'T2' })]), (e) => /mismatch/.test(e.message) && re.test(e.message)); assert.equal(writes(w).length, 1); } finally { w.clean(); }
  });
}
test('playlist update where the fake clears the description: the run stops with a mismatch', async () => {
  const w = world(); w.state.afterPut = (p) => { if (p.endsWith('/playlists')) w.state.playlists.p1.snippet.description = ''; };
  try { await assert.rejects(() => run(w, [pl('p1', { title: 'New PL' }), vid('v1', { title: 'T1' })]), /mismatch.*description/); assert.equal(writes(w).length, 1); } finally { w.clean(); }
});

// ======================= real-API round =======================
const allFiles = (w) => readdirSync(w.ledgerDir).sort().map((n) => join(w.ledgerDir, n));
const linesOf = (f) => readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// ---- 1/2. every playlists.update carries the full live snippet and the status ----
test('the fake is as strict as the real API: a playlists.update without snippet.title is a 400 "{0}"', async () => {
  const w = world();
  try { const r = await w.deps.fetch('https://www.googleapis.com/youtube/v3/playlists?part=status', { method: 'PUT', headers: { Authorization: 'Bearer AT-asia' }, body: JSON.stringify({ id: 'p1', status: { privacyStatus: 'private' } }) }); assert.equal(r.status, 400); assert.equal((await r.json()).error.message, '{0}'); } finally { w.clean(); }
});
test('playlist privacy-only op: sends part=snippet,status with title, description, language and the new privacy; read-back checks all of it', async () => {
  const w = world();
  try {
    w.state.playlists.p1.snippet.tags = ['t1']; const r = await run(w, [pl('p1', { privacyStatus: 'private' })]); assert.equal(r.done, 1);
    assert.match(w.state.puts[0].url, /playlists\?part=snippet,status$/);
    assert.deepEqual(w.state.puts[0].body, { id: 'p1', snippet: { title: 'PL', description: 'x', tags: ['t1'], defaultLanguage: 'en' }, status: { privacyStatus: 'private' } });
    assert.equal(w.state.playlists.p1.status.privacyStatus, 'private');
  } finally { w.clean(); }
});
test('playlist title/description op keeps the LIVE privacy in the status part', async () => {
  const w = world();
  try { await run(w, [pl('p2', { description: 'new' }, 'africa')]); assert.deepEqual(w.state.puts[0].body.status, { privacyStatus: 'private' }); assert.equal(w.state.playlists.p2.status.privacyStatus, 'private'); } finally { w.clean(); }
});
test('playlist read-back compares the snippet too: a privacy op where the fake clears the description is a mismatch', async () => {
  const w = world(); w.state.afterPut = (p) => { if (p.endsWith('/playlists')) w.state.playlists.p1.snippet.description = ''; };
  try { await assert.rejects(() => run(w, [pl('p1', { privacyStatus: 'private' })]), /mismatch.*description/); } finally { w.clean(); }
});
test('create: the final privacy step sends the full live snippet (strict fake), and its undo restores nothing it should not', async () => {
  const w = world();
  try {
    const r = await run(w, [create('vietnam', 'Vietnam', ['v1'])]); assert.equal(r.done, 1); assert.equal(w.state.playlists.PLNEW1.status.privacyStatus, 'public');
    assert.equal(w.state.puts[0].body.snippet.title, 'Vietnam');
  } finally { w.clean(); }
});
test('undo of a playlist privacy change restores it through a valid playlists.update (title included)', async () => {
  const w = world();
  try {
    await run(w, [pl('p1', { privacyStatus: 'private' })]);
    const u = await undoLedger(allFiles(w)[0], {}, w.deps); assert.equal(u.undone, 1); assert.equal(w.state.playlists.p1.status.privacyStatus, 'public');
    assert.match(w.state.puts[1].url, /part=snippet,status$/); assert.equal(w.state.puts[1].body.snippet.title, 'PL'); assert.deepEqual(w.state.puts[1].body.status, { privacyStatus: 'public' });
  } finally { w.clean(); }
});

// ---- 3. mixed-case TLDs ----
test('address check: non-word TLDs match in any case, English-word TLDs only in lowercase / all caps', async () => {
  const w = world();
  try {
    for (const [t, host] of [['Evil.Com', /evil\.com/i], ['evil.cOm/x', /evil\.com/i], ['see Evil.NET today', /evil\.net/i], ['a.IO', /a\.io/i], ['x.Vn', /x\.vn/i], ['EVIL.COM', /evil\.com/i], ['evil.be', /evil\.be/], ['evil.co/x', /evil\.co/]]) await assert.rejects(() => plan(w, [vid('v1', { description: t })]), host, t);
    for (const t of ['Great.Be careful', 'Nice day.Me too', 'Day 1.Co-op', 'Fun.Us all', 'Look.Info below', 'Go.Shop now']) assert.equal((await plan(w, [vid('v1', { description: t })])).ops.length, 1, t);
  } finally { w.clean(); }
});

// ---- 4. one ledger file per run ----
test('each apply run writes its own ledger file, even two runs in the same second; undo of the later run does not revert the earlier one', async () => {
  const w = world();
  try {
    await run(w, [vid('v1', { title: 'T1' })]); await run(w, [vid('v1', { title: 'T2' })]);
    const fs = allFiles(w); assert.equal(fs.length, 2); for (const f of fs) assert.match(f, /changes-2026-11-16-100000(_\d+)?\.jsonl$/);
    const later = fs.find((f) => linesOf(f).some((l) => l.planned?.title === 'T2'));
    const u = await undoLedger(later, {}, w.deps); assert.equal(u.undone, 1); assert.equal(w.state.videos.v1.snippet.title, 'T1');
  } finally { w.clean(); }
});
test('a ledger with the OLD file name is still read: by undo, and by the create re-run rules', async () => {
  const w = world();
  try {
    const old = join(w.ledgerDir, 'changes-2026-11-16.jsonl'); mkdirSync(w.ledgerDir, { recursive: true });
    w.state.videos.v1.snippet.title = 'T1';
    writeFileSync(old, JSON.stringify({ ts: 't1', status: 'pending', kind: 'video', channel: 'asia', id: 'v1', before: { title: 'Title v1', description: 'L1 v1\nwww.beyondparadiseadventures.net', tags: ['a', 'b'], categoryId: '19', defaultLanguage: 'en', defaultAudioLanguage: 'en' }, planned: { title: 'T1' } }) + '\n');
    assert.equal((await undoLedger(old, {}, w.deps)).undone, 1); assert.equal(w.state.videos.v1.snippet.title, 'Title v1');
    const r = await run(w, [create('vietnam', 'Vietnam', ['v1'])]); assert.equal(r.done, 1);
    writeFileSync(old, readFileSync(old, 'utf8')); // old-named file next to the new one: the re-run reads both
    const r2 = await applyPlan({ ops: [{ kind: 'playlist-create', channel: 'asia', id: 'vietnam', key: 'vietnam', title: 'Vietnam', before: {}, after: { title: 'Vietnam', description: 'About Vietnam', privacyStatus: 'public' }, items: ['v1'], source: 'decisions' }] }, { ledgerDir: w.ledgerDir }, w.deps);
    assert.equal(r2.alreadyApplied, 1);
  } finally { w.clean(); }
});

// ---- 5. a failed op shows the response's reason ----
test('a failed op prints the reason from the response body, not only the message', async () => {
  const w = world(); const orig = w.deps.fetch;
  w.deps.fetch = async (u, o = {}) => (o.method === 'PUT' ? { ok: false, status: 400, json: async () => ({ error: { message: '{0}', errors: [{ reason: 'playlistTitleRequired', message: '{0}' }] } }) } : orig(u, o));
  try {
    await assert.rejects(() => run(w, [vid('v1', { title: 'T1' })]), /playlistTitleRequired/);
    const f = linesOf(allFiles(w)[0]).find((l) => l.status === 'failed'); assert.match(f.error, /playlistTitleRequired/); assert.deepEqual(f.reasons, ['playlistTitleRequired']);
  } finally { w.clean(); }
});

// ---- operator re-run of the same plan after a pending+failed pair ----
test('a pending+failed pair from an earlier run does not block or confuse a re-run of the same plan; undo then restores the public state once', async () => {
  const w = world();
  try {
    const p = await plan(w, [vid('v1', { title: 'T1' }), pl('p1', { privacyStatus: 'private' })]);
    await applyPlan(p, { ledgerDir: w.ledgerDir, only: ['v1'] }, w.deps); // the video op is done
    const orig = w.deps.fetch; let once = true;
    w.deps.fetch = async (u, o = {}) => (o.method === 'PUT' && /playlists/.test(u) && once ? (once = false, json({ error: { message: '{0}' } }, 400)) : orig(u, o));
    await assert.rejects(() => applyPlan(p, { ledgerDir: w.ledgerDir }, w.deps), /400/); // playlist op: pending + failed, nothing changed
    assert.equal(w.state.playlists.p1.status.privacyStatus, 'public');
    const r = await applyPlan(p, { ledgerDir: w.ledgerDir }, w.deps); // re-run of the SAME plan object
    assert.equal(r.alreadyApplied, 1); assert.equal(r.done, 1); assert.equal(r.stale, 0); assert.equal(w.state.playlists.p1.status.privacyStatus, 'private');
    const fs = allFiles(w); const last = fs[fs.length - 1]; const puts = w.state.puts.length;
    const u = await undoLedger(last, {}, w.deps); assert.equal(u.undone, 1); assert.equal(w.state.playlists.p1.status.privacyStatus, 'public'); assert.equal(w.state.puts.length, puts + 1);
    const failedFile = fs.find((f) => linesOf(f).some((l) => l.status === 'failed')); const u2 = await undoLedger(failedFile, { only: ['p1'] }, w.deps);
    assert.equal(u2.undone, 0); assert.equal(u2['not-applied'], 1); assert.equal(w.state.puts.length, puts + 1); // restored once, not twice
  } finally { w.clean(); }
});
