#!/usr/bin/env node
// Weekly drafter: BPI briefs (last 7 days) → up to 3 drafts → queue (pending_approval) → WhatsApp.
import { readBriefs, buildDrafts, loadQueue, saveQueue, nextId, STATUS, whatsapp, renderList, log, CONFIG } from './lib.js';
const DRY = process.argv.includes('--dry-run');
const briefs = readBriefs();
const drafts = await buildDrafts({ briefs });
const q = loadQueue();
const already = new Set(q.drafts.map((d) => d.sourceId));
let added = 0, rejected = 0;
for (const d of drafts) {
  if (d.rejected) { rejected++; log(`rejected draft (${d.kind} ${d.sourceId}): ${d.rejected}`); continue; }
  if (already.has(d.sourceId)) { log(`skip duplicate ${d.sourceId}`); continue; }
  const id = nextId(q); q.drafts.push({ id, status: STATUS.PENDING, ...d }); added++;
  log(`draft ${id} (${d.kind}) ${d.text.length} chars`);
}
log(`briefs=${briefs.length} drafts=${drafts.length} added=${added} rejected=${rejected}${DRY ? ' [dry-run]' : ''}`);
if (DRY) { console.log(renderList(q)); process.exit(0); }
saveQueue(q);
if (added) await whatsapp(renderList(q)); else await whatsapp(`📭 ${CONFIG.page}: nothing new to draft this week (${briefs.length} briefs read, ${rejected} rejected by the voice/brand gate).`);
