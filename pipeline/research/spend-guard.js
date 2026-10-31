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
//   record(n)           — log n grounded call ATTEMPTS (called before the HTTP request)
//
// Override caps via env: RESEARCH_MAX_CALLS_DAY, RESEARCH_MAX_CALLS_RUN
// Kill switch: create .research-kill at repo root to block all calls.
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const LEDGER = process.env.RESEARCH_LEDGER_PATH || path.join(ROOT, '.tmp', 'research-spend.json');
const KILL = process.env.RESEARCH_KILL_PATH || path.join(ROOT, '.research-kill');

const DAILY = parseInt(process.env.RESEARCH_MAX_CALLS_DAY || '200', 10);
const PER_RUN = parseInt(process.env.RESEARCH_MAX_CALLS_RUN || '30', 10);

// Per-provider caps for the non-grounded cascade (Tavily, Brave, OpenRouter, DeepSeek,
// OpenAI, Anthropic). Conservative defaults; override RESEARCH_MAX_PROVIDER_CALLS_DAY / _RUN
// or per provider RESEARCH_MAX_<PROVIDER>_CALLS_DAY (e.g. RESEARCH_MAX_OPENAI_CALLS_DAY).
const PROVIDER_DAILY = parseInt(process.env.RESEARCH_MAX_PROVIDER_CALLS_DAY || '40', 10);
const PROVIDER_PER_RUN = parseInt(process.env.RESEARCH_MAX_PROVIDER_CALLS_RUN || '15', 10);
const providerRun = {};
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

function providerCap(name, kind) {
  const v = parseInt(process.env[`RESEARCH_MAX_${String(name).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_CALLS_${kind}`], 10);
  return Number.isFinite(v) ? v : (kind === 'DAY' ? PROVIDER_DAILY : PROVIDER_PER_RUN);
}
const providerToday = name => ((load().providers || {})[today()] || {})[name] || 0;

// Fail-closed check BEFORE any non-Gemini provider call. Throws on kill-switch or cap.
function checkProvider(name, n = 1) {
  if (fs.existsSync(KILL)) throw new Error('SPEND GUARD: kill-switch active (.research-kill present). Remove it to resume.');
  const run = providerRun[name] || 0;
  if (run + n > providerCap(name, 'RUN')) throw new Error(`SPEND GUARD: ${name} per-run cap reached (${run}/${providerCap(name, 'RUN')}).`);
  const s = providerToday(name);
  if (s + n > providerCap(name, 'DAY')) throw new Error(`SPEND GUARD: ${name} daily cap reached (${s}/${providerCap(name, 'DAY')}).`);
}

function recordProvider(name, n = 1) {
  providerRun[name] = (providerRun[name] || 0) + n;
  const o = load(); o.providers = o.providers || {}; const d = (o.providers[today()] = o.providers[today()] || {});
  d[name] = (d[name] || 0) + n; save(o);
}

module.exports = { checkAffordable, record, spentToday, checkProvider, recordProvider, providerToday, DAILY, PER_RUN };
