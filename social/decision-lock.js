// One lock for every writer of the decision files (hooks file, clip decisions, decision record). Built on withQueueLock (lib.js).
import fs from 'node:fs';
import path from 'node:path';
import { withQueueLock } from './lib.js';
import { stateDir } from './stop.js';

export const decisionLockPath = (env = process.env) => path.join(stateDir(env), 'bpa-decisions.lock');

/** Run fn while holding the decision lock. A lock that stays busy past timeoutMs rejects with code 'lock-busy'. */
export async function withDecisionLock(fn, { env = process.env, timeoutMs = 5000 } = {}) {
  let ran = false;
  fs.mkdirSync(path.dirname(decisionLockPath(env)), { recursive: true, mode: 0o700 });
  try {
    return await withQueueLock(async () => { ran = true; return fn(); }, { lockPath: decisionLockPath(env), timeoutMs });
  } catch (e) {
    if (!ran && e && e.message === 'queue lock timeout') throw Object.assign(new Error('lock-busy'), { code: 'lock-busy' });
    throw e;
  }
}
