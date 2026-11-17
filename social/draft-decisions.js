// The review page's Skip and Edit for queue drafts: queue lock, the version the owner saw, the record first, then the change.
// The checks and the changes are the SHARED functions of draft-actions.js (the WhatsApp commands call the same ones); nothing here sends anything.
// Locks: the queue lock first, the decision lock only for the short record line inside it, never the other way round.
import { withQueueLock, saveQueue, nextSlots, STATUS, CONFIG, log } from './lib.js';
import { readDecisions } from './review-decisions.js';
import { withDecisionLock } from './decision-lock.js';
import { publicCode } from './bpa-actions.js';
import { hiddenCharsIn } from './invisible-chars.js';
import { draftVersion, readQueueStrict, draftExpiresAt, textTooLong, hasHiddenChars } from './draft-version.js';
import { plainTime } from './plain-time.js';
import { checkSkip, applySkip, checkEdit, applyEdit, approveGuards, scheduleDraft, statusCodeOf } from './draft-actions.js';

const MAX_TEXT = 2000;
const fail = (code) => ({ ok: false, code: publicCode(code) });
const done = (id, decision) => ({ ok: true, change: { kind: 'draft', id, decision } });

/** No default for the queue file, the record file or the never-promote key: a caller that forgets one gets check-failed and nothing is read or written. */
export function createDraftActions(options = {}) {
  const hasKey = Object.hasOwn(options, 'neverPromotePatterns'); // a destructured parameter cannot tell an absent key from undefined
  const { env = process.env, queuePath, recordFile, now = () => new Date(), lockTimeoutMs = 5000, save = saveQueue, neverPromotePatterns, ttlDays = CONFIG.draftTtlDays, scheduleTimeoutMs = 70000, schedule, igOn, stop, notify, approveOn,
    finalCheck, // test seam: review-routes.js never passes it (review-step3-guards.test.js, guard f); the real final check is the default
  } = options;
  const approveReady = [schedule, igOn, stop, notify, approveOn].every((f) => typeof f === 'function'); // an igOn that is missing would be called AFTER the Meta call and read as a failure while the post exists
  /** The injected schedule with a time limit above the 60 second limit of the Meta call: a hanging call must not hold the queue lock for ever. The timeout is an error, so scheduleDraft answers schedule-failed. */
  const scheduleBounded = async (text, at) => {
    let timer; const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('schedule timed out')), scheduleTimeoutMs); timer.unref?.(); });
    try { return await Promise.race([schedule(text, at), limit]); } finally { clearTimeout(timer); }
  };
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
    try { save(q, queuePath); return null; } catch { const v = await recordLocked(ctx, { void: n }); log('draft decision: queue not saved'); if (!v) log('review failed: void-record-failed'); return fail('write-failed'); } // the record then says more than the queue: say so
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
      if (o.d.auto === true) return fail('cannot-decide'); // an edit would fail the automatic lane's own text check for good: not offered, not accepted
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
    if (typeof req?.slot !== 'string') return fail('bad-request'); // the date the owner saw
    return queueLocked(async () => {
      const o = open(req); if (o.fail) return o.fail;
      const { q, d } = o;
      if (draftVersion(d) !== req.version) return fail('version-changed');
      const exp = draftExpiresAt(d, ttlDays); if (exp === null || now().getTime() > exp) return fail('expired'); // a creation time that cannot be read counts as expired on the page (the WhatsApp route is unchanged) // the worker expires drafts only while posting is not stopped
      if (textTooLong(d)) return fail('text-too-long'); // the card shows at most 5000 characters: what was read must be all that goes out
      if (hasHiddenChars(d)) return fail('bad-characters'); // caption, on-video text and every slide text
      // An earlier approve may already exist at Meta (its record line is written BEFORE the call and survives a crash): never a second one.
      const rd = readDecisions(recordFile); if (!rd.ok) return fail('record-failed');
      if (d.metaUnknown || rd.records.some((x) => x.kind === 'draft' && x.id === req.id && x.decision === 'approve')) return fail('check-meta');
      const at = nextSlots(q, 1, now())[0]; if (req.slot !== at) return fail('slot-changed'); // the value compared is the value scheduled
      const g = await approveGuards(d, { cmd: 'approve', stop, neverPromotePatterns, notify, say, onCheckError: 'refuse', finalCheck });
      if (!g.ok) { if (g.code === 'blocked') { try { save(q, queuePath); } catch { /* best effort: the alert was sent */ } } return fail(g.code); }
      const rec = await recordLocked(ctx, { kind: 'draft', id: req.id, version: req.version, decision: 'approve' }); if (!rec) return fail('record-failed');
      const r = await scheduleDraft(q, d, { cmd: 'approve', schedule: scheduleBounded, igOn, persist: (qq) => save(qq, queuePath), say, now, at });
      if (!r.ok) {
        if (r.code === 'schedule-failed') { d.metaUnknown = { at: now().toISOString() }; try { save(q, queuePath); } catch { /* best effort: lastError */ } return fail('schedule-failed'); } // outcome unknown: the record line stays
        await recordLocked(ctx, { void: rec.n }); return fail(r.code === 'stopped' || r.code === 'write-failed' ? r.code : 'check-failed'); // nothing reached Meta
      }
      try { save(q, queuePath); } catch { log('review failed: schedule-not-saved'); d.metaUnknown = { at: now().toISOString() }; try { save(q, queuePath); } catch { /* the record line is the durable guard */ } return fail('schedule-not-saved'); } // the post exists: no void
      return { ok: true, change: { kind: 'draft', id: req.id, decision: 'scheduled' }, scheduledFor: r.scheduledFor, scheduledForText: plainTime(r.scheduledFor) };
    });
  }
  return { skipDraft, editDraft, approveDraft };
}
