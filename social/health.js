#!/usr/bin/env node
// Last-success state and the silence alarm (fleet pattern `pattern-lastsuccess-heartbeat`: write the stamp on real success, alarm on age).
//   <state dir>/bpa-social-run.json       {lastRunAt, lastOkAt, result}  written by worker.js on EVERY run. result: ok | stopped | publish-failed | error: ...
//                                         lastOkAt moves only on a run that finished without throwing and without a failed publish (stopped counts as ok).
//   <state dir>/bpa-social-lastpost.json  {at, id}              written on every successful publish (worker or approval server)
//   <state dir>/bpa-social-alerts.json    {<condition>: <ISO>}  written by the approval server only: when each alert last went out
//   <state dir>/bpa-social-armed.json     {armedAt, stoppedSeenAt?}  written/removed by worker.js only (syncArmedStamp): armedAt = when the worker first saw config.autoPublish on
//                                         (removed on any run where it is not exactly true, so off-then-on starts a new clock); stoppedSeenAt = last worker run that found the pipeline stopped
// Four files on purpose: each has one kind of writer, so a read-modify-write can never drop another process's update.
// `node health.js --check` exits 1 and prints the reason when (a) the worker has not run for more than 45 minutes (worker-stale), or it has run but
// its last result is an error or it has not SUCCEEDED for 45 minutes (worker-failing: "ran" is not "worked"), or
// (b) config.autoPublish is on and more than config.alarmNoPostDays (default 4) days have passed since the LATEST of: armedAt, the last successful post, stoppedSeenAt
// (so the clock starts when the lane is first seen on, not at an old post, and a lifted `bpa stop` restarts it; stop.js records nothing, the worker's stoppedSeenAt is at most one 15-min run early).
// Lane on but no armed stamp = problem `armed-missing` (unknown: held back for 20 min after the approval server starts). The approval server reads config.json ONCE at start (lib.js CONFIG),
// so switch-on = edit config.json, restart the approval server; the worker (fresh process each run) writes the stamp within 15 min, inside the grace. A stamp that never appears alarms about an hour later.
// A missing or unreadable state file is an alarm (fail closed). autoPublish is only READ here; nothing here publishes anything.
// The always-on approval server runs healthTick() hourly: a worker cannot report its own death.
import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, whatsapp, log } from './lib.js';
import { stateDir, stopStatus } from './stop.js';

export const runStatePathFor = (env = process.env) => path.join(stateDir(env), 'bpa-social-run.json');
export const lastPostPathFor = (env = process.env) => path.join(stateDir(env), 'bpa-social-lastpost.json');
export const alertsPathFor = (env = process.env) => path.join(stateDir(env), 'bpa-social-alerts.json');
export const armedPathFor = (env = process.env) => path.join(stateDir(env), 'bpa-social-armed.json');
export const WORKER_MAX_AGE_MIN = 45;

function writeAtomic(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); const tmp = `${p}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(obj) + '\n'); fs.renameSync(tmp, p); }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
const validTime = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s));

/** Never throws: a failed write only means the stale alarm will fire, which is the safe direction.
 *  ok defaults to true for results "ok" and "stopped"; lastOkAt is carried over from the previous file when this run was not ok. */
export function recordWorkerRun({ now = new Date(), result = 'ok', ok = (result === 'ok' || result === 'stopped'), path: p = runStatePathFor() } = {}) {
  try {
    const prev = readJson(p); const lastOkAt = ok ? now.toISOString() : (prev && validTime(prev.lastOkAt) ? prev.lastOkAt : null);
    writeAtomic(p, { lastRunAt: now.toISOString(), lastOkAt, result: String(result).slice(0, 300) }); return true;
  } catch (e) { try { log(`health: could not write the run state (${e.code || e.message})`); } catch {} return false; }
}
export function recordPost({ now = new Date(), id, path: p = lastPostPathFor() } = {}) {
  try { writeAtomic(p, { at: now.toISOString(), id: String(id) }); return true; } catch (e) { try { log(`health: could not write the last-post state (${e.code || e.message})`); } catch {} return false; }
}

/** Worker only. on = config.autoPublish === true. On with no valid stamp: write {armedAt}; on and stopped: also remember stoppedSeenAt; off: remove the stamp. Returns { ok, error? } and never throws. */
export function syncArmedStamp({ now = new Date(), on, stopped = false, path: p = armedPathFor() } = {}) {
  try {
    if (!on) { try { fs.unlinkSync(p); } catch (e) { if (e.code !== 'ENOENT') throw e; } return { ok: true }; }
    const prev = readJson(p); const cur = prev && validTime(prev.armedAt) ? prev : { armedAt: now.toISOString() };
    const next = stopped ? { ...cur, stoppedSeenAt: now.toISOString() } : cur;
    if (!prev || JSON.stringify(prev) !== JSON.stringify(next)) writeAtomic(p, next);
    return { ok: true };
  } catch (e) { try { log(`health: could not update the armed stamp (${e.code || e.message})`); } catch {} return { ok: false, error: e.code || e.message }; }
}

/** { ok, problems: [{ key, reason }] } — keys: worker-stale, no-post. */
export function checkHealth({ now = new Date(), config = CONFIG, runStatePath = runStatePathFor(), lastPostPath = lastPostPathFor(), armedPath = armedPathFor(), stopOpts } = {}) {
  const problems = [];
  const run = readJson(runStatePath); // `unknown: true` = "no evidence either way" (missing/stale state): healthTick holds these back right after the server starts
  if (!run || !validTime(run.lastRunAt)) problems.push({ key: 'worker-stale', unknown: true, reason: 'no recorded worker run (the run state file is missing or unreadable)' });
  else {
    const min = Math.round((now.getTime() - Date.parse(run.lastRunAt)) / 60e3);
    if (min > WORKER_MAX_AGE_MIN) problems.push({ key: 'worker-stale', unknown: true, reason: `the worker has not run for ${min} min (limit ${WORKER_MAX_AGE_MIN}); last result: ${run.result}` });
    else if (typeof run.result === 'string' && run.result.startsWith('error')) problems.push({ key: 'worker-failing', reason: `the worker runs but fails: last result "${run.result.slice(0, 160)}"` });
    else if (!validTime(run.lastOkAt)) problems.push({ key: 'worker-failing', unknown: true, reason: 'the worker runs but no successful run is recorded' });
    else { const ok = Math.round((now.getTime() - Date.parse(run.lastOkAt)) / 60e3); if (ok > WORKER_MAX_AGE_MIN) problems.push({ key: 'worker-failing', reason: `the worker runs but has not succeeded for ${ok} min (limit ${WORKER_MAX_AGE_MIN}); last result: ${run.result}` }); }
  }
  if (config?.autoPublish === true && !stopStatus(stopOpts).stopped) { // stopped on purpose = silence is expected
    const limit = Number.isFinite(config.alarmNoPostDays) && config.alarmNoPostDays > 0 ? config.alarmNoPostDays : 4;
    const armed = readJson(armedPath); const last = readJson(lastPostPath);
    if (!armed || !validTime(armed.armedAt)) problems.push({ key: 'armed-missing', unknown: true, reason: 'autoPublish is on but the worker has not recorded when the automatic lane was switched on (the armed stamp is missing or unreadable)' });
    else { // the clock starts at the latest of: switched on, last successful post, stop last seen
      const stamps = [['switched on', armed.armedAt], ['last post', last?.at], ['stop last seen', armed.stoppedSeenAt]].filter(([, t]) => validTime(t));
      const [what, ref] = stamps.reduce((a, b) => (Date.parse(b[1]) > Date.parse(a[1]) ? b : a));
      const days = (now.getTime() - Date.parse(ref)) / 86400e3;
      if (days > limit) problems.push({ key: 'no-post', reason: `autoPublish is on and no post succeeded for ${Math.floor(days)} days (limit ${limit}); counted from: ${what} at ${ref}${last?.at ? `; last post: ${last.id} at ${last.at}` : '; no post recorded yet'}` });
    }
  }
  return { ok: problems.length === 0, problems };
}

/** One alert per condition per 24 h. The time is recorded only when the send really succeeded, so a failed send is retried on the next tick. */
export const STARTUP_GRACE_MS = 20 * 60e3; // one worker interval (15 min) plus a margin
export async function healthTick({ now = new Date(), config = CONFIG, notify = whatsapp, say = log, alertsPath = alertsPathFor(), startedAt, graceMs = STARTUP_GRACE_MS, ...rest } = {}) {
  const r = checkHealth({ now, config, ...rest });
  // right after the approval server (re)starts, missing or old worker state proves nothing (first start after a merge, after sleep or a reboot): wait one interval + margin
  if (startedAt && now.getTime() - startedAt.getTime() < graceMs) r.problems = r.problems.filter((p) => !p.unknown);
  r.ok = r.problems.length === 0; if (r.ok) return r;
  const alerts = readJson(alertsPath) || {}; let changed = false;
  for (const p of r.problems) {
    const prev = Date.parse(alerts[p.key]); if (!Number.isNaN(prev) && now.getTime() - prev < 24 * 3600e3) continue;
    say(`health alarm ${p.key}: ${p.reason}`);
    if (await notify(`⚠️ ${config.page || 'Beyond Paradise Adventures'} social: ${p.reason}`)) { alerts[p.key] = now.toISOString(); changed = true; } else say(`health alarm ${p.key}: the WhatsApp alert was NOT delivered, will retry next hour`);
  }
  if (changed) { try { writeAtomic(alertsPath, alerts); } catch (e) { say(`health: could not write the alerts file (${e.code || e.message})`); } }
  return r;
}

const isMain = process.argv[1] && (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  if (!process.argv.includes('--check')) { console.log('usage: node health.js --check   (exit 1 + reason when the worker is silent or no post succeeded)'); process.exitCode = 2; }
  else { const r = checkHealth(); if (r.ok) console.log('ok'); else for (const p of r.problems) console.log(`ALARM ${p.key}: ${p.reason}`); process.exitCode = r.ok ? 0 : 1; }
}
