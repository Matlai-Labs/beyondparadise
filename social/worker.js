#!/usr/bin/env node
// Every 15 min: reconcile scheduled posts with Meta, expire stale drafts, alert on failures; Monday 08:00 heartbeat.
// Exported as runWorker(deps) so tests can inject every external call; the launchd entry (node worker.js) runs it once.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stuckIgPublishes, markStuckAlerted, loadQueue, saveQueue, withQueueLock, mergeQueue, claimIgPublish, STATUS, postStatus as metaPostStatus, whatsapp, log, CONFIG, igEnabled, igPostDraftAny, igGate, QUEUE_PATH, finalCheck, blockDraft } from './lib.js';
import { stopStatus, StoppedError } from './stop.js';
import { reserveInstagramPublish, releaseInstagramReservation, eatDay } from './ledger.js';
import { recordWorkerRun, recordPost } from './health.js';

const defaultApprovalHealth = async () => { const h = await fetch(`http://127.0.0.1:${CONFIG.approvalPort}/health`, { signal: AbortSignal.timeout(3000) }); return h.json(); };

/** Runs once and records the run (ok / stopped / error) in the health state; an error is recorded and rethrown, so launchd still sees it. */
export async function runWorker(deps = {}) {
  let r;
  try { r = await runWorkerInner(deps); }
  catch (e) { recordWorkerRun({ now: deps.now || new Date(), result: `error: ${String(e.message).slice(0, 200)}`, path: deps.runStatePath }); throw e; }
  recordWorkerRun({ now: deps.now || new Date(), result: r.stopped ? 'stopped' : r.publishFailed ? 'publish-failed' : 'ok', path: deps.runStatePath });
  return r;
}
async function runWorkerInner(deps) {
  const { now = new Date(), lastPostPath, queuePath = QUEUE_PATH, igOn = igEnabled, publishIg = igPostDraftAny, postStatus = metaPostStatus, notify = whatsapp, say = log,
    approvalHealth = defaultApprovalHealth, reserve = reserveInstagramPublish, release = releaseInstagramReservation, ledgerPath, config: capConfig = CONFIG, stopOpts, stop = () => stopStatus(stopOpts), check = finalCheck, neverPromotePatterns } = deps;
  const lockOpts = { lockPath: queuePath + '.lock' };
  // stop flag (own or fleet-wide): publish nothing, schedule nothing, touch nothing; one line; exit code stays 0
  { const st = stop(); if (st.stopped) { say(`worker: ${st.reason}`); return { exitCode: 0, stopped: true }; } }
  const q = loadQueue(queuePath); const base = JSON.parse(JSON.stringify(q)); let changed = false; const problems = []; let stopNoted = false; let publishFailed = false; const state = q.state || (q.state = {});
  for (const d of q.drafts) {
    if (d.status === STATUS.SCHEDULED && d.postId) {
      try { const s = await postStatus(d.postId); if (s.error) throw new Error(s.error.message); if (s.is_published) { d.status = STATUS.POSTED; d.permalink = s.permalink_url; d.postedAt = now.toISOString(); changed = true; say(`${d.id} posted ${s.permalink_url}`); recordPost({ now, id: d.id, path: lastPostPath }); } }
      catch (e) { if (new Date(d.scheduledFor).getTime() + 3600e3 < now.getTime()) { problems.push(`${d.id}: ${e.message.slice(0, 100)}`); } }
    }
    if (d.status === STATUS.PENDING && now.getTime() - new Date(d.createdAt).getTime() > CONFIG.draftTtlDays * 86400e3) { d.status = STATUS.EXPIRED; changed = true; say(`${d.id} expired`); }
    // Instagram has no reliable API scheduling: publish queued IG items when their time comes.
    if (d.ig?.status === 'queued' && new Date(d.ig.at).getTime() <= now.getTime() && igOn()) {
      { const st = stop(); if (st.stopped) { if (!stopNoted) { stopNoted = true; say(`worker: ${st.reason} (publishing skipped mid-run)`); } continue; } } // re-checked right before the claim
      // FINAL CHECK on the exact text that is about to go out (voice gate + rules). Before the cap reservation, so a blocked item uses no slot; blocked is never retried.
      { const fc = await check(d, { neverPromotePatterns }); if (!fc.ok) { await blockDraft(d, fc, { stage: 'Instagram publish', now, notify, say }); changed = true; continue; } }
      // daily cap: reserve (ledger line written NOW, before any network call). Refused = the item stays queued and is retried on a later day.
      const rs = reserve({ id: d.id, now, config: capConfig, path: ledgerPath });
      if (!rs.ok) {
        const day = eatDay(now); const noted = state.capNoted?.day === day ? state.capNoted.ids : [];
        if (!noted.includes(d.id)) { say(`${d.id} instagram publish held: ${rs.reason}`); state.capNoted = { day, ids: [...noted, d.id] }; changed = true; if (!/daily cap/.test(rs.reason)) problems.push(`${d.id} Instagram held: ${rs.reason}`); }
        continue;
      }
      const claimed = await claimIgPublish(d.id, now, queuePath); // persisted 'publishing' marker before any Meta call
      if (!claimed) { say(`${d.id} instagram claim failed after the reservation; reservation kept`); continue; } // another run took it, or it was changed meanwhile
      d.ig = claimed; base.drafts.find((x) => x.id === d.id).ig = JSON.parse(JSON.stringify(claimed));
      try { const r = await publishIg(d); d.ig = { status: 'posted', ...r, postedAt: now.toISOString() }; changed = true; say(`${d.id} instagram ${r.permalink}`); recordPost({ now, id: d.id, path: lastPostPath }); }
      catch (e) {
        if (e instanceof StoppedError) { // a stop arrived after the reservation: nothing reached the network, so give the slot back and requeue (no alert, not a failure)
          d.ig = { status: 'queued', at: claimed.at }; changed = true; const rl = release({ id: d.id, at: now, path: ledgerPath });
          say(`${d.id} instagram publish stopped before it started (${e.reason}); item queued again${rl.ok ? ', reservation released' : `, reservation kept (${rl.reason})`}`); continue;
        }
        d.ig = { ...d.ig, status: 'failed', error: e.message }; changed = true; say(`${d.id} instagram publish failed; ledger reservation kept (safe direction): ${e.message.slice(0, 160)}`); problems.push(`${d.id} Instagram: ${e.message.slice(0, 100)}`); publishFailed = true; }
    }
  }
  // Instagram on in config.json but off in practice: say so (log per post, one alert per state change) instead of skipping quietly
  if (await igGate(q, { now, notify, say })) changed = true;
  const stuck = stuckIgPublishes(q, now); // alerted once per draft; marked only after the alert is actually sent
  if (stuck.length) problems.push(`Instagram publish stuck in 'publishing' (check Meta before retrying): ${stuck.join(', ')}`);
  // health of the approval server (silence = alarm)
  try { if (!(await approvalHealth()).ok) throw new Error('unhealthy'); } catch (e) { problems.push(`approval server down (${e.message})`); }
  if (problems.length && (!state.lastAlert || now.getTime() - new Date(state.lastAlert).getTime() > 6 * 3600e3)) { if (await notify(`⚠️ ${CONFIG.page} social: ${problems.join(' | ')}`)) { state.lastAlert = now.toISOString(); markStuckAlerted(q, stuck, now); changed = true; } }
  const local = new Date(now.toLocaleString('en-US', { timeZone: CONFIG.timezone })); const week = `${local.getFullYear()}-W${Math.ceil(((local - new Date(local.getFullYear(), 0, 1)) / 86400e3 + 1) / 7)}`;
  if (local.getDay() === 1 && local.getHours() >= 8 && state.lastHeartbeat !== week) {
    const n = (s) => q.drafts.filter((d) => d.status === s).length;
    if (await notify(`💚 ${CONFIG.page} social weekly: pending ${n(STATUS.PENDING)}, scheduled ${n(STATUS.SCHEDULED)}, posted ${n(STATUS.POSTED)}, skipped ${n(STATUS.SKIPPED)}, expired ${n(STATUS.EXPIRED)}, blocked ${n(STATUS.BLOCKED)}.`)) { state.lastHeartbeat = week; changed = true; }
  }
  state.lastRunOk = now.toISOString(); changed = true;
  if (changed) await withQueueLock(async () => saveQueue(mergeQueue(base, q, loadQueue(queuePath)), queuePath), lockOpts);
  return { exitCode: 0, stopped: false, publishFailed };
}

const isMain = process.argv[1] && (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) { const r = await runWorker(); process.exitCode = r.exitCode; }
