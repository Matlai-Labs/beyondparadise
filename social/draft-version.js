// What the review page needs to decide on a queue draft: the version of what the owner sees, a strict queue reader, the expiry time.
import crypto from 'node:crypto'; import fs from 'node:fs';

/** Reasons shown on a card (not refusals). Both lists are in the closed set of bpa-actions.js. */
export const DRAFT_REASONS = Object.freeze(['stopped', 'text-missing', 'hidden-characters', 'sources-missing', 'sources-old', 'sources-outdated', 'sources-too-few', 'check-meta', 'approve-off', 'final-check', 'blocked', 'queue-unreadable', 'expired', 'video-missing', 'ready-file-changed']);

const sourcesOf = (d) => (Array.isArray(d.claimSources) ? d.claimSources.map((s) => [s?.claim, s?.source, s?.url, s?.line]) : []);
/** 64 hex. Covers the caption, the on-video text, the slides, the ready file hash and the recorded sources; NOT status, decidedAt, scheduledFor, ig, lastError, score, hookAdvice. */
export function draftVersion(d) {
  return crypto.createHash('sha256').update(JSON.stringify(['draft', d.id, d.text, d.videoText ?? null, d.slides ?? null, d.readyFileSha256 ?? null, d.claimSourcesHash ?? null, sourcesOf(d)]), 'utf8').digest('hex');
}
/** The queue as it is on disk. A missing file, a parse error or no drafts list is unreadable: never an empty fallback (lib.js loadQueue would give one, and a save would then wipe the queue). */
export function readQueueStrict(queuePath) {
  try { const q = JSON.parse(fs.readFileSync(queuePath, 'utf8')); return q && typeof q === 'object' && !Array.isArray(q) && Array.isArray(q.drafts) ? { ok: true, q } : { ok: false, code: 'queue-unreadable' }; }
  catch { return { ok: false, code: 'queue-unreadable' }; }
}
/** When the worker expires a pending draft (createdAt plus the days), or null when createdAt is not a valid time. */
export function draftExpiresAt(d, ttlDays) { const t = Date.parse(d?.createdAt); return Number.isNaN(t) ? null : t + ttlDays * 86400e3; }
