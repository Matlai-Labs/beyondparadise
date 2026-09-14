#!/usr/bin/env node
// 127.0.0.1:3028 — the `bpa` WhatsApp command family (bridge → POST /bpa/action {text} → {message}).
import http from 'node:http';
import { loadQueue, saveQueue, STATUS, parseCommand, renderList, nextSlots, schedulePost, publishNow, brandGuard, voiceGate, log, CONFIG, igEnabled, igPostDraftAny } from './lib.js';
const PORT = CONFIG.approvalPort;
async function handle(text) {
  const c = parseCommand(text); const q = loadQueue(); const find = (id) => q.drafts.find((d) => d.id === id);
  if (c.cmd === 'help') return 'bpa · bpa list · bpa approve B1 B2 · bpa skip B1 · bpa edit B1: text · bpa post B1 now · bpa status';
  if (c.cmd === 'list') return renderList(q);
  if (c.cmd === 'status') { const n = (s) => q.drafts.filter((d) => d.status === s).length; const up = q.drafts.filter((d) => d.status === STATUS.SCHEDULED).map((d) => `${d.id} ${d.scheduledFor.slice(0, 16)}`).join(', ') || 'none'; return `📊 pending ${n(STATUS.PENDING)} · scheduled ${n(STATUS.SCHEDULED)} (${up}) · posted ${n(STATUS.POSTED)} · skipped ${n(STATUS.SKIPPED)}`; }
  if (c.cmd === 'unknown') return `❓ Didn't get "${c.raw}". ${await handle('help')}`;
  const out = [];
  for (const id of c.ids) {
    const d = find(id); if (!d) { out.push(`❌ ${id}: not found`); continue; }
    if (c.cmd === 'skip') { if (d.status !== STATUS.PENDING) { out.push(`⚠️ ${id} is ${d.status}`); continue; } d.status = STATUS.SKIPPED; d.decidedAt = new Date().toISOString(); out.push(`🚫 ${id} skipped`); continue; }
    if (c.cmd === 'edit') { if (d.status !== STATUS.PENDING) { out.push(`⚠️ ${id} is ${d.status}`); continue; } const bad = brandGuard(c.text); if (bad) { out.push(`❌ ${id}: ${bad}`); continue; } const v = await voiceGate(c.text); if (!v.ok) { out.push(`❌ ${id}: voice-lint — ${v.reason}`); continue; } d.text = c.text; d.editedAt = new Date().toISOString(); out.push(`✏️ ${id} updated (${c.text.length} chars). Reply *bpa approve ${id}* to schedule.`); continue; }
    if (c.cmd === 'approve' || c.cmd === 'postnow') {
      if (d.status !== STATUS.PENDING) { out.push(`⚠️ ${id} is ${d.status}`); continue; }
      try {
        if (c.cmd === 'postnow') {
          const r = await publishNow(d.text); d.status = STATUS.POSTED; d.postId = r.id; d.permalink = r.permalink_url; d.postedAt = new Date().toISOString(); out.push(`✅ ${id} posted now on the Page: ${r.permalink_url || r.id}`);
          if (igEnabled()) { try { const ig = await igPostDraftAny(d); d.ig = { status: 'posted', ...ig, postedAt: new Date().toISOString() }; out.push(`📸 ${id} on Instagram: ${ig.permalink}`); } catch (e) { d.ig = { status: 'failed', error: e.message }; out.push(`❌ ${id} Instagram failed: ${e.message.slice(0, 140)}`); } }
        } else {
          const [at] = nextSlots(q, 1); const r = await schedulePost(d.text, at); d.status = STATUS.SCHEDULED; d.postId = r.id; d.scheduledFor = at; d.decidedAt = new Date().toISOString();
          if (igEnabled()) d.ig = { status: 'queued', at };
          out.push(`📅 ${id} scheduled for ${at.slice(0, 16)} on the Page${igEnabled() ? ' + Instagram' : ''} (${r.id})`);
        }
      } catch (e) { d.lastError = e.message; log(`${c.cmd} ${id} failed: ${e.message}`); out.push(`❌ ${id}: ${e.message.slice(0, 160)}`); }
    }
  }
  saveQueue(q); return out.join('\n');
}
const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, service: 'bpa-social approval', pending: loadQueue().drafts.filter((d) => d.status === STATUS.PENDING).length });
  if (req.method === 'POST' && req.url === '/bpa/action') {
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => { try { const { text } = JSON.parse(body || '{}'); log(`cmd: ${String(text).slice(0, 120)}`); const message = await handle(text); send(200, { ok: true, message }); } catch (e) { log(`cmd error ${e.message}`); send(500, { ok: false, message: `⚠️ bpa error: ${e.message}` }); } });
    return;
  }
  send(404, { ok: false });
});
server.listen(PORT, '127.0.0.1', () => log(`approval server listening on 127.0.0.1:${PORT}`));
