// The one guarded caller for the local model (Ollama on this machine). Node built-ins only.
//
//   askLocal({ model, prompt, system, format, images, timeoutMs, keepAlive, numPredict }, deps) -> the answer text
//
// Free and local only. There is no code path to another host: the base URL must be exactly http://127.0.0.1:11434 or
// http://localhost:11434 (assertLocalOllama), and the request URL is built from the host that check returns.
// Before EVERY request, in this order, and every failure is a GuardError (fail closed, nothing is sent):
//   1 host check  2 stop flag (own or fleet-wide, stop.js; an unreadable flag counts as stopped)
//   3 per-run cap (default 120)  4 per-East-Africa-day cap (default 1500), a counter file reserved BEFORE the call
// The counter file is the same one media-segments.js uses (bpa-segments-calls.json in the state folder, shape {day,count}),
// so both callers draw on one daily budget. Reads and writes are serialised by an O_EXCL lock and the file is replaced
// atomically; an unreadable or odd counter, a busy lock or a failed write refuses.
// Thinking models can spend a small token budget on reasoning and return nothing: num_predict is generous and an empty
// answer throws EmptyAnswerError (a failure, never text).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stopStatus, stateDir } from './stop.js';
import { acquire, releaseLock } from './ledger.js';

export const OLLAMA_PORT = '11434';
export const DEFAULT_MAX_CALLS = 120;
export const DEFAULT_DAILY_CAP = 1500;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_KEEP_ALIVE = '2m';
export const DEFAULT_NUM_PREDICT = 4096;

export class GuardError extends Error { constructor(message) { super(message); this.name = 'GuardError'; this.guard = true; } }
export class EmptyAnswerError extends Error { constructor(message) { super(message); this.name = 'EmptyAnswerError'; } }

export const defaultCounterFile = (env = process.env) => env.BPA_SEGMENTS_COUNTER || path.join(stateDir(env), 'bpa-segments-calls.json');

/** Throws unless the URL is exactly http://127.0.0.1:11434 or http://localhost:11434. Returns the host. */
export function assertLocalOllama(baseUrl) {
  let u;
  try { u = new URL(String(baseUrl)); } catch { throw new GuardError(`refusing model host: not a URL (${String(baseUrl).slice(0, 60)})`); }
  const ok = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port === OLLAMA_PORT && !u.username && !u.password;
  if (!ok) throw new GuardError(`refusing model host ${u.host}: only http://127.0.0.1:${OLLAMA_PORT} or http://localhost:${OLLAMA_PORT} is allowed`);
  return u.hostname;
}

/** Day key in East Africa Time (UTC+3, no DST). */
export const eatDayKey = (d) => new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 10);
const posInt = (x) => Number.isInteger(x) && x > 0;

/** Reserve one call in the per-day counter. { ok:true, day, count } or { ok:false, reason }. Never throws. */
export function reserveCall({ counterFile = defaultCounterFile(), dailyCap = DEFAULT_DAILY_CAP, now = new Date(), lockTimeoutMs = 2000 } = {}) {
  if (!posInt(dailyCap)) return { ok: false, reason: 'refusing: the daily cap must be a positive integer' };
  try { fs.mkdirSync(path.dirname(counterFile), { recursive: true, mode: 0o700 }); } catch (e) { return { ok: false, reason: `daily counter folder unusable (${e.code || e.message}): refusing` }; }
  const lockPath = counterFile + '.lock'; const token = acquire(lockPath, lockTimeoutMs);
  if (!token) return { ok: false, reason: 'daily counter lock busy or unusable: refusing' };
  try {
    const day = eatDayKey(now); let count = 0; let raw = null;
    try { raw = fs.readFileSync(counterFile, 'utf8'); } catch (e) { if (!e || e.code !== 'ENOENT') return { ok: false, reason: `daily counter unreadable (${e && e.code}): refusing` }; }
    if (raw !== null) {
      let o; try { o = JSON.parse(raw); } catch { return { ok: false, reason: 'daily counter unreadable (not JSON): refusing' }; }
      if (!o || typeof o !== 'object' || Array.isArray(o) || typeof o.day !== 'string' || !Number.isInteger(o.count) || o.count < 0) return { ok: false, reason: 'daily counter unreadable (bad shape): refusing' };
      count = o.day === day ? o.count : 0;
    }
    if (count >= dailyCap) return { ok: false, reason: `per-day cap of ${dailyCap} calls reached for ${day}` };
    const tmp = `${counterFile}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try { fs.writeFileSync(tmp, `${JSON.stringify({ day, count: count + 1 })}\n`); fs.renameSync(tmp, counterFile); }
    catch (e) { try { fs.unlinkSync(tmp); } catch {} return { ok: false, reason: `daily counter not writable (${e.code || e.message}): refusing` }; }
    return { ok: true, day, count: count + 1 };
  } finally { releaseLock(lockPath, token); }
}

// One counter per process, so the per-run cap spans every askLocal call of a run unless a caller passes its own `run`.
const PROCESS_RUN = { calls: 0 };

/** The guard, in order. Returns the host. Throws GuardError. */
export function guardCall(deps = {}) {
  const { baseUrl = `http://127.0.0.1:${OLLAMA_PORT}`, run = PROCESS_RUN, maxCalls = DEFAULT_MAX_CALLS, dailyCap = DEFAULT_DAILY_CAP, counterFile = defaultCounterFile(), stopOpts, now = () => new Date() } = deps;
  const host = assertLocalOllama(baseUrl);
  const st = stopStatus(stopOpts); if (st.stopped) throw new GuardError(`${st.reason}: no model calls`);
  if (!posInt(maxCalls) || !posInt(dailyCap)) throw new GuardError('refusing: call caps must be positive integers');
  if (!run || !Number.isInteger(run.calls)) throw new GuardError('refusing: no per-run counter');
  if (run.calls >= maxCalls) throw new GuardError(`per-run cap of ${maxCalls} calls reached`);
  const r = reserveCall({ counterFile, dailyCap, now: now() }); if (!r.ok) throw new GuardError(r.reason);
  run.calls += 1;
  return host;
}

/** One local model call. deps (all optional, injected by tests): baseUrl, fetchImpl, run, maxCalls, dailyCap, counterFile, stopOpts, now. */
export async function askLocal({ model, prompt, system, format, images, timeoutMs = DEFAULT_TIMEOUT_MS, keepAlive = DEFAULT_KEEP_ALIVE, numPredict = DEFAULT_NUM_PREDICT } = {}, deps = {}) {
  if (typeof model !== 'string' || !model.trim()) throw new GuardError('refusing: no model named');
  const { fetchImpl = globalThis.fetch } = deps;
  const host = guardCall(deps);
  const messages = [];
  if (system) messages.push({ role: 'system', content: String(system) });
  messages.push({ role: 'user', content: String(prompt ?? ''), ...(Array.isArray(images) && images.length ? { images } : {}) });
  const r = await fetchImpl(`http://${host}:${OLLAMA_PORT}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ model, stream: false, keep_alive: keepAlive, options: { temperature: 0.3, num_predict: numPredict }, messages, ...(format ? { format } : {}) }),
  });
  if (!r.ok) throw new Error(`ollama HTTP ${r.status}`);
  const j = await r.json();
  const content = j && j.message && j.message.content;
  if (typeof content !== 'string' || !content.trim()) throw new EmptyAnswerError(`${model} returned an empty answer (thinking models need a larger token budget)`);
  return content;
}
