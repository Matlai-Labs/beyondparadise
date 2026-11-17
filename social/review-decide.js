// Body parsing and the decision run for the review page routes. No state of its own: the actions (bpa-actions.js) decide and write.
import { stopStatus } from './stop.js';
import { stopPosting, startPosting, publicCode } from './bpa-actions.js';
import { appendDecision } from './review-decisions.js';
import { withDecisionLock } from './decision-lock.js';

const NO = Object.freeze({ ok: false });
const KINDS = new Set(['hook', 'clip']);
const ACTIONS = new Set(['approve', 'skip', 'undo', 'edit']);
const BASE_KEYS = new Set(['kind', 'id', 'version', 'action']);
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
// (kind, action) -> createActions function name; a Map, so a hostile word is just a miss
const FUNCTIONS = new Map([
  ['hook:approve', 'approveHook'], ['hook:skip', 'skipHook'], ['hook:undo', 'unapproveHook'], ['hook:edit', 'editHook'],
  ['clip:approve', 'approveClip'], ['clip:skip', 'skipClip'], ['clip:undo', 'unapproveClip'],
]);

function parseObject(text) {
  if (typeof text !== 'string') return null;
  let j; try { j = JSON.parse(text); } catch { return null; }
  return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
}

export function parseDecisionBody(text) {
  const j = parseObject(text); if (!j) return NO;
  const keys = Object.keys(j);
  for (const k of keys) if (!BASE_KEYS.has(k) && k !== 'text') return NO;
  const { kind, id, version, action } = j;
  if (typeof kind !== 'string' || !KINDS.has(kind) || typeof action !== 'string' || !ACTIONS.has(action)) return NO;
  if (!FUNCTIONS.has(`${kind}:${action}`)) return NO;
  if (typeof id !== 'string' || id.length < 1 || id.length > 200 || CONTROL.test(id)) return NO;
  if (typeof version !== 'string' || !/^[0-9a-f]{64}$/.test(version)) return NO;
  const hasText = Object.hasOwn(j, 'text');
  if (action === 'edit') {
    if (!hasText || typeof j.text !== 'string' || j.text.length < 1 || j.text.length > 200) return NO;
    return { ok: true, req: { kind, id, version, action, text: j.text } };
  }
  if (hasText) return NO;
  return { ok: true, req: { kind, id, version, action } };
}

export function parsePostingBody(text) {
  const j = parseObject(text); if (!j) return NO;
  const keys = Object.keys(j);
  if (!Object.hasOwn(j, 'action') || (j.action !== 'stop' && j.action !== 'start')) return NO;
  if (keys.length === 1) return { ok: true, action: j.action };
  // SR4: only Start may carry `seen`, the stop (its reason line with the time) the page showed when the owner tapped
  if (j.action !== 'start' || keys.length !== 2 || !Object.hasOwn(j, 'seen')) return NO;
  if (typeof j.seen !== 'string' || j.seen.length < 1 || j.seen.length > 300 || CONTROL.test(j.seen)) return NO;
  return { ok: true, action: 'start', seen: j.seen };
}

export async function runDecision(req, { actions, recordFile, claimedLogin, now = () => new Date() }) {
  const fn = FUNCTIONS.get(`${req.kind}:${req.action}`);
  if (!fn || typeof actions?.[fn] !== 'function') return { ok: false, code: 'bad-request' };
  const ctx = {
    record: (r) => appendDecision(recordFile, { ...r, claimedLogin, at: now().toISOString() }),
    voidRecord: (n) => appendDecision(recordFile, { kind: req.kind, id: req.id, version: null, decision: 'void', ref: n, claimedLogin, at: now().toISOString() }),
  };
  let r; try { r = await actions[fn](req, ctx); } catch { return { ok: false, code: 'check-failed' }; }
  if (!r || r.ok !== true) return { ok: false, code: publicCode(r?.code) };
  return r;
}

export async function runPosting(action, { recordFile, claimedLogin, now = () => new Date(), queuePath, stopOpts, readStatus = () => ({ stop: stopStatus(stopOpts) }), stop = stopPosting, start = startPosting, lockTimeoutMs = 5000, seen }) {
  // CR3: the record line is written under the decision lock like every other writer of the record, or two writers could read the same last number
  // (the stop itself never waits for the lock: it happens first, and a busy lock only costs the audit line)
  const rec = async (decision) => {
    try { return await withDecisionLock(() => appendDecision(recordFile, { kind: 'posting', id: 'posting', version: null, decision, claimedLogin, at: now().toISOString() }), { timeoutMs: lockTimeoutMs }); } catch { return { ok: false }; }
  };
  if (action === 'stop') {
    let note; try { note = stop({ queuePath, stopOpts, now: now() })?.note; } catch { /* the read-back below decides */ }
    try { await rec('stop'); } catch { /* best effort (D6) */ }
    const stopped = readStatus()?.stop?.stopped === true;
    return stopped ? { ok: true, ...(note ? { note } : {}) } : { ok: false, code: 'could-not-stop' };
  }
  if (action === 'start') {
    // SR4: the page saw one stop; if posting is stopped now by another one (stopped again by WhatsApp in between), a stale two-tap must not release it
    if (typeof seen === 'string') { let cur = null; try { cur = readStatus()?.stop; } catch { cur = null; } if (cur && cur.stopped === true && cur.reason !== seen) return { ok: false, code: 'stop-changed' }; }
    const r = await rec('start'); if (!r || r.ok !== true) return { ok: false, code: 'record-failed' };
    try { start({ stopOpts }); } catch { /* the read-back below decides */ }
    return readStatus()?.stop?.stopped === false ? { ok: true } : { ok: false, code: 'still-stopped' };
  }
  return { ok: false, code: 'bad-request' };
}
