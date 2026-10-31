#!/usr/bin/env node
// Every 15 min: reconcile scheduled posts with Meta, expire stale drafts, alert on failures; Monday 08:00 heartbeat.
import { stuckIgPublishes, markStuckAlerted, loadQueue, saveQueue, withQueueLock, mergeQueue, claimIgPublish, STATUS, postStatus, whatsapp, log, CONFIG, igEnabled, igPostDraftAny } from './lib.js';
const q = loadQueue(); const base = JSON.parse(JSON.stringify(q)); const now = new Date(); let changed = false; const problems = [];
for (const d of q.drafts) {
  if (d.status === STATUS.SCHEDULED && d.postId) {
    try { const s = await postStatus(d.postId); if (s.error) throw new Error(s.error.message); if (s.is_published) { d.status = STATUS.POSTED; d.permalink = s.permalink_url; d.postedAt = now.toISOString(); changed = true; log(`${d.id} posted ${s.permalink_url}`); } }
    catch (e) { if (new Date(d.scheduledFor).getTime() + 3600e3 < now.getTime()) { problems.push(`${d.id}: ${e.message.slice(0, 100)}`); } }
  }
  if (d.status === STATUS.PENDING && now.getTime() - new Date(d.createdAt).getTime() > CONFIG.draftTtlDays * 86400e3) { d.status = STATUS.EXPIRED; changed = true; log(`${d.id} expired`); }
  // Instagram has no reliable API scheduling: publish queued IG items when their time comes.
  if (d.ig?.status === 'queued' && new Date(d.ig.at).getTime() <= now.getTime() && igEnabled()) {
    const claimed = await claimIgPublish(d.id, now); // persisted 'publishing' marker before any Meta call
    if (!claimed) continue; // another run took it, or it was changed meanwhile
    d.ig = claimed; base.drafts.find((x) => x.id === d.id).ig = JSON.parse(JSON.stringify(claimed));
    try { const r = await igPostDraftAny(d); d.ig = { status: 'posted', ...r, postedAt: now.toISOString() }; changed = true; log(`${d.id} instagram ${r.permalink}`); }
    catch (e) { d.ig = { ...d.ig, status: 'failed', error: e.message }; changed = true; problems.push(`${d.id} Instagram: ${e.message.slice(0, 100)}`); }
  }
}
const stuck = stuckIgPublishes(q, now); // alerted once per draft; marked only after the alert is actually sent
if (stuck.length) problems.push(`Instagram publish stuck in 'publishing' (check Meta before retrying): ${stuck.join(', ')}`);
// health of the approval server (silence = alarm)
try { const h = await fetch(`http://127.0.0.1:${CONFIG.approvalPort}/health`, { signal: AbortSignal.timeout(3000) }); if (!(await h.json()).ok) throw new Error('unhealthy'); } catch (e) { problems.push(`approval server down (${e.message})`); }
const state = q.state || (q.state = {});
if (problems.length && (!state.lastAlert || now.getTime() - new Date(state.lastAlert).getTime() > 6 * 3600e3)) { if (await whatsapp(`⚠️ ${CONFIG.page} social: ${problems.join(' | ')}`)) { state.lastAlert = now.toISOString(); markStuckAlerted(q, stuck, now); changed = true; } }
const local = new Date(now.toLocaleString('en-US', { timeZone: CONFIG.timezone })); const week = `${local.getFullYear()}-W${Math.ceil(((local - new Date(local.getFullYear(), 0, 1)) / 86400e3 + 1) / 7)}`;
if (local.getDay() === 1 && local.getHours() >= 8 && state.lastHeartbeat !== week) {
  const n = (s) => q.drafts.filter((d) => d.status === s).length;
  if (await whatsapp(`💚 ${CONFIG.page} social weekly: pending ${n(STATUS.PENDING)}, scheduled ${n(STATUS.SCHEDULED)}, posted ${n(STATUS.POSTED)}, skipped ${n(STATUS.SKIPPED)}, expired ${n(STATUS.EXPIRED)}.`)) { state.lastHeartbeat = week; changed = true; }
}
state.lastRunOk = now.toISOString(); changed = true;
if (changed) await withQueueLock(async () => saveQueue(mergeQueue(base, q, loadQueue())));
