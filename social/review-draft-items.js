// Review page items for queue drafts and the automatic lane's prepared posts. Pure with injected inputs (no log, no network, no model).
// This file SHOWS; it decides nothing. Every payload is capped and carries no url, no error text, no file path.
import path from 'node:path';
import { claimGateWhy } from './claim-gate.js';
import { draftVersion, draftExpiresAt, textTooLong, hasHiddenChars, TEXT_SHOW_MAX } from './draft-version.js';
import { plainTime } from './plain-time.js';
import { nextSlots } from './lib.js';
import { mediaIdFor, DECISION_WINDOW_MS } from './review-items.js';

export const NOTE_DRAFT_NO_PICTURE = 'picture is made when the post goes out';
const NOTE_VIDEO_MISSING = 'video missing';
const TEXT_MAX = TEXT_SHOW_MAX, TITLE_MAX = 120, SOURCES_MAX = 20, SOURCE_FIELD_MAX = 300, RULES_MAX = 20;
const cut = (s, n) => { const a = Array.from(s); return a.length > n ? a.slice(0, n).join('') : s; }; // by code point: a surrogate pair is never split
const nonEmpty = (v) => typeof v === 'string' && v !== '';
const inWindow = (at, now, windowMs) => { const t = Date.parse(at); return Number.isNaN(t) || now.getTime() - t <= windowMs; };
const titleOf = (text) => { const first = typeof text === 'string' ? text.split('\n')[0] : ''; const a = Array.from(first); return a.length > TITLE_MAX ? `${a.slice(0, TITLE_MAX - 1).join('')}…` : first; };
const ACTIONS = { null: ['approve', 'skip', 'edit'], 'approve-off': ['skip', 'edit'], 'check-meta': ['skip'], 'text-too-long': ['skip'], expired: [] };

function factsOf(d, { q, now, ttlDays, igOn, pending }) {
  const sources = []; if (Array.isArray(d.claimSources)) for (const s of d.claimSources) { if (s && typeof s === 'object' && nonEmpty(s.claim) && nonEmpty(s.source) && nonEmpty(s.line)) sources.push({ claim: cut(s.claim, SOURCE_FIELD_MAX), source: cut(s.source, SOURCE_FIELD_MAX), line: cut(s.line, SOURCE_FIELD_MAX) }); if (sources.length >= SOURCES_MAX) break; }
  const exp = pending ? draftExpiresAt(d, ttlDays) : null; const slot = pending ? nextSlots(q, 1, now)[0] : null;
  const rules = Array.isArray(d.blocked?.rules) ? d.blocked.rules.filter((r) => typeof r === 'string' && /^[a-z0-9-]{1,40}$/.test(r)).slice(0, RULES_MAX) : [];
  return {
    text: typeof d.text === 'string' ? cut(d.text, TEXT_MAX) : '', videoText: typeof d.videoText === 'string' && d.videoText !== '' ? cut(d.videoText, TEXT_MAX) : null,
    draftKind: typeof d.kind === 'string' && /^[a-z0-9_-]{1,30}$/.test(d.kind) ? d.kind : null, sources,
    expiresText: exp === null ? null : plainTime(exp), whenText: nonEmpty(d.scheduledFor) ? plainTime(d.scheduledFor) : null, nextSlot: slot, nextSlotText: slot ? plainTime(slot) : null,
    instagram: pending ? igOn() === true : Boolean(d.ig), auto: d.auto === true, blockedRules: rules, lastTryFailed: nonEmpty(d.lastError), // the error text itself is never sent
  };
}

/** The first reason a pending draft cannot be approved now (null = ready), in a fixed order. checkFor (the final check) runs only when nothing earlier applies. */
async function pendingReason(d, { claimWhy, checkFor, stop, approveOn, approvedIds, ttlDays, now }) {
  if (d.metaUnknown || approvedIds.has(d.id)) return 'check-meta'; // an earlier Approve may already exist at Meta
  const exp = draftExpiresAt(d, ttlDays); if (exp === null || now.getTime() > exp) return 'expired'; // an unreadable creation time counts as expired
  if (!nonEmpty(typeof d.text === 'string' ? d.text.trim() : '')) return 'text-missing';
  if (textTooLong(d)) return 'text-too-long';
  if (hasHiddenChars(d)) return 'hidden-characters';
  const w = claimWhy(d); if (w) return w.code;
  if (stop().stopped) return 'stopped';
  let ok = false; try { ok = (await checkFor(d)).ok === true; } catch { ok = false; } if (!ok) return 'final-check';
  return approveOn() !== true ? 'approve-off' : null;
}

/** The prepared video of an automatic post: a file in the lane's folder that still has the hash it was checked with. { reason, preview, media } */
async function preparedVideo(d, version, { autoDir, info, secret }) {
  const none = (reason) => ({ reason, preview: { mediaId: null, note: NOTE_VIDEO_MISSING }, media: null });
  const abs = nonEmpty(d.readyFile) ? path.resolve(d.readyFile) : null;
  if (!abs || path.dirname(abs) !== path.resolve(autoDir) || !/^[A-Za-z0-9_.-]+\.mp4$/.test(path.basename(abs))) return none('video-missing');
  const pk = info.peek(abs); if (!pk) return none('video-missing'); // a missing file, a folder or a link
  if ((await info.hash(abs, pk)) !== d.readyFileSha256) return none('ready-file-changed');
  const mediaId = mediaIdFor(secret, d.id, version);
  return { reason: null, preview: { mediaId, note: null }, media: [mediaId, { path: abs, kind: 'prepared', size: pk.size, mtimeMs: pk.mtimeMs, ino: pk.ino }] };
}

export async function buildDraftItems({ readQueue, claimWhy = claimGateWhy, checkFor, stop, igOn, approveOn, approvedIds = new Set(), ttlDays, now = new Date(), autoDir, info, secret, decisionWindowMs = DECISION_WINDOW_MS }) {
  const items = []; const media = new Map(); const problems = [];
  let r; try { r = readQueue(); } catch { r = null; }
  if (!r || !r.ok || !Array.isArray(r.q?.drafts)) return { items, media, problems: ['queue-unreadable'] };
  const q = { ...r.q, drafts: r.q.drafts.filter((x) => x && typeof x === 'object') }; // nextSlots reads every entry: one null entry must not hide the others
  for (const d of q.drafts) {
    try {
      if (!d || typeof d !== 'object' || typeof d.id !== 'string' || d.id === '') continue;
      const version = draftVersion(d); const base = { kind: 'draft', id: d.id, version, title: titleOf(d.text), usableToday: false };
      const preview = { mediaId: null, note: NOTE_DRAFT_NO_PICTURE };
      if (d.status === 'pending_approval') {
        const reason = await pendingReason(d, { claimWhy, checkFor, stop, approveOn, approvedIds, ttlDays, now });
        items.push({ ...base, preview, facts: factsOf(d, { q, now, ttlDays, igOn, pending: true }), state: reason === null || reason === 'approve-off' ? 'waiting' : `refused: ${reason}`, reason, decision: null, actions: [...(ACTIONS[reason] ?? ['skip', 'edit'])] });
      } else if (d.status === 'blocked') {
        items.push({ ...base, preview, facts: factsOf(d, { q, now, ttlDays, igOn, pending: false }), state: 'blocked', reason: 'blocked', decision: null, actions: [] });
      } else if (d.status === 'scheduled' && d.auto === true) {
        const v = await preparedVideo(d, version, { autoDir, info, secret }); if (v.media) media.set(v.media[0], v.media[1]);
        items.push({ ...base, preview: v.preview, facts: factsOf(d, { q, now, ttlDays, igOn, pending: false }), state: 'automatic', reason: v.reason, decision: null, actions: [] });
      } else if (d.status === 'scheduled') {
        if (!inWindow(d.decidedAt, now, decisionWindowMs)) continue;
        items.push({ ...base, preview, facts: factsOf(d, { q, now, ttlDays, igOn, pending: false }), state: 'scheduled', reason: null, decision: { kind: 'scheduled', at: d.decidedAt }, actions: [] });
      } else if (d.status === 'skipped') {
        if (!inWindow(d.decidedAt, now, decisionWindowMs)) continue;
        items.push({ ...base, preview, facts: factsOf(d, { q, now, ttlDays, igOn, pending: false }), state: 'skipped', reason: null, decision: { kind: 'skipped', at: d.decidedAt }, actions: [] });
      } // posted, expired, failed: not shown
    } catch { /* one odd draft never hides the others */ }
  }
  return { items, media, problems };
}
