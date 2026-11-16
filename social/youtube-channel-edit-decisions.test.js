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
      if (p.endsWith('/playlists')) return json({ items: q.get('id') ? [structuredClone(state.playlists[q.get('id')])].filter(Boolean) : Object.values(state.playlists).filter((x) => x.snippet.channelId === state.channels[owner].id).map((x) => structuredClone(x)) });
    }
    if (method === 'PUT') {
      const body = JSON.parse(o.body); state.puts = (state.puts || []).concat([{ url, body }]); let res;
      if (p.endsWith('/videos')) { const cur = state.videos[body.id]; if (body.snippet) cur.snippet = { publishedAt: cur.snippet.publishedAt, channelId: cur.snippet.channelId, ...body.snippet }; if (body.status) cur.status = { ...cur.status, ...body.status }; res = cur; }
      if (p.endsWith('/playlists')) { const cur = state.playlists[body.id]; if (body.snippet) cur.snippet = { channelId: cur.snippet.channelId, ...body.snippet }; if (body.status) cur.status = { ...cur.status, ...body.status }; res = cur; }
      if (p.endsWith('/channels')) {
        const cur = state.channels[owner]; const changes = body.brandingSettings.channel.title !== cur.brandingSettings.channel.title;
        if (changes && state.channelTitle === 'http') return json({ error: { message: 'Invalid channel title' } }, 400);
        if (!(changes && state.channelTitle === 'ignore')) cur.brandingSettings = body.brandingSettings;
        res = cur;
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
test('apply playlist privacy: part=status only, the snippet is untouched', async () => {
  const w = world();
  try {
    const r = await run(w, [pl('p1', { privacyStatus: 'private' })]); assert.equal(r.done, 1);
    assert.match(w.state.puts[0].url, /playlists\?part=status$/); assert.deepEqual(w.state.puts[0].body, { id: 'p1', status: { privacyStatus: 'private' } });
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
  try { await run(w, [pl('p1', { description: 'new text' })]); assert.match(w.state.puts[0].url, /playlists\?part=snippet$/); assert.equal(w.state.puts[0].body.status, undefined); } finally { w.clean(); }
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
    assert.match(w.state.posts[0].url, /playlists\?part=snippet,status$/); assert.deepEqual(w.state.posts[0].body, { snippet: { title: 'Vietnam', description: 'About Vietnam' }, status: { privacyStatus: 'public' } });
    assert.match(w.state.posts[1].url, /playlistItems\?part=snippet$/); assert.deepEqual(w.state.posts[1].body, { snippet: { playlistId: 'PLNEW1', resourceId: { kind: 'youtube#video', videoId: 'v1' } } });
    assert.equal(w.state.posts[2].body.snippet.resourceId.videoId, 'v2');
    const { lines, file } = readLedger(w); assert.deepEqual(lines.map((l) => l.status), ['pending', 'created', 'item-created', 'item-created', 'done']);
    assert.equal(lines[1].playlistId, 'PLNEW1'); assert.equal(lines[1].of, lines[0].ts);
    assert.deepEqual(lines.slice(2, 4).map((l) => [l.videoId, l.playlistItemId]), [['v1', 'PI2'], ['v2', 'PI3']]); assert.deepEqual(lines[4].itemIds, ['PI2', 'PI3']);
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
    const r = await run(w, [create('vietnam', 'Vietnam', ['v1', 'v2'])], { maxUnits: 152 }); // 3 read units + 150 would be 153
    assert.equal(r.done, 0); assert.match(r.stoppedReason, /maxUnits/); assert.equal(writes(w).length, 0); assert.equal(existsSync(w.ledgerDir) ? readdirSync(w.ledgerDir).length : 0, 0);
    const r2 = await run(w, [create('vietnam', 'Vietnam', ['v1', 'v2'])], { maxUnits: 153 }); assert.equal(r2.done, 1); assert.equal(writes(w).length, 3);
  } finally { w.clean(); }
});
test('unit budget: inserts of an earlier op are counted against the next op', async () => {
  const w = world();
  try {
    const r = await run(w, [create('a', 'Alpha', ['v1', 'v2']), create('b', 'Beta', ['v1', 'v2'])], { maxUnits: 300 });
    assert.equal(r.done, 1); assert.match(r.stoppedReason, /maxUnits/); assert.equal(w.state.posts.length, 3); assert.ok(r.units >= 153);
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
