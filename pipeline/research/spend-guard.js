'use strict';

// ============================================================
// spend-guard.js — fail-closed cap IN FRONT of paid research calls
//
// Hard rule: never overspend on AI. Treat runaway spend as a bug.
// Gemini grounding is free under ~1,500 req/day, then $35/1k.
// This guard caps grounded calls per day and per run, with a
// kill-switch file. It blocks BEFORE the call — fail-closed.
//
//   checkAffordable(n)  — throws if the call would breach the cap
//   record(n)           — log n successful grounded calls
//
// Override caps via env: RESEARCH_MAX_CALLS_DAY, RESEARCH_MAX_CALLS_RUN
// Kill switch: create .research-kill at repo root to block all calls.
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const LEDGER = path.join(ROOT, '.tmp', 'research-spend.json');
const KILL = path.join(ROOT, '.research-kill');

const DAILY = parseInt(process.env.RESEARCH_MAX_CALLS_DAY || '200', 10);
const PER_RUN = parseInt(process.env.RESEARCH_MAX_CALLS_RUN || '30', 10);

let runCount = 0;
const today = () => new Date().toISOString().slice(0, 10);
const load = () => { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return {}; } };
const save = o => { fs.mkdirSync(path.dirname(LEDGER), { recursive: true }); fs.writeFileSync(LEDGER, JSON.stringify(o, null, 2)); };
const spentToday = () => load()[today()] || 0;

function checkAffordable(n = 1) {
  if (fs.existsSync(KILL)) throw new Error('SPEND GUARD: kill-switch active (.research-kill present). Remove it to resume.');
  if (runCount + n > PER_RUN) throw new Error(`SPEND GUARD: per-run cap reached (${runCount}/${PER_RUN}). Raise RESEARCH_MAX_CALLS_RUN if intended.`);
  const s = spentToday();
  if (s + n > DAILY) throw new Error(`SPEND GUARD: daily grounded-call cap reached (${s}/${DAILY}). Wait until tomorrow or raise RESEARCH_MAX_CALLS_DAY.`);
}

function record(n = 1) {
  runCount += n;
  const o = load();
  o[today()] = (o[today()] || 0) + n;
  save(o);
}

module.exports = { checkAffordable, record, spentToday, DAILY, PER_RUN };
