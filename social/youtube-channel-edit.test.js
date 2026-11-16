import { test } from 'node:test'; import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs'; import { tmpdir, homedir } from 'node:os'; import { join } from 'node:path';
import { fixDescription, fixPlaylistDescription, keywordsString, buildPlan, applyPlan, undoLedger, guardedFetch, main } from './youtube-channel-edit.js';
import { CHANNELS } from './youtube-login.js';

const U = 'https://beyondparadiseadventures.com/';
const CANON = `Beyond Paradise Adventures: ${U}`;
const fa = (t, channel = 'asia') => fixDescription(t, { channel });

// ---------- text rules ----------
test('rule 1: every old address form becomes the new one', () => {
  for (const f of ['www.beyondparadiseadventures.net', 'beyondparadiseadventures.net', 'http://www.beyondparadiseadventures.net', 'https://beyondparadiseadventures.net/', 'https://www.beyondparadiseadventures.net/', 'www.beyondparadiseadventures.net!']) {
    assert.equal(fixPlaylistDescription(`See ${f} today`).text, `See ${U} today`, f);
  }
  assert.equal(fixPlaylistDescription('Visit www.beyondparadiseadventures.net/ now').text, `Visit ${U} now`);
  assert.equal(fixPlaylistDescription('x http://beyondparadiseadventures.net! y').text, `x ${U} y`);
  assert.equal(fa('T\nSee www.beyondparadiseadventures.net').text.includes('.net'), false);
});
test('rule 2: shop line and its gear lead-in go; other lines stay; lead-in with another address stays', () => {
  const r = fa('T\n\nKeep this\n🛍️ Browse travel gear & essentials:\nshop.beyondparadiseadventures.net\nAfter');
  assert.equal(r.text, `T\n${CANON}\n\nKeep this\nAfter`);
  const r2 = fa('T\nSee https://example.org gear & shop:\nhttps://shop.beyondparadiseadventures.net/\nAfter');
  assert.ok(r2.text.includes('example.org')); assert.equal(r2.text.includes('shop.'), false);
  assert.equal(fa('T\n👉www.shop.beyondparadiseadventures.net\nZ').text.includes('shop.'), false);
  assert.equal(fixPlaylistDescription('A\n🛒 Check out our curated travel gear:https://shop.beyondparadiseadventures.net/\nB').text, 'A\nB');
});
test('rule 3: TikTok and Twitter lines are deleted, with or without emoji', () => {
  const r = fa('T\nInstagram: @beyondparadiseadventures\nTikTok: @beyondparadiseadventures\n🐦 Twitter: @beyondparadiseA\nEnd');
  assert.equal(r.text, `T\n${CANON}\nInstagram: https://www.instagram.com/beyondparadiseadventures/\nEnd`);
});
test('rule 4: Instagram handle becomes the profile address, emoji kept', () => {
  assert.ok(fa('T\n📸 Instagram: @beyondparadiseadventures ').text.includes('📸 Instagram: https://www.instagram.com/beyondparadiseadventures/'));
});
test('rule 5: other-channel block becomes one line, lead-in removed (asia and africa)', () => {
  const a = fa('T\n🎥 Subscribe to both our YouTube channels for travel videos across the globe:\n🌍 Africa Channel: BPA-Africa\n🌏 Asia Channel: BPA-Asia\n🔔 Don’t forget to like!', 'asia');
  assert.equal(a.text, `T\n${CANON}\nAfrica channel: https://www.youtube.com/@BPA-Africa\n🔔 Don’t forget to like!`);
  const b = fa('T\n▶️ Follow also our channel specialized in Traveling to Asia:\n👉 https://www.youtube.com/channel/UCkWgpqnOXI6RRxZzjFayajg', 'africa');
  assert.equal(b.text, `T\n${CANON}\nAsia channel: https://www.youtube.com/@beyondparadiseadventures`);
  const c = fa('T\n🎥 Subscribe to our YouTube channels\nAfrica & global travel: BPA-Africa\nAsia: BPA-Asia', 'africa');
  assert.ok(c.text.endsWith('Asia channel: https://www.youtube.com/@beyondparadiseadventures'));
  assert.equal(c.text.includes('Subscribe'), false);
});
test('rule 6: whole promo sentences and lines go, including lead-ins; content wording stays', () => {
  const r = fa([
    'T', '', '📍 Which one would you book tomorrow? Let us know! 👇',
    '🌍 Book your dream Vietnam adventure today at www.beyondparadiseadventures.net ✈️',
    '🚀 Plan your trip & get inspired:', '🌐 www.beyondparadiseadventures.net',
    '🌍 Follow @beyondparadiseadventures for more travel inspiration! ✈️ And visit www.beyondparadiseadventures.net to plan your next adventure! 🌿🏝️',
    '📍 Ready to explore Vietnam? Book flights, tours, and more at www.beyondparadiseadventures.net!',
    '🏡 Stay Outside the Town – Book a cozy mountain lodge! 🌿',
    'For more hidden gems and stunning landscapes', 'Follow @beyondparadiseadventures and visit www.beyondparadiseadventures.net ', 'to book your next Vietnam adventure! ✈️🏔️',
    '📍 Ready to tick this off your bucket list? Plan your dream trip at ', 'You need a flight, we have you covered: ', 'www.beyondparadiseadventures.net ✈️',
    '📌 Check out our website for more amazing travel content and bookings:', '👉 www.beyondparadiseadventures.net',
    'Get Your Tickets From', 'https://beyondparadiseadventures.net/',
    '🔔 Subscribe for more!'].join('\n'));
  assert.equal(r.text, [`T`, CANON, '', '📍 Which one would you book tomorrow? Let us know! 👇', '🌍 Follow @beyondparadiseadventures for more travel inspiration! ✈️', '🏡 Stay Outside the Town – Book a cozy mountain lodge! 🌿', '🔔 Subscribe for more!'].join('\n'));
  assert.deepEqual(r.warnings, []);
});
test('rule 6: a promo that cannot be removed cleanly is left and reported', () => {
  const r = fa('T\nPlan your trip with us at\nand more text');
  assert.ok(r.text.includes('Plan your trip with us at')); assert.equal(r.warnings.length, 1);
});
test('rule 7: line 2 is exactly the canonical line, never twice; empty text becomes only that line', () => {
  assert.equal(fa('').text, CANON);
  assert.equal(fa('Only title').text, `Only title\n${CANON}`);
  assert.equal(fa(`Only title\n${CANON}\n\nBody`).text, `Only title\n${CANON}\n\nBody`);
  assert.equal(fa('Title\n\nBody\n' + CANON).text, `Title\n${CANON}\n\nBody`);
});
test('rule 8: tidy trailing spaces, blank runs, leading and trailing blank lines', () => {
  assert.equal(fa('\n\nT  \n\n\n\nBody   \n\n\n').text, `T\n${CANON}\n\nBody`);
});
test('a description needing no change only gains line 2; hashtags, emoji and title untouched', () => {
  const t = '🌴 Title – ✨\n\nSome body 🌿\n\n#A #B';
  assert.equal(fa(t).text, '🌴 Title – ✨\n' + CANON + '\n\nSome body 🌿\n\n#A #B');
});
test('idempotent and invariants over a messy synthetic description', () => {
  const t = '🌴 Title\n\nBody\n🌐 Plan your trip, book flights & hotels, and read our travel blog at:\n🌐 www.beyondparadiseadventures.net\n🛍️ Check out our travel gear & accessories at:\nhttps://shop.beyondparadiseadventures.net/\n📲 Follow us:\nInstagram: @beyondparadiseadventures\nTikTok: @beyondparadiseadventures\nTwitter: @beyondparadiseA\n🎥 Subscribe to our channels:\nBPA- Asia and BPA-Africa\n\n#x';
  for (const ch of ['asia', 'africa']) {
    const once = fa(t, ch); const twice = fa(once.text, ch);
    assert.equal(twice.text, once.text);
    assert.ok(!once.text.includes('.net')); assert.ok(!once.text.includes('shop.')); assert.ok(!/^\W*(TikTok|Twitter):/im.test(once.text));
    assert.equal(once.text.split('\n')[1], CANON);
  }
});
test('playlist: rules 1 and 2 plus tidy only; other promo wording stays; idempotent', () => {
  const t = 'Playlist\n\n📍 Plan your next adventure with us at www.beyondparadiseadventures.net ✈️\n\nTikTok: @x\n';
  const r = fixPlaylistDescription(t);
  assert.equal(r.text, `Playlist\n\n📍 Plan your next adventure with us at ${U} ✈️\n\nTikTok: @x`);
  assert.equal(fixPlaylistDescription(r.text).text, r.text);
  assert.equal(fixPlaylistDescription('').text, '');
});
test('keywordsString quotes phrases with spaces only', () => {
  assert.equal(keywordsString(['Beyond Paradise Adventures', 'Hanoi', 'Ha Long Bay']), '"Beyond Paradise Adventures" Hanoi "Ha Long Bay"');
});

const DATA = join(homedir(), 'Movies', 'Beyond Paradise', 'youtube-archive', 'data');
test('real saved data: every description passes the invariants and no rule warns', { skip: !existsSync(join(DATA, 'asia-videos.json')) }, () => {
  const warned = [];
  for (const ch of ['asia', 'africa']) {
    for (const v of JSON.parse(readFileSync(join(DATA, `${ch}-videos.json`), 'utf8'))) {
      const r = fa(v.snippet.description, ch);
      assert.equal(fa(r.text, ch).text, r.text, `idempotent ${v.id}`);
      assert.ok(!r.text.includes('.net'), `.net ${v.id}`); assert.ok(!r.text.includes('shop.'), `shop ${v.id}`);
      assert.ok(!/^\W*(TikTok|Twitter):/im.test(r.text), `social ${v.id}`);
      assert.equal(r.text.split('\n')[v.snippet.description.trim() ? 1 : 0], CANON, `line2 ${v.id}`); assert.equal(r.text.split('\n').filter((l) => l === CANON).length, 1);
      assert.ok(!/\n\n\n/.test(r.text) && r.text === r.text.trim() && !/ +\n/.test(r.text));
      if (v.snippet.description.trim()) assert.equal(r.text.split('\n')[0], v.snippet.description.replace(/\r/g, '').split('\n')[0].trimEnd(), `line1 ${v.id}`);
      if (r.warnings.length) warned.push(v.id);
    }
    for (const p of JSON.parse(readFileSync(join(DATA, `${ch}-playlists.json`), 'utf8'))) {
      const r = fixPlaylistDescription(p.snippet.description);
      assert.equal(fixPlaylistDescription(r.text).text, r.text, `pl idem ${p.id}`);
      assert.ok(!r.text.includes('.net') && !r.text.includes('shop.'), `pl ${p.id}`);
    }
  }
  assert.deepEqual(warned, []);
});

// ---------- fake YouTube ----------
const rnd = (p) => p + '_' + Math.random().toString(36).slice(2, 10);
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
function world(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'yce-')); const ledgerDir = join(dir, 'ledger');
  const refresh = { asia: rnd('ra'), africa: rnd('rf') };
  writeFileSync(join(dir, 'youtube-client.env'), `YOUTUBE_OAUTH_CLIENT_ID=${rnd('c')}\nYOUTUBE_OAUTH_CLIENT_SECRET=${rnd('s')}\n`);
  for (const c of ['asia', 'africa']) writeFileSync(join(dir, `youtube-${c}.json`), JSON.stringify({ channelId: CHANNELS[c].id, channelTitle: c, scope: 'x', obtainedAt: 'n', refresh_token: refresh[c] }));
  const mk = (id, chan, extra = {}) => ({ id, snippet: { publishedAt: 'p', channelId: CHANNELS[chan].id, title: 'Title ' + id, description: `L1 ${id}\nwww.beyondparadiseadventures.net`, tags: ['a', 'b'], categoryId: chan === 'africa' ? '22' : '19', defaultLanguage: 'en', defaultAudioLanguage: 'en', ...extra }, status: { privacyStatus: 'public' } });
  const state = {
    tokenOwner: { asia: 'asia', africa: 'africa' }, calls: [], events: [], videos: { v1: mk('v1', 'asia'), v2: mk('v2', 'asia'), a1: mk('a1', 'africa') },
    playlists: { p1: { id: 'p1', snippet: { channelId: CHANNELS.asia.id, title: 'PL', description: 'x\nshop.beyondparadiseadventures.net', defaultLanguage: 'en' }, status: { privacyStatus: 'public' } } },
    channels: { asia: { id: CHANNELS.asia.id, brandingSettings: { channel: { title: 'BPA - Asia', description: 'old', keywords: 'old', country: 'VN', defaultLanguage: 'en', unsubscribedTrailer: 'tr' }, image: { bannerExternalUrl: 'https://x/y' } } }, africa: { id: CHANNELS.africa.id, brandingSettings: { channel: { title: 'BPA - Africa', description: 'oldA', keywords: 'oldA', country: 'TZ' }, image: { bannerExternalUrl: 'https://x/z' } } } },
    failPut: null, corruptPut: null, onPut: null, ...opts,
  };
  const chanOfToken = (auth) => state.tokenOwner[auth.replace('Bearer AT-', '')];
  const fetch = async (url, o = {}) => {
    url = String(url); const u = new URL(url); const method = o.method || 'GET'; state.calls.push({ url, method, body: o.body });
    if (u.host === 'oauth2.googleapis.com') { const b = new URLSearchParams(o.body); const who = b.get('refresh_token') === refresh.asia ? 'asia' : 'africa'; return json({ access_token: 'AT-' + who }); }
    const owner = chanOfToken(o.headers.Authorization); const q = u.searchParams; const p = u.pathname;
    if (method === 'GET') {
      if (p.endsWith('/channels')) return json({ items: [{ id: state.channels[owner].id, brandingSettings: structuredClone(state.channels[owner].brandingSettings), contentDetails: { relatedPlaylists: { uploads: 'UP' } } }] });
      if (p.endsWith('/videos')) return json({ items: q.get('id').split(',').filter((i) => state.videos[i]).map((i) => structuredClone(state.videos[i])) });
      if (p.endsWith('/playlists')) return json({ items: q.get('id') ? [structuredClone(state.playlists[q.get('id')])].filter(Boolean) : Object.values(state.playlists).filter((x) => x.snippet.channelId === state.channels[owner].id).map((x) => structuredClone(x)) });
      if (p.endsWith('/playlistItems')) return json({ items: Object.keys(state.videos).filter((i) => state.videos[i].snippet.channelId === state.channels[owner].id).map((i) => ({ contentDetails: { videoId: i } })) });
    }
    if (method === 'PUT') {
      state.events.push('PUT'); if (state.onPut) state.onPut(url, o);
      const body = JSON.parse(o.body); state.puts = (state.puts || []).concat([{ url, body }]);
      if (state.failPut) return json({ error: { message: 'boom' } }, 500);
      if (p.endsWith('/videos')) { const cur = state.videos[body.id]; const sn = { publishedAt: cur.snippet.publishedAt, channelId: cur.snippet.channelId, ...body.snippet }; if (state.corruptPut) sn.title = 'CHANGED'; cur.snippet = sn; return json(cur); }
      if (p.endsWith('/playlists')) { const cur = state.playlists[body.id]; cur.snippet = { channelId: cur.snippet.channelId, ...body.snippet }; return json(cur); }
      if (p.endsWith('/channels')) { state.channels[owner].brandingSettings = body.brandingSettings; return json(state.channels[owner]); }
    }
    return json({}, 404);
  };
  const deps = { configDir: dir, env: {}, fetch, now: new Date('2026-11-16T10:00:00Z') };
  return { dir, ledgerDir, state, deps, clean: () => rmSync(dir, { recursive: true, force: true }) };
}
const putCount = (w) => w.state.calls.filter((c) => c.method === 'PUT').length;
const oneOp = (w, id = 'v1', chan = 'asia') => {
  const live = w.state.videos[id].snippet;
  return { kind: 'video', channel: chan, id, title: live.title, before: { description: live.description, categoryId: live.categoryId }, after: { description: 'NEW ' + id, categoryId: live.categoryId }, warnings: [] };
};
const readLedger = (w) => { const f = readdirSync(w.ledgerDir).map((n) => join(w.ledgerDir, n)); return { file: f[0], lines: readFileSync(f[0], 'utf8').trim().split('\n').map((l) => JSON.parse(l)) }; };

test('buildPlan: one op per changed object, none for unchanged ones, africa category 22 -> 19', async () => {
  const w = world();
  try {
    // v2 already fixed, asia channel already matches the texts
    w.state.videos.v2.snippet.description = fa(w.state.videos.v2.snippet.description, 'asia').text;
    const texts = JSON.parse(readFileSync(new URL('./youtube-channel-texts.json', import.meta.url), 'utf8'));
    w.state.channels.asia.brandingSettings.channel.description = texts.asia.description; w.state.channels.asia.brandingSettings.channel.keywords = keywordsString(texts.asia.keywords);
    const plan = await buildPlan(w.deps);
    assert.equal(plan.createdAt, '2026-11-16T10:00:00.000Z');
    const ids = plan.ops.map((o) => `${o.kind}:${o.channel}:${o.id}`).sort();
    assert.deepEqual(ids, [`channel:africa:${CHANNELS.africa.id}`, 'playlist:asia:p1', 'video:africa:a1', 'video:asia:v1'].sort());
    const a1 = plan.ops.find((o) => o.id === 'a1'); assert.equal(a1.before.categoryId, '22'); assert.equal(a1.after.categoryId, '19');
    assert.equal(plan.ops.find((o) => o.id === 'v1').after.categoryId, '19');
    assert.equal(plan.ops.find((o) => o.kind === 'playlist').after.description, 'x');
    assert.equal(putCount(w), 0);
    const ch = plan.ops.find((o) => o.kind === 'channel'); assert.equal(ch.after.keywords, '"Beyond Paradise Adventures" "East Africa travel" Zanzibar "Stone Town" "Africa travel" "Rwanda gorilla trekking"');
  } finally { w.clean(); }
});

test('apply sends the complete snippet back (tags, title, languages) with only description/category changed', async () => {
  const w = world();
  try {
    const before = structuredClone(w.state.videos.v1.snippet); const op = oneOp(w);
    const r = await applyPlan({ ops: [op] }, { ledgerDir: w.ledgerDir }, w.deps);
    assert.equal(r.done, 1); assert.equal(putCount(w), 1);
    const put = w.state.puts[0]; assert.match(put.url, /^https:\/\/www\.googleapis\.com\/youtube\/v3\/videos\?part=snippet$/);
    assert.deepEqual(put.body, { id: 'v1', snippet: { title: before.title, description: 'NEW v1', tags: before.tags, categoryId: before.categoryId, defaultLanguage: 'en', defaultAudioLanguage: 'en' } });
    assert.equal(w.state.videos.v1.snippet.tags.length, 2);
    const { lines, file } = readLedger(w); assert.deepEqual(lines.map((l) => l.status), ['pending', 'done']); assert.equal(lines[1].verified, true);
    assert.match(file, /changes-2026-11-16\.jsonl$/); assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(r.ledger, file);
  } finally { w.clean(); }
});
test('apply omits snippet keys the live snippet does not have', async () => {
  const w = world(); delete w.state.videos.v1.snippet.defaultAudioLanguage; delete w.state.videos.v1.snippet.tags;
  try { await applyPlan({ ops: [oneOp(w)] }, { ledgerDir: w.ledgerDir }, w.deps); const s = w.state.puts[0].body.snippet; assert.ok(!('tags' in s)); assert.ok(!('defaultAudioLanguage' in s)); assert.equal(s.defaultLanguage, 'en'); } finally { w.clean(); }
});
test('apply playlist and channel parts are sent whole', async () => {
  const w = world();
  try {
    const pl = { kind: 'playlist', channel: 'asia', id: 'p1', title: 'PL', before: { description: 'x\nshop.beyondparadiseadventures.net' }, after: { description: 'x' } };
    const ch = { kind: 'channel', channel: 'asia', id: CHANNELS.asia.id, title: 'BPA - Asia', before: { description: 'old', keywords: 'old' }, after: { description: 'N', keywords: '"A B" C' } };
    const r = await applyPlan({ ops: [pl, ch] }, { ledgerDir: w.ledgerDir }, w.deps);
    assert.equal(r.done, 2);
    assert.deepEqual(w.state.puts[0].body, { id: 'p1', snippet: { title: 'PL', description: 'x', defaultLanguage: 'en' } });
    assert.match(w.state.puts[1].url, /channels\?part=brandingSettings$/);
    const sent = w.state.puts[1].body.brandingSettings; assert.deepEqual(sent.image, { bannerExternalUrl: 'https://x/y' });
    assert.equal(sent.channel.country, 'VN'); assert.equal(sent.channel.unsubscribedTrailer, 'tr'); assert.equal(sent.channel.title, 'BPA - Asia'); assert.equal(sent.channel.description, 'N'); assert.equal(sent.channel.keywords, '"A B" C');
    assert.equal(w.state.channels.asia.brandingSettings.channel.description, 'N');
  } finally { w.clean(); }
});
test('apply skips a stale op with no PUT', async () => {
  const w = world();
  try {
    const op = oneOp(w); w.state.videos.v1.snippet.description = 'edited by hand since the plan';
    const r = await applyPlan({ ops: [op] }, { ledgerDir: w.ledgerDir }, w.deps);
    assert.equal(r.stale, 1); assert.equal(r.done, 0); assert.equal(putCount(w), 0); assert.equal(w.state.videos.v1.snippet.description, 'edited by hand since the plan');
  } finally { w.clean(); }
});
test('tampered plan (title change) is refused with no PUT, even when an earlier op is fine', async () => {
  const w = world();
  try {
    const good = oneOp(w, 'v2'); const bad = oneOp(w); bad.after.title = 'Hijacked';
    await assert.rejects(() => applyPlan({ ops: [good, bad] }, { ledgerDir: w.ledgerDir }, w.deps), /title/);
    assert.equal(putCount(w), 0);
    const bad2 = oneOp(w); bad2.after.privacyStatus = 'private';
    await assert.rejects(() => applyPlan({ ops: [bad2] }, { ledgerDir: w.ledgerDir }, w.deps), /privacyStatus/);
    const pl = { kind: 'playlist', channel: 'asia', id: 'p1', before: { description: 'x' }, after: { description: 'y', categoryId: '1' } };
    await assert.rejects(() => applyPlan({ ops: [pl] }, { ledgerDir: w.ledgerDir }, w.deps), /categoryId/);
    assert.equal(putCount(w), 0);
  } finally { w.clean(); }
});
test('wrong channel for the token is refused with no PUT', async () => {
  const w = world();
  try {
    w.state.tokenOwner.asia = 'africa'; // the asia sign-in actually belongs to the africa channel
    await assert.rejects(() => applyPlan({ ops: [oneOp(w)] }, { ledgerDir: w.ledgerDir }, w.deps), /channel/i);
    assert.equal(putCount(w), 0);
    const w2 = world(); w2.state.videos.v1.snippet.channelId = CHANNELS.africa.id;
    await assert.rejects(() => applyPlan({ ops: [oneOp(w2)] }, { ledgerDir: w2.ledgerDir }, w2.deps), /channel/i);
    assert.equal(putCount(w2), 0); w2.clean();
  } finally { w.clean(); }
});
test('ledger has pending before the PUT is issued, done after', async () => {
  const w = world(); let seen;
  w.state.onPut = () => { seen = readLedger(w).lines.map((l) => l.status); };
  try { await applyPlan({ ops: [oneOp(w)] }, { ledgerDir: w.ledgerDir }, w.deps); assert.deepEqual(seen, ['pending']); assert.deepEqual(readLedger(w).lines.map((l) => l.status), ['pending', 'done']); } finally { w.clean(); }
});
test('read-back mismatch stops the run; later ops are not written', async () => {
  const w = world(); w.state.corruptPut = true;
  try {
    await assert.rejects(() => applyPlan({ ops: [oneOp(w, 'v1'), oneOp(w, 'v2')] }, { ledgerDir: w.ledgerDir }, w.deps), /mismatch/i);
    assert.equal(putCount(w), 1); assert.deepEqual(readLedger(w).lines.map((l) => l.status), ['pending', 'mismatch']);
  } finally { w.clean(); }
});
test('HTTP error on the write: failed ledger line, run stops', async () => {
  const w = world(); w.state.failPut = true;
  try {
    await assert.rejects(() => applyPlan({ ops: [oneOp(w, 'v1'), oneOp(w, 'v2')] }, { ledgerDir: w.ledgerDir }, w.deps), /500|boom/);
    assert.equal(putCount(w), 1); assert.deepEqual(readLedger(w).lines.map((l) => l.status), ['pending', 'failed']);
  } finally { w.clean(); }
});
test('maxUnits stops cleanly before the write that would exceed it', async () => {
  const w = world();
  try {
    const r = await applyPlan({ ops: [oneOp(w, 'v1'), oneOp(w, 'v2')] }, { ledgerDir: w.ledgerDir, maxUnits: 60 }, w.deps);
    assert.equal(r.done, 1); assert.equal(putCount(w), 1); assert.match(r.stoppedReason, /maxUnits/i); assert.ok(r.units <= 60);
    const w2 = world(); const r2 = await applyPlan({ ops: [oneOp(w2)] }, { ledgerDir: w2.ledgerDir, maxUnits: 10 }, w2.deps);
    assert.equal(r2.done, 0); assert.equal(putCount(w2), 0); w2.clean();
  } finally { w.clean(); }
});
test('only limits the run to the listed ids', async () => {
  const w = world();
  try { const r = await applyPlan({ ops: [oneOp(w, 'v1'), oneOp(w, 'v2')] }, { ledgerDir: w.ledgerDir, only: ['v2'] }, w.deps); assert.equal(r.done, 1); assert.equal(r.skipped, 1); assert.equal(w.state.puts[0].body.id, 'v2'); } finally { w.clean(); }
});
test('non-Google host is refused (guardedFetch) and every request in a run is on a Google host', async () => {
  let called = 0; const gf = guardedFetch(async () => { called++; return json({}); });
  await assert.rejects(() => gf('https://evil.example.com/x'), /host/i); await assert.rejects(() => gf('http://www.googleapis.com/x'), /host|https/i); await assert.rejects(() => gf('https://www.googleapis.com.evil.com/x'), /host/i);
  assert.equal(called, 0); await gf('https://www.googleapis.com/youtube/v3/videos'); await gf('https://oauth2.googleapis.com/token'); assert.equal(called, 2);
  const w = world();
  try { await applyPlan({ ops: [oneOp(w)] }, { ledgerDir: w.ledgerDir }, w.deps); for (const c of w.state.calls) assert.match(new URL(c.url).host, /^(www|oauth2)\.googleapis\.com$/); } finally { w.clean(); }
});
test('undo restores, verifies, and skips entries changed since', async () => {
  const w = world();
  try {
    const orig1 = structuredClone(w.state.videos.v1.snippet);
    await applyPlan({ ops: [oneOp(w, 'v1'), oneOp(w, 'v2')] }, { ledgerDir: w.ledgerDir }, w.deps);
    w.state.videos.v2.snippet.description = 'someone edited v2 after us';
    const { file } = readLedger(w);
    const r = await undoLedger(file, {}, w.deps);
    assert.equal(r.undone, 1); assert.equal(r['changed-since'], 1);
    assert.equal(w.state.videos.v1.snippet.description, orig1.description); assert.deepEqual(w.state.videos.v1.snippet.tags, orig1.tags);
    assert.equal(w.state.videos.v2.snippet.description, 'someone edited v2 after us');
    assert.ok(readLedger(w).lines.some((l) => l.status === 'undone' && l.id === 'v1'));
    const again = await undoLedger(file, {}, w.deps); assert.equal(again.undone, 0);
  } finally { w.clean(); }
});
test('undo --only limits to one id', async () => {
  const w = world();
  try { const o1 = w.state.videos.v1.snippet.description; await applyPlan({ ops: [oneOp(w, 'v1'), oneOp(w, 'v2')] }, { ledgerDir: w.ledgerDir }, w.deps); const { file } = readLedger(w); const r = await undoLedger(file, { only: ['v1'] }, w.deps); assert.equal(r.undone, 1); assert.equal(w.state.videos.v1.snippet.description, o1); assert.equal(w.state.videos.v2.snippet.description, 'NEW v2'); } finally { w.clean(); }
});

test('CLI: no or unknown command prints usage, exits 2, makes no network call', async () => {
  for (const argv of [[], ['frobnicate']]) {
    let calls = 0; const out = [];
    const code = await main(argv, { fetch: async () => { calls++; return json({}); }, out: (s) => out.push(s), err: (s) => out.push(s) });
    assert.equal(code, 2); assert.equal(calls, 0); assert.match(out.join('\n'), /usage/i);
  }
});
test('CLI plan writes plan.json and a compact plan.md with a summary table', async () => {
  const w = world(); const out = join(w.dir, 'out');
  try {
    const code = await main(['plan', '--out', out], { ...w.deps, out: () => {}, err: () => {} });
    assert.equal(code, 0); const plan = JSON.parse(readFileSync(join(out, 'plan.json'), 'utf8')); assert.ok(plan.ops.length >= 4);
    const md = readFileSync(join(out, 'plan.md'), 'utf8');
    assert.match(md, /\| *kind/i); assert.match(md, /video asia v1 — Title v1/); assert.match(md, /^- www\.beyondparadiseadventures\.net$/m); assert.match(md, /^\+ Beyond Paradise Adventures: https:\/\/beyondparadiseadventures\.com\/$/m);
    assert.equal(putCount(w), 0);
  } finally { w.clean(); }
});
