#!/usr/bin/env node
// usage: node record-claim-sources.js B25 sources.json   (sources.json = [{claim, source, url, line}, ...])
import fs from 'node:fs';
import { withQueueLock, loadQueue, saveQueue, log } from './lib.js';
const [id, file] = process.argv.slice(2); if (!id || !file) { console.error('usage: record-claim-sources.js B25 sources.json'); process.exit(2); }
const list = JSON.parse(fs.readFileSync(file, 'utf8'));
await withQueueLock(async () => { const q = loadQueue(); const d = q.drafts.find((x) => x.id === id); if (!d) { console.error('not found'); process.exit(1); } d.claimSources = list; d.claimSourcesAt = new Date().toISOString(); saveQueue(q); log(`${id}: recorded ${list.length} claim source line(s)`); });
console.log(`${id}: ${list.length} source lines recorded`);
