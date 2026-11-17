#!/usr/bin/env node
// 127.0.0.1:3028 — the `bpa` WhatsApp command family (bridge → POST /bpa/action {text} → {message}).
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { authorize } from './auth.js';
import { withQueueLock, loadQueue, saveQueue, STATUS, parseCommand, renderList, schedulePost, publishNow, whatsapp, log, CONFIG, igEnabled, igPostDraftAny, QUEUE_PATH } from './lib.js';
import { stopStatus, engageStop, releaseStop, StoppedError } from './stop.js';
import { skipDraft, editDraft, approveGuards, scheduleDraft } from './draft-actions.js';
import { readQueueStrict } from './draft-version.js';
import { scheduledAtMetaNote, stopPosting, startPosting } from './bpa-actions.js';
import { reserveInstagramPublish, releaseInstagramReservation } from './ledger.js';
import { recordPost, healthTick } from './health.js';
import { createReviewHandler, defaultInputs, defaultActions, refuse } from './review-routes.js';
import { createSessions, loadAccess, checkHealthAccess, hasProxyHeaders } from './review-auth.js';
const PORT = CONFIG.approvalPort;
export { scheduledAtMetaNote };
/** Entry used by the HTTP handler: stop/start run OUTSIDE the queue lock (a long `post ... now` holds it for minutes and the bridge gives up after 45 s). */
export async function dispatch(text, deps = {}) {
  const cmd = parseCommand(text).cmd;
  if (cmd === 'stop' || cmd === 'start') return handle(text, deps);
  return withQueueLock(() => handle(text, deps), { lockPath: (deps.queuePath || QUEUE_PATH) + '.lock' });
}
export async function handle(text, deps = {}) {
  const { queuePath = QUEUE_PATH, stopOpts, stop = () => stopStatus(stopOpts), schedule = schedulePost, publish = publishNow, publishIg = igPostDraftAny, igOn = igEnabled, reserve = reserveInstagramPublish, release = releaseInstagramReservation, now: nowDep, ledgerPath, config: capConfig = CONFIG, lastPostPath, notify = whatsapp, neverPromotePatterns } = deps;
  const parsed = parseCommand(text); const again = parsed.cmd === 'approveagain'; const c = again ? { ...parsed, cmd: 'approve' } : parsed; // `bpa approve B1 again` is an approve that first clears the "check Meta first" mark
  // stop / start never wait for the queue lock (dispatch() below calls them outside it) and never need a readable queue.
  if (c.cmd === 'stop') return stopPosting({ queuePath, stopOpts, now: nowDep || new Date() }).reply;
  if (c.cmd === 'start') return startPosting({ stopOpts }).reply;
  // A command that SAVES never saves a queue it could not read (loadQueue would give an empty one and the save would wipe the real file). A MISSING file keeps the old behaviour: an empty queue, "not found".
  let q;
  if (['skip', 'edit', 'approve', 'postnow'].includes(c.cmd) && fs.existsSync(queuePath)) { const r = readQueueStrict(queuePath); if (!r.ok) return '⚠️ The queue file cannot be read, so nothing was changed. Tell Claude.'; q = r.q; } else q = loadQueue(queuePath);
  const find = (id) => q.drafts.find((d) => d.id === id);
  if (c.cmd === 'help') return 'bpa · bpa list · bpa approve B1 B2 · bpa skip B1 · bpa edit B1: text · bpa post B1 now · bpa status · bpa stop · bpa start';
  if (c.cmd === 'list') return renderList(q);
  if (c.cmd === 'status') { const n = (s) => q.drafts.filter((d) => d.status === s).length; const up = q.drafts.filter((d) => d.status === STATUS.SCHEDULED).map((d) => `${d.id} ${d.scheduledFor.slice(0, 16)}`).join(', ') || 'none'; return `📊 pending ${n(STATUS.PENDING)} · scheduled ${n(STATUS.SCHEDULED)} (${up}) · posted ${n(STATUS.POSTED)} · skipped ${n(STATUS.SKIPPED)} · blocked ${n(STATUS.BLOCKED)}`; }
  if (c.cmd === 'unknown') return `❓ Didn't get "${c.raw}". ${await handle('help', deps)}`;
  const out = [];
  for (const id of c.ids) {
    const d = find(id); if (!d) { out.push(`❌ ${id}: not found`); continue; }
    if (c.cmd === 'skip') { out.push(skipDraft(d).line); continue; }
    if (c.cmd === 'edit') { out.push((await editDraft(d, c.text, { neverPromotePatterns })).line); continue; }
    if (again) { // the way out of "check Meta first": the owner looked and no post is there. Same queue lock, then the normal approve with every guard.
      if (!d.metaUnknown) { out.push(`❌ ${id}: nothing to repeat`); continue; }
      delete d.metaUnknown; log(`approve again ${id}`);
    }
    if (c.cmd === 'approve' || c.cmd === 'postnow') {
      const g = await approveGuards(d, { cmd: c.cmd, stop, neverPromotePatterns, notify, say: log }); if (!g.ok) { out.push(g.line); continue; }
      try {
        if (c.cmd === 'postnow') {
          const r = await publish(d.text); d.status = STATUS.POSTED; d.postId = r.id; d.permalink = r.permalink_url; d.postedAt = new Date().toISOString(); recordPost({ now: new Date(), id, path: lastPostPath }); out.push(`✅ ${id} posted now on the Page: ${r.permalink_url || r.id}`);
          if (igOn()) {
            const rAt = new Date(); const rs = reserve({ id, now: rAt, config: capConfig, path: ledgerPath }); // daily cap: ledger line written before the network call
            if (!rs.ok) { d.ig = { status: 'queued', at: new Date().toISOString() }; log(`${id} instagram publish held, queued for the next free day: ${rs.reason}`); out.push(`📸 ${id} Instagram not posted: ${rs.reason}. It is queued; the worker will post it on the next free day.`); }
            else {
              try { const ig = await publishIg(d); d.ig = { status: 'posted', ...ig, postedAt: new Date().toISOString() }; recordPost({ now: new Date(), id, path: lastPostPath }); out.push(`📸 ${id} on Instagram: ${ig.permalink}`); }
              catch (e) {
                if (e instanceof StoppedError) { // stop arrived after the reservation: nothing reached the network, give the slot back and queue the leg
                  const rl = release({ id, at: rAt, path: ledgerPath }); d.ig = { status: 'queued', at: new Date().toISOString() };
                  log(`${id} instagram publish stopped before it started (${e.reason}); queued${rl.ok ? ', reservation released' : `, reservation kept (${rl.reason})`}`); out.push(`📸 ${id} Instagram held: ${e.reason}. It is queued and goes out after *bpa start*.`);
                } else { d.ig = { status: 'failed', error: e.message }; log(`${id} instagram publish failed; ledger reservation kept (safe direction): ${e.message.slice(0, 160)}`); out.push(`❌ ${id} Instagram failed: ${e.message.slice(0, 140)}`); }
              }
            }
          }
        } else {
          out.push((await scheduleDraft(q, d, { cmd: c.cmd, schedule, igOn, say: log })).line);
        }
      } catch (e) {
        if (e instanceof StoppedError) { log(`${c.cmd} ${id} refused: ${e.reason}`); out.push(`⏸ ${id}: ${e.reason}. Nothing was posted. Reply *bpa start* to resume.`); continue; }
        d.lastError = e.message; log(`${c.cmd} ${id} failed: ${e.message}`); out.push(`❌ ${id}: ${e.message.slice(0, 160)}`); }
    }
  }
  saveQueue(q, queuePath); return out.join('\n');
}
const reviewSessions = createSessions();
const reviewHandler = createReviewHandler({ sessions: reviewSessions, loadInputs: defaultInputs, loadActions: defaultActions, log });
export const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (reviewHandler(req, res)) return; // /review/*: its own access rule (login + cookie), see review-routes.js
  if (req.method === 'GET' && req.url === '/health') {
    // loopback callers (the worker) as before; through the published port only with the owner's login and a session cookie
    const g = checkHealthAccess(req, { port: Number(process.env.BPA_APPROVAL_PORT || PORT), access: loadAccess(), sessions: reviewSessions });
    if (!g.ok) { log(`review refused: ${g.reason} health`); return refuse(res, g); }
    return send(200, { ok: true, service: 'bpa-social approval', pending: loadQueue().drafts.filter((d) => d.status === STATUS.PENDING).length });
  }
  if (req.method === 'POST' && req.url === '/bpa/action') {
    // `tailscale serve` publishes the whole port; a request that came through it carries proxy headers, a loopback caller (the WhatsApp bridge) never does
    if (hasProxyHeaders(req)) { log('review refused: proxied-request action'); return refuse(res, { code: 403 }); }
    const auth = authorize(req, { ...process.env, BPA_APPROVAL_PORT: process.env.BPA_APPROVAL_PORT || String(PORT) }); if (!auth.ok) { log(`auth rejected: ${auth.reason}`); return send(auth.code, { ok: false, message: auth.reason }); }
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => { try { const { text } = JSON.parse(body || '{}'); log(`cmd: ${String(text).slice(0, 120)}`); const message = await dispatch(text); send(200, { ok: true, message }); } catch (e) { log(`cmd error ${e.message}`); send(500, { ok: false, message: `⚠️ bpa error: ${e.message}` }); } });
    return;
  }
  send(404, { ok: false });
});
const isMain = process.argv[1] && (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
// Hourly health check, run HERE (always on) and not in the worker: a worker cannot report its own death. One WhatsApp alert per condition per 24 h.
function startHealthWatch() {
  const startedAt = new Date(); // a missing/old worker state proves nothing until one worker interval + margin has passed since THIS start
  const tick = () => healthTick({ startedAt }).catch((e) => log(`health tick error ${e.message}`));
  setTimeout(tick, 60e3); setInterval(tick, 3600e3);
}
if (isMain) { server.listen(PORT, '127.0.0.1', () => log(`approval server listening on 127.0.0.1:${PORT}`)); startHealthWatch(); }
