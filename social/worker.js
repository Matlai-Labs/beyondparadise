#!/usr/bin/env node
// Every 15 min: reconcile scheduled posts with Meta, expire stale drafts, alert on failures; Monday 08:00 heartbeat.
// Exported as runWorker(deps) so tests can inject every external call; the launchd entry (node worker.js) runs it once.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stuckIgPublishes, markStuckAlerted, loadQueue, saveQueue, withQueueLock, mergeQueue, claimIgPublish, STATUS, postStatus as metaPostStatus, whatsapp, log, CONFIG, igEnabled, igPostDraftAny, igGate, QUEUE_PATH } from './lib.js';
import { stopStatus } from './stop.js';

const defaultApprovalHealth = async () => { const h = await fetch(`http://127.0.0.1:${CONFIG.approvalPort}/health`, { signal: AbortSignal.timeout(3000) }); return h.json(); };

export async function runWorker(deps = {}) {
  const { now = new Date(), queuePath = QUEUE_PATH, igOn = igEnabled, publishIg = igPostDraftAny, postStatus = metaPostStatus, notify = whatsapp, say = log,
    approvalHealth = defaultApprovalHealth, stopOpts, stop = () => stopStatus(stopOpts) } = deps;
  const lockOpts = { lockPath: queuePath + '.lock' };
  // stop flag (own or fleet-wide): publish nothing, schedule nothing, touch nothing; one line; exit code stays 0
  { const st = stop(); if (st.stopped) { say(`worker: ${st.reason}`); return { exitCode: 0, stopped: true }; } }
  const q = loadQueue(queuePath); const base = JSON.parse(JSON.stringify(q)); let changed = false; const problems = []; let stopNoted = false;
  for (const d of q.drafts) {
    if (d.status === STATUS.SCHEDULED && d.postId) {
      try { const s = await postStatus(d.postId); if (s.error) throw new Error(s.error.message); if (s.is_published) { d.status = STATUS.POSTED; d.permalink = s.permalink_url; d.postedAt = now.toISOString(); changed = true; say(`${d.id} posted ${s.permalink_url}`); } }
      catch (e) { if (new Date(d.scheduledFor).getTime() + 3600e3 < now.getTime()) { problems.push(`${d.id}: ${e.message.slice(0, 100)}`); } }
    }
    if (d.status === STATUS.PENDING && now.getTime() - new Date(d.createdAt).getTime() > CONFIG.draftTtlDays * 86400e3) { d.status = STATUS.EXPIRED; changed = true; say(`${d.id} expired`); }
    // Instagram has no reliable API scheduling: publish queued IG items when their time comes.
    if (d.ig?.status === 'queued' && new Date(d.ig.at).getTime() <= now.getTime() && igOn()) {
      { const st = stop(); if (st.stopped) { if (!stopNoted) { stopNoted = true; say(`worker: ${st.reason} (publishing skipped mid-run)`); } continue; } } // re-checked right before the claim
      const claimed = await claimIgPublish(d.id, now, queuePath); // persisted 'publishing' marker before any Meta call
      if (!claimed) continue; // another run took it, or it was changed meanwhile
      d.ig = claimed; base.drafts.find((x) => x.id === d.id).ig = JSON.parse(JSON.stringify(claimed));
      try { const r = await publishIg(d); d.ig = { status: 'posted', ...r, postedAt: now.toISOString() }; changed = true; say(`${d.id} instagram ${r.permalink}`); }
      catch (e) { d.ig = { ...d.ig, status: 'failed', error: e.message }; changed = true; problems.push(`${d.id} Instagram: ${e.message.slice(0, 100)}`); }
    }
  }
  // Instagram on in config.json but off in practice: say so (log per post, one alert per state change) instead of skipping quietly
  if (await igGate(q, { now, notify, say })) changed = true;
  const stuck = stuckIgPublishes(q, now); // alerted once per draft; marked only after the alert is actually sent
  if (stuck.length) problems.push(`Instagram publish stuck in 'publishing' (check Meta before retrying): ${stuck.join(', ')}`);
  // health of the approval server (silence = alarm)
  try { if (!(await approvalHealth()).ok) throw new Error('unhealthy'); } catch (e) { problems.push(`approval server down (${e.message})`); }
  const state = q.state || (q.state = {});
  if (problems.length && (!state.lastAlert || now.getTime() - new Date(state.lastAlert).getTime() > 6 * 3600e3)) { if (await notify(`⚠️ ${CONFIG.page} social: ${problems.join(' | ')}`)) { state.lastAlert = now.toISOString(); markStuckAlerted(q, stuck, now); changed = true; } }
  const local = new Date(now.toLocaleString('en-US', { timeZone: CONFIG.timezone })); const week = `${local.getFullYear()}-W${Math.ceil(((local - new Date(local.getFullYear(), 0, 1)) / 86400e3 + 1) / 7)}`;
  if (local.getDay() === 1 && local.getHours() >= 8 && state.lastHeartbeat !== week) {
    const n = (s) => q.drafts.filter((d) => d.status === s).length;
    if (await notify(`💚 ${CONFIG.page} social weekly: pending ${n(STATUS.PENDING)}, scheduled ${n(STATUS.SCHEDULED)}, posted ${n(STATUS.POSTED)}, skipped ${n(STATUS.SKIPPED)}, expired ${n(STATUS.EXPIRED)}.`)) { state.lastHeartbeat = week; changed = true; }
  }
  state.lastRunOk = now.toISOString(); changed = true;
  if (changed) await withQueueLock(async () => saveQueue(mergeQueue(base, q, loadQueue(queuePath)), queuePath), lockOpts);
  return { exitCode: 0, stopped: false };
}

const isMain = process.argv[1] && (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) { const r = await runWorker(); process.exitCode = r.exitCode; }
