// The decision record: one JSON line per decision, append only, private (mode 600). Audit only, never read back to decide anything.
// Callers hold the decision lock (decision-lock.js). The record never holds text: a key outside the whitelist is refused.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './stop.js';
import { log } from './lib.js';

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

const NL = 10;
const nOf = (text) => { try { const j = JSON.parse(text); return j && Number.isInteger(j.n) && j.n >= 0 ? j.n : null; } catch { return null; } };
/** The last non-empty line of buf[0..end): { start, end, text } or null. */
function lastLine(buf, end) {
  while (end > 0 && buf[end - 1] === NL) end--;
  if (end === 0) return null;
  const start = buf.lastIndexOf(NL, end - 1) + 1;
  return { start, end, text: buf.subarray(start, end).toString('utf8') };
}
/** SR3. What the file ends with: { last, tornFrom } (tornFrom = byte offset of a damaged last line to set aside, else null; needNewline = the last good line lacks its newline) or null = refuse.
 *  A damaged line anywhere but last, or a last line that is damaged with no good line before it (unless the whole file is one unterminated fragment), still fails closed. */
function scan(buf) {
  const a = lastLine(buf, buf.length); if (!a) return { last: 0, tornFrom: null, needNewline: false };
  const terminated = buf[buf.length - 1] === NL; const n = nOf(a.text);
  if (n !== null) return { last: n, tornFrom: null, needNewline: !terminated };
  const b = lastLine(buf, a.start);
  if (!b) return terminated ? null : { last: 0, tornFrom: a.start, needNewline: false };
  const m = nOf(b.text); return m === null ? null : { last: m, tornFrom: a.start, needNewline: false };
}
const O_APPEND_RW = fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW; // O_NOFOLLOW: lstat then open would follow a link swapped in between
function writeAll(fd, buf) { let off = 0; while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off); }

export function appendDecision(file, rec) {
  let fd = null;
  try {
    if (!validRec(rec)) return FAIL;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fd = fs.openSync(file, O_APPEND_RW, 0o600);
    const st = fs.fstatSync(fd); if (!st.isFile() || (st.mode & 0o077) !== 0) return FAIL;
    const buf = fs.readFileSync(fd); const sc = scan(buf); if (!sc) return FAIL;
    if (sc.tornFrom !== null) { // a crash in the middle of a write: keep the fragment aside, cut it from the record, go on after the last good line
      const tfd = fs.openSync(`${file}.torn`, O_APPEND_RW, 0o600);
      try { writeAll(tfd, Buffer.concat([buf.subarray(sc.tornFrom), Buffer.from('\n')])); fs.fsyncSync(tfd); } finally { fs.closeSync(tfd); }
      fs.ftruncateSync(fd, sc.tornFrom); log('review failed: decision-record-torn');
    }
    const n = sc.last + 1;
    const line = `${JSON.stringify({ n, kind: rec.kind, id: rec.id, version: rec.version, decision: rec.decision, claimedLogin: rec.claimedLogin, at: rec.at, ...(rec.ref !== undefined ? { ref: rec.ref } : {}) })}\n`;
    writeAll(fd, Buffer.from((sc.needNewline ? '\n' : '') + line)); fs.fsyncSync(fd);
    return { ok: true, n };
  } catch { return FAIL; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } } }
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
