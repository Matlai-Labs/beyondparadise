// The review page's Skip and Edit for queue drafts: queue lock, the version the owner saw, the record first, then the change.
// The checks and the changes are the SHARED functions of draft-actions.js (the WhatsApp commands call the same ones); nothing here sends anything.
// Locks: the queue lock first, the decision lock only for the short record line inside it, never the other way round.
import { withQueueLock, saveQueue, STATUS, CONFIG, log } from './lib.js';
import { withDecisionLock } from './decision-lock.js';
import { publicCode } from './bpa-actions.js';
import { hiddenCharsIn } from './invisible-chars.js';
import { draftVersion, readQueueStrict, draftExpiresAt } from './draft-version.js';
import { plainTime } from './plain-time.js';
import { checkSkip, applySkip, checkEdit, applyEdit, approveGuards, scheduleDraft, statusCodeOf } from './draft-actions.js';

const MAX_TEXT = 2000;
const fail = (code) => ({ ok: false, code: publicCode(code) });
const done = (id, decision) => ({ ok: true, change: { kind: 'draft', id, decision } });

/** No default for the queue file, the record file or the never-promote key: a caller that forgets one gets check-failed and nothing is read or written. */
export function createDraftActions(options = {}) {
  const hasKey = Object.hasOwn(options, 'neverPromotePatterns'); // a destructured parameter cannot tell an absent key from undefined
  const { env = process.env, queuePath, recordFile, now = () => new Date(), lockTimeoutMs = 5000, save = saveQueue, neverPromotePatterns, ttlDays = CONFIG.draftTtlDays, schedule, igOn, stop, notify, approveOn, finalCheck } = options;
  const approveReady = [schedule, igOn, stop, notify, approveOn].every((f) => typeof f === 'function'); // an igOn that is missing would be called AFTER the Meta call and read as a failure while the post exists
  const say = (_text, code) => log(`review draft: ${publicCode(code ?? 'check-failed')}`); // the text is dropped on purpose: no draft text, id or Meta message in the log
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
  /** The common start: request shape, strict queue read, the draft, its status. Each section then checks the version the owner saw. */
  const open = (req) => {
    if (!req || typeof req.id !== 'string' || req.id === '' || typeof req.version !== 'string') return { fail: fail('bad-request') };
    const r = readQueueStrict(queuePath); if (!r.ok) return { fail: fail(r.code) };
    const i = r.q.drafts.findIndex((x) => x && x.id === req.id); if (i < 0) return { fail: fail('not-found') };
    const d = r.q.drafts[i]; if (d.status !== STATUS.PENDING) return { fail: fail(statusCodeOf(d.status)) };
    return { q: r.q, i, d };
  };
  /** Save; a failed save voids the record line so the record never says more than the queue. */
  const saveOrVoid = async (q, ctx, n) => {
    try { save(q, queuePath); return null; } catch { await recordLocked(ctx, { void: n }); log('draft decision: queue not saved'); return fail('write-failed'); }
  };

  async function skipDraft(req, ctx) {
    return queueLocked(async () => {
      const o = open(req); if (o.fail) return o.fail;
      if (draftVersion(o.d) !== req.version) return fail('version-changed');
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
      if (draftVersion(o.d) !== req.version) return fail('version-changed');
      if (text === o.d.text) return fail('no-change');
      const c = await checkEdit(o.d, text, { neverPromotePatterns }); if (!c.ok) return fail(c.code);
      const nd = structuredClone(o.d); applyEdit(nd, text, { now }); // on a copy: the real draft is replaced only after the record is written
      const rec = await recordLocked(ctx, { kind: 'draft', id: req.id, version: draftVersion(nd), decision: 'edit' }); if (!rec) return fail('record-failed');
      o.q.drafts[o.i] = nd;
      return (await saveOrVoid(o.q, ctx, rec.n)) || done(req.id, 'edited');
    });
  }
  /** Approve: the irreversible step. Order: switch, strict read, status, version, expiry, hidden characters, guards, record, ONE injected schedule call, state. */
  async function approveDraft(req, ctx) {
    if (!ready || !approveReady) return fail('check-failed');
    if (approveOn() !== true) return fail('cannot-decide'); // the off switch answers before any read, record or call
    return queueLocked(async () => {
      const o = open(req); if (o.fail) return o.fail;
      const { q, d } = o;
      if (draftVersion(d) !== req.version) return fail('version-changed');
      const exp = draftExpiresAt(d, ttlDays); if (exp !== null && now().getTime() > exp) return fail('expired'); // the worker expires drafts only while posting is not stopped
      if (hiddenCharsIn(d.text) || hiddenCharsIn(String(d.videoText ?? ''))) return fail('bad-characters');
      const g = await approveGuards(d, { cmd: 'approve', stop, neverPromotePatterns, notify, say, onCheckError: 'refuse', finalCheck });
      if (!g.ok) { if (g.code === 'blocked') { try { save(q, queuePath); } catch { /* best effort: the alert was sent */ } } return fail(g.code); }
      const rec = await recordLocked(ctx, { kind: 'draft', id: req.id, version: req.version, decision: 'approve' }); if (!rec) return fail('record-failed');
      const r = await scheduleDraft(q, d, { cmd: 'approve', schedule, igOn, say, now });
      if (!r.ok) {
        if (r.code === 'schedule-failed') { try { save(q, queuePath); } catch { /* best effort: lastError */ } return fail('schedule-failed'); } // outcome unknown: the record line stays
        await recordLocked(ctx, { void: rec.n }); return fail(r.code === 'stopped' ? 'stopped' : 'check-failed'); // nothing reached Meta
      }
      try { save(q, queuePath); } catch { log('review failed: schedule-not-saved'); return fail('schedule-not-saved'); } // the post exists: no void
      return { ok: true, change: { kind: 'draft', id: req.id, decision: 'scheduled' }, scheduledFor: r.scheduledFor, scheduledForText: plainTime(r.scheduledFor) };
    });
  }
  return { skipDraft, editDraft, approveDraft };
}
