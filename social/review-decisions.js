// The decision record: one JSON line per decision, append only, private (mode 600). Audit only, never read back to decide anything.
// Callers hold the decision lock (decision-lock.js). The record never holds text: a key outside the whitelist is refused.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './stop.js';

export const decisionsFilePath = (env = process.env) => path.join(stateDir(env), 'bpa-review-decisions.jsonl');

const KINDS = new Set(['hook', 'clip', 'posting']);
const WORDS = new Set(['approve', 'skip', 'edit', 'undo', 'stop', 'start', 'void']);
const KEYS = new Set(['n', 'kind', 'id', 'version', 'decision', 'claimedLogin', 'at', 'ref']); // claimedLogin = the login the proxy header CLAIMED, not proof of who acted
const FAIL = { ok: false, reason: 'record-failed' };
const isDate = (s) => typeof s === 'string' && s !== '' && !Number.isNaN(Date.parse(s));

function validRec(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
  for (const k of Object.keys(r)) if (!KEYS.has(k) || k === 'n') return false;
  if (!KINDS.has(r.kind) || !WORDS.has(r.decision)) return false;
  if (typeof r.id !== 'string' || r.id === '') return false;
  if (r.version !== null && typeof r.version !== 'string') return false;
  if (typeof r.claimedLogin !== 'string' || r.claimedLogin === '' || !isDate(r.at)) return false;
  if (r.ref !== undefined && !Number.isInteger(r.ref)) return false;
  return true;
}

// Returns the last n in the file, or null when a line cannot be read.
function lastN(text) {
  const lines = text.split('\n').filter((l) => l !== '');
  if (lines.length === 0) return 0;
  try { const j = JSON.parse(lines[lines.length - 1]); return Number.isInteger(j.n) && j.n >= 0 ? j.n : null; } catch { return null; }
}

export function appendDecision(file, rec) {
  try {
    if (!validRec(rec)) return FAIL;
    let last = 0;
    let st = null; try { st = fs.lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') return FAIL; }
    if (st) {
      if (!st.isFile() || (st.mode & 0o077) !== 0) return FAIL;
      last = lastN(fs.readFileSync(file, 'utf8')); if (last === null) return FAIL;
    } else fs.mkdirSync(path.dirname(file), { recursive: true });
    const n = last + 1;
    const line = `${JSON.stringify({ n, kind: rec.kind, id: rec.id, version: rec.version, decision: rec.decision, claimedLogin: rec.claimedLogin, at: rec.at, ...(rec.ref !== undefined ? { ref: rec.ref } : {}) })}\n`;
    const fd = fs.openSync(file, 'a', 0o600);
    try { fs.writeSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return { ok: true, n };
  } catch { return FAIL; }
}

export function readDecisions(file, { sinceMs, nowMs = Date.now() } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { ok: true, records: [] } : { ok: false, reason: 'cannot-read' }; }
  const all = [];
  for (const l of text.split('\n')) {
    if (l === '') continue;
    try { const j = JSON.parse(l); if (j && typeof j === 'object') all.push(j); else return { ok: false, reason: 'bad-line' }; } catch { return { ok: false, reason: 'bad-line' }; }
  }
  const voided = new Set(all.filter((r) => r.decision === 'void' && Number.isInteger(r.ref)).map((r) => r.ref));
  let records = all.filter((r) => r.decision !== 'void' && !voided.has(r.n)); // void lines themselves are not decisions
  if (typeof sinceMs === 'number') records = records.filter((r) => Date.parse(r.at) >= nowMs - sinceMs);
  return { ok: true, records };
}
