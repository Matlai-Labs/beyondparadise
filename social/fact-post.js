// The verbatim draft of the automatic lane (B9b). No model, no paraphrase: the post text is the idea's own title (cut cleanly), the idea's own
// sourced claim sentences word for word, and the lines code adds (caption.js: source line, pointer, hashtags).
//
//   verbatimDraft(idea, { now, sourceNames }) -> { ok: true, draft, reason: null } | { ok: false, draft: null, reason }
//   hookFrom(title) -> { ok: true, hook } | { ok: false, reason }
// Refusals, each a named reason: idea-has-no-claims, title-missing, title-too-long, claim-too-long (a claim is never shortened),
// claim-multiline, title-has-markup; with an approved hook also hook-invalid (empty or more than one line) and hook-too-long. The draft carries lane "auto" and writer "verbatim", the claims it shows (the rules gate checks figures against them),
// and `videoText` (the hook that is drawn on the clip) so the final check sees the on-video text as well.
import { codeLinesFor, hashtagsFor } from './caption.js';

export const HOOK_MAX = 60;
export const CLAIM_MAX = 240;
export const CLAIMS_MAX = 3;
/** The one line code adds to every automatic reel: the clips come from compilation videos, so the place of filming is not known. Part of `text`, so the hash and the final check cover it. */
export const LIBRARY_FOOTAGE_LINE = 'Video: library footage.';
export const ALT_PREFIX = 'Short video of East African landscape or wildlife with the text: ';

const len = (s) => [...s].length;
const hasText = (v) => typeof v === 'string' && v.trim() !== '';
const WEAK_END = new Set(['a', 'an', 'the', 'of', 'for', 'to', 'in', 'on', 'at', 'with', 'by', 'from', 'and', 'or', 'but', 'as', 'per', 'than', 'is', 'are', 'was', 'were', 'has', 'have', 'had', 'will', 'can', 'that', 'which', 'who', 'vs', '&', '-', '–', '—']);
const STARTS_CAP_OR_DIGIT = /^[\p{Lu}\p{N}]/u;
// markup that would be drawn literally on the clip: asterisks, backticks, a markdown link, underscores used as emphasis (snake_case stays plain)
const MARKUP = /[*`]|\[[^\]]*\]\(|(?:^|[\s(])_[^\s_]|[^\s_]_(?:$|[\s).,;:!?])/u;
const NATURAL_BREAK = /[.,;:!?)]$/;

/** The title as a hook: whole when it fits; otherwise cut after a whole word to at most HOOK_MAX characters. A cut that would land inside a number or a
 *  name (two capitalised or numeric words apart, or a word followed by a bare symbol), leave a bracket or quote open, or leave an ellipsis, is refused. */
export function hookFrom(title) {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return { ok: false, reason: 'title-missing' };
  if (MARKUP.test(t)) return { ok: false, reason: 'title-has-markup' };
  const refuse = { ok: false, reason: 'title-too-long' };
  if (len(t) <= HOOK_MAX) return /…|\.\.\./.test(t) ? refuse : { ok: true, hook: t };
  const tokens = t.split(' '); let k = 0, used = 0;
  while (k < tokens.length && used + (k ? 1 : 0) + len(tokens[k]) <= HOOK_MAX) { used += (k ? 1 : 0) + len(tokens[k]); k += 1; }
  if (k === 0 || k === tokens.length) return refuse;
  const naturalBreak = NATURAL_BREAK.test(tokens[k - 1]);
  if (!naturalBreak && (STARTS_CAP_OR_DIGIT.test(tokens[k - 1]) && STARTS_CAP_OR_DIGIT.test(tokens[k]))) return refuse; // capitalised/numeric run split
  if (!naturalBreak && !/^[\p{L}\p{N}]/u.test(tokens[k])) return refuse; // "50 | %" , "A | /B"
  let kept = tokens.slice(0, k);
  while (kept.length > 1 && WEAK_END.has(kept[kept.length - 1].replace(/[,;:]+$/, '').toLowerCase())) kept.pop();
  let hook = kept.join(' ').replace(/[,;:–—-]+$/u, '').trim();
  const count = (re) => (hook.match(re) || []).length;
  if (count(/\(/g) !== count(/\)/g) || count(/"/g) % 2 || count(/“/g) !== count(/”/g)) return refuse;
  if (!hook || /…|\.\.\./.test(hook)) return refuse;
  return { ok: true, hook };
}

/** `hook` (optional): an approved hand-written hook (auto-hooks.js) used INSTEAD of the cut title. One line, at most HOOK_MAX characters; the figures and the final check are the caller's (auto-lane.js evaluateIdea). */
export function verbatimDraft(idea, { now = new Date(), sourceNames, hook } = {}) {
  const fail = (reason) => ({ ok: false, draft: null, reason });
  const all = idea && Array.isArray(idea.claims) ? idea.claims : [];
  if (!all.length || !all.every((c) => c && hasText(c.text))) return fail('idea-has-no-claims');
  let h;
  if (hook === undefined) { h = hookFrom(idea.title); if (!h.ok) return fail(h.reason); }
  else { const t = typeof hook === 'string' ? hook.trim() : ''; if (!t || /[\r\n]/.test(t)) return fail('hook-invalid'); if (len(t) > HOOK_MAX) return fail('hook-too-long'); h = { ok: true, hook: t }; }
  const claims = all.slice(0, CLAIMS_MAX).map((c) => ({ ...c }));
  for (const c of claims) { if (/[\r\n]/.test(c.text)) return fail('claim-multiline'); if (len(c.text) > CLAIM_MAX) return fail('claim-too-long'); }
  const codeLines = codeLinesFor({ ...idea, claims }, { sourceNames }); const tags = codeLines[codeLines.length - 1];
  // the source line, then the footage line, then the pointer (when there is one), a blank line, the hashtags
  const text = [h.hook, '', ...claims.map((c) => c.text), codeLines[0], LIBRARY_FOOTAGE_LINE, ...codeLines.slice(1, -1), '', tags].join('\n');
  const draft = { kind: 'auto', lane: 'auto', writer: 'verbatim', ideaKind: idea.kind, topic: idea.topic ?? null, region: 'all', text, hook: h.hook, caption: claims.map((c) => c.text).join('\n'),
    altText: `${ALT_PREFIX}${h.hook}`, videoText: h.hook, hashtags: hashtagsFor(idea), sourceDate: claims.map((c) => c.sourceDate).filter(Boolean).sort().at(-1) ?? null,
    sourceId: idea.sourceId ?? null, ideaId: idea.id, link: idea.link ?? null, claims, createdAt: now.toISOString() };
  return { ok: true, draft, reason: null };
}
