// Approval gate (added after draft B25, 2026-11-12): a draft that states a number or a place must carry
// >=2 recorded source lines (claimSources: [{claim, source, url, line}]) from different hosts, or it cannot be approved.
const PLACE = /\b(?:north|south|east|west)(?:-?(?:east|west))?(?:ern)?\b|\bcoast\b|\b(?:Matemwe|Muyuni|Mnemba|Nungwi|Kendwa|Paje|Jambiani|Bwejuu|Michamvi|Kizimkazi|Stone Town|Pemba|Mafia|Serengeti|Zanzibar City|Dar es Salaam)\b/gi;
const NUM = /\b\d[\d,.]*\b/g;
/** Pure: the numeric/location tokens in the draft text (hashtags and URLs removed). */
export function claimsIn(text) {
  const t = String(text).replace(/https?:\/\/\S+/g, ' ').replace(/#\w+/g, ' ');
  return [...(t.match(NUM) || []), ...(t.match(PLACE) || [])];
}
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };
/** Returns null when approval may proceed, else the refusal reason. */
export function claimGate(d) {
  const claims = claimsIn(d.text); if (!claims.length) return null;
  const ok = (Array.isArray(d.claimSources) ? d.claimSources : []).filter((s) => s && s.source && s.line && host(s.url));
  if (!ok.length) return `no recorded source line for claims (${[...new Set(claims)].slice(0, 5).join(', ')}); record claimSources first`;
  const hosts = new Set(ok.map((s) => host(s.url)));
  return hosts.size >= 2 ? null : 'claims need 2 independent recorded sources on different sites';
}
