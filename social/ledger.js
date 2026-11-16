// Daily Instagram publish cap, counted per East Africa Time calendar day from a small ledger file.
//   config.json  maxInstagramPostsPerDay : absent = 1, 0 = none, n = n. Anything that is not a whole number >= 0 counts as 0 (fail closed).
//   ledger       <state dir>/bpa-social-ig-ledger.jsonl  (env BPA_LEDGER_PATH, or BPA_STATE_DIR for the folder; default ~/.matlai)
//                one JSON line per publish: {"at":"<ISO time>","id":"<queue id>"}
// reserveInstagramPublish() is called immediately before the publish call and writes the ledger line BEFORE the network call is made:
// a publish that then fails keeps its reservation (safe direction). Unreadable or corrupt ledger, a busy lock, a failed write: refused.
// Concurrency: an O_EXCL lock file serialises the read-count-write; the file itself is replaced atomically (temp + rename).
import fs from 'node:fs'; import path from 'node:path';
import { CONFIG } from './lib.js';
import { stateDir } from './stop.js';

export const defaultLedgerPath = (env = process.env) => env.BPA_LEDGER_PATH || path.join(stateDir(env), 'bpa-social-ig-ledger.jsonl');

export function dailyCap(config = CONFIG) {
  const v = config?.maxInstagramPostsPerDay;
  if (v === undefined) return 1;
  return Number.isInteger(v) && v >= 0 ? v : 0;
}
/** YYYY-MM-DD of `date` in the pipeline's timezone (Africa/Dar_es_Salaam = EAT, UTC+3, no DST). */
export const eatDay = (date, tz = CONFIG.timezone) => date.toLocaleDateString('en-CA', { timeZone: tz });

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function acquire(lockPath, timeoutMs, staleMs = 30e3) {
  const start = Date.now();
  for (;;) {
    try { const fd = fs.openSync(lockPath, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return true; }
    catch (e) {
      if (e.code !== 'EEXIST') return false;
      try { if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) { fs.unlinkSync(lockPath); continue; } } catch {}
      if (Date.now() - start > timeoutMs) return false;
      sleepSync(15);
    }
  }
}
function readLedger(p) {
  let raw; try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return raw.split('\n').filter((l) => l.trim()).map((l) => {
    const o = JSON.parse(l);
    if (!o || typeof o !== 'object' || Array.isArray(o) || typeof o.id !== 'string' || typeof o.at !== 'string' || Number.isNaN(Date.parse(o.at))) throw new Error('bad ledger line');
    return o;
  });
}

/** { ok, reason, count, cap }. ok=true means the ledger line is already written. Never throws. */
export function reserveInstagramPublish({ id, now = new Date(), config = CONFIG, path: p = defaultLedgerPath(), tz = config?.timezone || CONFIG.timezone, lockTimeoutMs = 2000 } = {}) {
  const cap = dailyCap(config);
  if (cap === 0) return { ok: false, reason: 'daily cap 0 (Instagram publishing is set to none)', count: 0, cap };
  const lockPath = p + '.lock';
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (e) { return { ok: false, reason: `ledger folder unusable (${e.code || e.message}), failing closed`, cap }; }
  if (!acquire(lockPath, lockTimeoutMs)) return { ok: false, reason: 'ledger lock busy or unusable, failing closed', cap };
  try {
    let rows; try { rows = readLedger(p); } catch (e) { return { ok: false, reason: `ledger unreadable or corrupt (${e.code || e.message}), failing closed`, cap }; }
    const today = eatDay(now, tz); const count = rows.filter((r) => eatDay(new Date(r.at), tz) === today).length;
    if (count >= cap) return { ok: false, reason: `daily cap ${cap} reached for ${today} EAT (${count} already)`, count, cap };
    const next = rows.concat({ at: now.toISOString(), id: String(id) }).map((r) => JSON.stringify(r)).join('\n') + '\n';
    const tmp = `${p}.${process.pid}.tmp`;
    try { fs.writeFileSync(tmp, next); fs.renameSync(tmp, p); } catch (e) { try { fs.unlinkSync(tmp); } catch {} return { ok: false, reason: `ledger write failed (${e.code || e.message}), failing closed`, cap }; }
    return { ok: true, reason: null, count: count + 1, cap };
  } finally { try { fs.unlinkSync(lockPath); } catch {} }
}
