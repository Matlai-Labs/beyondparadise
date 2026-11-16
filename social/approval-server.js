#!/usr/bin/env node
// 127.0.0.1:3028 — the `bpa` WhatsApp command family (bridge → POST /bpa/action {text} → {message}).
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { authorize } from './auth.js';
import { claimGate } from './claim-gate.js';
import { withQueueLock, loadQueue, saveQueue, STATUS, parseCommand, renderList, nextSlots, schedulePost, publishNow, brandGuard, voiceGate, log, CONFIG, igEnabled, igPostDraftAny, QUEUE_PATH } from './lib.js';
import { stopStatus, engageStop, releaseStop } from './stop.js';
import { reserveInstagramPublish } from './ledger.js';
import { recordPost, healthTick } from './health.js';
const PORT = CONFIG.approvalPort;
export async function handle(text, deps = {}) {
  const { queuePath = QUEUE_PATH, stopOpts, stop = () => stopStatus(stopOpts), schedule = schedulePost, publish = publishNow, publishIg = igPostDraftAny, igOn = igEnabled, reserve = reserveInstagramPublish, ledgerPath, config: capConfig = CONFIG, lastPostPath } = deps;
  const c = parseCommand(text);
  if (c.cmd === 'stop') return engageStop(stopOpts); // before the queue is read: stopping must work even when the queue file is damaged
  if (c.cmd === 'start') return releaseStop(stopOpts);
  const q = loadQueue(queuePath); const find = (id) => q.drafts.find((d) => d.id === id);
  if (c.cmd === 'help') return 'bpa · bpa list · bpa approve B1 B2 · bpa skip B1 · bpa edit B1: text · bpa post B1 now · bpa status · bpa stop · bpa start';
  if (c.cmd === 'list') return renderList(q);
  if (c.cmd === 'status') { const n = (s) => q.drafts.filter((d) => d.status === s).length; const up = q.drafts.filter((d) => d.status === STATUS.SCHEDULED).map((d) => `${d.id} ${d.scheduledFor.slice(0, 16)}`).join(', ') || 'none'; return `📊 pending ${n(STATUS.PENDING)} · scheduled ${n(STATUS.SCHEDULED)} (${up}) · posted ${n(STATUS.POSTED)} · skipped ${n(STATUS.SKIPPED)}`; }
  if (c.cmd === 'unknown') return `❓ Didn't get "${c.raw}". ${await handle('help', deps)}`;
  const out = [];
  for (const id of c.ids) {
    const d = find(id); if (!d) { out.push(`❌ ${id}: not found`); continue; }
    if (c.cmd === 'skip') { if (d.status !== STATUS.PENDING) { out.push(`⚠️ ${id} is ${d.status}`); continue; } d.status = STATUS.SKIPPED; d.decidedAt = new Date().toISOString(); out.push(`🚫 ${id} skipped`); continue; }
    if (c.cmd === 'edit') { if (d.status !== STATUS.PENDING) { out.push(`⚠️ ${id} is ${d.status}`); continue; } const bad = brandGuard(c.text); if (bad) { out.push(`❌ ${id}: ${bad}`); continue; } const v = await voiceGate(c.text); if (!v.ok) { out.push(`❌ ${id}: voice-lint — ${v.reason}`); continue; } d.text = c.text; delete d.claimSources; delete d.claimSourcesHash; delete d.claimSourcesAt; d.editedAt = new Date().toISOString(); out.push(`✏️ ${id} updated (${c.text.length} chars). Reply *bpa approve ${id}* to schedule.`); continue; }
    if (c.cmd === 'approve' || c.cmd === 'postnow') {
      if (d.status !== STATUS.PENDING) { out.push(`⚠️ ${id} is ${d.status}`); continue; }
      { const st = stop(); if (st.stopped) { log(`${c.cmd} ${id} refused: ${st.reason}`); out.push(`⏸ ${id}: ${st.reason}. Reply *bpa start* to resume.`); continue; } }
      { const g = claimGate(d); if (g) { log(`${c.cmd} ${id} refused: ${g}`); out.push(`❌ ${id}: ${g}`); continue; } }
      try {
        if (c.cmd === 'postnow') {
          const r = await publish(d.text); d.status = STATUS.POSTED; d.postId = r.id; d.permalink = r.permalink_url; d.postedAt = new Date().toISOString(); recordPost({ now: new Date(), id, path: lastPostPath }); out.push(`✅ ${id} posted now on the Page: ${r.permalink_url || r.id}`);
          if (igOn()) {
            const rs = reserve({ id, now: new Date(), config: capConfig, path: ledgerPath }); // daily cap: ledger line written before the network call
            if (!rs.ok) { log(`${id} instagram publish held: ${rs.reason}`); out.push(`📸 ${id} Instagram not posted: ${rs.reason}`); }
            else { try { const ig = await publishIg(d); d.ig = { status: 'posted', ...ig, postedAt: new Date().toISOString() }; recordPost({ now: new Date(), id, path: lastPostPath }); out.push(`📸 ${id} on Instagram: ${ig.permalink}`); } catch (e) { d.ig = { status: 'failed', error: e.message }; log(`${id} instagram publish failed; ledger reservation kept (safe direction): ${e.message.slice(0, 160)}`); out.push(`❌ ${id} Instagram failed: ${e.message.slice(0, 140)}`); } }
          }
        } else {
          const [at] = nextSlots(q, 1); const r = await schedule(d.text, at); d.status = STATUS.SCHEDULED; d.postId = r.id; d.scheduledFor = at; d.decidedAt = new Date().toISOString();
          if (igOn()) d.ig = { status: 'queued', at };
          out.push(`📅 ${id} scheduled for ${at.slice(0, 16)} on the Page${igOn() ? ' + Instagram' : ''} (${r.id})`);
        }
      } catch (e) { d.lastError = e.message; log(`${c.cmd} ${id} failed: ${e.message}`); out.push(`❌ ${id}: ${e.message.slice(0, 160)}`); }
    }
  }
  saveQueue(q, queuePath); return out.join('\n');
}
const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, service: 'bpa-social approval', pending: loadQueue().drafts.filter((d) => d.status === STATUS.PENDING).length });
  if (req.method === 'POST' && req.url === '/bpa/action') {
    const auth = authorize(req, { ...process.env, BPA_APPROVAL_PORT: process.env.BPA_APPROVAL_PORT || String(PORT) }); if (!auth.ok) { log(`auth rejected: ${auth.reason}`); return send(auth.code, { ok: false, message: auth.reason }); }
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => { try { const { text } = JSON.parse(body || '{}'); log(`cmd: ${String(text).slice(0, 120)}`); const message = await withQueueLock(() => handle(text)); send(200, { ok: true, message }); } catch (e) { log(`cmd error ${e.message}`); send(500, { ok: false, message: `⚠️ bpa error: ${e.message}` }); } });
    return;
  }
  send(404, { ok: false });
});
const isMain = process.argv[1] && (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
// Hourly health check, run HERE (always on) and not in the worker: a worker cannot report its own death. One WhatsApp alert per condition per 24 h.
function startHealthWatch() {
  const tick = () => healthTick({}).catch((e) => log(`health tick error ${e.message}`));
  setTimeout(tick, 60e3); setInterval(tick, 3600e3);
}
if (isMain) { server.listen(PORT, '127.0.0.1', () => log(`approval server listening on 127.0.0.1:${PORT}`)); startHealthWatch(); }
