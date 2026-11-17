// Approval gate (added after draft B25, 2026-11-12): a draft that states a number or a place must carry
// >=2 recorded source lines (claimSources: [{claim, source, url, line}]) from different registrable domains, recorded for
// EXACTLY the current text (claimSourcesHash = sha256 of the text), or it cannot be approved.
import crypto from 'node:crypto';
const PLACE = /\b(?:north|south|east|west)(?:-?(?:east|west))?(?:ern)?\b|\bcoast\b|\b(?:Zanzibar City|Zanzibar|Unguja|Jozani|Kiwengwa|Matemwe|Muyuni|Mnemba|Nungwi|Kendwa|Paje|Jambiani|Bwejuu|Michamvi|Kizimkazi|Stone Town|Pemba|Mafia|Serengeti|Dar es Salaam)\b/gi;
// digits with anything after them ("20km", "9am", "4th", "1st"); the leading \b keeps "B25" style ids out, as before
const NUM = /\b\d[\d,.]*[a-z]*/gi;
const WORDNUM = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|hundreds?|thousands?|millions?|per ?cent)\b/gi;
/** Pure: the numeric/location tokens in the draft text (hashtags and URLs removed). */
export function claimsIn(text) {
  const t = String(text).replace(/https?:\/\/\S+/g, ' ').replace(/#\w+/g, ' ');
  return [...(t.match(NUM) || []), ...(t.match(WORDNUM) || []), ...(t.match(PLACE) || [])];
}
export const textHash = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
const host = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && x.hostname ? x.hostname.toLowerCase().replace(/^www\./, '') : null; } catch { return null; } };
// No public-suffix dependency: the registrable domain is the last two labels, or the last three when the second-last label +
// TLD is a common two-part suffix (co.uk, co.tz, com.au, ...). Not a full PSL; good enough to stop a.com vs x.a.com counting twice.
const TWO_PART = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.tz', 'or.tz', 'go.tz', 'ac.tz', 'co.ke', 'co.za', 'co.nz', 'co.in', 'co.jp', 'com.au', 'net.au', 'org.au', 'com.br', 'com.mx', 'com.tr', 'com.sg']);
export function registrableDomain(h) {
  const l = String(h).toLowerCase().split('.').filter(Boolean);
  if (l.length <= 2 || /^\d+(\.\d+){3}$/.test(h)) return l.join('.');
  return l.slice(TWO_PART.has(l.slice(-2).join('.')) ? -3 : -2).join('.');
}
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const validEntry = (s) => !!s && typeof s === 'object' && nonEmpty(s.claim) && nonEmpty(s.source) && nonEmpty(s.line) && host(s.url) !== null;
/** null when the list is a well-formed array of {claim, source, line, https url}, else the reason. */
export function validateSources(list) {
  if (!Array.isArray(list) || !list.length) return 'sources must be a non-empty array';
  const i = list.findIndex((s) => !validEntry(s));
  return i === -1 ? null : `source #${i + 1} needs non-empty claim, source, line and a parsable https url`;
}
/** What record-claim-sources stores on the draft: the list plus the hash of the exact text it was recorded for. */
export function sourcesRecord(text, list) {
  const bad = validateSources(list); if (bad) throw new Error(bad);
  if (!nonEmpty(text)) throw new Error('draft has no text');
  return { claimSources: list, claimSourcesHash: textHash(text), claimSourcesAt: new Date().toISOString() };
}
/** null when approval may proceed, else { code, message }: `code` is from a closed set (safe to show or log), `message` is the WhatsApp text (it may name claims from the draft). */
export function claimGateWhy(d) {
  if (!d || typeof d.text !== 'string' || !d.text.trim()) return { code: 'text-missing', message: 'draft text is missing or blank; nothing to approve' };
  const claims = claimsIn(d.text); if (!claims.length) return null;
  const list = Array.isArray(d.claimSources) ? d.claimSources : [];
  const ok = list.filter(validEntry);
  if (!ok.length) return { code: 'sources-missing', message: `no recorded source line for claims (${[...new Set(claims)].slice(0, 5).join(', ')}); record claimSources first` };
  if (!d.claimSourcesHash) return { code: 'sources-old', message: 'sources were recorded the old way (no text hash); record the sources again with record-claim-sources.js' };
  if (d.claimSourcesHash !== textHash(d.text)) return { code: 'sources-outdated', message: 'the text changed after the sources were recorded; record the sources again' };
  const sites = new Set(ok.map((s) => registrableDomain(host(s.url))));
  return sites.size >= 2 ? null : { code: 'sources-too-few', message: 'claims need 2 independent recorded sources on different sites' };
}
/** Returns null when approval may proceed, else the refusal reason. */
export function claimGate(d) { const w = claimGateWhy(d); return w ? w.message : null; }
