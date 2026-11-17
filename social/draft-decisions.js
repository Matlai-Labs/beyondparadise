// The review page's Skip and Edit for queue drafts: queue lock, the version the owner saw, the record first, then the change.
// The checks and the changes are the SHARED functions of draft-actions.js (the WhatsApp commands call the same ones); nothing here sends anything.
// Locks: the queue lock first, the decision lock only for the short record line inside it, never the other way round.
import { withQueueLock, saveQueue, STATUS, log } from './lib.js';
import { withDecisionLock } from './decision-lock.js';
import { publicCode } from './bpa-actions.js';
import { hiddenCharsIn } from './invisible-chars.js';
import { draftVersion, readQueueStrict } from './draft-version.js';
import { checkSkip, applySkip, checkEdit, applyEdit, statusCodeOf } from './draft-actions.js';

const MAX_TEXT = 2000;
const fail = (code) => ({ ok: false, code: publicCode(code) });
const done = (id, decision) => ({ ok: true, change: { kind: 'draft', id, decision } });

/** No default for the queue file, the record file or the never-promote key: a caller that forgets one gets check-failed and nothing is read or written. */
export function createDraftActions(options = {}) {
  const hasKey = Object.hasOwn(options, 'neverPromotePatterns'); // a destructured parameter cannot tell an absent key from undefined
  const { env = process.env, queuePath, recordFile, now = () => new Date(), lockTimeoutMs = 5000, save = saveQueue, neverPromotePatterns } = options;
  const ready = hasKey && typeof queuePath === 'string' && queuePath !== '' && typeof recordFile === 'string' && recordFile !== '';

  const queueLocked = async (fn) => {
    if (!ready) return fail('check-failed');
    try { return await withQueueLock(fn, { lockPath: queuePath + '.lock', timeoutMs: lockTimeoutMs }); }
    catch (e) { return fail(e && e.message === 'queue lock timeout' ? 'lock-busy' : 'check-failed'); }
  };
  /** The record line (or its void line) under the decision lock; null when it could not be written. */
  const recordLocked = async (ctx, rec) => {
    try { const r = await withDecisionLock(() => (rec.void !== undefined ? ctx.voidRecord(rec.void) : ctx.record(rec)), { env, timeoutMs: lockTimeoutMs }); return r && r.ok === true ? r : null; } catch { return null; }
  };
  /** The common start: request shape, strict queue read, the draft, its status, the version the owner saw. */
  const open = (req) => {
    if (!req || typeof req.id !== 'string' || req.id === '' || typeof req.version !== 'string') return { fail: fail('bad-request') };
    const r = readQueueStrict(queuePath); if (!r.ok) return { fail: fail(r.code) };
    const i = r.q.drafts.findIndex((x) => x && x.id === req.id); if (i < 0) return { fail: fail('not-found') };
    const d = r.q.drafts[i]; if (d.status !== STATUS.PENDING) return { fail: fail(statusCodeOf(d.status)) };
    if (draftVersion(d) !== req.version) return { fail: fail('version-changed') };
    return { q: r.q, i, d };
  };
  /** Save; a failed save voids the record line so the record never says more than the queue. */
  const saveOrVoid = async (q, ctx, n) => {
    try { save(q, queuePath); return null; } catch { await recordLocked(ctx, { void: n }); log('draft decision: queue not saved'); return fail('write-failed'); }
  };

  async function skipDraft(req, ctx) {
    return queueLocked(async () => {
      const o = open(req); if (o.fail) return o.fail;
      const c = checkSkip(o.d); if (!c.ok) return fail(c.code);
      const rec = await recordLocked(ctx, { kind: 'draft', id: req.id, version: req.version, decision: 'skip' }); if (!rec) return fail('record-failed');
      applySkip(o.d, { now });
      return (await saveOrVoid(o.q, ctx, rec.n)) || done(req.id, 'skipped');
    });
  }
  async function editDraft(req, ctx) {
    const text = typeof req?.text === 'string' ? req.text.trim() : '';
    if (text === '' || text.length > MAX_TEXT) return fail('bad-request');
    if (hiddenCharsIn(text)) return fail('bad-characters');
    return queueLocked(async () => {
      const o = open(req); if (o.fail) return o.fail;
      if (text === o.d.text) return fail('no-change');
      const c = await checkEdit(o.d, text, { neverPromotePatterns }); if (!c.ok) return fail(c.code);
      const nd = structuredClone(o.d); applyEdit(nd, text, { now }); // on a copy: the real draft is replaced only after the record is written
      const rec = await recordLocked(ctx, { kind: 'draft', id: req.id, version: draftVersion(nd), decision: 'edit' }); if (!rec) return fail('record-failed');
      o.q.drafts[o.i] = nd;
      return (await saveOrVoid(o.q, ctx, rec.n)) || done(req.id, 'edited');
    });
  }
  async function approveDraft() { return fail('check-failed'); } // Task 9
  return { skipDraft, editDraft, approveDraft };
}
