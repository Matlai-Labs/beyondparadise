// One place that turns a moment into local time parts and into a plain sentence part. The same formatter the Meta note uses.
import { CONFIG } from './lib.js';

/** { day, month, hour, minute } of a moment in a time zone (24 hour clock). */
export function localParts(ms, tz = CONFIG.timezone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
}

/** '18 Nov at 00:06 (East Africa time)' for an ISO string or milliseconds; null when it is not a valid time. */
export function plainTime(isoOrMs, tz = CONFIG.timezone) {
  const ms = typeof isoOrMs === 'number' ? isoOrMs : (typeof isoOrMs === 'string' ? Date.parse(isoOrMs) : NaN);
  if (!Number.isFinite(ms)) return null;
  try {
    const p = localParts(ms, tz);
    const zone = tz === 'Africa/Dar_es_Salaam' ? 'East Africa time'
      : (new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'long' }).formatToParts(new Date(ms)).find((x) => x.type === 'timeZoneName')?.value || tz);
    return `${p.day} ${p.month} at ${p.hour}:${p.minute} (${zone})`;
  } catch { return null; }
}
