// What the WhatsApp commands and the review page both do to a queue draft: skip and edit.
// Each action has a CHECK step (never changes the draft) and an APPLY step (the change), because the page writes its record between the two.
// No network function is imported here: `schedule` is a parameter, never a default, and this file never names a publisher.
import { STATUS, brandGuard, voiceGate, rulesCheck, finalCheck as realFinalCheck, blockDraft, nextSlots, log } from './lib.js';
import { claimGateWhy } from './claim-gate.js';
import { numberFidelity } from './caption.js';
import { StoppedError } from './stop.js';

export const STATUS_CODE = new Map([[STATUS.SCHEDULED, 'already-scheduled'], [STATUS.SKIPPED, 'already-skipped'], [STATUS.POSTED, 'already-posted'], [STATUS.EXPIRED, 'expired'], [STATUS.BLOCKED, 'blocked'], [STATUS.FAILED, 'not-pending']]);
export const statusCodeOf = (status) => STATUS_CODE.get(status) || 'not-pending';

const notPending = (d) => ({ ok: false, code: statusCodeOf(d.status), line: `⚠️ ${d.id} is ${d.status}` });

export function checkSkip(d) { if (d.status !== STATUS.PENDING) return notPending(d); return { ok: true }; }
export function applySkip(d, { now = () => new Date() } = {}) { d.status = STATUS.SKIPPED; d.decidedAt = now().toISOString(); return `🚫 ${d.id} skipped`; }
export function skipDraft(d, opts) { const c = checkSkip(d); if (!c.ok) return c; return { ok: true, line: applySkip(d, opts) }; }

export async function checkEdit(d, text, { neverPromotePatterns } = {}) {
  if (d.status !== STATUS.PENDING) return notPending(d);
  const bad = brandGuard(text); if (bad) return { ok: false, code: 'brand-rule', line: `❌ ${d.id}: ${bad}` };
  const v = await voiceGate(text); if (!v.ok) return { ok: false, code: 'voice-rule', line: `❌ ${d.id}: voice-lint — ${v.reason}` };
  const rg = rulesCheck(text, { claims: d.claims, neverPromotePatterns }); if (!rg.ok) return { ok: false, code: 'rules', line: `❌ ${d.id}: rules — ${rg.reason}` };
  // numbers: where the draft has claims, a figure in the new text must be one of the claim figures (the line may name the numbers: WhatsApp only, the page shows the code)
  if (Array.isArray(d.claims) && d.claims.length) { const bad = numberFidelity([text], d.claims); if (bad.length) return { ok: false, code: 'number-not-in-facts', line: `❌ ${d.id}: number-not-in-facts — ${[...new Set(bad)].join(', ')}` }; }
  return { ok: true };
}
export function applyEdit(d, text, { now = () => new Date() } = {}) {
  d.text = text; delete d.claimSources; delete d.claimSourcesHash; delete d.claimSourcesAt; d.editedAt = now().toISOString();
  return `✏️ ${d.id} updated (${text.length} chars). Reply *bpa approve ${d.id}* to schedule.`;
}
export async function editDraft(d, text, opts) { const c = await checkEdit(d, text, opts); if (!c.ok) return c; return { ok: true, line: applyEdit(d, text, opts) }; }

// ── approve: the guards (the same on every route), then the scheduling step ─────────────────────────────────────────
const PASSED = new WeakSet(); // drafts that approveGuards let through; scheduleDraft consumes one entry per call, so nothing is scheduled without the checks
/** `say(text, code)`: the WhatsApp route passes `log` (it ignores the code); the page passes a say that logs only the closed code. */
export async function approveGuards(d, { cmd = 'approve', stop, neverPromotePatterns, notify, say = log, onCheckError = 'block', finalCheck = realFinalCheck } = {}) {
  if (d.status !== STATUS.PENDING) return notPending(d);
  { const st = stop(); if (st.stopped) { say(`${cmd} ${d.id} refused: ${st.reason}`, 'stopped'); return { ok: false, code: 'stopped', line: `⏸ ${d.id}: ${st.reason}. Reply *bpa start* to resume.` }; } }
  { const g = claimGateWhy(d); if (g) { say(`${cmd} ${d.id} refused: ${g.message}`, g.code); return { ok: false, code: g.code, line: `❌ ${d.id}: ${g.message}` }; } }
  // FINAL CHECK on the exact text that is about to go out (voice gate + rules), BEFORE any ledger reservation, schedule or publish call
  const fc = await finalCheck(d, { neverPromotePatterns });
  if (!fc.ok) {
    if (onCheckError === 'refuse' && (fc.listReason || fc.voiceUnavailable === true || (fc.ruleIds.length === 1 && fc.ruleIds[0] === 'check-error'))) { say('final check could not run', 'check-failed'); return { ok: false, code: 'check-failed', line: `❌ ${d.id}: the checks could not be run now. Nothing was changed.` }; }
    await blockDraft(d, fc, { stage: cmd === 'postnow' ? 'posting now' : 'scheduling', notify: typeof notify === 'function' ? notify : async () => {}, say });
    return { ok: false, code: 'blocked', line: `🚫 ${d.id} blocked: ${fc.ruleIds.join(', ')}. Nothing was posted or scheduled; it will not be retried.` };
  }
  PASSED.add(d); return { ok: true };
}
/** Schedules the Facebook post at Meta through the INJECTED `schedule` (no default) and records it on the draft. Needs a draft that approveGuards let through, once. */
export async function scheduleDraft(q, d, { cmd = 'approve', schedule, igOn, say = log, now = () => new Date(), at } = {}) {
  if (!PASSED.has(d)) return { ok: false, code: 'check-failed', line: `❌ ${d.id}: checks were not run` };
  PASSED.delete(d);
  if (typeof schedule !== 'function' || typeof igOn !== 'function') return { ok: false, code: 'schedule-failed', line: `❌ ${d.id}: scheduling is not available` }; // before the Meta call: a TypeError after it would be read as a failure while the post exists
  try {
    at = at ?? nextSlots(q, 1, now())[0]; const r = await schedule(d.text, at); d.status = STATUS.SCHEDULED; d.postId = r.id; d.scheduledFor = at; d.decidedAt = now().toISOString();
    const ig = igOn(); if (ig) d.ig = { status: 'queued', at };
    return { ok: true, line: `📅 ${d.id} scheduled for ${at.slice(0, 16)} on the Page${ig ? ' + Instagram' : ''} (${r.id})`, scheduledFor: at, postId: r.id };
  } catch (e) {
    if (e instanceof StoppedError) { say(`${cmd} ${d.id} refused: ${e.reason}`, 'stopped'); return { ok: false, code: 'stopped', line: `⏸ ${d.id}: ${e.reason}. Nothing was posted. Reply *bpa start* to resume.` }; }
    d.lastError = e.message; say(`${cmd} ${d.id} failed: ${e.message}`, 'schedule-failed'); return { ok: false, code: 'schedule-failed', line: `❌ ${d.id}: ${e.message.slice(0, 160)}` };
  }
}
