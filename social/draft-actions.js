// What the WhatsApp commands and the review page both do to a queue draft: skip and edit.
// Each action has a CHECK step (never changes the draft) and an APPLY step (the change), because the page writes its record between the two.
// No network function is imported here: scheduling and posting stay in approval-server.js.
import { STATUS, brandGuard, voiceGate, rulesCheck } from './lib.js';

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
  return { ok: true };
}
export function applyEdit(d, text, { now = () => new Date() } = {}) {
  d.text = text; delete d.claimSources; delete d.claimSourcesHash; delete d.claimSourcesAt; d.editedAt = now().toISOString();
  return `✏️ ${d.id} updated (${text.length} chars). Reply *bpa approve ${d.id}* to schedule.`;
}
export async function editDraft(d, text, opts) { const c = await checkEdit(d, text, opts); if (!c.ok) return c; return { ok: true, line: applyEdit(d, text, opts) }; }
