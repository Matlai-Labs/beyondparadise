// bpa-social draft scorer: a 12-part Instagram rubric + a 0-10 hook score, shown next to each draft in `bpa approve`.
//
// ADVISORY ONLY. The score never blocks, edits, or re-orders a draft, and never changes its status. Tim decides.
// What it means: total = 60% rubric pass-rate (post-level parts only) + 40% hook score. It catches obviously weak
// drafts (no hook, no ask, hashtag wall); it does NOT predict reach. Profile-level parts are judged monthly, not per draft.
//
// Pattern borrowed from Jakeschincariol/Instagram-agent-skill (MIT, https://github.com/Jakeschincariol/Instagram-agent-skill):
// its /ig-profile "12-part rubric", the hook scorer (hookscore.py) and the caption linter (caption.py: 125-char feed window,
// hashtag cap, one ask). No code copied or installed; the checks below are written from scratch for BPA drafts.
// NOTE: the README names the 12-part profile rubric but does not list its parts, so the 12 ids here are derived:
// 9 post-level criteria (from the README's caption/hook tooling) + 3 profile-level ones (bio, highlights, grid).
// Pure module: no I/O, no network, no imports.

const PROFILE_NOTE = 'profile-level — judged monthly';
const str = (v) => (typeof v === 'string' ? v : '');
const lines = (t) => str(t).split('\n');
const firstLine = (t) => lines(t).map((l) => l.trim()).find(Boolean) || '';
const stripTags = (s) => s.replace(/#[\p{L}\p{N}_]+/gu, '').trim();
const hashtagsOf = (t) => str(t).match(/#[\p{L}\p{N}_]+/gu) || [];
const emojiOf = (t) => str(t).match(/\p{Extended_Pictographic}/gu) || [];
const words = (t) => str(t).split(/\s+/).filter(Boolean).length;
const SLOP = ['delve', 'tapestry', 'game-changer', 'game changer', 'unlock the', 'stop scrolling', 'in today\'s video', 'follow for more', 'tag someone who needs', 'the algorithm loves', 'run don\'t walk', 'hidden gem', 'bucket list', 'paradise awaits', 'look no further', 'nestled', 'testament to', 'elevate your', 'embark on', 'seamless'];
const CTA = /\b(message me|dm me|send me|comment|reply|book|save this|share this|follow|tap|click|link in bio|contact|ask me|get in touch|plan your|check availability|visit)\b/gi;

export function hookScore(text, subject = '') {
  const signals = []; let score = 0;
  const raw = firstLine(text);
  if (!raw) return { score: 0, signals: ['no hook line'] };
  const hook = stripTags(raw);
  const hasTag = hook !== raw;
  const bare = hook.replace(/[\p{Extended_Pictographic}\s️‍]/gu, '');
  if (hook.length >= 15 && hook.length <= 125) { score += 2; signals.push(`length ${hook.length} fits the 125-char feed window`); }
  else signals.push(hook.length < 15 ? `too short (${hook.length})` : `too long (${hook.length} > 125, cut mid-thought in the feed)`);
  if (/^(\d|how\b|why\b|the\b|what\b|when\b|where\b)/i.test(hook) || hook.includes('?')) { score += 2; signals.push('opens with a number, question, how/why/the'); }
  else signals.push('no number/question/how/why/the opener');
  const subj = clean(subject);
  const concrete = /\d/.test(hook) || /\s[A-Z][a-z]{2,}/.test(hook) || (subj && hook.toLowerCase().includes(subj.toLowerCase()));
  if (concrete) { score += 2; signals.push('names something concrete (number, place or subject)'); } else signals.push('nothing concrete in the hook');
  if (!hasTag) { score += 2; signals.push('no hashtag in the hook'); } else signals.push('hashtag in the hook line');
  if (bare.length) { score += 1; } else signals.push('emoji-only or empty hook');
  if (!/^(hey|hi|hello|good morning)\b|stop scrolling|in today's/i.test(hook)) { score += 1; } else signals.push('greeting/preamble opener');
  return { score, signals };
}
function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

const profile = (id, name) => ({ id, name, test: () => ({ pass: null, note: PROFILE_NOTE }) });
const ok = (pass, note) => ({ pass, note });

export const RUBRIC = [
  { id: 'hook-window', name: 'hook fits the 125-char feed window', test: (d) => { const n = stripTags(firstLine(d.text)).length; return ok(n >= 15 && n <= 125, `first line ${n} chars`); } },
  { id: 'hook-concrete', name: 'hook has a number, question or named place', test: (d) => { const h = firstLine(d.text); return ok(/\d/.test(h) || h.includes('?') || /\s[A-Z][a-z]{2,}/.test(h), h ? 'checked first line' : 'no first line'); } },
  { id: 'cta', name: 'exactly one clear call to action', test: (d) => { const n = lines(d.text).slice(1).filter((l) => !l.trim().startsWith('#') && l.match(CTA)).length; return ok(n >= 1 && n <= 2, n ? `${n} line(s) with an ask` : 'no call to action'); } },
  { id: 'hashtags', name: '3-5 hashtags (Instagram cap is 5)', test: (d) => { const n = hashtagsOf(d.text).length; return ok(n >= 3 && n <= 5, `${n} hashtag(s)`); } },
  { id: 'brand-links', name: 'brand in full, clean https links only', test: (d) => { const t = str(d.text); const bad = /\bBeyond Paradise(?! Adventures)\b/.test(t) ? 'short brand name' : /google\.com\/url\?|&ust=/.test(t) ? 'wrapped link' : /http:\/\//i.test(t) ? 'plain http link' : null; return ok(!bad, bad || 'ok'); } },
  { id: 'no-slop', name: 'no stock AI/marketing phrases', test: (d) => { const t = str(d.text).toLowerCase(); const hit = SLOP.filter((p) => t.includes(p)); return ok(!hit.length, hit.length ? `found: ${hit.join(', ')}` : 'none found'); } },
  { id: 'concrete-fact', name: 'states a concrete date, price or number', test: (d) => { const t = str(d.text); const m = t.match(/\d[\d,.]*\s?(%|\$|€|eur|tzs|usd|nights?|weeks?|days?)|\b\d{1,2} (january|february|march|april|may|june|july|august|september|october|november|december)\b|[$€]\s?\d/i); return ok(!!m, m ? `found "${m[0]}"` : 'no date/price/quantity'); } },
  { id: 'readability', name: 'line breaks and at most 3 emoji', test: (d) => { const t = str(d.text); const paras = t.split(/\n\s*\n/).filter((p) => p.trim()).length; const e = emojiOf(t).length; return ok(paras >= 2 && e <= 3, `${paras} paragraph(s), ${e} emoji`); } },
  { id: 'length-band', name: 'caption length 80-400 words', test: (d) => { const n = words(d.text); return ok(n >= 80 && n <= 400, `${n} words`); } },
  profile('bio', 'bio states who, what, for whom'),
  profile('highlights', 'story highlights cover the key topics'),
  profile('grid', 'grid is visually consistent'),
];

export function scoreDraft(draft) {
  try {
    const d = draft && typeof draft === 'object' ? draft : {};
    if (!str(d.text).trim()) return { hook: { score: 0, signals: ['no text'] }, rubric: [], passed: 0, applicable: 0, total: 0, note: 'no text to score' };
    const subject = str(d.text).split(/ — |\n/)[0];
    const hook = hookScore(d.text, subject);
    const rubric = RUBRIC.map((r) => { let res; try { res = r.test(d); } catch (e) { res = { pass: false, note: `check error: ${e.message}` }; } return { id: r.id, name: r.name, pass: res.pass, note: res.note }; });
    const graded = rubric.filter((r) => r.pass !== null); const passed = graded.filter((r) => r.pass).length;
    const applicable = graded.length;
    const total = Math.round(0.6 * (applicable ? passed / applicable : 0) * 100 + 0.4 * hook.score * 10);
    return { hook, rubric, passed, applicable, total };
  } catch (e) {
    return { hook: { score: 0, signals: [`score error: ${e.message}`] }, rubric: [], passed: 0, applicable: 0, total: 0, note: `score error: ${e.message}` };
  }
}

export function renderScore(s) {
  if (!s || typeof s.total !== 'number') return '';
  const fails = (s.rubric || []).filter((r) => r.pass === false).map((r) => r.id);
  return `score ${s.total}/100 · hook ${s.hook?.score ?? 0}/10 · rubric ${s.passed}/${s.applicable}${fails.length ? ` ✗ ${fails.join(', ')}` : ' ✓'}`;
}
