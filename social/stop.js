// Stop flags for the social pipeline. Pattern vendored from the fleet `killswitch-flagfile` (unreadable = stopped)
// and `stop-all` (flag under the passwd home, HOME deliberately not consulted for it, STOP_ALL_FLAG_PATH the only override).
// Two flags, either one stops publishing and scheduling:
//   1. bpa-social-stop  : this pipeline only. Default <home>/.matlai/bpa-social-stop  (env BPA_STOP_FLAG, or BPA_STATE_DIR for the folder).
//                         `bpa stop` creates it, `bpa start` removes it.
//   2. stop-all.flag    : fleet-wide. Default <passwd home>/.matlai/stop-all.flag  (env STOP_ALL_FLAG_PATH). Read only here, never created or removed here.
// Fail closed: a flag whose state cannot be read (anything but "does not exist") counts as stopped.
// The flag lives outside the repo on purpose: worktrees, `git clean` and backup restores would delete it.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

export class StoppedError extends Error { constructor(reason) { super(reason); this.name = 'StoppedError'; this.reason = reason; } }

export const stateDir = (env = process.env) => env.BPA_STATE_DIR || path.join(os.homedir(), '.matlai');
export const stopFlagPath = (env = process.env) => env.BPA_STOP_FLAG || path.join(stateDir(env), 'bpa-social-stop');
export function fleetStopPath(env = process.env) {
  if (env.STOP_ALL_FLAG_PATH) return env.STOP_ALL_FLAG_PATH;
  let home; try { home = os.userInfo().homedir; } catch { home = null; }
  return home ? path.join(home, '.matlai', 'stop-all.flag') : null; // null = cannot even locate it: treated as unreadable
}

function probe(p) {
  if (!p) return { state: 'unreadable', code: 'NOPATH' };
  try { const st = fs.statSync(p); return { state: 'engaged', since: st.mtime.toISOString() }; }
  catch (e) { return e.code === 'ENOENT' ? { state: 'absent' } : { state: 'unreadable', code: e.code || 'ERR' }; }
}

/** { stopped, reason } — reason is the one log line ("stopped by flag since <mtime>"). Never throws. */
export function stopStatus({ env = process.env, flagPath = stopFlagPath(env), fleetPath = fleetStopPath(env) } = {}) {
  try {
    const own = probe(flagPath), fleet = probe(fleetPath);
    if (own.state === 'engaged') return { stopped: true, reason: `stopped by flag since ${own.since}`, since: own.since, by: 'own' };
    if (fleet.state === 'engaged') return { stopped: true, reason: `stopped by fleet stop-all flag since ${fleet.since}`, since: fleet.since, by: 'fleet' };
    if (own.state === 'unreadable') return { stopped: true, reason: `stopped: stop flag state unreadable (${own.code}), failing closed` };
    if (fleet.state === 'unreadable') return { stopped: true, reason: `stopped: fleet stop-all flag state unreadable (${fleet.code}), failing closed` };
    return { stopped: false, reason: null };
  } catch (e) { return { stopped: true, reason: `stopped: stop check failed (${e.code || e.message}), failing closed` }; }
}
/** Guard for every function that publishes or schedules. */
export function assertNotStopped(opts) { const s = stopStatus(opts); if (s.stopped) throw new StoppedError(s.reason); }

/** `bpa stop`: create the flag (keeps the original time when it already exists). Returns the one reply line. */
export function engageStop({ env = process.env, flagPath = stopFlagPath(env), now = new Date() } = {}) {
  const cur = probe(flagPath);
  if (cur.state === 'engaged') return `🛑 already stopped since ${cur.since}. Reply *bpa start* to resume.`;
  try { fs.mkdirSync(path.dirname(flagPath), { recursive: true }); fs.writeFileSync(flagPath, `${now.toISOString()}\n`, { mode: 0o600 }); }
  catch (e) { return `⚠️ could not create the stop flag (${e.code || e.message}); publishing is NOT stopped by this command.`; }
  return '🛑 Stopped. Nothing new will be published, scheduled or drafted until you reply *bpa start*.';
}
/** `bpa start`: remove the flag. Says so when the fleet-wide flag still holds. */
export function releaseStop({ env = process.env, flagPath = stopFlagPath(env), fleetPath = fleetStopPath(env) } = {}) {
  let removed = false;
  try { fs.unlinkSync(flagPath); removed = true; } catch (e) { if (e.code !== 'ENOENT') return `⚠️ could not remove the stop flag (${e.code || e.message}); still stopped.`; }
  const rest = stopStatus({ env, flagPath, fleetPath });
  if (rest.stopped) return `${removed ? '▶️ bpa flag removed, but' : 'ℹ️ the bpa flag was not set, but'} still ${rest.reason}.`;
  return removed ? '▶️ started. Publishing, scheduling and drafting are allowed again.' : 'ℹ️ it was not stopped.';
}
