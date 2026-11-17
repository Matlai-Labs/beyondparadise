import './test-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { CLIP_REASONS, HOOK_REASONS } from './review-items.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(HERE, 'review-page.html'), 'utf8');
const pure = vm.runInNewContext(`${html.split('// BEGIN PURE')[1].split('// END PURE')[0]}; ({ LIST_PAGE, LABELS, REASON_TEXT, REASON_PREFIX, FALLBACK, filterItems, countKinds, moveIndex, windowOf, reasonText, stateLine, clipTitle, rowText, statusLines, factLines, anyPending, noteText, statusHint, quietLine, videoUi, shouldAutoplay, PLAY_TEXT, PLAYING_LINE, PAUSED_LINE, VIDEO_FAILED_TEXT, VIDEO_WAIT_MS, videoFailureAction })`);

test('static rules: no external request, no HTML injection, no inline handlers, nonce on every script', () => {
  assert.ok(html.length < 60000); assert.doesNotMatch(html, /https?:\/\//); assert.doesNotMatch(html, /<link|@import|<iframe/);
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) assert.ok(!html.includes(bad), bad);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/); const scripts = html.match(/<script\b[^>]*>/g) || []; assert.ok(scripts.length >= 1); for (const s of scripts) assert.match(s, /nonce="__NONCE__"/);
  assert.doesNotMatch(html.match(/<style\b[^>]*>/)[0], /nonce/);
  for (const m of html.matchAll(/fetch\(([^)]*)\)/g)) assert.match(m[1], /^'api\/items'/);
  assert.ok((html.match(/fetch\(/g) || []).length >= 1);
});
test('head: charset, viewport, title', () => {
  assert.match(html, /<meta charset=/i); assert.match(html, /<meta name="viewport"/); assert.match(html, /<title>Beyond Paradise: review<\/title>/);
});
test('the step line, a muted looping inline video built in script, and no video in the markup', () => {
  assert.ok(html.includes('Step 1: look only. Approve and Skip arrive with the next step.')); assert.doesNotMatch(html.split('<script')[0], /<video/);
  for (const w of ["createElement('video')", 'muted = true', 'loop = true', 'playsInline = true', "'media/'"]) assert.ok(html.includes(w), w);
  assert.ok(html.includes('controls = true') && !/controls = (reduce|!reduce|false)/.test(html), 'native controls are on in every case');
});
test('the named elements and the only fetch exist', () => {
  for (const id of ['status', 'filters', 'list', 'card', 'video-slot', 'prev', 'next', 'refresh']) assert.ok(html.includes(`id="${id}"`), id);
  for (const k of ['all', 'hook', 'clip']) assert.ok(html.includes(`data-kind="${k}"`), k);
});
test('server text goes in through textContent only', () => { assert.ok(html.includes('textContent')); assert.ok(!/\.(innerText|srcdoc)\s*=/.test(html)); });
test('plain English: no jargon in markup text or labels', () => {
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '') + Object.values(pure.LABELS).join(' ');
  assert.doesNotMatch(text, /\b(sha\d*|hash|json|manifest|api|mediaId|version|null|undefined|token|nonce)\b/i);
});
test('filterItems and countKinds', () => { const it = [{ kind: 'hook' }, { kind: 'clip' }, { kind: 'hook' }]; assert.equal(pure.filterItems(it, 'hook').length, 2); assert.equal(pure.filterItems(it, 'all').length, 3); assert.deepEqual({ ...pure.countKinds(it) }, { all: 3, hook: 2, clip: 1 }); assert.deepEqual(pure.filterItems(it, 'clip'), [{ kind: 'clip' }]); });
test('moveIndex clamps and never wraps', () => { assert.equal(pure.moveIndex(0, -1, 5), 0); assert.equal(pure.moveIndex(4, 1, 5), 4); assert.equal(pure.moveIndex(2, 1, 5), 3); assert.equal(pure.moveIndex(0, 1, 0), 0); });
test('windowOf keeps 300 items to 50 rows and contains the current index (focus 5)', () => {
  assert.equal(pure.LIST_PAGE, 50); for (const i of [0, 49, 50, 123, 299]) { const w = pure.windowOf(300, i, 50); assert.ok(w.to - w.from <= 50 && w.from <= i && i < w.to, String(i)); assert.equal(w.from % 50, 0); }
  assert.deepEqual({ ...pure.windowOf(0, 0, 50) }, { from: 0, to: 0 });
});
test('every problem code the server can send has a plain sentence', () => { for (const k of ['hooks-unreadable', 'ideas-unavailable', 'library-missing', 'library-unreadable']) assert.match(pure.LABELS[k], /^[A-Z].*\.$/); });

// ── fix round B and C: plain words, phone, keyboard ──────────────────────────────
const readSrc = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');
const codeShape = /[a-z0-9]-[a-z0-9]|[a-z]:[a-z]|_/;
test('B3: every reason code the server modules can emit has its own plain sentence', () => {
  const codes = new Set([...CLIP_REASONS, ...HOOK_REASONS, 'final-check:voice', 'final-check:rules+voice', 'judge:filler', 'alt-text:voice', 'bad-config:autoKinds', 'bad-config:autoRequireApprovedHook', 'bad-hooks-file: cannot read the hooks file (ENOENT)']);
  for (const f of ['auto-lane.js', 'fact-post.js', 'auto-pairing.js', 'review-items.js']) for (const m of readSrc(f).matchAll(/reasons?: \[?'([a-z0-9:-]+)'/g)) codes.add(m[1]);
  for (const m of readSrc('fact-post.js').matchAll(/'((?:title|claim|hook|no)-[a-z-]+)'/g)) codes.add(m[1]);
  assert.ok(codes.size >= 30, `collected ${codes.size}`);
  const missing = [...codes].filter((c) => pure.reasonText(c) === pure.FALLBACK); assert.deepEqual(missing, [], `no sentence for: ${missing.join(', ')}`);
});
test('B3: an unknown code gets the generic sentence and no code is shown', () => {
  assert.equal(pure.FALLBACK, 'The checks refuse it today.'); for (const c of ['zz-unknown-code', '', null, undefined, 'x:y']) assert.equal(pure.reasonText(c), pure.FALLBACK, String(c));
  assert.equal(pure.reasonText('hook-number-not-in-claims'), 'The text has a number that is not in the facts.'); assert.equal(pure.reasonText('hook-subject-mismatch'), 'The text names a different animal than the facts.');
  assert.equal(pure.reasonText('title-claim-differ'), "The idea's title and its fact do not match."); assert.equal(pure.reasonText('single-subject-not-yes'), 'The reviewer has not confirmed one animal in one shot.');
  assert.equal(pure.reasonText('flash-not-checked'), 'Nobody has checked this clip for flashing yet.'); assert.equal(pure.reasonText('render-check-failed'), 'The video file is damaged.');
});
const hookItem = (over = {}) => ({ kind: 'hook', id: 'idea_1', version: 'v', title: 'When lions are easiest to see', preview: { mediaId: null, note: 'video is being prepared' }, facts: { hook: 'x', caption: 'Cap', claims: [{ text: 'Claim', sourceDate: '2026-10-03', source: 'Park service, read 2026-10-03' }], link: '/x/', exampleClip: null }, state: 'approved', reason: null, usableToday: true, actions: [], ...over });
const clipItem = (over = {}) => ({ kind: 'clip', id: 'c-0943', version: 'v', title: 'c-0943', preview: { mediaId: 'm_' + 'a'.repeat(32), note: null }, facts: { durationSec: 7, verdict: 'pass', singleSubject: 'yes', notes: 'a lion', tags: ['lion', 'river-crossing'], flash: false, source: [] }, state: 'eligible', reason: null, usableToday: true, actions: [], ...over });
test('A2 on the card: the approved-hook sentences, exact', () => {
  assert.equal(pure.stateLine(hookItem()), 'Approved. The automatic posting can use it.');
  assert.equal(pure.stateLine(hookItem({ usableToday: false, reason: 'in-history' })), 'Approved, but the automatic posting would not use it today: This idea was posted recently.');
  assert.equal(pure.stateLine(hookItem({ usableToday: false, reason: 'no-matching-clip' })), 'Approved, but the automatic posting would not use it today: No approved, unused clip shows this animal.');
  assert.equal(pure.stateLine(hookItem({ state: 'unapproved', usableToday: false, reason: 'not-approved' })), 'Waiting for your yes.');
  assert.equal(pure.stateLine(hookItem({ state: 'stale', usableToday: false, reason: 'stale' })), 'Out of date: the facts changed since it was written.');
  assert.equal(pure.stateLine(hookItem({ state: 'refused: hook-number-not-in-claims', usableToday: false, reason: 'hook-number-not-in-claims' })), 'The checks refuse it today: The text has a number that is not in the facts.');
});
test('B: clip titles, states and facts in plain words', () => {
  assert.equal(pure.clipTitle(clipItem()), 'Clip, 7 s, shows lion, river crossing'); assert.equal(pure.rowText(clipItem()), 'Clip, 7 s, shows lion, river crossing'); assert.equal(pure.rowText(hookItem()), 'Video text: When lions are easiest to see');
  assert.equal(pure.stateLine(clipItem()), 'Ready to use.'); assert.equal(pure.stateLine(clipItem({ state: 'already used in a post', reason: 'already-used', usableToday: false })), 'Already used in a post.');
  assert.equal(pure.stateLine(clipItem({ state: 'video missing', reason: 'video-missing', usableToday: false })), 'The video file is missing.');
  assert.equal(pure.stateLine(clipItem({ state: 'not eligible: single-subject not yes', reason: 'single-subject-not-yes', usableToday: false })), 'Not ready yet: The reviewer has not confirmed one animal in one shot.');
  const lines = Object.fromEntries(pure.factLines(clipItem()).map(([k, v]) => [k, v]));
  assert.equal(lines['One animal in one shot:'], 'yes'); assert.equal(lines['Flashing:'], 'none found'); assert.equal(lines["Reviewer's decision:"], 'passed'); assert.equal(lines['Shows:'], 'lion, river crossing');
  assert.equal(Object.fromEntries(pure.factLines(clipItem({ facts: { ...clipItem().facts, flash: null } })))['Flashing:'], 'not checked');
  const hl = pure.factLines(hookItem()); assert.ok(hl.some(([k, v]) => k === 'Related page:' && v === '/x/')); assert.ok(hl.some(([k, v]) => k === 'Source:' && v === 'Park service, read 3 Oct 2026'));
  assert.ok(!hl.some(([k]) => k === 'Page:'));
});
test('B: status line wording', () => {
  const NOW = Date.parse('2026-11-17T10:00:00Z'); const base = { autoLane: 'off', stop: { stopped: false, reason: null }, lastPost: { at: '2026-11-12T10:00:00Z', id: 'B26' }, lastRun: { at: '2026-11-17T09:56:00Z', result: 'ok' } };
  assert.deepEqual([...pure.statusLines(base, NOW)], ['Posting: allowed', 'Automatic posting: OFF', 'Last post 12 Nov', 'Last check by the system 4 min ago']);
  assert.equal(pure.statusLines({ ...base, stop: { stopped: true, reason: 'stopped by flag' } }, NOW)[0], 'Posting: stopped (stopped by flag)'); assert.equal(pure.statusLines({ ...base, autoLane: 'on' }, NOW)[1], 'Automatic posting: ON');
  assert.equal(pure.statusLines({ ...base, lastPost: 'none' }, NOW)[2], 'No post recorded yet'); assert.equal(pure.statusLines({ ...base, lastPost: 'unknown' }, NOW)[2], 'Could not be read');
  const bad = [...pure.statusLines({ autoLane: 'unknown', stop: 'unknown', lastPost: 'unknown', lastRun: 'unknown' }, NOW)]; assert.deepEqual(bad, ['Posting: could not be read', 'Automatic posting: could not be read', 'Could not be read', 'Last check by the system: could not be read']);
});
test('B: no code shape reaches any sentence the page can produce', () => {
  const sentences = [...Object.values(pure.REASON_TEXT), ...pure.REASON_PREFIX.map((p) => p[1]), pure.FALLBACK, ...Object.values(pure.LABELS)];
  const items = [hookItem(), hookItem({ usableToday: false, reason: 'in-history' }), hookItem({ state: 'unapproved', reason: 'not-approved' }), hookItem({ state: 'refused: x', reason: 'zz-unknown-code' }), clipItem(), clipItem({ state: 'not eligible: x', reason: 'flash-detected' }), clipItem({ state: 'already used in a post', reason: 'already-used' })];
  for (const it of items) { sentences.push(pure.stateLine(it)); for (const [k, v] of pure.factLines(it)) if (k !== 'Related page:') sentences.push(k, String(v)); }
  sentences.push(...pure.statusLines({ autoLane: 'on', stop: { stopped: true, reason: 'stopped by flag' }, lastPost: 'none', lastRun: 'unknown' }, 0));
  for (const t of sentences) { assert.doesNotMatch(t, codeShape, t); assert.doesNotMatch(t, /\b(null|undefined|NaN|json|hash|token)\b/i, t); }
  assert.ok(sentences.length > 60);
});
test('B4: old wordings are gone from the page', () => {
  for (const old of ['Hook proposal', 'Never expires', 'One subject only', 'Flash check', 'Reviewer says', 'Auto lane', 'System last ran', 'Page:', 'Hook: ', 'no flash', 'No post yet', 'The video is being prepared.']) assert.ok(!html.includes(old), old);
  for (const w of ['Proposed video text', 'Example footage. The real post may use other footage that fits.', 'Nothing waits here. Pick another filter.', 'The page cannot load. Open it again from your own device with Tailscale switched on.', 'This browser could not play the video. Tap Reload. If it stays like this, tell Claude.']) assert.ok(html.includes(w), w);
});
test('B5: an expired session reloads once, then shows the sentence', () => { assert.ok(html.includes('sessionStorage')); assert.ok(/location\.reload\(\)/.test(html)); });
test('C6: sticky buttons, 45vh video, swipe hint, focus, live state, reduced motion', () => {
  assert.match(html, /@media \(max-width: 899px\)[^}]*#nav[^}]*position: sticky/s); assert.match(html, /@media \(max-width: 899px\)[\s\S]*max-height: 45vh/);
  assert.ok(html.includes('Swipe left or right, or use the buttons.')); assert.match(html, /<h2 id="card-title" tabindex="-1">/); assert.ok(html.includes('.focus('));
  assert.match(html, /<p id="state" aria-live="polite">/); assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
});
test('C6: the pressed filter button has at least 4.5:1 contrast in light and dark', () => {
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const light = html.match(/:root \{[^}]*\}/)[0]; const dark = html.match(/@media \(prefers-color-scheme: dark\) \{ :root \{[^}]*\}/)[0];
  for (const [name, block] of [['light', light], ['dark', dark]]) { const acc = /--accent: (#[0-9a-f]{6})/.exec(block)[1]; const fg = /--accent-fg: (#[0-9a-f]{6})/.exec(block)[1]; assert.ok(ratio(acc, fg) >= 4.5, `${name} ${ratio(acc, fg).toFixed(2)}`); }
});
test('C6: Up and Down are not captured; Left, Right, J and K move; modifier keys are left alone', () => {
  const k = html.slice(html.indexOf("addEventListener('keydown'")); const body = k.slice(0, k.indexOf('});'));
  assert.ok(!/ArrowUp|ArrowDown/.test(body)); for (const w of ['ArrowLeft', 'ArrowRight', "'j'", "'k'", 'ctrlKey', 'metaKey', 'altKey']) assert.ok(body.includes(w), w);
});

test('D7: the page asks again by itself while a video is being prepared, and says so in plain words', () => {
  assert.equal(pure.anyPending([{ preview: { note: null } }, { preview: { mediaId: null, note: 'video is being prepared' } }]), true); assert.equal(pure.anyPending([{ preview: { note: 'video missing' } }]), false);
  assert.equal(pure.noteText({ preview: { note: 'video is being prepared' } }), 'This video will appear in a few seconds.'); assert.match(html, /if \(anyPending\(state\.items\)\) retryTimer = setTimeout\(load, \d+\)/);
});

const QUIET = 'No example video yet. Example videos for texts come in a later step. The clips have their videos.';
test('change 1: a video text without an example video gets a small quiet line, no black box; a clip being read keeps a box', () => {
  const none = hookItem({ preview: { mediaId: null, note: 'no example video yet' } });
  assert.equal(pure.quietLine(none), QUIET); assert.equal(pure.noteText(none), QUIET);
  assert.equal(pure.quietLine(clipItem({ preview: { mediaId: null, note: 'video is being prepared' } })), null, 'a clip being read is not the quiet case');
  assert.equal(pure.quietLine(clipItem()), null);
  assert.equal(pure.anyPending([none]), false, 'nothing is being prepared for a video text: no retry');
  assert.equal(pure.anyPending([clipItem({ preview: { mediaId: null, note: 'video is being prepared' } })]), true);
  assert.ok(html.includes('id="video-quiet"')); assert.ok(html.indexOf('id="video-quiet"') > html.indexOf('id="card-title"') && html.indexOf('id="video-quiet"') < html.indexOf('id="video-slot"'), 'under the heading, above the video area');
  assert.match(html, /#video-quiet\s*\{[^}]*font-size: 0\.\d+rem/); assert.ok(!/#video-quiet\s*\{[^}]*background: #000/.test(html));
  assert.ok(html.includes('quietLine(item)'), 'showVideo uses it');
});
test('change 2: the filter buttons are All, Clips, Video texts, then Reload', () => {
  const order = [...html.split('<script')[0].matchAll(/<button type="button"(?: data-kind="(\w+)"| id="(\w+)")/g)].map((m) => m[1] || m[2]).filter((k) => ['all', 'clip', 'hook', 'refresh'].includes(k));
  assert.deepEqual(order, ['all', 'clip', 'hook', 'refresh']);
});
test('change 3: no post record says so, with a hover and tap explanation', () => {
  assert.equal(pure.statusHint('No post recorded yet'), 'This record started on the day the page went live.'); assert.equal(pure.statusHint('Last post 12 Nov'), null);
  assert.ok(html.includes("setAttribute('title'") || html.includes('.title ='), 'hover text'); assert.ok(html.includes("addEventListener('click'") && html.includes('statusHint('), 'tap text');
});
test('change 5: at 390 px the top row stays on one line and Reload keeps its text', () => {
  assert.match(html, /@media \(max-width: 480px\)[\s\S]*?#filters\s*\{[^}]*flex-wrap: nowrap/); assert.match(html, /@media \(max-width: 480px\)[\s\S]*?#filters button\s*\{[^}]*padding: \d+px \d+px/);
  assert.match(html, /<button type="button" id="refresh">Reload<\/button>/);
});

// ── play button: a clip that is not playing always has a big Play video button ───
const ui = (o) => ({ ...pure.videoUi(o) });
test('play: reduced motion never starts by itself and shows the button', () => {
  assert.equal(pure.shouldAutoplay(true), false); assert.equal(pure.shouldAutoplay(false), true);
  assert.deepEqual(ui({ reduce: true, playing: false }), { button: true, errorSentence: false, playingLine: false, pausedLine: true });
});
test('play: autoplay rejected shows the button and no error text', () => {
  assert.deepEqual(ui({ reduce: false, playing: false, playRejected: true, loadedWithin8s: true }), { button: true, errorSentence: false, playingLine: false, pausedLine: true });
});
test('play: an error event or nothing loaded after 8 s shows only the sentence', () => {
  const only = { button: false, errorSentence: true, playingLine: false, pausedLine: false };
  assert.deepEqual(ui({ errored: true }), only); assert.deepEqual(ui({ loadedWithin8s: false }), only); assert.deepEqual(ui({ errored: true, playing: true, playRejected: true }), only);
  assert.equal(pure.VIDEO_FAILED_TEXT, 'This browser could not play the video. Tap Reload. If it stays like this, tell Claude.'); assert.equal(pure.VIDEO_WAIT_MS, 8000);
  assert.equal(ui({ loadedWithin8s: undefined }).errorSentence, false, 'not yet decided is not a failure');
});
test('play: playing hides the button and says it is playing; paused after playing shows the button and Paused.', () => {
  assert.deepEqual(ui({ reduce: false, playing: true, loadedWithin8s: true }), { button: false, errorSentence: false, playingLine: true, pausedLine: false });
  assert.deepEqual(ui({ reduce: true, playing: true }), { button: false, errorSentence: false, playingLine: true, pausedLine: false });
  assert.deepEqual(ui({ reduce: false, playing: false, loadedWithin8s: true }), { button: true, errorSentence: false, playingLine: false, pausedLine: true });
  assert.equal(pure.PLAYING_LINE, 'Playing, no sound. The clip repeats.'); assert.equal(pure.PAUSED_LINE, 'Paused.'); assert.equal(pure.PLAY_TEXT, 'Play video');
});
test('play: every combination gives exactly one of button-or-playing-line unless it failed', () => {
  for (const reduce of [true, false]) for (const playing of [true, false]) for (const playRejected of [true, false]) for (const errored of [true, false]) for (const loadedWithin8s of [true, false, undefined]) {
    const r = pure.videoUi({ reduce, playing, playRejected, errored, loadedWithin8s });
    if (errored || loadedWithin8s === false) assert.deepEqual({ ...r }, { button: false, errorSentence: true, playingLine: false, pausedLine: false });
    else { assert.equal(r.button, !playing); assert.equal(r.playingLine, playing); assert.equal(r.pausedLine, !playing); assert.equal(r.errorSentence, false); }
  }
});
test('play: static - controls on, play() called with its rejection handled, button by textContent, no inline handlers', () => {
  assert.ok(html.includes('v.controls = true')); assert.ok(html.includes('v.muted = true') && html.includes('v.loop = true') && html.includes('v.playsInline = true'));
  assert.match(html, /const p = v\.play\(\);[\s\S]{0,200}p\.then\(\(\) => \{[^\n]*\}, \(\) => \{/, 'play() promise has a rejection handler');
  assert.equal((html.match(/\.play\(\)/g) || []).length, 1, 'play() is only called through start()');
  assert.ok(html.includes("el('button', PLAY_TEXT, 'play-big')") && html.includes("btn.type = 'button'") && html.includes("setAttribute('aria-live', 'polite')"));
  assert.ok(html.includes('v.paused === before'), 'a click that the native controls already handled is not toggled twice');
  assert.ok(/\.play-big \{[^}]*min-height: 64px/.test(html));
  assert.ok(html.includes('shouldAutoplay(reduce)') && html.includes("dead = true; stopVideo();"));
});
test('videoFailureAction: reload only for a lost session (403 or 503) and only once', () => {
  const a = pure.videoFailureAction;
  for (const s of [403, 503]) { assert.equal(a({ probeStatus: s, alreadyReloaded: false }), 'reload'); assert.equal(a({ probeStatus: s }), 'reload'); assert.equal(a({ probeStatus: s, alreadyReloaded: true }), 'sentence'); assert.equal(a({ probeStatus: s, alreadyReloaded: '1' }), 'sentence'); }
  for (const s of [200, 404, 429, 500, null, undefined]) { assert.equal(a({ probeStatus: s, alreadyReloaded: false }), 'sentence', String(s)); assert.equal(a({ probeStatus: s, alreadyReloaded: true }), 'sentence', String(s)); }
  assert.equal(a(), 'sentence'); assert.equal(a({}), 'sentence');
});
test('a failed clip checks the session before it gives up: one probe, one reload per recovery path, the sentence otherwise', () => {
  const m = html.match(/if \(ui\.errorSentence\) \{[\s\S]*?\n      \}/);
  assert.ok(m, 'failure branch found'); const b = m[0];
  assert.ok(b.includes('dead = true; stopVideo();'), 'stops at once');
  for (const w of ["fetch('api/items', { cache: 'no-store' })", 'videoFailureAction(', "sessionStorage.getItem('bpa_reloaded')", "sessionStorage.setItem('bpa_reloaded', '1')", 'location.reload()', "slot.appendChild(el('p', VIDEO_FAILED_TEXT, 'video-note'))"]) assert.ok(b.includes(w), w);
  assert.equal((html.match(/location\.reload\(\)/g) || []).length, 2, 'load() and the clip failure: no other reload');
  assert.equal((html.match(/bpa_reloaded/g) || []).length, 5, 'one storage key, no second key');
  assert.ok(b.includes('videoSerial'), 'a card that is no longer shown gets nothing');
});
