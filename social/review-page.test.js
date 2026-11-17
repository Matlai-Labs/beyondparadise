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
const pure = vm.runInNewContext(`${html.split('// BEGIN PURE')[1].split('// END PURE')[0]}; ({ LIST_PAGE, LABELS, REASON_TEXT, REASON_PREFIX, FALLBACK, filterItems, countKinds, moveIndex, windowOf, reasonText, stateLine, clipTitle, rowText, statusLines, factLines, anyPending, noteText, statusHint, quietLine, videoUi, shouldAutoplay, PLAY_TEXT, PLAYING_LINE, PAUSED_LINE, VIDEO_FAILED_TEXT, VIDEO_WAIT_MS, videoFailureAction, EDIT_MAX, NET_TEXT, postingBody, REFUSAL_TEXT, refusalText, waitingItems, decidedItems, decisionRequest, afterRefusal, tokenStep, keyAction, decidedLine, stopButtonText, EDIT_LIMITS, BODY_MAX_BYTES, utf8Length, editProblem, EDIT_PROBLEM_TEXT, hiddenInDraft, canUndo, doneText, confirmText, netText, DONE_TEXT, RELOAD_CODES })`);

test('static rules: no external request, no HTML injection, no inline handlers, nonce on every script', () => {
  assert.ok(html.length < 60000); assert.doesNotMatch(html, /https?:\/\//); assert.doesNotMatch(html, /<link|@import|<iframe/);
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) assert.ok(!html.includes(bad), bad);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/); const scripts = html.match(/<script\b[^>]*>/g) || []; assert.ok(scripts.length >= 1); for (const s of scripts) assert.match(s, /nonce="__NONCE__"/);
  assert.doesNotMatch(html.match(/<style\b[^>]*>/)[0], /nonce/);
  for (const m of html.matchAll(/fetch\(([^)]*)\)/g)) assert.match(m[1], /^'(api\/(items|session|decide|posting)|\.\/)'/);
  assert.ok((html.match(/fetch\(/g) || []).length >= 1);
  assert.equal((html.match(/method: 'POST'/g) || []).length, 3, 'exactly one POST per route: session, decide, posting');
});
test('head: charset, viewport, title', () => {
  assert.match(html, /<meta charset=/i); assert.match(html, /<meta name="viewport"/); assert.match(html, /<title>Beyond Paradise: review<\/title>/);
});
test('the step line, a muted looping inline video built in script, and no video in the markup', () => {
  assert.ok(html.includes('Step 3: posts too. Approve schedules a real post and cannot be undone here. Skip is final. Edit does not approve. Undo for video texts and clips is under What I decided.')); assert.doesNotMatch(html.split('<script')[0], /<video/);
  for (const w of ["createElement('video')", 'muted = true', 'loop = true', 'playsInline = true', "'media/'"]) assert.ok(html.includes(w), w);
  assert.ok(html.includes('controls = true') && !/controls = (reduce|!reduce|false)/.test(html), 'native controls are on in every case');
});
test('the named elements and the only fetch exist', () => {
  for (const id of ['status', 'filters', 'list', 'card', 'video-slot', 'prev', 'next', 'refresh']) assert.ok(html.includes(`id="${id}"`), id);
  for (const k of ['all', 'hook', 'clip', 'draft']) assert.ok(html.includes(`data-kind="${k}"`), k);
});
test('server text goes in through textContent only', () => { assert.ok(html.includes('textContent')); assert.ok(!/\.(innerText|srcdoc)\s*=/.test(html)); });
test('plain English: no jargon in markup text or labels', () => {
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '') + Object.values(pure.LABELS).join(' ');
  assert.doesNotMatch(text, /\b(sha\d*|hash|json|manifest|api|mediaId|version|null|undefined|token|nonce)\b/i);
});
test('filterItems and countKinds', () => { const it = [{ kind: 'hook' }, { kind: 'clip' }, { kind: 'hook' }]; assert.equal(pure.filterItems(it, 'hook').length, 2); assert.equal(pure.filterItems(it, 'all').length, 3); assert.deepEqual({ ...pure.countKinds(it) }, { all: 3, hook: 2, clip: 1, draft: 0 }); assert.deepEqual(pure.filterItems(it, 'clip'), [{ kind: 'clip' }]); });
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
  assert.equal(pure.statusLines({ ...base, stop: { stopped: true, reason: 'stopped by flag' } }, NOW)[0], 'Posting: stopped (a stop switch could not be read)'); assert.equal(pure.statusLines({ ...base, autoLane: 'on' }, NOW)[1], 'Automatic posting: ON');
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

// ── task 12: decision logic (pure part) ──────────────────────────────────────────
test('EDIT_MAX equals HOOK_MAX of the real check', async () => { const { HOOK_MAX } = await import('./fact-post.js'); assert.equal(pure.EDIT_MAX, HOOK_MAX); });
test('every code the server can answer has a plain sentence; none is the fallback; none has jargon', async () => { const { ACTION_CODES } = await import('./bpa-actions.js'); for (const c of ACTION_CODES) { const t = pure.refusalText(c); assert.notEqual(t, pure.FALLBACK, c); assert.match(t, /\.$/, c); assert.doesNotMatch(t, /\b(sha\d*|hash|json|manifest|api|mediaId|version|null|undefined|token|nonce|ledger)\b/i, c); } });
test('every clip and hook reason code has a REASON_TEXT sentence', async () => { const { CLIP_REASONS, HOOK_REASONS } = await import('./review-items.js'); for (const c of [...CLIP_REASONS, ...HOOK_REASONS]) assert.notEqual(pure.reasonText(c), pure.FALLBACK, c); });
test('edit refusals reuse the check sentences with a prefix; an unknown code never shows the code', () => { assert.equal(pure.refusalText('hook-number-not-in-claims'), 'Not saved: The text has a number that is not in the facts.'); assert.equal(pure.refusalText('final-check'), 'Not saved: The wording fails the voice or rules check.'); assert.equal(pure.refusalText('final-check:xyz'), 'Not saved: The wording fails the voice or rules check.'); assert.equal(pure.refusalText('weird-new-code'), pure.FALLBACK); });
test('prototype keys are never codes: __proto__, constructor, toString, hasOwnProperty give the fallback (a string), not a function or an object', () => { for (const c of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) assert.equal(pure.refusalText(c), pure.FALLBACK, c); });
test('decisionRequest: only offered actions; edit text rules', () => {
  const it = { kind: 'hook', id: 'idea_1', version: 'a'.repeat(64), actions: ['approve', 'skip', 'edit'] };
  assert.deepEqual({ ...pure.decisionRequest(it, 'approve') }, { kind: 'hook', id: 'idea_1', version: 'a'.repeat(64), action: 'approve' });
  assert.equal(pure.decisionRequest(it, 'undo'), null); assert.equal(pure.decisionRequest(it, 'edit', ''), null); assert.equal(pure.decisionRequest(it, 'edit', 'x'.repeat(61)), null); assert.equal(pure.decisionRequest(it, 'edit', 'a\nb'), null);
  assert.equal(pure.decisionRequest(it, 'edit', 'a\u200bb'), null); assert.equal(pure.decisionRequest(it, 'edit', 'a\u202eb'), null); assert.equal(pure.decisionRequest(it, 'edit', 'a\u0007b'), null); assert.equal(pure.decisionRequest(it, 'edit', 'a\u007fb'), null);
  assert.equal(pure.decisionRequest(it, 'edit', 'Lions at dawn').text, 'Lions at dawn'); assert.equal(pure.decisionRequest(it, 'edit', 'x'.repeat(60)).text.length, 60);
});
test('waiting and decided lists; decided newest first', () => {
  const items = [{ id: 'a', decision: null }, { id: 'b', decision: { at: '2026-11-10T10:00:00.000Z' } }, { id: 'c', decision: null }, { id: 'd', decision: { at: '2026-11-12T10:00:00.000Z' } }];
  assert.deepEqual(pure.waitingItems(items).map((i) => i.id), ['a', 'c']); assert.deepEqual(pure.decidedItems(items).map((i) => i.id), ['d', 'b']);
});
test('afterRefusal and tokenStep tables', () => { for (const c of ['version-changed', 'stale', 'not-found', 'not-decided', 'already-approved', 'already-skipped']) assert.equal(pure.afterRefusal(c), 'reload'); assert.equal(pure.afterRefusal('lock-busy'), 'stay'); assert.equal(pure.tokenStep({ status: 403, retried: false }), 'refresh-and-retry'); assert.equal(pure.tokenStep({ status: 403, retried: true }), 'give-up'); assert.equal(pure.tokenStep({ status: 409, retried: false }), 'done'); assert.equal(pure.tokenStep({ status: 200, retried: false }), 'done'); assert.equal(pure.tokenStep({ status: 500, retried: false }), 'give-up'); });
test('keys: A S E on a wide screen only, never while typing, busy or repeating; Escape cancels the edit; arrows are not touched here', () => {
  const base = { wide: true, typing: false, busy: false, editing: false, actions: ['approve', 'skip', 'edit'] }; const k = (key, o = {}, c = {}) => pure.keyAction({ key, ctrlKey: false, metaKey: false, altKey: false, repeat: false, ...o }, { ...base, ...c });
  assert.equal(k('a'), 'approve'); assert.equal(k('S'), 'skip'); assert.equal(k('e'), 'edit'); assert.equal(k('a', {}, { wide: false }), null); assert.equal(k('a', {}, { typing: true }), null); assert.equal(k('a', {}, { busy: true }), null); assert.equal(k('a', { repeat: true }), null); assert.equal(k('a', { ctrlKey: true }), null); assert.equal(k('a', { metaKey: true }), null); assert.equal(k('a', { altKey: true }), null);
  assert.equal(k('e', {}, { actions: ['approve', 'skip'] }), null); assert.equal(k('Escape', {}, { editing: true, typing: true }), 'cancel'); assert.equal(k('Escape'), null); assert.equal(k('ArrowLeft'), null);
});
test('decided line and stop button text', () => {
  assert.equal(pure.decidedLine({ kind: 'hook', title: 'Lions at dawn', decision: { kind: 'approved' } }), 'You approved "Lions at dawn".');
  assert.equal(pure.decidedLine({ kind: 'hook', title: 'Lions at dawn', decision: { kind: 'skipped' } }), 'You skipped "Lions at dawn".');
  assert.equal(pure.decidedLine({ kind: 'clip', facts: { durationSec: 4, tags: ['lion'] }, decision: { kind: 'skipped' } }), 'You skipped "Clip, 4 s, shows lion".');
  assert.equal(pure.stopButtonText({ stopped: false, armed: false }), 'Stop all posting'); assert.equal(pure.stopButtonText({ stopped: false, armed: true }), 'Tap again to stop all posting');
  assert.equal(pure.stopButtonText({ stopped: true, armed: false }), 'Allow posting again'); assert.equal(pure.stopButtonText({ stopped: true, armed: true }), 'Tap again to allow posting');
});
test('the Play button code is untouched: PLAY_TEXT, play-big and the failure sentence are still in the file', () => { for (const s of ["const PLAY_TEXT = 'Play video'", "'play-big'", 'VIDEO_FAILED_TEXT', 'videoFailureAction']) assert.ok(html.includes(s), s); });

// ── task 13: the DOM part ────────────────────────────────────────────────────────
const markup = html.split('<script')[0]; const script = html.slice(html.indexOf('<script'));
test('13: the named elements exist; every button has type=button; the buttons are at least 44 px', () => {
  for (const id of ['actions', 'act-approve', 'act-skip', 'act-edit', 'edit-box', 'edit-text', 'notice', 'decided', 'stop-all']) assert.ok(markup.includes(`id="${id}"`), id);
  for (const m of markup.matchAll(/<button\b[^>]*>/g)) assert.match(m[0], /type="button"/, m[0]);
  assert.ok((script.match(/el\('button'/g) || []).length <= (script.match(/\.type = 'button'/g) || []).length, 'every button made in script gets type=button');
  assert.match(html, /\n  button \{[^}]*min-height: 44px/); assert.ok(!/(#actions|#edit-box|#decided|#stop-all)[^{]*\{[^}]*min-height: (\d|[1-3]\d|4[0-3])px/.test(html));
});
test('13: the action token and the page header: script variable only, one place each, no credentials option', () => {
  assert.ok(!html.includes('localStorage')); assert.ok(!html.includes('bpa_token')); assert.ok(!/sessionStorage\.setItem\('(?!bpa_reloaded)/.test(html));
  assert.equal((script.match(/X-Bpa-Action/g) || []).length, 1); assert.equal((script.match(/X-Bpa-Page/g) || []).length, 1);
  assert.equal((script.match(/PAGE_HDR/g) || []).length, 3, 'defined once, used by the session call and the renewal');
  assert.doesNotMatch(html, /credentials\s*:/); assert.doesNotMatch(html, /document\.cookie/);
  assert.match(html, /fetch\('api\/session', \{ method: 'POST', headers: PAGE_HDR/); assert.match(html, /fetch\('\.\/', \{ headers: PAGE_HDR/);
  assert.match(html, /fetch\('api\/decide', \{ method: 'POST', headers: actionHeaders\(\)/); assert.match(html, /fetch\('api\/posting', \{ method: 'POST', headers: actionHeaders\(\)/);
  assert.match(html, /'Content-Type': 'application\/json'/);
  for (const m of html.matchAll(/method: 'POST'(.{0,20})/g)) assert.match(m[1], /^, headers:/);
});
test('13: one renewal and one retry; the page is not reloaded for it', () => {
  assert.equal((script.match(/renewSession\(\)/g) || []).length, 2, 'defined and called once');
  assert.ok(html.includes("tokenStep({ status: res.status, retried })") && html.includes('refresh-and-retry') && html.includes('retried = true'));
  assert.ok(html.includes('Your session ended. Reload the page.'));
  const f = html.slice(html.indexOf('async function renewSession')); const body = f.slice(0, f.indexOf('\n}\n')); assert.ok(!body.includes('location.reload') && body.includes('429') && body.includes('3000') && body.includes('fetchToken()'));
});
test('13: the exact sentences of the notice, the edit box, the lists and the stop button', () => {
  for (const s of ['Approved. You can undo it under What I decided.', 'Skipped. You can undo it under What I decided.', 'Saved and approved.', 'All clips that were ready are decided. From now on the automatic posting uses only the clips you approve.', 'New text for the video, at most 60 characters', 'Save and approve', 'Saving…', 'What I decided (', 'Nothing waits here.', 'Undo']) assert.ok(html.includes(s), s);
  assert.match(markup, /<p id="notice"[^>]*aria-live="polite"/); assert.match(markup, /<details id="decided"/);
});
test('13: the lists, counts and keys use the pure functions', () => {
  for (const w of ['waitingItems(state.items)', 'decidedItems(state.items)', 'decisionRequest(', 'refusalText(', 'afterRefusal(', 'keyAction(', 'decidedLine(', 'stopButtonText(', 'enforced']) assert.ok(html.includes(w), w);
  assert.match(html, /function shownItems\(\) \{ return filterItems\(waitingItems\(state\.items\), state\.kind\)/); assert.match(html, /countKinds\(waitingItems\(state\.items\)\)/);
  assert.ok(html.includes("getElementById('card-title').focus") || html.includes("$('card-title').focus"));
});
test('13: server text goes on the page by textContent only (no HTML assignment anywhere in the script)', () => {
  assert.doesNotMatch(script, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|eval\(|new Function|createContextualFragment|DOMParser/);
  assert.ok((script.match(/textContent/g) || []).length >= 10);
});
test('13: typing in the edit box never moves the card or decides', () => {
  const k = html.slice(html.indexOf("addEventListener('keydown'")); assert.ok(k.slice(0, k.indexOf('});')).includes('isTyping('), 'the old arrow listener also stands down while typing');
  assert.ok(html.includes('typing: isTyping(e)'));
});
test('13: the Play button code is still byte for byte there', () => { for (const s of ["const btn = el('button', PLAY_TEXT, 'play-big'); btn.type = 'button';".replace('const btn', 'const wrap = el(\'div\', undefined, \'vwrap\'); const btn'), "btn.addEventListener('click', (e) => { e.stopPropagation(); start(); });"]) assert.ok(html.includes(s), s); });

// ── review fixes: low items on the page ────────────────────────────────────────────────────────────────────────────
test('low: Shift+A, Shift+S and Shift+E do nothing (the arrow handler already stood down on Shift); the plain keys still work', () => {
  const ctx = { wide: true, typing: false, busy: false, editing: false, actions: ['approve', 'skip', 'edit'] };
  for (const key of ['a', 's', 'e', 'A', 'S', 'E']) assert.equal(pure.keyAction({ key, shiftKey: true }, ctx), null, `shift+${key}`);
  assert.equal(pure.keyAction({ key: 'a' }, ctx), 'approve'); assert.equal(pure.keyAction({ key: 's', shiftKey: false }, ctx), 'skip');
  assert.equal(pure.keyAction({ key: 'Escape', shiftKey: true }, { ...ctx, editing: true }), 'cancel', 'Escape still closes the edit box');
});
test('low: a network error on a decision has its own sentence that says the decision may have been saved', () => {
  assert.match(pure.NET_TEXT, /may have been saved/); assert.match(pure.NET_TEXT, /Reload the page/); assert.notEqual(pure.NET_TEXT, 'That did not work. Reload the page.');
  assert.doesNotMatch(pure.NET_TEXT, /\b(sha\d*|hash|json|manifest|api|mediaId|version|null|undefined|token|nonce|network)\b/i);
});

// ── review fixes: SR2, the page refuses the same characters as the server (one shared list) ─────────────────────────────
import { BAD_CHARS, LINEBREAK_CHARS, GOOD_TEXTS } from './review-test-chars.js';
test('SR2: the page refuses every character of the shared list (the same list the server test uses), line breaks too; ordinary text passes', () => {
  const item = { kind: 'hook', id: 'idea_1', version: 'a'.repeat(64), actions: ['edit'] }; const missed = [];
  for (const ch of [...BAD_CHARS, ...LINEBREAK_CHARS]) if (pure.decisionRequest(item, 'edit', `Lions at${ch}dawn`) !== null) missed.push(`U+${ch.codePointAt(0).toString(16).toUpperCase()}`);
  assert.deepEqual(missed, []);
  for (const text of GOOD_TEXTS) assert.deepEqual({ ...pure.decisionRequest(item, 'edit', text) }, { kind: 'hook', id: 'idea_1', version: 'a'.repeat(64), action: 'edit', text }, JSON.stringify(text));
});
test('SR2: the page source holds its refusal set as plain escapes with the u flag (no literal invisible characters in the file)', () => {
  const line = html.split('\n').find((l) => l.startsWith('const BAD_EDIT_CHARS')); assert.ok(line); assert.match(line, /\\p\{Cc\}/); assert.match(line, /\/u;/);
  assert.doesNotMatch(html, /[​-‏‪-‮⁠-⁤⁦-⁩﻿؜]/, 'no literal invisible character anywhere in the page file');
});

test('SR4: the posting body: Stop carries nothing else; Start carries the stop reason the page saw (and nothing when the page has none)', () => {
  assert.deepEqual({ ...pure.postingBody('stop', { reason: 'stopped by flag since T' }) }, { action: 'stop' });
  assert.deepEqual({ ...pure.postingBody('start', { reason: 'stopped by flag since T' }) }, { action: 'start', seen: 'stopped by flag since T' });
  assert.deepEqual({ ...pure.postingBody('start', { reason: null }) }, { action: 'start' }); assert.deepEqual({ ...pure.postingBody('start', {}) }, { action: 'start' });
});
test('SR4: the sentence for a stop that changed in between is exactly the agreed one', () => { assert.equal(pure.refusalText('stop-changed'), 'Posting was stopped again in the meantime. Check and tap again.'); });

test('the stop line is a local time in words and never the raw reason', () => {
  const NOW = Date.parse('2026-11-17T10:00:00Z'); const base = { autoLane: 'off', stop: { stopped: false, reason: null }, lastPost: { at: '2026-11-12T10:00:00Z', id: 'B26' }, lastRun: { at: '2026-11-17T09:56:00Z', result: 'ok' } };
  const raw = 'stopped by flag since 2026-11-17T21:06:42.521Z'; const T = '18 Nov at 00:06 (East Africa time)';
  const own = pure.statusLines({ ...base, stop: { stopped: true, reason: raw, since: '2026-11-17T21:06:42.521Z', sinceText: T, by: 'own' } }, NOW)[0];
  const fleet = pure.statusLines({ ...base, stop: { stopped: true, reason: raw, sinceText: T, by: 'fleet' } }, NOW)[0];
  const none = pure.statusLines({ ...base, stop: { stopped: true, reason: raw } }, NOW)[0];
  assert.equal(own, 'Posting: stopped since ' + T); assert.equal(fleet, 'Posting: stopped by the fleet-wide stop switch since ' + T); assert.equal(none, 'Posting: stopped (a stop switch could not be read)');
  for (const l of [own, fleet, none]) assert.doesNotMatch(l, /T21:06|\dZ/);
  assert.equal(pure.statusLines({ ...base, stop: { stopped: false, reason: null } }, NOW)[0], 'Posting: allowed'); assert.equal(pure.statusLines({ ...base, stop: 'unknown' }, NOW)[0], 'Posting: could not be read');
});

// ══ Task 12: drafts on the page (pure functions and sentences) ═══════════════════════════════════════════════════
import { EMOJI_OK_TEXTS, EMOJI_BAD_TEXTS, DRAFT_LINEBREAKS_REFUSED } from './review-test-chars.js';
const dItem = (o = {}) => ({ kind: 'draft', id: 'B1', version: 'a'.repeat(64), title: 'Lions sleep', preview: { mediaId: null, note: 'picture is made when the post goes out' }, facts: { text: 'Lions sleep.', videoText: null, draftKind: 'outlook', sources: [], expiresText: '22 Nov at 11:00 (East Africa time)', whenText: null, nextSlot: '2026-11-19T09:00:00+03:00', nextSlotText: '19 Nov at 09:00 (East Africa time)', instagram: false, auto: false, blockedRules: [], lastTryFailed: false }, state: 'waiting', reason: null, usableToday: false, decision: null, actions: ['approve', 'skip', 'edit'], ...o });
test('T12-1 counts and rows: drafts are counted; a row says Post or Automatic post; the Posts filter exists', () => {
  assert.deepEqual({ ...pure.countKinds([{ kind: 'draft' }, { kind: 'hook' }, { kind: 'clip' }, { kind: 'draft' }]) }, { all: 4, hook: 1, clip: 1, draft: 2 });
  assert.equal(pure.rowText(dItem()), 'Post: Lions sleep'); assert.equal(pure.rowText(dItem({ facts: { auto: true } })), 'Automatic post: Lions sleep'); assert.equal(pure.rowText({ kind: 'hook', title: 'T' }), 'Video text: T');
  assert.match(html, /renderFilters\(\)[\s\S]{0,200}draft: 'Posts'/);
});
test('T12-2 state lines for drafts', () => {
  const s = (o) => pure.stateLine(dItem(o));
  assert.equal(s({}), 'Waiting for your yes. If you approve it, it is scheduled at Meta for 19 Nov at 09:00 (East Africa time).');
  assert.equal(s({ facts: { nextSlotText: null } }), 'Waiting for your yes.');
  assert.equal(s({ reason: 'approve-off' }), 'Ready. Approving posts on this page is not switched on yet. You can skip or edit it.');
  assert.equal(s({ state: 'refused: sources-missing', reason: 'sources-missing' }), 'Not ready: The numbers or places in this post have no recorded source. Ask Claude to record them.');
  assert.equal(s({ state: 'blocked', reason: 'blocked' }), 'Blocked by the checks. It will not go out.');
  assert.equal(s({ state: 'scheduled', facts: { whenText: '19 Nov at 09:00 (East Africa time)' } }), 'Scheduled at Meta for 19 Nov at 09:00 (East Africa time). It goes out by itself.');
  assert.equal(s({ state: 'automatic', facts: { whenText: '19 Nov at 09:00 (East Africa time)' } }), 'Automatic post, scheduled for 19 Nov at 09:00 (East Africa time). There is nothing to decide here. Stop all posting holds it.');
  assert.equal(s({ state: 'skipped' }), 'You skipped it.'); assert.equal(s({ state: 'weird' }), pure.FALLBACK); assert.equal(s({ state: 'refused: nonsense-reason', reason: 'nonsense-reason' }), pure.FALLBACK);
});
test('T12-3 reasons and the label for an unreadable list', () => {
  const want = { stopped: 'Posting is stopped right now.', 'text-missing': 'This post has no text.', 'sources-missing': 'The numbers or places in this post have no recorded source. Ask Claude to record them.', 'sources-old': 'The sources of this post were recorded the old way. Ask Claude to record them again.', 'sources-outdated': 'The text changed after its sources were recorded. Ask Claude to record them again.', 'sources-too-few': 'The numbers or places in this post need two sources on different sites.', blocked: 'The checks blocked this post.', 'hidden-characters': 'The text holds characters that cannot be seen. Use Edit and remove them.', 'check-meta': 'This post may already be scheduled at Meta. Look in Meta before you do anything here.', 'approve-off': 'Approving posts on this page is not switched on yet.', expired: 'The time to decide has passed. The system removes it soon.', 'ready-file-changed': 'The video file changed after it was checked.' };
  for (const [k, v] of Object.entries(want)) assert.equal(pure.reasonText(k), v, k);
  assert.match(pure.reasonText('queue-unreadable'), /^The list of posts cannot be read right now\./); assert.equal(pure.LABELS['queue-unreadable'], 'The list of posts cannot be read right now.');
});
test('T12-4 facts of a draft, in order; no raw time; the picture note', () => {
  const it = dItem({ facts: { text: 'Whole text here.', videoText: 'On video', draftKind: 'outlook', sources: [{ claim: 'c1', source: 'Site 1', line: 'l1' }, { claim: 'c2', source: 'Site 2', line: 'l2' }], expiresText: '22 Nov at 11:00 (East Africa time)', whenText: '19 Nov at 09:00 (East Africa time)', instagram: true, auto: false, blockedRules: ['sea-conditions', 'paid-link-wording'], lastTryFailed: true } });
  assert.deepEqual([...pure.factLines(it)].map((r) => [...r]), [['Post:', 'Whole text here.'], ['Text on the video:', 'On video'], ['Fact:', 'c1'], ['Source:', 'Site 1: l1'], ['Fact:', 'c2'], ['Source:', 'Site 2: l2'], ['Decide by:', '22 Nov at 11:00 (East Africa time)'], ['Scheduled for:', '19 Nov at 09:00 (East Africa time)'], ['Instagram:', 'The system also posts it on Instagram later.'], ['Rules that refused it:', 'sea conditions, paid link wording'], ['Last try:', 'Meta did not accept the last try.']]);
  assert.deepEqual([...pure.factLines(dItem())].map((r) => [...r]).filter((r) => r[0] === 'Instagram:'), [['Instagram:', 'Not on Instagram.']]); assert.deepEqual([...pure.factLines(dItem({ state: 'scheduled' }))].map((r) => r[0]).filter((k) => k === 'Instagram:'), []);
  const full = { ...dItem().facts, whenText: '19 Nov at 09:00 (East Africa time)', videoText: 'v', sources: [{ claim: 'c', source: 's', line: 'l' }], blockedRules: ['a-b'], lastTryFailed: true };
  for (const i of [it, dItem(), dItem({ state: 'automatic' }), dItem({ facts: full }), dItem({ state: 'scheduled', facts: full }), dItem({ state: 'blocked', facts: full })]) for (const r of pure.factLines(i)) assert.doesNotMatch(r[1], /\d{4}-\d{2}-\d{2}T/, r[0]);
  assert.equal(pure.noteText(dItem()), 'The picture or video is made when the post goes out. It is not shown here.');
});
test('T12-5 every code of the closed set has a refusal or reason sentence, read from the source of bpa-actions.js; cannot-decide is rewritten; the reload codes', () => {
  const srcFile = fs.readFileSync(path.join(HERE, 'bpa-actions.js'), 'utf8'); const list = srcFile.match(/export const ACTION_CODES = Object\.freeze\(\[([\s\S]*?)\]\);/)[1]; const codes = [...list.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]); assert.ok(codes.length > 40);
  for (const c of codes) { const t = pure.refusalText(c); assert.notEqual(t, pure.FALLBACK, c); assert.match(t, /\.$/, c); }
  assert.equal(pure.REFUSAL_TEXT['cannot-decide'], 'This cannot be decided here. If it is a post: approving posts on this page is not switched on yet.');
  for (const c of ['already-scheduled', 'already-posted', 'expired', 'blocked', 'not-pending', 'slot-changed', 'check-meta']) assert.equal(pure.afterRefusal(c), 'reload', c); assert.equal(pure.afterRefusal('lock-busy'), 'stay');
});
test('T12-6 edit rules per kind: limits, hidden characters, the body size, the request', () => {
  assert.deepEqual({ ...pure.EDIT_LIMITS }, { hook: 60, draft: 2000 }); assert.equal(pure.BODY_MAX_BYTES, 2048); assert.equal(pure.utf8Length('a\u00e9\u2014\u{1F981}'), 1 + 2 + 3 + 4);
  for (const c of BAD_CHARS) assert.equal(pure.editProblem('draft', 'a' + c + 'b'), 'bad-characters', 'U+' + c.codePointAt(0).toString(16));
  for (const c of DRAFT_LINEBREAKS_REFUSED) assert.equal(pure.editProblem('draft', 'a' + c + 'b'), 'bad-characters', 'break U+' + c.codePointAt(0).toString(16));
  assert.equal(pure.editProblem('draft', 'line one\nline two'), null, 'a line feed is allowed in a draft'); assert.equal(pure.editProblem('hook', 'line one\nline two'), 'bad-characters', 'but not in a hook');
  for (const t of GOOD_TEXTS) assert.equal(pure.editProblem('draft', t), null, t); for (const t of EMOJI_OK_TEXTS) assert.equal(pure.editProblem('draft', t), null, t); for (const t of EMOJI_BAD_TEXTS) assert.equal(pure.editProblem('draft', t), 'bad-characters', t);
  assert.equal(pure.editProblem('draft', ''), 'empty'); assert.equal(pure.editProblem('draft', '   '), 'empty'); assert.equal(pure.editProblem('draft', 5), 'empty');
  assert.equal(pure.editProblem('draft', 'x'.repeat(1900)), null); assert.equal(pure.editProblem('draft', 'x'.repeat(2001)), 'too-long'); assert.equal(pure.editProblem('draft', 'x'.repeat(2000)), 'too-big', '2000 plain characters fit the length rule but not the 2048 byte body');
  assert.equal(pure.editProblem('draft', '\u2014'.repeat(700)), 'too-big'); assert.equal(pure.editProblem('hook', 'h'.repeat(61)), 'too-long'); assert.equal(pure.editProblem('hook', 'h'.repeat(60)), null);
  assert.equal(pure.EDIT_PROBLEM_TEXT.empty, 'Write at least one character.'); assert.equal(pure.EDIT_PROBLEM_TEXT['too-big'], 'This text is too long to save from this page. Shorten it, or use WhatsApp.'); assert.equal(pure.EDIT_PROBLEM_TEXT['bad-characters'], pure.REFUSAL_TEXT['bad-characters']);
  assert.equal(pure.EDIT_PROBLEM_TEXT['too-long']('draft'), 'Write between 1 and 2000 characters.'); assert.equal(pure.EDIT_PROBLEM_TEXT['too-long']('hook'), 'Write between 1 and 60 characters on one line.');
  const it = dItem(); assert.deepEqual({ ...pure.decisionRequest(it, 'approve') }, { kind: 'draft', id: 'B1', version: 'a'.repeat(64), action: 'approve', slot: '2026-11-19T09:00:00+03:00' });
  assert.equal(pure.decisionRequest(dItem({ facts: { nextSlot: null } }), 'approve'), null); assert.deepEqual({ ...pure.decisionRequest(it, 'skip') }, { kind: 'draft', id: 'B1', version: 'a'.repeat(64), action: 'skip' });
  assert.deepEqual({ ...pure.decisionRequest(it, 'edit', 'New\ntext.') }, { kind: 'draft', id: 'B1', version: 'a'.repeat(64), action: 'edit', text: 'New\ntext.' }); assert.equal(pure.decisionRequest(it, 'edit', 'x'.repeat(2001)), null); assert.equal(pure.decisionRequest(it, 'edit', '\u2014'.repeat(700)), null);
  assert.equal(pure.decisionRequest(dItem({ actions: ['skip'] }), 'approve'), null);
});
test('T12-7 keys: a draft is never approved or skipped by a key; a hook is unchanged', () => {
  const k = (key, kind, c = {}) => pure.keyAction({ key, ctrlKey: false, metaKey: false, altKey: false, repeat: false }, { wide: true, typing: false, busy: false, editing: false, actions: ['approve', 'skip', 'edit'], kind, ...c });
  assert.equal(k('a', 'draft'), null); assert.equal(k('s', 'draft'), null); assert.equal(k('e', 'draft'), 'edit'); assert.equal(k('Escape', 'draft', { editing: true }), 'cancel');
  assert.equal(k('a', 'hook'), 'approve'); assert.equal(k('s', 'hook'), 'skip'); assert.equal(k('e', 'hook'), 'edit'); assert.equal(k('Escape', 'hook', { editing: true }), 'cancel'); assert.equal(k('a', undefined), 'approve');
});
test('T12-8 decided rows and Undo', () => {
  assert.equal(pure.decidedLine(dItem({ state: 'scheduled', decision: { kind: 'scheduled', at: 'x' }, facts: { whenText: '19 Nov at 09:00 (East Africa time)' }, actions: [] })), 'You scheduled "Lions sleep" for 19 Nov at 09:00 (East Africa time).');
  assert.equal(pure.decidedLine(dItem({ state: 'skipped', decision: { kind: 'skipped', at: 'x' }, actions: [] })), 'You skipped "Lions sleep".');
  assert.equal(pure.canUndo(dItem({ decision: { kind: 'skipped' }, actions: [] })), false); assert.equal(pure.canUndo({ kind: 'hook', actions: ['undo'] }), true); assert.equal(pure.canUndo({}), false);
});
test('T12-9 done, confirm and connection sentences', () => {
  const it = dItem({ facts: { nextSlotText: '19 Nov at 09:00 (East Africa time)', instagram: false } });
  assert.equal(pure.doneText(it, 'approve', { scheduledForText: '19 Nov at 09:00 (East Africa time)' }), 'Scheduled at Meta for 19 Nov at 09:00 (East Africa time). It goes out by itself.'); assert.equal(pure.doneText(it, 'approve', {}), 'Scheduled at Meta.');
  assert.equal(pure.doneText(it, 'skip', {}), 'Skipped. This cannot be undone here.'); assert.equal(pure.doneText(it, 'edit', {}), 'Saved. It is not scheduled yet. Look at the card again before you approve.');
  assert.equal(pure.doneText({ kind: 'hook' }, 'approve', {}), 'Approved. You can undo it under What I decided.'); assert.equal(pure.doneText({ kind: 'clip' }, 'undo', {}), 'Undone. It is back in the waiting list.'); assert.equal(pure.DONE_TEXT.edit, 'Saved and approved.');
  assert.equal(pure.confirmText(it, 'approve'), 'This schedules a real post at Meta for 19 Nov at 09:00 (East Africa time). It then goes out by itself. This page cannot take it back; only Meta can cancel it.');
  assert.ok(pure.confirmText(dItem({ facts: { nextSlotText: 'x', instagram: true } }), 'approve').endsWith(' It also goes on Instagram.')); assert.equal(pure.confirmText(it, 'skip'), 'Skip this post? It does not come back on this page.');
  assert.equal(pure.netText(it, 'approve'), 'The connection broke. The post may have been scheduled at Meta. Check Meta before you tap again.'); assert.equal(pure.netText(it, 'skip'), pure.NET_TEXT); assert.equal(pure.netText({ kind: 'hook' }, 'approve'), pure.NET_TEXT);
});
test('T12-11 jargon: the new sentences hold none of the forbidden words', () => {
  const bad = /\b(sha\d*|hash|json|manifest|api|mediaId|version|null|undefined|token|nonce)\b/i; const all = [...Object.values(pure.REFUSAL_TEXT), ...Object.values(pure.REASON_TEXT), ...Object.values(pure.EDIT_PROBLEM_TEXT).map((v) => (typeof v === 'function' ? v('draft') + v('hook') : v))];
  const items = [dItem(), dItem({ reason: 'approve-off' }), dItem({ state: 'scheduled', facts: { whenText: 'x', instagram: true } }), dItem({ state: 'automatic' }), dItem({ state: 'blocked' }), dItem({ state: 'skipped' }), dItem({ state: 'refused: expired', reason: 'expired' })];
  for (const i of items) { all.push(pure.stateLine(i)); for (const a of ['approve', 'skip', 'edit']) all.push(pure.confirmText(i, a) || '', pure.doneText(i, a, { scheduledForText: 'x' }), pure.netText(i, a)); }
  for (const t of all) assert.doesNotMatch(t, bad, t);
});
