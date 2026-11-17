// State-changing actions shared by the WhatsApp `bpa` commands and the review page.
import fs from 'node:fs';
import { STATUS, CONFIG, QUEUE_PATH } from './lib.js';
import { engageStop, releaseStop } from './stop.js';
/** One plain sentence about Facebook posts already scheduled at Meta (stop does not cancel them). Reads the queue WITHOUT the lock; a parse error leaves the sentence out. */
export function scheduledAtMetaNote(queuePath, now = new Date(), tz = CONFIG.timezone) {
  let q; try { q = JSON.parse(fs.readFileSync(queuePath, 'utf8')); } catch { return ''; }
  const times = (Array.isArray(q?.drafts) ? q.drafts : []).filter((d) => d?.status === STATUS.SCHEDULED && Date.parse(d.scheduledFor) > now.getTime()).map((d) => Date.parse(d.scheduledFor)).sort((x, y) => x - y);
  if (!times.length) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(times[0])).map((x) => [x.type, x.value]));
  const when = `${p.day} ${p.month} ${p.hour}:${p.minute}`;
  return times.length === 1 ? `1 Facebook post is already scheduled at Meta for ${when} and will still go out; cancel it in Meta if needed.`
    : `${times.length} Facebook posts are already scheduled at Meta, the next for ${when}, and will still go out; cancel them in Meta if needed.`;
}
/** Stop posting. `reply` is exactly what `bpa stop` answers (it already ends with the note); `note` is the Meta sentence alone. No queue lock. */
export function stopPosting({ queuePath = QUEUE_PATH, stopOpts, now = new Date() } = {}) {
  const note = scheduledAtMetaNote(queuePath, now);
  return { reply: engageStop(stopOpts) + (note ? ` ${note}` : ''), note };
}
/** Allow posting again. `reply` is exactly what `bpa start` answers. */
export function startPosting({ stopOpts } = {}) { return { reply: releaseStop(stopOpts) }; }
