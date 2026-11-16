#!/usr/bin/env node
// Weekly drafter: BPI briefs (last 7 days) → up to 3 drafts → queue (pending_approval) → WhatsApp.
// Exported as runDraft(deps) so tests can inject every external call; the launchd entry (node draft.js) runs it once.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withQueueLock, readBriefs as readBriefsReal, buildDrafts as buildDraftsReal, loadQueue, saveQueue, nextId, STATUS, whatsapp, renderList, log, CONFIG, QUEUE_PATH } from './lib.js';
import { hookAdvice, loadHookTypes } from './hookpatterns.js';
import { stopStatus } from './stop.js';

export async function runDraft(deps = {}) {
  const { dry = false, queuePath = QUEUE_PATH, readBriefs = readBriefsReal, buildDrafts = buildDraftsReal, notify = whatsapp, say = log, stopOpts, stop = () => stopStatus(stopOpts) } = deps;
  // stop flag (own or fleet-wide): draft nothing, queue nothing, send nothing; one line; exit code stays 0
  { const st = stop(); if (st.stopped) { say(`draft: ${st.reason}`); return { exitCode: 0, stopped: true }; } }
  const topTypes = loadHookTypes();
  const briefs = readBriefs();
  const q = loadQueue(queuePath); const had = new Set(q.drafts.map((d) => d.id));
  const drafts = await buildDrafts({ briefs, existingDrafts: q.drafts });
  const already = new Set(q.drafts.map((d) => d.sourceId));
  let added = 0, rejected = 0;
  for (const d of drafts) {
    if (d.rejected) { rejected++; say(`rejected draft (${d.kind} ${d.sourceId}): ${d.rejected}`); continue; }
    if (already.has(d.sourceId)) { say(`skip duplicate ${d.sourceId}`); continue; }
    // Optional, advisory hook-style line (hook-patterns.json copied from Agent OS). No file = no line, nothing else changes.
    let hookNote = ''; try { hookNote = hookAdvice(d.text, topTypes); } catch { hookNote = ''; }
    const id = nextId(q); q.drafts.push({ id, status: STATUS.PENDING, ...d, ...(hookNote ? { hookAdvice: hookNote } : {}) }); added++;
    say(`draft ${id} (${d.kind}) ${d.text.length} chars`);
  }
  say(`briefs=${briefs.length} drafts=${drafts.length} added=${added} rejected=${rejected}${dry ? ' [dry-run]' : ''}`);
  if (dry) { console.log(renderList(q)); return { exitCode: 0, stopped: false }; }
  // append onto the CURRENT file: the approval server may have changed other drafts while we were drafting
  await withQueueLock(async () => { const fresh = loadQueue(queuePath); fresh.seq = q.seq; fresh.drafts.push(...q.drafts.filter((d) => !had.has(d.id))); saveQueue(fresh, queuePath); }, { lockPath: queuePath + '.lock' });
  if (added) await notify(renderList(q)); else await notify(`📭 ${CONFIG.page}: nothing new to draft this week (${briefs.length} briefs read, ${rejected} rejected by the voice/brand gate).`);
  return { exitCode: 0, stopped: false };
}

const isMain = process.argv[1] && (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) { const r = await runDraft({ dry: process.argv.includes('--dry-run') }); process.exitCode = r.exitCode; }
